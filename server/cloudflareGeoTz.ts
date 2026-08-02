import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import geobuf from "geobuf";
import Pbf from "pbf";

const ASSET_ROOT = "/__astro_internal_geo_tz";
const DATA_PART_BYTES = 4 * 1024 * 1024;
const MAX_CACHED_DATA_PARTS = 4;

type GeoTzIndexLeaf = {
  pos: number;
  len: number;
};

type GeoTzLookup =
  | number[]
  | GeoTzIndexLeaf
  | {
      a?: GeoTzLookup;
      b?: GeoTzLookup;
      c?: GeoTzLookup;
      d?: GeoTzLookup;
    };

type GeoTzIndex = {
  lookup: GeoTzLookup;
  timezones: string[];
};

type TimeZoneFeature = {
  properties: { tzid?: unknown } | null;
  type: "Feature";
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
};

type TimeZoneFeatureCollection = {
  features: TimeZoneFeature[];
};

export type StaticAssetFetcher = {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
};

const indexCache = new Map<string, Promise<GeoTzIndex>>();
const dataPartCache = new Map<string, Promise<ArrayBuffer>>();

function assetUrl(requestUrl: string, path: string): string {
  return new URL(`${ASSET_ROOT}/${path}`, requestUrl).href;
}

async function fetchRequiredAsset(
  assets: StaticAssetFetcher,
  url: string
): Promise<Response> {
  const response = await assets.fetch(new Request(url));
  if (!response.ok) {
    throw new Error(`geo-tzデータを取得できませんでした（${response.status}）`);
  }
  return response;
}

function loadIndex(
  assets: StaticAssetFetcher,
  requestUrl: string
): Promise<GeoTzIndex> {
  const url = assetUrl(requestUrl, "timezones-1970.index.json");
  const cached = indexCache.get(url);
  if (cached) return cached;
  const promise = fetchRequiredAsset(assets, url)
    .then((response) => response.json() as Promise<GeoTzIndex>)
    .catch((error: unknown) => {
      indexCache.delete(url);
      throw error;
    });
  indexCache.set(url, promise);
  return promise;
}

function rememberDataPart(
  key: string,
  promise: Promise<ArrayBuffer>
): Promise<ArrayBuffer> {
  dataPartCache.set(key, promise);
  if (dataPartCache.size > MAX_CACHED_DATA_PARTS) {
    const oldestKey = dataPartCache.keys().next().value;
    if (typeof oldestKey === "string") dataPartCache.delete(oldestKey);
  }
  return promise;
}

function loadDataPart(
  assets: StaticAssetFetcher,
  requestUrl: string,
  partIndex: number
): Promise<ArrayBuffer> {
  const partName = `timezones-1970.part-${partIndex.toString().padStart(3, "0")}.bin`;
  const url = assetUrl(requestUrl, partName);
  const cached = dataPartCache.get(url);
  if (cached) return cached;
  return rememberDataPart(
    url,
    fetchRequiredAsset(assets, url)
      .then((response) => response.arrayBuffer())
      .catch((error: unknown) => {
        dataPartCache.delete(url);
        throw error;
      })
  );
}

async function readDataRange(
  assets: StaticAssetFetcher,
  requestUrl: string,
  position: number,
  length: number
): Promise<Uint8Array> {
  if (position < 0 || length <= 0) {
    throw new Error("geo-tzインデックスが不正です");
  }
  const firstPart = Math.floor(position / DATA_PART_BYTES);
  const lastPart = Math.floor((position + length - 1) / DATA_PART_BYTES);
  const parts = await Promise.all(
    Array.from(
      { length: lastPart - firstPart + 1 },
      (_, offset) => loadDataPart(assets, requestUrl, firstPart + offset)
    )
  );
  const output = new Uint8Array(length);
  let outputOffset = 0;
  for (let partIndex = firstPart; partIndex <= lastPart; partIndex += 1) {
    const bytes = new Uint8Array(parts[partIndex - firstPart]);
    const start = partIndex === firstPart ? position % DATA_PART_BYTES : 0;
    const remaining = length - outputOffset;
    const copyLength = Math.min(remaining, bytes.length - start);
    if (copyLength <= 0) throw new Error("geo-tzデータが途中で終了しました");
    output.set(bytes.subarray(start, start + copyLength), outputOffset);
    outputOffset += copyLength;
  }
  if (outputOffset !== length) throw new Error("geo-tzデータが不足しています");
  return output;
}

function oceanTimeZones(longitude: number): string[] {
  if (longitude === -180 || longitude === 180) {
    return ["Etc/GMT+12", "Etc/GMT-12"];
  }
  const offset = Math.max(-12, Math.min(12, -Math.round(longitude / 15)));
  return [offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "+" : ""}${offset}`];
}

function isLeaf(value: GeoTzLookup): value is GeoTzIndexLeaf {
  return !Array.isArray(value) &&
    "pos" in value && Number.isFinite(value.pos) &&
    "len" in value && Number.isFinite(value.len);
}

/**
 * geo-tz 8.xの1970境界データと同じ四分木・geobuf判定をWorkers向けに非同期化する。
 * 元パッケージの実行時fs依存だけを静的アセット取得へ置き換えている。
 */
export async function findCloudflareTimeZones(
  latitude: number,
  longitude: number,
  assets: StaticAssetFetcher,
  requestUrl: string
): Promise<string[]> {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error(`Invalid latitude: ${latitude}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error(`Invalid longitude: ${longitude}`);
  }
  const index = await loadIndex(assets, requestUrl);
  if (latitude === 90) return [...new Set(index.timezones)];

  const lookupLatitude = Math.max(-89.9999, Math.min(89.9999, latitude));
  const lookupLongitude = Math.max(-179.9999, Math.min(179.9999, longitude));
  const queryPoint = point([lookupLongitude, lookupLatitude]);
  const bounds = {
    top: 89.9999,
    bottom: -89.9999,
    left: -179.9999,
    right: 179.9999,
    midLat: 0,
    midLon: 0,
  };
  let node: GeoTzLookup | undefined = index.lookup;

  while (node) {
    if (Array.isArray(node)) {
      return node.map((timeZoneIndex) => index.timezones[timeZoneIndex])
        .filter((value): value is string => typeof value === "string");
    }
    if (isLeaf(node)) {
      const bytes = await readDataRange(
        assets,
        requestUrl,
        node.pos,
        node.len
      );
      const decoded = geobuf.decode(new Pbf(bytes)) as TimeZoneFeatureCollection;
      const matches = decoded.features.flatMap((feature) => {
        const timeZone = feature.properties?.tzid;
        return typeof timeZone === "string" &&
          booleanPointInPolygon(queryPoint, feature)
          ? [timeZone]
          : [];
      });
      return matches.length > 0 ? matches : oceanTimeZones(longitude);
    }

    let quadrant: "a" | "b" | "c" | "d";
    if (lookupLatitude >= bounds.midLat && lookupLongitude >= bounds.midLon) {
      quadrant = "a";
      bounds.bottom = bounds.midLat;
      bounds.left = bounds.midLon;
    } else if (lookupLatitude >= bounds.midLat && lookupLongitude < bounds.midLon) {
      quadrant = "b";
      bounds.bottom = bounds.midLat;
      bounds.right = bounds.midLon;
    } else if (lookupLatitude < bounds.midLat && lookupLongitude < bounds.midLon) {
      quadrant = "c";
      bounds.top = bounds.midLat;
      bounds.right = bounds.midLon;
    } else {
      quadrant = "d";
      bounds.top = bounds.midLat;
      bounds.left = bounds.midLon;
    }
    node = node[quadrant];
    bounds.midLat = (bounds.top + bounds.bottom) / 2;
    bounds.midLon = (bounds.left + bounds.right) / 2;
  }
  return oceanTimeZones(longitude);
}

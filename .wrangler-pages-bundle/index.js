var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../server/placeGeocode.ts
async function resolveJapanesePlaceName(rawQuery, signal) {
  const query = rawQuery.trim();
  if (!query) throw new Error("\u30B9\u30DD\u30C3\u30C8\u540D\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044");
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`\u30B9\u30DD\u30C3\u30C8\u540D\u306F${MAX_QUERY_LENGTH}\u6587\u5B57\u4EE5\u5185\u3067\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044`);
  }
  const coordinateMatch = query.match(
    /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,、]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/
  );
  if (coordinateMatch) {
    const latitude = Number(coordinateMatch[1]);
    const longitude = Number(coordinateMatch[2]);
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      return { latitude, longitude, label: `${latitude}, ${longitude}` };
    }
  }
  const parameters = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "5",
    addressdetails: "1",
    namedetails: "1",
    countrycodes: "jp",
    "accept-language": "ja"
  });
  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?${parameters}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Language": "ja-JP,ja;q=0.9",
        "User-Agent": "AstroSight/0.0.0"
      },
      signal
    }
  );
  if (!response.ok) {
    throw new Error(`\u5730\u540D\u691C\u7D22\u901A\u4FE1\u30A8\u30E9\u30FC\uFF1A${response.status}`);
  }
  const places = await response.json();
  const place = places.find(
    (candidate) => Number.isFinite(Number(candidate.lat)) && Number.isFinite(Number(candidate.lon)) && typeof candidate.display_name === "string"
  );
  if (!place) throw new Error("\u6307\u5B9A\u3057\u305F\u30B9\u30DD\u30C3\u30C8\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F");
  return {
    latitude: Number(place.lat),
    longitude: Number(place.lon),
    label: String(place.display_name)
  };
}
var MAX_QUERY_LENGTH;
var init_placeGeocode = __esm({
  "../server/placeGeocode.ts"() {
    init_functionsRoutes_0_25847306968093076();
    MAX_QUERY_LENGTH = 200;
    __name(resolveJapanesePlaceName, "resolveJapanesePlaceName");
  }
});

// _shared/http.ts
function jsonResponse(data, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
var init_http = __esm({
  "_shared/http.ts"() {
    init_functionsRoutes_0_25847306968093076();
    __name(jsonResponse, "jsonResponse");
    __name(errorMessage, "errorMessage");
  }
});

// api/geocode.ts
var onRequest;
var init_geocode = __esm({
  "api/geocode.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_placeGeocode();
    init_http();
    onRequest = /* @__PURE__ */ __name(async ({ request }) => {
      if (request.method !== "POST") {
        return jsonResponse({ error: "POST\u30EA\u30AF\u30A8\u30B9\u30C8\u306E\u307F\u5229\u7528\u3067\u304D\u307E\u3059" }, 405);
      }
      try {
        const body = await request.json();
        if (typeof body.query !== "string") {
          return jsonResponse({ error: "\u30B9\u30DD\u30C3\u30C8\u540D\u304C\u3042\u308A\u307E\u305B\u3093" }, 400);
        }
        return jsonResponse(await resolveJapanesePlaceName(body.query, request.signal));
      } catch (error) {
        const message = errorMessage(error);
        return jsonResponse({ error: message }, message.includes("\u898B\u3064\u304B\u308A\u307E\u305B\u3093") ? 404 : 422);
      }
    }, "onRequest");
  }
});

// ../server/cloudflareRuntime.ts
function configureServerRuntime(next) {
  configuration = {
    cesiumIonToken: next.cesiumIonToken?.trim() || void 0,
    persistentCache: next.persistentCache,
    waitUntil: next.waitUntil
  };
}
function serverPersistentCache() {
  return configuration.persistentCache;
}
function keepServerTaskAlive(promise) {
  configuration.waitUntil?.(promise);
}
var configuration;
var init_cloudflareRuntime = __esm({
  "../server/cloudflareRuntime.ts"() {
    init_functionsRoutes_0_25847306968093076();
    configuration = {};
    __name(configureServerRuntime, "configureServerRuntime");
    __name(serverPersistentCache, "serverPersistentCache");
    __name(keepServerTaskAlive, "keepServerTaskAlive");
  }
});

// ../server/gsiElevation.ts
import { inflateSync } from "node:zlib";
async function withTileRequestLimit(task) {
  if (activeTileRequests >= MAX_CONCURRENT_GSI_TILE_REQUESTS) {
    await new Promise((resolve) => tileRequestWaiters.push(resolve));
  }
  activeTileRequests += 1;
  try {
    return await task();
  } finally {
    activeTileRequests -= 1;
    tileRequestWaiters.shift()?.();
  }
}
function isJapaneseCoverage(point2) {
  return point2.latitude >= 20 && point2.latitude <= 46.5 && point2.longitude >= 122 && point2.longitude <= 154;
}
function readChunkName(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
}
function paethPredictor(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}
function decodePng(bytes) {
  if (PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new Error("\u56FD\u571F\u5730\u7406\u9662\u6A19\u9AD8\u30BF\u30A4\u30EB\u304CPNG\u5F62\u5F0F\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  }
  let width = 0;
  let height = 0;
  let bytesPerPixel = 0;
  const idatParts = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      4
    ).getUint32(0, false);
    const name = readChunkName(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error("\u56FD\u571F\u5730\u7406\u9662\u6A19\u9AD8\u30BF\u30A4\u30EB\u306EPNG\u30C7\u30FC\u30BF\u304C\u9014\u4E2D\u3067\u7D42\u4E86\u3057\u3066\u3044\u307E\u3059");
    }
    if (name === "IHDR") {
      const header = new DataView(
        bytes.buffer,
        bytes.byteOffset + dataStart,
        length
      );
      width = header.getUint32(0, false);
      height = header.getUint32(4, false);
      const bitDepth = header.getUint8(8);
      const colorType = header.getUint8(9);
      if (bitDepth !== 8 || colorType !== 2 && colorType !== 6) {
        throw new Error(`\u672A\u5BFE\u5FDC\u306E\u6A19\u9AD8PNG\u5F62\u5F0F\u3067\u3059\uFF08bit=${bitDepth}, color=${colorType}\uFF09`);
      }
      bytesPerPixel = colorType === 2 ? 3 : 4;
    } else if (name === "IDAT") {
      idatParts.push(bytes.slice(dataStart, dataEnd));
    } else if (name === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (width <= 0 || height <= 0 || bytesPerPixel === 0 || idatParts.length === 0) {
    throw new Error("\u56FD\u571F\u5730\u7406\u9662\u6A19\u9AD8\u30BF\u30A4\u30EB\u306EPNG\u30D8\u30C3\u30C0\u30FC\u3092\u89E3\u6790\u3067\u304D\u307E\u305B\u3093");
  }
  const compressedLength = idatParts.reduce((sum2, part) => sum2 + part.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let compressedOffset = 0;
  for (const part of idatParts) {
    compressed.set(part, compressedOffset);
    compressedOffset += part.length;
  }
  const inflated = inflateSync(compressed);
  const rowBytes = width * bytesPerPixel;
  if (inflated.length < (rowBytes + 1) * height) {
    throw new Error("\u56FD\u571F\u5730\u7406\u9662\u6A19\u9AD8\u30BF\u30A4\u30EB\u306E\u5C55\u958B\u5F8C\u30C7\u30FC\u30BF\u304C\u4E0D\u8DB3\u3057\u3066\u3044\u307E\u3059");
  }
  const pixels = new Uint8Array(rowBytes * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[rowOffset - rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[rowOffset - rowBytes + x - bytesPerPixel] : 0;
      const reconstructed = filter === 0 ? raw : filter === 1 ? raw + left : filter === 2 ? raw + above : filter === 3 ? raw + Math.floor((left + above) / 2) : filter === 4 ? raw + paethPredictor(left, above, upperLeft) : Number.NaN;
      if (!Number.isFinite(reconstructed)) {
        throw new Error(`\u672A\u5BFE\u5FDC\u306EPNG\u30D5\u30A3\u30EB\u30BF\u30FC\u3067\u3059\uFF08${filter}\uFF09`);
      }
      pixels[rowOffset + x] = reconstructed & 255;
    }
    sourceOffset += rowBytes;
  }
  return { width, height, bytesPerPixel, pixels };
}
function decodeElevationTile(bytes) {
  const png = decodePng(bytes);
  const pixelCount = png.width * png.height;
  const heightsCentimeters = new Int32Array(pixelCount);
  const noDataValue = NO_DATA_HEIGHT_CENTIMETERS;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * png.bytesPerPixel;
    const encoded = png.pixels[offset] * 65536 + png.pixels[offset + 1] * 256 + png.pixels[offset + 2];
    heightsCentimeters[pixelIndex] = encoded === 2 ** 23 ? noDataValue : encoded < 2 ** 23 ? encoded : encoded - 2 ** 24;
  }
  return { width: png.width, height: png.height, heightsCentimeters };
}
function tileCoordinates(point2, zoom) {
  const scale2 = 2 ** zoom;
  const normalizedX = (point2.longitude + 180) / 360 * scale2;
  const latitudeRadians = point2.latitude * Math.PI / 180;
  const normalizedY = (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale2;
  const x = Math.floor(normalizedX);
  const y = Math.floor(normalizedY);
  return {
    x,
    y,
    pixelX: Math.max(0, Math.min(255, Math.floor((normalizedX - x) * 256))),
    pixelY: Math.max(0, Math.min(255, Math.floor((normalizedY - y) * 256)))
  };
}
function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = /* @__PURE__ */ __name(() => reject(new DOMException("Aborted", "AbortError")), "onAbort");
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
function persistentTileKey(source, x, y) {
  return `gsi-decoded-dem-v1/${source.id}/${source.zoom}/${x}/${y}.bin`;
}
function serializeDecodedElevationTile(tile) {
  const headerBytes = 12;
  const output = new Uint8Array(headerBytes + tile.heightsCentimeters.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, PERSISTENT_TILE_FORMAT_VERSION, true);
  view.setUint32(4, tile.width, true);
  view.setUint32(8, tile.height, true);
  output.set(
    new Uint8Array(
      tile.heightsCentimeters.buffer,
      tile.heightsCentimeters.byteOffset,
      tile.heightsCentimeters.byteLength
    ),
    headerBytes
  );
  return output.buffer;
}
function deserializeDecodedElevationTile(bytes) {
  const headerBytes = 12;
  if (bytes.byteLength < headerBytes) return null;
  const view = new DataView(bytes);
  const version = view.getUint32(0, true);
  const width = view.getUint32(4, true);
  const height = view.getUint32(8, true);
  if (version !== PERSISTENT_TILE_FORMAT_VERSION || width <= 0 || height <= 0 || width * height > 1048576 || bytes.byteLength !== headerBytes + width * height * Int32Array.BYTES_PER_ELEMENT) {
    return null;
  }
  const copied = bytes.slice(headerBytes);
  return { width, height, heightsCentimeters: new Int32Array(copied) };
}
async function readPersistentDecodedTile(source, x, y) {
  const persistentCache = serverPersistentCache();
  if (!persistentCache) return null;
  try {
    const bytes = await persistentCache.get(persistentTileKey(source, x, y), {
      type: "arrayBuffer"
    });
    return bytes instanceof ArrayBuffer ? deserializeDecodedElevationTile(bytes) : null;
  } catch {
    return null;
  }
}
function writePersistentDecodedTile(source, x, y, tile) {
  const persistentCache = serverPersistentCache();
  if (!persistentCache) return;
  const key2 = persistentTileKey(source, x, y);
  if (persistentWritePromises.has(key2)) return;
  const write = persistentCache.put(key2, serializeDecodedElevationTile(tile), {
    expirationTtl: PERSISTENT_TILE_TTL_SECONDS,
    metadata: {
      source: source.label,
      zoom: source.zoom,
      width: tile.width,
      height: tile.height,
      formatVersion: PERSISTENT_TILE_FORMAT_VERSION,
      savedAt: (/* @__PURE__ */ new Date()).toISOString()
    }
  }).then(() => void 0).catch(() => {
  }).finally(() => {
    persistentWritePromises.delete(key2);
  });
  persistentWritePromises.set(key2, write);
  keepServerTaskAlive(write);
}
async function fetchGsiTileWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("\u56FD\u571F\u5730\u7406\u9662\u6A19\u9AD8\u30BF\u30A4\u30EB\u53D6\u5F97\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8", "TimeoutError")),
    GSI_TILE_REQUEST_TIMEOUT_MS
  );
  try {
    return await fetch(url, {
      headers: { Accept: "image/png" },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}
async function fetchDecodedTile(source, x, y, signal) {
  const key2 = `${source.id}/${source.zoom}/${x}/${y}`;
  const cached = tileCache.get(key2);
  if (cached) return awaitWithAbort(cached, signal);
  const promise = withTileRequestLimit(async () => {
    const persistent = await readPersistentDecodedTile(source, x, y);
    if (persistent) return persistent;
    const response = await fetchGsiTileWithTimeout(
      `https://cyberjapandata.gsi.go.jp/xyz/${source.id}/${source.zoom}/${x}/${y}.png`
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`\u56FD\u571F\u5730\u7406\u9662\u6A19\u9AD8\u30BF\u30A4\u30EB\u53D6\u5F97\u30A8\u30E9\u30FC\uFF1A${response.status}`);
    }
    const decoded = decodeElevationTile(new Uint8Array(await response.arrayBuffer()));
    writePersistentDecodedTile(source, x, y, decoded);
    return decoded;
  }).catch((error) => {
    tileCache.delete(key2);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    console.warn(`\u56FD\u571F\u5730\u7406\u9662\u6A19\u9AD8\u30BF\u30A4\u30EB ${key2} \u3092\u5229\u7528\u3067\u304D\u307E\u305B\u3093`, error);
    return null;
  });
  tileCache.set(key2, promise);
  if (tileCache.size > MAX_TILE_CACHE_ENTRIES) {
    const oldestKey = tileCache.keys().next().value;
    if (typeof oldestKey === "string") tileCache.delete(oldestKey);
  }
  return awaitWithAbort(promise, signal);
}
function heightFromTile(tile, pixelX, pixelY) {
  if (pixelX >= tile.width || pixelY >= tile.height) return null;
  const heightCentimeters = tile.heightsCentimeters[pixelY * tile.width + pixelX];
  if (heightCentimeters === NO_DATA_HEIGHT_CENTIMETERS) return null;
  return heightCentimeters * 0.01;
}
function sourceIsAllowedForPoint(source, point2) {
  if (point2.maximumDetail === "10m") return source.label === "DEM10B";
  if (point2.maximumDetail === "5m") return source.label !== "DEM1A";
  return true;
}
async function lookupGsiElevations(points, signal) {
  if (points.length > 2048) {
    throw new Error("\u4E00\u5EA6\u306B\u53D6\u5F97\u3067\u304D\u308B\u6A19\u9AD8\u70B9\u306F2,048\u70B9\u307E\u3067\u3067\u3059");
  }
  for (const point2 of points) {
    if (!Number.isFinite(point2.latitude) || !Number.isFinite(point2.longitude) || point2.latitude < -90 || point2.latitude > 90 || point2.longitude < -180 || point2.longitude > 180) {
      throw new Error("\u6A19\u9AD8\u53D6\u5F97\u5EA7\u6A19\u304C\u4E0D\u6B63\u3067\u3059");
    }
  }
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const results = points.map(() => ({
    heightMeters: null,
    source: null
  }));
  const unresolved = /* @__PURE__ */ new Set();
  points.forEach((point2, index) => {
    if (isJapaneseCoverage(point2)) unresolved.add(index);
  });
  for (const source of GSI_TILE_SOURCES) {
    if (unresolved.size === 0) break;
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const requests = [];
    const uniqueTiles = /* @__PURE__ */ new Map();
    for (const index of unresolved) {
      const point2 = points[index];
      if (!sourceIsAllowedForPoint(source, point2)) continue;
      const coordinate = tileCoordinates(point2, source.zoom);
      const tileKey = `${coordinate.x}/${coordinate.y}`;
      requests.push({ index, coordinate, tileKey });
      if (!uniqueTiles.has(tileKey)) {
        uniqueTiles.set(tileKey, { x: coordinate.x, y: coordinate.y });
      }
    }
    if (requests.length === 0) continue;
    const tileEntries = await Promise.all(
      [...uniqueTiles.entries()].map(async ([tileKey, coordinate]) => [
        tileKey,
        await fetchDecodedTile(source, coordinate.x, coordinate.y, signal)
      ])
    );
    const tiles = new Map(tileEntries);
    for (const request of requests) {
      const tile = tiles.get(request.tileKey) ?? null;
      if (!tile) continue;
      const heightMeters = heightFromTile(
        tile,
        request.coordinate.pixelX,
        request.coordinate.pixelY
      );
      if (heightMeters === null) continue;
      results[request.index] = { heightMeters, source: source.label };
      unresolved.delete(request.index);
    }
  }
  return results;
}
var GSI_TILE_SOURCES, PNG_SIGNATURE, MAX_TILE_CACHE_ENTRIES, PERSISTENT_TILE_FORMAT_VERSION, PERSISTENT_TILE_TTL_SECONDS, NO_DATA_HEIGHT_CENTIMETERS, MAX_CONCURRENT_GSI_TILE_REQUESTS, tileCache, persistentWritePromises, activeTileRequests, tileRequestWaiters, GSI_TILE_REQUEST_TIMEOUT_MS;
var init_gsiElevation = __esm({
  "../server/gsiElevation.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_cloudflareRuntime();
    GSI_TILE_SOURCES = [
      // 国土地理院の公開順に合わせ、航空レーザ由来の1m/5m DEMを最優先する。
      { id: "dem1a_png", label: "DEM1A", zoom: 17 },
      { id: "dem5a_png", label: "DEM5A", zoom: 15 },
      { id: "dem5b_png", label: "DEM5B", zoom: 15 },
      { id: "dem5c_png", label: "DEM5C", zoom: 15 },
      { id: "dem_png", label: "DEM10B", zoom: 14 }
    ];
    PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
    MAX_TILE_CACHE_ENTRIES = 512;
    PERSISTENT_TILE_FORMAT_VERSION = 1;
    PERSISTENT_TILE_TTL_SECONDS = 30 * 24 * 60 * 60;
    NO_DATA_HEIGHT_CENTIMETERS = -2147483648;
    MAX_CONCURRENT_GSI_TILE_REQUESTS = 8;
    tileCache = /* @__PURE__ */ new Map();
    persistentWritePromises = /* @__PURE__ */ new Map();
    activeTileRequests = 0;
    tileRequestWaiters = [];
    __name(withTileRequestLimit, "withTileRequestLimit");
    __name(isJapaneseCoverage, "isJapaneseCoverage");
    __name(readChunkName, "readChunkName");
    __name(paethPredictor, "paethPredictor");
    __name(decodePng, "decodePng");
    __name(decodeElevationTile, "decodeElevationTile");
    __name(tileCoordinates, "tileCoordinates");
    __name(awaitWithAbort, "awaitWithAbort");
    __name(persistentTileKey, "persistentTileKey");
    __name(serializeDecodedElevationTile, "serializeDecodedElevationTile");
    __name(deserializeDecodedElevationTile, "deserializeDecodedElevationTile");
    __name(readPersistentDecodedTile, "readPersistentDecodedTile");
    __name(writePersistentDecodedTile, "writePersistentDecodedTile");
    GSI_TILE_REQUEST_TIMEOUT_MS = 8e3;
    __name(fetchGsiTileWithTimeout, "fetchGsiTileWithTimeout");
    __name(fetchDecodedTile, "fetchDecodedTile");
    __name(heightFromTile, "heightFromTile");
    __name(sourceIsAllowedForPoint, "sourceIsAllowedForPoint");
    __name(lookupGsiElevations, "lookupGsiElevations");
  }
});

// _shared/env.ts
function spotSearchJobKv(env) {
  return env.SPOT_SEARCH_JOBS;
}
function configureCloudflareServerRuntime(context) {
  configureServerRuntime({
    cesiumIonToken: context.env.CESIUM_ION_TOKEN ?? context.env.VITE_CESIUM_ION_TOKEN,
    persistentCache: context.env.SPOT_SEARCH_JOBS,
    waitUntil: /* @__PURE__ */ __name((promise) => context.waitUntil(promise), "waitUntil")
  });
}
var init_env = __esm({
  "_shared/env.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_cloudflareRuntime();
    __name(spotSearchJobKv, "spotSearchJobKv");
    __name(configureCloudflareServerRuntime, "configureCloudflareServerRuntime");
  }
});

// api/gsi-elevation.ts
function requestPoints(body) {
  if (typeof body !== "object" || body === null || !("points" in body)) return null;
  if (!Array.isArray(body.points)) return null;
  return body.points.map((value) => {
    if (typeof value !== "object" || value === null) {
      return { latitude: Number.NaN, longitude: Number.NaN };
    }
    return {
      latitude: "latitude" in value ? Number(value.latitude) : Number.NaN,
      longitude: "longitude" in value ? Number(value.longitude) : Number.NaN,
      maximumDetail: "maximumDetail" in value && (value.maximumDetail === "1m" || value.maximumDetail === "5m" || value.maximumDetail === "10m") ? value.maximumDetail : void 0
    };
  });
}
var onRequest2;
var init_gsi_elevation = __esm({
  "api/gsi-elevation.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_gsiElevation();
    init_env();
    init_http();
    __name(requestPoints, "requestPoints");
    onRequest2 = /* @__PURE__ */ __name(async (context) => {
      if (context.request.method !== "POST") {
        return jsonResponse({ error: "POST\u30EA\u30AF\u30A8\u30B9\u30C8\u306E\u307F\u5229\u7528\u3067\u304D\u307E\u3059" }, 405, "public, max-age=3600");
      }
      configureCloudflareServerRuntime(context);
      try {
        const points = requestPoints(await context.request.json());
        if (!points) {
          return jsonResponse({ error: "\u5EA7\u6A19\u306E\u914D\u5217\u304C\u3042\u308A\u307E\u305B\u3093" }, 400, "public, max-age=3600");
        }
        return jsonResponse(
          { samples: await lookupGsiElevations(points, context.request.signal) },
          200,
          "public, max-age=3600"
        );
      } catch (error) {
        return jsonResponse({ error: errorMessage(error) }, 422, "public, max-age=3600");
      }
    }, "onRequest");
  }
});

// ../server/lruPromiseCache.ts
var LruPromiseCache;
var init_lruPromiseCache = __esm({
  "../server/lruPromiseCache.ts"() {
    init_functionsRoutes_0_25847306968093076();
    LruPromiseCache = class {
      static {
        __name(this, "LruPromiseCache");
      }
      entries = /* @__PURE__ */ new Map();
      options;
      constructor(options) {
        this.options = options;
      }
      get(key2) {
        const entry = this.entries.get(key2);
        if (!entry) return void 0;
        if (this.options.ttlMs && Date.now() - entry.touchedAt > this.options.ttlMs) {
          this.entries.delete(key2);
          return void 0;
        }
        entry.touchedAt = Date.now();
        this.entries.delete(key2);
        this.entries.set(key2, entry);
        return entry.value;
      }
      set(key2, value) {
        const entry = { value, touchedAt: Date.now() };
        this.entries.delete(key2);
        this.entries.set(key2, entry);
        this.trim();
        value.catch(() => {
          if (this.entries.get(key2)?.value === value) this.entries.delete(key2);
        });
        return value;
      }
      getOrCreate(key2, factory) {
        return this.get(key2) ?? this.set(key2, factory());
      }
      delete(key2) {
        this.entries.delete(key2);
      }
      clear() {
        this.entries.clear();
      }
      get size() {
        return this.entries.size;
      }
      trim() {
        while (this.entries.size > this.options.maxEntries) {
          const oldest = this.entries.keys().next().value;
          if (typeof oldest !== "string") break;
          this.entries.delete(oldest);
        }
      }
    };
  }
});

// ../server/gsiGeoid.ts
function validatedCoordinate(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < 20 || latitude > 46.5 || longitude < 122 || longitude > 154) {
    throw new Error("\u30B8\u30AA\u30A4\u30C9\u9AD8\u306E\u53D6\u5F97\u7BC4\u56F2\u5916\u3067\u3059");
  }
}
async function lookupGsiGeoidHeight(latitude, longitude, signal, pointSpecific = false) {
  validatedCoordinate(latitude, longitude);
  const queryLatitude = Number(latitude.toFixed(pointSpecific ? 8 : 2));
  const queryLongitude = Number(longitude.toFixed(pointSpecific ? 8 : 2));
  const key2 = `${queryLatitude},${queryLongitude}`;
  const cached = cache.get(key2);
  if (cached) return cached;
  const request = fetch(
    "https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh/cgi/geoidcalc.pl?" + new URLSearchParams({
      outputType: "json",
      latitude: String(queryLatitude),
      longitude: String(queryLongitude)
    }),
    { headers: { Accept: "application/json" }, signal }
  ).then(async (response) => {
    if (!response.ok) {
      throw new Error(`\u56FD\u571F\u5730\u7406\u9662\u30B8\u30AA\u30A4\u30C9API\u30A8\u30E9\u30FC\uFF1A${response.status}`);
    }
    const data = await response.json();
    const height = Number(data.OutputData?.geoidHeight);
    if (!Number.isFinite(height)) {
      throw new Error("\u56FD\u571F\u5730\u7406\u9662\u30B8\u30AA\u30A4\u30C9API\u306E\u5FDC\u7B54\u304C\u4E0D\u6B63\u3067\u3059");
    }
    return height;
  });
  return cache.set(key2, request);
}
var cache;
var init_gsiGeoid = __esm({
  "../server/gsiGeoid.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_lruPromiseCache();
    cache = new LruPromiseCache({
      maxEntries: 128,
      ttlMs: 24 * 60 * 60 * 1e3
    });
    __name(validatedCoordinate, "validatedCoordinate");
    __name(lookupGsiGeoidHeight, "lookupGsiGeoidHeight");
  }
});

// api/gsi-geoid.ts
var onRequest3;
var init_gsi_geoid = __esm({
  "api/gsi-geoid.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_gsiGeoid();
    init_http();
    onRequest3 = /* @__PURE__ */ __name(async ({ request }) => {
      if (request.method !== "GET") {
        return jsonResponse({ error: "GET\u30EA\u30AF\u30A8\u30B9\u30C8\u306E\u307F\u5229\u7528\u3067\u304D\u307E\u3059" }, 405, "public, max-age=86400");
      }
      const url = new URL(request.url);
      try {
        const geoidHeightMeters = await lookupGsiGeoidHeight(
          Number(url.searchParams.get("latitude")),
          Number(url.searchParams.get("longitude")),
          request.signal,
          url.searchParams.get("precision") === "point"
        );
        return jsonResponse({ geoidHeightMeters }, 200, "public, max-age=86400");
      } catch (error) {
        return jsonResponse({ error: errorMessage(error) }, 422, "public, max-age=86400");
      }
    }, "onRequest");
  }
});

// ../node_modules/geographiclib-geodesic/geographiclib-geodesic.min.js
var require_geographiclib_geodesic_min = __commonJS({
  "../node_modules/geographiclib-geodesic/geographiclib-geodesic.min.js"(exports, module) {
    init_functionsRoutes_0_25847306968093076();
    (function(cb) {
      var geodesic = {};
      geodesic.Constants = {};
      geodesic.Math = {};
      geodesic.Accumulator = {};
      (function(c) {
        "use strict";
        c.WGS84 = { a: 6378137, f: 1 / 298.257223563 };
        c.version = { major: 2, minor: 2, patch: 0 };
        c.version_string = "2.2.0";
      })(geodesic.Constants);
      (function(m) {
        "use strict";
        m.digits = 53;
        m.epsilon = Math.pow(0.5, m.digits - 1);
        m.degree = Math.PI / 180;
        m.sq = function(x) {
          return x * x;
        };
        m.hypot = function(x, y) {
          return Math.sqrt(x * x + y * y);
        };
        m.cbrt = Math.cbrt || function(x) {
          var y = Math.pow(Math.abs(x), 1 / 3);
          return x > 0 ? y : x < 0 ? -y : x;
        };
        m.log1p = Math.log1p || function(x) {
          var y = 1 + x, z = y - 1;
          return z === 0 ? x : x * Math.log(y) / z;
        };
        m.atanh = Math.atanh || function(x) {
          var y = Math.abs(x);
          y = m.log1p(2 * y / (1 - y)) / 2;
          return x > 0 ? y : x < 0 ? -y : x;
        };
        m.copysign = function(x, y) {
          return Math.abs(x) * (y < 0 || y === 0 && 1 / y < 0 ? -1 : 1);
        };
        m.sum = function(u4, v2) {
          var s = u4 + v2, up = s - v2, vpp = s - up, t;
          up -= u4;
          vpp -= v2;
          t = s ? 0 - (up + vpp) : s;
          return { s, t };
        };
        m.polyval = function(N, p, s, x) {
          var y = N < 0 ? 0 : p[s++];
          while (--N >= 0) y = y * x + p[s++];
          return y;
        };
        m.AngRound = function(x) {
          var z = 1 / 16, y = Math.abs(x);
          y = y < z ? z - (z - y) : y;
          return m.copysign(y, x);
        };
        m.remainder = function(x, y) {
          x %= y;
          return x < -y / 2 ? x + y : x < y / 2 ? x : x - y;
        };
        m.AngNormalize = function(x) {
          var y = m.remainder(x, 360);
          return Math.abs(y) === 180 ? m.copysign(180, x) : y;
        };
        m.LatFix = function(x) {
          return Math.abs(x) > 90 ? NaN : x;
        };
        m.AngDiff = function(x, y) {
          var r = m.sum(m.remainder(-x, 360), m.remainder(y, 360)), d, e;
          r = m.sum(m.remainder(r.s, 360), r.t);
          d = r.s;
          e = r.t;
          if (d === 0 || Math.abs(d) === 180)
            d = m.copysign(d, e === 0 ? y - x : -e);
          return { d, e };
        };
        m.sincosd = function(x) {
          var d, r, q, s, c, sinx, cosx;
          d = x % 360;
          q = Math.round(d / 90);
          d -= 90 * q;
          r = d * this.degree;
          s = Math.sin(r);
          c = Math.cos(r);
          if (Math.abs(d) === 45) {
            c = Math.sqrt(0.5);
            s = m.copysign(c, r);
          } else if (Math.abs(d) === 30) {
            c = Math.sqrt(0.75);
            s = m.copysign(0.5, r);
          }
          switch (q & 3) {
            case 0:
              sinx = s;
              cosx = c;
              break;
            case 1:
              sinx = c;
              cosx = -s;
              break;
            case 2:
              sinx = -s;
              cosx = -c;
              break;
            default:
              sinx = -c;
              cosx = s;
              break;
          }
          cosx += 0;
          if (sinx === 0) sinx = m.copysign(sinx, x);
          return { s: sinx, c: cosx };
        };
        m.sincosde = function(x, t) {
          var d, r, q, s, c, sinx, cosx;
          d = x % 360;
          q = Math.round(d / 90);
          d = m.AngRound(d - 90 * q + t);
          r = d * this.degree;
          s = Math.sin(r);
          c = Math.cos(r);
          if (Math.abs(d) === 45) {
            c = Math.sqrt(0.5);
            s = m.copysign(c, r);
          } else if (Math.abs(d) === 30) {
            c = Math.sqrt(0.75);
            s = m.copysign(0.5, r);
          }
          switch (q & 3) {
            case 0:
              sinx = s;
              cosx = c;
              break;
            case 1:
              sinx = c;
              cosx = -s;
              break;
            case 2:
              sinx = -s;
              cosx = -c;
              break;
            default:
              sinx = -c;
              cosx = s;
              break;
          }
          cosx += 0;
          if (sinx === 0) sinx = m.copysign(sinx, x + t);
          return { s: sinx, c: cosx };
        };
        m.atan2d = function(y, x) {
          var q = 0, ang;
          if (Math.abs(y) > Math.abs(x)) {
            [y, x] = [x, y];
            q = 2;
          }
          if (m.copysign(1, x) < 0) {
            x = -x;
            ++q;
          }
          ang = Math.atan2(y, x) / this.degree;
          switch (q) {
            case 1:
              ang = m.copysign(180, y) - ang;
              break;
            case 2:
              ang = 90 - ang;
              break;
            case 3:
              ang = -90 + ang;
              break;
            default:
              break;
          }
          return ang;
        };
      })(geodesic.Math);
      (function(a, m) {
        "use strict";
        a.Accumulator = function(y) {
          this.Set(y);
        };
        a.Accumulator.prototype.Set = function(y) {
          if (!y) y = 0;
          if (y.constructor === a.Accumulator) {
            this._s = y._s;
            this._t = y._t;
          } else {
            this._s = y;
            this._t = 0;
          }
        };
        a.Accumulator.prototype.Add = function(y) {
          var u4 = m.sum(y, this._t), v2 = m.sum(u4.s, this._s);
          u4 = u4.t;
          this._s = v2.s;
          this._t = v2.t;
          if (this._s === 0)
            this._s = u4;
          else
            this._t += u4;
        };
        a.Accumulator.prototype.Sum = function(y) {
          var b;
          if (!y)
            return this._s;
          else {
            b = new a.Accumulator(this);
            b.Add(y);
            return b._s;
          }
        };
        a.Accumulator.prototype.Negate = function() {
          this._s *= -1;
          this._t *= -1;
        };
        a.Accumulator.prototype.Remainder = function(y) {
          this._s = m.remainder(this._s, y);
          this.Add(0);
        };
      })(geodesic.Accumulator, geodesic.Math);
      geodesic.Geodesic = {};
      geodesic.GeodesicLine = {};
      geodesic.PolygonArea = {};
      (function(g, l, p, m, c) {
        "use strict";
        var GEOGRAPHICLIB_GEODESIC_ORDER = 6, nA1_ = GEOGRAPHICLIB_GEODESIC_ORDER, nA2_ = GEOGRAPHICLIB_GEODESIC_ORDER, nA3_ = GEOGRAPHICLIB_GEODESIC_ORDER, nA3x_ = nA3_, nC3x_, nC4x_, maxit1_ = 20, maxit2_ = maxit1_ + m.digits + 10, tol0_ = m.epsilon, tol1_ = 200 * tol0_, tol2_ = Math.sqrt(tol0_), tolb_ = tol0_, xthresh_ = 1e3 * tol2_, CAP_NONE = 0, CAP_ALL = 31, OUT_ALL = 32640, astroid, A1m1f_coeff, C1f_coeff, C1pf_coeff, A2m1f_coeff, C2f_coeff, A3_coeff, C3_coeff, C4_coeff;
        g.tiny_ = Math.sqrt(Number.MIN_VALUE / Number.EPSILON);
        g.nC1_ = GEOGRAPHICLIB_GEODESIC_ORDER;
        g.nC1p_ = GEOGRAPHICLIB_GEODESIC_ORDER;
        g.nC2_ = GEOGRAPHICLIB_GEODESIC_ORDER;
        g.nC3_ = GEOGRAPHICLIB_GEODESIC_ORDER;
        g.nC4_ = GEOGRAPHICLIB_GEODESIC_ORDER;
        nC3x_ = g.nC3_ * (g.nC3_ - 1) / 2;
        nC4x_ = g.nC4_ * (g.nC4_ + 1) / 2;
        g.CAP_C1 = 1 << 0;
        g.CAP_C1p = 1 << 1;
        g.CAP_C2 = 1 << 2;
        g.CAP_C3 = 1 << 3;
        g.CAP_C4 = 1 << 4;
        g.NONE = 0;
        g.ARC = 1 << 6;
        g.LATITUDE = 1 << 7 | CAP_NONE;
        g.LONGITUDE = 1 << 8 | g.CAP_C3;
        g.AZIMUTH = 1 << 9 | CAP_NONE;
        g.DISTANCE = 1 << 10 | g.CAP_C1;
        g.STANDARD = g.LATITUDE | g.LONGITUDE | g.AZIMUTH | g.DISTANCE;
        g.DISTANCE_IN = 1 << 11 | g.CAP_C1 | g.CAP_C1p;
        g.REDUCEDLENGTH = 1 << 12 | g.CAP_C1 | g.CAP_C2;
        g.GEODESICSCALE = 1 << 13 | g.CAP_C1 | g.CAP_C2;
        g.AREA = 1 << 14 | g.CAP_C4;
        g.ALL = OUT_ALL | CAP_ALL;
        g.LONG_UNROLL = 1 << 15;
        g.OUT_MASK = OUT_ALL | g.LONG_UNROLL;
        g.SinCosSeries = function(sinp, sinx, cosx, c2) {
          var k = c2.length, n = k - (sinp ? 1 : 0), ar = 2 * (cosx - sinx) * (cosx + sinx), y0 = n & 1 ? c2[--k] : 0, y1 = 0;
          n = Math.floor(n / 2);
          while (n--) {
            y1 = ar * y0 - y1 + c2[--k];
            y0 = ar * y1 - y0 + c2[--k];
          }
          return sinp ? 2 * sinx * cosx * y0 : cosx * (y0 - y1);
        };
        astroid = /* @__PURE__ */ __name(function(x, y) {
          var k, p2 = m.sq(x), q = m.sq(y), r = (p2 + q - 1) / 6, S, r2, r3, disc, u4, T3, T, ang, v2, uv, w;
          if (!(q === 0 && r <= 0)) {
            S = p2 * q / 4;
            r2 = m.sq(r);
            r3 = r * r2;
            disc = S * (S + 2 * r3);
            u4 = r;
            if (disc >= 0) {
              T3 = S + r3;
              T3 += T3 < 0 ? -Math.sqrt(disc) : Math.sqrt(disc);
              T = m.cbrt(T3);
              u4 += T + (T !== 0 ? r2 / T : 0);
            } else {
              ang = Math.atan2(Math.sqrt(-disc), -(S + r3));
              u4 += 2 * r * Math.cos(ang / 3);
            }
            v2 = Math.sqrt(m.sq(u4) + q);
            uv = u4 < 0 ? q / (v2 - u4) : u4 + v2;
            w = (uv - q) / (2 * v2);
            k = uv / (Math.sqrt(uv + m.sq(w)) + w);
          } else {
            k = 0;
          }
          return k;
        }, "astroid");
        A1m1f_coeff = [1, 4, 64, 0, 256];
        g.A1m1f = function(eps) {
          var p2 = Math.floor(nA1_ / 2), t = m.polyval(p2, A1m1f_coeff, 0, m.sq(eps)) / A1m1f_coeff[p2 + 1];
          return (t + eps) / (1 - eps);
        };
        C1f_coeff = [-1, 6, -16, 32, -9, 64, -128, 2048, 9, -16, 768, 3, -5, 512, -7, 1280, -7, 2048];
        g.C1f = function(eps, c2) {
          var eps2 = m.sq(eps), d = eps, o = 0, l2, p2;
          for (l2 = 1; l2 <= g.nC1_; ++l2) {
            p2 = Math.floor((g.nC1_ - l2) / 2);
            c2[l2] = d * m.polyval(p2, C1f_coeff, o, eps2) / C1f_coeff[o + p2 + 1];
            o += p2 + 2;
            d *= eps;
          }
        };
        C1pf_coeff = [205, -432, 768, 1536, 4005, -4736, 3840, 12288, -225, 116, 384, -7173, 2695, 7680, 3467, 7680, 38081, 61440];
        g.C1pf = function(eps, c2) {
          var eps2 = m.sq(eps), d = eps, o = 0, l2, p2;
          for (l2 = 1; l2 <= g.nC1p_; ++l2) {
            p2 = Math.floor((g.nC1p_ - l2) / 2);
            c2[l2] = d * m.polyval(p2, C1pf_coeff, o, eps2) / C1pf_coeff[o + p2 + 1];
            o += p2 + 2;
            d *= eps;
          }
        };
        A2m1f_coeff = [-11, -28, -192, 0, 256];
        g.A2m1f = function(eps) {
          var p2 = Math.floor(nA2_ / 2), t = m.polyval(p2, A2m1f_coeff, 0, m.sq(eps)) / A2m1f_coeff[p2 + 1];
          return (t - eps) / (1 + eps);
        };
        C2f_coeff = [1, 2, 16, 32, 35, 64, 384, 2048, 15, 80, 768, 7, 35, 512, 63, 1280, 77, 2048];
        g.C2f = function(eps, c2) {
          var eps2 = m.sq(eps), d = eps, o = 0, l2, p2;
          for (l2 = 1; l2 <= g.nC2_; ++l2) {
            p2 = Math.floor((g.nC2_ - l2) / 2);
            c2[l2] = d * m.polyval(p2, C2f_coeff, o, eps2) / C2f_coeff[o + p2 + 1];
            o += p2 + 2;
            d *= eps;
          }
        };
        g.Geodesic = function(a, f) {
          this.a = a;
          this.f = f;
          this._f1 = 1 - this.f;
          this._e2 = this.f * (2 - this.f);
          this._ep2 = this._e2 / m.sq(this._f1);
          this._n = this.f / (2 - this.f);
          this._b = this.a * this._f1;
          this._c2 = (m.sq(this.a) + m.sq(this._b) * (this._e2 === 0 ? 1 : (this._e2 > 0 ? m.atanh(Math.sqrt(this._e2)) : Math.atan(Math.sqrt(-this._e2))) / Math.sqrt(Math.abs(this._e2)))) / 2;
          this._etol2 = 0.1 * tol2_ / Math.sqrt(Math.max(1e-3, Math.abs(this.f)) * Math.min(1, 1 - this.f / 2) / 2);
          if (!(isFinite(this.a) && this.a > 0))
            throw new Error("Equatorial radius is not positive");
          if (!(isFinite(this._b) && this._b > 0))
            throw new Error("Polar semi-axis is not positive");
          this._A3x = new Array(nA3x_);
          this._C3x = new Array(nC3x_);
          this._C4x = new Array(nC4x_);
          this.A3coeff();
          this.C3coeff();
          this.C4coeff();
        };
        A3_coeff = [-3, 128, -2, -3, 64, -1, -3, -1, 16, 3, -1, -2, 8, 1, -1, 2, 1, 1];
        g.Geodesic.prototype.A3coeff = function() {
          var o = 0, k = 0, j, p2;
          for (j = nA3_ - 1; j >= 0; --j) {
            p2 = Math.min(nA3_ - j - 1, j);
            this._A3x[k++] = m.polyval(p2, A3_coeff, o, this._n) / A3_coeff[o + p2 + 1];
            o += p2 + 2;
          }
        };
        C3_coeff = [3, 128, 2, 5, 128, -1, 3, 3, 64, -1, 0, 1, 8, -1, 1, 4, 5, 256, 1, 3, 128, -3, -2, 3, 64, 1, -3, 2, 32, 7, 512, -10, 9, 384, 5, -9, 5, 192, 7, 512, -14, 7, 512, 21, 2560];
        g.Geodesic.prototype.C3coeff = function() {
          var o = 0, k = 0, l2, j, p2;
          for (l2 = 1; l2 < g.nC3_; ++l2) {
            for (j = g.nC3_ - 1; j >= l2; --j) {
              p2 = Math.min(g.nC3_ - j - 1, j);
              this._C3x[k++] = m.polyval(p2, C3_coeff, o, this._n) / C3_coeff[o + p2 + 1];
              o += p2 + 2;
            }
          }
        };
        C4_coeff = [97, 15015, 1088, 156, 45045, -224, -4784, 1573, 45045, -10656, 14144, -4576, -858, 45045, 64, 624, -4576, 6864, -3003, 15015, 100, 208, 572, 3432, -12012, 30030, 45045, 1, 9009, -2944, 468, 135135, 5792, 1040, -1287, 135135, 5952, -11648, 9152, -2574, 135135, -64, -624, 4576, -6864, 3003, 135135, 8, 10725, 1856, -936, 225225, -8448, 4992, -1144, 225225, -1440, 4160, -4576, 1716, 225225, -136, 63063, 1024, -208, 105105, 3584, -3328, 1144, 315315, -128, 135135, -2560, 832, 405405, 128, 99099];
        g.Geodesic.prototype.C4coeff = function() {
          var o = 0, k = 0, l2, j, p2;
          for (l2 = 0; l2 < g.nC4_; ++l2) {
            for (j = g.nC4_ - 1; j >= l2; --j) {
              p2 = g.nC4_ - j - 1;
              this._C4x[k++] = m.polyval(p2, C4_coeff, o, this._n) / C4_coeff[o + p2 + 1];
              o += p2 + 2;
            }
          }
        };
        g.Geodesic.prototype.A3f = function(eps) {
          return m.polyval(nA3x_ - 1, this._A3x, 0, eps);
        };
        g.Geodesic.prototype.C3f = function(eps, c2) {
          var mult = 1, o = 0, l2, p2;
          for (l2 = 1; l2 < g.nC3_; ++l2) {
            p2 = g.nC3_ - l2 - 1;
            mult *= eps;
            c2[l2] = mult * m.polyval(p2, this._C3x, o, eps);
            o += p2 + 1;
          }
        };
        g.Geodesic.prototype.C4f = function(eps, c2) {
          var mult = 1, o = 0, l2, p2;
          for (l2 = 0; l2 < g.nC4_; ++l2) {
            p2 = g.nC4_ - l2 - 1;
            c2[l2] = mult * m.polyval(p2, this._C4x, o, eps);
            o += p2 + 1;
            mult *= eps;
          }
        };
        g.Geodesic.prototype.Lengths = function(eps, sig12, ssig1, csig1, dn1, ssig2, csig2, dn2, cbet1, cbet2, outmask, C1a, C2a) {
          outmask &= g.OUT_MASK;
          var vals = {}, m0x = 0, J12 = 0, A1 = 0, A2 = 0, B1, B2, l2, csig12, t;
          if (outmask & (g.DISTANCE | g.REDUCEDLENGTH | g.GEODESICSCALE)) {
            A1 = g.A1m1f(eps);
            g.C1f(eps, C1a);
            if (outmask & (g.REDUCEDLENGTH | g.GEODESICSCALE)) {
              A2 = g.A2m1f(eps);
              g.C2f(eps, C2a);
              m0x = A1 - A2;
              A2 = 1 + A2;
            }
            A1 = 1 + A1;
          }
          if (outmask & g.DISTANCE) {
            B1 = g.SinCosSeries(true, ssig2, csig2, C1a) - g.SinCosSeries(true, ssig1, csig1, C1a);
            vals.s12b = A1 * (sig12 + B1);
            if (outmask & (g.REDUCEDLENGTH | g.GEODESICSCALE)) {
              B2 = g.SinCosSeries(true, ssig2, csig2, C2a) - g.SinCosSeries(true, ssig1, csig1, C2a);
              J12 = m0x * sig12 + (A1 * B1 - A2 * B2);
            }
          } else if (outmask & (g.REDUCEDLENGTH | g.GEODESICSCALE)) {
            for (l2 = 1; l2 <= g.nC2_; ++l2)
              C2a[l2] = A1 * C1a[l2] - A2 * C2a[l2];
            J12 = m0x * sig12 + (g.SinCosSeries(true, ssig2, csig2, C2a) - g.SinCosSeries(true, ssig1, csig1, C2a));
          }
          if (outmask & g.REDUCEDLENGTH) {
            vals.m0 = m0x;
            vals.m12b = dn2 * (csig1 * ssig2) - dn1 * (ssig1 * csig2) - csig1 * csig2 * J12;
          } else
            vals.m12b = NaN;
          if (outmask & g.GEODESICSCALE) {
            csig12 = csig1 * csig2 + ssig1 * ssig2;
            t = this._ep2 * (cbet1 - cbet2) * (cbet1 + cbet2) / (dn1 + dn2);
            vals.M12 = csig12 + (t * ssig2 - csig2 * J12) * ssig1 / dn1;
            vals.M21 = csig12 - (t * ssig1 - csig1 * J12) * ssig2 / dn2;
          }
          return vals;
        };
        g.Geodesic.prototype.InverseStart = function(sbet1, cbet1, dn1, sbet2, cbet2, dn2, lam12, slam12, clam12, C1a, C2a) {
          var vals = {}, sbet12 = sbet2 * cbet1 - cbet2 * sbet1, cbet12 = cbet2 * cbet1 + sbet2 * sbet1, sbet12a, shortline, omg12, sbetm2, somg12, comg12, t, ssig12, csig12, x, y, lamscale, betscale, k2, eps, cbet12a, bet12a, m12b, m0, nvals, k, omg12a, lam12x;
          vals.sig12 = -1;
          sbet12a = sbet2 * cbet1;
          sbet12a += cbet2 * sbet1;
          shortline = cbet12 >= 0 && sbet12 < 0.5 && cbet2 * lam12 < 0.5;
          if (shortline) {
            sbetm2 = m.sq(sbet1 + sbet2);
            sbetm2 /= sbetm2 + m.sq(cbet1 + cbet2);
            vals.dnm = Math.sqrt(1 + this._ep2 * sbetm2);
            omg12 = lam12 / (this._f1 * vals.dnm);
            somg12 = Math.sin(omg12);
            comg12 = Math.cos(omg12);
          } else {
            somg12 = slam12;
            comg12 = clam12;
          }
          vals.salp1 = cbet2 * somg12;
          vals.calp1 = comg12 >= 0 ? sbet12 + cbet2 * sbet1 * m.sq(somg12) / (1 + comg12) : sbet12a - cbet2 * sbet1 * m.sq(somg12) / (1 - comg12);
          ssig12 = m.hypot(vals.salp1, vals.calp1);
          csig12 = sbet1 * sbet2 + cbet1 * cbet2 * comg12;
          if (shortline && ssig12 < this._etol2) {
            vals.salp2 = cbet1 * somg12;
            vals.calp2 = sbet12 - cbet1 * sbet2 * (comg12 >= 0 ? m.sq(somg12) / (1 + comg12) : 1 - comg12);
            t = m.hypot(vals.salp2, vals.calp2);
            vals.salp2 /= t;
            vals.calp2 /= t;
            vals.sig12 = Math.atan2(ssig12, csig12);
          } else if (Math.abs(this._n) > 0.1 || csig12 >= 0 || ssig12 >= 6 * Math.abs(this._n) * Math.PI * m.sq(cbet1)) {
          } else {
            lam12x = Math.atan2(-slam12, -clam12);
            if (this.f >= 0) {
              k2 = m.sq(sbet1) * this._ep2;
              eps = k2 / (2 * (1 + Math.sqrt(1 + k2)) + k2);
              lamscale = this.f * cbet1 * this.A3f(eps) * Math.PI;
              betscale = lamscale * cbet1;
              x = lam12x / lamscale;
              y = sbet12a / betscale;
            } else {
              cbet12a = cbet2 * cbet1 - sbet2 * sbet1;
              bet12a = Math.atan2(sbet12a, cbet12a);
              nvals = this.Lengths(this._n, Math.PI + bet12a, sbet1, -cbet1, dn1, sbet2, cbet2, dn2, cbet1, cbet2, g.REDUCEDLENGTH, C1a, C2a);
              m12b = nvals.m12b;
              m0 = nvals.m0;
              x = -1 + m12b / (cbet1 * cbet2 * m0 * Math.PI);
              betscale = x < -0.01 ? sbet12a / x : -this.f * m.sq(cbet1) * Math.PI;
              lamscale = betscale / cbet1;
              y = lam12 / lamscale;
            }
            if (y > -tol1_ && x > -1 - xthresh_) {
              if (this.f >= 0) {
                vals.salp1 = Math.min(1, -x);
                vals.calp1 = -Math.sqrt(1 - m.sq(vals.salp1));
              } else {
                vals.calp1 = Math.max(x > -tol1_ ? 0 : -1, x);
                vals.salp1 = Math.sqrt(1 - m.sq(vals.calp1));
              }
            } else {
              k = astroid(x, y);
              omg12a = lamscale * (this.f >= 0 ? -x * k / (1 + k) : -y * (1 + k) / k);
              somg12 = Math.sin(omg12a);
              comg12 = -Math.cos(omg12a);
              vals.salp1 = cbet2 * somg12;
              vals.calp1 = sbet12a - cbet2 * sbet1 * m.sq(somg12) / (1 - comg12);
            }
          }
          if (!(vals.salp1 <= 0)) {
            t = m.hypot(vals.salp1, vals.calp1);
            vals.salp1 /= t;
            vals.calp1 /= t;
          } else {
            vals.salp1 = 1;
            vals.calp1 = 0;
          }
          return vals;
        };
        g.Geodesic.prototype.Lambda12 = function(sbet1, cbet1, dn1, sbet2, cbet2, dn2, salp1, calp1, slam120, clam120, diffp, C1a, C2a, C3a) {
          var vals = {}, t, salp0, calp0, somg1, comg1, somg2, comg2, somg12, comg12, B312, eta, k2, nvals;
          if (sbet1 === 0 && calp1 === 0)
            calp1 = -g.tiny_;
          salp0 = salp1 * cbet1;
          calp0 = m.hypot(calp1, salp1 * sbet1);
          vals.ssig1 = sbet1;
          somg1 = salp0 * sbet1;
          vals.csig1 = comg1 = calp1 * cbet1;
          t = m.hypot(vals.ssig1, vals.csig1);
          vals.ssig1 /= t;
          vals.csig1 /= t;
          vals.salp2 = cbet2 !== cbet1 ? salp0 / cbet2 : salp1;
          vals.calp2 = cbet2 !== cbet1 || Math.abs(sbet2) !== -sbet1 ? Math.sqrt(m.sq(calp1 * cbet1) + (cbet1 < -sbet1 ? (cbet2 - cbet1) * (cbet1 + cbet2) : (sbet1 - sbet2) * (sbet1 + sbet2))) / cbet2 : Math.abs(calp1);
          vals.ssig2 = sbet2;
          somg2 = salp0 * sbet2;
          vals.csig2 = comg2 = vals.calp2 * cbet2;
          t = m.hypot(vals.ssig2, vals.csig2);
          vals.ssig2 /= t;
          vals.csig2 /= t;
          vals.sig12 = Math.atan2(Math.max(0, vals.csig1 * vals.ssig2 - vals.ssig1 * vals.csig2), vals.csig1 * vals.csig2 + vals.ssig1 * vals.ssig2);
          somg12 = Math.max(0, comg1 * somg2 - somg1 * comg2);
          comg12 = comg1 * comg2 + somg1 * somg2;
          eta = Math.atan2(somg12 * clam120 - comg12 * slam120, comg12 * clam120 + somg12 * slam120);
          k2 = m.sq(calp0) * this._ep2;
          vals.eps = k2 / (2 * (1 + Math.sqrt(1 + k2)) + k2);
          this.C3f(vals.eps, C3a);
          B312 = g.SinCosSeries(true, vals.ssig2, vals.csig2, C3a) - g.SinCosSeries(true, vals.ssig1, vals.csig1, C3a);
          vals.domg12 = -this.f * this.A3f(vals.eps) * salp0 * (vals.sig12 + B312);
          vals.lam12 = eta + vals.domg12;
          if (diffp) {
            if (vals.calp2 === 0)
              vals.dlam12 = -2 * this._f1 * dn1 / sbet1;
            else {
              nvals = this.Lengths(vals.eps, vals.sig12, vals.ssig1, vals.csig1, dn1, vals.ssig2, vals.csig2, dn2, cbet1, cbet2, g.REDUCEDLENGTH, C1a, C2a);
              vals.dlam12 = nvals.m12b;
              vals.dlam12 *= this._f1 / (vals.calp2 * cbet2);
            }
          }
          return vals;
        };
        g.Geodesic.prototype.Inverse = function(lat1, lon1, lat2, lon2, outmask) {
          var r, vals;
          if (!outmask) outmask = g.STANDARD;
          if (outmask === g.LONG_UNROLL) outmask |= g.STANDARD;
          outmask &= g.OUT_MASK;
          r = this.InverseInt(lat1, lon1, lat2, lon2, outmask);
          vals = r.vals;
          if (outmask & g.AZIMUTH) {
            vals.azi1 = m.atan2d(r.salp1, r.calp1);
            vals.azi2 = m.atan2d(r.salp2, r.calp2);
          }
          return vals;
        };
        g.Geodesic.prototype.InverseInt = function(lat1, lon1, lat2, lon2, outmask) {
          var vals = {}, lon12, lon12s, lonsign, t, swapp, latsign, sbet1, cbet1, sbet2, cbet2, s12x, m12x, dn1, dn2, lam12, slam12, clam12, sig12, calp1, salp1, calp2, salp2, C1a, C2a, C3a, meridian, nvals, ssig1, csig1, ssig2, csig2, eps, omg12, dnm, numit, salp1a, calp1a, salp1b, calp1b, tripn, tripb, v2, dv, dalp1, sdalp1, cdalp1, nsalp1, lengthmask, salp0, calp0, alp12, k2, A4, C4a, B41, B42, somg12, comg12, domg12, dbet1, dbet2, salp12, calp12, sdomg12, cdomg12;
          vals.lat1 = lat1 = m.LatFix(lat1);
          vals.lat2 = lat2 = m.LatFix(lat2);
          lat1 = m.AngRound(lat1);
          lat2 = m.AngRound(lat2);
          lon12 = m.AngDiff(lon1, lon2);
          lon12s = lon12.e;
          lon12 = lon12.d;
          if (outmask & g.LONG_UNROLL) {
            vals.lon1 = lon1;
            vals.lon2 = lon1 + lon12 + lon12s;
          } else {
            vals.lon1 = m.AngNormalize(lon1);
            vals.lon2 = m.AngNormalize(lon2);
          }
          lonsign = m.copysign(1, lon12);
          lon12 *= lonsign;
          lon12s *= lonsign;
          lam12 = lon12 * m.degree;
          t = m.sincosde(lon12, lon12s);
          slam12 = t.s;
          clam12 = t.c;
          lon12s = 180 - lon12 - lon12s;
          swapp = Math.abs(lat1) < Math.abs(lat2) || isNaN(lat2) ? -1 : 1;
          if (swapp < 0) {
            lonsign *= -1;
            [lat2, lat1] = [lat1, lat2];
          }
          latsign = m.copysign(1, -lat1);
          lat1 *= latsign;
          lat2 *= latsign;
          t = m.sincosd(lat1);
          sbet1 = this._f1 * t.s;
          cbet1 = t.c;
          t = m.hypot(sbet1, cbet1);
          sbet1 /= t;
          cbet1 /= t;
          cbet1 = Math.max(g.tiny_, cbet1);
          t = m.sincosd(lat2);
          sbet2 = this._f1 * t.s;
          cbet2 = t.c;
          t = m.hypot(sbet2, cbet2);
          sbet2 /= t;
          cbet2 /= t;
          cbet2 = Math.max(g.tiny_, cbet2);
          if (cbet1 < -sbet1) {
            if (cbet2 === cbet1)
              sbet2 = m.copysign(sbet1, sbet2);
          } else {
            if (Math.abs(sbet2) === -sbet1)
              cbet2 = cbet1;
          }
          dn1 = Math.sqrt(1 + this._ep2 * m.sq(sbet1));
          dn2 = Math.sqrt(1 + this._ep2 * m.sq(sbet2));
          C1a = new Array(g.nC1_ + 1);
          C2a = new Array(g.nC2_ + 1);
          C3a = new Array(g.nC3_);
          meridian = lat1 === -90 || slam12 === 0;
          if (meridian) {
            calp1 = clam12;
            salp1 = slam12;
            calp2 = 1;
            salp2 = 0;
            ssig1 = sbet1;
            csig1 = calp1 * cbet1;
            ssig2 = sbet2;
            csig2 = calp2 * cbet2;
            sig12 = Math.atan2(Math.max(0, csig1 * ssig2 - ssig1 * csig2), csig1 * csig2 + ssig1 * ssig2);
            nvals = this.Lengths(this._n, sig12, ssig1, csig1, dn1, ssig2, csig2, dn2, cbet1, cbet2, outmask | g.DISTANCE | g.REDUCEDLENGTH, C1a, C2a);
            s12x = nvals.s12b;
            m12x = nvals.m12b;
            if (outmask & g.GEODESICSCALE) {
              vals.M12 = nvals.M12;
              vals.M21 = nvals.M21;
            }
            if (sig12 < tol2_ || m12x >= 0) {
              if (sig12 < 3 * g.tiny_ || sig12 < tol0_ && (s12x < 0 || m12x < 0))
                sig12 = m12x = s12x = 0;
              m12x *= this._b;
              s12x *= this._b;
              vals.a12 = sig12 / m.degree;
            } else
              meridian = false;
          }
          somg12 = 2;
          if (!meridian && sbet1 === 0 && (this.f <= 0 || lon12s >= this.f * 180)) {
            calp1 = calp2 = 0;
            salp1 = salp2 = 1;
            s12x = this.a * lam12;
            sig12 = omg12 = lam12 / this._f1;
            m12x = this._b * Math.sin(sig12);
            if (outmask & g.GEODESICSCALE)
              vals.M12 = vals.M21 = Math.cos(sig12);
            vals.a12 = lon12 / this._f1;
          } else if (!meridian) {
            nvals = this.InverseStart(sbet1, cbet1, dn1, sbet2, cbet2, dn2, lam12, slam12, clam12, C1a, C2a);
            sig12 = nvals.sig12;
            salp1 = nvals.salp1;
            calp1 = nvals.calp1;
            if (sig12 >= 0) {
              salp2 = nvals.salp2;
              calp2 = nvals.calp2;
              dnm = nvals.dnm;
              s12x = sig12 * this._b * dnm;
              m12x = m.sq(dnm) * this._b * Math.sin(sig12 / dnm);
              if (outmask & g.GEODESICSCALE)
                vals.M12 = vals.M21 = Math.cos(sig12 / dnm);
              vals.a12 = sig12 / m.degree;
              omg12 = lam12 / (this._f1 * dnm);
            } else {
              numit = 0;
              salp1a = g.tiny_;
              calp1a = 1;
              salp1b = g.tiny_;
              calp1b = -1;
              for (tripn = false, tripb = false; ; ++numit) {
                nvals = this.Lambda12(sbet1, cbet1, dn1, sbet2, cbet2, dn2, salp1, calp1, slam12, clam12, numit < maxit1_, C1a, C2a, C3a);
                v2 = nvals.lam12;
                salp2 = nvals.salp2;
                calp2 = nvals.calp2;
                sig12 = nvals.sig12;
                ssig1 = nvals.ssig1;
                csig1 = nvals.csig1;
                ssig2 = nvals.ssig2;
                csig2 = nvals.csig2;
                eps = nvals.eps;
                domg12 = nvals.domg12;
                dv = nvals.dlam12;
                if (tripb || !(Math.abs(v2) >= (tripn ? 8 : 1) * tol0_) || numit == maxit2_)
                  break;
                if (v2 > 0 && (numit < maxit1_ || calp1 / salp1 > calp1b / salp1b)) {
                  salp1b = salp1;
                  calp1b = calp1;
                } else if (v2 < 0 && (numit < maxit1_ || calp1 / salp1 < calp1a / salp1a)) {
                  salp1a = salp1;
                  calp1a = calp1;
                }
                if (numit < maxit1_ && dv > 0) {
                  dalp1 = -v2 / dv;
                  if (Math.abs(dalp1) < Math.PI) {
                    sdalp1 = Math.sin(dalp1);
                    cdalp1 = Math.cos(dalp1);
                    nsalp1 = salp1 * cdalp1 + calp1 * sdalp1;
                    if (nsalp1 > 0) {
                      calp1 = calp1 * cdalp1 - salp1 * sdalp1;
                      salp1 = nsalp1;
                      t = m.hypot(salp1, calp1);
                      salp1 /= t;
                      calp1 /= t;
                      tripn = Math.abs(v2) <= 16 * tol0_;
                      continue;
                    }
                  }
                }
                salp1 = (salp1a + salp1b) / 2;
                calp1 = (calp1a + calp1b) / 2;
                t = m.hypot(salp1, calp1);
                salp1 /= t;
                calp1 /= t;
                tripn = false;
                tripb = Math.abs(salp1a - salp1) + (calp1a - calp1) < tolb_ || Math.abs(salp1 - salp1b) + (calp1 - calp1b) < tolb_;
              }
              lengthmask = outmask | (outmask & (g.REDUCEDLENGTH | g.GEODESICSCALE) ? g.DISTANCE : g.NONE);
              nvals = this.Lengths(eps, sig12, ssig1, csig1, dn1, ssig2, csig2, dn2, cbet1, cbet2, lengthmask, C1a, C2a);
              s12x = nvals.s12b;
              m12x = nvals.m12b;
              if (outmask & g.GEODESICSCALE) {
                vals.M12 = nvals.M12;
                vals.M21 = nvals.M21;
              }
              m12x *= this._b;
              s12x *= this._b;
              vals.a12 = sig12 / m.degree;
              if (outmask & g.AREA) {
                sdomg12 = Math.sin(domg12);
                cdomg12 = Math.cos(domg12);
                somg12 = slam12 * cdomg12 - clam12 * sdomg12;
                comg12 = clam12 * cdomg12 + slam12 * sdomg12;
              }
            }
          }
          if (outmask & g.DISTANCE)
            vals.s12 = 0 + s12x;
          if (outmask & g.REDUCEDLENGTH)
            vals.m12 = 0 + m12x;
          if (outmask & g.AREA) {
            salp0 = salp1 * cbet1;
            calp0 = m.hypot(calp1, salp1 * sbet1);
            if (calp0 !== 0 && salp0 !== 0) {
              ssig1 = sbet1;
              csig1 = calp1 * cbet1;
              ssig2 = sbet2;
              csig2 = calp2 * cbet2;
              k2 = m.sq(calp0) * this._ep2;
              eps = k2 / (2 * (1 + Math.sqrt(1 + k2)) + k2);
              A4 = m.sq(this.a) * calp0 * salp0 * this._e2;
              t = m.hypot(ssig1, csig1);
              ssig1 /= t;
              csig1 /= t;
              t = m.hypot(ssig2, csig2);
              ssig2 /= t;
              csig2 /= t;
              C4a = new Array(g.nC4_);
              this.C4f(eps, C4a);
              B41 = g.SinCosSeries(false, ssig1, csig1, C4a);
              B42 = g.SinCosSeries(false, ssig2, csig2, C4a);
              vals.S12 = A4 * (B42 - B41);
            } else
              vals.S12 = 0;
            if (!meridian && somg12 == 2) {
              somg12 = Math.sin(omg12);
              comg12 = Math.cos(omg12);
            }
            if (!meridian && comg12 > -0.7071 && sbet2 - sbet1 < 1.75) {
              domg12 = 1 + comg12;
              dbet1 = 1 + cbet1;
              dbet2 = 1 + cbet2;
              alp12 = 2 * Math.atan2(somg12 * (sbet1 * dbet2 + sbet2 * dbet1), domg12 * (sbet1 * sbet2 + dbet1 * dbet2));
            } else {
              salp12 = salp2 * calp1 - calp2 * salp1;
              calp12 = calp2 * calp1 + salp2 * salp1;
              if (salp12 === 0 && calp12 < 0) {
                salp12 = g.tiny_ * calp1;
                calp12 = -1;
              }
              alp12 = Math.atan2(salp12, calp12);
            }
            vals.S12 += this._c2 * alp12;
            vals.S12 *= swapp * lonsign * latsign;
            vals.S12 += 0;
          }
          if (swapp < 0) {
            [salp2, salp1] = [salp1, salp2];
            [calp2, calp1] = [calp1, calp2];
            if (outmask & g.GEODESICSCALE) {
              [vals.M21, vals.M12] = [vals.M12, vals.M21];
            }
          }
          salp1 *= swapp * lonsign;
          calp1 *= swapp * latsign;
          salp2 *= swapp * lonsign;
          calp2 *= swapp * latsign;
          return { vals, salp1, calp1, salp2, calp2 };
        };
        g.Geodesic.prototype.GenDirect = function(lat1, lon1, azi1, arcmode, s12_a12, outmask) {
          var line;
          if (!outmask) outmask = g.STANDARD;
          else if (outmask === g.LONG_UNROLL) outmask |= g.STANDARD;
          if (!arcmode) outmask |= g.DISTANCE_IN;
          line = new l.GeodesicLine(this, lat1, lon1, azi1, outmask);
          return line.GenPosition(arcmode, s12_a12, outmask);
        };
        g.Geodesic.prototype.Direct = function(lat1, lon1, azi1, s12, outmask) {
          return this.GenDirect(lat1, lon1, azi1, false, s12, outmask);
        };
        g.Geodesic.prototype.ArcDirect = function(lat1, lon1, azi1, a12, outmask) {
          return this.GenDirect(lat1, lon1, azi1, true, a12, outmask);
        };
        g.Geodesic.prototype.Line = function(lat1, lon1, azi1, caps) {
          return new l.GeodesicLine(this, lat1, lon1, azi1, caps);
        };
        g.Geodesic.prototype.DirectLine = function(lat1, lon1, azi1, s12, caps) {
          return this.GenDirectLine(lat1, lon1, azi1, false, s12, caps);
        };
        g.Geodesic.prototype.ArcDirectLine = function(lat1, lon1, azi1, a12, caps) {
          return this.GenDirectLine(lat1, lon1, azi1, true, a12, caps);
        };
        g.Geodesic.prototype.GenDirectLine = function(lat1, lon1, azi1, arcmode, s12_a12, caps) {
          var t;
          if (!caps) caps = g.STANDARD | g.DISTANCE_IN;
          if (!arcmode) caps |= g.DISTANCE_IN;
          t = new l.GeodesicLine(this, lat1, lon1, azi1, caps);
          t.GenSetDistance(arcmode, s12_a12);
          return t;
        };
        g.Geodesic.prototype.InverseLine = function(lat1, lon1, lat2, lon2, caps) {
          var r, t, azi1;
          if (!caps) caps = g.STANDARD | g.DISTANCE_IN;
          r = this.InverseInt(lat1, lon1, lat2, lon2, g.ARC);
          azi1 = m.atan2d(r.salp1, r.calp1);
          if (caps & (g.OUT_MASK & g.DISTANCE_IN)) caps |= g.DISTANCE;
          t = new l.GeodesicLine(this, lat1, lon1, azi1, caps, r.salp1, r.calp1);
          t.SetArc(r.vals.a12);
          return t;
        };
        g.Geodesic.prototype.Polygon = function(polyline) {
          return new p.PolygonArea(this, polyline);
        };
        g.WGS84 = new g.Geodesic(c.WGS84.a, c.WGS84.f);
      })(geodesic.Geodesic, geodesic.GeodesicLine, geodesic.PolygonArea, geodesic.Math, geodesic.Constants);
      (function(g, l, m) {
        "use strict";
        l.GeodesicLine = function(geod, lat1, lon1, azi1, caps, salp1, calp1) {
          var t, cbet1, sbet1, eps, s, c;
          if (!caps) caps = g.STANDARD | g.DISTANCE_IN;
          this.a = geod.a;
          this.f = geod.f;
          this._b = geod._b;
          this._c2 = geod._c2;
          this._f1 = geod._f1;
          this.caps = caps | g.LATITUDE | g.AZIMUTH | g.LONG_UNROLL;
          this.lat1 = m.LatFix(lat1);
          this.lon1 = lon1;
          if (typeof salp1 === "undefined" || typeof calp1 === "undefined") {
            this.azi1 = m.AngNormalize(azi1);
            t = m.sincosd(m.AngRound(this.azi1));
            this.salp1 = t.s;
            this.calp1 = t.c;
          } else {
            this.azi1 = azi1;
            this.salp1 = salp1;
            this.calp1 = calp1;
          }
          t = m.sincosd(m.AngRound(this.lat1));
          sbet1 = this._f1 * t.s;
          cbet1 = t.c;
          t = m.hypot(sbet1, cbet1);
          sbet1 /= t;
          cbet1 /= t;
          cbet1 = Math.max(g.tiny_, cbet1);
          this._dn1 = Math.sqrt(1 + geod._ep2 * m.sq(sbet1));
          this._salp0 = this.salp1 * cbet1;
          this._calp0 = m.hypot(this.calp1, this.salp1 * sbet1);
          this._ssig1 = sbet1;
          this._somg1 = this._salp0 * sbet1;
          this._csig1 = this._comg1 = sbet1 !== 0 || this.calp1 !== 0 ? cbet1 * this.calp1 : 1;
          t = m.hypot(this._ssig1, this._csig1);
          this._ssig1 /= t;
          this._csig1 /= t;
          this._k2 = m.sq(this._calp0) * geod._ep2;
          eps = this._k2 / (2 * (1 + Math.sqrt(1 + this._k2)) + this._k2);
          if (this.caps & g.CAP_C1) {
            this._A1m1 = g.A1m1f(eps);
            this._C1a = new Array(g.nC1_ + 1);
            g.C1f(eps, this._C1a);
            this._B11 = g.SinCosSeries(true, this._ssig1, this._csig1, this._C1a);
            s = Math.sin(this._B11);
            c = Math.cos(this._B11);
            this._stau1 = this._ssig1 * c + this._csig1 * s;
            this._ctau1 = this._csig1 * c - this._ssig1 * s;
          }
          if (this.caps & g.CAP_C1p) {
            this._C1pa = new Array(g.nC1p_ + 1);
            g.C1pf(eps, this._C1pa);
          }
          if (this.caps & g.CAP_C2) {
            this._A2m1 = g.A2m1f(eps);
            this._C2a = new Array(g.nC2_ + 1);
            g.C2f(eps, this._C2a);
            this._B21 = g.SinCosSeries(true, this._ssig1, this._csig1, this._C2a);
          }
          if (this.caps & g.CAP_C3) {
            this._C3a = new Array(g.nC3_);
            geod.C3f(eps, this._C3a);
            this._A3c = -this.f * this._salp0 * geod.A3f(eps);
            this._B31 = g.SinCosSeries(true, this._ssig1, this._csig1, this._C3a);
          }
          if (this.caps & g.CAP_C4) {
            this._C4a = new Array(g.nC4_);
            geod.C4f(eps, this._C4a);
            this._A4 = m.sq(this.a) * this._calp0 * this._salp0 * geod._e2;
            this._B41 = g.SinCosSeries(false, this._ssig1, this._csig1, this._C4a);
          }
          this.a13 = this.s13 = NaN;
        };
        l.GeodesicLine.prototype.GenPosition = function(arcmode, s12_a12, outmask) {
          var vals = {}, sig12, ssig12, csig12, B12, AB1, ssig2, csig2, tau12, s, c, serr, omg12, lam12, lon12, E, sbet2, cbet2, somg2, comg2, salp2, calp2, dn2, B22, AB2, J12, t, B42, salp12, calp12;
          if (!outmask) outmask = g.STANDARD;
          else if (outmask === g.LONG_UNROLL) outmask |= g.STANDARD;
          outmask &= this.caps & g.OUT_MASK;
          vals.lat1 = this.lat1;
          vals.azi1 = this.azi1;
          vals.lon1 = outmask & g.LONG_UNROLL ? this.lon1 : m.AngNormalize(this.lon1);
          if (arcmode)
            vals.a12 = s12_a12;
          else
            vals.s12 = s12_a12;
          if (!(arcmode || this.caps & g.DISTANCE_IN & g.OUT_MASK)) {
            vals.a12 = NaN;
            return vals;
          }
          B12 = 0;
          AB1 = 0;
          if (arcmode) {
            sig12 = s12_a12 * m.degree;
            t = m.sincosd(s12_a12);
            ssig12 = t.s;
            csig12 = t.c;
          } else {
            tau12 = s12_a12 / (this._b * (1 + this._A1m1));
            s = Math.sin(tau12);
            c = Math.cos(tau12);
            B12 = -g.SinCosSeries(true, this._stau1 * c + this._ctau1 * s, this._ctau1 * c - this._stau1 * s, this._C1pa);
            sig12 = tau12 - (B12 - this._B11);
            ssig12 = Math.sin(sig12);
            csig12 = Math.cos(sig12);
            if (Math.abs(this.f) > 0.01) {
              ssig2 = this._ssig1 * csig12 + this._csig1 * ssig12;
              csig2 = this._csig1 * csig12 - this._ssig1 * ssig12;
              B12 = g.SinCosSeries(true, ssig2, csig2, this._C1a);
              serr = (1 + this._A1m1) * (sig12 + (B12 - this._B11)) - s12_a12 / this._b;
              sig12 = sig12 - serr / Math.sqrt(1 + this._k2 * m.sq(ssig2));
              ssig12 = Math.sin(sig12);
              csig12 = Math.cos(sig12);
            }
          }
          ssig2 = this._ssig1 * csig12 + this._csig1 * ssig12;
          csig2 = this._csig1 * csig12 - this._ssig1 * ssig12;
          dn2 = Math.sqrt(1 + this._k2 * m.sq(ssig2));
          if (outmask & (g.DISTANCE | g.REDUCEDLENGTH | g.GEODESICSCALE)) {
            if (arcmode || Math.abs(this.f) > 0.01)
              B12 = g.SinCosSeries(true, ssig2, csig2, this._C1a);
            AB1 = (1 + this._A1m1) * (B12 - this._B11);
          }
          sbet2 = this._calp0 * ssig2;
          cbet2 = m.hypot(this._salp0, this._calp0 * csig2);
          if (cbet2 === 0)
            cbet2 = csig2 = g.tiny_;
          salp2 = this._salp0;
          calp2 = this._calp0 * csig2;
          if (arcmode && outmask & g.DISTANCE)
            vals.s12 = this._b * ((1 + this._A1m1) * sig12 + AB1);
          if (outmask & g.LONGITUDE) {
            somg2 = this._salp0 * ssig2;
            comg2 = csig2;
            E = m.copysign(1, this._salp0);
            omg12 = outmask & g.LONG_UNROLL ? E * (sig12 - (Math.atan2(ssig2, csig2) - Math.atan2(this._ssig1, this._csig1)) + (Math.atan2(E * somg2, comg2) - Math.atan2(E * this._somg1, this._comg1))) : Math.atan2(somg2 * this._comg1 - comg2 * this._somg1, comg2 * this._comg1 + somg2 * this._somg1);
            lam12 = omg12 + this._A3c * (sig12 + (g.SinCosSeries(true, ssig2, csig2, this._C3a) - this._B31));
            lon12 = lam12 / m.degree;
            vals.lon2 = outmask & g.LONG_UNROLL ? this.lon1 + lon12 : m.AngNormalize(m.AngNormalize(this.lon1) + m.AngNormalize(lon12));
          }
          if (outmask & g.LATITUDE)
            vals.lat2 = m.atan2d(sbet2, this._f1 * cbet2);
          if (outmask & g.AZIMUTH)
            vals.azi2 = m.atan2d(salp2, calp2);
          if (outmask & (g.REDUCEDLENGTH | g.GEODESICSCALE)) {
            B22 = g.SinCosSeries(true, ssig2, csig2, this._C2a);
            AB2 = (1 + this._A2m1) * (B22 - this._B21);
            J12 = (this._A1m1 - this._A2m1) * sig12 + (AB1 - AB2);
            if (outmask & g.REDUCEDLENGTH)
              vals.m12 = this._b * (dn2 * (this._csig1 * ssig2) - this._dn1 * (this._ssig1 * csig2) - this._csig1 * csig2 * J12);
            if (outmask & g.GEODESICSCALE) {
              t = this._k2 * (ssig2 - this._ssig1) * (ssig2 + this._ssig1) / (this._dn1 + dn2);
              vals.M12 = csig12 + (t * ssig2 - csig2 * J12) * this._ssig1 / this._dn1;
              vals.M21 = csig12 - (t * this._ssig1 - this._csig1 * J12) * ssig2 / dn2;
            }
          }
          if (outmask & g.AREA) {
            B42 = g.SinCosSeries(false, ssig2, csig2, this._C4a);
            if (this._calp0 === 0 || this._salp0 === 0) {
              salp12 = salp2 * this.calp1 - calp2 * this.salp1;
              calp12 = calp2 * this.calp1 + salp2 * this.salp1;
            } else {
              salp12 = this._calp0 * this._salp0 * (csig12 <= 0 ? this._csig1 * (1 - csig12) + ssig12 * this._ssig1 : ssig12 * (this._csig1 * ssig12 / (1 + csig12) + this._ssig1));
              calp12 = m.sq(this._salp0) + m.sq(this._calp0) * this._csig1 * csig2;
            }
            vals.S12 = this._c2 * Math.atan2(salp12, calp12) + this._A4 * (B42 - this._B41);
          }
          if (!arcmode)
            vals.a12 = sig12 / m.degree;
          return vals;
        };
        l.GeodesicLine.prototype.Position = function(s12, outmask) {
          return this.GenPosition(false, s12, outmask);
        };
        l.GeodesicLine.prototype.ArcPosition = function(a12, outmask) {
          return this.GenPosition(true, a12, outmask);
        };
        l.GeodesicLine.prototype.GenSetDistance = function(arcmode, s13_a13) {
          if (arcmode)
            this.SetArc(s13_a13);
          else
            this.SetDistance(s13_a13);
        };
        l.GeodesicLine.prototype.SetDistance = function(s13) {
          var r;
          this.s13 = s13;
          r = this.GenPosition(false, this.s13, g.ARC);
          this.a13 = 0 + r.a12;
        };
        l.GeodesicLine.prototype.SetArc = function(a13) {
          var r;
          this.a13 = a13;
          r = this.GenPosition(true, this.a13, g.DISTANCE);
          this.s13 = 0 + r.s12;
        };
      })(geodesic.Geodesic, geodesic.GeodesicLine, geodesic.Math);
      (function(p, g, m, a) {
        "use strict";
        var transit, transitdirect, AreaReduceA, AreaReduceB;
        transit = /* @__PURE__ */ __name(function(lon1, lon2) {
          var lon12 = m.AngDiff(lon1, lon2).d;
          lon1 = m.AngNormalize(lon1);
          lon2 = m.AngNormalize(lon2);
          return lon12 > 0 && (lon1 < 0 && lon2 >= 0 || lon1 > 0 && lon2 === 0) ? 1 : lon12 < 0 && lon1 >= 0 && lon2 < 0 ? -1 : 0;
        }, "transit");
        transitdirect = /* @__PURE__ */ __name(function(lon1, lon2) {
          lon1 = lon1 % 720;
          lon2 = lon2 % 720;
          return (0 <= lon2 && lon2 < 360 || lon2 < -360 ? 0 : 1) - (0 <= lon1 && lon1 < 360 || lon1 < -360 ? 0 : 1);
        }, "transitdirect");
        AreaReduceA = /* @__PURE__ */ __name(function(area, area0, crossings, reverse, sign) {
          area.Remainder(area0);
          if (crossings & 1)
            area.Add((area.Sum() < 0 ? 1 : -1) * area0 / 2);
          if (!reverse)
            area.Negate();
          if (sign) {
            if (area.Sum() > area0 / 2)
              area.Add(-area0);
            else if (area.Sum() <= -area0 / 2)
              area.Add(+area0);
          } else {
            if (area.Sum() >= area0)
              area.Add(-area0);
            else if (area.Sum() < 0)
              area.Add(+area0);
          }
          return 0 + area.Sum();
        }, "AreaReduceA");
        AreaReduceB = /* @__PURE__ */ __name(function(area, area0, crossings, reverse, sign) {
          area = m.remainder(area, area0);
          if (crossings & 1)
            area += (area < 0 ? 1 : -1) * area0 / 2;
          if (!reverse)
            area *= -1;
          if (sign) {
            if (area > area0 / 2)
              area -= area0;
            else if (area <= -area0 / 2)
              area += area0;
          } else {
            if (area >= area0)
              area -= area0;
            else if (area < 0)
              area += area0;
          }
          return 0 + area;
        }, "AreaReduceB");
        p.PolygonArea = function(geod, polyline) {
          this._geod = geod;
          this.a = this._geod.a;
          this.f = this._geod.f;
          this._area0 = 4 * Math.PI * geod._c2;
          this.polyline = !polyline ? false : polyline;
          this._mask = g.LATITUDE | g.LONGITUDE | g.DISTANCE | (this.polyline ? g.NONE : g.AREA | g.LONG_UNROLL);
          if (!this.polyline)
            this._areasum = new a.Accumulator(0);
          this._perimetersum = new a.Accumulator(0);
          this.Clear();
        };
        p.PolygonArea.prototype.Clear = function() {
          this.num = 0;
          this._crossings = 0;
          if (!this.polyline)
            this._areasum.Set(0);
          this._perimetersum.Set(0);
          this._lat0 = this._lon0 = this.lat = this.lon = NaN;
        };
        p.PolygonArea.prototype.AddPoint = function(lat, lon) {
          var t;
          if (this.num === 0) {
            this._lat0 = this.lat = lat;
            this._lon0 = this.lon = lon;
          } else {
            t = this._geod.Inverse(this.lat, this.lon, lat, lon, this._mask);
            this._perimetersum.Add(t.s12);
            if (!this.polyline) {
              this._areasum.Add(t.S12);
              this._crossings += transit(this.lon, lon);
            }
            this.lat = lat;
            this.lon = lon;
          }
          ++this.num;
        };
        p.PolygonArea.prototype.AddEdge = function(azi, s) {
          var t;
          if (this.num) {
            t = this._geod.Direct(this.lat, this.lon, azi, s, this._mask);
            this._perimetersum.Add(s);
            if (!this.polyline) {
              this._areasum.Add(t.S12);
              this._crossings += transitdirect(this.lon, t.lon2);
            }
            this.lat = t.lat2;
            this.lon = t.lon2;
          }
          ++this.num;
        };
        p.PolygonArea.prototype.Compute = function(reverse, sign) {
          var vals = { number: this.num }, t, tempsum;
          if (this.num < 2) {
            vals.perimeter = 0;
            if (!this.polyline)
              vals.area = 0;
            return vals;
          }
          if (this.polyline) {
            vals.perimeter = this._perimetersum.Sum();
            return vals;
          }
          t = this._geod.Inverse(this.lat, this.lon, this._lat0, this._lon0, this._mask);
          vals.perimeter = this._perimetersum.Sum(t.s12);
          tempsum = new a.Accumulator(this._areasum);
          tempsum.Add(t.S12);
          vals.area = AreaReduceA(tempsum, this._area0, this._crossings + transit(this.lon, this._lon0), reverse, sign);
          return vals;
        };
        p.PolygonArea.prototype.TestPoint = function(lat, lon, reverse, sign) {
          var vals = { number: this.num + 1 }, t, tempsum, crossings, i;
          if (this.num === 0) {
            vals.perimeter = 0;
            if (!this.polyline)
              vals.area = 0;
            return vals;
          }
          vals.perimeter = this._perimetersum.Sum();
          tempsum = this.polyline ? 0 : this._areasum.Sum();
          crossings = this._crossings;
          for (i = 0; i < (this.polyline ? 1 : 2); ++i) {
            t = this._geod.Inverse(i === 0 ? this.lat : lat, i === 0 ? this.lon : lon, i !== 0 ? this._lat0 : lat, i !== 0 ? this._lon0 : lon, this._mask);
            vals.perimeter += t.s12;
            if (!this.polyline) {
              tempsum += t.S12;
              crossings += transit(i === 0 ? this.lon : lon, i !== 0 ? this._lon0 : lon);
            }
          }
          if (this.polyline)
            return vals;
          vals.area = AreaReduceB(tempsum, this._area0, crossings, reverse, sign);
          return vals;
        };
        p.PolygonArea.prototype.TestEdge = function(azi, s, reverse, sign) {
          var vals = { number: this.num ? this.num + 1 : 0 }, t, tempsum, crossings;
          if (this.num === 0)
            return vals;
          vals.perimeter = this._perimetersum.Sum() + s;
          if (this.polyline)
            return vals;
          tempsum = this._areasum.Sum();
          crossings = this._crossings;
          t = this._geod.Direct(this.lat, this.lon, azi, s, this._mask);
          tempsum += t.S12;
          crossings += transitdirect(this.lon, t.lon2);
          crossings += transit(t.lon2, this._lon0);
          t = this._geod.Inverse(t.lat2, t.lon2, this._lat0, this._lon0, this._mask);
          vals.perimeter += t.s12;
          tempsum += t.S12;
          vals.area = AreaReduceB(tempsum, this._area0, crossings, reverse, sign);
          return vals;
        };
      })(geodesic.PolygonArea, geodesic.Geodesic, geodesic.Math, geodesic.Accumulator);
      cb(geodesic);
    })(function(geo) {
      if (typeof module === "object" && module.exports) {
        module.exports = geo;
      } else if (typeof define === "function" && define.amd) {
        define("geographiclib-geodesic", [], function() {
          return geo;
        });
      } else {
        window.geodesic = geo;
      }
    });
  }
});

// ../src/geodesy/karneyGeodesic.ts
function assertFiniteNumber(value, valueName) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${valueName} must be a finite number.`);
  }
}
function assertValidGeodeticCoordinate(coordinate, coordinateName) {
  assertFiniteNumber(coordinate.latitude, `${coordinateName} latitude`);
  assertFiniteNumber(coordinate.longitude, `${coordinateName} longitude`);
  if (coordinate.latitude < -90 || coordinate.latitude > 90) {
    throw new Error(`${coordinateName} latitude must be between -90 and 90 degrees.`);
  }
}
function calculateKarneySurfaceMetrics(origin, target) {
  assertValidGeodeticCoordinate(origin, "Karney inverse origin");
  assertValidGeodeticCoordinate(target, "Karney inverse target");
  const result = Geodesic.WGS84.Inverse(
    origin.latitude,
    origin.longitude,
    target.latitude,
    target.longitude,
    Geodesic.STANDARD
  );
  const distanceMeters2 = result.s12;
  const initialBearingDegrees = result.azi1;
  assertFiniteNumber(distanceMeters2, "Karney inverse distance result");
  assertFiniteNumber(initialBearingDegrees, "Karney inverse initial bearing result");
  if (distanceMeters2 < 0) {
    throw new Error("Karney inverse distance result must be non-negative.");
  }
  return {
    distanceMeters: distanceMeters2,
    bearingDegrees: normalizeBearingDegrees(
      initialBearingDegrees,
      "Karney inverse initial bearing result"
    )
  };
}
function calculateKarneySurfaceDistanceMeters(origin, target) {
  return calculateKarneySurfaceMetrics(origin, target).distanceMeters;
}
function normalizeBearingDegrees(value, valueName) {
  assertFiniteNumber(value, valueName);
  return (value % 360 + 360) % 360;
}
var import_geographiclib_geodesic, Geodesic;
var init_karneyGeodesic = __esm({
  "../src/geodesy/karneyGeodesic.ts"() {
    init_functionsRoutes_0_25847306968093076();
    import_geographiclib_geodesic = __toESM(require_geographiclib_geodesic_min(), 1);
    ({ Geodesic } = import_geographiclib_geodesic.default);
    __name(assertFiniteNumber, "assertFiniteNumber");
    __name(assertValidGeodeticCoordinate, "assertValidGeodeticCoordinate");
    __name(calculateKarneySurfaceMetrics, "calculateKarneySurfaceMetrics");
    __name(calculateKarneySurfaceDistanceMeters, "calculateKarneySurfaceDistanceMeters");
    __name(normalizeBearingDegrees, "normalizeBearingDegrees");
  }
});

// ../server/precisionStructures.ts
function distanceMeters(origin, target) {
  return calculateKarneySurfaceDistanceMeters(origin, target);
}
function precisionStructuresNear(point2, radiusMeters = 1800) {
  return OUGATOU_PRECISION_STRUCTURES.flatMap((structure) => {
    const distance = distanceMeters(point2, structure);
    return distance <= radiusMeters ? [{ ...structure, distanceMeters: Math.round(distance) }] : [];
  });
}
var OSM_NODE_BASE_URL, OUGATOU_PRECISION_STRUCTURES;
var init_precisionStructures = __esm({
  "../server/precisionStructures.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_karneyGeodesic();
    OSM_NODE_BASE_URL = "https://www.openstreetmap.org/node/";
    OUGATOU_PRECISION_STRUCTURES = [
      {
        id: "ougatou-hotel",
        name: "\u738B\u30F6\u982D\u30DB\u30C6\u30EB",
        type: "hotel",
        latitude: 36.2257334,
        longitude: 138.1087099,
        groundElevationMeters: 2029.1,
        groundElevationSource: "GSI_DEM1A_LIDAR",
        structureHeightMeters: null,
        osmType: "node",
        osmId: 1150853443,
        sourceUrl: `${OSM_NODE_BASE_URL}1150853443`,
        note: "\u30DB\u30C6\u30EB\u516C\u5F0F\u60C5\u5831\u3067\u306F\u738B\u30F6\u982D\u5C71\u9802\uFF08\u6A19\u9AD82,034m\uFF09\u306B\u7ACB\u5730\u3002\u5EFA\u7269\u9AD8\u306F\u672A\u691C\u8A3C\u3002"
      },
      ...[
        [1, 8247387026, 36.2261699, 138.1070149, 2031.74, "\u738B\u30F6\u982D"],
        [2, 8247387027, 36.2260488, 138.1078732, 2032.3, "\u738B\u30F6\u982D"],
        [3, 8247387028, 36.2260661, 138.1083345, 2032.71, "\u738B\u30F6\u982D"],
        [4, 8247387029, 36.2261267, 138.1089782, 2031.1, "\u738B\u30F6\u982D"],
        [5, 8247387030, 36.2260228, 138.1095147, 2027.94, "\u738B\u30F6\u982D"],
        [6, 8247387031, 36.2266373, 138.1093216, 2026.67, "\u738B\u30F6\u982D"],
        [7, 8247387032, 36.2265248, 138.1102335, 2018.2, "\u738B\u30F6\u982D"],
        [8, 8247387033, 36.2277278, 138.096683, 2000.8, "\u738B\u30F6\u9F3B"],
        [9, 8247387034, 36.2280134, 138.0974126, 2003.29, "\u738B\u30F6\u9F3B"]
      ].map(([
        index,
        osmId,
        latitude,
        longitude,
        groundElevationMeters,
        area
      ]) => ({
        id: `utsukushigahara-communications-tower-${index}`,
        name: `\u7F8E\u30F6\u539F\u30FB${area} \u901A\u4FE1\u5854 ${index}`,
        type: "communications-tower",
        latitude,
        longitude,
        groundElevationMeters,
        groundElevationSource: "GSI_DEM1A_LIDAR",
        structureHeightMeters: null,
        osmType: "node",
        osmId,
        sourceUrl: `${OSM_NODE_BASE_URL}${osmId}`,
        note: "OSM\u306B\u901A\u4FE1\u5854\u3068\u3057\u3066\u767B\u9332\u3002\u5854\u4F53\u9AD8\u3068\u904B\u55B6\u8005\u306E\u5BFE\u5FDC\u306F\u672A\u691C\u8A3C\u306E\u305F\u3081\u63A8\u6E2C\u3057\u306A\u3044\u3002"
      }))
    ];
    __name(distanceMeters, "distanceMeters");
    __name(precisionStructuresNear, "precisionStructuresNear");
  }
});

// ../server/osmSiteContext.ts
function isOsmElement(value) {
  return typeof value === "object" && value !== null && "type" in value && (value.type === "node" || value.type === "way" || value.type === "relation") && "id" in value && typeof value.id === "number";
}
function geometryOf(element) {
  if (Array.isArray(element.geometry)) {
    return element.geometry.filter(
      (point2) => Number.isFinite(point2.lat) && Number.isFinite(point2.lon)
    );
  }
  if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
    return [{ lat: element.lat, lon: element.lon }];
  }
  return element.center ? [element.center] : [];
}
function localMeters(coordinate, origin) {
  const metrics = calculateKarneySurfaceMetrics(origin, {
    latitude: coordinate.lat,
    longitude: coordinate.lon
  });
  const bearingRadians = metrics.bearingDegrees * Math.PI / 180;
  return {
    x: Math.sin(bearingRadians) * metrics.distanceMeters,
    y: Math.cos(bearingRadians) * metrics.distanceMeters
  };
}
function pointSegmentDistanceMeters(start, end, point2) {
  const a = localMeters(start, point2);
  const b = localMeters(end, point2);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx * dx + dy * dy < 1e-9) return Math.hypot(a.x, a.y);
  const ratio = Math.max(
    0,
    Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy))
  );
  return Math.hypot(a.x + ratio * dx, a.y + ratio * dy);
}
function distanceToElementMeters(element, point2) {
  const geometry = geometryOf(element);
  if (geometry.length === 0) return Number.POSITIVE_INFINITY;
  if (geometry.length === 1) {
    const local = localMeters(geometry[0], point2);
    return Math.hypot(local.x, local.y);
  }
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < geometry.length; index += 1) {
    distance = Math.min(
      distance,
      pointSegmentDistanceMeters(geometry[index - 1], geometry[index], point2)
    );
  }
  return distance;
}
function polygonContainsPoint(geometry, point2) {
  if (geometry.length < 4) return false;
  const first = geometry[0];
  const last = geometry.at(-1);
  if (!last || first.lat !== last.lat || first.lon !== last.lon) return false;
  let inside = false;
  for (let current = 0, previous = geometry.length - 1; current < geometry.length; previous = current, current += 1) {
    const a = geometry[current];
    const b = geometry[previous];
    const crosses = a.lat > point2.latitude !== b.lat > point2.latitude && point2.longitude < (b.lon - a.lon) * (point2.latitude - a.lat) / (b.lat - a.lat) + a.lon;
    if (crosses) inside = !inside;
  }
  return inside;
}
function numericMeters(value) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("ft") || normalized.includes("'")) return null;
  const match2 = normalized.match(/^-?\d+(?:\.\d+)?/);
  if (!match2) return null;
  const parsed = Number(match2[0]);
  return Number.isFinite(parsed) ? parsed : null;
}
function isRestricted(element, point2) {
  const tags = element.tags ?? {};
  const restricted = PRIVATE_ACCESS_VALUES.has(tags.access) || PRIVATE_ACCESS_VALUES.has(tags.foot);
  if (!restricted) return false;
  const geometry = geometryOf(element);
  return polygonContainsPoint(geometry, point2) || Boolean(tags.highway) && distanceToElementMeters(element, point2) <= 12;
}
function isWalkable(element, point2) {
  const tags = element.tags ?? {};
  if (!tags.highway || NON_WALKABLE_HIGHWAYS.has(tags.highway)) return false;
  if (PRIVATE_ACCESS_VALUES.has(tags.access) || PRIVATE_ACCESS_VALUES.has(tags.foot)) {
    return false;
  }
  return distanceToElementMeters(element, point2) <= 25;
}
function isOnMappedWay(element, point2) {
  const tags = element.tags ?? {};
  if (!tags.highway) return false;
  const mappedWidth = numericMeters(tags.width);
  const defaultHalfWidth = MOTOR_ROAD_HALF_WIDTH_METERS[tags.highway] ?? (tags.highway === "pedestrian" ? 4 : tags.highway === "track" ? 2.5 : tags.highway === "footway" || tags.highway === "path" || tags.highway === "steps" || tags.highway === "cycleway" ? 2 : 3);
  const halfWidth = mappedWidth === null ? defaultHalfWidth : Math.max(1.5, mappedWidth / 2);
  return distanceToElementMeters(element, point2) <= halfWidth;
}
function isOnMotorRoad(element, point2) {
  const tags = element.tags ?? {};
  const defaultHalfWidth = tags.highway ? MOTOR_ROAD_HALF_WIDTH_METERS[tags.highway] : void 0;
  if (defaultHalfWidth === void 0) return false;
  const mappedWidth = numericMeters(tags.width);
  const halfWidth = mappedWidth === null ? defaultHalfWidth : Math.max(1.5, mappedWidth / 2);
  return distanceToElementMeters(element, point2) <= halfWidth;
}
function landmarkType(element) {
  const tags = element.tags ?? {};
  if (tags.tourism === "hotel") return "hotel";
  if (tags.man_made === "communications_tower") {
    return "communications-tower";
  }
  if (tags.man_made === "mast") return "communications-mast";
  if (tags.man_made === "tower" && (tags["tower:type"] === "communication" || tags.communication)) {
    return "communications-tower";
  }
  if (tags.man_made === "tower" || tags.building === "tower") return "tower";
  if (tags["ceremonial_gate"] === "torii" || tags.man_made === "torii") {
    return "torii";
  }
  if (tags.amenity === "place_of_worship" && tags.religion === "shinto" || tags.building === "shrine" || tags.historic === "wayside_shrine") {
    return "shrine";
  }
  if (tags.building && tags.historic) return "historic-building";
  if (tags.building && (tags.wikidata || tags.wikipedia || tags.tourism === "attraction")) {
    return "landmark-building";
  }
  return null;
}
function displayName(element, type) {
  const tags = element.tags ?? {};
  return tags["name:ja"] ?? tags.name ?? (type === "torii" ? "\u9CE5\u5C45" : type === "shrine" ? "\u795E\u793E" : type === "hotel" ? "\u30DB\u30C6\u30EB" : type === "communications-tower" ? "\u901A\u4FE1\u5854" : type === "communications-mast" ? "\u901A\u4FE1\u30DE\u30B9\u30C8" : type === "tower" ? "\u5854" : "\u540D\u79F0\u672A\u767B\u9332\u306E\u5EFA\u7269");
}
function nearbyLandmarks(elements, point2) {
  return elements.flatMap((element) => {
    const type = landmarkType(element);
    if (!type) return [];
    const distanceMeters2 = distanceToElementMeters(element, point2);
    if (!Number.isFinite(distanceMeters2) || distanceMeters2 > 600) return [];
    return [{
      name: displayName(element, type),
      type,
      distanceMeters: Math.round(distanceMeters2)
    }];
  }).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 8);
}
function nearbyBuildings(elements, point2) {
  return elements.flatMap((element) => {
    const tags = element.tags ?? {};
    if (!tags.building || !(tags.name || tags["name:ja"] || tags.wikidata || tags.wikipedia)) {
      return [];
    }
    const distanceMeters2 = distanceToElementMeters(element, point2);
    if (!Number.isFinite(distanceMeters2) || distanceMeters2 > 600) return [];
    const mappedHeight = numericMeters(tags.height);
    const levels = numericMeters(tags["building:levels"]);
    const heightMeters = mappedHeight ?? (levels === null ? null : levels * 3);
    return [{
      name: tags["name:ja"] ?? tags.name ?? tags.wikidata ?? "\u540D\u79F0\u672A\u767B\u9332\u306E\u5EFA\u7269",
      distanceMeters: Math.round(distanceMeters2),
      heightMeters,
      heightSource: mappedHeight !== null ? "surveyed" : levels !== null ? "levels-estimate" : null,
      wikidata: tags.wikidata ?? null
    }];
  }).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 8);
}
function structureType(element) {
  const tags = element.tags ?? {};
  if (tags.tourism === "hotel") return "hotel";
  if (tags.man_made === "communications_tower") return "communications-tower";
  if (tags.man_made === "mast") return "communications-mast";
  if (tags.man_made === "tower" && (tags["tower:type"] === "communication" || tags.communication)) {
    return "communications-tower";
  }
  if (tags.man_made === "tower" || tags.building === "tower") return "tower";
  return null;
}
function representativeCoordinate(element) {
  if (element.center) return element.center;
  if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
    return { lat: element.lat, lon: element.lon };
  }
  const geometry = geometryOf(element);
  if (geometry.length === 0) return null;
  return {
    lat: geometry.reduce((sum2, coordinate) => sum2 + coordinate.lat, 0) / geometry.length,
    lon: geometry.reduce((sum2, coordinate) => sum2 + coordinate.lon, 0) / geometry.length
  };
}
function nearbyStructures(elements, point2) {
  const structures = /* @__PURE__ */ new Map();
  for (const element of elements) {
    const type = structureType(element);
    const coordinate = representativeCoordinate(element);
    if (!type || !coordinate) continue;
    const distanceMeters2 = distanceToElementMeters(element, point2);
    if (!Number.isFinite(distanceMeters2) || distanceMeters2 > 1800) continue;
    const tags = element.tags ?? {};
    const mappedHeight = numericMeters(tags.height);
    const levels = numericMeters(tags["building:levels"]);
    const structureHeightMeters = mappedHeight ?? (levels === null ? null : levels * 3);
    structures.set(`${element.type}/${element.id}`, {
      name: displayName(element, type),
      type,
      latitude: coordinate.lat,
      longitude: coordinate.lon,
      distanceMeters: Math.round(distanceMeters2),
      groundElevationMeters: null,
      groundElevationSource: null,
      structureHeightMeters,
      heightSource: mappedHeight !== null ? "surveyed" : levels !== null ? "levels-estimate" : null,
      osmType: element.type,
      osmId: element.id,
      sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      note: null
    });
  }
  for (const structure of precisionStructuresNear(point2)) {
    structures.set(`${structure.osmType}/${structure.osmId}`, {
      name: structure.name,
      type: structure.type,
      latitude: structure.latitude,
      longitude: structure.longitude,
      distanceMeters: structure.distanceMeters,
      groundElevationMeters: structure.groundElevationMeters,
      groundElevationSource: structure.groundElevationSource,
      structureHeightMeters: structure.structureHeightMeters,
      heightSource: null,
      osmType: structure.osmType,
      osmId: structure.osmId,
      sourceUrl: structure.sourceUrl,
      note: structure.note
    });
  }
  return [...structures.values()].sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 24);
}
function combinedLandmarks(elements, point2, structures) {
  const landmarks = /* @__PURE__ */ new Map();
  const structureDistanceKeys = new Set(
    structures.map((structure) => `${structure.type}:${structure.distanceMeters}`)
  );
  for (const landmark of nearbyLandmarks(elements, point2)) {
    if (structureDistanceKeys.has(`${landmark.type}:${landmark.distanceMeters}`)) {
      continue;
    }
    landmarks.set(`${landmark.type}:${landmark.distanceMeters}`, landmark);
  }
  for (const structure of structures) {
    landmarks.set(`structure:${structure.osmType}/${structure.osmId}`, {
      name: structure.name,
      type: structure.type,
      distanceMeters: structure.distanceMeters
    });
  }
  return [...landmarks.values()].sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 16);
}
function queryForPoints(points, includeDetails) {
  const statements = points.flatMap((point2) => {
    const aroundAccess = `(around:120,${point2.latitude},${point2.longitude})`;
    const aroundLandmark = `(around:600,${point2.latitude},${point2.longitude})`;
    const accessStatements = [
      `way${aroundAccess}["highway"]`,
      `nwr${aroundAccess}["access"~"^(private|no|customers|permit)$"]`,
      `nwr${aroundAccess}["foot"~"^(private|no)$"]`
    ];
    const detailStatements = [
      `nwr${aroundLandmark}["amenity"="place_of_worship"]`,
      `nwr${aroundLandmark}["ceremonial_gate"="torii"]`,
      `nwr${aroundLandmark}["man_made"="torii"]`,
      `nwr${aroundLandmark}["historic"]`,
      `nwr${aroundLandmark}["tourism"="hotel"]`,
      `nwr${aroundLandmark}["man_made"~"^(tower|communications_tower|mast)$"]`,
      `nwr${aroundLandmark}["building"="tower"]`,
      `nwr${aroundLandmark}["building"]["wikidata"]`,
      `nwr${aroundLandmark}["building"]["wikipedia"]`,
      `nwr${aroundLandmark}["building"]["tourism"="attraction"]`
    ];
    return [
      ...accessStatements,
      ...includeDetails ? detailStatements : []
    ].map((statement) => `${statement};`);
  });
  return `[out:json][timeout:25];(${statements.join("")});out tags center geom;`;
}
function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = /* @__PURE__ */ __name(() => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    }, "onAbort");
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
async function fetchOverpass(query, signal) {
  let lastError = null;
  const deadline = Date.now() + OVERPASS_TOTAL_TIMEOUT_MS;
  for (const retryDelay of OVERPASS_RETRY_DELAYS_MS) {
    if (Date.now() >= deadline) break;
    await abortableDelay(retryDelay, signal);
    for (const endpoint of OVERPASS_ENDPOINTS) {
      const remainingMilliseconds = deadline - Date.now();
      if (remainingMilliseconds <= 0) break;
      const requestController = new AbortController();
      const forwardAbort = /* @__PURE__ */ __name(() => requestController.abort(signal?.reason), "forwardAbort");
      signal?.addEventListener("abort", forwardAbort, { once: true });
      const requestTimeout = setTimeout(
        () => requestController.abort(new DOMException("Overpass API timeout", "TimeoutError")),
        Math.min(OVERPASS_REQUEST_TIMEOUT_MS, remainingMilliseconds)
      );
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Accept: "application/json",
            "User-Agent": "AstroSight/0.0.0"
          },
          body: new URLSearchParams({ data: query }),
          signal: requestController.signal
        });
        if (!response.ok) {
          throw new Error(`Overpass API\u30A8\u30E9\u30FC\uFF1A${response.status}`);
        }
        const data = await response.json();
        if (!Array.isArray(data.elements)) {
          throw new Error("Overpass API\u306E\u5FDC\u7B54\u5F62\u5F0F\u304C\u4E0D\u6B63\u3067\u3059");
        }
        return data.elements.filter(isOsmElement);
      } catch (error) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(requestTimeout);
        signal?.removeEventListener("abort", forwardAbort);
      }
    }
  }
  throw lastError ?? new Error(
    "OpenStreetMap\u5730\u7406\u30C7\u30FC\u30BF\u306E\u53D6\u5F97\u304C\u6642\u9593\u5185\u306B\u5B8C\u4E86\u3057\u307E\u305B\u3093\u3067\u3057\u305F"
  );
}
async function lookupOsmSiteContexts(points, signal, includeDetails = true) {
  if (points.length === 0 || points.length > 8) {
    throw new Error("\u4E00\u5EA6\u306B\u5224\u5B9A\u3067\u304D\u308B\u5019\u88DC\u5730\u70B9\u306F1\u301C8\u70B9\u3067\u3059");
  }
  for (const point2 of points) {
    if (!Number.isFinite(point2.latitude) || !Number.isFinite(point2.longitude) || point2.latitude < -90 || point2.latitude > 90 || point2.longitude < -180 || point2.longitude > 180) {
      throw new Error("\u5730\u7406\u6761\u4EF6\u306E\u5224\u5B9A\u5EA7\u6A19\u304C\u4E0D\u6B63\u3067\u3059");
    }
  }
  const elements = await fetchOverpass(queryForPoints(points, includeDetails), signal);
  return points.map((point2) => {
    const structures = nearbyStructures(elements, point2);
    return {
      walkingAccessible: elements.some((element) => isWalkable(element, point2)),
      onMappedWay: elements.some((element) => isOnMappedWay(element, point2)),
      restrictedAccess: elements.some((element) => isRestricted(element, point2)),
      onMotorRoad: elements.some((element) => isOnMotorRoad(element, point2)),
      nearbyLandmarks: combinedLandmarks(elements, point2, structures),
      nearbyBuildings: nearbyBuildings(elements, point2),
      nearbyStructures: structures
    };
  });
}
var OVERPASS_ENDPOINTS, OVERPASS_RETRY_DELAYS_MS, OVERPASS_REQUEST_TIMEOUT_MS, OVERPASS_TOTAL_TIMEOUT_MS, PRIVATE_ACCESS_VALUES, NON_WALKABLE_HIGHWAYS, MOTOR_ROAD_HALF_WIDTH_METERS;
var init_osmSiteContext = __esm({
  "../server/osmSiteContext.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_precisionStructures();
    init_karneyGeodesic();
    OVERPASS_ENDPOINTS = [
      "https://overpass-api.de/api/interpreter",
      "https://lz4.overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter"
    ];
    OVERPASS_RETRY_DELAYS_MS = [0, 450];
    OVERPASS_REQUEST_TIMEOUT_MS = 6e3;
    OVERPASS_TOTAL_TIMEOUT_MS = 15e3;
    PRIVATE_ACCESS_VALUES = /* @__PURE__ */ new Set(["private", "no", "customers", "permit"]);
    NON_WALKABLE_HIGHWAYS = /* @__PURE__ */ new Set([
      "motorway",
      "motorway_link",
      "trunk",
      "trunk_link",
      "construction",
      "proposed"
    ]);
    MOTOR_ROAD_HALF_WIDTH_METERS = {
      motorway: 7.5,
      motorway_link: 4,
      trunk: 6,
      trunk_link: 4,
      primary: 5,
      primary_link: 4,
      secondary: 4.5,
      secondary_link: 3.8,
      tertiary: 4,
      tertiary_link: 3.5,
      unclassified: 3.5,
      residential: 3.2,
      living_street: 3.2,
      service: 2.8,
      road: 3.5
    };
    __name(isOsmElement, "isOsmElement");
    __name(geometryOf, "geometryOf");
    __name(localMeters, "localMeters");
    __name(pointSegmentDistanceMeters, "pointSegmentDistanceMeters");
    __name(distanceToElementMeters, "distanceToElementMeters");
    __name(polygonContainsPoint, "polygonContainsPoint");
    __name(numericMeters, "numericMeters");
    __name(isRestricted, "isRestricted");
    __name(isWalkable, "isWalkable");
    __name(isOnMappedWay, "isOnMappedWay");
    __name(isOnMotorRoad, "isOnMotorRoad");
    __name(landmarkType, "landmarkType");
    __name(displayName, "displayName");
    __name(nearbyLandmarks, "nearbyLandmarks");
    __name(nearbyBuildings, "nearbyBuildings");
    __name(structureType, "structureType");
    __name(representativeCoordinate, "representativeCoordinate");
    __name(nearbyStructures, "nearbyStructures");
    __name(combinedLandmarks, "combinedLandmarks");
    __name(queryForPoints, "queryForPoints");
    __name(abortableDelay, "abortableDelay");
    __name(fetchOverpass, "fetchOverpass");
    __name(lookupOsmSiteContexts, "lookupOsmSiteContexts");
  }
});

// api/osm-site-context.ts
function requestPoints2(body) {
  if (typeof body !== "object" || body === null || !("points" in body) || !Array.isArray(body.points)) {
    return null;
  }
  return body.points.map((value) => {
    if (typeof value !== "object" || value === null) {
      return { latitude: Number.NaN, longitude: Number.NaN };
    }
    return {
      latitude: "latitude" in value ? Number(value.latitude) : Number.NaN,
      longitude: "longitude" in value ? Number(value.longitude) : Number.NaN
    };
  });
}
var onRequest4;
var init_osm_site_context = __esm({
  "api/osm-site-context.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_osmSiteContext();
    init_env();
    init_http();
    __name(requestPoints2, "requestPoints");
    onRequest4 = /* @__PURE__ */ __name(async (context) => {
      if (context.request.method !== "POST") {
        return jsonResponse({ error: "POST\u30EA\u30AF\u30A8\u30B9\u30C8\u306E\u307F\u5229\u7528\u3067\u304D\u307E\u3059" }, 405, "public, max-age=300");
      }
      configureCloudflareServerRuntime(context);
      try {
        const body = await context.request.json();
        const points = requestPoints2(body);
        if (!points) {
          return jsonResponse({ error: "\u5019\u88DC\u5EA7\u6A19\u304C\u3042\u308A\u307E\u305B\u3093" }, 400, "public, max-age=300");
        }
        const includeDetails = !(typeof body === "object" && body !== null && "includeDetails" in body && body.includeDetails === false);
        const contexts = await lookupOsmSiteContexts(
          points,
          context.request.signal,
          includeDetails
        );
        return jsonResponse({
          contexts,
          attribution: "\xA9 OpenStreetMap contributors / \u56FD\u571F\u5730\u7406\u9662 \u6A19\u9AD8\u30BF\u30A4\u30EB"
        }, 200, "public, max-age=300");
      } catch (error) {
        return jsonResponse({ error: errorMessage(error) }, 422, "public, max-age=300");
      }
    }, "onRequest");
  }
});

// ../src/search/googleMapsUrl.ts
function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}
function isAllowedGoogleMapsHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "maps.app.goo.gl" || host === "goo.gl" || host === "google.com" || host === "www.google.com" || host === "maps.google.com" || host === "google.co.jp" || host === "www.google.co.jp" || host === "maps.google.co.jp" || host.endsWith(".google.com") || host.endsWith(".google.co.jp");
}
function extractGoogleMapsSharedUrl(text) {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[\])}】）」』、。,]+$/gu, "");
    try {
      const url = new URL(cleaned);
      if (isAllowedGoogleMapsHost(url.hostname)) return url.href;
    } catch {
    }
  }
  return null;
}
function coordinatePair(latitudeText, longitudeText) {
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  return validCoordinates(latitude, longitude) ? { latitude, longitude } : null;
}
function normalizeGoogleMapsText(source) {
  let normalized = source.replaceAll("&amp;", "&").replaceAll("&#38;", "&").replaceAll("&#x26;", "&").replaceAll("&quot;", '"').replaceAll("&#34;", '"').replaceAll("&#x22;", '"').replaceAll("\\u002f", "/").replaceAll("\\u002F", "/").replaceAll("\\u003a", ":").replaceAll("\\u003A", ":").replaceAll("\\u003d", "=").replaceAll("\\u003D", "=").replaceAll("\\u0026", "&").replaceAll("\\u002c", ",").replaceAll("\\u002C", ",").replaceAll("\\x2f", "/").replaceAll("\\x2F", "/").replaceAll("\\x3a", ":").replaceAll("\\x3A", ":").replaceAll("\\x3d", "=").replaceAll("\\x3D", "=").replaceAll("\\x26", "&").replaceAll("\\x2c", ",").replaceAll("\\x2C", ",").replaceAll("\\/", "/");
  for (let pass = 0; pass < 4; pass += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(normalized);
    } catch {
      decoded = normalized.replace(
        /%(21|23|25|26|2C|2F|3A|3D|3F|40)/giu,
        (value) => String.fromCharCode(Number.parseInt(value.slice(1), 16))
      );
    }
    if (decoded === normalized) break;
    normalized = decoded;
  }
  return normalized;
}
function extractCoordinatesFromUrl(source) {
  try {
    const url = new URL(source);
    for (const parameter of ["query", "q", "destination", "ll", "center"]) {
      const value = url.searchParams.get(parameter);
      const match2 = value?.match(
        /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/u
      );
      if (!match2) continue;
      const coordinates = coordinatePair(match2[1], match2[2]);
      if (coordinates) return coordinates;
    }
    const path = decodeURIComponent(url.pathname).replaceAll("+", " ");
    const pathMatch = path.match(
      /\/maps\/(?:search|place|dir)\/(?:[^/]+\/)*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\/|$)/iu
    );
    return pathMatch ? coordinatePair(pathMatch[1], pathMatch[2]) : null;
  } catch {
    return null;
  }
}
function extractGoogleMapsPlaceQuery(source) {
  const normalized = normalizeGoogleMapsText(source);
  try {
    const url = new URL(normalized);
    for (const parameter of ["query", "q", "destination"]) {
      const value2 = url.searchParams.get(parameter)?.trim();
      if (!value2 || /^place_id:/iu.test(value2) || coordinatePair(
        value2.split(",")[0] ?? "",
        value2.split(",")[1] ?? ""
      )) {
        continue;
      }
      return value2.slice(0, 200);
    }
    const path = decodeURIComponent(url.pathname).replaceAll("+", " ");
    const match2 = path.match(/\/maps\/(?:place|search)\/([^/]+)/iu);
    const value = match2?.[1]?.trim();
    if (!value || coordinatePair(
      value.split(",")[0] ?? "",
      value.split(",")[1] ?? ""
    )) {
      return null;
    }
    return value.slice(0, 200);
  } catch {
    return null;
  }
}
function extractGoogleMapsCoordinates(source) {
  const normalized = normalizeGoogleMapsText(source);
  const urlCoordinates = extractCoordinatesFromUrl(normalized);
  if (urlCoordinates) return urlCoordinates;
  const latitudeLongitudePatterns = [
    // placeの正式座標を、画面中心を表す@座標より優先する。
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/u,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|\/|$)/u,
    /[?&](?:query|q|destination|ll|center)=(-?\d+(?:\.\d+)?),(?:\+|\s)*(-?\d+(?:\.\d+)?)/iu,
    /"latitude"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"longitude"\s*:\s*(-?\d+(?:\.\d+)?)/iu,
    /["'](?:latitude|lat)["']\s*[:=]\s*(-?\d+(?:\.\d+)?)[\s\S]{0,160}?["'](?:longitude|lng|lon)["']\s*[:=]\s*(-?\d+(?:\.\d+)?)/iu
  ];
  for (const pattern of latitudeLongitudePatterns) {
    const match2 = normalized.match(pattern);
    if (!match2) continue;
    const coordinates = coordinatePair(match2[1], match2[2]);
    if (coordinates) return coordinates;
  }
  const namedLongitudeLatitude = normalized.match(
    /["'](?:longitude|lng|lon)["']\s*[:=]\s*(-?\d+(?:\.\d+)?)[\s\S]{0,160}?["'](?:latitude|lat)["']\s*[:=]\s*(-?\d+(?:\.\d+)?)/iu
  );
  if (namedLongitudeLatitude) {
    const coordinates = coordinatePair(
      namedLongitudeLatitude[2],
      namedLongitudeLatitude[1]
    );
    if (coordinates) return coordinates;
  }
  const longitudeLatitude = normalized.match(
    /!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/u
  );
  if (longitudeLatitude) {
    const coordinates = coordinatePair(
      longitudeLatitude[2],
      longitudeLatitude[1]
    );
    if (coordinates) return coordinates;
  }
  const initializationIndex = normalized.indexOf("APP_INITIALIZATION_STATE");
  if (initializationIndex >= 0) {
    const initializationState = normalized.slice(
      initializationIndex,
      initializationIndex + 75e4
    );
    const initializationCoordinates = initializationState.match(
      /\[\s*null\s*,\s*null\s*,\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*\]/u
    );
    if (initializationCoordinates) {
      return coordinatePair(
        initializationCoordinates[1],
        initializationCoordinates[2]
      );
    }
  }
  return null;
}
var init_googleMapsUrl = __esm({
  "../src/search/googleMapsUrl.ts"() {
    init_functionsRoutes_0_25847306968093076();
    __name(validCoordinates, "validCoordinates");
    __name(isAllowedGoogleMapsHost, "isAllowedGoogleMapsHost");
    __name(extractGoogleMapsSharedUrl, "extractGoogleMapsSharedUrl");
    __name(coordinatePair, "coordinatePair");
    __name(normalizeGoogleMapsText, "normalizeGoogleMapsText");
    __name(extractCoordinatesFromUrl, "extractCoordinatesFromUrl");
    __name(extractGoogleMapsPlaceQuery, "extractGoogleMapsPlaceQuery");
    __name(extractGoogleMapsCoordinates, "extractGoogleMapsCoordinates");
  }
});

// ../server/googleMaps.ts
function decodeHtmlEntities(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&#38;", "&").replaceAll("&#x26;", "&").replaceAll("&quot;", '"').replaceAll("&#34;", '"').replaceAll("&#x22;", '"').replaceAll("\\u003d", "=").replaceAll("\\u0026", "&").replaceAll("\\u002f", "/").replaceAll("\\/", "/");
}
function resolveRedirectUrl(location, baseUrl) {
  try {
    const resolved = new URL(decodeHtmlEntities(location), baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }
    return isAllowedGoogleMapsHost(resolved.hostname) ? resolved.href : null;
  } catch {
    return null;
  }
}
function extractGoogleUrlsFromHtml(html, baseUrl, includeOrdinaryLinks = true) {
  const decoded = decodeHtmlEntities(html);
  const values = /* @__PURE__ */ new Set();
  const add = /* @__PURE__ */ __name((candidate) => {
    if (!candidate) return;
    const resolved = resolveRedirectUrl(candidate, baseUrl);
    if (!resolved) return;
    try {
      const hostname = new URL(resolved).hostname.toLowerCase();
      if (hostname === "maps.app.goo.gl" || hostname === "goo.gl" || hostname === "google.com" || hostname.endsWith(".google.com") || hostname === "google.co.jp" || hostname.endsWith(".google.co.jp")) {
        values.add(resolved);
      }
    } catch {
    }
  }, "add");
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/giu,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/giu,
    /<meta[^>]+(?:property|name)=["'](?:og:url|twitter:url)["'][^>]+content=["']([^"']+)["']/giu,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:url|twitter:url)["']/giu,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url\s*=\s*([^"';]+)[^"']*["']/giu,
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/giu,
    /(?:window\.)?location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/giu,
    /["'](?:url|redirectUrl|continueUrl)["']\s*:\s*["']([^"']+)["']/giu
  ];
  if (includeOrdinaryLinks) {
    patterns.push(
      /href=["'](https?:\/\/[^"']+)["']/giu,
      /(?:https?:\\?\/\\?\/)(?:www\.)?(?:maps\.)?google(?:\.com|\.co\.jp)\\?\/[^\s"'<>]+/giu
    );
  }
  for (const pattern of patterns) {
    for (const match2 of decoded.matchAll(pattern)) add(match2[1] ?? match2[0]);
  }
  return [...values];
}
function coordinatesFromContent(content, resolvedUrl) {
  const direct = extractGoogleMapsCoordinates(content);
  if (direct) return { ...direct, resolvedUrl };
  for (const candidate of extractGoogleUrlsFromHtml(content, resolvedUrl)) {
    const coordinates = extractGoogleMapsCoordinates(candidate);
    if (coordinates) return { ...coordinates, resolvedUrl: candidate };
  }
  return null;
}
function googleMapsPlaceQueryCandidates(query) {
  const normalized = query.replace(/\s+/gu, " ").trim();
  const candidates = /* @__PURE__ */ new Set();
  const add = /* @__PURE__ */ __name((value) => {
    const candidate = value.trim();
    if (candidate) candidates.add(candidate.slice(0, 200));
  }, "add");
  add(normalized);
  const withoutPostalCode = normalized.replace(/^〒?\d{3}-?\d{4}\s*/u, "");
  add(withoutPostalCode);
  const words = withoutPostalCode.split(" ").filter(Boolean);
  if (words.length > 1) {
    add(words.at(-1) ?? "");
    add(words.slice(-2).join(" "));
  }
  return [...candidates];
}
async function resolveGoogleMapsSharedUrl(input) {
  const sourceUrl = extractGoogleMapsSharedUrl(input);
  if (!sourceUrl) throw new Error("Google\u30DE\u30C3\u30D7\u306E\u5171\u6709URL\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  const direct = extractGoogleMapsCoordinates(sourceUrl);
  if (direct) return { ...direct, resolvedUrl: sourceUrl };
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 18e3);
  try {
    let currentUrl = sourceUrl;
    const visited = /* @__PURE__ */ new Set();
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
      if (visited.has(currentUrl)) throw new Error("\u5171\u6709\u30EA\u30F3\u30AF\u304C\u5FAA\u74B0\u3057\u3066\u3044\u307E\u3059");
      visited.add(currentUrl);
      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: abortController.signal,
        headers: GOOGLE_REQUEST_HEADERS
      });
      const location = response.headers.get("location");
      if (location && response.status >= 300 && response.status < 400) {
        const nextUrl = resolveRedirectUrl(location, currentUrl);
        if (!nextUrl) throw new Error("\u8EE2\u9001\u5148URL\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3067\u3057\u305F");
        const fromLocation = extractGoogleMapsCoordinates(nextUrl);
        if (fromLocation) return { ...fromLocation, resolvedUrl: nextUrl };
        currentUrl = nextUrl;
        continue;
      }
      const responseText = await response.text();
      const fromResponse = coordinatesFromContent(responseText, currentUrl);
      if (fromResponse) return fromResponse;
      const nextCandidates = extractGoogleUrlsFromHtml(
        responseText,
        currentUrl,
        false
      ).filter((candidate) => !visited.has(candidate));
      const coordinateCandidate = nextCandidates.find(
        (candidate) => extractGoogleMapsCoordinates(candidate)
      );
      if (coordinateCandidate) {
        const coordinates = extractGoogleMapsCoordinates(coordinateCandidate);
        if (coordinates) return { ...coordinates, resolvedUrl: coordinateCandidate };
      }
      const nextCandidate = nextCandidates.find((candidate) => candidate !== currentUrl);
      if (nextCandidate) {
        currentUrl = nextCandidate;
        continue;
      }
      if (response.ok) {
        break;
      }
      throw new Error(`Google\u30DE\u30C3\u30D7\u5171\u6709\u30EA\u30F3\u30AF\u901A\u4FE1\u30A8\u30E9\u30FC\uFF1A${response.status}`);
    }
    const finalResponse = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      signal: abortController.signal,
      headers: GOOGLE_REQUEST_HEADERS
    });
    const finalUrl = finalResponse.url || sourceUrl;
    const finalUrlCoordinates = extractGoogleMapsCoordinates(finalUrl);
    if (finalUrlCoordinates) {
      return { ...finalUrlCoordinates, resolvedUrl: finalUrl };
    }
    const finalContent = await finalResponse.text();
    const finalCoordinates = coordinatesFromContent(finalContent, finalUrl);
    if (finalCoordinates) return finalCoordinates;
    const placeQuery = [finalUrl, ...[...visited].reverse()].map((candidate) => extractGoogleMapsPlaceQuery(candidate)).find((candidate) => Boolean(candidate));
    if (placeQuery) {
      let lastPlaceError;
      for (const candidate of googleMapsPlaceQueryCandidates(placeQuery)) {
        try {
          const place = await resolveJapanesePlaceName(
            candidate,
            abortController.signal
          );
          return {
            latitude: place.latitude,
            longitude: place.longitude,
            resolvedUrl: finalUrl
          };
        } catch (error) {
          lastPlaceError = error;
        }
      }
      if (lastPlaceError) throw lastPlaceError;
    }
    if (/\/maps\/d\//u.test(new URL(finalUrl).pathname)) {
      throw new Error(
        "\u3053\u306E\u5171\u6709URL\u306F\u8907\u6570\u5730\u70B9\u3092\u542B\u3080Google\u30DE\u30A4\u30DE\u30C3\u30D7\u3067\u3059\u3002Google Maps\u3067\u5BFE\u8C61\u5730\u70B9\u30921\u3064\u958B\u304D\u3001\u305D\u306E\u5730\u70B9\u306E\u5171\u6709URL\u3092\u8CBC\u308A\u4ED8\u3051\u3066\u304F\u3060\u3055\u3044"
      );
    }
    throw new Error("\u5171\u6709\u30EA\u30F3\u30AF\u306E\u6700\u7D42\u8EE2\u9001\u5148\u304B\u3089\u5EA7\u6A19\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Google\u30DE\u30C3\u30D7\u5171\u6709\u30EA\u30F3\u30AF\u306E\u89E3\u6790\u304C\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8\u3057\u307E\u3057\u305F");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
var GOOGLE_REQUEST_HEADERS, MAX_REDIRECT_HOPS;
var init_googleMaps = __esm({
  "../server/googleMaps.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_googleMapsUrl();
    init_placeGeocode();
    GOOGLE_REQUEST_HEADERS = {
      "User-Agent": "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6"
    };
    MAX_REDIRECT_HOPS = 20;
    __name(decodeHtmlEntities, "decodeHtmlEntities");
    __name(resolveRedirectUrl, "resolveRedirectUrl");
    __name(extractGoogleUrlsFromHtml, "extractGoogleUrlsFromHtml");
    __name(coordinatesFromContent, "coordinatesFromContent");
    __name(googleMapsPlaceQueryCandidates, "googleMapsPlaceQueryCandidates");
    __name(resolveGoogleMapsSharedUrl, "resolveGoogleMapsSharedUrl");
  }
});

// api/resolve-google-maps.ts
var onRequest5;
var init_resolve_google_maps = __esm({
  "api/resolve-google-maps.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_googleMaps();
    init_http();
    onRequest5 = /* @__PURE__ */ __name(async ({ request }) => {
      if (request.method !== "POST") {
        return jsonResponse({ error: "POST\u30EA\u30AF\u30A8\u30B9\u30C8\u306E\u307F\u5229\u7528\u3067\u304D\u307E\u3059" }, 405);
      }
      let requestBody;
      try {
        requestBody = await request.json();
      } catch {
        return jsonResponse({ error: "\u9001\u4FE1\u5185\u5BB9\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3067\u3057\u305F" }, 400);
      }
      const sharedUrl = typeof requestBody === "object" && requestBody !== null && "url" in requestBody && typeof requestBody.url === "string" ? requestBody.url : "";
      if (!sharedUrl.trim()) {
        return jsonResponse({ error: "Google\u30DE\u30C3\u30D7\u306E\u5171\u6709URL\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044" }, 400);
      }
      try {
        return jsonResponse(await resolveGoogleMapsSharedUrl(sharedUrl));
      } catch (error) {
        return jsonResponse(
          { error: `\u5171\u6709URL\u306E\u89E3\u6790\u306B\u5931\u6557\u3057\u307E\u3057\u305F\uFF1A${errorMessage(error)}` },
          422
        );
      }
    }, "onRequest");
  }
});

// ../server/spotSearchJobs.ts
function validSearchJobId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}
function validSpotSearchJobInput(value) {
  if (typeof value !== "object" || value === null) return false;
  if (!("criteria" in value) || typeof value.criteria !== "object" || value.criteria === null) {
    return false;
  }
  if (!("subject" in value) || typeof value.subject !== "object" || value.subject === null) {
    return false;
  }
  return "baseDateIso" in value && typeof value.baseDateIso === "string" && Number.isFinite(Date.parse(value.baseDateIso)) && "timeZone" in value && typeof value.timeZone === "string" && value.timeZone.length <= 80 && "lensCenterHeightMeters" in value && Number.isFinite(value.lensCenterHeightMeters) && "subjectGroundHeightMeters" in value && Number.isFinite(value.subjectGroundHeightMeters) && "calculationMode" in value && (value.calculationMode === "standard" || value.calculationMode === "pro");
}
function key(clientId, jobId) {
  if (!validSearchJobId(clientId) || !validSearchJobId(jobId)) {
    throw new Error("\u691C\u7D22\u30B8\u30E7\u30D6ID\u304C\u4E0D\u6B63\u3067\u3059");
  }
  return `spot-search-jobs/v1/${clientId}/${jobId}.json`;
}
function isSpotSearchJob(value) {
  return typeof value === "object" && value !== null && "version" in value && value.version === 1 && "clientId" in value && validSearchJobId(value.clientId) && "jobId" in value && validSearchJobId(value.jobId) && "status" in value && typeof value.status === "string" && "input" in value && typeof value.input === "object" && value.input !== null && "results" in value && Array.isArray(value.results);
}
function storageStatus(job) {
  if (job.status === "complete") return "completed";
  if (job.status === "failed") return "failed";
  if (job.status === "queued") return "queued";
  return "running";
}
function storedRecord(job, previous) {
  const expiresAt = new Date(
    Date.parse(job.updatedAt) + JOB_TTL_SECONDS * 1e3
  ).toISOString();
  const completed = job.status === "complete";
  return {
    version: 1,
    jobId: job.jobId,
    status: storageStatus(job),
    progress: job.progress,
    progressPercent: job.progressPercent,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    request: job.input,
    partialResult: completed ? previous?.partialResult ?? previous?.job.results ?? [] : job.results,
    finalResult: completed ? job.results : void 0,
    error: job.error,
    expiresAt,
    job
  };
}
function isStoredSpotSearchJob(value) {
  return typeof value === "object" && value !== null && "version" in value && value.version === 1 && "job" in value && isSpotSearchJob(value.job);
}
async function getStoredSpotSearchJob(kv, clientId, jobId) {
  const value = await kv.get(key(clientId, jobId), { type: "json" });
  return isStoredSpotSearchJob(value) ? value : null;
}
async function getSpotSearchJob(kv, clientId, jobId) {
  return (await getStoredSpotSearchJob(kv, clientId, jobId))?.job ?? null;
}
async function setSpotSearchJob(kv, job, previous) {
  const record = storedRecord(job, previous);
  await kv.put(key(job.clientId, job.jobId), JSON.stringify(record), {
    expirationTtl: JOB_TTL_SECONDS,
    metadata: {
      status: record.status,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt
    }
  });
}
async function updateSpotSearchJob(kv, clientId, jobId, update) {
  const currentRecord = await getStoredSpotSearchJob(kv, clientId, jobId);
  if (!currentRecord) throw new Error("\u691C\u7D22\u30B8\u30E7\u30D6\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
  const current = currentRecord.job;
  const next = {
    ...current,
    ...update,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await setSpotSearchJob(kv, next, currentRecord);
  return next;
}
function createSpotSearchJobUpdater(kv, initialJob) {
  let current = initialJob;
  return async (clientId, jobId, update) => {
    if (clientId !== current.clientId || jobId !== current.jobId) {
      throw new Error("\u691C\u7D22\u30B8\u30E7\u30D6ID\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093");
    }
    current = {
      ...current,
      ...update,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await setSpotSearchJob(kv, current);
    return current;
  };
}
var ID_PATTERN, JOB_TTL_SECONDS;
var init_spotSearchJobs = __esm({
  "../server/spotSearchJobs.ts"() {
    init_functionsRoutes_0_25847306968093076();
    ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
    __name(validSearchJobId, "validSearchJobId");
    __name(validSpotSearchJobInput, "validSpotSearchJobInput");
    __name(key, "key");
    __name(isSpotSearchJob, "isSpotSearchJob");
    __name(storageStatus, "storageStatus");
    __name(storedRecord, "storedRecord");
    __name(isStoredSpotSearchJob, "isStoredSpotSearchJob");
    __name(getStoredSpotSearchJob, "getStoredSpotSearchJob");
    __name(getSpotSearchJob, "getSpotSearchJob");
    __name(setSpotSearchJob, "setSpotSearchJob");
    __name(updateSpotSearchJob, "updateSpotSearchJob");
    __name(createSpotSearchJobUpdater, "createSpotSearchJobUpdater");
  }
});

// api/spot-search-finalize.ts
function validResults(value) {
  return Array.isArray(value) && value.length <= 100 && value.every(
    (result) => typeof result === "object" && result !== null && "id" in result && typeof result.id === "string" && "date" in result && typeof result.date === "string"
  );
}
var onRequest6;
var init_spot_search_finalize = __esm({
  "api/spot-search-finalize.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_spotSearchJobs();
    init_env();
    init_http();
    __name(validResults, "validResults");
    onRequest6 = /* @__PURE__ */ __name(async ({ request, env }) => {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      try {
        const body = await request.json();
        if (!validSearchJobId(body.clientId) || !validSearchJobId(body.jobId) || !validResults(body.results)) {
          throw new Error("\u6700\u7D423D\u78BA\u8A8D\u7D50\u679C\u304C\u4E0D\u6B63\u3067\u3059");
        }
        const job = await updateSpotSearchJob(
          spotSearchJobKv(env),
          body.clientId,
          body.jobId,
          {
            status: "complete",
            progress: "\u691C\u7D22\u304C\u5B8C\u4E86\u3057\u307E\u3057\u305F",
            results: body.results,
            error: void 0
          }
        );
        return jsonResponse(job);
      } catch (error) {
        return jsonResponse({ error: errorMessage(error) }, 422);
      }
    }, "onRequest");
  }
});

// api/spot-search-start.ts
var onRequest7;
var init_spot_search_start = __esm({
  "api/spot-search-start.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_spotSearchJobs();
    init_env();
    init_http();
    onRequest7 = /* @__PURE__ */ __name(async ({ request, env }) => {
      if (request.method !== "POST") {
        return jsonResponse({ error: "POST\u30EA\u30AF\u30A8\u30B9\u30C8\u306E\u307F\u5229\u7528\u3067\u304D\u307E\u3059" }, 405);
      }
      try {
        const body = await request.json();
        if (!validSearchJobId(body.clientId) || !validSearchJobId(body.jobId) || !validSpotSearchJobInput(body.input)) {
          return jsonResponse({ error: "\u30D0\u30C3\u30AF\u30B0\u30E9\u30A6\u30F3\u30C9\u691C\u7D22\u6761\u4EF6\u304C\u4E0D\u6B63\u3067\u3059" }, 400);
        }
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const job = {
          version: 1,
          clientId: body.clientId,
          jobId: body.jobId,
          status: "queued",
          progress: "\u30D0\u30C3\u30AF\u30B0\u30E9\u30A6\u30F3\u30C9\u691C\u7D22\u3092\u958B\u59CB\u3057\u3066\u3044\u307E\u3059\u2026",
          progressPercent: 0,
          input: body.input,
          results: [],
          createdAt: now,
          updatedAt: now
        };
        const kv = spotSearchJobKv(env);
        await setSpotSearchJob(kv, job);
        try {
          await env.SPOT_SEARCH_QUEUE.send({ version: 1, job });
        } catch (error) {
          const updateJob = createSpotSearchJobUpdater(kv, job);
          await updateJob(job.clientId, job.jobId, {
            status: "failed",
            progress: "\u691C\u7D22\u51E6\u7406\u3092\u8D77\u52D5\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F",
            error: errorMessage(error)
          });
          return jsonResponse({ error: errorMessage(error) }, 502);
        }
        return jsonResponse({ jobId: job.jobId, status: "queued" }, 202);
      } catch (error) {
        return jsonResponse({ error: errorMessage(error) }, 422);
      }
    }, "onRequest");
  }
});

// api/spot-search-status.ts
var onRequest8;
var init_spot_search_status = __esm({
  "api/spot-search-status.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_spotSearchJobs();
    init_env();
    init_http();
    onRequest8 = /* @__PURE__ */ __name(async ({ request, env }) => {
      if (request.method !== "GET") {
        return jsonResponse({ error: "GET\u30EA\u30AF\u30A8\u30B9\u30C8\u306E\u307F\u5229\u7528\u3067\u304D\u307E\u3059" }, 405);
      }
      const url = new URL(request.url);
      const clientId = url.searchParams.get("clientId");
      const jobId = url.searchParams.get("jobId");
      if (!validSearchJobId(clientId) || !validSearchJobId(jobId)) {
        return jsonResponse({ error: "\u691C\u7D22\u30B8\u30E7\u30D6ID\u304C\u4E0D\u6B63\u3067\u3059" }, 400);
      }
      try {
        const job = await getSpotSearchJob(spotSearchJobKv(env), clientId, jobId);
        return job ? jsonResponse(job) : jsonResponse({ error: "\u691C\u7D22\u30B8\u30E7\u30D6\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093" }, 404);
      } catch (error) {
        return jsonResponse({ error: errorMessage(error) }, 422);
      }
    }, "onRequest");
  }
});

// ../node_modules/robust-predicates/esm/util.js
function sum(elen, e, flen, f, h) {
  let Q, Qnew, hh, bvirt;
  let enow = e[0];
  let fnow = f[0];
  let eindex = 0;
  let findex = 0;
  if (fnow > enow === fnow > -enow) {
    Q = enow;
    enow = e[++eindex];
  } else {
    Q = fnow;
    fnow = f[++findex];
  }
  let hindex = 0;
  if (eindex < elen && findex < flen) {
    if (fnow > enow === fnow > -enow) {
      Qnew = enow + Q;
      hh = Q - (Qnew - enow);
      enow = e[++eindex];
    } else {
      Qnew = fnow + Q;
      hh = Q - (Qnew - fnow);
      fnow = f[++findex];
    }
    Q = Qnew;
    if (hh !== 0) {
      h[hindex++] = hh;
    }
    while (eindex < elen && findex < flen) {
      if (fnow > enow === fnow > -enow) {
        Qnew = Q + enow;
        bvirt = Qnew - Q;
        hh = Q - (Qnew - bvirt) + (enow - bvirt);
        enow = e[++eindex];
      } else {
        Qnew = Q + fnow;
        bvirt = Qnew - Q;
        hh = Q - (Qnew - bvirt) + (fnow - bvirt);
        fnow = f[++findex];
      }
      Q = Qnew;
      if (hh !== 0) {
        h[hindex++] = hh;
      }
    }
  }
  while (eindex < elen) {
    Qnew = Q + enow;
    bvirt = Qnew - Q;
    hh = Q - (Qnew - bvirt) + (enow - bvirt);
    enow = e[++eindex];
    Q = Qnew;
    if (hh !== 0) {
      h[hindex++] = hh;
    }
  }
  while (findex < flen) {
    Qnew = Q + fnow;
    bvirt = Qnew - Q;
    hh = Q - (Qnew - bvirt) + (fnow - bvirt);
    fnow = f[++findex];
    Q = Qnew;
    if (hh !== 0) {
      h[hindex++] = hh;
    }
  }
  if (Q !== 0 || hindex === 0) {
    h[hindex++] = Q;
  }
  return hindex;
}
function estimate(elen, e) {
  let Q = e[0];
  for (let i = 1; i < elen; i++) Q += e[i];
  return Q;
}
function vec(n) {
  return new Float64Array(n);
}
var epsilon, splitter, resulterrbound;
var init_util = __esm({
  "../node_modules/robust-predicates/esm/util.js"() {
    init_functionsRoutes_0_25847306968093076();
    epsilon = 11102230246251565e-32;
    splitter = 134217729;
    resulterrbound = (3 + 8 * epsilon) * epsilon;
    __name(sum, "sum");
    __name(estimate, "estimate");
    __name(vec, "vec");
  }
});

// ../node_modules/robust-predicates/esm/orient2d.js
function orient2dadapt(ax, ay, bx, by, cx, cy, detsum) {
  let acxtail, acytail, bcxtail, bcytail;
  let bvirt, c, ahi, alo, bhi, blo, _i, _j, _0, s1, s0, t1, t0, u32;
  const acx = ax - cx;
  const bcx = bx - cx;
  const acy = ay - cy;
  const bcy = by - cy;
  s1 = acx * bcy;
  c = splitter * acx;
  ahi = c - (c - acx);
  alo = acx - ahi;
  c = splitter * bcy;
  bhi = c - (c - bcy);
  blo = bcy - bhi;
  s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
  t1 = acy * bcx;
  c = splitter * acy;
  ahi = c - (c - acy);
  alo = acy - ahi;
  c = splitter * bcx;
  bhi = c - (c - bcx);
  blo = bcx - bhi;
  t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
  _i = s0 - t0;
  bvirt = s0 - _i;
  B[0] = s0 - (_i + bvirt) + (bvirt - t0);
  _j = s1 + _i;
  bvirt = _j - s1;
  _0 = s1 - (_j - bvirt) + (_i - bvirt);
  _i = _0 - t1;
  bvirt = _0 - _i;
  B[1] = _0 - (_i + bvirt) + (bvirt - t1);
  u32 = _j + _i;
  bvirt = u32 - _j;
  B[2] = _j - (u32 - bvirt) + (_i - bvirt);
  B[3] = u32;
  let det = estimate(4, B);
  let errbound = ccwerrboundB * detsum;
  if (det >= errbound || -det >= errbound) {
    return det;
  }
  bvirt = ax - acx;
  acxtail = ax - (acx + bvirt) + (bvirt - cx);
  bvirt = bx - bcx;
  bcxtail = bx - (bcx + bvirt) + (bvirt - cx);
  bvirt = ay - acy;
  acytail = ay - (acy + bvirt) + (bvirt - cy);
  bvirt = by - bcy;
  bcytail = by - (bcy + bvirt) + (bvirt - cy);
  if (acxtail === 0 && acytail === 0 && bcxtail === 0 && bcytail === 0) {
    return det;
  }
  errbound = ccwerrboundC * detsum + resulterrbound * Math.abs(det);
  det += acx * bcytail + bcy * acxtail - (acy * bcxtail + bcx * acytail);
  if (det >= errbound || -det >= errbound) return det;
  s1 = acxtail * bcy;
  c = splitter * acxtail;
  ahi = c - (c - acxtail);
  alo = acxtail - ahi;
  c = splitter * bcy;
  bhi = c - (c - bcy);
  blo = bcy - bhi;
  s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
  t1 = acytail * bcx;
  c = splitter * acytail;
  ahi = c - (c - acytail);
  alo = acytail - ahi;
  c = splitter * bcx;
  bhi = c - (c - bcx);
  blo = bcx - bhi;
  t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
  _i = s0 - t0;
  bvirt = s0 - _i;
  u[0] = s0 - (_i + bvirt) + (bvirt - t0);
  _j = s1 + _i;
  bvirt = _j - s1;
  _0 = s1 - (_j - bvirt) + (_i - bvirt);
  _i = _0 - t1;
  bvirt = _0 - _i;
  u[1] = _0 - (_i + bvirt) + (bvirt - t1);
  u32 = _j + _i;
  bvirt = u32 - _j;
  u[2] = _j - (u32 - bvirt) + (_i - bvirt);
  u[3] = u32;
  const C1len = sum(4, B, 4, u, C1);
  s1 = acx * bcytail;
  c = splitter * acx;
  ahi = c - (c - acx);
  alo = acx - ahi;
  c = splitter * bcytail;
  bhi = c - (c - bcytail);
  blo = bcytail - bhi;
  s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
  t1 = acy * bcxtail;
  c = splitter * acy;
  ahi = c - (c - acy);
  alo = acy - ahi;
  c = splitter * bcxtail;
  bhi = c - (c - bcxtail);
  blo = bcxtail - bhi;
  t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
  _i = s0 - t0;
  bvirt = s0 - _i;
  u[0] = s0 - (_i + bvirt) + (bvirt - t0);
  _j = s1 + _i;
  bvirt = _j - s1;
  _0 = s1 - (_j - bvirt) + (_i - bvirt);
  _i = _0 - t1;
  bvirt = _0 - _i;
  u[1] = _0 - (_i + bvirt) + (bvirt - t1);
  u32 = _j + _i;
  bvirt = u32 - _j;
  u[2] = _j - (u32 - bvirt) + (_i - bvirt);
  u[3] = u32;
  const C2len = sum(C1len, C1, 4, u, C2);
  s1 = acxtail * bcytail;
  c = splitter * acxtail;
  ahi = c - (c - acxtail);
  alo = acxtail - ahi;
  c = splitter * bcytail;
  bhi = c - (c - bcytail);
  blo = bcytail - bhi;
  s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
  t1 = acytail * bcxtail;
  c = splitter * acytail;
  ahi = c - (c - acytail);
  alo = acytail - ahi;
  c = splitter * bcxtail;
  bhi = c - (c - bcxtail);
  blo = bcxtail - bhi;
  t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
  _i = s0 - t0;
  bvirt = s0 - _i;
  u[0] = s0 - (_i + bvirt) + (bvirt - t0);
  _j = s1 + _i;
  bvirt = _j - s1;
  _0 = s1 - (_j - bvirt) + (_i - bvirt);
  _i = _0 - t1;
  bvirt = _0 - _i;
  u[1] = _0 - (_i + bvirt) + (bvirt - t1);
  u32 = _j + _i;
  bvirt = u32 - _j;
  u[2] = _j - (u32 - bvirt) + (_i - bvirt);
  u[3] = u32;
  const Dlen = sum(C2len, C2, 4, u, D);
  return D[Dlen - 1];
}
function orient2d(ax, ay, bx, by, cx, cy) {
  const detleft = (ay - cy) * (bx - cx);
  const detright = (ax - cx) * (by - cy);
  const det = detleft - detright;
  const detsum = Math.abs(detleft + detright);
  if (Math.abs(det) >= ccwerrboundA * detsum) return det;
  return -orient2dadapt(ax, ay, bx, by, cx, cy, detsum);
}
var ccwerrboundA, ccwerrboundB, ccwerrboundC, B, C1, C2, D, u;
var init_orient2d = __esm({
  "../node_modules/robust-predicates/esm/orient2d.js"() {
    init_functionsRoutes_0_25847306968093076();
    init_util();
    ccwerrboundA = (3 + 16 * epsilon) * epsilon;
    ccwerrboundB = (2 + 12 * epsilon) * epsilon;
    ccwerrboundC = (9 + 64 * epsilon) * epsilon * epsilon;
    B = vec(4);
    C1 = vec(8);
    C2 = vec(12);
    D = vec(16);
    u = vec(4);
    __name(orient2dadapt, "orient2dadapt");
    __name(orient2d, "orient2d");
  }
});

// ../node_modules/robust-predicates/esm/orient3d.js
var o3derrboundA, o3derrboundB, o3derrboundC, bc, ca, ab, at_b, at_c, bt_c, bt_a, ct_a, ct_b, bct, cat, abt, u2, _8, _8b, _16, _12, fin, fin2;
var init_orient3d = __esm({
  "../node_modules/robust-predicates/esm/orient3d.js"() {
    init_functionsRoutes_0_25847306968093076();
    init_util();
    o3derrboundA = (7 + 56 * epsilon) * epsilon;
    o3derrboundB = (3 + 28 * epsilon) * epsilon;
    o3derrboundC = (26 + 288 * epsilon) * epsilon * epsilon;
    bc = vec(4);
    ca = vec(4);
    ab = vec(4);
    at_b = vec(4);
    at_c = vec(4);
    bt_c = vec(4);
    bt_a = vec(4);
    ct_a = vec(4);
    ct_b = vec(4);
    bct = vec(8);
    cat = vec(8);
    abt = vec(8);
    u2 = vec(4);
    _8 = vec(8);
    _8b = vec(8);
    _16 = vec(16);
    _12 = vec(12);
    fin = vec(192);
    fin2 = vec(192);
  }
});

// ../node_modules/robust-predicates/esm/incircle.js
var iccerrboundA, iccerrboundB, iccerrboundC, bc2, ca2, ab2, aa, bb, cc, u3, v, axtbc, aytbc, bxtca, bytca, cxtab, cytab, abt2, bct2, cat2, abtt, bctt, catt, _82, _162, _16b, _16c, _32, _32b, _48, _64, fin3, fin22;
var init_incircle = __esm({
  "../node_modules/robust-predicates/esm/incircle.js"() {
    init_functionsRoutes_0_25847306968093076();
    init_util();
    iccerrboundA = (10 + 96 * epsilon) * epsilon;
    iccerrboundB = (4 + 48 * epsilon) * epsilon;
    iccerrboundC = (44 + 576 * epsilon) * epsilon * epsilon;
    bc2 = vec(4);
    ca2 = vec(4);
    ab2 = vec(4);
    aa = vec(4);
    bb = vec(4);
    cc = vec(4);
    u3 = vec(4);
    v = vec(4);
    axtbc = vec(8);
    aytbc = vec(8);
    bxtca = vec(8);
    bytca = vec(8);
    cxtab = vec(8);
    cytab = vec(8);
    abt2 = vec(8);
    bct2 = vec(8);
    cat2 = vec(8);
    abtt = vec(4);
    bctt = vec(4);
    catt = vec(4);
    _82 = vec(8);
    _162 = vec(16);
    _16b = vec(16);
    _16c = vec(16);
    _32 = vec(32);
    _32b = vec(32);
    _48 = vec(48);
    _64 = vec(64);
    fin3 = vec(1152);
    fin22 = vec(1152);
  }
});

// ../node_modules/robust-predicates/esm/insphere.js
var isperrboundA, isperrboundB, isperrboundC, ab3, bc3, cd, de, ea, ac, bd, ce, da, eb, abc, bcd, cde, dea, eab, abd, bce, cda, deb, eac, adet, bdet, cdet, ddet, edet, abdet, cddet, cdedet, deter, _83, _8b2, _8c, _163, _24, _482, _48b, _96, _192, _384x, _384y, _384z, _768, xdet, ydet, zdet, fin4;
var init_insphere = __esm({
  "../node_modules/robust-predicates/esm/insphere.js"() {
    init_functionsRoutes_0_25847306968093076();
    init_util();
    isperrboundA = (16 + 224 * epsilon) * epsilon;
    isperrboundB = (5 + 72 * epsilon) * epsilon;
    isperrboundC = (71 + 1408 * epsilon) * epsilon * epsilon;
    ab3 = vec(4);
    bc3 = vec(4);
    cd = vec(4);
    de = vec(4);
    ea = vec(4);
    ac = vec(4);
    bd = vec(4);
    ce = vec(4);
    da = vec(4);
    eb = vec(4);
    abc = vec(24);
    bcd = vec(24);
    cde = vec(24);
    dea = vec(24);
    eab = vec(24);
    abd = vec(24);
    bce = vec(24);
    cda = vec(24);
    deb = vec(24);
    eac = vec(24);
    adet = vec(1152);
    bdet = vec(1152);
    cdet = vec(1152);
    ddet = vec(1152);
    edet = vec(1152);
    abdet = vec(2304);
    cddet = vec(2304);
    cdedet = vec(3456);
    deter = vec(5760);
    _83 = vec(8);
    _8b2 = vec(8);
    _8c = vec(8);
    _163 = vec(16);
    _24 = vec(24);
    _482 = vec(48);
    _48b = vec(48);
    _96 = vec(96);
    _192 = vec(192);
    _384x = vec(384);
    _384y = vec(384);
    _384z = vec(384);
    _768 = vec(768);
    xdet = vec(96);
    ydet = vec(96);
    zdet = vec(96);
    fin4 = vec(1152);
  }
});

// ../node_modules/robust-predicates/index.js
var init_robust_predicates = __esm({
  "../node_modules/robust-predicates/index.js"() {
    init_functionsRoutes_0_25847306968093076();
    init_orient2d();
    init_orient3d();
    init_incircle();
    init_insphere();
  }
});

// ../node_modules/point-in-polygon-hao/dist/esm/index.js
function pointInPolygon(p, polygon) {
  var i;
  var ii;
  var k = 0;
  var f;
  var u1;
  var v1;
  var u22;
  var v2;
  var currentP;
  var nextP;
  var x = p[0];
  var y = p[1];
  var numContours = polygon.length;
  for (i = 0; i < numContours; i++) {
    ii = 0;
    var contour = polygon[i];
    var contourLen = contour.length - 1;
    currentP = contour[0];
    if (currentP[0] !== contour[contourLen][0] && currentP[1] !== contour[contourLen][1]) {
      throw new Error("First and last coordinates in a ring must be the same");
    }
    u1 = currentP[0] - x;
    v1 = currentP[1] - y;
    for (ii; ii < contourLen; ii++) {
      nextP = contour[ii + 1];
      u22 = nextP[0] - x;
      v2 = nextP[1] - y;
      if (v1 === 0 && v2 === 0) {
        if (u22 <= 0 && u1 >= 0 || u1 <= 0 && u22 >= 0) {
          return 0;
        }
      } else if (v2 >= 0 && v1 <= 0 || v2 <= 0 && v1 >= 0) {
        f = orient2d(u1, u22, v1, v2, 0, 0);
        if (f === 0) {
          return 0;
        }
        if (f > 0 && v2 > 0 && v1 <= 0 || f < 0 && v2 <= 0 && v1 > 0) {
          k++;
        }
      }
      currentP = nextP;
      v1 = v2;
      u1 = u22;
    }
  }
  if (k % 2 === 0) {
    return false;
  }
  return true;
}
var init_esm = __esm({
  "../node_modules/point-in-polygon-hao/dist/esm/index.js"() {
    init_functionsRoutes_0_25847306968093076();
    init_robust_predicates();
    __name(pointInPolygon, "pointInPolygon");
  }
});

// ../node_modules/@turf/helpers/dist/esm/index.js
function feature(geom, properties, options = {}) {
  const feat = { type: "Feature" };
  if (options.id === 0 || options.id) {
    feat.id = options.id;
  }
  if (options.bbox) {
    feat.bbox = options.bbox;
  }
  feat.properties = properties || {};
  feat.geometry = geom;
  return feat;
}
function point(coordinates, properties, options = {}) {
  if (!coordinates) {
    throw new Error("coordinates is required");
  }
  if (!Array.isArray(coordinates)) {
    throw new Error("coordinates must be an Array");
  }
  if (coordinates.length < 2) {
    throw new Error("coordinates must be at least 2 numbers long");
  }
  if (!isNumber(coordinates[0]) || !isNumber(coordinates[1])) {
    throw new Error("coordinates must contain numbers");
  }
  const geom = {
    type: "Point",
    coordinates
  };
  return feature(geom, properties, options);
}
function isNumber(num) {
  return !isNaN(num) && num !== null && !Array.isArray(num);
}
var earthRadius, factors;
var init_esm2 = __esm({
  "../node_modules/@turf/helpers/dist/esm/index.js"() {
    init_functionsRoutes_0_25847306968093076();
    earthRadius = 63710088e-1;
    factors = {
      centimeters: earthRadius * 100,
      centimetres: earthRadius * 100,
      degrees: 360 / (2 * Math.PI),
      feet: earthRadius * 3.28084,
      inches: earthRadius * 39.37,
      kilometers: earthRadius / 1e3,
      kilometres: earthRadius / 1e3,
      meters: earthRadius,
      metres: earthRadius,
      miles: earthRadius / 1609.344,
      millimeters: earthRadius * 1e3,
      millimetres: earthRadius * 1e3,
      nauticalmiles: earthRadius / 1852,
      radians: 1,
      yards: earthRadius * 1.0936
    };
    __name(feature, "feature");
    __name(point, "point");
    __name(isNumber, "isNumber");
  }
});

// ../node_modules/@turf/invariant/dist/esm/index.js
function getCoord(coord) {
  if (!coord) {
    throw new Error("coord is required");
  }
  if (!Array.isArray(coord)) {
    if (coord.type === "Feature" && coord.geometry !== null && coord.geometry.type === "Point") {
      return [...coord.geometry.coordinates];
    }
    if (coord.type === "Point") {
      return [...coord.coordinates];
    }
  }
  if (Array.isArray(coord) && coord.length >= 2 && !Array.isArray(coord[0]) && !Array.isArray(coord[1])) {
    return [...coord];
  }
  throw new Error("coord must be GeoJSON Point or an Array of numbers");
}
function getGeom(geojson) {
  if (geojson.type === "Feature") {
    return geojson.geometry;
  }
  return geojson;
}
var init_esm3 = __esm({
  "../node_modules/@turf/invariant/dist/esm/index.js"() {
    init_functionsRoutes_0_25847306968093076();
    __name(getCoord, "getCoord");
    __name(getGeom, "getGeom");
  }
});

// ../node_modules/@turf/boolean-point-in-polygon/dist/esm/index.js
function booleanPointInPolygon(point2, polygon, options = {}) {
  if (!point2) {
    throw new Error("point is required");
  }
  if (!polygon) {
    throw new Error("polygon is required");
  }
  const pt = getCoord(point2);
  const geom = getGeom(polygon);
  const type = geom.type;
  const bbox = polygon.bbox;
  let polys = geom.coordinates;
  if (bbox && inBBox(pt, bbox) === false) {
    return false;
  }
  if (type === "Polygon") {
    polys = [polys];
  }
  let result = false;
  for (var i = 0; i < polys.length; ++i) {
    const polyResult = pointInPolygon(pt, polys[i]);
    if (polyResult === 0) return options.ignoreBoundary ? false : true;
    else if (polyResult) result = true;
  }
  return result;
}
function inBBox(pt, bbox) {
  return bbox[0] <= pt[0] && bbox[1] <= pt[1] && bbox[2] >= pt[0] && bbox[3] >= pt[1];
}
var index_default;
var init_esm4 = __esm({
  "../node_modules/@turf/boolean-point-in-polygon/dist/esm/index.js"() {
    init_functionsRoutes_0_25847306968093076();
    init_esm();
    init_esm3();
    __name(booleanPointInPolygon, "booleanPointInPolygon");
    __name(inBBox, "inBBox");
    index_default = booleanPointInPolygon;
  }
});

// ../node_modules/geobuf/encode.js
var require_encode = __commonJS({
  "../node_modules/geobuf/encode.js"(exports, module) {
    "use strict";
    init_functionsRoutes_0_25847306968093076();
    module.exports = encode;
    var keys;
    var keysNum;
    var keysArr;
    var dim;
    var e;
    var maxPrecision = 1e6;
    var geometryTypes = {
      "Point": 0,
      "MultiPoint": 1,
      "LineString": 2,
      "MultiLineString": 3,
      "Polygon": 4,
      "MultiPolygon": 5,
      "GeometryCollection": 6
    };
    function encode(obj, pbf) {
      keys = {};
      keysArr = [];
      keysNum = 0;
      dim = 0;
      e = 1;
      analyze(obj);
      e = Math.min(e, maxPrecision);
      var precision = Math.ceil(Math.log(e) / Math.LN10);
      for (var i = 0; i < keysArr.length; i++) pbf.writeStringField(1, keysArr[i]);
      if (dim !== 2) pbf.writeVarintField(2, dim);
      if (precision !== 6) pbf.writeVarintField(3, precision);
      if (obj.type === "FeatureCollection") pbf.writeMessage(4, writeFeatureCollection, obj);
      else if (obj.type === "Feature") pbf.writeMessage(5, writeFeature, obj);
      else pbf.writeMessage(6, writeGeometry, obj);
      keys = null;
      return pbf.finish();
    }
    __name(encode, "encode");
    function analyze(obj) {
      var i, key2;
      if (obj.type === "FeatureCollection") {
        for (i = 0; i < obj.features.length; i++) analyze(obj.features[i]);
      } else if (obj.type === "Feature") {
        if (obj.geometry !== null) analyze(obj.geometry);
        for (key2 in obj.properties) saveKey(key2);
      } else if (obj.type === "Point") analyzePoint(obj.coordinates);
      else if (obj.type === "MultiPoint") analyzePoints(obj.coordinates);
      else if (obj.type === "GeometryCollection") {
        for (i = 0; i < obj.geometries.length; i++) analyze(obj.geometries[i]);
      } else if (obj.type === "LineString") analyzePoints(obj.coordinates);
      else if (obj.type === "Polygon" || obj.type === "MultiLineString") analyzeMultiLine(obj.coordinates);
      else if (obj.type === "MultiPolygon") {
        for (i = 0; i < obj.coordinates.length; i++) analyzeMultiLine(obj.coordinates[i]);
      }
      for (key2 in obj) {
        if (!isSpecialKey(key2, obj.type)) saveKey(key2);
      }
    }
    __name(analyze, "analyze");
    function analyzeMultiLine(coords) {
      for (var i = 0; i < coords.length; i++) analyzePoints(coords[i]);
    }
    __name(analyzeMultiLine, "analyzeMultiLine");
    function analyzePoints(coords) {
      for (var i = 0; i < coords.length; i++) analyzePoint(coords[i]);
    }
    __name(analyzePoints, "analyzePoints");
    function analyzePoint(point2) {
      dim = Math.max(dim, point2.length);
      for (var i = 0; i < point2.length; i++) {
        while (Math.round(point2[i] * e) / e !== point2[i] && e < maxPrecision) e *= 10;
      }
    }
    __name(analyzePoint, "analyzePoint");
    function saveKey(key2) {
      if (keys[key2] === void 0) {
        keysArr.push(key2);
        keys[key2] = keysNum++;
      }
    }
    __name(saveKey, "saveKey");
    function writeFeatureCollection(obj, pbf) {
      for (var i = 0; i < obj.features.length; i++) {
        pbf.writeMessage(1, writeFeature, obj.features[i]);
      }
      writeProps(obj, pbf, true);
    }
    __name(writeFeatureCollection, "writeFeatureCollection");
    function writeFeature(feature2, pbf) {
      if (feature2.geometry !== null) pbf.writeMessage(1, writeGeometry, feature2.geometry);
      if (feature2.id !== void 0) {
        if (typeof feature2.id === "number" && feature2.id % 1 === 0) pbf.writeSVarintField(12, feature2.id);
        else pbf.writeStringField(11, feature2.id);
      }
      if (feature2.properties) writeProps(feature2.properties, pbf);
      writeProps(feature2, pbf, true);
    }
    __name(writeFeature, "writeFeature");
    function writeGeometry(geom, pbf) {
      pbf.writeVarintField(1, geometryTypes[geom.type]);
      var coords = geom.coordinates;
      if (geom.type === "Point") writePoint(coords, pbf);
      else if (geom.type === "MultiPoint") writeLine(coords, pbf, true);
      else if (geom.type === "LineString") writeLine(coords, pbf);
      else if (geom.type === "MultiLineString") writeMultiLine(coords, pbf);
      else if (geom.type === "Polygon") writeMultiLine(coords, pbf, true);
      else if (geom.type === "MultiPolygon") writeMultiPolygon(coords, pbf);
      else if (geom.type === "GeometryCollection") {
        for (var i = 0; i < geom.geometries.length; i++) pbf.writeMessage(4, writeGeometry, geom.geometries[i]);
      }
      writeProps(geom, pbf, true);
    }
    __name(writeGeometry, "writeGeometry");
    function writeProps(props, pbf, isCustom) {
      var indexes = [], valueIndex = 0;
      for (var key2 in props) {
        if (isCustom && isSpecialKey(key2, props.type)) {
          continue;
        }
        pbf.writeMessage(13, writeValue, props[key2]);
        indexes.push(keys[key2]);
        indexes.push(valueIndex++);
      }
      pbf.writePackedVarint(isCustom ? 15 : 14, indexes);
    }
    __name(writeProps, "writeProps");
    function writeValue(value, pbf) {
      if (value === null) return;
      var type = typeof value;
      if (type === "string") pbf.writeStringField(1, value);
      else if (type === "boolean") pbf.writeBooleanField(5, value);
      else if (type === "object") pbf.writeStringField(6, JSON.stringify(value));
      else if (type === "number") {
        if (value % 1 !== 0) pbf.writeDoubleField(2, value);
        else if (value >= 0) pbf.writeVarintField(3, value);
        else pbf.writeVarintField(4, -value);
      }
    }
    __name(writeValue, "writeValue");
    function writePoint(point2, pbf) {
      var coords = [];
      for (var i = 0; i < dim; i++) coords.push(Math.round(point2[i] * e));
      pbf.writePackedSVarint(3, coords);
    }
    __name(writePoint, "writePoint");
    function writeLine(line, pbf) {
      var coords = [];
      populateLine(coords, line);
      pbf.writePackedSVarint(3, coords);
    }
    __name(writeLine, "writeLine");
    function writeMultiLine(lines, pbf, closed) {
      var len = lines.length, i;
      if (len !== 1) {
        var lengths = [];
        for (i = 0; i < len; i++) lengths.push(lines[i].length - (closed ? 1 : 0));
        pbf.writePackedVarint(2, lengths);
      }
      var coords = [];
      for (i = 0; i < len; i++) populateLine(coords, lines[i], closed);
      pbf.writePackedSVarint(3, coords);
    }
    __name(writeMultiLine, "writeMultiLine");
    function writeMultiPolygon(polygons, pbf) {
      var len = polygons.length, i, j;
      if (len !== 1 || polygons[0].length !== 1) {
        var lengths = [len];
        for (i = 0; i < len; i++) {
          lengths.push(polygons[i].length);
          for (j = 0; j < polygons[i].length; j++) lengths.push(polygons[i][j].length - 1);
        }
        pbf.writePackedVarint(2, lengths);
      }
      var coords = [];
      for (i = 0; i < len; i++) {
        for (j = 0; j < polygons[i].length; j++) populateLine(coords, polygons[i][j], true);
      }
      pbf.writePackedSVarint(3, coords);
    }
    __name(writeMultiPolygon, "writeMultiPolygon");
    function populateLine(coords, line, closed) {
      var i, j, len = line.length - (closed ? 1 : 0), sum2 = new Array(dim);
      for (j = 0; j < dim; j++) sum2[j] = 0;
      for (i = 0; i < len; i++) {
        for (j = 0; j < dim; j++) {
          var n = Math.round(line[i][j] * e) - sum2[j];
          coords.push(n);
          sum2[j] += n;
        }
      }
    }
    __name(populateLine, "populateLine");
    function isSpecialKey(key2, type) {
      if (key2 === "type") return true;
      else if (type === "FeatureCollection") {
        if (key2 === "features") return true;
      } else if (type === "Feature") {
        if (key2 === "id" || key2 === "properties" || key2 === "geometry") return true;
      } else if (type === "GeometryCollection") {
        if (key2 === "geometries") return true;
      } else if (key2 === "coordinates") return true;
      return false;
    }
    __name(isSpecialKey, "isSpecialKey");
  }
});

// ../node_modules/geobuf/decode.js
var require_decode = __commonJS({
  "../node_modules/geobuf/decode.js"(exports, module) {
    "use strict";
    init_functionsRoutes_0_25847306968093076();
    module.exports = decode;
    var keys;
    var values;
    var lengths;
    var dim;
    var e;
    var geometryTypes = [
      "Point",
      "MultiPoint",
      "LineString",
      "MultiLineString",
      "Polygon",
      "MultiPolygon",
      "GeometryCollection"
    ];
    function decode(pbf) {
      dim = 2;
      e = Math.pow(10, 6);
      lengths = null;
      keys = [];
      values = [];
      var obj = pbf.readFields(readDataField, {});
      keys = null;
      return obj;
    }
    __name(decode, "decode");
    function readDataField(tag, obj, pbf) {
      if (tag === 1) keys.push(pbf.readString());
      else if (tag === 2) dim = pbf.readVarint();
      else if (tag === 3) e = Math.pow(10, pbf.readVarint());
      else if (tag === 4) readFeatureCollection(pbf, obj);
      else if (tag === 5) readFeature(pbf, obj);
      else if (tag === 6) readGeometry(pbf, obj);
    }
    __name(readDataField, "readDataField");
    function readFeatureCollection(pbf, obj) {
      obj.type = "FeatureCollection";
      obj.features = [];
      return pbf.readMessage(readFeatureCollectionField, obj);
    }
    __name(readFeatureCollection, "readFeatureCollection");
    function readFeature(pbf, feature2) {
      feature2.type = "Feature";
      var f = pbf.readMessage(readFeatureField, feature2);
      if (!("geometry" in f)) f.geometry = null;
      return f;
    }
    __name(readFeature, "readFeature");
    function readGeometry(pbf, geom) {
      geom.type = "Point";
      return pbf.readMessage(readGeometryField, geom);
    }
    __name(readGeometry, "readGeometry");
    function readFeatureCollectionField(tag, obj, pbf) {
      if (tag === 1) obj.features.push(readFeature(pbf, {}));
      else if (tag === 13) values.push(readValue(pbf));
      else if (tag === 15) readProps(pbf, obj);
    }
    __name(readFeatureCollectionField, "readFeatureCollectionField");
    function readFeatureField(tag, feature2, pbf) {
      if (tag === 1) feature2.geometry = readGeometry(pbf, {});
      else if (tag === 11) feature2.id = pbf.readString();
      else if (tag === 12) feature2.id = pbf.readSVarint();
      else if (tag === 13) values.push(readValue(pbf));
      else if (tag === 14) feature2.properties = readProps(pbf, {});
      else if (tag === 15) readProps(pbf, feature2);
    }
    __name(readFeatureField, "readFeatureField");
    function readGeometryField(tag, geom, pbf) {
      if (tag === 1) geom.type = geometryTypes[pbf.readVarint()];
      else if (tag === 2) lengths = pbf.readPackedVarint();
      else if (tag === 3) readCoords(geom, pbf, geom.type);
      else if (tag === 4) {
        geom.geometries = geom.geometries || [];
        geom.geometries.push(readGeometry(pbf, {}));
      } else if (tag === 13) values.push(readValue(pbf));
      else if (tag === 15) readProps(pbf, geom);
    }
    __name(readGeometryField, "readGeometryField");
    function readCoords(geom, pbf, type) {
      if (type === "Point") geom.coordinates = readPoint(pbf);
      else if (type === "MultiPoint") geom.coordinates = readLine(pbf, true);
      else if (type === "LineString") geom.coordinates = readLine(pbf);
      else if (type === "MultiLineString") geom.coordinates = readMultiLine(pbf);
      else if (type === "Polygon") geom.coordinates = readMultiLine(pbf, true);
      else if (type === "MultiPolygon") geom.coordinates = readMultiPolygon(pbf);
    }
    __name(readCoords, "readCoords");
    function readValue(pbf) {
      var end = pbf.readVarint() + pbf.pos, value = null;
      while (pbf.pos < end) {
        var val = pbf.readVarint(), tag = val >> 3;
        if (tag === 1) value = pbf.readString();
        else if (tag === 2) value = pbf.readDouble();
        else if (tag === 3) value = pbf.readVarint();
        else if (tag === 4) value = -pbf.readVarint();
        else if (tag === 5) value = pbf.readBoolean();
        else if (tag === 6) value = JSON.parse(pbf.readString());
      }
      return value;
    }
    __name(readValue, "readValue");
    function readProps(pbf, props) {
      var end = pbf.readVarint() + pbf.pos;
      while (pbf.pos < end) props[keys[pbf.readVarint()]] = values[pbf.readVarint()];
      values = [];
      return props;
    }
    __name(readProps, "readProps");
    function readPoint(pbf) {
      var end = pbf.readVarint() + pbf.pos, coords = [];
      while (pbf.pos < end) coords.push(pbf.readSVarint() / e);
      return coords;
    }
    __name(readPoint, "readPoint");
    function readLinePart(pbf, end, len, closed) {
      var i = 0, coords = [], p, d;
      var prevP = [];
      for (d = 0; d < dim; d++) prevP[d] = 0;
      while (len ? i < len : pbf.pos < end) {
        p = [];
        for (d = 0; d < dim; d++) {
          prevP[d] += pbf.readSVarint();
          p[d] = prevP[d] / e;
        }
        coords.push(p);
        i++;
      }
      if (closed) coords.push(coords[0]);
      return coords;
    }
    __name(readLinePart, "readLinePart");
    function readLine(pbf) {
      return readLinePart(pbf, pbf.readVarint() + pbf.pos);
    }
    __name(readLine, "readLine");
    function readMultiLine(pbf, closed) {
      var end = pbf.readVarint() + pbf.pos;
      if (!lengths) return [readLinePart(pbf, end, null, closed)];
      var coords = [];
      for (var i = 0; i < lengths.length; i++) coords.push(readLinePart(pbf, end, lengths[i], closed));
      lengths = null;
      return coords;
    }
    __name(readMultiLine, "readMultiLine");
    function readMultiPolygon(pbf) {
      var end = pbf.readVarint() + pbf.pos;
      if (!lengths) return [[readLinePart(pbf, end, null, true)]];
      var coords = [];
      var j = 1;
      for (var i = 0; i < lengths[0]; i++) {
        var rings = [];
        for (var k = 0; k < lengths[j]; k++) rings.push(readLinePart(pbf, end, lengths[j + 1 + k], true));
        j += lengths[j] + 1;
        coords.push(rings);
      }
      lengths = null;
      return coords;
    }
    __name(readMultiPolygon, "readMultiPolygon");
  }
});

// ../node_modules/geobuf/index.js
var require_geobuf = __commonJS({
  "../node_modules/geobuf/index.js"(exports) {
    "use strict";
    init_functionsRoutes_0_25847306968093076();
    exports.encode = require_encode();
    exports.decode = require_decode();
  }
});

// ../node_modules/ieee754/index.js
var require_ieee754 = __commonJS({
  "../node_modules/ieee754/index.js"(exports) {
    init_functionsRoutes_0_25847306968093076();
    exports.read = function(buffer, offset, isLE, mLen, nBytes) {
      var e, m;
      var eLen = nBytes * 8 - mLen - 1;
      var eMax = (1 << eLen) - 1;
      var eBias = eMax >> 1;
      var nBits = -7;
      var i = isLE ? nBytes - 1 : 0;
      var d = isLE ? -1 : 1;
      var s = buffer[offset + i];
      i += d;
      e = s & (1 << -nBits) - 1;
      s >>= -nBits;
      nBits += eLen;
      for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {
      }
      m = e & (1 << -nBits) - 1;
      e >>= -nBits;
      nBits += mLen;
      for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {
      }
      if (e === 0) {
        e = 1 - eBias;
      } else if (e === eMax) {
        return m ? NaN : (s ? -1 : 1) * Infinity;
      } else {
        m = m + Math.pow(2, mLen);
        e = e - eBias;
      }
      return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
    };
    exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
      var e, m, c;
      var eLen = nBytes * 8 - mLen - 1;
      var eMax = (1 << eLen) - 1;
      var eBias = eMax >> 1;
      var rt = mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0;
      var i = isLE ? 0 : nBytes - 1;
      var d = isLE ? 1 : -1;
      var s = value < 0 || value === 0 && 1 / value < 0 ? 1 : 0;
      value = Math.abs(value);
      if (isNaN(value) || value === Infinity) {
        m = isNaN(value) ? 1 : 0;
        e = eMax;
      } else {
        e = Math.floor(Math.log(value) / Math.LN2);
        if (value * (c = Math.pow(2, -e)) < 1) {
          e--;
          c *= 2;
        }
        if (e + eBias >= 1) {
          value += rt / c;
        } else {
          value += rt * Math.pow(2, 1 - eBias);
        }
        if (value * c >= 2) {
          e++;
          c /= 2;
        }
        if (e + eBias >= eMax) {
          m = 0;
          e = eMax;
        } else if (e + eBias >= 1) {
          m = (value * c - 1) * Math.pow(2, mLen);
          e = e + eBias;
        } else {
          m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
          e = 0;
        }
      }
      for (; mLen >= 8; buffer[offset + i] = m & 255, i += d, m /= 256, mLen -= 8) {
      }
      e = e << mLen | m;
      eLen += mLen;
      for (; eLen > 0; buffer[offset + i] = e & 255, i += d, e /= 256, eLen -= 8) {
      }
      buffer[offset + i - d] |= s * 128;
    };
  }
});

// ../node_modules/pbf/index.js
var require_pbf = __commonJS({
  "../node_modules/pbf/index.js"(exports, module) {
    "use strict";
    init_functionsRoutes_0_25847306968093076();
    module.exports = Pbf2;
    var ieee754 = require_ieee754();
    function Pbf2(buf) {
      this.buf = ArrayBuffer.isView && ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf || 0);
      this.pos = 0;
      this.type = 0;
      this.length = this.buf.length;
    }
    __name(Pbf2, "Pbf");
    Pbf2.Varint = 0;
    Pbf2.Fixed64 = 1;
    Pbf2.Bytes = 2;
    Pbf2.Fixed32 = 5;
    var SHIFT_LEFT_32 = (1 << 16) * (1 << 16);
    var SHIFT_RIGHT_32 = 1 / SHIFT_LEFT_32;
    var TEXT_DECODER_MIN_LENGTH = 12;
    var utf8TextDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8");
    Pbf2.prototype = {
      destroy: /* @__PURE__ */ __name(function() {
        this.buf = null;
      }, "destroy"),
      // === READING =================================================================
      readFields: /* @__PURE__ */ __name(function(readField, result, end) {
        end = end || this.length;
        while (this.pos < end) {
          var val = this.readVarint(), tag = val >> 3, startPos = this.pos;
          this.type = val & 7;
          readField(tag, result, this);
          if (this.pos === startPos) this.skip(val);
        }
        return result;
      }, "readFields"),
      readMessage: /* @__PURE__ */ __name(function(readField, result) {
        return this.readFields(readField, result, this.readVarint() + this.pos);
      }, "readMessage"),
      readFixed32: /* @__PURE__ */ __name(function() {
        var val = readUInt32(this.buf, this.pos);
        this.pos += 4;
        return val;
      }, "readFixed32"),
      readSFixed32: /* @__PURE__ */ __name(function() {
        var val = readInt32(this.buf, this.pos);
        this.pos += 4;
        return val;
      }, "readSFixed32"),
      // 64-bit int handling is based on github.com/dpw/node-buffer-more-ints (MIT-licensed)
      readFixed64: /* @__PURE__ */ __name(function() {
        var val = readUInt32(this.buf, this.pos) + readUInt32(this.buf, this.pos + 4) * SHIFT_LEFT_32;
        this.pos += 8;
        return val;
      }, "readFixed64"),
      readSFixed64: /* @__PURE__ */ __name(function() {
        var val = readUInt32(this.buf, this.pos) + readInt32(this.buf, this.pos + 4) * SHIFT_LEFT_32;
        this.pos += 8;
        return val;
      }, "readSFixed64"),
      readFloat: /* @__PURE__ */ __name(function() {
        var val = ieee754.read(this.buf, this.pos, true, 23, 4);
        this.pos += 4;
        return val;
      }, "readFloat"),
      readDouble: /* @__PURE__ */ __name(function() {
        var val = ieee754.read(this.buf, this.pos, true, 52, 8);
        this.pos += 8;
        return val;
      }, "readDouble"),
      readVarint: /* @__PURE__ */ __name(function(isSigned) {
        var buf = this.buf, val, b;
        b = buf[this.pos++];
        val = b & 127;
        if (b < 128) return val;
        b = buf[this.pos++];
        val |= (b & 127) << 7;
        if (b < 128) return val;
        b = buf[this.pos++];
        val |= (b & 127) << 14;
        if (b < 128) return val;
        b = buf[this.pos++];
        val |= (b & 127) << 21;
        if (b < 128) return val;
        b = buf[this.pos];
        val |= (b & 15) << 28;
        return readVarintRemainder(val, isSigned, this);
      }, "readVarint"),
      readVarint64: /* @__PURE__ */ __name(function() {
        return this.readVarint(true);
      }, "readVarint64"),
      readSVarint: /* @__PURE__ */ __name(function() {
        var num = this.readVarint();
        return num % 2 === 1 ? (num + 1) / -2 : num / 2;
      }, "readSVarint"),
      readBoolean: /* @__PURE__ */ __name(function() {
        return Boolean(this.readVarint());
      }, "readBoolean"),
      readString: /* @__PURE__ */ __name(function() {
        var end = this.readVarint() + this.pos;
        var pos = this.pos;
        this.pos = end;
        if (end - pos >= TEXT_DECODER_MIN_LENGTH && utf8TextDecoder) {
          return readUtf8TextDecoder(this.buf, pos, end);
        }
        return readUtf8(this.buf, pos, end);
      }, "readString"),
      readBytes: /* @__PURE__ */ __name(function() {
        var end = this.readVarint() + this.pos, buffer = this.buf.subarray(this.pos, end);
        this.pos = end;
        return buffer;
      }, "readBytes"),
      // verbose for performance reasons; doesn't affect gzipped size
      readPackedVarint: /* @__PURE__ */ __name(function(arr, isSigned) {
        if (this.type !== Pbf2.Bytes) return arr.push(this.readVarint(isSigned));
        var end = readPackedEnd(this);
        arr = arr || [];
        while (this.pos < end) arr.push(this.readVarint(isSigned));
        return arr;
      }, "readPackedVarint"),
      readPackedSVarint: /* @__PURE__ */ __name(function(arr) {
        if (this.type !== Pbf2.Bytes) return arr.push(this.readSVarint());
        var end = readPackedEnd(this);
        arr = arr || [];
        while (this.pos < end) arr.push(this.readSVarint());
        return arr;
      }, "readPackedSVarint"),
      readPackedBoolean: /* @__PURE__ */ __name(function(arr) {
        if (this.type !== Pbf2.Bytes) return arr.push(this.readBoolean());
        var end = readPackedEnd(this);
        arr = arr || [];
        while (this.pos < end) arr.push(this.readBoolean());
        return arr;
      }, "readPackedBoolean"),
      readPackedFloat: /* @__PURE__ */ __name(function(arr) {
        if (this.type !== Pbf2.Bytes) return arr.push(this.readFloat());
        var end = readPackedEnd(this);
        arr = arr || [];
        while (this.pos < end) arr.push(this.readFloat());
        return arr;
      }, "readPackedFloat"),
      readPackedDouble: /* @__PURE__ */ __name(function(arr) {
        if (this.type !== Pbf2.Bytes) return arr.push(this.readDouble());
        var end = readPackedEnd(this);
        arr = arr || [];
        while (this.pos < end) arr.push(this.readDouble());
        return arr;
      }, "readPackedDouble"),
      readPackedFixed32: /* @__PURE__ */ __name(function(arr) {
        if (this.type !== Pbf2.Bytes) return arr.push(this.readFixed32());
        var end = readPackedEnd(this);
        arr = arr || [];
        while (this.pos < end) arr.push(this.readFixed32());
        return arr;
      }, "readPackedFixed32"),
      readPackedSFixed32: /* @__PURE__ */ __name(function(arr) {
        if (this.type !== Pbf2.Bytes) return arr.push(this.readSFixed32());
        var end = readPackedEnd(this);
        arr = arr || [];
        while (this.pos < end) arr.push(this.readSFixed32());
        return arr;
      }, "readPackedSFixed32"),
      readPackedFixed64: /* @__PURE__ */ __name(function(arr) {
        if (this.type !== Pbf2.Bytes) return arr.push(this.readFixed64());
        var end = readPackedEnd(this);
        arr = arr || [];
        while (this.pos < end) arr.push(this.readFixed64());
        return arr;
      }, "readPackedFixed64"),
      readPackedSFixed64: /* @__PURE__ */ __name(function(arr) {
        if (this.type !== Pbf2.Bytes) return arr.push(this.readSFixed64());
        var end = readPackedEnd(this);
        arr = arr || [];
        while (this.pos < end) arr.push(this.readSFixed64());
        return arr;
      }, "readPackedSFixed64"),
      skip: /* @__PURE__ */ __name(function(val) {
        var type = val & 7;
        if (type === Pbf2.Varint) while (this.buf[this.pos++] > 127) {
        }
        else if (type === Pbf2.Bytes) this.pos = this.readVarint() + this.pos;
        else if (type === Pbf2.Fixed32) this.pos += 4;
        else if (type === Pbf2.Fixed64) this.pos += 8;
        else throw new Error("Unimplemented type: " + type);
      }, "skip"),
      // === WRITING =================================================================
      writeTag: /* @__PURE__ */ __name(function(tag, type) {
        this.writeVarint(tag << 3 | type);
      }, "writeTag"),
      realloc: /* @__PURE__ */ __name(function(min) {
        var length = this.length || 16;
        while (length < this.pos + min) length *= 2;
        if (length !== this.length) {
          var buf = new Uint8Array(length);
          buf.set(this.buf);
          this.buf = buf;
          this.length = length;
        }
      }, "realloc"),
      finish: /* @__PURE__ */ __name(function() {
        this.length = this.pos;
        this.pos = 0;
        return this.buf.subarray(0, this.length);
      }, "finish"),
      writeFixed32: /* @__PURE__ */ __name(function(val) {
        this.realloc(4);
        writeInt32(this.buf, val, this.pos);
        this.pos += 4;
      }, "writeFixed32"),
      writeSFixed32: /* @__PURE__ */ __name(function(val) {
        this.realloc(4);
        writeInt32(this.buf, val, this.pos);
        this.pos += 4;
      }, "writeSFixed32"),
      writeFixed64: /* @__PURE__ */ __name(function(val) {
        this.realloc(8);
        writeInt32(this.buf, val & -1, this.pos);
        writeInt32(this.buf, Math.floor(val * SHIFT_RIGHT_32), this.pos + 4);
        this.pos += 8;
      }, "writeFixed64"),
      writeSFixed64: /* @__PURE__ */ __name(function(val) {
        this.realloc(8);
        writeInt32(this.buf, val & -1, this.pos);
        writeInt32(this.buf, Math.floor(val * SHIFT_RIGHT_32), this.pos + 4);
        this.pos += 8;
      }, "writeSFixed64"),
      writeVarint: /* @__PURE__ */ __name(function(val) {
        val = +val || 0;
        if (val > 268435455 || val < 0) {
          writeBigVarint(val, this);
          return;
        }
        this.realloc(4);
        this.buf[this.pos++] = val & 127 | (val > 127 ? 128 : 0);
        if (val <= 127) return;
        this.buf[this.pos++] = (val >>>= 7) & 127 | (val > 127 ? 128 : 0);
        if (val <= 127) return;
        this.buf[this.pos++] = (val >>>= 7) & 127 | (val > 127 ? 128 : 0);
        if (val <= 127) return;
        this.buf[this.pos++] = val >>> 7 & 127;
      }, "writeVarint"),
      writeSVarint: /* @__PURE__ */ __name(function(val) {
        this.writeVarint(val < 0 ? -val * 2 - 1 : val * 2);
      }, "writeSVarint"),
      writeBoolean: /* @__PURE__ */ __name(function(val) {
        this.writeVarint(Boolean(val));
      }, "writeBoolean"),
      writeString: /* @__PURE__ */ __name(function(str) {
        str = String(str);
        this.realloc(str.length * 4);
        this.pos++;
        var startPos = this.pos;
        this.pos = writeUtf8(this.buf, str, this.pos);
        var len = this.pos - startPos;
        if (len >= 128) makeRoomForExtraLength(startPos, len, this);
        this.pos = startPos - 1;
        this.writeVarint(len);
        this.pos += len;
      }, "writeString"),
      writeFloat: /* @__PURE__ */ __name(function(val) {
        this.realloc(4);
        ieee754.write(this.buf, val, this.pos, true, 23, 4);
        this.pos += 4;
      }, "writeFloat"),
      writeDouble: /* @__PURE__ */ __name(function(val) {
        this.realloc(8);
        ieee754.write(this.buf, val, this.pos, true, 52, 8);
        this.pos += 8;
      }, "writeDouble"),
      writeBytes: /* @__PURE__ */ __name(function(buffer) {
        var len = buffer.length;
        this.writeVarint(len);
        this.realloc(len);
        for (var i = 0; i < len; i++) this.buf[this.pos++] = buffer[i];
      }, "writeBytes"),
      writeRawMessage: /* @__PURE__ */ __name(function(fn, obj) {
        this.pos++;
        var startPos = this.pos;
        fn(obj, this);
        var len = this.pos - startPos;
        if (len >= 128) makeRoomForExtraLength(startPos, len, this);
        this.pos = startPos - 1;
        this.writeVarint(len);
        this.pos += len;
      }, "writeRawMessage"),
      writeMessage: /* @__PURE__ */ __name(function(tag, fn, obj) {
        this.writeTag(tag, Pbf2.Bytes);
        this.writeRawMessage(fn, obj);
      }, "writeMessage"),
      writePackedVarint: /* @__PURE__ */ __name(function(tag, arr) {
        if (arr.length) this.writeMessage(tag, writePackedVarint, arr);
      }, "writePackedVarint"),
      writePackedSVarint: /* @__PURE__ */ __name(function(tag, arr) {
        if (arr.length) this.writeMessage(tag, writePackedSVarint, arr);
      }, "writePackedSVarint"),
      writePackedBoolean: /* @__PURE__ */ __name(function(tag, arr) {
        if (arr.length) this.writeMessage(tag, writePackedBoolean, arr);
      }, "writePackedBoolean"),
      writePackedFloat: /* @__PURE__ */ __name(function(tag, arr) {
        if (arr.length) this.writeMessage(tag, writePackedFloat, arr);
      }, "writePackedFloat"),
      writePackedDouble: /* @__PURE__ */ __name(function(tag, arr) {
        if (arr.length) this.writeMessage(tag, writePackedDouble, arr);
      }, "writePackedDouble"),
      writePackedFixed32: /* @__PURE__ */ __name(function(tag, arr) {
        if (arr.length) this.writeMessage(tag, writePackedFixed32, arr);
      }, "writePackedFixed32"),
      writePackedSFixed32: /* @__PURE__ */ __name(function(tag, arr) {
        if (arr.length) this.writeMessage(tag, writePackedSFixed32, arr);
      }, "writePackedSFixed32"),
      writePackedFixed64: /* @__PURE__ */ __name(function(tag, arr) {
        if (arr.length) this.writeMessage(tag, writePackedFixed64, arr);
      }, "writePackedFixed64"),
      writePackedSFixed64: /* @__PURE__ */ __name(function(tag, arr) {
        if (arr.length) this.writeMessage(tag, writePackedSFixed64, arr);
      }, "writePackedSFixed64"),
      writeBytesField: /* @__PURE__ */ __name(function(tag, buffer) {
        this.writeTag(tag, Pbf2.Bytes);
        this.writeBytes(buffer);
      }, "writeBytesField"),
      writeFixed32Field: /* @__PURE__ */ __name(function(tag, val) {
        this.writeTag(tag, Pbf2.Fixed32);
        this.writeFixed32(val);
      }, "writeFixed32Field"),
      writeSFixed32Field: /* @__PURE__ */ __name(function(tag, val) {
        this.writeTag(tag, Pbf2.Fixed32);
        this.writeSFixed32(val);
      }, "writeSFixed32Field"),
      writeFixed64Field: /* @__PURE__ */ __name(function(tag, val) {
        this.writeTag(tag, Pbf2.Fixed64);
        this.writeFixed64(val);
      }, "writeFixed64Field"),
      writeSFixed64Field: /* @__PURE__ */ __name(function(tag, val) {
        this.writeTag(tag, Pbf2.Fixed64);
        this.writeSFixed64(val);
      }, "writeSFixed64Field"),
      writeVarintField: /* @__PURE__ */ __name(function(tag, val) {
        this.writeTag(tag, Pbf2.Varint);
        this.writeVarint(val);
      }, "writeVarintField"),
      writeSVarintField: /* @__PURE__ */ __name(function(tag, val) {
        this.writeTag(tag, Pbf2.Varint);
        this.writeSVarint(val);
      }, "writeSVarintField"),
      writeStringField: /* @__PURE__ */ __name(function(tag, str) {
        this.writeTag(tag, Pbf2.Bytes);
        this.writeString(str);
      }, "writeStringField"),
      writeFloatField: /* @__PURE__ */ __name(function(tag, val) {
        this.writeTag(tag, Pbf2.Fixed32);
        this.writeFloat(val);
      }, "writeFloatField"),
      writeDoubleField: /* @__PURE__ */ __name(function(tag, val) {
        this.writeTag(tag, Pbf2.Fixed64);
        this.writeDouble(val);
      }, "writeDoubleField"),
      writeBooleanField: /* @__PURE__ */ __name(function(tag, val) {
        this.writeVarintField(tag, Boolean(val));
      }, "writeBooleanField")
    };
    function readVarintRemainder(l, s, p) {
      var buf = p.buf, h, b;
      b = buf[p.pos++];
      h = (b & 112) >> 4;
      if (b < 128) return toNum(l, h, s);
      b = buf[p.pos++];
      h |= (b & 127) << 3;
      if (b < 128) return toNum(l, h, s);
      b = buf[p.pos++];
      h |= (b & 127) << 10;
      if (b < 128) return toNum(l, h, s);
      b = buf[p.pos++];
      h |= (b & 127) << 17;
      if (b < 128) return toNum(l, h, s);
      b = buf[p.pos++];
      h |= (b & 127) << 24;
      if (b < 128) return toNum(l, h, s);
      b = buf[p.pos++];
      h |= (b & 1) << 31;
      if (b < 128) return toNum(l, h, s);
      throw new Error("Expected varint not more than 10 bytes");
    }
    __name(readVarintRemainder, "readVarintRemainder");
    function readPackedEnd(pbf) {
      return pbf.type === Pbf2.Bytes ? pbf.readVarint() + pbf.pos : pbf.pos + 1;
    }
    __name(readPackedEnd, "readPackedEnd");
    function toNum(low, high, isSigned) {
      if (isSigned) {
        return high * 4294967296 + (low >>> 0);
      }
      return (high >>> 0) * 4294967296 + (low >>> 0);
    }
    __name(toNum, "toNum");
    function writeBigVarint(val, pbf) {
      var low, high;
      if (val >= 0) {
        low = val % 4294967296 | 0;
        high = val / 4294967296 | 0;
      } else {
        low = ~(-val % 4294967296);
        high = ~(-val / 4294967296);
        if (low ^ 4294967295) {
          low = low + 1 | 0;
        } else {
          low = 0;
          high = high + 1 | 0;
        }
      }
      if (val >= 18446744073709552e3 || val < -18446744073709552e3) {
        throw new Error("Given varint doesn't fit into 10 bytes");
      }
      pbf.realloc(10);
      writeBigVarintLow(low, high, pbf);
      writeBigVarintHigh(high, pbf);
    }
    __name(writeBigVarint, "writeBigVarint");
    function writeBigVarintLow(low, high, pbf) {
      pbf.buf[pbf.pos++] = low & 127 | 128;
      low >>>= 7;
      pbf.buf[pbf.pos++] = low & 127 | 128;
      low >>>= 7;
      pbf.buf[pbf.pos++] = low & 127 | 128;
      low >>>= 7;
      pbf.buf[pbf.pos++] = low & 127 | 128;
      low >>>= 7;
      pbf.buf[pbf.pos] = low & 127;
    }
    __name(writeBigVarintLow, "writeBigVarintLow");
    function writeBigVarintHigh(high, pbf) {
      var lsb = (high & 7) << 4;
      pbf.buf[pbf.pos++] |= lsb | ((high >>>= 3) ? 128 : 0);
      if (!high) return;
      pbf.buf[pbf.pos++] = high & 127 | ((high >>>= 7) ? 128 : 0);
      if (!high) return;
      pbf.buf[pbf.pos++] = high & 127 | ((high >>>= 7) ? 128 : 0);
      if (!high) return;
      pbf.buf[pbf.pos++] = high & 127 | ((high >>>= 7) ? 128 : 0);
      if (!high) return;
      pbf.buf[pbf.pos++] = high & 127 | ((high >>>= 7) ? 128 : 0);
      if (!high) return;
      pbf.buf[pbf.pos++] = high & 127;
    }
    __name(writeBigVarintHigh, "writeBigVarintHigh");
    function makeRoomForExtraLength(startPos, len, pbf) {
      var extraLen = len <= 16383 ? 1 : len <= 2097151 ? 2 : len <= 268435455 ? 3 : Math.floor(Math.log(len) / (Math.LN2 * 7));
      pbf.realloc(extraLen);
      for (var i = pbf.pos - 1; i >= startPos; i--) pbf.buf[i + extraLen] = pbf.buf[i];
    }
    __name(makeRoomForExtraLength, "makeRoomForExtraLength");
    function writePackedVarint(arr, pbf) {
      for (var i = 0; i < arr.length; i++) pbf.writeVarint(arr[i]);
    }
    __name(writePackedVarint, "writePackedVarint");
    function writePackedSVarint(arr, pbf) {
      for (var i = 0; i < arr.length; i++) pbf.writeSVarint(arr[i]);
    }
    __name(writePackedSVarint, "writePackedSVarint");
    function writePackedFloat(arr, pbf) {
      for (var i = 0; i < arr.length; i++) pbf.writeFloat(arr[i]);
    }
    __name(writePackedFloat, "writePackedFloat");
    function writePackedDouble(arr, pbf) {
      for (var i = 0; i < arr.length; i++) pbf.writeDouble(arr[i]);
    }
    __name(writePackedDouble, "writePackedDouble");
    function writePackedBoolean(arr, pbf) {
      for (var i = 0; i < arr.length; i++) pbf.writeBoolean(arr[i]);
    }
    __name(writePackedBoolean, "writePackedBoolean");
    function writePackedFixed32(arr, pbf) {
      for (var i = 0; i < arr.length; i++) pbf.writeFixed32(arr[i]);
    }
    __name(writePackedFixed32, "writePackedFixed32");
    function writePackedSFixed32(arr, pbf) {
      for (var i = 0; i < arr.length; i++) pbf.writeSFixed32(arr[i]);
    }
    __name(writePackedSFixed32, "writePackedSFixed32");
    function writePackedFixed64(arr, pbf) {
      for (var i = 0; i < arr.length; i++) pbf.writeFixed64(arr[i]);
    }
    __name(writePackedFixed64, "writePackedFixed64");
    function writePackedSFixed64(arr, pbf) {
      for (var i = 0; i < arr.length; i++) pbf.writeSFixed64(arr[i]);
    }
    __name(writePackedSFixed64, "writePackedSFixed64");
    function readUInt32(buf, pos) {
      return (buf[pos] | buf[pos + 1] << 8 | buf[pos + 2] << 16) + buf[pos + 3] * 16777216;
    }
    __name(readUInt32, "readUInt32");
    function writeInt32(buf, val, pos) {
      buf[pos] = val;
      buf[pos + 1] = val >>> 8;
      buf[pos + 2] = val >>> 16;
      buf[pos + 3] = val >>> 24;
    }
    __name(writeInt32, "writeInt32");
    function readInt32(buf, pos) {
      return (buf[pos] | buf[pos + 1] << 8 | buf[pos + 2] << 16) + (buf[pos + 3] << 24);
    }
    __name(readInt32, "readInt32");
    function readUtf8(buf, pos, end) {
      var str = "";
      var i = pos;
      while (i < end) {
        var b0 = buf[i];
        var c = null;
        var bytesPerSequence = b0 > 239 ? 4 : b0 > 223 ? 3 : b0 > 191 ? 2 : 1;
        if (i + bytesPerSequence > end) break;
        var b1, b2, b3;
        if (bytesPerSequence === 1) {
          if (b0 < 128) {
            c = b0;
          }
        } else if (bytesPerSequence === 2) {
          b1 = buf[i + 1];
          if ((b1 & 192) === 128) {
            c = (b0 & 31) << 6 | b1 & 63;
            if (c <= 127) {
              c = null;
            }
          }
        } else if (bytesPerSequence === 3) {
          b1 = buf[i + 1];
          b2 = buf[i + 2];
          if ((b1 & 192) === 128 && (b2 & 192) === 128) {
            c = (b0 & 15) << 12 | (b1 & 63) << 6 | b2 & 63;
            if (c <= 2047 || c >= 55296 && c <= 57343) {
              c = null;
            }
          }
        } else if (bytesPerSequence === 4) {
          b1 = buf[i + 1];
          b2 = buf[i + 2];
          b3 = buf[i + 3];
          if ((b1 & 192) === 128 && (b2 & 192) === 128 && (b3 & 192) === 128) {
            c = (b0 & 15) << 18 | (b1 & 63) << 12 | (b2 & 63) << 6 | b3 & 63;
            if (c <= 65535 || c >= 1114112) {
              c = null;
            }
          }
        }
        if (c === null) {
          c = 65533;
          bytesPerSequence = 1;
        } else if (c > 65535) {
          c -= 65536;
          str += String.fromCharCode(c >>> 10 & 1023 | 55296);
          c = 56320 | c & 1023;
        }
        str += String.fromCharCode(c);
        i += bytesPerSequence;
      }
      return str;
    }
    __name(readUtf8, "readUtf8");
    function readUtf8TextDecoder(buf, pos, end) {
      return utf8TextDecoder.decode(buf.subarray(pos, end));
    }
    __name(readUtf8TextDecoder, "readUtf8TextDecoder");
    function writeUtf8(buf, str, pos) {
      for (var i = 0, c, lead; i < str.length; i++) {
        c = str.charCodeAt(i);
        if (c > 55295 && c < 57344) {
          if (lead) {
            if (c < 56320) {
              buf[pos++] = 239;
              buf[pos++] = 191;
              buf[pos++] = 189;
              lead = c;
              continue;
            } else {
              c = lead - 55296 << 10 | c - 56320 | 65536;
              lead = null;
            }
          } else {
            if (c > 56319 || i + 1 === str.length) {
              buf[pos++] = 239;
              buf[pos++] = 191;
              buf[pos++] = 189;
            } else {
              lead = c;
            }
            continue;
          }
        } else if (lead) {
          buf[pos++] = 239;
          buf[pos++] = 191;
          buf[pos++] = 189;
          lead = null;
        }
        if (c < 128) {
          buf[pos++] = c;
        } else {
          if (c < 2048) {
            buf[pos++] = c >> 6 | 192;
          } else {
            if (c < 65536) {
              buf[pos++] = c >> 12 | 224;
            } else {
              buf[pos++] = c >> 18 | 240;
              buf[pos++] = c >> 12 & 63 | 128;
            }
            buf[pos++] = c >> 6 & 63 | 128;
          }
          buf[pos++] = c & 63 | 128;
        }
      }
      return pos;
    }
    __name(writeUtf8, "writeUtf8");
  }
});

// ../server/cloudflareGeoTz.ts
function assetUrl(requestUrl, path) {
  return new URL(`${ASSET_ROOT}/${path}`, requestUrl).href;
}
async function fetchRequiredAsset(assets, url) {
  const response = await assets.fetch(new Request(url));
  if (!response.ok) {
    throw new Error(`geo-tz\u30C7\u30FC\u30BF\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\uFF08${response.status}\uFF09`);
  }
  return response;
}
function loadIndex(assets, requestUrl) {
  const url = assetUrl(requestUrl, "timezones-1970.index.json");
  const cached = indexCache.get(url);
  if (cached) return cached;
  const promise = fetchRequiredAsset(assets, url).then((response) => response.json()).catch((error) => {
    indexCache.delete(url);
    throw error;
  });
  indexCache.set(url, promise);
  return promise;
}
function rememberDataPart(key2, promise) {
  dataPartCache.set(key2, promise);
  if (dataPartCache.size > MAX_CACHED_DATA_PARTS) {
    const oldestKey = dataPartCache.keys().next().value;
    if (typeof oldestKey === "string") dataPartCache.delete(oldestKey);
  }
  return promise;
}
function loadDataPart(assets, requestUrl, partIndex) {
  const partName = `timezones-1970.part-${partIndex.toString().padStart(3, "0")}.bin`;
  const url = assetUrl(requestUrl, partName);
  const cached = dataPartCache.get(url);
  if (cached) return cached;
  return rememberDataPart(
    url,
    fetchRequiredAsset(assets, url).then((response) => response.arrayBuffer()).catch((error) => {
      dataPartCache.delete(url);
      throw error;
    })
  );
}
async function readDataRange(assets, requestUrl, position, length) {
  if (position < 0 || length <= 0) {
    throw new Error("geo-tz\u30A4\u30F3\u30C7\u30C3\u30AF\u30B9\u304C\u4E0D\u6B63\u3067\u3059");
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
    if (copyLength <= 0) throw new Error("geo-tz\u30C7\u30FC\u30BF\u304C\u9014\u4E2D\u3067\u7D42\u4E86\u3057\u307E\u3057\u305F");
    output.set(bytes.subarray(start, start + copyLength), outputOffset);
    outputOffset += copyLength;
  }
  if (outputOffset !== length) throw new Error("geo-tz\u30C7\u30FC\u30BF\u304C\u4E0D\u8DB3\u3057\u3066\u3044\u307E\u3059");
  return output;
}
function oceanTimeZones(longitude) {
  if (longitude === -180 || longitude === 180) {
    return ["Etc/GMT+12", "Etc/GMT-12"];
  }
  const offset = Math.max(-12, Math.min(12, -Math.round(longitude / 15)));
  return [offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "+" : ""}${offset}`];
}
function isLeaf(value) {
  return !Array.isArray(value) && "pos" in value && Number.isFinite(value.pos) && "len" in value && Number.isFinite(value.len);
}
async function findCloudflareTimeZones(latitude, longitude, assets, requestUrl) {
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
    midLon: 0
  };
  let node = index.lookup;
  while (node) {
    if (Array.isArray(node)) {
      return node.map((timeZoneIndex) => index.timezones[timeZoneIndex]).filter((value) => typeof value === "string");
    }
    if (isLeaf(node)) {
      const bytes = await readDataRange(
        assets,
        requestUrl,
        node.pos,
        node.len
      );
      const decoded = import_geobuf.default.decode(new import_pbf.default(bytes));
      const matches = decoded.features.flatMap((feature2) => {
        const timeZone = feature2.properties?.tzid;
        return typeof timeZone === "string" && index_default(queryPoint, feature2) ? [timeZone] : [];
      });
      return matches.length > 0 ? matches : oceanTimeZones(longitude);
    }
    let quadrant;
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
var import_geobuf, import_pbf, ASSET_ROOT, DATA_PART_BYTES, MAX_CACHED_DATA_PARTS, indexCache, dataPartCache;
var init_cloudflareGeoTz = __esm({
  "../server/cloudflareGeoTz.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_esm4();
    init_esm2();
    import_geobuf = __toESM(require_geobuf(), 1);
    import_pbf = __toESM(require_pbf(), 1);
    ASSET_ROOT = "/__astro_internal_geo_tz";
    DATA_PART_BYTES = 4 * 1024 * 1024;
    MAX_CACHED_DATA_PARTS = 4;
    indexCache = /* @__PURE__ */ new Map();
    dataPartCache = /* @__PURE__ */ new Map();
    __name(assetUrl, "assetUrl");
    __name(fetchRequiredAsset, "fetchRequiredAsset");
    __name(loadIndex, "loadIndex");
    __name(rememberDataPart, "rememberDataPart");
    __name(loadDataPart, "loadDataPart");
    __name(readDataRange, "readDataRange");
    __name(oceanTimeZones, "oceanTimeZones");
    __name(isLeaf, "isLeaf");
    __name(findCloudflareTimeZones, "findCloudflareTimeZones");
  }
});

// api/timezone.ts
var onRequest9;
var init_timezone = __esm({
  "api/timezone.ts"() {
    init_functionsRoutes_0_25847306968093076();
    init_cloudflareGeoTz();
    init_http();
    onRequest9 = /* @__PURE__ */ __name(async ({ request, env }) => {
      if (request.method !== "GET") {
        return jsonResponse({ error: "GET\u30EA\u30AF\u30A8\u30B9\u30C8\u306E\u307F\u5229\u7528\u3067\u304D\u307E\u3059" }, 405);
      }
      const url = new URL(request.url);
      const latitude = Number(url.searchParams.get("latitude"));
      const longitude = Number(url.searchParams.get("longitude"));
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return jsonResponse({ error: "\u7DEF\u5EA6\u30FB\u7D4C\u5EA6\u304C\u4E0D\u6B63\u3067\u3059" }, 400, "public, max-age=86400");
      }
      try {
        const timeZone = (await findCloudflareTimeZones(latitude, longitude, env.ASSETS, request.url))[0];
        return timeZone ? jsonResponse({ timeZone }, 200, "public, max-age=86400") : jsonResponse({ error: "\u30BF\u30A4\u30E0\u30BE\u30FC\u30F3\u3092\u7279\u5B9A\u3067\u304D\u307E\u305B\u3093" }, 404, "public, max-age=86400");
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : String(error)
        }, 422, "public, max-age=86400");
      }
    }, "onRequest");
  }
});

// ../.wrangler/tmp/pages-ydjWek/functionsRoutes-0.25847306968093076.mjs
var routes;
var init_functionsRoutes_0_25847306968093076 = __esm({
  "../.wrangler/tmp/pages-ydjWek/functionsRoutes-0.25847306968093076.mjs"() {
    init_geocode();
    init_gsi_elevation();
    init_gsi_geoid();
    init_osm_site_context();
    init_resolve_google_maps();
    init_spot_search_finalize();
    init_spot_search_start();
    init_spot_search_status();
    init_timezone();
    routes = [
      {
        routePath: "/api/geocode",
        mountPath: "/api",
        method: "",
        middlewares: [],
        modules: [onRequest]
      },
      {
        routePath: "/api/gsi-elevation",
        mountPath: "/api",
        method: "",
        middlewares: [],
        modules: [onRequest2]
      },
      {
        routePath: "/api/gsi-geoid",
        mountPath: "/api",
        method: "",
        middlewares: [],
        modules: [onRequest3]
      },
      {
        routePath: "/api/osm-site-context",
        mountPath: "/api",
        method: "",
        middlewares: [],
        modules: [onRequest4]
      },
      {
        routePath: "/api/resolve-google-maps",
        mountPath: "/api",
        method: "",
        middlewares: [],
        modules: [onRequest5]
      },
      {
        routePath: "/api/spot-search-finalize",
        mountPath: "/api",
        method: "",
        middlewares: [],
        modules: [onRequest6]
      },
      {
        routePath: "/api/spot-search-start",
        mountPath: "/api",
        method: "",
        middlewares: [],
        modules: [onRequest7]
      },
      {
        routePath: "/api/spot-search-status",
        mountPath: "/api",
        method: "",
        middlewares: [],
        modules: [onRequest8]
      },
      {
        routePath: "/api/timezone",
        mountPath: "/api",
        method: "",
        middlewares: [],
        modules: [onRequest9]
      }
    ];
  }
});

// ../node_modules/wrangler/templates/pages-template-worker.ts
init_functionsRoutes_0_25847306968093076();

// ../node_modules/path-to-regexp/dist.es2015/index.js
init_functionsRoutes_0_25847306968093076();
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key2 = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key2++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key2++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key2 = keys[i2 - 1];
      if (key2.modifier === "*" || key2.modifier === "+") {
        params[key2.name] = m[i2].split(key2.prefix + key2.suffix).map(function(value) {
          return decode(value, key2);
        });
      } else {
        params[key2.name] = decode(m[i2], key2);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};
/*! Bundled license information:

ieee754/index.js:
  (*! ieee754. BSD-3-Clause License. Feross Aboukhadijeh <https://feross.org/opensource> *)
*/

// CityGML（PLATEAU）の建物ファイルを流し読みし、建物ごとに「上を向いた面」と高さの範囲を取り出す。
//
// 方針（精度最優先）:
//  - 座標は元データの数値をそのまま残す（丸めない・間引かない）。
//  - 高さは元データの値（標高）のまま残す。楕円体高への換算など、解釈を伴う処理はここではしない。
//  - 屋根の面は、形状の詳細度（LOD）ごとに分けてすべて残す。
//  - 想定外のデータ（座標系が違う・座標が日本の範囲外）は、推測で直さずに「読めなかった」と数える。
//
// 出力する建物1件の形:
//  { id, mh, pmh, ht, b:[南,西,北,東],
//    l0: { k:"re"|"fp", p:[面...] },
//    l:  { "1": { z:[最低,最高], t:[面...], zi:[最低,最高], ti:[面...] }, "2": {...} } }
//  面 = [外周, 穴...]、外周・穴 = [緯度,経度,高さ, 緯度,経度,高さ, ...]
//  t = 建物本体の上を向いた面、ti = 屋上の付属物（塔屋・設備など）の上を向いた面。

const SKIPPED_BUILDING_ELEMENTS = new Set([
  // 屋内の要素と、実体のない面は、外から見た高さに関係しない。
  "Room", "interiorRoom", "IntBuildingInstallation", "interiorBuildingInstallation",
  "BuildingFurniture", "interiorFurniture", "Door", "Window", "opening",
  "InteriorWallSurface", "CeilingSurface", "FloorSurface", "ClosureSurface",
]);
const SURFACE_ELEMENTS = new Set(["RoofSurface", "WallSurface", "GroundSurface", "OuterFloorSurface", "OuterCeilingSurface"]);
const TOP_SURFACES = new Set(["RoofSurface", "OuterFloorSurface"]);
const VERTICAL_RATIO = 1e-3;
const GROUND_FACE_TOLERANCE_METERS = 0.005;
const METERS_PER_DEGREE = 111_320;

const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITY[body] ?? whole;
  });
}

function attribute(tag, name) {
  const pattern = new RegExp(`\\s${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "u");
  const match = pattern.exec(tag);
  return match ? decodeEntities(match[1] ?? match[2]) : null;
}

/** 名前空間のURIから、扱う種類を決める（接頭辞の文字には頼らない）。 */
function namespaceKind(uri) {
  if (!uri) return "";
  if (/\/citygml\/building\//u.test(uri)) return "bldg";
  if (/opengis\.net\/gml/u.test(uri)) return "gml";
  if (/\/iur\/uro\//u.test(uri)) return "uro";
  return "other";
}

/** 面が鉛直（壁）かどうかと、水平に見たときの面積を求める。 */
function horizontalShare(ring) {
  const count = ring.length / 3;
  if (count < 3) return 0;
  const cosLatitude = Math.cos((ring[0] * Math.PI) / 180);
  const x0 = ring[1] * cosLatitude * METERS_PER_DEGREE;
  const y0 = ring[0] * METERS_PER_DEGREE;
  const z0 = ring[2];
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const ax = ring[index * 3 + 1] * cosLatitude * METERS_PER_DEGREE - x0;
    const ay = ring[index * 3] * METERS_PER_DEGREE - y0;
    const az = ring[index * 3 + 2] - z0;
    const bx = ring[next * 3 + 1] * cosLatitude * METERS_PER_DEGREE - x0;
    const by = ring[next * 3] * METERS_PER_DEGREE - y0;
    const bz = ring[next * 3 + 2] - z0;
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const length = Math.hypot(nx, ny, nz);
  return length === 0 ? 0 : Math.abs(nz) / length;
}

export function createBuildingExtractor(onBuilding) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const namespaces = new Map();
  const stats = {
    buildings: 0, written: 0, withoutGeometry: 0, polygons: 0, badCoordinatePolygons: 0,
    maxLod: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 }, srsNames: [], hrefOnlyLods: 0, encoding: null,
  };
  let pending = "";
  let depth = 0;
  let defaultDimension = 3;

  let building = null; // 読み取り中の建物
  let buildingDepth = -1;
  let skipDepth = -1;
  let partDepth = -1;
  let installationDepth = -1;
  let lod = null; // { lod, prop, depth }
  let surface = null; // { type, depth }
  let polygon = null; // { rings, depth }
  let ringRole = null;
  let capture = null; // { kind, depth, text, dimension }

  function resolve(qualifiedName) {
    const colon = qualifiedName.indexOf(":");
    const prefix = colon < 0 ? "" : qualifiedName.slice(0, colon);
    return { kind: namespaceKind(namespaces.get(prefix)), local: colon < 0 ? qualifiedName : qualifiedName.slice(colon + 1) };
  }

  /** gml:id（接頭辞の文字は問わない）を読む。 */
  function gmlId(tag) {
    for (const match of tag.matchAll(/\s(?:([\w.-]+):)?id\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
      if (match[1] === undefined || namespaceKind(namespaces.get(match[1])) === "gml") return decodeEntities(match[2] ?? match[3]);
    }
    return "";
  }

  function parseCoordinates(text, dimension, separatorComma) {
    const parts = separatorComma ? text.trim().split(/[\s,]+/u) : text.trim().split(/\s+/u);
    if (parts.length === 1 && parts[0] === "") return [];
    if (dimension !== 3 && dimension !== 2) return null;
    if (parts.length % dimension !== 0) return null;
    const ring = new Array((parts.length / dimension) * 3);
    for (let source = 0, target = 0; source < parts.length; source += dimension, target += 3) {
      const latitude = Number(parts[source]);
      const longitude = Number(parts[source + 1]);
      const height = dimension === 3 ? Number(parts[source + 2]) : NaN;
      // 日本の範囲外・数値でない座標は、座標系や並び順が想定と違う印。推測で直さない。
      if (!(latitude >= 20 && latitude <= 46) || !(longitude >= 122 && longitude <= 154)) return null;
      if (dimension === 3 && !Number.isFinite(height)) return null;
      ring[target] = latitude;
      ring[target + 1] = longitude;
      ring[target + 2] = dimension === 3 ? height : null;
    }
    return ring;
  }

  function closePolygon() {
    const current = polygon;
    polygon = null;
    if (!building || !lod || !current) return;
    stats.polygons += 1;
    if (current.bad || current.rings.length === 0 || current.rings[0].length < 9) {
      stats.badCoordinatePolygons += 1;
      building.bad += 1;
      return;
    }
    building.polygons.push({
      lod: lod.lod, prop: lod.prop, surface: surface?.type ?? null,
      installation: installationDepth >= 0, rings: current.rings,
    });
  }

  function finishBuilding() {
    const current = building;
    building = null;
    stats.buildings += 1;
    if (current.polygons.length === 0) {
      stats.withoutGeometry += 1;
      return;
    }
    let south = Infinity; let west = Infinity; let north = -Infinity; let east = -Infinity;
    const byLod = new Map();
    for (const item of current.polygons) {
      for (const ring of item.rings) {
        for (let index = 0; index < ring.length; index += 3) {
          if (ring[index] < south) south = ring[index];
          if (ring[index] > north) north = ring[index];
          if (ring[index + 1] < west) west = ring[index + 1];
          if (ring[index + 1] > east) east = ring[index + 1];
        }
      }
      if (!byLod.has(item.lod)) byLod.set(item.lod, []);
      byLod.get(item.lod).push(item);
    }
    const record = { id: current.id };
    if (current.measuredHeight !== null) record.mh = current.measuredHeight;
    if (current.partHeights.length > 0) record.pmh = current.partHeights;
    if (current.heightType !== null) record.ht = current.heightType;
    if (current.bad > 0) record.bad = current.bad;
    record.b = [south, west, north, east];
    let highest = 0;
    const levels = {};
    for (const [level, items] of [...byLod.entries()].sort((a, b) => a[0] - b[0])) {
      if (level === 0) {
        const roofEdge = items.filter((item) => /roofedge/iu.test(item.prop));
        const chosen = roofEdge.length > 0 ? roofEdge : items;
        record.l0 = { k: roofEdge.length > 0 ? "re" : "fp", p: chosen.map((item) => item.rings) };
        continue;
      }
      const range = (list) => {
        let low = Infinity; let high = -Infinity;
        for (const item of list) for (const ring of item.rings) for (let index = 2; index < ring.length; index += 3) {
          const value = ring[index];
          if (value === null) continue;
          if (value < low) low = value;
          if (value > high) high = value;
        }
        return Number.isFinite(low) ? [low, high] : null;
      };
      const tops = (list) => {
        const typed = list.some((item) => item.surface !== null);
        if (typed) return list.filter((item) => TOP_SURFACES.has(item.surface));
        // 面の種類が書かれていない立体（LOD1の箱など）: 壁（鉛直な面）と底面を除いた残りが上の面。
        const bounds = range(list);
        return list.filter((item) => {
          if (horizontalShare(item.rings[0]) < VERTICAL_RATIO) return false;
          if (!bounds || bounds[1] - bounds[0] <= 0.01) return true;
          for (let index = 2; index < item.rings[0].length; index += 3) {
            if (item.rings[0][index] > bounds[0] + GROUND_FACE_TOLERANCE_METERS) return true;
          }
          return false;
        });
      };
      const body = items.filter((item) => !item.installation);
      const extras = items.filter((item) => item.installation);
      const entry = {};
      const bodyRange = range(body);
      if (bodyRange) { entry.z = bodyRange; entry.t = tops(body).map((item) => item.rings); }
      const extraRange = range(extras);
      if (extraRange) { entry.zi = extraRange; entry.ti = tops(extras).map((item) => item.rings); }
      if (entry.z || entry.zi) { levels[level] = entry; highest = Math.max(highest, level); }
    }
    if (Object.keys(levels).length > 0) record.l = levels;
    if (!record.l && !record.l0) { stats.withoutGeometry += 1; return; }
    stats.maxLod[highest] = (stats.maxLod[highest] ?? 0) + 1;
    stats.written += 1;
    onBuilding(record);
  }

  function openElement(tag, selfClosing) {
    const nameEnd = tag.search(/[\s/]/u);
    const qualifiedName = nameEnd < 0 ? tag : tag.slice(0, nameEnd);
    if (tag.includes("xmlns")) {
      for (const match of tag.matchAll(/\sxmlns(?::([\w.-]+))?\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
        namespaces.set(match[1] ?? "", match[2] ?? match[3]);
      }
    }
    depth += 1;
    const { kind, local } = resolve(qualifiedName);
    if (kind === "gml" && local === "Envelope") {
      const srsName = attribute(tag, "srsName");
      if (srsName && !stats.srsNames.includes(srsName)) stats.srsNames.push(srsName);
      const dimension = Number(attribute(tag, "srsDimension"));
      if (!building && (dimension === 2 || dimension === 3)) defaultDimension = dimension;
    }
    if (!building) {
      if (kind === "bldg" && local === "Building") {
        building = {
          id: gmlId(tag), measuredHeight: null, partHeights: [],
          heightType: null, polygons: [], bad: 0,
        };
        buildingDepth = depth;
        skipDepth = partDepth = installationDepth = -1;
        lod = surface = polygon = capture = null;
      }
    } else if (skipDepth < 0) {
      if (kind === "bldg") {
        if (SKIPPED_BUILDING_ELEMENTS.has(local)) skipDepth = depth;
        else if (local === "BuildingPart") { if (partDepth < 0) partDepth = depth; }
        else if (local === "BuildingInstallation") { if (installationDepth < 0) installationDepth = depth; }
        else if (SURFACE_ELEMENTS.has(local)) surface = { type: local, depth };
        else if (local === "measuredHeight") capture = { kind: "measuredHeight", depth, text: "" };
        else {
          const match = /^lod([0-4])(\w+)$/u.exec(local);
          if (match && !lod) {
            lod = { lod: Number(match[1]), prop: match[2], depth, polygons: building.polygons.length, hrefs: 0 };
          }
        }
      } else if (kind === "uro" && local === "lod1HeightType") {
        capture = { kind: "heightType", depth, text: "" };
      } else if (kind === "gml" && lod) {
        if (local === "Polygon" || local === "Triangle" || local === "Rectangle") {
          polygon = { rings: [], depth, bad: false, points: null };
        } else if (polygon && (local === "exterior" || local === "outerBoundaryIs")) ringRole = "exterior";
        else if (polygon && (local === "interior" || local === "innerBoundaryIs")) ringRole = "interior";
        else if (polygon && local === "LinearRing") polygon.points = [];
        else if (polygon && (local === "posList" || local === "pos" || local === "coordinates")) {
          const dimension = Number(attribute(tag, "srsDimension"));
          capture = { kind: local, depth, text: "", dimension: dimension === 2 || dimension === 3 ? dimension : defaultDimension };
        } else if (tag.includes("href")) lod.hrefs += 1;
      }
    }
    if (selfClosing) closeElement();
  }

  function closeElement() {
    if (capture && capture.depth === depth) {
      const done = capture;
      capture = null;
      if (done.kind === "measuredHeight") {
        const value = Number(done.text.trim());
        if (Number.isFinite(value)) {
          if (partDepth >= 0) building.partHeights.push(value);
          else if (building.measuredHeight === null) building.measuredHeight = value;
        }
      } else if (done.kind === "heightType") {
        if (building.heightType === null) building.heightType = decodeEntities(done.text.trim());
      } else if (polygon) {
        const ring = parseCoordinates(done.text, done.dimension, done.kind === "coordinates");
        if (ring === null) polygon.bad = true;
        else if (done.kind === "pos") polygon.points?.push(...ring);
        else if (ring.length > 0) polygon.points = ring;
      }
    } else if (polygon && polygon.depth === depth) {
      closePolygon();
    } else if (polygon && polygon.points && depth > polygon.depth) {
      // LinearRing の終わりで、輪を1本確定する。
      // （posList も pos の並びも、ここで points に入っている。）
      if (pendingRingClose) {
        if (polygon.points.length >= 9) {
          if (ringRole === "interior" && polygon.rings.length > 0) polygon.rings.push(polygon.points);
          else if (ringRole === "interior") polygon.bad = true;
          else polygon.rings.unshift(polygon.points);
        } else if (ringRole !== "interior") polygon.bad = true;
        polygon.points = null;
      }
    }
    if (lod && lod.depth === depth) {
      if (building && building.polygons.length === lod.polygons && lod.hrefs > 0) stats.hrefOnlyLods += 1;
      lod = null;
    }
    if (surface && surface.depth === depth) surface = null;
    if (skipDepth === depth) skipDepth = -1;
    if (partDepth === depth) partDepth = -1;
    if (installationDepth === depth) installationDepth = -1;
    if (building && buildingDepth === depth) finishBuilding();
    depth -= 1;
  }

  let pendingRingClose = false;

  function handleClose(qualifiedName) {
    if (polygon && polygon.points) {
      const { kind, local } = resolve(qualifiedName);
      pendingRingClose = kind === "gml" && local === "LinearRing";
    } else pendingRingClose = false;
    closeElement();
    pendingRingClose = false;
  }

  function consume(final) {
    let position = 0;
    const length = pending.length;
    while (position < length) {
      const open = pending.indexOf("<", position);
      if (open < 0) {
        if (capture) capture.text += pending.slice(position);
        position = length;
        break;
      }
      if (capture && open > position) capture.text += pending.slice(position, open);
      position = open;
      if (pending.startsWith("<!--", open)) {
        const end = pending.indexOf("-->", open + 4);
        if (end < 0) break;
        position = end + 3;
        continue;
      }
      if (pending.startsWith("<![CDATA[", open)) {
        const end = pending.indexOf("]]>", open + 9);
        if (end < 0) break;
        if (capture) capture.text += pending.slice(open + 9, end);
        position = end + 3;
        continue;
      }
      if (pending.startsWith("<?", open)) {
        const end = pending.indexOf("?>", open + 2);
        if (end < 0) break;
        if (stats.encoding === null && pending.startsWith("<?xml", open)) {
          stats.encoding = (attribute(pending.slice(open, end), "encoding") ?? "UTF-8").toUpperCase();
        }
        position = end + 2;
        continue;
      }
      if (open + 9 > length && !final && "<![CDATA[".startsWith(pending.slice(open))) break;
      // 属性値の中の「>」に惑わされないよう、引用符を数えながら終わりを探す。
      let end = -1;
      let quote = 0;
      for (let index = open + 1; index < length; index += 1) {
        const code = pending.charCodeAt(index);
        if (quote !== 0) { if (code === quote) quote = 0; }
        else if (code === 34 || code === 39) quote = code;
        else if (code === 62) { end = index; break; }
      }
      if (end < 0) break;
      if (pending.charCodeAt(open + 1) === 47) {
        handleClose(pending.slice(open + 2, end).trim());
      } else if (pending.charCodeAt(open + 1) !== 33) {
        const selfClosing = pending.charCodeAt(end - 1) === 47;
        const tag = pending.slice(open + 1, selfClosing ? end - 1 : end);
        if (selfClosing) {
          const { kind, local } = resolve(tag.slice(0, tag.search(/[\s/]|$/u)));
          pendingRingClose = Boolean(polygon?.points) && kind === "gml" && local === "LinearRing";
        }
        openElement(tag, selfClosing);
        pendingRingClose = false;
      }
      position = end + 1;
    }
    pending = pending.slice(position);
  }

  return {
    write(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      consume(false);
    },
    end() {
      pending += decoder.decode();
      consume(true);
      const incomplete = depth !== 0 || pending.trim() !== "";
      return { ...stats, incomplete };
    },
  };
}

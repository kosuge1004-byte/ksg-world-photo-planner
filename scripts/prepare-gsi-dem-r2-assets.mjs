import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { gzip, inflateRawSync } from "node:zlib";
import {
  LOCAL_DEM_MANIFEST_KEY,
  LOCAL_DEM_NO_DATA_CENTIMETERS,
  encodeLocalDemAsset,
  localDemAssetKey,
  localDemMeshBounds,
} from "../server/gsiLocalDem.ts";

const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_END = 0x06054b50;
const MAX_ZIP_TAIL = 65_557;
const FORMAT = "astrosight-gsi-local-dem-v1";
const INVENTORY_RELATIVE_PATH = path.join("gsi-local-dem-v1", "asset-inventory.jsonl");
const INVENTORY_JOURNAL_RELATIVE_PATH = path.join("gsi-local-dem-v1", "asset-inventory.journal.jsonl");
const VALID_SOURCES = new Set([
  "DEM1A", "DEM5A", "DEM5B", "DEM5C", "DEM10A", "DEM10B",
]);
const XML_DECLARATION_SCAN_BYTES = 512;
const INNER_XML_CONCURRENCY = 8;
const gzipAsync = promisify(gzip);
let journalAppendTail = Promise.resolve();

function appendJournalLine(filePath, line) {
  const operation = journalAppendTail.then(() => fs.appendFile(filePath, line, "utf8"));
  // Keep later appends usable while still propagating this operation's error
  // to its caller. The conversion itself fails if any append fails.
  journalAppendTail = operation.catch(() => undefined);
  return operation;
}

/**
 * Decode only the encodings used by official GSI DEM GML. Newer archives are
 * UTF-8, while older 2010-era DEM5 files explicitly declare Shift_JIS. The
 * declaration itself is ASCII, so the body encoding never has to be guessed.
 */
export function decodeGsiDemXml(input, origin = "GML") {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const prefixBytes = bytes.subarray(0, Math.min(bytes.length, XML_DECLARATION_SCAN_BYTES));
  let prefix = "";
  for (const byte of prefixBytes) prefix += byte <= 0x7f ? String.fromCharCode(byte) : "?";
  const declared = /<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(prefix)?.[1] ?? "UTF-8";
  const normalized = declared.trim().toLowerCase().replaceAll("_", "-");
  const decoderLabel = normalized === "utf-8" || normalized === "utf8"
    ? "utf-8"
    : normalized === "shift-jis" || normalized === "shiftjis" ||
        normalized === "sjis" || normalized === "windows-31j" || normalized === "cp932"
      ? "shift_jis"
      : null;
  if (!decoderLabel) {
    throw new Error(`GMLの宣言文字コードに対応していません（${declared}）: ${origin}`);
  }
  try {
    return {
      xml: new TextDecoder(decoderLabel, { fatal: true }).decode(bytes),
      encoding: decoderLabel === "utf-8" ? "UTF-8" : "Shift_JIS",
    };
  } catch (error) {
    throw new Error(`GMLが宣言文字コード ${declared} の正しいデータではありません: ${origin}`, { cause: error });
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-gsi-dem-r2-assets.mjs --input <zip|xml|dir> [--input ...] --output <dir>",
    "",
    "Output mirrors the R2 object keys below <dir>. Uploading is intentionally a separate step.",
    `Manifest object: ${LOCAL_DEM_MANIFEST_KEY}`,
    "Options: --replace --compression-level <1..9> --source <DEM1A|DEM5A|DEM5B|DEM5C|DEM10A|DEM10B>",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { inputs: [], output: "dem/r2-local", replace: false, level: 6, source: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") {
      const input = argv[++index];
      if (!input) throw new Error("--input にパスが必要です");
      options.inputs.push(input);
    } else if (value === "--output") {
      const output = argv[++index];
      if (!output) throw new Error("--output にパスが必要です");
      options.output = output;
    } else if (value === "--replace") {
      options.replace = true;
    } else if (value === "--compression-level") {
      options.level = Number(argv[++index]);
      if (!Number.isInteger(options.level) || options.level < 1 || options.level > 9) {
        throw new Error("--compression-level は1～9で指定してください");
      }
    } else if (value === "--source") {
      options.source = String(argv[++index] ?? "").toUpperCase();
      if (!VALID_SOURCES.has(options.source)) {
        throw new Error("--source のDEM種別が不正です");
      }
    } else if (value === "--help" || value === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (value.startsWith("-")) {
      throw new Error(`未対応のオプションです: ${value}`);
    } else {
      options.inputs.push(value);
    }
  }
  if (options.inputs.length === 0) throw new Error(`入力がありません\n${usage()}`);
  return options;
}

function findEndOfCentralDirectory(bytes) {
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP_END) return offset;
  }
  throw new Error("ZIP中央ディレクトリ終端が見つかりません");
}

function centralDirectoryInfo(tail, fileSize, tailStart) {
  const endOffset = findEndOfCentralDirectory(tail);
  const entryCount = tail.readUInt16LE(endOffset + 10);
  const centralSize = tail.readUInt32LE(endOffset + 12);
  const centralOffset = tail.readUInt32LE(endOffset + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64中央ディレクトリには未対応です（ファイルをメッシュ別ZIPで処理してください）");
  }
  if (centralOffset + centralSize > fileSize) {
    throw new Error("ZIP中央ディレクトリの位置が不正です");
  }
  // Small ZIPs may already have the complete central directory in the tail.
  const inTailOffset = centralOffset - tailStart;
  return { entryCount, centralSize, centralOffset, inTailOffset };
}

function parseCentralDirectory(bytes, expectedEntries) {
  const entries = [];
  let offset = 0;
  while (offset + 46 <= bytes.length && entries.length < expectedEntries) {
    if (bytes.readUInt32LE(offset) !== ZIP_CENTRAL_FILE) {
      throw new Error(`ZIP中央ディレクトリが不正です（offset=${offset}）`);
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const expectedCrc32 = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64エントリには未対応です（メッシュ別ZIPを使用してください）");
    }
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString((flags & 0x0800) !== 0 ? "utf8" : "latin1");
    if ((flags & 0x0001) !== 0) throw new Error(`暗号化ZIPには未対応です: ${name}`);
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset, expectedCrc32 });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (entries.length !== expectedEntries) {
    throw new Error(`ZIPエントリ数が一致しません（expected=${expectedEntries}, actual=${entries.length}）`);
  }
  return entries;
}

async function zipEntriesFromFile(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const tailLength = Math.min(stat.size, MAX_ZIP_TAIL);
    const tailStart = stat.size - tailLength;
    const tail = Buffer.allocUnsafe(tailLength);
    await handle.read(tail, 0, tailLength, tailStart);
    const info = centralDirectoryInfo(tail, stat.size, tailStart);
    let central;
    if (info.inTailOffset >= 0 && info.inTailOffset + info.centralSize <= tail.length) {
      central = tail.subarray(info.inTailOffset, info.inTailOffset + info.centralSize);
    } else {
      central = Buffer.allocUnsafe(info.centralSize);
      await handle.read(central, 0, info.centralSize, info.centralOffset);
    }
    return { handle, entries: parseCentralDirectory(central, info.entryCount) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function zipEntriesFromBuffer(bytes) {
  const tailStart = Math.max(0, bytes.length - MAX_ZIP_TAIL);
  const tail = bytes.subarray(tailStart);
  const info = centralDirectoryInfo(tail, bytes.length, tailStart);
  const central = bytes.subarray(info.centralOffset, info.centralOffset + info.centralSize);
  return parseCentralDirectory(central, info.entryCount);
}

function decompressZipPayload(payload, entry) {
  const output = entry.method === 0
    ? payload
    : entry.method === 8
      ? inflateRawSync(payload)
      : null;
  if (!output) throw new Error(`ZIP圧縮方式${entry.method}は未対応です: ${entry.name}`);
  if (crc32(output) !== entry.expectedCrc32) {
    throw new Error(`ZIP CRC32が一致しません: ${entry.name}`);
  }
  return output;
}

async function readFileZipEntry(handle, entry) {
  const local = Buffer.allocUnsafe(30);
  await handle.read(local, 0, local.length, entry.localOffset);
  if (local.readUInt32LE(0) !== ZIP_LOCAL_FILE) {
    throw new Error(`ZIPローカルヘッダーが不正です: ${entry.name}`);
  }
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  const payload = Buffer.allocUnsafe(entry.compressedSize);
  await handle.read(payload, 0, payload.length, entry.localOffset + 30 + nameLength + extraLength);
  const output = decompressZipPayload(payload, entry);
  if (output.length !== entry.uncompressedSize) {
    throw new Error(`ZIP展開サイズが一致しません: ${entry.name}`);
  }
  return output;
}

function readBufferZipEntry(container, entry) {
  const offset = entry.localOffset;
  if (container.readUInt32LE(offset) !== ZIP_LOCAL_FILE) {
    throw new Error(`内包ZIPローカルヘッダーが不正です: ${entry.name}`);
  }
  const nameLength = container.readUInt16LE(offset + 26);
  const extraLength = container.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const payload = container.subarray(start, start + entry.compressedSize);
  const output = decompressZipPayload(payload, entry);
  if (output.length !== entry.uncompressedSize) {
    throw new Error(`内包ZIP展開サイズが一致しません: ${entry.name}`);
  }
  return output;
}

function tagText(xml, localName) {
  const match = new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${localName}(?:\\s[^>]*)?>([^<]+)</`, "i").exec(xml);
  if (!match) throw new Error(`<${localName}> が見つかりません`);
  return match[1].trim();
}

function pair(text, label) {
  const values = text.trim().split(/\s+/).map(Number);
  if (values.length !== 2 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} が2要素の数値ではありません`);
  }
  return values;
}

function sourceFromNames(...names) {
  for (const name of names) {
    const match = /\b(DEM(?:1A|5A|5B|5C|10A|10B))\b/i.exec(name);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

/** 実ファイルのGML 3.2を、損失のないcm整数グリッドへ変換する。 */
export function parseGsiDemGml(xml, nameHint = "", sourceOverride = null) {
  const source = sourceOverride ?? sourceFromNames(nameHint, xml.slice(0, 2_000));
  if (!source || !VALID_SOURCES.has(source)) {
    throw new Error(`DEM種別をファイル名から判定できません: ${nameHint}`);
  }
  const meshCode = tagText(xml, "mesh");
  const [south, west] = pair(tagText(xml, "lowerCorner"), "lowerCorner");
  const [north, east] = pair(tagText(xml, "upperCorner"), "upperCorner");
  const [lowX, lowY] = pair(tagText(xml, "low"), "GridEnvelope low");
  const [highX, highY] = pair(tagText(xml, "high"), "GridEnvelope high");
  const [startX, startY] = pair(tagText(xml, "startPoint"), "startPoint");
  if (![lowX, lowY, highX, highY, startX, startY].every(Number.isInteger)) {
    throw new Error("GMLグリッドのインデックスが整数ではありません");
  }
  const width = highX - lowX + 1;
  const height = highY - lowY + 1;
  if (width <= 1 || height <= 1 || width * height > 2_000_000) {
    throw new Error(`GMLグリッド寸法が不正です: ${width}x${height}`);
  }
  if (startX < lowX || startX > highX || startY < lowY || startY > highY) {
    throw new Error("GML startPoint がグリッド範囲外です");
  }
  const expectedMeshLength = source === "DEM10A" || source === "DEM10B" ? 6 : 8;
  const meshBounds = localDemMeshBounds(meshCode);
  if (!meshBounds || meshCode.length !== expectedMeshLength) {
    throw new Error(`メッシュコード ${meshCode} が ${source} と一致しません`);
  }
  const boundTolerance = 2e-9;
  if (
    Math.abs(south - meshBounds.south) > boundTolerance ||
    Math.abs(west - meshBounds.west) > boundTolerance ||
    Math.abs(north - meshBounds.north) > boundTolerance ||
    Math.abs(east - meshBounds.east) > boundTolerance
  ) {
    throw new Error(`GML bbox がメッシュ ${meshCode} の範囲と一致しません`);
  }
  const sequence = /<(?:(?:[A-Za-z0-9_-]+):)?sequenceRule\b[^>]*\border=["']\+x-y["'][^>]*>\s*Linear\s*</i.test(xml);
  if (!sequence) throw new Error("GMLの走査順が +x-y Linear ではありません");
  const tupleMatch = /<(?:(?:[A-Za-z0-9_-]+):)?tupleList(?:\s[^>]*)?>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?tupleList>/i.exec(xml);
  if (!tupleMatch) throw new Error("gml:tupleList が見つかりません");

  const heightsCentimeters = new Int32Array(width * height);
  heightsCentimeters.fill(LOCAL_DEM_NO_DATA_CENTIMETERS);
  let x = startX;
  let y = startY;
  let tupleCount = 0;
  const tupleLines = tupleMatch[1].split(/\r\n|\n|\r/);
  const tuplePattern = /^([^,]+),\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)$/;
  for (let lineIndex = 0; lineIndex < tupleLines.length; lineIndex += 1) {
    const line = tupleLines[lineIndex].trim();
    if (!line) continue;
    const match = tuplePattern.exec(line);
    if (!match || !match[1].trim()) {
      throw new Error(`tupleList に不正な行があります（line=${lineIndex + 1}, tuple=${tupleCount}）`);
    }
    if (x < lowX || x > highX || y < lowY || y > highY) {
      throw new Error(`tupleList がグリッド範囲を超えました（tuple=${tupleCount}）`);
    }
    const value = Number(match[2]);
    if (!Number.isFinite(value)) throw new Error(`標高値が不正です（tuple=${tupleCount}）`);
    const centimeters = Math.round(value * 100);
    if (
      Math.abs(value + 9_999) >= 1e-6 &&
      (!Number.isSafeInteger(centimeters) || centimeters <= -2_147_483_648 || centimeters > 2_147_483_647)
    ) {
      throw new Error(`標高値がint32 cm範囲外です（tuple=${tupleCount}）`);
    }
    heightsCentimeters[(y - lowY) * width + (x - lowX)] =
      Math.abs(value + 9_999) < 1e-6 ? LOCAL_DEM_NO_DATA_CENTIMETERS : centimeters;
    tupleCount += 1;
    x += 1;
    if (x > highX) {
      x = lowX;
      y += 1;
    }
  }
  if (tupleCount === 0) throw new Error("tupleList に標高値がありません");
  const expectedRemaining = width * height - ((startY - lowY) * width + (startX - lowX));
  if (tupleCount > expectedRemaining) {
    throw new Error(`tupleList点数がグリッド範囲を超えました（capacity=${expectedRemaining}, actual=${tupleCount}）`);
  }

  // GSI GML omits leading and trailing cells outside a dataset's actual
  // coverage. startPoint identifies the first serialized cell; tupleList may
  // therefore end before GridEnvelope.high (for example sparse DEM10A volcano
  // coverage). Those omitted cells are NoData. Every non-empty serialized line
  // is parsed strictly above, so malformed/truncated tuples cannot be silently
  // mistaken for this valid sparse representation.

  return {
    source,
    meshCode,
    tupleCount,
    omittedPrefixCount: (startY - lowY) * width + (startX - lowX),
    omittedSuffixCount: expectedRemaining - tupleCount,
    asset: {
      width,
      height,
      south,
      west,
      north,
      east,
      latitudeStep: (north - south) / height,
      longitudeStep: (east - west) / width,
      heightsCentimeters,
    },
  };
}

async function atomicWrite(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, filePath);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeGmlAsset(xmlBytes, nameHint, origin, options, inventory) {
  const decoded = decodeGsiDemXml(xmlBytes, origin);
  const parsed = parseGsiDemGml(
    decoded.xml,
    nameHint,
    options.source
  );
  const raw = Buffer.from(encodeLocalDemAsset(parsed.asset));
  const objectKey = localDemAssetKey(parsed.source, parsed.meshCode);
  const outputPath = path.join(options.output, ...objectKey.split("/"));
  const rawDigest = sha256(raw);
  const previousInventory = inventory.get(objectKey);
  if (
    !options.replace &&
    previousInventory?.rawSha256 &&
    previousInventory.rawSha256 !== rawDigest
  ) {
    throw new Error(`同じR2キーに内容の異なるDEMがあります: ${objectKey}`);
  }

  let action = "written";
  let compressed = null;
  let digest = null;
  if (!options.replace && previousInventory?.rawSha256 === rawDigest) {
    try {
      const existing = await fs.readFile(outputPath);
      if (
        existing.length === previousInventory.gzipBytes &&
        sha256(existing) === previousInventory.sha256
      ) {
        compressed = existing;
        digest = previousInventory.sha256;
        action = "unchanged";
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!compressed) {
    // mtime=0 makes resumed conversions byte-for-byte reproducible.
    // Async zlib uses the bounded libuv worker pool. Official DEM5 inner ZIPs
    // contain many independent XML grids, so this avoids leaving all CPU cores
    // idle while preserving deterministic gzip output (mtime=0).
    compressed = await gzipAsync(raw, { level: options.level, mtime: 0 });
    digest = sha256(compressed);
    try {
      const existing = await fs.readFile(outputPath);
      if (!options.replace) {
        if (sha256(existing) !== digest) {
          throw new Error(`同じR2キーに内容の異なるDEMがあります: ${objectKey}`);
        }
        action = "unchanged";
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (action === "written") await atomicWrite(outputPath, compressed);
  }
  const inventoryEntry = {
    objectKey,
    source: parsed.source,
    meshCode: parsed.meshCode,
    width: parsed.asset.width,
    height: parsed.asset.height,
    tupleCount: parsed.tupleCount,
    implicitNoDataCells: parsed.omittedPrefixCount + parsed.omittedSuffixCount,
    encoding: decoded.encoding,
    rawBytes: raw.length,
    gzipBytes: compressed.length,
    sha256: digest,
    rawSha256: rawDigest,
    origin,
  };
  inventory.set(objectKey, inventoryEntry);
  if (action === "written" || !previousInventory) {
    const journalPath = path.join(options.output, INVENTORY_JOURNAL_RELATIVE_PATH);
    await fs.mkdir(path.dirname(journalPath), { recursive: true });
    await appendJournalLine(journalPath, `${JSON.stringify(inventoryEntry)}\n`);
  }
  const sparseNote = inventoryEntry.implicitNoDataCells > 0
    ? `, implicit NoData=${inventoryEntry.implicitNoDataCells.toLocaleString()}`
    : "";
  console.log(`${action}: ${objectKey} (${compressed.length.toLocaleString()} bytes${sparseNote})`);
}

async function processInnerZip(bytes, contextName, origin, options, inventory) {
  const entries = zipEntriesFromBuffer(bytes).filter(
    (entry) => !entry.name.endsWith("/") && entry.name.toLowerCase().endsWith(".xml")
  );
  let cursor = 0;
  const workerCount = Math.min(INNER_XML_CONCURRENCY, entries.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) return;
      const entry = entries[index];
      const xml = readBufferZipEntry(bytes, entry);
      await writeGmlAsset(xml, `${entry.name} ${contextName}`, `${origin}!${entry.name}`, options, inventory);
    }
  }));
}

async function processZip(filePath, options, inventory) {
  const { handle, entries } = await zipEntriesFromFile(filePath);
  try {
    for (const entry of entries) {
      if (entry.name.endsWith("/")) continue;
      const lower = entry.name.toLowerCase();
      if (!lower.endsWith(".zip") && !lower.endsWith(".xml")) continue;
      const payload = await readFileZipEntry(handle, entry);
      if (lower.endsWith(".zip")) {
        await processInnerZip(payload, `${entry.name} ${path.basename(filePath)}`, `${filePath}!${entry.name}`, options, inventory);
      } else {
        await writeGmlAsset(payload, `${entry.name} ${path.basename(filePath)}`, `${filePath}!${entry.name}`, options, inventory);
      }
    }
  } finally {
    await handle.close();
  }
}

async function collectInputs(inputPath) {
  const stat = await fs.stat(inputPath);
  if (stat.isFile()) return [inputPath];
  if (!stat.isDirectory()) return [];
  const files = [];
  const queue = [inputPath];
  while (queue.length > 0) {
    const directory = queue.shift();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(child);
      else if (/\.(?:zip|xml)$/i.test(entry.name)) files.push(child);
    }
  }
  return files.sort();
}

async function writeManifest(options, inventory) {
  const assets = [...inventory.values()].sort((left, right) => left.objectKey.localeCompare(right.objectKey));
  const sources = {};
  let gzipBytes = 0;
  let rawBytes = 0;
  for (const asset of assets) {
    sources[asset.source] ??= { assetCount: 0, gzipBytes: 0, rawBytes: 0 };
    sources[asset.source].assetCount += 1;
    sources[asset.source].gzipBytes += asset.gzipBytes;
    sources[asset.source].rawBytes += asset.rawBytes;
    gzipBytes += asset.gzipBytes;
    rawBytes += asset.rawBytes;
  }
  const manifest = {
    schemaVersion: 1,
    format: FORMAT,
    generatedAt: new Date().toISOString(),
    assetPrefix: "gsi-local-dem-v1/",
    heightEncoding: "signed int32 centimetres; -2147483648 is NoData",
    coordinateOrder: "latitude longitude; +x-y (west to east, north to south)",
    assetCount: assets.length,
    gzipBytes,
    rawBytes,
    sources,
  };
  const manifestPath = path.join(options.output, ...LOCAL_DEM_MANIFEST_KEY.split("/"));
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const inventoryPath = path.join(options.output, INVENTORY_RELATIVE_PATH);
  await atomicWrite(inventoryPath, `${assets.map((asset) => JSON.stringify(asset)).join("\n")}\n`);
  await fs.rm(path.join(options.output, INVENTORY_JOURNAL_RELATIVE_PATH), { force: true });
  console.log(`manifest: ${manifestPath}`);
  console.log(`assets=${assets.length}, gzip=${gzipBytes.toLocaleString()} bytes, raw=${rawBytes.toLocaleString()} bytes`);
}

async function loadExistingInventory(outputRoot) {
  const inventory = new Map();
  const paths = [
    path.join(outputRoot, INVENTORY_RELATIVE_PATH),
    path.join(outputRoot, INVENTORY_JOURNAL_RELATIVE_PATH),
  ];
  for (const inventoryPath of paths) {
    try {
      const text = await fs.readFile(inventoryPath, "utf8");
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (typeof entry.objectKey === "string") inventory.set(entry.objectKey, entry);
        } catch (error) {
          // appendFile can leave only the final journal record partial after an
          // abrupt stop. Earlier malformed records indicate real corruption.
          if (inventoryPath.endsWith(INVENTORY_JOURNAL_RELATIVE_PATH) && index === lines.length - 1) {
            break;
          }
          throw error;
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return inventory;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  options.output = path.resolve(options.output);
  const inventory = await loadExistingInventory(options.output);
  const files = [];
  for (const input of options.inputs) files.push(...await collectInputs(path.resolve(input)));
  for (const filePath of [...new Set(files)]) {
    console.log(`input: ${filePath}`);
    if (filePath.toLowerCase().endsWith(".xml")) {
      await writeGmlAsset(await fs.readFile(filePath), path.basename(filePath), filePath, options, inventory);
    } else {
      await processZip(filePath, options, inventory);
    }
  }
  await writeManifest(options, inventory);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}

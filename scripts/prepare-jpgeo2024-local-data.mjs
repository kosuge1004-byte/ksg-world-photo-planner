import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const SOURCE_ROWS = 2101;
const SOURCE_COLUMNS = 1601;
const SOURCE_LATITUDE_MAX = 50;
const SOURCE_LONGITUDE_MIN = 120;
const LATITUDE_STEP = 1 / 60;
const LONGITUDE_STEP = 1.5 / 60;

// AstroSight has always limited GSI geoid queries to this Japan-and-islands
// rectangle. Keeping precisely that rectangle avoids shipping unused ocean and
// foreign-area cells while retaining every coordinate accepted by the app.
const LATITUDE_MIN = 20;
const LATITUDE_MAX = 46.5;
const LONGITUDE_MIN = 122;
const LONGITUDE_MAX = 154;
const TILE_SIZE = 64;
const VALUE_SCALE = 10_000;
const ENTRY_NAME = "JPGEO2024.isg";

const archivePath = path.resolve(process.argv[2] ?? "geoid/JPGEO2024_isg.zip");
const outputPath = path.resolve(process.argv[3] ?? "server/data/jpgeo2024.generated.ts");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function findEndOfCentralDirectory(bytes) {
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP central directory was not found");
}

/** Extract one stored/deflated entry without adding a build-time ZIP package. */
function extractZipEntry(archive, wantedName) {
  const eocd = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central-directory record at ${offset}`);
    }
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    if (name === wantedName) {
      if (archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`Invalid ZIP local header for ${wantedName}`);
      }
      const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(dataStart, dataStart + compressedSize);
      const extracted = compressionMethod === 0
        ? Buffer.from(compressed)
        : compressionMethod === 8
          ? inflateRawSync(compressed)
          : null;
      if (!extracted) throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
      if (extracted.length !== uncompressedSize) {
        throw new Error(`Unexpected ${wantedName} size: ${extracted.length} != ${uncompressedSize}`);
      }
      return extracted;
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${wantedName} was not found in ${archivePath}`);
}

function headerInteger(header, key) {
  const match = header.match(new RegExp(`^${key}\\s*=\\s*(\\d+)\\s*$`, "mu"));
  if (!match) throw new Error(`Missing ISG header field: ${key}`);
  return Number(match[1]);
}

function requireHeaderLine(header, expression, description) {
  if (!expression.test(header)) {
    throw new Error(`Unexpected JPGEO2024 ${description}`);
  }
}

function exactGridIndex(value, description) {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) > 1e-10) {
    throw new Error(`${description} is not aligned to the JPGEO2024 source grid`);
  }
  return rounded;
}

function writeInt16(bytes, value) {
  if (!Number.isInteger(value) || value < -32_768 || value > 32_767) {
    throw new Error(`Difference ${value} cannot be represented exactly as int16`);
  }
  bytes.push(value & 0xff, (value >> 8) & 0xff);
}

function writeInt32(bytes, value) {
  bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
}

function encodeTile(values, gridRows, gridColumns, tileRow, tileColumn) {
  const rowStart = tileRow * TILE_SIZE;
  const columnStart = tileColumn * TILE_SIZE;
  const height = Math.min(TILE_SIZE, gridRows - rowStart);
  const width = Math.min(TILE_SIZE, gridColumns - columnStart);
  const baseIndex = rowStart * gridColumns + columnStart;
  const bytes = [];

  // One absolute value and exact int16 differences for the north/west edges.
  // Interior cells use a 2-D predictor. 97% of residuals fit one signed byte;
  // 0x80 is an escape followed by an exact little-endian int16 residual.
  writeInt32(bytes, values[baseIndex]);
  for (let column = 1; column < width; column += 1) {
    writeInt16(bytes, values[baseIndex + column] - values[baseIndex + column - 1]);
  }
  for (let row = 1; row < height; row += 1) {
    writeInt16(
      bytes,
      values[baseIndex + row * gridColumns] - values[baseIndex + (row - 1) * gridColumns],
    );
  }
  for (let row = 1; row < height; row += 1) {
    for (let column = 1; column < width; column += 1) {
      const cell = baseIndex + row * gridColumns + column;
      const residual = values[cell] - values[cell - 1] - values[cell - gridColumns] + values[cell - gridColumns - 1];
      if (residual >= -127 && residual <= 127) bytes.push(residual & 0xff);
      else {
        bytes.push(0x80);
        writeInt16(bytes, residual);
      }
    }
  }

  return Buffer.from(bytes).toString("base64");
}

const archive = fs.readFileSync(archivePath);
const source = extractZipEntry(archive, ENTRY_NAME);
const headerEndMarker = Buffer.from("end_of_head", "ascii");
const markerOffset = source.indexOf(headerEndMarker);
if (markerOffset < 0) throw new Error("JPGEO2024 ISG header terminator was not found");
const bodyOffset = source.indexOf(0x0a, markerOffset) + 1;
if (bodyOffset <= 0) throw new Error("JPGEO2024 ISG data section was not found");
const header = source.subarray(0, bodyOffset).toString("utf8");
if (!/^model name\s*:\s*JPGEO2024\s*$/mu.test(header)) {
  throw new Error("The ISG entry is not the JPGEO2024 geoid model");
}
if (!/^data ordering\s*:\s*N-to-S, W-to-E\s*$/mu.test(header)) {
  throw new Error("Unsupported JPGEO2024 grid ordering");
}
// Dimensions alone are insufficient to identify a grid. Check every source
// axis and unit used by the crop/interpolation math so a changed or wrong ISG
// file cannot silently produce spatially shifted values.
requireHeaderLine(header, /^data type\s*:\s*geoid\s*$/mu, "data type");
requireHeaderLine(header, /^data units\s*:\s*meters\s*$/mu, "data units");
requireHeaderLine(header, /^coord type\s*:\s*geodetic\s*$/mu, "coordinate type");
requireHeaderLine(header, /^coord units\s*:\s*dms\s*$/mu, "coordinate units");
requireHeaderLine(header, /^lat min\s*=\s*15°00'00"\s*$/mu, "minimum latitude");
requireHeaderLine(header, /^lat max\s*=\s*50°00'00"\s*$/mu, "maximum latitude");
requireHeaderLine(header, /^lon min\s*=\s*120°00'00"\s*$/mu, "minimum longitude");
requireHeaderLine(header, /^lon max\s*=\s*160°00'00"\s*$/mu, "maximum longitude");
requireHeaderLine(header, /^delta lat\s*=\s*0°01'00"\s*$/mu, "latitude interval");
requireHeaderLine(header, /^delta lon\s*=\s*0°01'30"\s*$/mu, "longitude interval");
requireHeaderLine(header, /^nodata\s*=\s*-9999\.0000\s*$/mu, "NoData marker");
requireHeaderLine(header, /^ISG format\s*=\s*2\.0\s*$/mu, "ISG format version");
if (headerInteger(header, "nrows") !== SOURCE_ROWS || headerInteger(header, "ncols") !== SOURCE_COLUMNS) {
  throw new Error("Unexpected JPGEO2024 source dimensions");
}

const firstSourceRow = exactGridIndex(
  (SOURCE_LATITUDE_MAX - LATITUDE_MAX) / LATITUDE_STEP,
  "Crop maximum latitude",
);
const lastSourceRow = exactGridIndex(
  (SOURCE_LATITUDE_MAX - LATITUDE_MIN) / LATITUDE_STEP,
  "Crop minimum latitude",
);
const firstSourceColumn = exactGridIndex(
  (LONGITUDE_MIN - SOURCE_LONGITUDE_MIN) / LONGITUDE_STEP,
  "Crop minimum longitude",
);
const lastSourceColumn = exactGridIndex(
  (LONGITUDE_MAX - SOURCE_LONGITUDE_MIN) / LONGITUDE_STEP,
  "Crop maximum longitude",
);
const gridRows = lastSourceRow - firstSourceRow + 1;
const gridColumns = lastSourceColumn - firstSourceColumn + 1;
const values = new Int32Array(gridRows * gridColumns);

const body = source.subarray(bodyOffset).toString("ascii");
const numberPattern = /-?\d+\.\d+/gu;
let sourceValueIndex = 0;
let storedValueIndex = 0;
let match;
while ((match = numberPattern.exec(body)) !== null) {
  const sourceRow = Math.floor(sourceValueIndex / SOURCE_COLUMNS);
  const sourceColumn = sourceValueIndex - sourceRow * SOURCE_COLUMNS;
  if (
    sourceRow >= firstSourceRow && sourceRow <= lastSourceRow &&
    sourceColumn >= firstSourceColumn && sourceColumn <= lastSourceColumn
  ) {
    const value = Number(match[0]);
    if (!Number.isFinite(value) || value === -9999) {
      throw new Error(`JPGEO2024 contains NoData inside the AstroSight coverage at source cell ${sourceRow},${sourceColumn}`);
    }
    const scaledValue = value * VALUE_SCALE;
    const integerValue = Math.round(scaledValue);
    if (Math.abs(scaledValue - integerValue) > 1e-6) {
      throw new Error(`JPGEO2024 value cannot be preserved at source cell ${sourceRow},${sourceColumn}`);
    }
    values[storedValueIndex] = integerValue;
    storedValueIndex += 1;
  }
  sourceValueIndex += 1;
}
if (sourceValueIndex !== SOURCE_ROWS * SOURCE_COLUMNS) {
  throw new Error(`Unexpected JPGEO2024 value count: ${sourceValueIndex}`);
}
if (storedValueIndex !== values.length) {
  throw new Error(`Unexpected cropped JPGEO2024 value count: ${storedValueIndex}`);
}

const tileRows = Math.ceil(gridRows / TILE_SIZE);
const tileColumns = Math.ceil(gridColumns / TILE_SIZE);
const tiles = [];
for (let tileRow = 0; tileRow < tileRows; tileRow += 1) {
  for (let tileColumn = 0; tileColumn < tileColumns; tileColumn += 1) {
    tiles.push(encodeTile(values, gridRows, gridColumns, tileRow, tileColumn));
  }
}

const output = `// Generated by scripts/prepare-jpgeo2024-local-data.mjs. Do not edit by hand.\n` +
  `// Source: GSI JPGEO2024.isg (ISG 2.0, N-to-S / W-to-E, metres).\n` +
  `// The lossless integer scale preserves every source value to its published 0.1 mm.\n` +
  `export const JPGEO2024_SOURCE_ARCHIVE_SHA256 = ${JSON.stringify(sha256(archive))};\n` +
  `export const JPGEO2024_SOURCE_ENTRY_SHA256 = ${JSON.stringify(sha256(source))};\n` +
  `export const JPGEO2024_LATITUDE_MIN = ${LATITUDE_MIN};\n` +
  `export const JPGEO2024_LATITUDE_MAX = ${LATITUDE_MAX};\n` +
  `export const JPGEO2024_LONGITUDE_MIN = ${LONGITUDE_MIN};\n` +
  `export const JPGEO2024_LONGITUDE_MAX = ${LONGITUDE_MAX};\n` +
  `export const JPGEO2024_LATITUDE_STEP = ${JSON.stringify(LATITUDE_STEP)};\n` +
  `export const JPGEO2024_LONGITUDE_STEP = ${JSON.stringify(LONGITUDE_STEP)};\n` +
  `export const JPGEO2024_ROWS = ${gridRows};\n` +
  `export const JPGEO2024_COLUMNS = ${gridColumns};\n` +
  `export const JPGEO2024_TILE_SIZE = ${TILE_SIZE};\n` +
  `export const JPGEO2024_TILE_ROWS = ${tileRows};\n` +
  `export const JPGEO2024_TILE_COLUMNS = ${tileColumns};\n` +
  `export const JPGEO2024_VALUE_SCALE = ${VALUE_SCALE};\n` +
  `export const JPGEO2024_TILE_BASE64: readonly string[] = [\n` +
  tiles.map((tile) => `  ${JSON.stringify(tile)},`).join("\n") +
  `\n];\n`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output);
console.log(JSON.stringify({
  source: archivePath,
  output: outputPath,
  sourceArchiveSha256: sha256(archive),
  sourceEntrySha256: sha256(source),
  rows: gridRows,
  columns: gridColumns,
  points: values.length,
  tileRows,
  tileColumns,
  tiles: tiles.length,
  generatedBytes: Buffer.byteLength(output),
}, null, 2));

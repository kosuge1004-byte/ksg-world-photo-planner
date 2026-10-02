import fs from "node:fs/promises";
import path from "node:path";

const API_URL = "https://service.gsi.go.jp/kiban/app/api/dem/latest";
const TYPE_CODES = ["DEM1A", "DEM5A", "DEM5B", "DEM5C", "DEM10A", "DEM10B"];
const DEFAULT_RADII_METERS = [0, 3_000, 10_000, 50_000];
const EARTH_METERS_PER_DEGREE = 111_320;
const BATCH_SIZE = 50;

function parseArguments(argv) {
  const output = {
    radii: DEFAULT_RADII_METERS,
    fetchMetadata: true,
    names: null,
    outputPrefix: "gsi-landmark-dem",
  };
  for (const argument of argv) {
    if (argument === "--no-fetch") output.fetchMetadata = false;
    else if (argument.startsWith("--radii=")) {
      output.radii = argument.slice("--radii=".length).split(",")
        .map(Number)
        .filter((value) => Number.isFinite(value) && value >= 0);
    } else if (argument.startsWith("--names=")) {
      output.names = argument.slice("--names=".length).split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (argument.startsWith("--output-prefix=")) {
      const prefix = argument.slice("--output-prefix=".length).trim();
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(prefix)) {
        throw new Error("output prefix is invalid");
      }
      output.outputPrefix = prefix;
    }
  }
  if (output.radii.length === 0) throw new Error("At least one non-negative radius is required");
  return output;
}

function readLandmarks(source) {
  const rowPattern = /\{\s*name:\s*"([^"]+)",\s*category:\s*"([^"]+)",\s*latitude:\s*(-?\d+(?:\.\d+)?),\s*longitude:\s*(-?\d+(?:\.\d+)?)/g;
  return [...source.matchAll(rowPattern)].map((match) => ({
    name: match[1],
    category: match[2],
    latitude: Number(match[3]),
    longitude: Number(match[4]),
  }));
}

function floorDiv(value, divisor) {
  return Math.floor(value / divisor);
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function secondMeshCodeFromIndexes(latitudeIndex, longitudeIndex) {
  const firstLatitude = floorDiv(latitudeIndex, 8);
  const firstLongitude = floorDiv(longitudeIndex, 8);
  const secondLatitude = positiveModulo(latitudeIndex, 8);
  const secondLongitude = positiveModulo(longitudeIndex, 8);
  return `${String(firstLatitude).padStart(2, "0")}${String(firstLongitude).padStart(2, "0")}${secondLatitude}${secondLongitude}`;
}

function meshBounds(latitudeIndex, longitudeIndex) {
  return {
    south: latitudeIndex / 12,
    north: (latitudeIndex + 1) / 12,
    west: 100 + longitudeIndex / 8,
    east: 100 + (longitudeIndex + 1) / 8,
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function minimumDistanceToMeshMeters(landmark, bounds) {
  const nearestLatitude = clamp(landmark.latitude, bounds.south, bounds.north);
  const nearestLongitude = clamp(landmark.longitude, bounds.west, bounds.east);
  const latitudeRadians = landmark.latitude * Math.PI / 180;
  const northMeters = (nearestLatitude - landmark.latitude) * EARTH_METERS_PER_DEGREE;
  const eastMeters = (nearestLongitude - landmark.longitude) * EARTH_METERS_PER_DEGREE * Math.cos(latitudeRadians);
  return Math.hypot(northMeters, eastMeters);
}

function meshesForRadius(landmark, radiusMeters) {
  const latitudeMargin = radiusMeters / EARTH_METERS_PER_DEGREE;
  const longitudeMargin = radiusMeters / (
    EARTH_METERS_PER_DEGREE * Math.max(0.1, Math.cos(landmark.latitude * Math.PI / 180))
  );
  const latitudeStart = Math.floor((landmark.latitude - latitudeMargin) * 12);
  const latitudeEnd = Math.floor((landmark.latitude + latitudeMargin) * 12);
  const longitudeStart = Math.floor((landmark.longitude - longitudeMargin - 100) * 8);
  const longitudeEnd = Math.floor((landmark.longitude + longitudeMargin - 100) * 8);
  const meshes = [];
  for (let latitudeIndex = latitudeStart; latitudeIndex <= latitudeEnd; latitudeIndex += 1) {
    for (let longitudeIndex = longitudeStart; longitudeIndex <= longitudeEnd; longitudeIndex += 1) {
      const bounds = meshBounds(latitudeIndex, longitudeIndex);
      if (radiusMeters === 0 || minimumDistanceToMeshMeters(landmark, bounds) <= radiusMeters + 1) {
        meshes.push(secondMeshCodeFromIndexes(latitudeIndex, longitudeIndex));
      }
    }
  }
  return meshes;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

async function fetchFiles(meshCodes) {
  const filesById = new Map();
  for (const meshBatch of chunk(meshCodes, BATCH_SIZE)) {
    const url = new URL(API_URL);
    url.searchParams.set("type_codes", TYPE_CODES.join(","));
    url.searchParams.set("mesh_codes", meshBatch.join(","));
    let response;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      response = await fetch(url, { headers: { accept: "application/json" } });
      if (response.ok) break;
      if (attempt === 3) throw new Error(`GSI DEM metadata request failed: ${response.status} ${url}`);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
    const body = await response.json();
    if (body?.result?.status !== "success" || !Array.isArray(body.results)) {
      throw new Error(`Unexpected GSI DEM response for ${meshBatch[0]}: ${JSON.stringify(body).slice(0, 500)}`);
    }
    for (const file of body.results) filesById.set(String(file.id), file);
  }
  return [...filesById.values()].sort((left, right) =>
    String(left.place_code).localeCompare(String(right.place_code)) ||
    String(left.type_code).localeCompare(String(right.type_code))
  );
}

function summarizeFiles(files) {
  const summaries = new Map();
  for (const file of files) {
    const type = String(file.type_code);
    const bytes = Number(file.file_size_kbyte) * 1024;
    const current = summaries.get(type) ?? { type, files: 0, estimatedBytes: 0 };
    current.files += 1;
    current.estimatedBytes += bytes;
    summaries.set(type, current);
  }
  const byType = [...summaries.values()].map((entry) => ({
    ...entry,
    estimatedGiB: Number((entry.estimatedBytes / 2 ** 30).toFixed(3)),
  }));
  const estimatedBytes = byType.reduce((sum, entry) => sum + entry.estimatedBytes, 0);
  return {
    files: files.length,
    estimatedBytes,
    estimatedGiB: Number((estimatedBytes / 2 ** 30).toFixed(3)),
    byType,
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = process.cwd();
  // The client-side catalogue is the authoritative spot-search list.  The
  // server prewarm seed intentionally used to omit ferris wheels, which left
  // six selectable landmarks without DEM coverage in the generated manifest.
  const landmarkPath = path.join(root, "src", "data", "japanLandmarks.ts");
  const demDirectory = path.join(root, "dem");
  const landmarks = readLandmarks(await fs.readFile(landmarkPath, "utf8"));
  const seedLandmarks = readLandmarks(await fs.readFile(path.join(root, "server", "landmarkPrewarmSeed.ts"), "utf8"));
  if (landmarks.length < 288 || landmarks.length !== seedLandmarks.length) {
    throw new Error(`Expected client and seed catalogues to match, parsed ${landmarks.length} / ${seedLandmarks.length}`);
  }
  const selectedNames = options.names ? new Set(options.names) : null;
  const selectedLandmarks = selectedNames
    ? landmarks.filter((landmark) => selectedNames.has(landmark.name))
    : landmarks;
  if (selectedNames && selectedLandmarks.length !== selectedNames.size) {
    const found = new Set(selectedLandmarks.map((landmark) => landmark.name));
    const missing = [...selectedNames].filter((name) => !found.has(name));
    throw new Error(`Unknown landmark name(s): ${missing.join(", ")}`);
  }
  await fs.mkdir(demDirectory, { recursive: true });

  for (const radiusMeters of [...new Set(options.radii)].sort((a, b) => a - b)) {
    const landmarksByMesh = new Map();
    for (const landmark of selectedLandmarks) {
      for (const meshCode of meshesForRadius(landmark, radiusMeters)) {
        const owners = landmarksByMesh.get(meshCode) ?? [];
        owners.push(landmark.name);
        landmarksByMesh.set(meshCode, owners);
      }
    }
    const meshCodes = [...landmarksByMesh.keys()].sort();
    const files = options.fetchMetadata ? await fetchFiles(meshCodes) : [];
    const suffix = radiusMeters === 0 ? "center" : `${Math.round(radiusMeters / 1000)}km`;
    const manifest = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      source: API_URL,
      landmarkSource: "src/data/japanLandmarks.ts",
      landmarkCount: selectedLandmarks.length,
      catalogueLandmarkCount: landmarks.length,
      radiusMeters,
      meshCodeLevel: "JIS X 0410 second mesh (about 10 km)",
      meshCount: meshCodes.length,
      meshCodes,
      landmarksByMesh: Object.fromEntries([...landmarksByMesh.entries()].sort()),
      summary: summarizeFiles(files),
      files: files.map((file) => ({
        id: Number(file.id),
        typeCode: String(file.type_code),
        meshCode: String(file.place_code),
        fileName: String(file.file_name),
        sizeKiB: Number(file.file_size_kbyte),
        estimatedBytes: Number(file.file_size_kbyte) * 1024,
        updateDate: String(file.file_update_date),
        downloadPath: `/kiban/app/api/download/file/${file.id}`,
        landmarks: landmarksByMesh.get(String(file.place_code)) ?? [],
      })),
    };
    const jsonPath = path.join(demDirectory, `${options.outputPrefix}-${suffix}-manifest.json`);
    await fs.writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const csvRows = [
      ["id", "typeCode", "meshCode", "fileName", "sizeKiB", "estimatedBytes", "updateDate", "downloadPath", "landmarks"],
      ...manifest.files.map((file) => [
        file.id, file.typeCode, file.meshCode, file.fileName, file.sizeKiB,
        file.estimatedBytes, file.updateDate, file.downloadPath, file.landmarks.join("|"),
      ]),
    ];
    await fs.writeFile(
      path.join(demDirectory, `${options.outputPrefix}-${suffix}-manifest.csv`),
      `${csvRows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`,
    );
    console.log(`${suffix}: ${meshCodes.length} meshes, ${manifest.summary.files} files, ${manifest.summary.estimatedGiB} GiB`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

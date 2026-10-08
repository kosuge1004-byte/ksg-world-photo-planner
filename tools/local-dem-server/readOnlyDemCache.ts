import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { RuntimeKvNamespace } from "../../server/cloudflareRuntime.ts";

const NATIONWIDE_READY_KEY = "gsi-local-dem-v1/nationwide-ready-v1.json";
const ALLOWED_KEY = /^gsi-local-dem-v1\/(?:manifest\.json|nationwide-ready-v1\.json|(?:DEM1A|DEM5A|DEM5B|DEM5C)\/\d{8}\.bin\.gz|DEM10B\/\d{6}\.bin\.gz)$/;
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_ASSET_BYTES = 16 * 1_048_576;

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export type ReadOnlyDemCache = RuntimeKvNamespace & {
  /** The validated manifest is read during startup; no path is exposed. */
  validateReady(): Promise<{ nationwideReady: boolean }>;
};

/**
 * R2 object keys are mapped to a prepared local tree. The caller cannot name a
 * file: only a manifest or a source/mesh key produced by gsiLocalDem is valid.
 */
export async function createReadOnlyDemCache(configuredRoot: string): Promise<ReadOnlyDemCache> {
  const root = await realpath(path.resolve(configuredRoot));
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error("configured DEM asset root is unavailable");

  const readKey = async (key: string): Promise<ArrayBuffer | null> => {
    if (!ALLOWED_KEY.test(key)) throw new Error("invalid DEM asset key");
    const candidate = path.resolve(root, ...key.split("/"));
    if (!isInside(root, candidate)) throw new Error("invalid DEM asset key");

    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("DEM asset read failed");
    }
    if (!isInside(root, canonical)) throw new Error("invalid DEM asset location");

    const maximumBytes = key.endsWith("/manifest.json")
      ? MAX_MANIFEST_BYTES
      : MAX_ASSET_BYTES;
    const metadata = await stat(canonical);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) {
      throw new Error("DEM asset is invalid");
    }

    // Open with read-only flags. The service exposes no write/delete/list API.
    const handle = await open(canonical, constants.O_RDONLY);
    try {
      const afterOpen = await handle.stat();
      if (!afterOpen.isFile() || afterOpen.size !== metadata.size) {
        throw new Error("DEM asset changed during read");
      }
      return toArrayBuffer(await handle.readFile());
    } finally {
      await handle.close();
    }
  };

  const cache: ReadOnlyDemCache = {
    get: (key) => readKey(key),
    getWithStatus: async (key) => {
      try {
        const value = await readKey(key);
        return { status: value ? "hit" as const : "miss" as const, value };
      } catch {
        return { status: "bypass" as const, value: null };
      }
    },
    put: async () => {
      throw new Error("local DEM asset store is read-only");
    },
    validateReady: async () => {
      const bytes = await readKey("gsi-local-dem-v1/manifest.json");
      if (!bytes) throw new Error("local DEM manifest is unavailable");
      let manifest: { schemaVersion?: unknown; format?: unknown };
      try {
        manifest = JSON.parse(new TextDecoder().decode(bytes)) as typeof manifest;
      } catch {
        throw new Error("local DEM manifest is invalid");
      }
      if (
        manifest.schemaVersion !== 1 ||
        manifest.format !== "astrosight-gsi-local-dem-v1"
      ) {
        throw new Error("local DEM manifest is invalid");
      }
      const readyBytes = await readKey(NATIONWIDE_READY_KEY);
      if (!readyBytes) return { nationwideReady: false };
      try {
        const ready = JSON.parse(new TextDecoder().decode(readyBytes)) as {
          schemaVersion?: unknown;
          format?: unknown;
          status?: unknown;
          manifestSha256?: unknown;
        };
        const manifestSha256 = createHash("sha256")
          .update(new Uint8Array(bytes))
          .digest("hex");
        return {
          nationwideReady:
            ready.schemaVersion === 1 &&
            ready.format === "astrosight-nationwide-dem-ready-v1" &&
            ready.status === "complete" &&
            ready.manifestSha256 === manifestSha256,
        };
      } catch {
        return { nationwideReady: false };
      }
    },
  };
  return cache;
}

export const readOnlyDemCacheInternalsForTests = {
  isInside,
  ALLOWED_KEY,
  NATIONWIDE_READY_KEY,
};

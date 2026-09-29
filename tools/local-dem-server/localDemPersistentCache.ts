import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeKvNamespace } from "../../server/cloudflareRuntime.ts";
import { createReadOnlyDemCache, type ReadOnlyDemCache } from "./readOnlyDemCache.ts";

const DECODED_TILE_KEY =
  /^gsi-decoded-dem-v2\/(?:dem1a_png\/17|(?:dem5a_png|dem5b_png|dem5c_png)\/15|dem_png\/14)\/\d+\/\d+\.bin$/;
const MAX_DECODED_TILE_BYTES = 9 + 256 * 256 * Int32Array.BYTES_PER_ELEMENT;

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`));
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export type LocalDemPersistentCache = RuntimeKvNamespace & {
  validateReady(): Promise<void>;
};

/**
 * Prepared official GML assets remain strictly read-only. Only decoded GSI PNG
 * tiles fetched by this process may be written, under a fixed content namespace
 * inside the configured E-drive root. The HTTP service exposes no cache write,
 * delete, list or path endpoint.
 */
export async function createLocalDemPersistentCache(
  configuredRoot: string
): Promise<LocalDemPersistentCache> {
  const official: ReadOnlyDemCache = await createReadOnlyDemCache(configuredRoot);
  const root = await realpath(path.resolve(configuredRoot));
  const tileRoot = path.resolve(root, "gsi-decoded-dem-v2");
  if (!isInside(root, tileRoot)) throw new Error("invalid decoded DEM cache root");
  await mkdir(tileRoot, { recursive: true });
  const canonicalTileRoot = await realpath(tileRoot);
  if (!isInside(root, canonicalTileRoot)) throw new Error("invalid decoded DEM cache root");

  const tilePath = (key: string): string => {
    if (!DECODED_TILE_KEY.test(key)) throw new Error("invalid decoded DEM tile key");
    const candidate = path.resolve(root, ...key.split("/"));
    if (!isInside(canonicalTileRoot, candidate)) throw new Error("invalid decoded DEM tile key");
    return candidate;
  };

  const readTile = async (key: string): Promise<ArrayBuffer | null> => {
    const candidate = tilePath(key);
    let metadata;
    try {
      metadata = await stat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("decoded DEM tile read failed");
    }
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_DECODED_TILE_BYTES) {
      throw new Error("decoded DEM tile is invalid");
    }
    const handle = await open(candidate, constants.O_RDONLY);
    try {
      const afterOpen = await handle.stat();
      if (!afterOpen.isFile() || afterOpen.size !== metadata.size) {
        throw new Error("decoded DEM tile changed during read");
      }
      return toArrayBuffer(await handle.readFile());
    } finally {
      await handle.close();
    }
  };

  const writeTile = async (key: string, value: ArrayBuffer): Promise<void> => {
    if (!(value instanceof ArrayBuffer) || value.byteLength < 1 ||
      value.byteLength > MAX_DECODED_TILE_BYTES) {
      throw new Error("decoded DEM tile payload is invalid");
    }
    const candidate = tilePath(key);
    const parent = path.dirname(candidate);
    if (!isInside(canonicalTileRoot, parent)) throw new Error("invalid decoded DEM tile key");
    await mkdir(parent, { recursive: true });
    const temporary = `${candidate}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, new Uint8Array(value), { flag: "wx" });
      try {
        await rename(temporary, candidate);
      } catch (error) {
        // Another concurrent request may have completed the same immutable
        // tile first. Keep that valid file and discard only our private temp.
        const existing = await readTile(key).catch(() => null);
        if (!existing) throw error;
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  };

  return {
    validateReady: () => official.validateReady(),
    get: async (key, options) => DECODED_TILE_KEY.test(key)
      ? readTile(key)
      : official.get(key, options),
    getWithStatus: async (key, options) => {
      if (!DECODED_TILE_KEY.test(key)) {
        return official.getWithStatus
          ? official.getWithStatus(key, options)
          : { status: "bypass" as const, value: null };
      }
      try {
        const value = await readTile(key);
        return { status: value ? "hit" as const : "miss" as const, value };
      } catch {
        return { status: "bypass" as const, value: null };
      }
    },
    put: (key, value) => writeTile(key, value),
  };
}

export const localDemPersistentCacheInternalsForTests = {
  DECODED_TILE_KEY,
  MAX_DECODED_TILE_BYTES,
  isInside,
};

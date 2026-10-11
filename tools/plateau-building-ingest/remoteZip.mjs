// 公開されているZIPを、丸ごとダウンロードせずに扱う。
// 目次（セントラルディレクトリ）を部分取得して中身の一覧を作り、必要なファイルだけを取り出す。
// 取り出したファイルは、大きさとCRC-32を目次の値と突き合わせて、壊れていないことを確かめる。

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const USER_AGENT = "AstroSight-plateau-building-ingest/1.0 (building heights only)";
const IDLE_TIMEOUT_MS = 120_000;
const TAIL_BYTES = 256 * 1024;
const MAX_DIRECTORY_BYTES = 512 * 1024 * 1024;
const LOCAL_HEADER_SLACK_BYTES = 4096;

export class RangeUnsupportedError extends Error {}
export class UnsupportedEntryError extends Error {}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(chunk, previous = 0) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(chunk, previous);
  let value = ~previous >>> 0;
  for (let index = 0; index < chunk.length; index += 1) value = CRC_TABLE[(value ^ chunk[index]) & 0xff] ^ (value >>> 8);
  return ~value >>> 0;
}

/** 部分取得の応答を開く。一定時間データが来なければ打ち切る。 */
async function openRange(url, start, endInclusive) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS); };
  const close = () => { clearTimeout(timer); controller.abort(); };
  try {
    const response = await fetch(url, {
      redirect: "follow", signal: controller.signal,
      headers: { Range: `bytes=${start}-${endInclusive}`, "User-Agent": USER_AGENT },
    });
    if (response.status === 200) throw new RangeUnsupportedError("部分取得に応じない配布元です");
    if (response.status !== 206) throw new Error(`HTTP ${response.status}`);
    const total = /\/(\d+)\s*$/u.exec(response.headers.get("content-range") ?? "");
    return { response, touch, close, totalBytes: total ? Number(total[1]) : null };
  } catch (error) {
    close();
    throw error;
  }
}

export async function fetchRange(url, start, endInclusive) {
  const opened = await openRange(url, start, endInclusive);
  try {
    const parts = [];
    for await (const chunk of opened.response.body) { opened.touch(); parts.push(Buffer.from(chunk)); }
    const buffer = Buffer.concat(parts);
    if (buffer.length !== endInclusive - start + 1) throw new Error("受け取った長さが要求と一致しません");
    return { buffer, totalBytes: opened.totalBytes };
  } finally {
    opened.close();
  }
}

/** ZIPの中身の一覧を作る（ZIP64対応）。 */
export async function listEntries(url) {
  const size = (await fetchRange(url, 0, 0)).totalBytes;
  if (!Number.isFinite(size) || size < 22) throw new Error("ファイルの大きさが分かりません");
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = (await fetchRange(url, tailStart, size - 1)).buffer;
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) <= tail.length) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("ZIPの末尾（目次の位置情報）が見つかりません");
  let entryCount = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
    const recordOffset = Number(tail.readBigUInt64LE(eocd - 12));
    const record = recordOffset >= tailStart && recordOffset + 56 <= size
      ? tail.subarray(recordOffset - tailStart, recordOffset - tailStart + 56)
      : (await fetchRange(url, recordOffset, recordOffset + 55)).buffer;
    if (record.readUInt32LE(0) !== 0x06064b50) throw new Error("ZIP64の位置情報が壊れています");
    entryCount = Number(record.readBigUInt64LE(32));
    directorySize = Number(record.readBigUInt64LE(40));
    directoryOffset = Number(record.readBigUInt64LE(48));
  } else if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64の位置情報が見つかりません");
  }
  if (directoryOffset + directorySize > size || directorySize > MAX_DIRECTORY_BYTES) throw new Error("目次の位置または大きさが不正です");
  const directory = directoryOffset >= tailStart
    ? tail.subarray(directoryOffset - tailStart, directoryOffset - tailStart + directorySize)
    : (await fetchRange(url, directoryOffset, directoryOffset + directorySize - 1)).buffer;

  const entries = [];
  let offset = 0;
  while (offset + 46 <= directory.length && directory.readUInt32LE(offset) === 0x02014b50) {
    const flags = directory.readUInt16LE(offset + 8);
    const method = directory.readUInt16LE(offset + 10);
    const crc = directory.readUInt32LE(offset + 16);
    let compressedSize = directory.readUInt32LE(offset + 20);
    let uncompressedSize = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    let localOffset = directory.readUInt32LE(offset + 42);
    const name = directory.toString("utf8", offset + 46, offset + 46 + nameLength);
    let extra = offset + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extra);
      const length = directory.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let cursor = extra + 4;
        if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(directory.readBigUInt64LE(cursor)); cursor += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(directory.readBigUInt64LE(cursor)); cursor += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(directory.readBigUInt64LE(cursor)); }
        break;
      }
      extra += 4 + length;
    }
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset, nameLength });
    offset = extraEnd + commentLength;
  }
  if (entries.length !== entryCount) throw new Error(`目次の件数が合いません（${entries.length}/${entryCount}）`);
  return { size, directoryOffset, entries };
}

/**
 * ZIPの中の1ファイルを取り出し、展開したデータを順に onChunk へ渡す。
 * 大きさとCRC-32が目次と一致しなければ例外にする。
 */
export async function readEntry(url, archive, entry, onChunk) {
  if (entry.flags & 0x1) throw new UnsupportedEntryError("暗号化されたファイルは読めません");
  if (entry.method !== 0 && entry.method !== 8) throw new UnsupportedEntryError(`未対応の圧縮方式です（方式${entry.method}）`);
  const lastByte = archive.directoryOffset - 1;
  const wanted = entry.localOffset + 30 + entry.nameLength + LOCAL_HEADER_SLACK_BYTES + entry.compressedSize - 1;
  const opened = await openRange(url, entry.localOffset, Math.min(lastByte, wanted));
  let checksum = 0;
  let total = 0;
  try {
    async function* compressed() {
      let header = Buffer.alloc(0);
      let dataStart = -1;
      let remaining = entry.compressedSize;
      for await (const raw of opened.response.body) {
        opened.touch();
        let chunk = Buffer.from(raw);
        if (dataStart < 0) {
          header = Buffer.concat([header, chunk]);
          if (header.length < 30) continue;
          if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("ファイルの先頭の印が見つかりません");
          dataStart = 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
          if (dataStart - 30 - entry.nameLength > LOCAL_HEADER_SLACK_BYTES) throw new Error("ファイルの見出しが想定より長く、読めません");
          if (header.length < dataStart) { dataStart = -1; continue; }
          chunk = header.subarray(dataStart);
        }
        if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
        remaining -= chunk.length;
        if (chunk.length > 0) yield chunk;
        if (remaining === 0) return;
      }
      if (remaining > 0) throw new Error("データが途中で途切れました");
    }
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        try {
          checksum = crc32(chunk, checksum);
          total += chunk.length;
          const wait = onChunk(chunk);
          if (wait && typeof wait.then === "function") wait.then(() => callback(), callback);
          else callback();
        } catch (error) { callback(error); }
      },
    });
    const source = Readable.from(compressed(), { objectMode: false });
    if (entry.method === 8) await pipeline(source, zlib.createInflateRaw(), sink);
    else await pipeline(source, sink);
  } finally {
    opened.close();
  }
  if (total !== entry.uncompressedSize) throw new Error(`展開後の大きさが目次と一致しません（${total}/${entry.uncompressedSize}）`);
  if ((checksum >>> 0) !== (entry.crc >>> 0)) throw new Error("検査値（CRC-32）が一致しません。データが壊れています");
}

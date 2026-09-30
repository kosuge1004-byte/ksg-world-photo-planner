/**
 * 国土地理院 標高PNGタイル（dem_png / dem5a_png 等）のデコーダ。
 *
 * 2026-09-30: サーバー（Workers, node:zlib）と端末（ブラウザ/WebView,
 * DecompressionStream）で「完全に同一のcm整数配列」を得るため、zlib展開
 * 以外の処理（チャンク解析・PNGフィルター復元・RGB→cm変換）をここへ
 * 一本化した。展開関数だけを呼び出し側から渡す。旧 server/gsiElevation.ts
 * 内の実装を1行も変えずに移したもので、値・NoData判定は従来どおり。
 */

export const GSI_DEM_NO_DATA_CENTIMETERS = -2_147_483_648;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export type GsiDemPngHeader = {
  width: number;
  height: number;
  bytesPerPixel: number;
  /** 連結済みIDAT（zlibストリーム） */
  compressed: Uint8Array;
};

export type DecodedGsiDemTile = {
  width: number;
  height: number;
  heightsCentimeters: Int32Array;
};

function readChunkName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

export function parseGsiDemPng(bytes: Uint8Array): GsiDemPngHeader {
  if (PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new Error("国土地理院標高タイルがPNG形式ではありません");
  }

  let width = 0;
  let height = 0;
  let bytesPerPixel = 0;
  const idatParts: Uint8Array[] = [];
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
      throw new Error("国土地理院標高タイルのPNGデータが途中で終了しています");
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
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`未対応の標高PNG形式です（bit=${bitDepth}, color=${colorType}）`);
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
    throw new Error("国土地理院標高タイルのPNGヘッダーを解析できません");
  }
  const compressedLength = idatParts.reduce((sum, part) => sum + part.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let compressedOffset = 0;
  for (const part of idatParts) {
    compressed.set(part, compressedOffset);
    compressedOffset += part.length;
  }
  return { width, height, bytesPerPixel, compressed };
}

/** 展開済みスキャンラインからPNGフィルターを復元し、cm整数配列へ変換する。 */
export function gsiDemTileFromInflated(
  header: GsiDemPngHeader,
  inflated: Uint8Array
): DecodedGsiDemTile {
  const { width, height, bytesPerPixel } = header;
  const rowBytes = width * bytesPerPixel;
  if (inflated.length < (rowBytes + 1) * height) {
    throw new Error("国土地理院標高タイルの展開後データが不足しています");
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
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? pixels[rowOffset - rowBytes + x - bytesPerPixel]
        : 0;
      const reconstructed = filter === 0
        ? raw
        : filter === 1
          ? raw + left
          : filter === 2
            ? raw + above
            : filter === 3
              ? raw + Math.floor((left + above) / 2)
              : filter === 4
                ? raw + paethPredictor(left, above, upperLeft)
                : Number.NaN;
      if (!Number.isFinite(reconstructed)) {
        throw new Error(`未対応のPNGフィルターです（${filter}）`);
      }
      pixels[rowOffset + x] = reconstructed & 0xff;
    }
    sourceOffset += rowBytes;
  }

  const pixelCount = width * height;
  const heightsCentimeters = new Int32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * bytesPerPixel;
    const encoded =
      pixels[offset] * 65_536 +
      pixels[offset + 1] * 256 +
      pixels[offset + 2];
    heightsCentimeters[pixelIndex] = encoded === 2 ** 23
      ? GSI_DEM_NO_DATA_CENTIMETERS
      : encoded < 2 ** 23
        ? encoded
        : encoded - 2 ** 24;
  }
  return { width, height, heightsCentimeters };
}

/** 同期zlib展開（node:zlib inflateSync等）を使うサーバー用。 */
export function decodeGsiDemPngSync(
  bytes: Uint8Array,
  inflate: (compressed: Uint8Array) => Uint8Array
): DecodedGsiDemTile {
  const header = parseGsiDemPng(bytes);
  return gsiDemTileFromInflated(header, inflate(header.compressed));
}

/** 非同期zlib展開（DecompressionStream等）を使う端末用。 */
export async function decodeGsiDemPngAsync(
  bytes: Uint8Array,
  inflate: (compressed: Uint8Array) => Promise<Uint8Array>
): Promise<DecodedGsiDemTile> {
  const header = parseGsiDemPng(bytes);
  return gsiDemTileFromInflated(header, await inflate(header.compressed));
}

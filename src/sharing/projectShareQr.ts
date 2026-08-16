import QRCode from "qrcode";
import jsQR from "jsqr";

/**
 * 撮影計画の共有リンクをQRコード画像（PNGのdata URL）にする。
 * 共有コード自体はBase64url化したJSONで、画面の座標・カメラ設定・表示設定のみを含み、
 * 高度は含まない（受信側で必ず取り直す）。QRコード化はこの文字列を画像にするだけで、
 * 中身の仕様は projectShareCode.ts 側と同じ。
 */
export async function generateShareQrDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
    color: { dark: "#0b1420", light: "#ffffff" },
  });
}

export class QrDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrDecodeError";
  }
}

/** カメラ映像1フレーム分のImageDataからQRコードの中身の文字列を読み取る。見つからなければnull。 */
export function decodeQrFromImageData(imageData: ImageData): string | null {
  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: "attemptBoth",
  });
  return result ? result.data : null;
}

/** 画像ファイル（写真として保存されたQRコードなど）から中身の文字列を読み取る。 */
export async function decodeQrFromImageFile(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new QrDecodeError("画像を読み込めませんでした"));
      element.src = objectUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new QrDecodeError("画像を解析できませんでした");
    context.drawImage(image, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const text = decodeQrFromImageData(imageData);
    if (!text) throw new QrDecodeError("この画像からQRコードを読み取れませんでした");
    return text;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

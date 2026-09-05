import { useEffect, useRef, useState } from "react";
import { startEnvironmentCamera, stopCameraStream } from "../ar/cameraSession";
import { decodeQrFromImageData, decodeQrFromImageFile, QrDecodeError } from "../sharing/projectShareQr";

type Props = {
  open: boolean;
  onClose: () => void;
  onScanned: (text: string) => void;
};

type ScanMode = "camera" | "image";

export function ProjectQrScanDialog({ open, onClose, onScanned }: Props) {
  const [mode, setMode] = useState<ScanMode>("camera");
  const [cameraMessage, setCameraMessage] = useState("カメラを準備しています…");
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  // 2026-09-05追記: position:fixed;inset:0のバックドロップが実機（特に
  // 古いAndroid WebView）でdvh計算を誤り、中身が画面外へ押し出される
  // ことがあるため、開いた瞬間にJavaScriptで確実に画面内へスクロールする。
  useEffect(() => {
    if (open) dialogRef.current?.scrollIntoView({ block: "center", inline: "center" });
  }, [open]);

  useEffect(() => {
    if (!open) {
      setMode("camera");
      setImageError(null);
      setImageBusy(false);
      return;
    }
    setCameraMessage("カメラを準備しています…");
  }, [open]);

  useEffect(() => {
    if (!open || mode !== "camera") return;
    let disposed = false;
    // cleanup内でref.currentを直接参照すると、実行時点で別のノードに
    // 差し替わっている可能性があるため、effect開始時点の値を変数へ複製する。
    const videoElement = videoRef.current;

    function stopScanLoop() {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    }

    let frameInFlight = false;
    function scanFrame() {
      const video = videoRef.current;
      if (!video || video.readyState < video.HAVE_ENOUGH_DATA || disposed || frameInFlight) {
        animationFrameRef.current = requestAnimationFrame(scanFrame);
        return;
      }
      if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context || canvas.width === 0 || canvas.height === 0) {
        animationFrameRef.current = requestAnimationFrame(scanFrame);
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      // 2026-08-27追記: decodeQrFromImageDataはjsQRライブラリの遅延読み込み
      // のためasync化した。初回フレームだけライブラリのダウンロードを待つ
      // （通常は一瞬）。frameInFlightで、前のフレームの解析中に次の
      // requestAnimationFrameが二重に走らないようにする。
      frameInFlight = true;
      void decodeQrFromImageData(imageData).then((text) => {
        frameInFlight = false;
        if (disposed) return;
        if (text) {
          stopScanLoop();
          onScanned(text);
          return;
        }
        animationFrameRef.current = requestAnimationFrame(scanFrame);
      });
    }

    async function start() {
      try {
        const camera = await startEnvironmentCamera();
        if (disposed) {
          stopCameraStream(camera.stream);
          return;
        }
        streamRef.current = camera.stream;
        if (videoRef.current) {
          videoRef.current.srcObject = camera.stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setCameraMessage("QRコードを画面に映してください");
        animationFrameRef.current = requestAnimationFrame(scanFrame);
      } catch (error) {
        if (disposed) return;
        const name = error instanceof DOMException ? error.name : "";
        setCameraMessage(
          name === "NotAllowedError" || name === "SecurityError"
            ? "カメラを使用できません。端末のカメラ権限を許可してください。"
            : "カメラを開始できませんでした。画像から読み込むこともできます。"
        );
      }
    }

    void start();
    return () => {
      disposed = true;
      stopScanLoop();
      stopCameraStream(streamRef.current);
      streamRef.current = null;
      if (videoElement) videoElement.srcObject = null;
    };
  }, [open, mode, onScanned]);

  async function handleImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImageBusy(true);
    setImageError(null);
    try {
      const text = await decodeQrFromImageFile(file);
      onScanned(text);
    } catch (error) {
      setImageError(error instanceof QrDecodeError ? error.message : "画像からQRコードを読み取れませんでした");
    } finally {
      setImageBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="project-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="project-dialog qr-scan-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="QRコードを読み取る"
      >
        <h2>QRコードを読み取る</h2>
        <div className="qr-scan-mode-tabs" role="tablist" aria-label="読み取り方法">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "camera"}
            className={mode === "camera" ? "primary" : undefined}
            onClick={() => setMode("camera")}
          >
            カメラで読み取る
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "image"}
            className={mode === "image" ? "primary" : undefined}
            onClick={() => setMode("image")}
          >
            画像から読み込む
          </button>
        </div>
        {mode === "camera" ? (
          <div className="qr-scan-camera-wrap">
            <video ref={videoRef} className="qr-scan-video" playsInline muted autoPlay />
            <p className="project-dialog-note" role="status">{cameraMessage}</p>
          </div>
        ) : (
          <div className="qr-scan-image-wrap">
            <label className="qr-scan-image-label">
              <span>{imageBusy ? "読み取り中…" : "QRコードが写った画像を選択してください"}</span>
              <input type="file" accept="image/*" onChange={(event) => void handleImageChange(event)} disabled={imageBusy} />
            </label>
            {imageError && <p className="project-dialog-error" role="alert">{imageError}</p>}
          </div>
        )}
        <div>
          <button type="button" onClick={onClose}>閉じる</button>
        </div>
      </section>
    </div>
  );
}

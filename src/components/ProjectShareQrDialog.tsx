import { useEffect, useState } from "react";
import { generateShareQrDataUrl } from "../sharing/projectShareQr";

type Props = {
  open: boolean;
  url: string | null;
  projectName: string;
  onClose: () => void;
  onShareLink: () => void;
};

export function ProjectShareQrDialog({ open, url, projectName, onClose, onShareLink }: Props) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !url) {
      setQrDataUrl(null);
      setErrorMessage(null);
      return;
    }
    let cancelled = false;
    setErrorMessage(null);
    generateShareQrDataUrl(url)
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setErrorMessage("QRコードを作成できませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, [open, url]);

  if (!open || !url) return null;

  return (
    <div className="project-dialog-backdrop" role="presentation">
      <section
        className="project-dialog qr-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="撮影計画をQRコードで共有"
      >
        <h2>QRコードで受け渡す</h2>
        <p className="project-dialog-note">
          「{projectName || "（名称未設定）"}」を渡したい相手に、この画面をそのまま見せてください。
          相手はメニューの「QRコードを読み取る」からカメラで読み取れます。
        </p>
        <div className="qr-share-image-wrap">
          {qrDataUrl
            ? <img src={qrDataUrl} alt="撮影計画の共有QRコード" width={240} height={240} />
            : <div className="qr-share-image-placeholder">{errorMessage ?? "QRコードを作成しています…"}</div>}
        </div>
        {errorMessage && <p className="project-dialog-error" role="alert">{errorMessage}</p>}
        <div>
          <button type="button" onClick={onShareLink}>リンクを共有／コピー</button>
          <button type="button" className="primary" onClick={onClose}>閉じる</button>
        </div>
      </section>
    </div>
  );
}

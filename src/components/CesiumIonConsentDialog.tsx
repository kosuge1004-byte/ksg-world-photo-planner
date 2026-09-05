import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Cesium ionへのOAuth接続を開始する前に必ず表示する確認画面。
 *
 * Cesium社（Bentley Systems）担当者からの回答（2026-08-20付）で
 * 明示的に案内された内容に基づく:
 *   - 各ユーザーが自身のCesium ionアカウントを作成・管理し、
 *     Google Photorealistic 3D Tilesを含むCesium ionサービスの利用は
 *     各ユーザー自身のアカウントに紐付いて計上される（BYOA方式）。
 *   - ただし各エンドユーザーは、Cesium ionの利用規約およびライセンス
 *     条件を遵守する必要がある。
 *   - 特に、業務の一環として利用する場合（社内利用や顧客向け業務での
 *     利用を含む）は、Communityプランではなく Commercial/Premium
 *     プランが必要になる。
 *   - 「アプリケーションや利用規約等において、利用者が適切なCesium ion
 *     プランおよびライセンスを購入するよう案内いただくことをお勧め
 *     します」との推奨に基づき、接続前にここで案内する。
 *
 * 2026-08-26追記: 利用回数の把握はこの端末単体でのカウントに限られる
 * （AstroSightはユーザーアカウントを持たないため、複数端末を横断した
 * 名寄せができない）。そのため「1アカウントにつき1端末での利用」を
 * 前提とすることを明記し、同意のチェックを入れないと接続へ進めない
 * ようにする。
 */
export function CesiumIonConsentDialog({ open, onConfirm, onCancel }: Props) {
  const [singleDeviceAcknowledged, setSingleDeviceAcknowledged] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);

  // 2026-09-05追記: position:fixed;inset:0のバックドロップが実機（特に
  // 古いAndroid WebView）でdvh計算を誤り、中身が画面外へ押し出される
  // ことがあるため、開いた瞬間にJavaScriptで確実に画面内へスクロールする。
  useEffect(() => {
    if (open) dialogRef.current?.scrollIntoView({ block: "center", inline: "center" });
  }, [open]);

  if (!open) return null;
  return (
    <div className="project-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="project-dialog cesium-ion-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Cesium ionアカウントの接続について"
      >
        <h2>ご自身のCesium ionアカウントを接続します</h2>
        <p className="project-dialog-note">
          Google Photorealistic 3D Tiles（Googleタイルモード）を利用するには、あなた自身のCesium ionアカウント（無料で作成できます）が必要です。次の画面でログインまたは新規登録すると、以降の利用量はAstroSightではなく、あなた自身のCesium ionアカウントに計上されます。
        </p>
        <ul className="cesium-ion-consent-points">
          <li>個人の趣味利用であれば、多くの場合Cesium ionの無料プラン（Community）の範囲内で利用できます。無料プランには1アカウントあたりの利用回数に上限があります。</li>
          <li>仕事・業務の一環として利用する場合（社内利用や顧客向け業務を含む）は、Cesium ion側の規約により、無料プランではなく有料プラン（Commercial／Premium）が必要になる場合があります。</li>
          <li>AstroSightは、この端末での利用回数のみを記録します。同じCesium ionアカウントを複数の端末（スマートフォンとパソコンなど）で使い回すと、各端末のカウントは低いままでも、Cesium ion側では合算され、無料枠を超えている可能性があります。</li>
          <li>利用量や規約への同意はCesium ion側のアカウントで管理されます。プラン・料金の詳細はCesium ion側でご確認ください。</li>
        </ul>
        <nav className="cesium-ion-consent-links" aria-label="関連リンク">
          <a href="https://cesium.com/platform/cesium-ion/pricing/" target="_blank" rel="noreferrer">
            Cesium ionの料金・プラン
          </a>
          <a href="https://cesium.com/legal/terms-of-service/" target="_blank" rel="noreferrer">
            Cesium ion利用規約
          </a>
          <a href="https://cesium.com/legal/privacy-policy/" target="_blank" rel="noreferrer">
            Cesium ionプライバシーポリシー
          </a>
        </nav>
        <label className="cesium-ion-consent-checkbox">
          <input
            type="checkbox"
            checked={singleDeviceAcknowledged}
            onChange={(event) => setSingleDeviceAcknowledged(event.target.checked)}
          />
          <span>
            1つのCesium ionアカウントは1台の端末でのみ利用することを理解しました。複数端末で同じアカウントを使う場合、無料枠を超える可能性があることを承知しています。
          </span>
        </label>
        <div>
          <button type="button" onClick={onCancel}>
            やめる
          </button>
          <button
            type="button"
            className="primary"
            onClick={onConfirm}
            disabled={!singleDeviceAcknowledged}
          >
            同意して接続する
          </button>
        </div>
      </section>
    </div>
  );
}

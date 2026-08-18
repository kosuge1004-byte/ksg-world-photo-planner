type Props = {
  ready: boolean;
};

export function PreviewStatus({ ready }: Props) {
  if (ready) {
    return null;
  }

  return (
    <div className="preview-empty-state">
      <strong>撮影プレビュー</strong>
      <span>
        三脚ピンと正式な被写体点を設定してください
      </span>
    </div>
  );
}

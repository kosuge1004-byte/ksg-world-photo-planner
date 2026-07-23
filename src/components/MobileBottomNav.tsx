export function MobileBottomNav() {
  return <nav className="mobile-bottom-nav" aria-label="メインナビゲーション">
    <button type="button"><span>▦</span><small>撮影プラン</small></button>
    <button type="button"><span>☆</span><small>お気に入り</small></button>
    <button type="button" className="bottom-add"><span>＋</span><small>ピン追加</small></button>
    <button type="button"><span>▧</span><small>写真一覧</small></button>
    <button type="button"><span>•••</span><small>その他</small></button>
  </nav>;
}

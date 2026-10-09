/**
 * localStorage への保存（2026-10-09）。
 * 端末の空き容量不足やプライベートブラウズでは setItem が例外を投げる。
 * 設定の保存に失敗しても操作は続けられるよう、失敗は false で返す。
 */
export function saveToLocalStorage(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`端末への保存に失敗しました（${key}）`, error);
    return false;
  }
}

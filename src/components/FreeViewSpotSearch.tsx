import { useEffect, useRef, useState } from "react";

import { toUserFacingErrorMessage } from "../errors/userFeedback";
import {
  fetchSpotCandidates,
  shouldSuggestForQuery,
  type SpotCandidate,
} from "../search/placeCandidates";
import {
  createLatestOnlyGuard,
  isDirectLocationQuery,
  resolveFreeViewDirectLocation,
  resolveFreeViewObserverGround,
  type FreeViewObserverLocation,
} from "../search/freeViewObserverSearch";
import type { GroundPoint } from "../types/points";
import { isAbortError } from "../utils/runtimeErrors";

type Props = {
  /** 候補の並び順に使う中心（いまの視点。無ければ地図の中心）。 */
  center: { latitude: number; longitude: number } | null;
  /** 視点が決まった時だけ呼ぶ。通常画面のピン・履歴には触れない。 */
  onObserverResolved: (observer: GroundPoint) => void;
  onClose: () => void;
  canClose: boolean;
};

const SUGGEST_DEBOUNCE_MS = 400;

/**
 * 自由ビューモードの視点検索（2026-10-09）。
 * 地名・名称・座標・Googleマップ共有URLを既存の検索経路で解決し、その地点の
 * 地表を視点にする。検索のたびに前の検索を中止し、遅れて届いた古い結果では
 * 視点を上書きしない。
 */
export function FreeViewSpotSearch({ center, onObserverResolved, onClose, canClose }: Props) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<SpotCandidate[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryLocation, setRetryLocation] = useState<FreeViewObserverLocation | null>(null);
  const [guard] = useState(createLatestOnlyGuard);
  const [suggestGuard] = useState(createLatestOnlyGuard);
  const centerRef = useRef(center);
  centerRef.current = center;
  const settledQueryRef = useRef("");

  useEffect(() => () => {
    guard.cancel();
    suggestGuard.cancel();
  }, [guard, suggestGuard]);

  // 入力途中の候補（既存の入力補完と同じ条件・同じ待ち時間）。
  useEffect(() => {
    const text = query.trim();
    if (!shouldSuggestForQuery(text) || text === settledQueryRef.current) {
      suggestGuard.cancel();
      return;
    }
    const timer = window.setTimeout(() => {
      const run = suggestGuard.begin();
      void fetchSpotCandidates(text, { mode: "suggest", center: centerRef.current, signal: run.signal })
        .then((list) => {
          if (run.isCurrent()) setCandidates(list);
        })
        .catch(() => undefined);
    }, SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, suggestGuard]);

  async function placeObserver(location: FreeViewObserverLocation, run: { isCurrent(): boolean }): Promise<void> {
    setMessage("この地点の地面の高さを取得しています…");
    try {
      const observer = await resolveFreeViewObserverGround(location);
      if (!run.isCurrent()) return;
      setRetryLocation(null);
      setMessage("");
      setBusy(false);
      onObserverResolved(observer);
    } catch (error) {
      if (!run.isCurrent() || isAbortError(error)) return;
      console.warn("自由ビュー: 視点の地面の高さを取得できませんでした", error);
      // 高さ0mのまま視点を確定しない。未取得を明示して再試行を出す。
      setRetryLocation(location);
      setBusy(false);
      setMessage("この地点の地面の高さを取得できなかったため、視点を移動していません。通信状態を確認して再試行してください。");
    }
  }

  async function runSearch(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      setMessage("地名・座標・Googleマップ共有URLを入力してください");
      return;
    }
    suggestGuard.cancel();
    settledQueryRef.current = trimmed;
    const run = guard.begin();
    setCandidates([]);
    setRetryLocation(null);
    setBusy(true);
    setMessage("検索しています…");
    try {
      if (isDirectLocationQuery(trimmed)) {
        const location = await resolveFreeViewDirectLocation(trimmed, run.signal);
        if (!run.isCurrent()) return;
        await placeObserver(location, run);
        return;
      }
      let list: SpotCandidate[] | null = null;
      try {
        list = await fetchSpotCandidates(trimmed, { mode: "search", center: centerRef.current, signal: run.signal });
      } catch (error) {
        if (!run.isCurrent() || isAbortError(error)) return;
        list = null;
      }
      if (!run.isCurrent()) return;
      if (list === null) {
        // 候補検索が使えない場合は、既存の「1件に確定する検索」へ戻す。
        const location = await resolveFreeViewDirectLocation(trimmed, run.signal);
        if (!run.isCurrent()) return;
        await placeObserver(location, run);
        return;
      }
      if (list.length === 0) {
        setBusy(false);
        setMessage("該当する場所が見つかりませんでした。別の名前や座標でお試しください。");
        return;
      }
      if (list.length === 1 || list[0]?.exactRegistered) {
        await placeObserver({ ...list[0].location, label: list[0].name }, run);
        return;
      }
      setCandidates(list);
      setBusy(false);
      setMessage(`候補が${list.length}件あります。立つ場所を選んでください。`);
    } catch (error) {
      if (!run.isCurrent() || isAbortError(error)) return;
      console.warn("自由ビュー: 視点の検索に失敗しました", error);
      setBusy(false);
      setMessage(toUserFacingErrorMessage(
        error,
        /^https?:\/\//iu.test(trimmed) ? "google-maps-url" : "spot-search"
      ));
    }
  }

  function chooseCandidate(candidate: SpotCandidate): void {
    suggestGuard.cancel();
    settledQueryRef.current = query.trim();
    const run = guard.begin();
    setCandidates([]);
    setBusy(true);
    void placeObserver({ ...candidate.location, label: candidate.name }, run);
  }

  return (
    <div className="free-view-search" role="dialog" aria-label="自由ビューの視点を検索">
      <form
        className="free-view-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(query);
        }}
      >
        <input
          type="search"
          value={query}
          autoFocus
          enterKeyHint="search"
          placeholder="立つ場所（地名・座標・Googleマップ共有URL）"
          aria-label="立つ場所を検索"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" disabled={busy && candidates.length === 0}>検索</button>
        {busy ? (
          <button
            type="button"
            onClick={() => {
              guard.cancel();
              setBusy(false);
              setMessage("検索を中止しました");
            }}
          >中止</button>
        ) : canClose && (
          <button type="button" onClick={onClose}>閉じる</button>
        )}
      </form>
      {message && <p className="free-view-search-message" aria-live="polite">{message}</p>}
      {retryLocation && !busy && (
        <button
          type="button"
          className="free-view-search-retry"
          onClick={() => {
            const run = guard.begin();
            setBusy(true);
            void placeObserver(retryLocation, run);
          }}
        >高さの取得を再試行</button>
      )}
      {candidates.length > 0 && (
        <ul className="free-view-search-candidates">
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              <button type="button" onClick={() => chooseCandidate(candidate)}>
                <strong>{candidate.name}</strong>
                <span>
                  {[candidate.kind, candidate.detail,
                    candidate.distanceKm !== undefined ? `${candidate.distanceKm}km` : ""]
                    .filter(Boolean).join("・")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <small className="free-view-search-credit">地名検索：© OpenStreetMap contributors（Nominatim・Photon）/ 国土地理院</small>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import type { GroundPoint } from "../types/points";
import type { SubjectRecord } from "../subjectStorage";
import { toUserFacingErrorMessage } from "../errors/userFeedback";
import { isAbortError } from "../utils/runtimeErrors";

type Props = {
  open: boolean;
  onBack: () => void;
  onLocatePin: (
    target: "subject" | "tripod",
    query: string,
    signal: AbortSignal,
    onProgress: (message: string, percent: number) => void
  ) => Promise<void>;
  currentSubject: GroundPoint | null;
  history: SubjectRecord[];
  favorites: SubjectRecord[];
  currentSubjectIsFavorite: boolean;
  onSelectStoredSubject: (record: SubjectRecord) => void;
  onToggleCurrentFavorite: () => void;
  onToggleFavorite: (record: SubjectRecord) => void;
  onRenameFavorite: (id: string, label: string) => void;
  justRegisteredFavoriteId: { token: number; id: string } | null;
  /** 2026-09-05追記: 三脚候補データ（方位プロファイル事前計算）が有効な被写体id一覧。 */
  bearingProfileEnabledIds: ReadonlySet<string>;
  /** 三脚候補データのダウンロードを（確認ダイアログ経由で）申し込む。 */
  onRequestBearingProfileDownload: (record: SubjectRecord) => void;
  /** お気に入りは残したまま、三脚候補データだけ端末から削除する。 */
  onDeleteBearingProfileData: (record: SubjectRecord) => void;
};

/**
 * 場所・被写体を探すためのスポット検索。
 * 日時・天体・構図候補の検索はメイン画面の専用機能へ集約し、この画面では
 * 地名／共有URLから2D地図上の被写体または三脚位置を決めることだけを扱う。
 */
export function SpotSearchScreen({
  open,
  onBack,
  onLocatePin,
  currentSubject,
  history,
  favorites,
  currentSubjectIsFavorite,
  onSelectStoredSubject,
  onToggleCurrentFavorite,
  onToggleFavorite,
  onRenameFavorite,
  justRegisteredFavoriteId,
  bearingProfileEnabledIds,
  onRequestBearingProfileDownload,
  onDeleteBearingProfileData,
}: Props) {
  const [query, setQuery] = useState("");
  const [pinTarget, setPinTarget] = useState<"subject" | "tripod">("subject");
  const [subjectListOpen, setSubjectListOpen] = useState<"history" | "favorites" | null>(null);
  const [editingFavoriteId, setEditingFavoriteId] = useState<string | null>(null);
  const [editingFavoriteLabel, setEditingFavoriteLabel] = useState("");
  const [message, setMessage] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!justRegisteredFavoriteId) return;
    setSubjectListOpen("favorites");
    const registered = favorites.find((item) => item.id === justRegisteredFavoriteId.id);
    setEditingFavoriteId(justRegisteredFavoriteId.id);
    setEditingFavoriteLabel(registered?.label ?? "");
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [justRegisteredFavoriteId?.token]);

  useEffect(() => {
    if (!open) {
      controllerRef.current?.abort();
      controllerRef.current = null;
      return;
    }
    setMessage("");
    setProgressPercent(0);
    setSubjectListOpen(null);
  }, [open]);

  function startEditingFavorite(record: SubjectRecord): void {
    setEditingFavoriteId(record.id);
    setEditingFavoriteLabel(record.label);
  }

  function commitFavoriteRename(): void {
    if (editingFavoriteId) onRenameFavorite(editingFavoriteId, editingFavoriteLabel);
    setEditingFavoriteId(null);
    setEditingFavoriteLabel("");
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setMessage("地名またはGoogleマップ共有URLを入力してください");
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsSearching(true);
    setProgressPercent(0);
    setMessage(pinTarget === "subject" ? "被写体の場所を検索しています…" : "三脚位置を検索しています…");
    try {
      await onLocatePin(pinTarget, trimmedQuery, controller.signal, (nextMessage, percent) => {
        if (controller.signal.aborted) return;
        setMessage(nextMessage);
        setProgressPercent(Math.min(100, Math.max(0, percent)));
      });
    } catch (error) {
      if (isAbortError(error)) return;
      setMessage(toUserFacingErrorMessage(
        error,
        /^https?:\/\//i.test(trimmedQuery) ? "google-maps-url" : "spot-search"
      ));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setIsSearching(false);
      }
    }
  }

  function closeScreen(): void {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setIsSearching(false);
    onBack();
  }

  if (!open) return null;

  const listedSubjects = subjectListOpen === "history" ? history : favorites;

  return (
    <section className="spot-search-screen" aria-label="スポット検索">
      <header className="spot-search-header">
        <button type="button" onClick={closeScreen} aria-label="メイン画面へ戻る">
          <span aria-hidden="true">‹</span>
          戻る
        </button>
        <h1>スポット検索</h1>
        <span aria-hidden="true" />
      </header>

      <form className="spot-search-content" onSubmit={(event) => void submit(event)}>
        <fieldset className="spot-pin-target-group">
          <legend>検索結果を置くピン</legend>
          <div className="spot-pin-target-options">
            <label className={pinTarget === "subject" ? "selected" : ""}>
              <input type="radio" name="spot-pin-target" value="subject" checked={pinTarget === "subject"} onChange={() => setPinTarget("subject")} />
              <span>被写体</span>
            </label>
            <label className={pinTarget === "tripod" ? "selected" : ""}>
              <input type="radio" name="spot-pin-target" value="tripod" checked={pinTarget === "tripod"} onChange={() => setPinTarget("tripod")} />
              <span>三脚位置</span>
            </label>
          </div>
        </fieldset>

        <div className="spot-subject-search-block">
          <label className="spot-search-field">
            <span>スポット名</span>
            <div className="spot-subject-input-row">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="地名 / Googleマップ共有URL"
                autoComplete="off"
                disabled={isSearching}
              />
              <button type="button" className={currentSubjectIsFavorite ? "spot-subject-icon active" : "spot-subject-icon"} aria-label="現在の被写体をお気に入り登録" disabled={pinTarget !== "subject" || !currentSubject} onClick={onToggleCurrentFavorite}>★</button>
              <button type="button" className="spot-subject-icon" aria-label="お気に入りを表示" disabled={pinTarget !== "subject"} onClick={() => setSubjectListOpen((value) => value === "favorites" ? null : "favorites")}>☆</button>
              <button type="button" className="spot-subject-icon" aria-label="検索履歴を表示" disabled={pinTarget !== "subject"} onClick={() => setSubjectListOpen((value) => value === "history" ? null : "history")}>◷</button>
            </div>
          </label>

          {subjectListOpen && (
            <section className="spot-subject-list" aria-label={subjectListOpen === "history" ? "検索履歴" : "お気に入り"}>
              <header>
                <strong>{subjectListOpen === "history" ? "最近の検索" : "お気に入り"}</strong>
                <button type="button" onClick={() => setSubjectListOpen(null)} aria-label="閉じる">×</button>
              </header>
              {listedSubjects.length === 0 ? (
                <p>{subjectListOpen === "history" ? "検索履歴はありません" : "お気に入りはありません"}</p>
              ) : listedSubjects.map((record) => (
                <div className="spot-subject-list-item" key={record.id}>
                  {subjectListOpen === "favorites" && editingFavoriteId === record.id ? (
                    <div className="spot-list-favorite-rename">
                      <input
                        autoFocus
                        type="text"
                        value={editingFavoriteLabel}
                        onChange={(event) => setEditingFavoriteLabel(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitFavoriteRename();
                          }
                        }}
                        placeholder="名称"
                        aria-label="お気に入りの名称"
                      />
                      <button type="button" onClick={commitFavoriteRename} aria-label="名称を保存">✓</button>
                      <button type="button" aria-label="編集をキャンセル" onClick={() => { setEditingFavoriteId(null); setEditingFavoriteLabel(""); }}>×</button>
                    </div>
                  ) : (
                    <>
                      <button type="button" onClick={() => onSelectStoredSubject(record)}>
                        <strong>{record.label}</strong>
                        <small>{record.latitude.toFixed(6)}, {record.longitude.toFixed(6)}</small>
                      </button>
                      {subjectListOpen === "favorites" && (
                        <button type="button" className="spot-list-rename" aria-label="名称を編集" onClick={() => startEditingFavorite(record)}>✎</button>
                      )}
                      {subjectListOpen === "favorites" && (
                        bearingProfileEnabledIds.has(record.id) ? (
                          <button
                            type="button"
                            className="spot-list-rolling-window active"
                            aria-label="三脚候補データを端末から削除"
                            title="三脚候補データを保存済み（タップで削除）"
                            onClick={() => onDeleteBearingProfileData(record)}
                          >
                            ⬇︎
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="spot-list-rolling-window"
                            aria-label="三脚候補データを端末に保存"
                            title="三脚候補データを端末に保存"
                            onClick={() => onRequestBearingProfileDownload(record)}
                          >
                            ⬇
                          </button>
                        )
                      )}
                      <button type="button" className="spot-list-favorite" aria-label="お気に入り切替" onClick={() => onToggleFavorite(record)}>
                        {favorites.some((favorite) => favorite.id === record.id) ? "★" : "☆"}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>

        <p className="project-dialog-note">
          ここでは場所だけを検索します。日時・天体・構図の検索はメイン画面の時間軸と天体検索を使用してください。
        </p>

        <div className="spot-search-action-row">
          <button className="spot-search-submit" type="submit" disabled={isSearching}>
            {isSearching ? "検索中…" : pinTarget === "subject" ? "被写体を検索して表示" : "三脚位置を検索して表示"}
          </button>
        </div>

        {isSearching && (
          <div className="celestial-transit-progress spot-search-progress" role="progressbar" aria-label="スポット検索進捗" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
            <div className="celestial-transit-progress-track" aria-hidden="true">
              <span style={{ width: `${progressPercent}%` }} />
            </div>
            <strong>{progressPercent}%</strong>
          </div>
        )}
        {message && <p className="spot-search-message" aria-live="polite">{message}</p>}
        <small className="spot-search-credit">地名検索：© OpenStreetMap contributors / 国土地理院</small>
      </form>
    </section>
  );
}

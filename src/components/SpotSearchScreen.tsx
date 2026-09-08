import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import type { GroundPoint } from "../types/points";
import type { SubjectRecord } from "../subjectStorage";
import { toUserFacingErrorMessage } from "../errors/userFeedback";
import { isAbortError } from "../utils/runtimeErrors";
import type { DownloadedSpotDataRecord } from "../cache/downloadedSpotData";
import type { DownloadedSpotStorageSummary } from "../cache/downloadedSpotDataStats";

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
  onSelectDownloadedSpotData: (record: DownloadedSpotDataRecord) => void;
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
  downloadedSpotData: DownloadedSpotDataRecord[];
  downloadedSpotStorageSummary: DownloadedSpotStorageSummary | null;
  onDeleteDownloadedSpotData: (record: DownloadedSpotDataRecord) => void;
  onDeleteDownloadedSpotDataBulk: (records: DownloadedSpotDataRecord[]) => void;
  onRefreshDownloadedSpotData: (record: DownloadedSpotDataRecord) => void;
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
  onSelectDownloadedSpotData,
  onToggleCurrentFavorite,
  onToggleFavorite,
  onRenameFavorite,
  justRegisteredFavoriteId,
  bearingProfileEnabledIds,
  onRequestBearingProfileDownload,
  onDeleteBearingProfileData,
  downloadedSpotData,
  downloadedSpotStorageSummary,
  onDeleteDownloadedSpotData,
  onDeleteDownloadedSpotDataBulk,
  onRefreshDownloadedSpotData,
}: Props) {
  const [query, setQuery] = useState("");
  const [pinTarget, setPinTarget] = useState<"subject" | "tripod">("subject");
  const [subjectListOpen, setSubjectListOpen] = useState<"history" | "favorites" | "downloads" | null>(null);
  const [editingFavoriteId, setEditingFavoriteId] = useState<string | null>(null);
  const [editingFavoriteLabel, setEditingFavoriteLabel] = useState("");
  const [message, setMessage] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [selectedDownloadedIds, setSelectedDownloadedIds] = useState<Set<string>>(new Set());
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
    setSelectedDownloadedIds(new Set());
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

  function formatBytes(bytes: number | null | undefined): string {
    if (bytes == null || !Number.isFinite(bytes)) return "未計測";
    if (bytes < 1024) return `${Math.round(bytes)}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
  }

  function toggleDownloadedSelection(subjectId: string): void {
    setSelectedDownloadedIds((current) => {
      const next = new Set(current);
      if (next.has(subjectId)) next.delete(subjectId); else next.add(subjectId);
      return next;
    });
  }

  function deleteSelectedDownloads(): void {
    const selected = downloadedSpotData.filter((record) => selectedDownloadedIds.has(record.subjectId));
    if (selected.length === 0) return;
    if (!window.confirm(`選択した${selected.length}スポットのダウンロードデータを削除しますか？`)) return;
    onDeleteDownloadedSpotDataBulk(selected);
    setSelectedDownloadedIds(new Set());
  }

  function deleteAllDownloads(): void {
    if (downloadedSpotData.length === 0) return;
    if (!window.confirm(`ダウンロード済み${downloadedSpotData.length}スポットのデータをすべて削除しますか？`)) return;
    onDeleteDownloadedSpotDataBulk(downloadedSpotData);
    setSelectedDownloadedIds(new Set());
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
              <button type="button" className="spot-subject-icon" aria-label="ダウンロード済みデータを表示" disabled={pinTarget !== "subject"} onClick={() => setSubjectListOpen((value) => value === "downloads" ? null : "downloads")}>⇩</button>
            </div>
          </label>

          {subjectListOpen && (
            <section className="spot-subject-list" aria-label={subjectListOpen === "history" ? "検索履歴" : subjectListOpen === "favorites" ? "お気に入り" : "ダウンロード済みデータ"}>
              <header>
                <strong>{subjectListOpen === "history" ? "最近の検索" : subjectListOpen === "favorites" ? "お気に入り" : "ダウンロード済みデータ"}</strong>
                <button type="button" onClick={() => setSubjectListOpen(null)} aria-label="閉じる">×</button>
              </header>
              {subjectListOpen === "downloads" ? (
                downloadedSpotData.length === 0 ? <p>ダウンロード済みデータはありません</p> : <>
                  <div className="spot-downloaded-data-summary">
                    <strong>{downloadedSpotData.length}スポット / 管理対象 {formatBytes(downloadedSpotStorageSummary?.uniqueManagedBytes)}</strong>
                    <small>DEM {formatBytes(downloadedSpotStorageSummary?.uniqueDemBytes)} ・ 地形プロファイル {formatBytes(downloadedSpotStorageSummary?.profileBytes)} ・ OSM/水面 {formatBytes(downloadedSpotStorageSummary?.uniqueSiteContextBytes)}</small>
                    {downloadedSpotStorageSummary?.originUsageBytes != null && (
                      <small>AstroSight全体の端末使用量 {formatBytes(downloadedSpotStorageSummary.originUsageBytes)}{downloadedSpotStorageSummary.originQuotaBytes != null ? ` / 利用可能枠 ${formatBytes(downloadedSpotStorageSummary.originQuotaBytes)}` : ""}</small>
                    )}
                    <div className="spot-downloaded-data-actions">
                      <button type="button" disabled={selectedDownloadedIds.size === 0} onClick={deleteSelectedDownloads}>選択削除 ({selectedDownloadedIds.size})</button>
                      <button type="button" onClick={deleteAllDownloads}>全削除</button>
                    </div>
                  </div>
                  {downloadedSpotData.map((record) => {
                    const stats = downloadedSpotStorageSummary?.bySubjectId[record.subjectId];
                    const stateLabel = stats?.state === "complete" ? "保存完了" : stats?.state === "needs-update" ? "更新が必要" : "一部不足";
                    return (
                  <div className="spot-subject-list-item spot-downloaded-data-item" key={record.subjectId}>
                    <label className="spot-download-select" aria-label={`${record.label}を選択`}>
                      <input type="checkbox" checked={selectedDownloadedIds.has(record.subjectId)} onChange={() => toggleDownloadedSelection(record.subjectId)} />
                    </label>
                    <button type="button" onClick={() => onSelectDownloadedSpotData(record)}>
                      <strong>{record.label} <span className={`spot-download-state ${stats?.state ?? "partial"}`}>{stateLabel}</span></strong>
                      <small>高精度DEM {record.highPrecisionPoints.toLocaleString()}点 / 地形 {record.profilePoints.toLocaleString()}点</small>
                      <small>DEM {formatBytes(stats?.demBytes ?? record.demTileBytes)} / {stats?.demLiveTiles ?? record.demTileCount ?? 0}タイル ・ 地形プロファイル {formatBytes(stats?.profileBytes)} / {stats?.profileEntries ?? 0}方位</small>
                      <small>OSM・水面 {formatBytes(stats?.siteContextBytes)} / {stats?.siteContextLiveCount ?? 0}件</small>
                      <small>{new Date(record.downloadedAtIso).toLocaleString()} ・ {favorites.some((favorite) => favorite.id === record.subjectId) ? "お気に入り登録済み" : "お気に入り未登録"}</small>
                    </button>
                    <div className="spot-downloaded-data-item-actions">
                      <button type="button" aria-label="ダウンロードデータを更新" onClick={() => onRefreshDownloadedSpotData(record)}>更新</button>
                      <button type="button" aria-label="ダウンロード済みデータを削除" onClick={() => onDeleteDownloadedSpotData(record)}>削除</button>
                    </div>
                  </div>
                    );
                  })}
                </>
              ) : listedSubjects.length === 0 ? (
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

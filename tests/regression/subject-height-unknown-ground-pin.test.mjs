import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SubjectRoofResolutionError,
  selectSubjectSurfacePoint,
} from "../../src/height/subjectSurfaceResolution.ts";
import { spotSearchErrorDetail, toUserFacingErrorMessage } from "../../src/errors/userFeedback.ts";

const ground = {
  latitude: 35.1, longitude: 136.9, height: 40,
  ellipsoidalHeightMeters: 40, orthometricHeightMeters: 3, geoidHeightMeters: 37,
  heightSource: "dem", label: "建物 地表",
};

test("the cause: an unresolved building height used to surface as a network error", () => {
  // 高さの候補が1つも無い建物は、判定関数としては従来どおり失敗を返す。
  let thrown = null;
  try {
    selectSubjectSurfacePoint({ groundPoint: ground, roofPoint: null, osmPoint: null, requireStructureRoof: true, label: "ある建物" });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof SubjectRoofResolutionError);
  // この失敗が画面まで届くと、通信に問題が無くても通信エラーの文言になっていた。
  // 一律の文言は残るが、実際の理由が後ろに付く。
  const shown = toUserFacingErrorMessage(thrown, "spot-search");
  assert.equal(shown, "必要なデータを通信先から取得できませんでした。通信状態を確認して、もう一度お試しください。");
  // 実際の理由は画面に出さず、「詳細をコピー」の中身に入る。
  assert.match(spotSearchErrorDetail(thrown, "spot-search"), /ある建物の頂上高度を確認できなかったため、地上には被写体ピンを配置しませんでした。/);
});

test("spot-search errors show the real reason and its cause; other screens are unchanged", () => {
  // 標高を取れなかった場合: 包んだエラーの原因までたどって表示する。
  const cause = new Error("国土地理院標高APIがタイムアウトしました");
  const wrapped = new Error("塔 地表の高度を取得できないため計算を中止しました。通信状態を確認して再試行してください。", { cause });
  const shown = toUserFacingErrorMessage(wrapped, "spot-search");
  assert.match(shown, /^必要なデータを通信先から取得できませんでした。/);
  assert.doesNotMatch(shown, /詳細|原因|API/);
  const detail = spotSearchErrorDetail(wrapped, "spot-search");
  assert.match(detail, /エラー内容: 塔 地表の高度を取得できないため計算を中止しました。/);
  assert.match(detail, /原因1: 国土地理院標高APIがタイムアウトしました/);
  // アドレスは接続先の名前だけ残し、経路・条件は伏せる。
  const withUrl = spotSearchErrorDetail(new Error("failed https://example.com/api/x?lat=35.1&key=abc now"), "spot-search");
  assert.match(withUrl, /https:\/\/example\.com\/… now/);
  assert.doesNotMatch(withUrl, /lat=|key=/);

  // 通信と無関係な失敗（端末の保存領域が満杯など）も理由が分かる。
  assert.equal(
    toUserFacingErrorMessage(new Error("The quota has been exceeded."), "spot-search"),
    "スポット検索を完了できませんでした。入力内容と通信状態を確認して、もう一度お試しください。"
  );
  assert.match(spotSearchErrorDetail(new Error("The quota has been exceeded."), "spot-search"), /The quota has been exceeded\./);
  // 内部メッセージをそのまま出している場合は、同じ文を重ねない。
  assert.equal(
    toUserFacingErrorMessage(new Error("指定したスポットが見つかりませんでした"), "spot-search"),
    "指定したスポットが見つかりませんでした"
  );
  assert.equal(spotSearchErrorDetail(new Error("指定したスポットが見つかりませんでした"), "spot-search"), null);
  // 長すぎる詳細は切り詰める。メッセージの無いエラーには何も付けない。
  const long = spotSearchErrorDetail(new Error("通信" + "あ".repeat(5000)), "spot-search");
  assert.ok(long.length <= 2000);
  assert.equal(spotSearchErrorDetail(null, "spot-search"), null);
  assert.equal(
    toUserFacingErrorMessage(null, "spot-search"),
    "スポット検索を完了できませんでした。入力内容と通信状態を確認して、もう一度お試しください。"
  );
  // スポット検索以外の画面の文言は変えていない。
  assert.equal(
    toUserFacingErrorMessage(wrapped, "preview"),
    "必要なデータを通信先から取得できませんでした。通信状態を確認して、もう一度お試しください。"
  );
});

test("when the height is unknown the subject pin goes on the ground and a closable notice says so", async () => {
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const notice = await readFile(new URL("../../src/components/UserNotice.tsx", import.meta.url), "utf8");

  // 高さを確定できなかった最後の段階で、失敗させずに地上のピンを返す。
  assert.doesNotMatch(app, /if \(!registeredAnchor\) throw error;/);
  assert.match(app, /return placeSubjectOnGroundBecauseHeightUnknown\(groundPoint, label\);\s*\}\s*\}\s*function placeSubjectOnGroundBecauseHeightUnknown/);
  // 内蔵スポットは、学習済みの高さがあればそれを先に使う（無ければ地上）。
  assert.match(app, /return resolveRegisteredStructureWithoutLiveHeight\(registeredAnchor, groundPoint, label\);\s*\} catch \(learnedError\) \{\s*if \(!\(learnedError instanceof SubjectRoofResolutionError\)\) throw learnedError;/);
  // 高さ不明以外の失敗（標高が取れない等）は、従来どおり失敗として扱う。
  assert.match(app, /if \(!\(error instanceof SubjectRoofResolutionError\)\) throw error;/);

  const body = app.slice(app.indexOf("function placeSubjectOnGroundBecauseHeightUnknown"));
  const fn = body.slice(0, body.indexOf("\n  }\n") + 5);
  // その旨を通知する。
  assert.match(fn, /showUserNotice\(\{\s*key: "subject-height-unknown",\s*tone: "warning",/);
  assert.match(fn, /高さを確認できなかったため、地上に被写体ピンを置きました/);
  // 置いたピンは地表として扱い、建物の頂上として保存しない。高さの推測値も付けない。
  assert.match(fn, /subjectSurfaceTarget: "terrain",\s*structureHeightMeters: undefined,/);
  assert.doesNotMatch(fn, /withVerticalOffset|knownStructureHeightMeters/);

  // 通知は必ず閉じられる: ×ボタンがあり、押すと通知を消す。
  assert.match(notice, /onClick=\{onDismiss\}\s*aria-label="通知を閉じる"/);
  assert.match(app, /onDismiss=\{\(\) => setUserNotice\(null\)\}/);
});

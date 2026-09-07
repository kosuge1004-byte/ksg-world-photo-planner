import {
  Cartesian2,
  Cartesian3,
  Cesium3DTileset,
  Cesium3DTileStyle,
  CesiumTerrainProvider,
  Ellipsoid,
  ImageryLayer,
  Ion,
  IonResource,
  IonGeocodeProviderType,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  Viewer,
} from "cesium";

import type { AccuracyMode } from "../types/precision";
import { markAsGoogleTileset } from "./googleTilesetMarker";
import { pickSceneSurfacePosition } from "./surfacePicking";
import {
  CESIUM_ION_USAGE_STOP_THRESHOLD,
  CESIUM_ION_USAGE_WARNING_THRESHOLD,
  CesiumIonRootTileLimitError,
  startCesiumIonRootTilesetRequest,
} from "../precision/cesiumIonConnection";
import { publishUserNotice } from "../errors/userFeedback";

export type GooglePhotorealisticTileset = Cesium3DTileset;

const TILESET_INITIALIZATION_TIMEOUT_MS = 35_000;
const TILESET_INITIALIZATION_ATTEMPTS = 2;
const GSI_STANDARD_TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png";
const PLATEAU_BUILDINGS_TILESET_URL =
  "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-maxlod2-latest/tileset.json";
const PLATEAU_TERRAIN_URL = "https://tile.plateauview.mlit.go.jp/terrain/";

/**
 * PLATEAU建物タイルセットを読み込む（標準モードの表示専用）。
 * 遮蔽判定には接続しない（2026-08-06付けの過去の決定と同じ方針。
 * 遮蔽判定へPLATEAUを再接続する試みは検証ロジックが機能しない疑いがあり撤回した）。
 */
export async function loadPlateauBuildingsTileset(): Promise<Cesium3DTileset> {
  const buildings = await Cesium3DTileset.fromUrl(PLATEAU_BUILDINGS_TILESET_URL, {
    // 2026-09-02追記: 三脚候補探索中だけプレビューをワイヤーフレーム表示に
    // 切り替えるため（重い探索と通信を取り合わないよう、建物テクスチャの
    // 読み込みを一時的に省略する目的）。debugWireframeは作成後に動的に
    // ON/OFFできるが、そのためにはWebGL1環境向けにこのフラグを作成時に
    // 立てておく必要がある（Cesium公式の制約）。
    enableDebugWireframe: true,
  });
  buildings.show = false;
  buildings.maximumScreenSpaceError = 8;
  buildings.dynamicScreenSpaceError = true;
  buildings.skipLevelOfDetail = true;
  buildings.preferLeaves = true;
  buildings.show = true;
  return buildings;
}

const HIDDEN_PLATEAU_HEIGHT_LOOKUP_MARKER = Symbol("astrosight-hidden-plateau-height-lookup");
export { HIDDEN_PLATEAU_HEIGHT_LOOKUP_MARKER };

/**
 * Googleタイルモード（Google Photorealistic 3D Tiles）では、Googleの利用規約により
 * その形状データを検索・高さ判定に使えないため、被写体ピンを建物の屋根に
 * 合わせる機能（resolvePlateauRoofGroundPoint）専用に、完全に透明な
 * PLATEAU建物タイルセットを別途・追加で読み込む。画面には一切表示されない
 * （Googleタイルの見た目はそのまま）。既に読み込み済みなら何もしない。
 */
export async function ensureHiddenPlateauBuildingsForHeightLookup(
  viewer: Viewer
): Promise<void> {
  const alreadyLoaded = viewer.scene.primitives.length > 0 &&
    (() => {
      for (let i = 0; i < viewer.scene.primitives.length; i += 1) {
        const primitive = viewer.scene.primitives.get(i) as unknown as Record<symbol, boolean>;
        if (primitive[HIDDEN_PLATEAU_HEIGHT_LOOKUP_MARKER]) return true;
      }
      return false;
    })();
  if (alreadyLoaded) return;

  const buildings = await Cesium3DTileset.fromUrl(PLATEAU_BUILDINGS_TILESET_URL);
  buildings.maximumScreenSpaceError = 32;
  buildings.dynamicScreenSpaceError = true;
  buildings.skipLevelOfDetail = true;
  buildings.preferLeaves = true;
  buildings.style = new Cesium3DTileStyle({ color: 'color("white", 0)' });
  (buildings as unknown as Record<symbol, boolean>)[HIDDEN_PLATEAU_HEIGHT_LOOKUP_MARKER] = true;
  if (viewer.isDestroyed()) {
    buildings.destroy();
    return;
  }
  viewer.scene.primitives.add(buildings);
}

/**
 * 2026-09-02追記: 重い三脚候補探索（数十秒規模の通信）が走っている間だけ、
 * プレビューの見た目を「形だけ」（建物はワイヤーフレーム、地面は画像
 * テクスチャ無しの単色陰影）に切り替え、画像・テクスチャの読み込み自体を
 * 省略することで、候補探索側の通信と取り合わないようにする。探索が
 * 終わったら通常の見た目へ戻す。座標・高さ計算には一切関与しない、
 * 純粋に見た目だけの切り替え。
 * - 建物（PLATEAU）: Cesium3DTileset.debugWireframe（公式のデバッグ用
 *   プロパティ。loadPlateauBuildingsTilesetでenableDebugWireframe: true
 *   を作成時に指定済みなので動的に切り替えられる）。Googleタイル
 *   モードの建物（Google Photorealistic 3D Tiles）は対象外とする
 *   （Googleの利用規約上の制約が既にあるこの3Dデータには、通常の見た目
 *   から外れる追加の操作をしない）。
 * - 地面: 画像レイヤー（GSI標準地図等）を一時的に非表示にし、Globeの
 *   単色陰影だけで地形の起伏を見せる。地形メッシュ自体（Globe.show）は
 *   変更しないため、高さ・位置は普段どおり正しく描画される。
 */
export function setPreviewWireframeMode(viewer: Viewer, enabled: boolean): void {
  if (viewer.isDestroyed()) return;
  for (let index = 0; index < viewer.scene.primitives.length; index += 1) {
    const primitive = viewer.scene.primitives.get(index) as unknown as
      | (Cesium3DTileset & Record<symbol, boolean>)
      | undefined;
    if (!primitive || typeof primitive.debugWireframe !== "boolean") continue;
    if (primitive[HIDDEN_PLATEAU_HEIGHT_LOOKUP_MARKER]) continue; // 当たり判定専用の透明タイルセットは対象外
    primitive.debugWireframe = enabled;
  }
  // 2026-09-05修正（実機報告：「プレビューが表示されない／真っ黒になる」）:
  // 以前はここで地面の画像レイヤー（imageryLayers）自体をshow=falseで
  // 完全に非表示にしていた。これは「ワイヤーフレーム（形だけ）表示」という
  // コメントの意図に反し、実際には地面の色・写真が何も無い状態
  // （Cesiumのデフォルト背景色＝ほぼ黒）になり、時間スライダーを動かす
  // たびに毎回発生する三脚候補探索の間、プレビュー・3D地図（2D表示中は
  // 隠れているはずのプレビューが対象）が丸ごと真っ黒に見える不具合の
  // 直接の原因になっていた。建物3Dタイルセットのワイヤーフレーム化
  // （上のループ）だけで十分に軽量化の目的は果たせるため、地面の
  // 画像レイヤーを隠す処理自体を廃止する。
}

const GOOGLE_PHOTOREALISTIC_ION_ASSET_ID = 2275207;
let googlePhotorealisticIonResourcePromise: ReturnType<typeof IonResource.fromAssetId> | undefined;

function getGooglePhotorealisticIonResource() {
  // CesiumJS 1.143 の createGooglePhotorealistic3DTileset() と同じ ion asset を使う。
  // Cesium公式実装はこの metadata/endpoint 解決を終えた後に
  // Cesium3DTileset.fromUrl(resource) で root tileset を要求する。
  // root quota と無関係な endpoint 解決失敗を誤カウントしないよう、同じ順序を明示する。
  googlePhotorealisticIonResourcePromise ??= IonResource.fromAssetId(
    GOOGLE_PHOTOREALISTIC_ION_ASSET_ID
  );
  return googlePhotorealisticIonResourcePromise;
}

async function createPhotorealisticTilesetWithTimeout(): Promise<GooglePhotorealisticTileset> {
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  // CesiumJS 1.143 の実装順に合わせ、まず ion asset endpoint を解決する。
  // ここで失敗した場合は Google root tileset request はまだ開始されていないため、
  // AstroSight の root カウンターは増やさない。
  const rootResource = await getGooglePhotorealisticIonResource();

  let usageCount: number;
  let request: Promise<Cesium3DTileset>;
  try {
    const started = startCesiumIonRootTilesetRequest(() =>
      Cesium3DTileset.fromUrl(rootResource, {
        // CesiumJS createGooglePhotorealistic3DTileset() の既定値を維持する。
        cacheBytes: 1536 * 1024 * 1024,
        maximumCacheOverflowBytes: 1024 * 1024 * 1024,
        enableCollision: true,
        // Google Map Tiles API Policies に従い、帰属表示を常時有効化する。
        showCreditsOnScreen: true,
      })
    );
    request = started.request;
    usageCount = started.count;
  } catch (error) {
    if (error instanceof CesiumIonRootTileLimitError) {
      publishUserNotice({
        key: "cesium-ion-root-limit",
        tone: "warning",
        prominent: true,
        message: `${error.message} ※同じCesium ionアカウントを複数端末で使用している場合、他端末の利用分はこの端末では把握できません。実際の利用量はCesium ionのUsage画面も確認してください。`,
      });
    }
    throw error;
  }

  if (usageCount === CESIUM_ION_USAGE_WARNING_THRESHOLD) {
    publishUserNotice({
      key: "cesium-ion-root-warning-500",
      tone: "warning",
      prominent: true,
      message: `Google 3Dマップの今月のroot取得カウントが${usageCount}回に達しました。${CESIUM_ION_USAGE_STOP_THRESHOLD}回に達すると、無料枠保護のため新しいGoogleタイル取得を停止します。※同じCesium ionアカウントを複数端末で使用している場合、他端末の利用分はこの端末では把握できません。実際の利用量はCesium ionのUsage画面も確認してください。`,
    });
  } else if (usageCount === CESIUM_ION_USAGE_STOP_THRESHOLD) {
    publishUserNotice({
      key: "cesium-ion-root-reached-800",
      tone: "warning",
      prominent: true,
      message: `Google 3Dマップの今月の安全利用上限（${usageCount}回）に達しました。現在開始したGoogleタイルはそのまま表示できますが、これ以降の新しいroot取得は翌月まで停止します。※同じCesium ionアカウントを複数端末で使用している場合、他端末の利用分はこの端末では把握できません。実際の利用量はCesium ionのUsage画面も確認してください。`,
    });
  }

  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error("Google 3Dタイル初期化がタイムアウトしました"));
        }, TILESET_INITIALIZATION_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      void request.then((tileset) => tileset.destroy()).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function createStandardViewer(
  container: HTMLDivElement,
  setStatus: (message: string) => void,
  terrainShadingEnabled: boolean
): Promise<Viewer> {
  const baseLayer = new ImageryLayer(new UrlTemplateImageryProvider({
    url: GSI_STANDARD_TILE_URL,
    credit: "地理院タイル（国土地理院）",
    maximumLevel: 18,
  }));

  // 地形（Viewer構築に必須）とPLATEAU建物タイルセット（表示専用、地形とは
  // 別エンドポイントで地形の結果に依存しない）を並行して取得開始する。
  // 建物を実際にシーンへ追加するかどうかは従来どおり地形の取得成功に
  // 依存させる（両者とも楕円体高基準で、垂直方向の整合を前提としている
  // ため）が、取得そのものを直列に待つ理由はない。読み込み内容・精度・
  // 表示条件は変更しない。
  setStatus("標準3D：PLATEAU地形を読み込み中…");
  // 2026-09-02追記（明示指示により）: requestVertexNormals（陰影計算用の
  // 法線データ）は既定でOFFにし、1タイルあたりの転送量を減らす。地形の
  // 高さ・形状データ自体（標高値）には一切影響しない。精度設定から
  // ONにすると陰影表現が戻る。
  const terrainProviderPromise = CesiumTerrainProvider.fromUrl(PLATEAU_TERRAIN_URL, {
    requestVertexNormals: terrainShadingEnabled,
  });
  const plateauBuildingsPromise = loadPlateauBuildingsTileset();
  // 先行取得中のPLATEAU建物リクエストの失敗を、地形の結果を待つ間に
  // 未処理のPromise rejectionとして表面化させない（実際のハンドリングは
  // 下の使用箇所で行う）。
  plateauBuildingsPromise.catch(() => undefined);

  let terrainProvider: CesiumTerrainProvider | undefined;
  try {
    terrainProvider = await terrainProviderPromise;
  } catch (error) {
    console.warn("PLATEAU terrain could not be loaded; PLATEAU buildings will be disabled.", error);
    setStatus("標準：PLATEAU地形未取得のため国土地理院地図で表示中");
  }

  const viewer = new Viewer(container, {
    baseLayer,
    terrainProvider,
    baseLayerPicker: false,
    geocoder: false,
    animation: false,
    fullscreenButton: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Number.POSITIVE_INFINITY,
  });

  viewer.scene.globe.show = true;
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.globe.enableLighting = true;

  // Display-only layer for standard mode. Do not use this tileset for height,
  // obstruction, line-of-sight, or search calculations. The building layer is
  // enabled only when PLATEAU-Terrain loaded successfully, because both use
  // ellipsoidal heights and are designed to align vertically.
  if (!terrainProvider) {
    // 地形が取得できなかった場合、先行取得していた建物タイルセットは
    // 使わずに破棄する（垂直方向の整合が取れないため表示しない方針は
    // 従来どおり変更しない）。
    void plateauBuildingsPromise
      .then((tileset) => tileset.destroy())
      .catch(() => undefined);
    return viewer;
  }

  try {
    setStatus("標準3D：PLATEAU建物を読み込み中…");
    const plateauBuildings = await plateauBuildingsPromise;

    viewer.scene.primitives.add(plateauBuildings);
    setStatus("標準3D：PLATEAU建物表示中（利用可能な最高LOD・テクスチャ優先）");
    viewer.scene.requestRender();
  } catch (error) {
    console.warn("PLATEAU buildings could not be loaded; continuing with GSI map only.", error);
    setStatus("標準：PLATEAU未取得のため国土地理院地図で表示中");
  }

  return viewer;
}

/**
 * Google Photorealistic 3D Tilesをタイムアウト＋リトライ付きで読み込む。
 * メイン3Dマップ（Googleタイルモード）とARカメラのオーバーレイの両方から呼ばれる
 * 唯一の場所とし、読み込み挙動（タイムアウト秒数・リトライ回数・調整パラメータ）
 * が両者でズレないようにする。呼び出し側でCesium ionトークンの設定は済ませておくこと。
 */
export async function loadGooglePhotorealisticTilesetWithRetry(
  setStatus: (message: string) => void
): Promise<GooglePhotorealisticTileset> {
  let tileset: GooglePhotorealisticTileset | null = null;
  for (let attempt = 1; attempt <= TILESET_INITIALIZATION_ATTEMPTS; attempt += 1) {
    try {
      tileset = await createPhotorealisticTilesetWithTimeout();
      break;
    } catch (error) {
      if (attempt === TILESET_INITIALIZATION_ATTEMPTS) throw error;
      setStatus("Google 3Dデータへ再接続中…");
      await new Promise<void>((resolve) => setTimeout(resolve, 900));
    }
  }
  if (!tileset) {
    throw new Error("Google 3Dタイルを初期化できませんでした");
  }
  tileset.maximumScreenSpaceError = 24;
  tileset.dynamicScreenSpaceError = true;
  return tileset;
}

async function createHighestPrecisionViewer(
  container: HTMLDivElement,
  token: string,
  setStatus: (message: string) => void
): Promise<Viewer> {
  if (!token) {
    throw new Error("Googleタイルモードの3D地図を開始するためのCesium ion設定が不足しています");
  }

  Ion.defaultAccessToken = token;

  const viewer = new Viewer(container, {
    globe: false,
    geocoder: IonGeocodeProviderType.GOOGLE,
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Number.POSITIVE_INFINITY,
  });

  let tileset: GooglePhotorealisticTileset;
  try {
    tileset = await loadGooglePhotorealisticTilesetWithRetry(setStatus);
  } catch (error) {
    viewer.destroy();
    throw error;
  }
  markAsGoogleTileset(tileset);
  viewer.scene.primitives.add(tileset);

  return viewer;
}

/**
 * 3Dマップをダブルタップ（ダブルクリック）した地点へ向けて寄る。
 * 標準・Googleタイルモードどちらの3Dビューアもここを通るため、両モードに共通で効く。
 * Cesiumデフォルトのダブルクリック挙動（ピンの追尾）は、意図せず視点が
 * 固定・追従してしまい紛らわしいため無効化した上で、この拡大操作に差し替える。
 */
function enableDoubleTapZoom(viewer: Viewer): void {
  viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement: { position: Cartesian2 }) => {
    if (viewer.isDestroyed()) return;
    const target =
      pickSceneSurfacePosition(viewer, movement.position) ??
      // Googleタイルモードはglobeを表示しない（globe: false）ためscene.globeが
      // undefinedになりうる。常に存在するWGS84楕円体定数を使う。
      viewer.camera.pickEllipsoid(movement.position, Ellipsoid.WGS84);
    if (!target) return;
    const camera = viewer.camera;
    // タップした地点へ向けて距離を半分に詰める（向きはそのまま）。
    const destination = Cartesian3.lerp(camera.position, target, 0.5, new Cartesian3());
    viewer.camera.flyTo({
      destination,
      orientation: {
        heading: camera.heading,
        pitch: camera.pitch,
        roll: camera.roll,
      },
      duration: 0.35,
    });
  }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
}

export async function createMapViewer(
  container: HTMLDivElement,
  token: string | undefined,
  accuracyMode: AccuracyMode,
  setStatus: (message: string) => void,
  terrainShadingEnabled = false
): Promise<Viewer> {
  const viewer = accuracyMode === "highest"
    ? await createHighestPrecisionViewer(container, token ?? "", setStatus)
    : await createStandardViewer(container, setStatus, terrainShadingEnabled);

  enableDoubleTapZoom(viewer);

  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(139.745433, 35.658581, 1200),
    orientation: {
      heading: CesiumMath.toRadians(20),
      pitch: CesiumMath.toRadians(-35),
      roll: 0,
    },
  });

  setStatus(
    accuracyMode === "highest"
      ? "Googleタイルモード：Google Photorealistic 3D Tiles 表示中"
      : "標準3D：国土地理院地図＋PLATEAU建物（表示専用）"
  );
  return viewer;
}

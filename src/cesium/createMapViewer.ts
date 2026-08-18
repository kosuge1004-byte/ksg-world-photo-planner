import {
  Cartesian2,
  Cartesian3,
  Cesium3DTileset,
  Cesium3DTileStyle,
  CesiumTerrainProvider,
  createGooglePhotorealistic3DTileset,
  Ellipsoid,
  ImageryLayer,
  Ion,
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

export type GooglePhotorealisticTileset = Awaited<
  ReturnType<typeof createGooglePhotorealistic3DTileset>
>;

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
  const buildings = await Cesium3DTileset.fromUrl(PLATEAU_BUILDINGS_TILESET_URL);
  buildings.show = false;
  buildings.maximumScreenSpaceError = 8;
  buildings.dynamicScreenSpaceError = true;
  buildings.skipLevelOfDetail = true;
  buildings.preferLeaves = true;
  buildings.show = true;
  return buildings;
}

const HIDDEN_PLATEAU_HEIGHT_LOOKUP_MARKER = Symbol("astrosight-hidden-plateau-height-lookup");

/**
 * 高精度モード（Google Photorealistic 3D Tiles）では、Googleの利用規約により
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

async function createPhotorealisticTilesetWithTimeout(): Promise<GooglePhotorealisticTileset> {
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const request = createGooglePhotorealistic3DTileset(
    {
      onlyUsingWithGoogleGeocoder: true,
    },
    {
      // Googleの公式ポリシー（Map Tiles API Policies）はCesiumJSでの利用時、
      // showCreditsOnScreenを有効にしてタイルの著作権表示を行うことを明示的に
      // 要求している。これを付けないと契約上必須の属性表示ができない。
      showCreditsOnScreen: true,
    }
  );
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
  setStatus: (message: string) => void
): Promise<Viewer> {
  const baseLayer = new ImageryLayer(new UrlTemplateImageryProvider({
    url: GSI_STANDARD_TILE_URL,
    credit: "地理院タイル（国土地理院）",
    maximumLevel: 18,
  }));

  let terrainProvider: CesiumTerrainProvider | undefined;
  try {
    setStatus("標準3D：PLATEAU地形を読み込み中…");
    terrainProvider = await CesiumTerrainProvider.fromUrl(PLATEAU_TERRAIN_URL, {
      requestVertexNormals: true,
    });
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
    return viewer;
  }

  try {
    setStatus("標準3D：PLATEAU建物を読み込み中…");
    const plateauBuildings = await loadPlateauBuildingsTileset();

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
 * メイン3Dマップ（高精度モード）とARカメラのオーバーレイの両方から呼ばれる
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
    throw new Error("高精度3D地図を開始するためのCesium ion設定が不足しています");
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
 * 標準・高精度モードどちらの3Dビューアもここを通るため、両モードに共通で効く。
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
      // 高精度モードはglobeを表示しない（globe: false）ためscene.globeが
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
  setStatus: (message: string) => void
): Promise<Viewer> {
  const viewer = accuracyMode === "highest"
    ? await createHighestPrecisionViewer(container, token ?? "", setStatus)
    : await createStandardViewer(container, setStatus);

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
      ? "高精度：Google Photorealistic 3D Tiles 表示中"
      : "標準3D：国土地理院地図＋PLATEAU建物（表示専用）"
  );
  return viewer;
}

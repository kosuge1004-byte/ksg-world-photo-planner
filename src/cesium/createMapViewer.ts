import {
  Cartesian3,
  Cesium3DTileStyle,
  Cesium3DTileset,
  createGooglePhotorealistic3DTileset,
  ImageryLayer,
  Ion,
  IonGeocodeProviderType,
  Math as CesiumMath,
  UrlTemplateImageryProvider,
  Viewer,
} from "cesium";

import type { AccuracyMode } from "../types/precision";

type GooglePhotorealisticTileset = Awaited<
  ReturnType<typeof createGooglePhotorealistic3DTileset>
>;

const TILESET_INITIALIZATION_TIMEOUT_MS = 35_000;
const TILESET_INITIALIZATION_ATTEMPTS = 2;
const GSI_STANDARD_TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png";
const PLATEAU_BUILDINGS_TILESET_URL =
  "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-lod1-2025/tileset.json";

async function createPhotorealisticTilesetWithTimeout(): Promise<GooglePhotorealisticTileset> {
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const request = createGooglePhotorealistic3DTileset({
    onlyUsingWithGoogleGeocoder: true,
  });
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

  const viewer = new Viewer(container, {
    baseLayer,
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

  // Display-only layer for standard mode. Do not use this tileset for terrain,
  // height, obstruction, line-of-sight, or search calculations.
  try {
    setStatus("標準3D：PLATEAU建物を読み込み中…");
    const plateauBuildings = await Cesium3DTileset.fromUrl(PLATEAU_BUILDINGS_TILESET_URL);
    plateauBuildings.show = false;
    plateauBuildings.maximumScreenSpaceError = 8;
    plateauBuildings.dynamicScreenSpaceError = true;
    plateauBuildings.skipLevelOfDetail = true;
    plateauBuildings.preferLeaves = true;

    plateauBuildings.style = new Cesium3DTileStyle({
      color: "color('#E0E0E0', 0.94)",
      show: "true",
    });

    viewer.scene.primitives.add(plateauBuildings);
    plateauBuildings.show = true;
    setStatus("標準3D：PLATEAU建物表示中（配信座標をそのまま使用）");
    viewer.scene.requestRender();
  } catch (error) {
    console.warn("PLATEAU buildings could not be loaded; continuing with GSI map only.", error);
    setStatus("標準：PLATEAU未取得のため国土地理院地図で表示中");
  }

  return viewer;
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

  let tileset: GooglePhotorealisticTileset | null = null;
  try {
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
  } catch (error) {
    viewer.destroy();
    throw error;
  }

  if (!tileset) {
    viewer.destroy();
    throw new Error("Google 3Dタイルを初期化できませんでした");
  }

  tileset.maximumScreenSpaceError = 24;
  tileset.dynamicScreenSpaceError = true;
  viewer.scene.primitives.add(tileset);
  return viewer;
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

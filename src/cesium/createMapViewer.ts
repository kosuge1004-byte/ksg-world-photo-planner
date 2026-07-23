import {
  Cartesian3,
  createGooglePhotorealistic3DTileset,
  Ion,
  IonGeocodeProviderType,
  Math as CesiumMath,
  Viewer,
} from "cesium";

type GooglePhotorealisticTileset = Awaited<
  ReturnType<typeof createGooglePhotorealistic3DTileset>
>;

const TILESET_INITIALIZATION_TIMEOUT_MS = 35_000;
const TILESET_INITIALIZATION_ATTEMPTS = 2;

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
      // タイムアウト後に古い要求が完了しても、未使用のタイルセットを残さない。
      void request.then((tileset) => tileset.destroy()).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function createMapViewer(
  container: HTMLDivElement,
  token: string,
  setStatus: (message: string) => void
): Promise<Viewer> {
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
  });

  let tileset: GooglePhotorealisticTileset | null = null;
  try {
    for (let attempt = 1; attempt <= TILESET_INITIALIZATION_ATTEMPTS; attempt += 1) {
      try {
        tileset = await createPhotorealisticTilesetWithTimeout();
        break;
      } catch (error) {
        if (attempt === TILESET_INITIALIZATION_ATTEMPTS) throw error;
        // モバイル回線の一時的な接続失敗では、Viewerを作り直さず一度だけ再試行する。
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

  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(139.745433, 35.658581, 1200),
    orientation: {
      heading: CesiumMath.toRadians(20),
      pitch: CesiumMath.toRadians(-35),
      roll: 0,
    },
  });

  setStatus("Google Photorealistic 3D Tiles 表示中");
  return viewer;
}

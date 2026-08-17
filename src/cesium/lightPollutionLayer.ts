import { ImageryLayer, UrlTemplateImageryProvider, type Viewer } from "cesium";

export const LIGHT_POLLUTION_MAX_ZOOM = 8;
export const LIGHT_POLLUTION_TILE_URL =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png";

// 2D表示（明るいGoogleマップのroadmapベース）向けの既定値。
export const LIGHT_POLLUTION_DEFAULT_ALPHA = 0.62;
// 標準3D表示は衛星写真ベースの地図で、Black Marble自体もほぼ黒い夜間画像
// なので、2Dと同じ不透明度だと重なって画面全体が暗く見えすぎていた
// （2026-08-16報告）。3Dだけ薄めに調整する。
export const LIGHT_POLLUTION_3D_ALPHA = 0.32;

const LAYER_KEY = "__astrosightLightPollutionLayer";

type ViewerWithLightPollutionLayer = Viewer & {
  [LAYER_KEY]?: ImageryLayer;
};

export function setLightPollutionLayerVisible(
  viewer: Viewer,
  visible: boolean,
  alpha: number = LIGHT_POLLUTION_3D_ALPHA
): void {
  if (viewer.isDestroyed()) return;

  const typedViewer = viewer as ViewerWithLightPollutionLayer;
  const layer = typedViewer[LAYER_KEY];

  if (!layer && visible) {
    const provider = new UrlTemplateImageryProvider({
      url: LIGHT_POLLUTION_TILE_URL,
      maximumLevel: LIGHT_POLLUTION_MAX_ZOOM,
      credit: "NASA EOSDIS GIBS / VIIRS Black Marble",
    });
    const created = new ImageryLayer(provider);
    created.alpha = alpha;
    created.show = true;
    viewer.imageryLayers.add(created);
    typedViewer[LAYER_KEY] = created;
    viewer.scene.requestRender();
    return;
  }

  if (layer && !visible) {
    // show=falseで隠すだけだと、読み込み済みタイルがGPUメモリに残り続ける。
    // 3D表示中はrequestRenderMode有効でも常時読み込みが走り得るため、非表示
    // 化のたびに実際にレイヤーを取り除いてメモリを解放する（2026-08-16の
    // フリーズ報告を受けた対策）。次にONにする際は再生成すればよい。
    viewer.imageryLayers.remove(layer, true);
    delete typedViewer[LAYER_KEY];
    viewer.scene.requestRender();
    return;
  }

  if (layer && visible) {
    layer.show = true;
    layer.alpha = alpha;
    viewer.scene.requestRender();
  }
}

import { ImageryLayer, UrlTemplateImageryProvider, type Viewer } from "cesium";

export const LIGHT_POLLUTION_MAX_ZOOM = 8;
export const LIGHT_POLLUTION_TILE_URL =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png";

const LAYER_KEY = "__astrosightLightPollutionLayer";

type ViewerWithLightPollutionLayer = Viewer & {
  [LAYER_KEY]?: ImageryLayer;
};

export function setLightPollutionLayerVisible(
  viewer: Viewer,
  visible: boolean
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
    created.alpha = 0.62;
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
    viewer.scene.requestRender();
  }
}

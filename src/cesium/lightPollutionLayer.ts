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
  let layer = typedViewer[LAYER_KEY];

  if (!layer && visible) {
    const provider = new UrlTemplateImageryProvider({
      url: LIGHT_POLLUTION_TILE_URL,
      maximumLevel: LIGHT_POLLUTION_MAX_ZOOM,
      credit: "NASA EOSDIS GIBS / VIIRS Black Marble",
    });
    layer = new ImageryLayer(provider);
    layer.alpha = 0.62;
    layer.show = true;
    viewer.imageryLayers.add(layer);
    typedViewer[LAYER_KEY] = layer;
  }

  if (layer) {
    layer.show = visible;
    viewer.scene.requestRender();
  }
}

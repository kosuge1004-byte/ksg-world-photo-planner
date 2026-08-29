import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { requestTimeZone } from "./network/timeZoneRequest";
import {
  BoundingSphere,
  Cartesian3,
  Cartographic,
  HeadingPitchRange,
  Math as CesiumMath,
} from "cesium";
import type { Viewer } from "cesium";

import "cesium/Build/Cesium/Widgets/widgets.css";
import "./App.css";

import { CelestialMenu } from "./components/CelestialMenu";
import { LightPollutionTileOverlay } from "./components/LightPollutionTileOverlay";
import { CelestialOverlay } from "./components/CelestialOverlay";
import { MetricsPanel } from "./components/MetricsPanel";
import { Map2DOverlay } from "./components/Map2DOverlay";
import { Map2DInteractionLayer } from "./components/Map2DInteractionLayer";
import { PinControls } from "./components/PinControls";
import { PreviewStatus } from "./components/PreviewStatus";
import { PreviewChrome } from "./components/PreviewChrome";
const CelestialTransitSearchDialog = lazy(() =>
  import("./components/CelestialTransitSearchDialog").then((m) => ({ default: m.CelestialTransitSearchDialog }))
);
import { PreviewGestureLayer } from "./components/PreviewGestureLayer";
import { PreviewMeasurementOverlay } from "./components/PreviewMeasurementOverlay";
import {
  measurePreviewDistanceMeters,
  type PreviewMeasurementPoint,
} from "./measurement/previewMeasurement";
import { enableMapMeasurement } from "./cesium/mapMeasurement";
import { ForegroundPreviewOverlay } from "./components/ForegroundPreviewOverlay";
import { ForegroundObjectControls } from "./components/ForegroundObjectControls";
import { SpotSearchScreen } from "./components/SpotSearchScreen";
const ProjectsScreen = lazy(() =>
  import("./components/ProjectsScreen").then((m) => ({ default: m.ProjectsScreen }))
);
const CalendarScreen = lazy(() =>
  import("./components/CalendarScreen").then((m) => ({ default: m.CalendarScreen }))
);
const MoonAgeCalendarScreen = lazy(() =>
  import("./components/MoonAgeCalendarScreen").then((m) => ({ default: m.MoonAgeCalendarScreen }))
);
import { ProjectSaveDialog } from "./components/ProjectSaveDialog";
import { SharedProjectImportDialog } from "./components/SharedProjectImportDialog";
import { ProjectShareQrDialog } from "./components/ProjectShareQrDialog";
import { ProjectQrScanDialog } from "./components/ProjectQrScanDialog";
import { PlacementConfirmDialog } from "./components/PlacementConfirmDialog";
import {
  beginOperationTag,
  endOperationTag,
  startFreezeMonitoring,
} from "./diagnostics/freezeDetector";
import { CesiumIonConsentDialog } from "./components/CesiumIonConsentDialog";
import {
  decodeProjectShareCode,
  encodeProjectShareCode,
  ProjectShareCodeError,
  type SharedProjectPayloadV1,
} from "./sharing/projectShareCode";
import { SubjectEditOverlay } from "./components/SubjectEditOverlay";
import { TimelinePanel } from "./components/TimelinePanel";
import type { ArCameraProjection } from "./components/ArCameraScreen";
const ArCameraScreen = lazy(() =>
  import("./components/ArCameraScreen").then((m) => ({ default: m.ArCameraScreen }))
);
import {
  requestArOrientationPermissionFromUserGesture,
  type ArTrackingSnapshot,
} from "./ar/deviceTracking";
import { TopSettingsBar } from "./components/TopSettingsBar";
import { UserNotice } from "./components/UserNotice";
import { coordinatesAtMapPixel } from "./map/webMercator";
import {
  refineSpotPresetHighestPrecision,
  type HighestPrecisionProgress,
} from "./precision/highestPrecision";
import {
  prepareRefractionWeatherContext,
  type RefractionWeatherContext,
} from "./search/refractionWeather";
import { loadPrecisionSettingsFromStorage, savePrecisionSettingsToStorage } from "./precision/precisionSettingsStorage";
import { formatEstimatedRemainingTime } from "./search/searchProgress";
import {
  buildDiagnosticDetail,
  publishUserNotice,
  subscribeUserNotices,
  toUserFacingErrorMessage,
  type UserNoticeEvent,
} from "./errors/userFeedback";
import {
  beginCesiumIonConnection,
  completeCesiumIonConnection,
  getValidCesiumIonAccessToken,
  isCesiumIonConnected,
  disconnectCesiumIon,
  recordCesiumIonHighPrecisionUsage,
  CESIUM_ION_USAGE_WARNING_THRESHOLD,
} from "./precision/cesiumIonConnection";

import { flyMapToTarget } from "./cesium/camera";
import {
  calculateCelestialHorizontalCoordinates,
  calculateCelestialScreenPoints,
  calculateCelestialScreenTracks,
  calculateMilkyWayScreenPath,
} from "./cesium/celestial";
import { updateCelestialMapEntities } from "./cesium/celestialMap";
import {
  evaluateCelestialLineOfSight,
  invalidateCelestialOcclusionCaches,
  prepareCelestialLineOfSightObserver,
  thirdDimensionSourceForAccuracyMode,
} from "./cesium/celestialOcclusion";
import {
  buildPreliminaryTripodCandidates,
  calculateTripodCandidates,
  getLastTripodSearchDiagnostics,
  getLastCoarseScanSamples,
} from "./cesium/tripodCandidates";
import {
  loadPersistentTripodSeeds,
  savePersistentTripodSeeds,
  clearPersistentTripodSeeds,
} from "./cesium/tripodCandidateSeedCache";
import {
  exactTripodCacheKey,
  getExactTripodCandidates,
  setExactTripodCandidates,
} from "./cesium/tripodCandidateExactCache";
import { warmGsiDeviceTilesFromPersistentCache } from "./cesium/gsiDemTileCache";
import { buildTripodSearchBaseLines } from "./cesium/tripodSearchLine";
import { updateConnectionLine } from "./cesium/connectionLine";
import { createMapViewer, ensureHiddenPlateauBuildingsForHeightLookup } from "./cesium/createMapViewer";
import { setLightPollutionLayerVisible } from "./cesium/lightPollutionLayer";
import {
  calculateKarneyDestinationPoint,
  calculateKarneyLineMetrics,
  calculateKarneySurfaceDistanceMeters,
} from "./geodesy/karneyGeodesic";
import { enableMapPlacement } from "./cesium/mapPlacement";
import { captureTripodPreview } from "./cesium/previewSnapshot";
import { pickCenterPosition } from "./cesium/subjectEdit";
import {
  setSubjectPinFromCoordinates,
  getSubjectPinPoint,
  setSubjectPinFromPosition,
  setSubjectPinFromExplicit3dPick,
} from "./cesium/subjectPin";
import {
  setTripodPin,
  setTripodPinFromCoordinates,
  setTripodPinFromExplicit3dPick,
  updateTripodDistanceLabel,
} from "./cesium/tripodPin";
import { resolveGroundPoint, resolveGroundPointFrom3dSurface } from "./height/heightResolver";
import { isResolvedGroundPoint } from "./types/points";
import { resolvePlateauRoofGroundPoint } from "./cesium/plateauBuildingVerification";
import { findOsmSubjectHeightHint, applyOsmSubjectHeightHint } from "./height/osmSubjectHeightFallback";
import { cartesianToForegroundCoordinates, enableForegroundObjectDrag, updateForegroundObjectEntity } from "./cesium/foregroundObject";

import {
  DEFAULT_CAMERA_SETTINGS,
  DEFAULT_CAMERA_VIEW_CORRECTION,
  FOCAL_LENGTH_MAX,
  FOCAL_LENGTH_MIN,
} from "./types/camera";
import type { PrecisionSettings } from "./types/precision";

import type {
  CalculationMode,
  CameraSettings,
  CameraViewCorrection,
  PreviewFrameMode,
} from "./types/camera";
import type {
  CelestialVisibility,
  CelestialBodyId,
  CelestialOcclusion,
  CelestialOcclusionMap,
  TripodCandidate,
} from "./types/celestial";
import {
  checkingCelestialOcclusion,
  failedCelestialOcclusion,
  isCelestialOcclusionConfirmedHidden,
} from "./types/celestial";
import type { GroundPoint } from "./types/points";
import { withLensCenterHeight, withVerticalOffset, ellipsoidalHeightMeters } from "./types/points";
import {
  DEFAULT_FOREGROUND_HEIGHT_CM,
  normalizeForegroundHeightCm,
  type ForegroundObject,
} from "./types/foreground";
import type {
  SpotPresetResult,
  SpotSearchCriteria,
} from "./types/search";
import type { SpotSearchJob } from "./types/backgroundSearch";
import type { PlannerProject } from "./types/project";
import { deleteProject, loadProjects, upsertProject } from "./projectStorage";
import { addSubjectHistory, isFavoriteSubject, loadFavoriteSubjects, loadSubjectHistory, renameFavoriteSubject, toggleFavoriteSubject } from "./subjectStorage";
import type { SubjectRecord } from "./subjectStorage";
import {
  dateFromZonedDateTimeLocal,
  dateTextFromDaySerial,
  daySerialFromDateText,
  isValidTimeZone,
  systemTimeZone,
  zonedDateTimeLocalFromDate,
} from "./time/zonedTime";
import {
  resolveSpotLocation,
  resolveSpotTimeZone,
  searchSpotPresets,
} from "./search/spotPresetSearch";
import {
  clearActiveSpotSearchJob,
  deserializeSpotSearchResults,
  finalizeBackgroundSpotSearch,
  readActiveSpotSearchJob,
  startBackgroundSpotSearch,
  waitForBackgroundSpotSearch,
  spotSearchPreparationKey,
  spotSearchCacheState,
  markSpotSearchPrepared,
} from "./search/backgroundSpotSearch";
import type { ActiveSpotSearchJob } from "./search/backgroundSpotSearch";
import { enterElementFullscreen, exitElementFullscreen } from "./ui/fullscreen";
import {
  canOpenNativeLocationSettings,
  DeviceLocationError,
  type DeviceLocation,
  geolocationPermissionState,
  getDeviceCurrentPosition,
  isInstalledWebApp,
  isNativeAndroidApp,
  locationPermissionInstructions,
  locationSettingsPlatform,
  openNativeLocationSettings,
  openNativeSystemLocationSettings,
} from "./device/locationSettings";

const DEFAULT_CELESTIAL_VISIBILITY: CelestialVisibility = {
  sun: true,
  moon: true,
  milkyWay: true,
  polaris: true,
};

const TRIPOD_CACHE_PREPARATION_TIMEOUT_MS = 2_000;

async function waitForOptionalTripodCache<T>(
  operation: Promise<T>,
  fallback: T,
  timeoutMessage: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => {
          console.warn(timeoutMessage);
          resolve(fallback);
        }, TRIPOD_CACHE_PREPARATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function applyMapViewMode(
  viewer: Viewer,
  mode: "2d" | "3d",
  center: { latitude: number; longitude: number },
  duration = 0.6
) {
  const current = viewer.camera.positionCartographic;
  const height = Math.max(current.height, 800);

  if (mode === "2d") {
    const destination = Cartesian3.fromDegrees(
      center.longitude,
      center.latitude,
      height
    );
    viewer.camera.flyTo({
      destination,
      duration,
      orientation: {
        heading: 0,
        pitch: CesiumMath.toRadians(-90),
        roll: 0,
      },
    });
    return;
  }

  // A pitched camera placed directly above the 2D center looks past that point,
  // which pushed the former 2D center toward (or beyond) the bottom edge.
  // Fly around the center as the target instead, so the same geographic point
  // remains at the screen center when entering 3D.
  const pitch = CesiumMath.toRadians(-35);
  const range = height / Math.sin(Math.abs(pitch));
  const target = Cartesian3.fromDegrees(center.longitude, center.latitude, 0);
  viewer.camera.flyToBoundingSphere(new BoundingSphere(target, 0), {
    duration,
    offset: new HeadingPitchRange(viewer.camera.heading, pitch, range),
  });
}

const LAST_MAP_STATE_STORAGE_KEY = "ksg-last-map-state-v1";

type LastMapState = {
  center: { latitude: number; longitude: number };
  zoom: number;
  viewMode: "2d" | "3d";
};

const DEFAULT_MAP_STATE: LastMapState = {
  center: { latitude: 35.658581, longitude: 139.745433 },
  zoom: 15,
  viewMode: "2d",
};

function loadLastMapState(): LastMapState {
  try {
    const saved = localStorage.getItem(LAST_MAP_STATE_STORAGE_KEY);
    if (!saved) return DEFAULT_MAP_STATE;
    const parsed = JSON.parse(saved) as Partial<LastMapState>;
    const latitude = parsed.center?.latitude;
    const longitude = parsed.center?.longitude;
    const zoom = parsed.zoom;
    const viewMode = parsed.viewMode;
    if (
      !Number.isFinite(latitude) || latitude! < -90 || latitude! > 90 ||
      !Number.isFinite(longitude) || longitude! < -180 || longitude! > 180 ||
      !Number.isFinite(zoom) || zoom! < 3 || zoom! > 20 ||
      (viewMode !== "2d" && viewMode !== "3d")
    ) {
      return DEFAULT_MAP_STATE;
    }
    return {
      center: { latitude: latitude!, longitude: longitude! },
      zoom: zoom!,
      viewMode,
    };
  } catch {
    return DEFAULT_MAP_STATE;
  }
}

function loadCameraSettings(): CameraSettings {
  try {
    const saved = localStorage.getItem("ksg-camera-settings");

    if (!saved) {
      return DEFAULT_CAMERA_SETTINGS;
    }

    const parsed = JSON.parse(saved) as Partial<CameraSettings> & {
      cameraHeightMeters?: number;
    };

    return {
      focalLengthMm:
        parsed.focalLengthMm ?? DEFAULT_CAMERA_SETTINGS.focalLengthMm,
      lensCenterHeightMeters:
        parsed.lensCenterHeightMeters ??
        parsed.cameraHeightMeters ??
        DEFAULT_CAMERA_SETTINGS.lensCenterHeightMeters,
    };
  } catch {
    return DEFAULT_CAMERA_SETTINGS;
  }
}

function loadCameraViewCorrection(): CameraViewCorrection {
  try {
    const parsed = JSON.parse(
      localStorage.getItem("ksg-camera-view-correction") ?? "{}"
    ) as Partial<CameraViewCorrection>;
    return {
      azimuthDegrees: Number.isFinite(parsed.azimuthDegrees)
        ? parsed.azimuthDegrees!
        : DEFAULT_CAMERA_VIEW_CORRECTION.azimuthDegrees,
      altitudeDegrees: Number.isFinite(parsed.altitudeDegrees)
        ? parsed.altitudeDegrees!
        : DEFAULT_CAMERA_VIEW_CORRECTION.altitudeDegrees,
    };
  } catch {
    return DEFAULT_CAMERA_VIEW_CORRECTION;
  }
}

function loadPrecisionSettings(): PrecisionSettings {
  return loadPrecisionSettingsFromStorage();
}

function loadCelestialVisibility(): CelestialVisibility {
  try {
    const saved = localStorage.getItem("ksg-celestial-visibility");

    if (!saved) {
      return DEFAULT_CELESTIAL_VISIBILITY;
    }

    return {
      ...DEFAULT_CELESTIAL_VISIBILITY,
      ...(JSON.parse(saved) as CelestialVisibility),
    };
  } catch {
    return DEFAULT_CELESTIAL_VISIBILITY;
  }
}

function loadCalculationMode(): CalculationMode {
  // 大気差（屈折）補正を常時適用する単一モード。
  return "pro";
}

function loadCelestialDateTime(): string {
  // アプリ起動時は、前回終了時の日時ではなく端末の現在日時を表示する。
  return zonedDateTimeLocalFromDate(new Date(), systemTimeZone());
}

type PlacementMode = "none" | "subject" | "tripod" | "foreground";

type AppNotice = UserNoticeEvent & {
  id: number;
  actionLabel?: string;
  onAction?: () => void;
};

function App() {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewSectionRef = useRef<HTMLElement>(null);
  const mapSectionRef = useRef<HTMLElement>(null);
  const map2dStageRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapViewerRef = useRef<Viewer | null>(null);
  const mapViewModeRef = useRef<"2d" | "3d">(loadLastMapState().viewMode);
  const disablePlacementRef = useRef<(() => void) | null>(null);
  // Reactの再描画前に連続タップされても、配置対象を一意に判定する同期状態。
  const placementModeRef = useRef<PlacementMode>("none");
  const previewJobRef = useRef(0);
  const previewRenderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const userNoticeSequenceRef = useRef(0);

  const [status, setStatus] = useState("3Dデータを読み込み中…");
  const [userNotice, setUserNotice] = useState<AppNotice | null>(null);
  const [mapInitializationAttempt, setMapInitializationAttempt] = useState(0);
  const [tripodCandidateRetrySequence, setTripodCandidateRetrySequence] = useState(0);
  const [occlusionRetrySequence] = useState(0);
  const [previewRetrySequence, setPreviewRetrySequence] = useState(0);
  const [highestPrecisionProgress, setHighestPrecisionProgress] =
    useState<HighestPrecisionProgress | null>(null);
  const [previewRefractionWeather, setPreviewRefractionWeather] =
    useState<RefractionWeatherContext | undefined>(undefined);
  const [mapReady, setMapReady] = useState(false);
  const [previewStatus, setPreviewStatus] = useState(
    "三脚ピンと被写体点を設定してください"
  );
  const [previewViewportAspectRatio, setPreviewViewportAspectRatio] =
    useState(16 / 9);
  const [previewFrameMode, setPreviewFrameMode] =
    useState<PreviewFrameMode>("screen");

  // ピン操作などの通知は既存の画面下ステータスへ集約し、検索パネル撤去後も利用者へ伝える。
  const setSearchMessage = useCallback(
    (message: string) => setStatus(message),
    []
  );
  const showUserNotice = useCallback((
    notice: UserNoticeEvent & {
      actionLabel?: string;
      onAction?: () => void;
    }
  ) => {
    setUserNotice({
      ...notice,
      id: ++userNoticeSequenceRef.current,
    });
  }, []);

  // 2026-08-27追記: 「マップ・スライダーが原因不明に固まる」という報告への
  // 対応。開発者ツールが使えないインストール型アプリ環境でも、フリーズの
  // 発生と直前の状況を診断できるようにする（詳細はsrc/diagnostics/
  // freezeDetector.tsのコメント参照）。アプリ起動時に1回だけ監視を開始する。
  useEffect(() => startFreezeMonitoring(), []);

  // Cesium ionのOAuth認証画面から戻ってきた直後（URLに?code=...&state=...が
  // 含まれる）であれば、アクセストークンへの交換を行う。アプリ起動時に
  // 一度だけ実行すればよいため、依存配列は空にしている。
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return;
    // 二重処理・履歴汚染を避けるため、まずURLからパラメータを取り除く。
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, "", url.toString());

    void completeCesiumIonConnection(code, state)
      .then(() => {
        showUserNotice({
          key: "cesium-ion-connection",
          tone: "warning",
          message: "Cesium ionアカウントを接続しました。Googleタイルモードが利用できます。",
        });
        // 2026-08-26追記: 以前はここで通知を出すだけで、実際の3D地図
        // 初期化処理（Cesium ionトークンの取得〜Googleタイルの読み込み）を
        // 再実行するトリガーが無く、「接続しました」と表示されても
        // 標準モード（国土地理院地図）のまま固定される不具合があった。
        // mapInitializationAttemptを更新し、3D地図の初期化useEffectを
        // 明示的に再実行させる。
        setMapInitializationAttempt((current) => current + 1);
      })
      .catch((error) => {
        console.warn("Cesium ion接続に失敗しました", error);
        showUserNotice({
          key: "cesium-ion-connection",
          tone: "error",
          message: error instanceof Error
            ? `Cesium ionアカウントの接続に失敗しました（${error.message}）`
            : "Cesium ionアカウントの接続に失敗しました。",
        });
      });
  }, [showUserNotice]);
  const [spotSearchOpen, setSpotSearchOpen] = useState(false);
  const [arCameraOpen, setArCameraOpen] = useState(false);
  const [arTracking, setArTracking] = useState<ArTrackingSnapshot>({ location: null, orientation: null });
  const [arCameraProjection, setArCameraProjection] = useState<ArCameraProjection | null>(null);
  const [arSearchTripod, setArSearchTripod] = useState<GroundPoint | null>(null);
  const [arSearchCameraSettings, setArSearchCameraSettings] = useState<CameraSettings | null>(null);
  const [arSearchAspectRatio, setArSearchAspectRatio] = useState<number | null>(null);
  const [projectSaveTripodOverride, setProjectSaveTripodOverride] = useState<GroundPoint | null>(null);
  const [celestialTransitSearchOpen, setCelestialTransitSearchOpen] = useState(false);
  const openCelestialTransitSearch = useCallback(() => {
    setArSearchTripod(null);
    setArSearchCameraSettings(null);
    setArSearchAspectRatio(null);
    setCelestialTransitSearchOpen(true);
  }, []);
  const [savedPlansOpen, setSavedPlansOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [moonAgeCalendarOpen, setMoonAgeCalendarOpen] = useState(false);
  const [projectSaveOpen, setProjectSaveOpen] = useState(false);
  const [projects, setProjects] = useState<PlannerProject[]>(loadProjects);
  const [subjectHistory, setSubjectHistory] = useState<SubjectRecord[]>(loadSubjectHistory);
  const [favoriteSubjects, setFavoriteSubjects] = useState<SubjectRecord[]>(loadFavoriteSubjects);
  const [justRegisteredFavorite, setJustRegisteredFavorite] =
    useState<{ token: number; id: string } | null>(null);
  const favoriteRegistrationTokenRef = useRef(0);
  const [sharedImportPayload, setSharedImportPayload] =
    useState<SharedProjectPayloadV1 | null>(null);
  const [sharedImportBusy, setSharedImportBusy] = useState(false);
  const [sharedImportError, setSharedImportError] = useState<string | null>(null);
  const [qrShareUrl, setQrShareUrl] = useState<string | null>(null);
  const [qrShareProjectName, setQrShareProjectName] = useState("");
  const [qrScanOpen, setQrScanOpen] = useState(false);
  const [pendingPlacement, setPendingPlacement] = useState<
    { kind: "subject" | "tripod" | "person"; commit: (offsetMeters: number) => Promise<void> } | null
  >(null);
  const [pendingPlacementOffsetMeters, setPendingPlacementOffsetMeters] = useState(0);
  const [pendingPlacementBusy, setPendingPlacementBusy] = useState(false);
  const [pendingPlacementError, setPendingPlacementError] = useState<string | null>(null);

  const [subjectPoint, setSubjectPoint] =
    useState<GroundPoint | null>(null);
  const [tripodPoint, setTripodPoint] =
    useState<GroundPoint | null>(null);
  // 2026-08-28追記: 三脚探索のuseEffectが、視線方向の観測点として
  // tripodPointの最新値を参照する際に使う。あえて依存配列には含めず、
  // このrefだけを参照することで、「候補点計算中の概算地点に三脚を
  // 仮設置しても、進行中の精密計算を中断・やり直しさせない」を実現する
  // （setTripodPoint自体は今まで通り呼ばれるが、それだけでは探索の
  // useEffectを再トリガーしなくなる）。
  const tripodPointRef = useRef(tripodPoint);
  tripodPointRef.current = tripodPoint;
  const [foregroundObjects, setForegroundObjects] = useState<ForegroundObject[]>([]);
  const foregroundObject = foregroundObjects[0] ?? null;
  // 人物を配置する前に指定した身長を保持し、配置時の初期サイズへ使用する。
  const [plannedForegroundHeightCm, setPlannedForegroundHeightCm] = useState(DEFAULT_FOREGROUND_HEIGHT_CM);
  const plannedForegroundHeightCmRef = useRef(DEFAULT_FOREGROUND_HEIGHT_CM);
  const foregroundTerrainTimerRef = useRef<number | null>(null);
  const foregroundTerrainRequestRef = useRef(0);
  const geoidBackfillRequestRef = useRef(0);
  const currentLocationRequestRef = useRef(0);
  const currentLocationMessageTimerRef = useRef<number | null>(null);
  const [currentLocationPending, setCurrentLocationPending] = useState(false);
  const [currentLocationMessage, setCurrentLocationMessage] = useState("");
  const [currentLocationPermissionDenied, setCurrentLocationPermissionDenied] =
    useState(false);
  const [currentLocationSettingsTarget, setCurrentLocationSettingsTarget] =
    useState<"app" | "system-location">("app");

  const [subjectPlacementActive, setSubjectPlacementActive] =
    useState(false);
  const [tripodPlacementActive, setTripodPlacementActive] =
    useState(false);
  const [foregroundPlacementActive, setForegroundPlacementActive] = useState(false);
  const [subjectEditActive, setSubjectEditActive] =
    useState(false);

  const [cameraSettings, setCameraSettings] =
    useState<CameraSettings>(loadCameraSettings);
  const [previewViewCorrection, setPreviewViewCorrection] =
    useState<CameraViewCorrection>(loadCameraViewCorrection);
  const [previewMeasuring, setPreviewMeasuring] = useState(false);
  const [previewMeasurePoints, setPreviewMeasurePoints] = useState<PreviewMeasurementPoint[]>([]);
  const [mapMeasuring, setMapMeasuring] = useState(false);
  const [mapMeasureDistanceMeters, setMapMeasureDistanceMeters] = useState<number | null>(null);
  const disableMapMeasurementRef = useRef<(() => void) | null>(null);
  const [precisionSettings, setPrecisionSettings] =
    useState<PrecisionSettings>(loadPrecisionSettings);
  // BYOA化: ARカメラ画面（ArCameraScreen経由でArCesiumOverlayへ渡す）でも
  // 高精度モードを使う場合、ユーザー自身のCesium ionトークンが必要になる。
  // メイン3D地図側（authorizeHighPrecision内）とは別の場所で消費されるため、
  // ここでもstateとして保持し、accuracyModeが変わるたびに取得し直す。
  const [arCesiumIonToken, setArCesiumIonToken] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (precisionSettings.accuracyMode !== "highest") {
      setArCesiumIonToken(undefined);
      return;
    }
    let cancelled = false;
    void getValidCesiumIonAccessToken().then((token) => {
      if (!cancelled) setArCesiumIonToken(token ?? undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [precisionSettings.accuracyMode]);

  // 設定画面（TopSettingsBar）で接続状態の表示・解除ボタンを出すための
  // state。アプリ起動時とaccuracyMode変更時に確認し直す。
  const [cesiumIonConnected, setCesiumIonConnectedState] = useState(() => isCesiumIonConnected());
  useEffect(() => {
    setCesiumIonConnectedState(isCesiumIonConnected());
  }, [precisionSettings.accuracyMode, arCesiumIonToken]);
  const handleDisconnectCesiumIon = useCallback(() => {
    disconnectCesiumIon();
    setCesiumIonConnectedState(false);
    setArCesiumIonToken(undefined);
    showUserNotice({
      key: "cesium-ion-connection",
      tone: "warning",
      message: "Cesium ionアカウントの接続を解除しました。",
    });
    // 3D地図がGoogleタイルモードで表示中だった場合、標準モードへ
    // 切り替わるよう地図の初期化処理を再実行させる。
    setMapInitializationAttempt((current) => current + 1);
  }, [showUserNotice]);

  // 2026-08-26追記: Cesium社（Bentley Systems）担当者からの回答に基づき、
  // 「アプリケーションや利用規約等において、利用者が適切なCesium ion
  // プランおよびライセンスを購入するよう案内いただくことをお勧めします」
  // との推奨があったため、OAuth認証画面へ直接飛ばす前に、必ず
  // CesiumIonConsentDialog（規約・プランに関する案内、リンク付き）を
  // 表示し、明示的な同意を得てから接続を開始する。
  const [cesiumIonConsentOpen, setCesiumIonConsentOpen] = useState(false);
  const requestCesiumIonConnection = useCallback(() => {
    setCesiumIonConsentOpen(true);
  }, []);
  const handleConfirmCesiumIonConsent = useCallback(() => {
    setCesiumIonConsentOpen(false);
    void beginCesiumIonConnection().then((url) => {
      window.location.href = url;
    });
  }, []);

  const [calculationMode] = useState<CalculationMode>(loadCalculationMode);
  const [timeZone, setTimeZone] = useState(systemTimeZone);

  const [celestialMenuOpen, setCelestialMenuOpen] = useState(true);
  const initialMapStateRef = useRef<LastMapState>(loadLastMapState());
  const [mapViewMode, setMapViewMode] = useState<"2d" | "3d">(
    initialMapStateRef.current.viewMode
  );
  const [mapZoom, setMapZoom] = useState(initialMapStateRef.current.zoom);
  const [mapSize, setMapSize] = useState({ width: 1, height: 1 });
  const [mapCenter, setMapCenter] = useState(
    initialMapStateRef.current.center
  );
  const [mapTool, setMapTool] = useState<"none" | "pin" | "metrics">("none");
  const pinToolButtonRef = useRef<HTMLButtonElement>(null);
  const pinDrawerRef = useRef<HTMLDivElement>(null);
  const [celestialVisibility, setCelestialVisibility] =
    useState<CelestialVisibility>(loadCelestialVisibility);
  const [lightPollutionEnabled, setLightPollutionEnabled] = useState(false);
  const [celestialOcclusion, setCelestialOcclusion] =
    useState<CelestialOcclusionMap>({});
  const [milkyWayLineOfSight, setMilkyWayLineOfSight] =
    useState<Partial<Record<number, boolean>>>({});
  const [tripodCandidates, setTripodCandidates] =
    useState<TripodCandidate[]>([]);
  // 2026-08-28追記: 精密計算（数秒〜数十秒）が終わる前に、通信不要の
  // 理論値を「候補点計算中」として先に表示するための、天体ID→暫定候補の
  // マップ。精密計算が完了した天体は、対応するエントリを削除する
  // （tripodCandidatesの確定表示に切り替わるため）。
  const [preliminaryTripodCandidates, setPreliminaryTripodCandidates] =
    useState<Partial<Record<TripodCandidate["id"], TripodCandidate>>>({});
  const [tripodCandidateSelectionOpen, setTripodCandidateSelectionOpen] =
    useState(false);
  const tripodCandidatesRef = useRef<TripodCandidate[]>([]);
  // 同一入力での重複計算を防ぐin-flight識別子。keyだけでは、中断した旧探索と
  // 同じ入力で直ちに再開した新探索を区別できないため、runIdも保持する。
  const tripodCalculationInFlightRef = useRef<{ key: string; runId: number } | null>(null);
  const tripodCalculationRunIdRef = useRef(0);
  // 2026-08-25追記: 前回の確定候補（tripodCandidatesRef）を距離ヒントとして
  // 再利用する仕組みは、天体IDだけをキーにしており「どの被写体で見つかった
  // 距離か」を区別していなかった。そのため被写体を切り替えた直後は、
  // 前の被写体での距離が誤ったヒントとして使われ、まずヒント周辺を無駄に
  // 探索してから改めて全距離走査するという二度手間が生じ、体感速度が
  // 大きく悪化する原因になっていた。ここで直前に検索した被写体の緯度経度を
  // 保持し、被写体が変わっていたら距離ヒントを使わないようにする。
  const tripodHintSubjectRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const [tripodCandidateCalculationStatus, setTripodCandidateCalculationStatus] =
    useState<"idle" | "calculating" | "complete" | "no-solution" | "error">("idle");

  // 2026-08-26追記: インストール型アプリ環境（PWA/専用アプリ）では
  // ブラウザの開発者ツールが使えないため、「計算中のまま何分も動かない」
  // 状態が、本当に処理が進んでいる（遅いだけ）のか完全に停止している
  // （デッドロック等）のかを、アプリの中だけで判別できるようにする。
  // 計算開始から15秒経過してもまだ計算中なら、通信回数・最後の通信から
  // の経過秒数を自動的に画面へ表示する。
  const TRIPOD_PROGRESS_DISPLAY_DELAY_MS = 15_000;
  const [tripodProgressSnapshot, setTripodProgressSnapshot] = useState<{
    elapsedSeconds: number;
    roundTripCount: number;
    secondsSinceLastRoundTrip: number | null;
  } | null>(null);
  useEffect(() => {
    if (tripodCandidateCalculationStatus !== "calculating") {
      setTripodProgressSnapshot(null);
      return;
    }
    const intervalId = window.setInterval(() => {
      const diagnostics = getLastTripodSearchDiagnostics();
      if (!diagnostics || diagnostics.finishedAtMs !== null) return;
      const now = Date.now();
      const elapsedMs = now - diagnostics.startedAtMs;
      if (elapsedMs < TRIPOD_PROGRESS_DISPLAY_DELAY_MS) {
        setTripodProgressSnapshot(null);
        return;
      }
      setTripodProgressSnapshot({
        elapsedSeconds: Math.round(elapsedMs / 1000),
        roundTripCount: diagnostics.liveRoundTripCount,
        secondsSinceLastRoundTrip: diagnostics.liveLastRoundTripFinishedAtMs
          ? Math.round((now - diagnostics.liveLastRoundTripFinishedAtMs) / 1000)
          : null,
      });
    }, 1_000);
    return () => window.clearInterval(intervalId);
  }, [tripodCandidateCalculationStatus]);

  const [tripodDiagnosticsCopyState, setTripodDiagnosticsCopyState] =
    useState<"idle" | "copied" | "failed">("idle");
  const handleCopyTripodDiagnostics = useCallback(async () => {
    const diagnostics = getLastTripodSearchDiagnostics();
    if (!diagnostics) return;
    const elapsedSeconds = diagnostics.finishedAtMs
      ? ((diagnostics.finishedAtMs - diagnostics.startedAtMs) / 1000).toFixed(1)
      : "計測中";
    const lines = [
      "[AstroSight三脚探索診断]",
      `日時: ${new Date().toISOString()}`,
      `所要時間: ${elapsedSeconds}秒`,
      `総確定時間(ms): ${diagnostics.totalElapsedMs !== null ? Math.round(diagnostics.totalElapsedMs) : "計測中"}`,
      `地形タイルキャッシュ: R2ヒット${diagnostics.cacheHitBatchCount}回・R2ミス${diagnostics.cacheMissBatchCount}回・` +
        `メモリヒット${diagnostics.cacheMemoryHitCount}回・同時要求共有${diagnostics.cacheSharedCount}回・` +
        `R2不使用/障害${diagnostics.cacheBypassCount}回`,
      "天体別内訳:",
      ...Object.entries(diagnostics.perCelestialBody).map(([label, entry]) => {
        const failRate = entry.terrainRequestedPoints > 0
          ? `${Math.round((entry.terrainFailedPoints / entry.terrainRequestedPoints) * 100)}%`
          : "0%";
        return `  ${label}: 交点候補${entry.initialSolutionCount}件→確定${entry.convergedCount}件` +
          `（地形取得${entry.terrainRequestedPoints}点中${entry.terrainFailedPoints}点失敗=${failRate}）` +
          `（距離ヒント: ${entry.distanceHintUsed ? "使用" : "未使用"}` +
          `${entry.distanceHintMeters !== undefined ? `・${Math.round(entry.distanceHintMeters)}m` : ""}）` +
          `（探索範囲: ${entry.usedWideFallbackScan ? "広域(二次)" : "狭域(一次)"}` +
          `${entry.primaryScanMaxMeters !== undefined ? `・一次上限${Math.round(entry.primaryScanMaxMeters)}m` : ""}）` +
          `（通信: ${entry.terrainRoundTripCount}回・` +
          `合計${(entry.terrainRoundTripTotalMs / 1000).toFixed(1)}秒・` +
          `平均${entry.terrainRoundTripCount > 0 ? Math.round(entry.terrainRoundTripTotalMs / entry.terrainRoundTripCount) : 0}ms/回）` +
          `（初期探索${(entry.initialScanMs / 1000).toFixed(2)}秒・` +
          `気象${(entry.weatherResolveMs / 1000).toFixed(2)}秒・` +
          `収束反復${(entry.convergenceLoopMs / 1000).toFixed(2)}秒・` +
          `精密化${(entry.refinementMs / 1000).toFixed(2)}秒・` +
          `ダブルチェック${(entry.doubleCheckMs / 1000).toFixed(2)}秒・` +
          `天体総時間${(entry.totalBodyMs / 1000).toFixed(2)}秒）` +
          `（除外理由: ${Object.keys(entry.rejectionReasons).length > 0
            ? Object.entries(entry.rejectionReasons).map(([reason, count]) => `${reason}=${count}`).join(" / ")
            : "なし"}）` +
          // 2026-08-29追記: 「交点候補N件→確定M件」なのに除外理由が0件、
          // という数の不整合が実機で報告された。見つかった全ての初期交点
          // 候補について、確定/棄却/重複除去/処理失敗のいずれになったかを
          // 1件ずつ示すことで、reject()を経由しない失敗（同じ地点への
          // 重複収束を含む）も含めて全件の行方を追えるようにする。
          (entry.intersectionOutcomes.length > 0
            ? `（初期交点の内訳: ${entry.intersectionOutcomes.map((outcome, index) =>
                `#${index + 1} 初期距離=${Number.isFinite(outcome.initialDistanceMeters) ? outcome.initialDistanceMeters.toFixed(1) : "-"}m` +
                ` → ${outcome.outcome}` +
                `${outcome.finalDistanceMeters !== null ? `(最終${outcome.finalDistanceMeters.toFixed(2)}m)` : ""}`
              ).join(" | ")}）`
            : "") +
          (entry.finalEvaluations.length > 0
            ? `（最終判定詳細: ${entry.finalEvaluations.map((evaluation, index) =>
                `#${index + 1} ${evaluation.reason}` +
                ` 距離=${evaluation.distanceMeters !== null ? evaluation.distanceMeters.toFixed(2) : "-"}m` +
                ` 方位誤差=${evaluation.azimuthErrorDegrees !== null ? evaluation.azimuthErrorDegrees.toFixed(6) : "-"}°` +
                ` 仰角誤差=${evaluation.altitudeErrorDegrees !== null ? evaluation.altitudeErrorDegrees.toFixed(6) : "-"}°` +
                ` dx=${evaluation.dxPercent !== null ? evaluation.dxPercent.toFixed(4) : "-"}%` +
                ` dy=${evaluation.dyPercent !== null ? evaluation.dyPercent.toFixed(4) : "-"}%` +
                ` 前方=${evaluation.inFront === null ? "-" : evaluation.inFront ? "yes" : "no"}` +
                ` 精密化パス=${evaluation.refinementPassesUsed ?? "-"}` +
                ` 1パス目スコア=${evaluation.firstPassScorePercent !== null ? evaluation.firstPassScorePercent.toFixed(4) : "-"}%` +
                ` 最終スコア=${evaluation.finalScorePercent !== null ? evaluation.finalScorePercent.toFixed(4) : "-"}%` +
                // 2026-08-29追記: 複数の交点候補を並行処理すると、パス推移を
                // グローバル1個所に記録する方式では「最後に処理された候補」の
                // 値で上書きされ、本当に見たい（棄却された）候補自身の推移が
                // 別の（確定した）候補のもので上書きされてしまっていた
                // （実機診断で確認）。この候補自身のパス推移をここへ直接出す。
                (evaluation.refinementPassTrace && evaluation.refinementPassTrace.length > 0
                  ? ` [パス推移: ${evaluation.refinementPassTrace.map((trace) =>
                      `${trace.pass}:${trace.centerDistanceMeters.toFixed(1)}/${trace.radialRadiusMeters.toFixed(1)}` +
                      `→${trace.bestDistanceMeters !== null ? trace.bestDistanceMeters.toFixed(2) : "-"}` +
                      `@${trace.bestScorePercent !== null ? trace.bestScorePercent.toFixed(4) : "-"}%` +
                      `${trace.onEdge ? "(edge)" : ""}`
                    ).join(" ")}]`
                  : "")
              ).join(" | ")}）`
            : "");
      }),
    ];
    // 2026-08-29追記: 「確定/棄却の結論そのものが現地確認と食い違う」
    // 報告を受け、推測での修正ではなく実データで原因を特定できるよう、
    // 粗探索段階（精密化前）の生の(距離, レイ高との差[m])サンプルを
    // そのまま添付する。符号が変わる（＝交点の兆候がある）箇所を目視で
    // 確認できるようにするための診断専用の情報で、探索結果には影響しない。
    const coarseScanSamples = getLastCoarseScanSamples();
    if (coarseScanSamples && coarseScanSamples.length > 0) {
      lines.push(
        "粗探索の生データ（精密化前・距離昇順、距離m:レイ高との差m）:",
        coarseScanSamples
          .map((sample) => `${Math.round(sample.distanceMeters)}:${sample.heightErrorMeters.toFixed(1)}`)
          .join(" ")
      );
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setTripodDiagnosticsCopyState("copied");
    } catch {
      setTripodDiagnosticsCopyState("failed");
    }
    window.setTimeout(() => setTripodDiagnosticsCopyState("idle"), 3_000);
  }, []);

  // 2026-08-29追記: 誤って「確定」扱いになった候補が端末の永続キャッシュへ
  // 保存され、以後の検索へ自己強化的に悪影響を与え続けることが実機で
  // 確認された（詳細はtripodCandidateSeedCache.tsのコメント参照）。この
  // 更新自体でも既存の永続seedは自動的に無効化されるが、念のため利用者
  // 自身の操作でも即座にリセットできるようにする。
  const [tripodSeedResetState, setTripodSeedResetState] =
    useState<"idle" | "done" | "failed">("idle");
  // 2026-08-29追記（「V11〜V20の変更を見直せば分かるだろ」というご指摘を
  // 受けて発見）: 「三脚候補の記憶をリセット」ボタンは端末の永続seed
  // キャッシュ（tripodCandidateSeedCache.ts、IndexedDB）だけを消去して
  // いたが、V11の設計は「現セッションの直前確定候補が存在する場合は、
  // そちらを永続seedより優先する」ことを明記しており、実際に
  // tripodCandidatesRef.current（前回の確定候補、誤った候補も含む）が
  // preferredDistancesByIdとして毎回優先的に使われ続けていた。永続層だけ
  // 消しても、この優先度がより高いセッション内の記憶は残ったままだった
  // ため、リセットが不完全だった。
  // また、リセットボタンは検索を再実行するトリガー
  // （tripodCandidateRetrySequence、「検索」ボタンや通知の「再試行」と
  // 同じ仕組み）を何も更新していなかったため、リセット後に表示される
  // 内容は「たまたま最後に完了していた検索結果」のままで、リセットが
  // 反映された新しい検索が自動的には走らなかった。
  const handleResetTripodSeedCache = useCallback(async () => {
    try {
      await clearPersistentTripodSeeds();
      tripodCandidatesRef.current = [];
      tripodHintSubjectRef.current = null;
      setTripodCandidates([]);
      setPreliminaryTripodCandidates({});
      setTripodCandidateRetrySequence((current) => current + 1);
      setTripodSeedResetState("done");
    } catch {
      setTripodSeedResetState("failed");
    }
    window.setTimeout(() => setTripodSeedResetState("idle"), 3_000);
  }, []);

  const [dateTimeLocal, setDateTimeLocal] = useState(
    loadCelestialDateTime
  );
  const [timelineInteracting, setTimelineInteracting] = useState(false);
  // 時間軸を操作中（ドラッグ中）だけ天体オーバーレイに掛ける透明度。
  // 静止時は3D静止画側に建物への隠れ方まで焼き込むため、この値は使わない。
  const [celestialDragOpacity, setCelestialDragOpacity] = useState(0.55);
  const mapCenterRef = useRef(mapCenter);
  const dateTimeLocalRef = useRef(dateTimeLocal);
  const timeZoneRef = useRef(timeZone);
  mapCenterRef.current = mapCenter;
  dateTimeLocalRef.current = dateTimeLocal;
  timeZoneRef.current = timeZone;

  useEffect(
    () => subscribeUserNotices((notice) => showUserNotice(notice)),
    [showUserNotice]
  );

  useEffect(() => {
    if (!userNotice) return;
    const timeout = window.setTimeout(
      () => setUserNotice((current) =>
        current?.id === userNotice.id ? null : current
      ),
      userNotice.actionLabel ? 20_000 : userNotice.tone === "error" ? 14_000 : 9_000
    );
    return () => window.clearTimeout(timeout);
  }, [userNotice]);

  useEffect(() => {
    // 起動時は必ずプレビュー＋マップのメイン画面を表示する。
    // 保存済みのスポット検索ジョブは維持し、検索画面を手動で開いた際に再開できる。
    setSpotSearchOpen(false);
    setArCameraOpen(false);
    setArSearchTripod(null);
    setArSearchCameraSettings(null);
    setArSearchAspectRatio(null);
    setProjectSaveTripodOverride(null);
    setCelestialTransitSearchOpen(false);
    setSavedPlansOpen(false);
    setCalendarOpen(false);
    setMoonAgeCalendarOpen(false);
    setProjectSaveOpen(false);

    const showMainScreenAfterPageRestore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setSpotSearchOpen(false);
      setArCameraOpen(false);
      setArSearchTripod(null);
      setArSearchCameraSettings(null);
      setArSearchAspectRatio(null);
      setProjectSaveTripodOverride(null);
      setCelestialTransitSearchOpen(false);
      setSavedPlansOpen(false);
      setCalendarOpen(false);
      setMoonAgeCalendarOpen(false);
      setProjectSaveOpen(false);
    };

    window.addEventListener("pageshow", showMainScreenAfterPageRestore);
    return () => window.removeEventListener("pageshow", showMainScreenAfterPageRestore);
  }, []);

  useEffect(() => () => {
    if (currentLocationMessageTimerRef.current !== null) {
      window.clearTimeout(currentLocationMessageTimerRef.current);
    }
  }, []);

  const previewAspectRatio =
    previewFrameMode === "landscape-3-2"
      ? 3 / 2
      : previewFrameMode === "portrait-3-2"
        ? 2 / 3
        : previewViewportAspectRatio;

  const previewMeasureDistanceMeters = useMemo(() => {
    if (previewMeasurePoints.length < 2 || !tripodPoint || !subjectPoint) return null;
    const [pointA, pointB] = previewMeasurePoints;
    try {
      return measurePreviewDistanceMeters(
        tripodPoint,
        subjectPoint,
        cameraSettings,
        previewAspectRatio,
        calculationMode,
        previewViewCorrection,
        pointA,
        pointB
      ).distanceMeters;
    } catch (error) {
      console.warn("プレビュー計測の距離を算出できませんでした", error);
      return null;
    }
  }, [
    previewMeasurePoints,
    tripodPoint,
    subjectPoint,
    cameraSettings,
    previewAspectRatio,
    calculationMode,
    previewViewCorrection,
  ]);

  function handlePreviewMeasureTap(xPercent: number, yPercent: number): void {
    setPreviewMeasurePoints((current) =>
      current.length >= 2 ? [{ xPercent, yPercent }] : [...current, { xPercent, yPercent }]
    );
  }

  const previewImagingFrameStyle = useMemo(() => {
    if (previewFrameMode === "screen") {
      return { width: "100%", height: "100%" };
    }
    if (previewViewportAspectRatio > previewAspectRatio) {
      return {
        width: `${(previewAspectRatio / previewViewportAspectRatio) * 100}%`,
        height: "100%",
      };
    }
    return {
      width: "100%",
      height: `${(previewViewportAspectRatio / previewAspectRatio) * 100}%`,
    };
  }, [previewAspectRatio, previewFrameMode, previewViewportAspectRatio]);

  const selectedDate = useMemo(
    () => dateFromZonedDateTimeLocal(dateTimeLocal, timeZone),
    [dateTimeLocal, timeZone]
  );
  const selectedDateText = dateTimeLocal.slice(0, 10);
  const selectedDayStart = useMemo(
    () =>
      dateFromZonedDateTimeLocal(
        `${selectedDateText}T00:00`,
        timeZone
      ),
    [selectedDateText, timeZone]
  );
  const selectedDayEnd = useMemo(() => {
    const serial = daySerialFromDateText(selectedDateText);
    return dateFromZonedDateTimeLocal(
      `${dateTextFromDaySerial(serial + 1)}T00:00`,
      timeZone
    );
  }, [selectedDateText, timeZone]);

  const metrics = useMemo(() => {
    if (!subjectPoint || !tripodPoint) {
      return null;
    }

    return calculateKarneyLineMetrics(tripodPoint, subjectPoint);
  }, [subjectPoint, tripodPoint]);

  const googleMapUrl = useMemo(() => {
    const centerValue = `${mapCenter.latitude},${mapCenter.longitude}`;
    return `https://maps.google.com/maps?ll=${encodeURIComponent(centerValue)}&z=${mapZoom}&output=embed&hl=ja&t=m`;
  }, [mapCenter, mapZoom]);

  const previewReady = Boolean(
    mapReady && subjectPoint && tripodPoint
  );

  const foregroundOverlapsSubjectPin = useMemo(() => {
    if (!foregroundObject?.enabled || !subjectPoint) return false;
    try {
      return calculateKarneySurfaceDistanceMeters(
        {
          latitude: foregroundObject.latitude,
          longitude: foregroundObject.longitude,
        },
        subjectPoint
      ) <= 0.5;
    } catch {
      return false;
    }
  }, [foregroundObject, subjectPoint]);

  const celestialPoints = useMemo(() => {
    if (!tripodPoint || !subjectPoint) {
      return [];
    }

    if (Number.isNaN(selectedDate.getTime())) {
      return [];
    }

    return calculateCelestialScreenPoints(
      selectedDate,
      tripodPoint,
      subjectPoint,
      cameraSettings,
      previewAspectRatio,
      calculationMode,
      previewViewCorrection,
      previewRefractionWeather
    );
  }, [
    selectedDate,
    tripodPoint,
    subjectPoint,
    cameraSettings,
    previewAspectRatio,
    calculationMode,
    previewViewCorrection,
    previewRefractionWeather,
  ]);

  const celestialOcclusionDirections = useMemo(
    () => {
      if (
        !tripodPoint ||
        !subjectPoint ||
        Number.isNaN(selectedDate.getTime())
      ) {
        return [];
      }
      const observerAtLens = {
        ...tripodPoint,
        height: tripodPoint.height + cameraSettings.lensCenterHeightMeters,
      };
      return (["sun", "moon", "milkyWay", "polaris"] as const).map((id) => ({
        id,
        ...calculateCelestialHorizontalCoordinates(
          id,
          selectedDate,
          observerAtLens,
          calculationMode,
          previewRefractionWeather
        ),
      }));
    },
    // 焦点距離・画角・構図補正は水平座標を変えないため依存させない。
    [
      tripodPoint,
      subjectPoint,
      selectedDate,
      cameraSettings.lensCenterHeightMeters,
      calculationMode,
      previewRefractionWeather,
    ]
  );

  useEffect(() => {
    // 遮蔽キャッシュは観測地点・日時・大気条件が変わった場合だけ無効化する。
    // 焦点距離・画角・構図補正は天体の方位高度を変えないため対象外。
    invalidateCelestialOcclusionCaches(mapViewerRef.current ?? undefined);
    setCelestialOcclusion({});
    setMilkyWayLineOfSight({});
  }, [
    tripodPoint,
    selectedDate,
    cameraSettings.lensCenterHeightMeters,
    previewRefractionWeather,
    mapReady,
  ]);

  const milkyWayPath = useMemo(() => {
    if (!tripodPoint || !subjectPoint) {
      return [];
    }

    if (Number.isNaN(selectedDate.getTime())) {
      return [];
    }
    // 連続スクロール中も点表示へ落とさず、粗い銀河面帯を維持する。
    // 停止後は5°刻みへ戻し、形状を精密化する。
    return calculateMilkyWayScreenPath(
      selectedDate,
      tripodPoint,
      subjectPoint,
      cameraSettings,
      previewAspectRatio,
      calculationMode,
      previewViewCorrection,
      timelineInteracting ? 20 : 5,
      previewRefractionWeather
    );
  }, [
    selectedDate,
    tripodPoint,
    subjectPoint,
    cameraSettings,
    previewAspectRatio,
    calculationMode,
    previewViewCorrection,
    timelineInteracting,
    previewRefractionWeather,
  ]);

  const visibleMilkyWayPath = useMemo(
    () => milkyWayPath.map((point, index) => ({
      ...point,
      lineOfSightVisible: milkyWayLineOfSight[index],
    })),
    [milkyWayLineOfSight, milkyWayPath]
  );

  const celestialTracks = useMemo(() => {
    if (!tripodPoint || !subjectPoint) return [];
    if (
      Number.isNaN(selectedDayStart.getTime()) ||
      Number.isNaN(selectedDayEnd.getTime())
    ) return [];
    return calculateCelestialScreenTracks(
      tripodPoint,
      subjectPoint,
      cameraSettings,
      previewAspectRatio,
      calculationMode,
      selectedDayStart,
      selectedDayEnd,
      timeZone,
      previewViewCorrection,
      previewRefractionWeather
    );
  }, [
    selectedDayStart,
    selectedDayEnd,
    tripodPoint,
    subjectPoint,
    cameraSettings,
    previewAspectRatio,
    calculationMode,
    timeZone,
    previewViewCorrection,
    previewRefractionWeather,
  ]);

  useEffect(() => {
    // 被写体ピンを新しく置いた直後は、モバイルのpointer/touch終了イベントが
    // 取りこぼされていても候補計算を再開できるよう、時間操作中フラグを解除する。
    // これにより、被写体確定時点の天体位置から三脚候補点を必ず再計算する。
    if (subjectPoint) setTimelineInteracting(false);
  }, [subjectPoint]);

  const tripodCandidateSourcePoints = useMemo(() => {
    // 三脚ピンがまだ無い段階でも、被写体ピン地点を初期観測地点として
    // 各天体の方位・高度を作り、三脚候補計算を開始できるようにする。
    // calculateTripodCandidates() 内で候補地点を反復更新するため、
    // 実際の候補位置における天体位置へ収束する。
    if (celestialPoints.length > 0) return celestialPoints;
    if (!subjectPoint || Number.isNaN(selectedDate.getTime())) return [];

    const definitions = [
      { id: "sun" as const, label: "太陽" },
      { id: "moon" as const, label: "月" },
      { id: "milkyWay" as const, label: "天の川" },
      { id: "polaris" as const, label: "北極星" },
    ];
    // カメラ高はUIの任意設定値を唯一の基準にする。heightだけを加算すると
    // ellipsoidal/orthometricHeightMeters が古い地表高のまま残り、天体計算と
    // ECEF/DEM計算で観測点高が分裂するため、共通helperで全高さ基準を同時更新する。
    const initialObserver = withLensCenterHeight(
      subjectPoint,
      cameraSettings.lensCenterHeightMeters,
      "三脚候補初期天体観測点"
    );

    return definitions.map(({ id, label }) => ({
      id,
      label,
      ...calculateCelestialHorizontalCoordinates(
        id,
        selectedDate,
        initialObserver,
        calculationMode,
        previewRefractionWeather
      ),
      xPercent: 50,
      yPercent: 50,
      inFront: true,
      visibleInFrame: false,
    }));
  }, [
    celestialPoints,
    subjectPoint,
    selectedDate,
    cameraSettings.lensCenterHeightMeters,
    calculationMode,
    previewRefractionWeather,
  ]);

  useEffect(() => {
    const controller = new AbortController();

    const weatherReferencePoint = tripodPoint ?? subjectPoint;
    if (
      precisionSettings.refractionCorrectionMode !== "auto"
      || !weatherReferencePoint
      || Number.isNaN(selectedDayStart.getTime())
      || Number.isNaN(selectedDayEnd.getTime())
    ) {
      setPreviewRefractionWeather(undefined);
      return () => controller.abort();
    }

    // Phase4-4: プレビュー、軌跡、遮蔽計算は同じ気象コンテキストを共有する。
    // 三脚ピン未設置時は被写体地点を初期気象地点として使い、三脚候補確定後は
    // calculateTripodCandidates() 内で候補地点の気象へ再解決して再収束する。
    // 選択日時そのものを「現在時刻」と誤認せず、実時刻を基準に予報/平年値を選ぶ。
    void prepareRefractionWeatherContext({
      accuracyMode: precisionSettings.accuracyMode,
      mode: precisionSettings.refractionCorrectionMode,
      point: weatherReferencePoint,
      searchStart: selectedDayStart,
      searchEnd: selectedDayEnd,
      now: new Date(),
      signal: controller.signal,
    }).then((context) => {
      if (controller.signal.aborted) return;
      if (context.effectiveMode !== "weather") {
        setPreviewRefractionWeather(undefined);
        publishUserNotice({
          key: "preview-weather-unavailable",
          tone: "warning",
          message: "気象データを取得できませんでした。標準大気モデルで表示します。",
        });
        return;
      }
      setPreviewRefractionWeather(context);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setPreviewRefractionWeather(undefined);
      publishUserNotice({
        key: "preview-weather-error",
        tone: "warning",
        message: "気象データの取得に失敗しました。",
      });
    });

    return () => controller.abort();
  }, [
    precisionSettings.accuracyMode,
    precisionSettings.refractionCorrectionMode,
    tripodPoint,
    subjectPoint,
    selectedDayStart,
    selectedDayEnd,
  ]);

  const resolveTripodCandidateRefractionWeather = useCallback(
    async (point: GroundPoint, signal?: AbortSignal): Promise<RefractionWeatherContext | undefined> => {
      if (precisionSettings.refractionCorrectionMode !== "auto") {
        return previewRefractionWeather;
      }
      const localController = signal ? undefined : new AbortController();
      const resolvedSignal = signal ?? localController!.signal;
      const context = await prepareRefractionWeatherContext({
        accuracyMode: precisionSettings.accuracyMode,
        mode: precisionSettings.refractionCorrectionMode,
        point,
        searchStart: selectedDayStart,
        searchEnd: selectedDayEnd,
        now: new Date(),
        signal: resolvedSignal,
      });
      return context;
    },
    [
      precisionSettings.accuracyMode,
      precisionSettings.refractionCorrectionMode,
      previewRefractionWeather,
      selectedDayStart,
      selectedDayEnd,
    ]
  );

  const tripodSearchLines = useMemo(
    () => buildTripodSearchBaseLines(
      subjectPoint,
      tripodCandidateSourcePoints,
      celestialVisibility
    ),
    [subjectPoint, tripodCandidateSourcePoints, celestialVisibility]
  );

  const displayedTripodCandidates = useMemo(() => {
    if (!timelineInteracting || !subjectPoint) {
      // 2026-08-28追記: まだ精密計算が終わっていない（確定候補がまだない）
      // 天体については、通信を待たずに表示できる暫定候補（地球を完全な
      // 球体とみなした理論値、solutionType: "preliminary"）を補って表示する。
      // 精密計算が終わった天体は、確定候補（tripodCandidates）が優先される
      // （setPreliminaryTripodCandidatesが完了時に空にリセットされるため、
      // 自然にこの補完は行われなくなる）。
      const confirmedIds = new Set(tripodCandidates.map((candidate) => candidate.id));
      const preliminaryOnly = Object.values(preliminaryTripodCandidates).filter(
        (candidate): candidate is TripodCandidate =>
          candidate !== undefined && !confirmedIds.has(candidate.id)
      );
      return preliminaryOnly.length > 0
        ? [...tripodCandidates, ...preliminaryOnly]
        : tripodCandidates;
    }
    const previousById = new Map<TripodCandidate["id"], TripodCandidate[]>();
    for (const candidate of tripodCandidatesRef.current) {
      const list = previousById.get(candidate.id) ?? [];
      list.push(candidate);
      previousById.set(candidate.id, list);
    }
    // ドラッグ中は通信を伴うDEM探索を行わず、直前に確定した全交点の距離を
    // 現在時刻の天体方位へ再投影する。複数候補を1件へ潰さない。
    return tripodCandidateSourcePoints.flatMap((point) => {
      if (!celestialVisibility[point.id] || point.altitudeDegrees <= 0.25) return [];
      const previousCandidates = previousById.get(point.id) ?? [];
      return previousCandidates.map((previous) => {
        const destination = calculateKarneyDestinationPoint(
          subjectPoint,
          (point.azimuthDegrees + 180) % 360,
          previous.distanceMeters
        );
        return {
          ...previous,
          label: point.label,
          latitude: destination.latitude,
          longitude: destination.longitude,
        };
      });
    });
  }, [
    celestialVisibility,
    subjectPoint,
    timelineInteracting,
    tripodCandidateSourcePoints,
    tripodCandidates,
    preliminaryTripodCandidates,
  ]);

  const selectableDisplayedTripodCandidates = useMemo(
    () => displayedTripodCandidates,
    [displayedTripodCandidates]
  );

  useEffect(() => {
    const enabledPoints = tripodCandidateSourcePoints.filter(
      (point) => celestialVisibility[point.id]
    );
    if (!subjectPoint || enabledPoints.length === 0) {
      tripodCandidatesRef.current = [];
      setTripodCandidates([]);
      setPreliminaryTripodCandidates({});
      setTripodCandidateCalculationStatus("idle");
      return;
    }
    if (timelineInteracting) {
      // 操作中はdisplayedTripodCandidatesの軽量再投影を使用し、
      // 操作停止後に下のDEM精密計算を一度だけ実行する。
      return;
    }

    // 直前の確定候補を天体IDごとの距離ヒントとして保持する。時刻操作後の
    // 再計算や被写体ピンの微調整では、実際の解が前回とほぼ同じ距離帯に
    // あることが多く、これを渡すとDEMの全距離走査（コールドスタート）を
    // 避けて1点確認または近傍のみの狭い走査で済むことが多い
    // （spotPresetSearch.tsの前回距離再利用と同じ仕組み）。
    // 外れていた場合は自動的に従来どおりの全距離走査へフォールバックする。
    //
    // ただし被写体そのものが切り替わった場合、前回の距離ヒントはほぼ確実に
    // 無関係（別の場所までの距離）であり、渡すと「ヒント周辺の無駄な探索」
    // →「結局全距離走査」という二度手間で逆に遅くなる。被写体の緯度経度が
    // 前回と十分近い（同一被写体とみなせる、約10m以内）場合だけヒントを使う。
    const SUBJECT_SAME_THRESHOLD_METERS = 10;
    const previousHintSubject = tripodHintSubjectRef.current;
    const isSameSubjectAsBefore =
      previousHintSubject !== null &&
      calculateKarneyLineMetrics(
        { latitude: previousHintSubject.latitude, longitude: previousHintSubject.longitude, height: 0 } as GroundPoint,
        { latitude: subjectPoint.latitude, longitude: subjectPoint.longitude, height: 0 } as GroundPoint
      ).distanceMeters <= SUBJECT_SAME_THRESHOLD_METERS;
    tripodHintSubjectRef.current = {
      latitude: subjectPoint.latitude,
      longitude: subjectPoint.longitude,
    };
    const preferredDistancesById = isSameSubjectAsBefore
      ? tripodCandidatesRef.current.reduce(
          (result, candidate) => {
            const current = result[candidate.id];
            if (current === undefined || candidate.distanceMeters > current) {
              result[candidate.id] = candidate.distanceMeters;
            }
            return result;
          },
          {} as Partial<Record<TripodCandidate["id"], number>>
        )
      : undefined;

    const initialDirectionObserver = tripodPointRef.current
      ? withLensCenterHeight(
          tripodPointRef.current,
          cameraSettings.lensCenterHeightMeters,
          "三脚候補初期方向観測点"
        )
      : undefined;

    // 完全一致結果キャッシュ Phase 1: 標準大気時だけ、同一アプリ実行中の
    // メモリ結果を再利用する。自動気象時は候補地点で解決される気象データの
    // immutableな版情報をまだ持てないため、誤った再利用を避けて無効化する。
    const exactCacheEnabled = precisionSettings.refractionCorrectionMode === "standard";
    // キャッシュを無効にする自動気象時でも、重複探索判定には完全な入力キーを
    // 使う。天体方位・カメラ高などを省いた簡易キーは、異なる探索を同一と誤認する。
    const calculationKey = exactTripodCacheKey({
      subject: subjectPoint,
      points: enabledPoints,
      cameraSettings,
      date: selectedDate,
      calculationMode,
      previewAspectRatio,
      refractionWeather: previewRefractionWeather,
      doubleCheckEnabled: precisionSettings.tripodCandidateDoubleCheckEnabled,
      initialDirectionObserver,
      accuracyMode: precisionSettings.accuracyMode,
      refractionMode: precisionSettings.refractionCorrectionMode,
      preferredDistancesById,
    });
    const exactCacheKey = exactCacheEnabled ? calculationKey : null;
    const exactCachedCandidates = exactCacheKey
      ? getExactTripodCandidates(exactCacheKey)
      : null;
    if (exactCachedCandidates) {
      tripodCandidatesRef.current = exactCachedCandidates;
      setTripodCandidates(exactCachedCandidates);
      setPreliminaryTripodCandidates({});
      setTripodCandidateCalculationStatus("complete");
      return;
    }

    const activeCalculation = tripodCalculationInFlightRef.current;
    if (activeCalculation?.key === calculationKey) return;
    const runId = tripodCalculationRunIdRef.current + 1;
    tripodCalculationRunIdRef.current = runId;
    tripodCalculationInFlightRef.current = { key: calculationKey, runId };
    const releaseInFlight = () => {
      if (tripodCalculationInFlightRef.current?.runId === runId) {
        tripodCalculationInFlightRef.current = null;
      }
    };

    // キャッシュ・気象・地形I/Oを待たず、WGS84楕円体との理論交点を概算候補
    // として即時表示する。精密探索が完了した天体からaligned候補へ置き換える。
    tripodCandidatesRef.current = [];
    setTripodCandidates([]);
    const immediatePreliminaryCandidates = buildPreliminaryTripodCandidates(
      subjectPoint,
      enabledPoints,
      cameraSettings.lensCenterHeightMeters,
      initialDirectionObserver
    );
    setPreliminaryTripodCandidates(Object.fromEntries(
      immediatePreliminaryCandidates.map((candidate) => [candidate.id, candidate])
    ));
    setTripodCandidateCalculationStatus("calculating");

    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        let operationStarted = false;
        try {
          // キャッシュは高速化専用。IndexedDB破損などで読み出せなくても、
          // authoritativeな通常探索は必ず開始して候補表示を止めない。
          let persistedSeeds: Awaited<ReturnType<typeof loadPersistentTripodSeeds>> = {};
          try {
            persistedSeeds = await waitForOptionalTripodCache(
              loadPersistentTripodSeeds(subjectPoint, enabledPoints),
              {},
              "三脚候補seedキャッシュの待機を打ち切り、通常探索を開始します"
            );
          } catch (error) {
            console.warn("三脚候補seedキャッシュを読み出せないため通常探索を続行します", error);
          }
          if (cancelled || controller.signal.aborted) return;
          const persistedDistances = Object.fromEntries(
            Object.entries(persistedSeeds).map(([id, seed]) => [id, seed?.distanceMeters])
          ) as Partial<Record<TripodCandidate["id"], number>>;
          const mergedPreferredDistances = {
            ...persistedDistances,
            ...(preferredDistancesById ?? {}),
          };

          // 保存済みDEMのウォームアップも高速化専用。失敗時は通常の端末キャッシュ
          // / API経路へそのまま進み、探索開始自体を失敗させない。
          const persistedSeedPoints = Object.values(persistedSeeds)
            .filter((seed): seed is NonNullable<typeof seed> => Boolean(seed))
            .map((seed) => ({ latitude: seed.latitude, longitude: seed.longitude }));
          if (persistedSeedPoints.length > 0) {
            try {
              await waitForOptionalTripodCache(
                warmGsiDeviceTilesFromPersistentCache(persistedSeedPoints),
                undefined,
                "三脚候補DEMキャッシュの事前読込待機を打ち切り、通常探索を開始します"
              );
            } catch (error) {
              console.warn("三脚候補DEMキャッシュを事前読込できないため通常探索を続行します", error);
            }
            if (cancelled || controller.signal.aborted) return;
          }

          beginOperationTag("calculateTripodCandidates");
          operationStarted = true;
          const candidates = await calculateTripodCandidates(
            subjectPoint,
            enabledPoints,
            cameraSettings,
            selectedDate,
            calculationMode,
            undefined,
            controller.signal,
            previewAspectRatio,
            undefined,
            undefined,
            previewRefractionWeather,
            mergedPreferredDistances,
            resolveTripodCandidateRefractionWeather,
            precisionSettings.tripodCandidateDoubleCheckEnabled,
            initialDirectionObserver,
            (preliminary) => {
              if (cancelled || controller.signal.aborted) return;
              setPreliminaryTripodCandidates((current) => ({
                ...current,
                [preliminary.id]: preliminary,
              }));
            },
            (resolvedId, resolvedCandidates) => {
              if (cancelled || controller.signal.aborted || resolvedCandidates.length === 0) return;
              // 先に完了した天体の全交点を即時表示し、遅い天体の完了を待たない。
              setTripodCandidates((current) => {
                if (cancelled || controller.signal.aborted) return current;
                const merged = [
                  ...current.filter((candidate) => candidate.id !== resolvedId),
                  ...resolvedCandidates,
                ];
                tripodCandidatesRef.current = merged;
                return merged;
              });
              setPreliminaryTripodCandidates((current) => {
                if (current[resolvedId] === undefined) return current;
                const next = { ...current };
                delete next[resolvedId];
                return next;
              });
            }
          );
          if (!cancelled) {
            const displayedCandidates = candidates;
            tripodCandidatesRef.current = displayedCandidates;
            setTripodCandidates(displayedCandidates);
            // 精密解が得られた天体だけ暫定値を除去する。解なし・通信失敗の
            // 天体は概算候補を残し、ユーザーが地図上で確認できるようにする。
            const confirmedIds = new Set(displayedCandidates.map((candidate) => candidate.id));
            setPreliminaryTripodCandidates((current) => Object.fromEntries(
              Object.entries(current).filter(([id]) => !confirmedIds.has(id as TripodCandidate["id"]))
            ));
            setTripodCandidateCalculationStatus(
              candidates.length > 0 ? "complete" : "no-solution"
            );
            // Persist only final aligned candidates as future search seeds. A seed
            // can only narrow the first search window; it can never bypass final
            // convergence/refinement or the wide-scan fallback.
            void savePersistentTripodSeeds(subjectPoint, enabledPoints, candidates).catch((error) => {
              console.warn("三脚候補seedキャッシュを保存できませんでした", error);
            });
            if (exactCacheKey) setExactTripodCandidates(exactCacheKey, candidates);
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          console.warn("三脚候補地点を計算できませんでした", error);
          if (!cancelled) {
            tripodCandidatesRef.current = [];
            setTripodCandidates([]);
            // 既に表示できた概算候補は消さない。精密計算だけが失敗したことを
            // 明示しつつ、候補確認・再試行のどちらも可能な状態を維持する。
            setTripodCandidateCalculationStatus("error");
            const isTerrainDataUnavailable =
              error instanceof Error && error.name === "TerrainDataUnavailableError";
            showUserNotice({
              key: "tripod-candidate-calculation",
              tone: "error",
              message: isTerrainDataUnavailable
                ? `地形データを取得できず、三脚候補を計算できませんでした（${error.message}）。通信状態を確認して再試行してください。`
                : "地形データを取得できず、三脚候補を計算できませんでした。通信状態を確認して再試行してください。",
              diagnosticDetail: buildDiagnosticDetail("三脚候補計算", error, {
                天体: enabledPoints.map((point) => point.id).join(","),
                日時: selectedDate.toISOString(),
                焦点距離mm: cameraSettings.focalLengthMm,
                カメラ高m: cameraSettings.lensCenterHeightMeters,
              }),
              actionLabel: "再試行",
              onAction: () => setTripodCandidateRetrySequence((current) => current + 1),
            });
          }
        } finally {
          if (operationStarted) endOperationTag("calculateTripodCandidates");
          releaseInFlight();
        }
      })();
    }, 0);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
      releaseInFlight();
    };
  }, [
    subjectPoint,
    tripodCandidateSourcePoints,
    celestialVisibility,
    cameraSettings,
    selectedDate,
    calculationMode,
    previewAspectRatio,
    previewRefractionWeather,
    resolveTripodCandidateRefractionWeather,
    timelineInteracting,
    precisionSettings.accuracyMode,
    precisionSettings.refractionCorrectionMode,
    precisionSettings.tripodCandidateDoubleCheckEnabled,
    tripodCandidateRetrySequence,
    showUserNotice,
  ]);

  useEffect(() => {
    if (!mapRef.current) {
      return;
    }

    const accuracyMode = precisionSettings.accuracyMode;

    let disposed = false;
    let localViewer: Viewer | null = null;
    let removeCameraSync: (() => void) | null = null;

    // 2026-08-25追記: 開発者1人のCesium ionトークンを全ユーザーで共有する
    // 方式（VITE_CESIUM_ION_TOKEN）から、各ユーザーが自分のCesium ion
    // アカウントを接続して使う方式（BYOA）へ切り替えた。標準モードは
    // Cesium ionトークンに一切依存しない（createMapViewer内の
    // createStandardViewerはtokenを受け取らない）ため、この変更で標準
    // モードの動作は変わらない。
    const authorizeHighPrecision = async (): Promise<{ available: boolean; token: string | undefined }> => {
      if (accuracyMode !== "highest") return { available: true, token: undefined };

      const cesiumToken = await getValidCesiumIonAccessToken();
      if (!cesiumToken) {
        console.warn("Cesium ion未接続のため標準モードへフォールバックします");
        showUserNotice({
          key: "cesium-ion-connect-prompt",
          tone: "error",
          message: "Googleタイルモードを利用するには、ご自身のCesium ionアカウントの接続が必要です。標準モードで表示しています。",
          actionLabel: "接続する",
          onAction: requestCesiumIonConnection,
        });
        return { available: false, token: undefined };
      }

      // 2026-08-26追記: 「1つのCesium ionアカウントを複数端末で使い回して
      // いないか」を検知する目的の利用回数記録。ただしAstroSightは
      // ユーザーアカウントを持たないため、この端末単体でのカウントに
      // とどまる（詳細はcesiumIonConnection.tsのコメント参照）。
      // 500回（1人の通常利用ではまず届かない水準）に達しても利用は
      // 止めず、複数端末で使っている可能性を案内する警告を出すのみとする。
      const usageCount = recordCesiumIonHighPrecisionUsage();
      if (usageCount === CESIUM_ION_USAGE_WARNING_THRESHOLD) {
        showUserNotice({
          key: "cesium-ion-usage-warning",
          tone: "warning",
          prominent: true,
          message: `このCesium ionアカウントは、この端末だけで今月すでに${usageCount}回、Googleタイルモードを利用しています。1つのアカウントは1台の端末でのみ利用する前提のため、この回数がそのままアカウント全体の今月の利用実績です（他の端末でも使っている場合は、実際はさらに多くなります）。Cesium ion無料プラン（Community）の上限に近づいている、または超えている可能性があります。プランの確認は設定画面から行えます。`,
        });
      }
      return { available: true, token: cesiumToken };
    };

    void authorizeHighPrecision()
      .then(({ available, token }) =>
        createMapViewer(
          mapRef.current!,
          token,
          available ? accuracyMode : "standard",
          setStatus
        )
      )
      .then((viewer) => {
        if (disposed) {
          viewer.destroy();
          return;
        }

        localViewer = viewer;
        mapViewerRef.current = viewer;
        applyMapViewMode(viewer, mapViewModeRef.current, mapCenterRef.current, 0);
        removeCameraSync = viewer.camera.moveEnd.addEventListener(() => {
          if (mapViewModeRef.current !== "3d") return;
          const position = pickCenterPosition(viewer);
          if (!position) return;
          const cartographic = Cartographic.fromCartesian(position);
          setMapCenter({
            latitude: CesiumMath.toDegrees(cartographic.latitude),
            longitude: CesiumMath.toDegrees(cartographic.longitude),
          });
        });
        setMapReady(true);
        setSearchMessage("3Dマップの読込が完了しました");
        setUserNotice((current) =>
          current?.key === "map-initialization" ? null : current
        );
      })
      .catch((error) => {
        console.error("3Dマップ初期化エラー:", error);
        const message = toUserFacingErrorMessage(error, "map");
        setStatus(message);
        showUserNotice({
          key: "map-initialization",
          tone: "error",
          message,
          actionLabel: "再試行",
          onAction: () => setMapInitializationAttempt((current) => current + 1),
        });
      });

    return () => {
      disposed = true;
      disablePlacementRef.current?.();
      disablePlacementRef.current = null;
      mapViewerRef.current = null;
      setMapReady(false);
      removeCameraSync?.();

      if (localViewer && !localViewer.isDestroyed()) {
        localViewer.destroy();
      }
    };
  }, [
    mapInitializationAttempt,
    precisionSettings.accuracyMode,
    requestCesiumIonConnection,
    setSearchMessage,
    showUserNotice,
  ]);

  useEffect(() => {
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed() || !mapReady) return;
    // 2D表示中はCesiumのデフォルト描画ループを完全停止し、非表示3Dの
    // タイル処理・描画がGoogle Maps iframeと競合しないようにする。
    // 3Dへ戻す時は同じViewerを再開し、画質・カメラ・キャッシュを維持する。
    viewer.useDefaultRenderLoop = mapViewMode === "3d";
    if (mapViewMode === "3d") viewer.scene.requestRender();
    return () => {
      if (!viewer.isDestroyed()) viewer.useDefaultRenderLoop = true;
    };
  }, [mapReady, mapViewMode]);

  useEffect(() => {
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed() || !mapReady) return;
    // Cesiumの3Dビューアは3D表示を隠している間もopacity:0で裏レンダリングを
    // 続けているため、mapViewModeを見ずに有効化すると2D表示中でも裏の3D側に
    // 光害タイルの読込負荷がかかりフリーズ・暗転していた（2026-08-16報告）。
    // 実際に3Dが表示されているときだけ有効化する。
    // さらに、highest（Google Photorealistic 3D Tiles）中は、下の
    // 自動2D切替useEffectが効くのが次のレンダリング以降になるため、
    // ここでも明示的に除外しないと切替が反映される前の1フレームだけ
    // 外部WMTSがPhotorealistic 3D Tilesへ重なってしまい、それが
    // クラッシュ（画面ごと暗転）につながっていた（スクリーンショット報告）。
    setLightPollutionLayerVisible(
      viewer,
      mapViewMode === "3d" &&
        precisionSettings.accuracyMode !== "highest" &&
        lightPollutionEnabled &&
        celestialVisibility.milkyWay
    );
  }, [
    celestialVisibility.milkyWay,
    lightPollutionEnabled,
    mapReady,
    mapViewMode,
    precisionSettings.accuracyMode,
  ]);

  useEffect(() => {
    if (!celestialVisibility.milkyWay && lightPollutionEnabled) {
      setLightPollutionEnabled(false);
    }
  }, [celestialVisibility.milkyWay, lightPollutionEnabled]);

  useEffect(() => {
    // Google Photorealistic 3D Tilesには外部WMTSを直接ドレープできないため、
    // Googleタイルモードの3D中に光害マップを有効化した場合は、位置が正確に一致する2D表示へ切り替える。
    if (
      lightPollutionEnabled &&
      precisionSettings.accuracyMode === "highest" &&
      mapViewMode === "3d"
    ) {
      setMapViewMode("2d");
    }
  }, [lightPollutionEnabled, mapViewMode, precisionSettings.accuracyMode]);

  useEffect(() => {
    const element = previewSectionRef.current;

    if (!element) {
      return;
    }

    const updateAspect = () => {
      const rect = element.getBoundingClientRect();
      const nextAspectRatio = rect.height > 0 ? rect.width / rect.height : 16 / 9;
      setPreviewViewportAspectRatio((current) =>
        current === nextAspectRatio ? current : nextAspectRatio
      );
    };

    updateAspect();
    const observer = new ResizeObserver(updateAspect);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = mapSectionRef.current;
    if (!element) return;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      setMapSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height }
      );
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    localStorage.setItem(
      "ksg-camera-settings",
      JSON.stringify(cameraSettings)
    );
  }, [cameraSettings]);

  useEffect(() => {
    localStorage.setItem(
      "ksg-camera-view-correction",
      JSON.stringify(previewViewCorrection)
    );
  }, [previewViewCorrection]);

  useEffect(() => {
    savePrecisionSettingsToStorage(precisionSettings);
  }, [precisionSettings]);


  useEffect(() => {
    mapViewModeRef.current = mapViewMode;
  }, [mapViewMode]);

  useEffect(() => {
    localStorage.setItem(
      LAST_MAP_STATE_STORAGE_KEY,
      JSON.stringify({ center: mapCenter, zoom: mapZoom, viewMode: mapViewMode })
    );
  }, [mapCenter, mapZoom, mapViewMode]);

  useEffect(() => {
    const latitude = tripodPoint?.latitude ?? subjectPoint?.latitude;
    const longitude = tripodPoint?.longitude ?? subjectPoint?.longitude;
    if (latitude === undefined || longitude === undefined) return;
    const controller = new AbortController();
    const previousTimeZone = timeZoneRef.current;
    const absoluteTime = dateFromZonedDateTimeLocal(
      dateTimeLocalRef.current,
      previousTimeZone
    );
    void requestTimeZone(latitude, longitude, controller.signal)
      .then((resolvedTimeZone) => {
        if (resolvedTimeZone === null) return;
        if (
          !isValidTimeZone(resolvedTimeZone) ||
          resolvedTimeZone === previousTimeZone
        ) return;
        // 地点変更で時刻そのものがずれないよう、絶対時刻を保って現地表示へ変換する。
        if (!Number.isNaN(absoluteTime.getTime())) {
          const localized = zonedDateTimeLocalFromDate(
            absoluteTime,
            resolvedTimeZone
          );
          dateTimeLocalRef.current = localized;
          setDateTimeLocal(localized);
        }
        timeZoneRef.current = resolvedTimeZone;
        setTimeZone(resolvedTimeZone);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("撮影地点のタイムゾーンを取得できませんでした", error);
        showUserNotice({
          key: "timezone-fallback",
          tone: "warning",
          message: "撮影地点の時刻設定を取得できなかったため、現在のタイムゾーンをそのまま使用しています。",
        });
      });

    return () => controller.abort();
    // タイムゾーン検索は地点が変わった時だけ行い、日時スクロールでは再取得しない。
  }, [
    subjectPoint?.latitude,
    subjectPoint?.longitude,
    tripodPoint?.latitude,
    tripodPoint?.longitude,
    showUserNotice,
  ]);

  useEffect(() => {
    localStorage.setItem(
      "ksg-celestial-visibility",
      JSON.stringify(celestialVisibility)
    );
  }, [celestialVisibility]);

  useEffect(() => {
    localStorage.setItem(
      "ksg-celestial-datetime",
      dateTimeLocal
    );
  }, [dateTimeLocal]);

  useEffect(() => {
    const viewer = mapViewerRef.current;
    if (
      !mapReady ||
      !viewer ||
      viewer.isDestroyed() ||
      !tripodPoint ||
      celestialOcclusionDirections.length === 0
    ) {
      setCelestialOcclusion({});
      return;
    }
    if (timelineInteracting) {
      // スクロール中は座標描画を優先し、地形・建物の詳細判定は停止後に行う。
      setCelestialOcclusion({});
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    const enabledPoints = celestialOcclusionDirections.filter(
      (point) => celestialVisibility[point.id]
    );
    const checkingEntries = Object.fromEntries(
      enabledPoints.map((point) => [point.id, checkingCelestialOcclusion()])
    ) as CelestialOcclusionMap;
    // 判定中は旧時刻の結果を捨てるが、未検証を遮蔽確定として天体円盤を隠さない。
    setCelestialOcclusion(checkingEntries);
    const timer = window.setTimeout(() => {
      void prepareCelestialLineOfSightObserver(
        viewer,
        tripodPoint,
        cameraSettings.lensCenterHeightMeters,
        controller.signal
      ).then(async (observer) => {
        const updatePointOcclusion = (
          pointId: keyof CelestialVisibility,
          result: CelestialOcclusion
        ) => {
          if (cancelled || controller.signal.aborted) return;
          setCelestialOcclusion((current) => ({
            ...current,
            [pointId]: result,
          }));
        };
        beginOperationTag("evaluateCelestialLineOfSight");
        await Promise.all(enabledPoints.map(async (point) => {
          const result = await evaluateCelestialLineOfSight(
            viewer,
            observer,
            point,
            controller.signal,
            (demResult) => updatePointOcclusion(point.id, demResult),
            thirdDimensionSourceForAccuracyMode(precisionSettings.accuracyMode)
          );
          updatePointOcclusion(point.id, result);
        }));
        endOperationTag("evaluateCelestialLineOfSight");
      }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("天体の地形・建物遮蔽を検証できませんでした", error);
        if (!cancelled) {
          const message = error instanceof Error
            ? error.message
            : "遮蔽判定の準備に失敗しました";
          setCelestialOcclusion(Object.fromEntries(
            enabledPoints.map((point) => [
              point.id,
              failedCelestialOcclusion(message),
            ])
          ));
          // プレビュー画面へのポップアップ表示は行わない。判定が完了しな
          // かった天体は、未検証（失敗）状態として円盤を通常表示のまま
          // 扱う（isCelestialOcclusionConfirmedHiddenがfailed状態を隠れ
          // 確定としないため、静かにフォールバックする）。
        }
      });
    }, 150);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    mapReady,
    tripodPoint,
    celestialOcclusionDirections,
    celestialVisibility,
    cameraSettings.lensCenterHeightMeters,
    timelineInteracting,
    occlusionRetrySequence,
    precisionSettings.accuracyMode,
    showUserNotice,
  ]);

  useEffect(() => {
    const viewer = mapViewerRef.current;
    if (
      !mapReady ||
      !viewer ||
      viewer.isDestroyed() ||
      !tripodPoint ||
      !celestialVisibility.milkyWay ||
      milkyWayPath.length === 0 ||
      timelineInteracting
    ) {
      setMilkyWayLineOfSight({});
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setMilkyWayLineOfSight({});
    const timer = window.setTimeout(() => {
      void prepareCelestialLineOfSightObserver(
        viewer,
        tripodPoint,
        cameraSettings.lensCenterHeightMeters,
        controller.signal
      ).then(async (observer) => {
        const pathVisibility: Partial<Record<number, boolean>> = {};
        const visibleIndexes = milkyWayPath.flatMap((point, index) =>
          point.visibleInFrame ? [index] : []
        );
        // 帯の中心と両端を検証する。判定中・失敗・僅差は遮蔽確定にしない。
        for (let offset = 0; offset < visibleIndexes.length; offset += 2) {
          const batch = visibleIndexes.slice(offset, offset + 2);
          const batchResults = await Promise.all(batch.map(async (index) => {
            const point = milkyWayPath[index];
            const directions = [
              {
                azimuthDegrees: point.azimuthDegrees,
                altitudeDegrees: point.altitudeDegrees,
              },
              {
                azimuthDegrees: point.northEdgeAzimuthDegrees,
                altitudeDegrees: point.northEdgeAltitudeDegrees,
              },
              {
                azimuthDegrees: point.southEdgeAzimuthDegrees,
                altitudeDegrees: point.southEdgeAltitudeDegrees,
              },
            ];
            const checks = await Promise.all(directions.map((direction) =>
              evaluateCelestialLineOfSight(
                viewer,
                observer,
                direction,
                controller.signal,
                undefined,
                thirdDimensionSourceForAccuracyMode(precisionSettings.accuracyMode)
              )
            ));
            const confirmedHidden = checks.some(
              isCelestialOcclusionConfirmedHidden
            );
            const failed = checks.some(
              (check) => check.verificationState === "failed"
            );
            return [index, failed ? undefined : !confirmedHidden] as const;
          }));
          if (cancelled || controller.signal.aborted) return;
          for (const [index, isVisible] of batchResults) {
            if (isVisible === undefined) delete pathVisibility[index];
            else pathVisibility[index] = isVisible;
          }
          setMilkyWayLineOfSight({ ...pathVisibility });
        }
      }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("天の川の地形・建物遮蔽を検証できませんでした", error);
        if (!cancelled) setMilkyWayLineOfSight({});
      });
    }, 150);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    mapReady,
    tripodPoint,
    celestialVisibility.milkyWay,
    milkyWayPath,
    cameraSettings.lensCenterHeightMeters,
    precisionSettings.accuracyMode,
    timelineInteracting,
    occlusionRetrySequence,
  ]);

  useEffect(() => {
    const viewer = mapViewerRef.current;

    if (!viewer || viewer.isDestroyed()) {
      return;
    }
    updateConnectionLine(viewer, tripodPoint, subjectPoint);
  }, [mapReady, tripodPoint, subjectPoint]);

  useEffect(() => {
    const viewer = mapViewerRef.current;
    if (!mapReady || !viewer || viewer.isDestroyed()) return;
    // 2Dで3D読込より先に配置したピンも、Viewer準備完了時に同じ座標へ同期する。
    if (subjectPoint) {
      setSubjectPinFromPosition(
        viewer,
        Cartesian3.fromDegrees(
          subjectPoint.longitude,
          subjectPoint.latitude,
          subjectPoint.height
        ),
        subjectPoint.label,
        subjectPoint
      );
    }
    if (tripodPoint) {
      setTripodPin(
        viewer,
        Cartesian3.fromDegrees(
          tripodPoint.longitude,
          tripodPoint.latitude,
          tripodPoint.height
        ),
        tripodPoint
      );
    }
  }, [mapReady, subjectPoint, tripodPoint]);

  useEffect(() => () => {
    if (foregroundTerrainTimerRef.current !== null) {
      window.clearTimeout(foregroundTerrainTimerRef.current);
    }
    foregroundTerrainRequestRef.current += 1;
  }, []);

  useEffect(() => {
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    updateForegroundObjectEntity(viewer, foregroundObject);
  }, [mapReady, foregroundObject]);

  useEffect(() => {
    const viewer = mapViewerRef.current;
    if (
      !viewer ||
      viewer.isDestroyed() ||
      !foregroundObject ||
      subjectPlacementActive ||
      tripodPlacementActive ||
      foregroundPlacementActive
    ) {
      return;
    }
    return enableForegroundObjectDrag(
      viewer,
      (position) => {
        const coordinates = cartesianToForegroundCoordinates(position);
        placeForegroundAtCoordinates(
          coordinates.latitude,
          coordinates.longitude,
          coordinates.groundHeightMeters,
          false,
          undefined,
          "drag-3d"
        );
      },
      () => {
        setSearchMessage(
          "人物の移動先となる3D表面を取得できませんでした。床・地面・屋上などが見える位置で再操作してください"
        );
      }
    );
    // 他のピン配置中は人物ドラッグを無効化し、複数ハンドラが同じタップを処理しない。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mapReady,
    foregroundObject?.id,
    tripodPoint,
    subjectPoint,
    subjectPlacementActive,
    tripodPlacementActive,
    foregroundPlacementActive,
  ]);

  useEffect(() => {
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    updateTripodDistanceLabel(viewer, metrics?.distanceMeters ?? null);
  }, [mapReady, metrics]);

  useEffect(() => {
    const viewer = mapViewerRef.current;

    if (!viewer || viewer.isDestroyed()) {
      return;
    }
    // 2D表示中のCesiumは非表示なので、3Dへ切り替わるまでEntityを更新しない。
    if (mapViewMode !== "3d") return;

    try {
      beginOperationTag("updateCelestialMapEntities");
      updateCelestialMapEntities(
        viewer,
        tripodPoint,
        subjectPoint,
        celestialPoints,
        celestialTracks,
        visibleMilkyWayPath,
        celestialVisibility,
        displayedTripodCandidates,
        tripodSearchLines,
        celestialOcclusion,
        mapViewMode,
        cameraSettings.lensCenterHeightMeters,
        tripodCandidateCalculationStatus === "calculating"
      );
      endOperationTag("updateCelestialMapEntities");
    } catch (error) {
      // 天体オーバーレイの異常だけで地図本体を失わないよう、描画更新を局所的に停止する。
      console.warn("天体の地図表示を更新できませんでした", error);
      setSearchMessage("天体表示の更新に失敗しました。日時またはピンを再設定してください");
    }
  }, [
    mapReady,
    tripodPoint,
    subjectPoint,
    celestialPoints,
    celestialTracks,
    visibleMilkyWayPath,
    celestialVisibility,
    displayedTripodCandidates,
    tripodSearchLines,
    celestialOcclusion,
    mapViewMode,
    cameraSettings.lensCenterHeightMeters,
    setSearchMessage,
    timelineInteracting,
    tripodCandidateCalculationStatus,
  ]);

  useEffect(() => {
    if (mapTool !== "pin") return;
    function handleOutsidePointer(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (pinToolButtonRef.current?.contains(event.target)) return;
      if (pinDrawerRef.current?.contains(event.target)) return;
      stopAllEditModes();
      setMapTool("none");
    }
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [mapTool]);

  useEffect(() => {
    const viewer = mapViewerRef.current;
    const previewCanvas = previewCanvasRef.current;

    // 時刻操作中は風景Canvasを再撮影せず、軽量な天体DOMだけを追従させる。
    // 既存の高精細化タイマーもeffect cleanupで止め、操作停止後に再開する。
    if (timelineInteracting) return;

    if (
      !mapReady ||
      !viewer ||
      viewer.isDestroyed() ||
      !previewCanvas ||
      !tripodPoint ||
      !subjectPoint
    ) {
      if (!tripodPoint || !subjectPoint) {
        setPreviewStatus("三脚ピンと被写体点を設定してください");
      }
      return;
    }

    const jobId = ++previewJobRef.current;
    let cancelled = false;
    const timers: number[] = [];

    type CameraSignature = { position: Cartesian3; direction: Cartesian3 };
    const cameraSignature = (): CameraSignature => ({
      position: Cartesian3.clone(viewer.camera.positionWC),
      direction: Cartesian3.clone(viewer.camera.directionWC),
    });
    const sameCamera = (a: CameraSignature, b: CameraSignature): boolean =>
      Cartesian3.distanceSquared(a.position, b.position) < 0.0001 &&
      Cartesian3.distanceSquared(a.direction, b.direction) < 1e-12;
    const mapCameraAtSchedule = cameraSignature();

    const updatePreview = (label: string) => {
      const render = async () => {
        if (cancelled || jobId !== previewJobRef.current) return;
        try {
          setPreviewStatus(label);
          await captureTripodPreview(
            viewer,
            previewCanvas,
            tripodPoint,
            subjectPoint,
            cameraSettings,
            calculationMode,
            previewViewCorrection,
            mapViewMode === "3d"
          );

          if (!cancelled && jobId === previewJobRef.current) {
            setPreviewStatus("三脚視点プレビュー");
          }
        } catch (error) {
          console.error("プレビュー生成エラー:", error);
          const message = toUserFacingErrorMessage(error, "preview");
          if (!cancelled && jobId === previewJobRef.current) {
            setPreviewStatus(message);
            showUserNotice({
              key: "preview-render",
              tone: "error",
              message,
              actionLabel: "再試行",
              onAction: () => setPreviewRetrySequence((current) => current + 1),
            });
          }
        }
      };

      const scheduled = previewRenderQueueRef.current.then(render, render);
      previewRenderQueueRef.current = scheduled.then(
        () => undefined,
        () => undefined
      );
      return scheduled;
    };

    void updatePreview("プレビュー生成中…");

    // Preview視点で追加タイルが読み込まれた後に最終高精細描画を1回だけ行う。
    // 従来は1.2秒/3.2秒の2回再撮影していたが、1.2秒時点の中間画像は
    // 3.2秒時点で必ず置き換えられるため、最終画質・座標計算を変えずに省略する。
    timers.push(
      window.setTimeout(() => {
        if (cancelled || jobId !== previewJobRef.current) return;
        const current = cameraSignature();
        if (sameCamera(current, mapCameraAtSchedule)) {
          // 予約後にメイン3Dカメラが動いていなければ従来どおり3.2秒で最終更新。
          void updatePreview("プレビュー最終更新中…");
          return;
        }

        // 3.2秒の待機中にユーザーがパン/ズームした場合、操作中へ強制描画を
        // 割り込ませない。カメラが700ms連続で静止してから最終高精細更新を
        // 1回だけ実施するので、最終画質は維持したまま操作時のカクつきを避ける。
        let previous = current;
        const waitForCameraIdle = () => {
          if (cancelled || jobId !== previewJobRef.current) return;
          const next = cameraSignature();
          if (sameCamera(previous, next)) {
            void updatePreview("プレビュー最終更新中…");
            return;
          }
          previous = next;
          timers.push(window.setTimeout(waitForCameraIdle, 700));
        };
        timers.push(window.setTimeout(waitForCameraIdle, 700));
      }, 3200)
    );

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [
    mapReady,
    tripodPoint,
    subjectPoint,
    cameraSettings,
    previewFrameMode,
    previewViewCorrection,
    calculationMode,
    mapViewMode,
    timelineInteracting,
    previewRetrySequence,
    showUserNotice,
  ]);

  function stopPlacementMode() {
    disablePlacementRef.current?.();
    disablePlacementRef.current = null;
    placementModeRef.current = "none";
    setSubjectPlacementActive(false);
    setTripodPlacementActive(false);
    setForegroundPlacementActive(false);
  }

  function stopAllEditModes() {
    stopPlacementMode();
    setSubjectEditActive(false);
    if (disableMapMeasurementRef.current) {
      disableMapMeasurementRef.current();
      disableMapMeasurementRef.current = null;
      setMapMeasuring(false);
      setMapMeasureDistanceMeters(null);
    }
  }

  /**
   * 地図クリックで即配置せず、確認ダイアログ（高度オフセット入力つき）を挟む。
   * commitには「はい」が押された後の実際の高度解決・ピン確定処理を渡す。
   */
  function openPlacementConfirm(
    kind: "subject" | "tripod" | "person",
    commit: (offsetMeters: number) => Promise<void>
  ): void {
    setPendingPlacement({ kind, commit });
    setPendingPlacementOffsetMeters(0);
    setPendingPlacementError(null);
    setPendingPlacementBusy(false);
  }

  function cancelPendingPlacement(): void {
    setPendingPlacement(null);
    setPendingPlacementError(null);
    setPendingPlacementBusy(false);
  }

  async function confirmPendingPlacement(): Promise<void> {
    if (!pendingPlacement) return;
    const offsetMeters = Number.isFinite(pendingPlacementOffsetMeters)
      ? pendingPlacementOffsetMeters
      : 0;
    setPendingPlacementBusy(true);
    setPendingPlacementError(null);
    try {
      await pendingPlacement.commit(offsetMeters);
      setPendingPlacement(null);
      setPendingPlacementBusy(false);
      stopPlacementMode();
    } catch (error) {
      console.warn("配置を確定できませんでした", error);
      setPendingPlacementError(
        error instanceof Error && error.message
          ? error.message
          : "高度を取得できませんでした。通信状態を確認して再試行するか、キャンセルしてください"
      );
      setPendingPlacementBusy(false);
    }
  }

  async function resolveSearchSubject(
    latitude: number,
    longitude: number,
    label: string
  ): Promise<GroundPoint> {
    // 検索・URL・座標入力では、DEM（地面）確定・建物屋根面への合わせ込み・
    // OSM高さ推定の3つを並行して行う（互いに入力の緯度経度だけから独立に
    // 求まるため、直列に待つ必要がない）。標準モードは表示用に読み込まれて
    // いるPLATEAU建物へclampToHeightMostDetailed（Cesium標準の表面クランプ
    // API。手動3Dタップと同じ方式）を1回のバッチ呼び出しで通す。Googleタイル
    // モードはその形状データを規約上読み取れないため、この判定専用に完全
    // 透明なPLATEAU建物を別途読み込んでから同じ判定を行う（画面の見た目は
    // Googleタイルのまま）。建物が無い・検証できない場合は、DEM地面の値の
    // まま変更しない。
    const viewer = mapViewerRef.current;
    const groundPointPromise = resolveGroundPoint(latitude, longitude, label);
    const roofPointPromise: Promise<GroundPoint | null> = (async () => {
      if (!viewer || viewer.isDestroyed()) return null;
      try {
        if (precisionSettings.accuracyMode === "highest") {
          await ensureHiddenPlateauBuildingsForHeightLookup(viewer);
          if (viewer.isDestroyed()) return null;
        }
        return await resolvePlateauRoofGroundPoint(viewer, latitude, longitude, label);
      } catch (error) {
        console.warn("被写体地点の建物屋根への合わせ込みに失敗しました", error);
        return null;
      }
    })();
    // 2026-08-29追記: 東京タワー等では、探索座標の近傍（塔の脚元にある
    // 低層のフットタウン等の別建物）にPLATEAUの建物データが存在するため、
    // roofPointがnullにならず、しかし塔本体よりずっと低い高さで「見つかって
    // しまう」ことがあった。以前はroofPointが非nullなら即採用していたため、
    // OSM高さ推定（findOsmSubjectHeightHint）が一度も実行されず、
    // 「タワーの根元（正確には隣接する低い建物の屋上）」にピンが立つ不具合が
    // 残っていた。roofPointの有無で早期returnせず、OSM高さ推定も必ず
    // 並行して取得し、両方が得られた場合はより高い（＝構造物の本体をより
    // よく捉えている可能性が高い）方を採用するよう修正する。
    const osmHintPromise = findOsmSubjectHeightHint(latitude, longitude).catch((error) => {
      console.warn("被写体地点のOSM高さ推定に失敗しました", error);
      return null;
    });
    const [groundPoint, roofPoint, osmHint] = await Promise.all([
      groundPointPromise,
      roofPointPromise,
      osmHintPromise,
    ]);
    const osmPoint = osmHint ? applyOsmSubjectHeightHint(groundPoint, osmHint, label) : null;
    const candidates = [roofPoint, osmPoint].filter(
      (point): point is GroundPoint => point !== null
    );
    if (candidates.length === 0) return groundPoint;
    return candidates.reduce((tallest, current) =>
      ellipsoidalHeightMeters(current) > ellipsoidalHeightMeters(tallest) ? current : tallest
    );
  }

  function currentSubjectPoint(): GroundPoint | null {
    if (subjectPoint) return subjectPoint;
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) return null;
    return getSubjectPinPoint(viewer);
  }

  async function searchFromSpotScreen(
    criteria: SpotSearchCriteria,
    signal: AbortSignal,
    onProgress: (message: string, percent: number) => void
  ): Promise<SpotPresetResult[]> {
    onProgress(criteria.useCurrentSubjectPin
      ? "現在の被写体ピンから検索条件を準備しています…"
      : "スポット位置を検索しています…", 0);
    const activeSubject = currentSubjectPoint();
    if (criteria.useCurrentSubjectPin && activeSubject && !subjectPoint) {
      setSubjectPoint(activeSubject);
    }
    const location = criteria.useCurrentSubjectPin
      ? activeSubject && {
          latitude: activeSubject.latitude,
          longitude: activeSubject.longitude,
          label: activeSubject.label,
        }
      : await resolveSpotLocation(criteria.query, signal);
    if (!location) {
      throw new Error("現在の被写体ピンがありません。メイン画面で配置してください");
    }
    if (signal.aborted) throw new DOMException("検索中止", "AbortError");
    const searchTimeZone = criteria.useCurrentSubjectPin
      ? timeZone
      : await resolveSpotTimeZone(location, timeZone, signal);
    const subject = criteria.useCurrentSubjectPin && activeSubject
      ? activeSubject
      : await resolveSearchSubject(
          location.latitude,
          location.longitude,
          location.label
        );
    const subjectGround = await resolveGroundPoint(
      location.latitude,
      location.longitude,
      `${location.label} 地表`
    );
    if (signal.aborted) throw new DOMException("検索中止", "AbortError");
    const preparationInput = {
      criteria,
      subject,
      baseDateIso: selectedDate.toISOString(),
      timeZone: searchTimeZone,
      lensCenterHeightMeters: cameraSettings.lensCenterHeightMeters,
      cameraSettings,
      previewAspectRatio,
      subjectGroundHeightMeters: subjectGround.height,
      calculationMode,
      viewCorrection: previewViewCorrection,
      precisionSettings,
    } as const;
    const cacheKey = spotSearchPreparationKey(preparationInput);
    const cacheState = spotSearchCacheState(cacheKey);
    onProgress(
      cacheState === "cold"
        ? "初回検索データを準備しています。初回は通常より時間がかかります。次回以降は保存済みデータを利用して高速化されます。"
        : "保存済みの検索準備データを利用しています…",
      0
    );
    const backgroundInput = {
      ...preparationInput,
      cacheState,
      cacheKey,
    } as const;

    let active: ActiveSpotSearchJob | null = null;
    try {
      // 登録完了後は画面を閉じてもサーバー側ジョブを中断しない。
      active = await startBackgroundSpotSearch(backgroundInput, signal);
      const job = await waitForBackgroundSpotSearch(
        active,
        signal,
        onProgress
      );
      return completeBackgroundSpotSearch(active, job, signal, onProgress);
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw error;
      }
      if (active) clearActiveSpotSearchJob(active);

      // Background Functionが起動しない環境でも検索不能にしない。
      // 同じ天文・測地計算を端末内で実行し、3D状態は未確認候補として利用者へ残す。
      onProgress(
        "サーバー検索を開始できないため、端末内検索へ自動的に切り替えました",
        0
      );
      const localResults = await searchSpotPresets({
        criteria,
        subject,
        baseDate: selectedDate,
        timeZone: searchTimeZone,
        cameraSettings: {
          ...cameraSettings,
          focalLengthMm: criteria.focalLengthMm,
        },
        previewAspectRatio,
        subjectGroundHeightMeters: subjectGround.height,
        calculationMode,
        signal,
        onProgress,
        lineOfSightEvaluator: async () => ({
          verificationState: "failed",
          visible: true,
          verified: false,
          terrainObstructed: false,
          photorealisticMeshObstructed: false,
          reason: "unverified",
        }),
      });
      if (cacheKey) markSpotSearchPrepared(cacheKey);
      return localResults;
    }
  }

  /**
   * バックグラウンド検索（サーバー側でDEM地形の遮蔽まで判定済み）の結果を
   * そのまま確定する。かつてはここでさらに三脚〜被写体間の建物3D遮蔽を
   * 追加確認していたが、その検証ロジックが実際には機能していない疑いが
   * あったため撤去した。遮蔽判定は地形（DEM）のみで行う。
   */
  async function completeBackgroundSpotSearch(
    active: ActiveSpotSearchJob,
    job: SpotSearchJob,
    signal: AbortSignal,
    onProgress: (message: string, percent: number) => void
  ): Promise<SpotPresetResult[]> {
    void signal;
    const results = deserializeSpotSearchResults(job.results).map((result) => ({
      ...result,
      candidate3dStatus: "disabled" as const,
    }));
    await finalizeBackgroundSpotSearch(active, results);
    if (job.input.cacheKey) markSpotSearchPrepared(job.input.cacheKey);
    const diagnosticMessage = job.progress.includes("検索診断")
      ? job.progress.slice(job.progress.indexOf("検索診断"))
      : "";
    onProgress(
      `${results.length}件を取得しました${diagnosticMessage ? `
${diagnosticMessage}
候補保持: ${results.length}件` : ""}`,
      100
    );
    return results;
  }

  async function resumeSpotSearch(
    signal: AbortSignal,
    onProgress: (message: string, percent: number) => void
  ): Promise<SpotPresetResult[] | null> {
    const active = readActiveSpotSearchJob();
    if (!active) return null;
    onProgress("バックグラウンド検索を再開しています…", 0);
    const job = await waitForBackgroundSpotSearch(active, signal, onProgress);
    return completeBackgroundSpotSearch(active, job, signal, onProgress);
  }


  async function locatePinFromSpotScreen(
    target: "subject" | "tripod",
    query: string,
    signal: AbortSignal,
    onProgress: (message: string, percent: number) => void
  ): Promise<void> {
    const viewer = mapViewerRef.current;
    onProgress(target === "subject" ? "被写体の位置を検索しています…" : "三脚位置を検索しています…", 0);
    const location = await resolveSpotLocation(query, signal);
    if (signal.aborted) throw new DOMException("検索中止", "AbortError");
    stopAllEditModes();
    if (target === "tripod") {
      onProgress("三脚位置の標高を取得しています…", 45);
      const pinned = viewer && !viewer.isDestroyed()
        ? await setTripodPinFromCoordinates(
            viewer,
            location.latitude,
            location.longitude,
            true
          )
        : await resolveGroundPoint(
            location.latitude,
            location.longitude,
            "三脚ピン"
          );
      if (signal.aborted) throw new DOMException("検索中止", "AbortError");
      const tripod = { ...pinned, label: location.label || "三脚ピン" };
      const center = { latitude: tripod.latitude, longitude: tripod.longitude };
      setTripodPoint(tripod);
      mapCenterRef.current = center;
      setMapCenter(center);
      if (mapViewMode === "3d" && viewer && !viewer.isDestroyed()) {
        flyMapToTarget(viewer, center.latitude, center.longitude, tripod.height);
      }
      setSpotSearchOpen(false);
      setSearchMessage(`${tripod.label}に三脚ピンを設置しました`);
      return;
    }

    const subject = await resolveSearchSubject(
      location.latitude,
      location.longitude,
      location.label
    );
    if (signal.aborted) throw new DOMException("検索中止", "AbortError");
    const pinned = viewer && !viewer.isDestroyed()
      ? setSubjectPinFromPosition(
          viewer,
          Cartesian3.fromDegrees(
            subject.longitude,
            subject.latitude,
            subject.height
          ),
          subject.label,
          subject
        )
      : subject;
    const center = {
      latitude: pinned.latitude,
      longitude: pinned.longitude,
    };
    setSubjectPoint(pinned);
    setSubjectHistory(addSubjectHistory(pinned, /^https?:\/\//i.test(query.trim()) ? "google-maps-url" : "place"));
    mapCenterRef.current = center;
    setMapCenter(center);
    if (mapViewMode === "3d" && viewer && !viewer.isDestroyed()) {
      flyMapToTarget(viewer, center.latitude, center.longitude, pinned.height);
    }
    setSpotSearchOpen(false);
    setSearchMessage(`${pinned.label}を被写体として表示しました`);
  }

  function applyStoredSubject(record: SubjectRecord) {
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    stopAllEditModes();
    const pinned = setSubjectPinFromPosition(
      viewer,
      Cartesian3.fromDegrees(record.longitude, record.latitude, record.height),
      record.label,
      record
    );
    const center = { latitude: pinned.latitude, longitude: pinned.longitude };
    setSubjectPoint(pinned);
    setSubjectHistory(addSubjectHistory(pinned, record.searchType));
    mapCenterRef.current = center;
    setMapCenter(center);
    if (mapViewMode === "3d") flyMapToTarget(viewer, center.latitude, center.longitude, pinned.height);
    setSpotSearchOpen(false);
    setSearchMessage(`${pinned.label}を被写体として表示しました`);
  }

  function toggleCurrentSubjectFavorite() {
    if (!subjectPoint) return;
    const wasFavorite = isFavoriteSubject(favoriteSubjects, subjectPoint);
    const updated = toggleFavoriteSubject(subjectPoint);
    setFavoriteSubjects(updated);
    // 登録時にすぐ名称を変更できるよう、新規登録した項目のidを通知する。
    // 同じ地点を再登録した場合もidだけでは変化がないため、毎回増えるトークンと組にする。
    favoriteRegistrationTokenRef.current += 1;
    setJustRegisteredFavorite(
      !wasFavorite && updated[0]
        ? { token: favoriteRegistrationTokenRef.current, id: updated[0].id }
        : null
    );
  }

  async function applySpotPreset(result: SpotPresetResult): Promise<void> {
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      setSearchMessage("マップの読込完了後に構図を適用してください");
      return;
    }
    let appliedResult = result;
    if (precisionSettings.accuracyMode === "highest") {      setSpotSearchOpen(false);
      setHighestPrecisionProgress({
        percent: 2,
        message: "三脚位置をGoogleタイルモードで計算中",
      });
      try {
        const refined = await refineSpotPresetHighestPrecision(
          viewer,
          result,
          {
            ...cameraSettings,
            focalLengthMm: result.focalLengthMm,
          },
          previewAspectRatio,
          calculationMode,
          setHighestPrecisionProgress,
          previewRefractionWeather
        );
        appliedResult = {
          ...result,
          subject: refined.subject,
          tripod: refined.tripod,
        };
      } catch (error) {
        console.warn("Googleタイルモード処理を完了できませんでした", error);
        setHighestPrecisionProgress(null);
        const message = toUserFacingErrorMessage(error, "highest-precision");
        setSearchMessage(message);
        showUserNotice({
          key: "highest-precision",
          tone: "error",
          message,
          actionLabel: "検索結果へ戻る",
          onAction: () => setSpotSearchOpen(true),
        });
        return;
      }
    }
    // 標準モード：GoogleタイルモードのGoogle 3Dクランプに相当する処理として、
    // PLATEAU建物をclampToHeightMostDetailedで1回のバッチ呼び出しにより
    // 屋根面へ合わせる（建物が無い・検証できない場合はDEM地面のまま変更
    // しない）。
    // 2026-08-29修正: 東京タワー等、塔の脚元にある別の低い建物（フット
    // タウン等）がPLATEAUに収録されているために roofPoint が非nullかつ
    // 塔本体よりずっと低い高さで「見つかってしまう」ケースがあった。
    // 以前は roofPoint が非nullなら即採用しOSM高さ推定を試さなかったため、
    // 塔の根元付近にピンが立つ不具合が残っていた。roofPointの有無で早期
    // 分岐せず、OSM高さ推定も必ず取得し、得られた高さのうちより高い方を
    // 採用する。
    if (precisionSettings.accuracyMode !== "highest") {
      try {
        const [roofPoint, osmHint] = await Promise.all([
          resolvePlateauRoofGroundPoint(
            viewer,
            appliedResult.subject.latitude,
            appliedResult.subject.longitude,
            appliedResult.subject.label
          ),
          findOsmSubjectHeightHint(
            appliedResult.subject.latitude,
            appliedResult.subject.longitude
          ).catch((error) => {
            console.warn("被写体地点のOSM高さ推定に失敗しました", error);
            return null;
          }),
        ]);
        const osmPoint = osmHint
          ? applyOsmSubjectHeightHint(appliedResult.subject, osmHint, appliedResult.subject.label)
          : null;
        const candidates = [roofPoint, osmPoint].filter(
          (point): point is GroundPoint => point !== null
        );
        if (candidates.length > 0) {
          const tallest = candidates.reduce((current, next) =>
            ellipsoidalHeightMeters(next) > ellipsoidalHeightMeters(current) ? next : current
          );
          appliedResult = { ...appliedResult, subject: tallest };
        }
      } catch (error) {
        console.warn("被写体の建物屋根への合わせ込みに失敗しました", error);
      }
    }
    stopAllEditModes();
    const subject = setSubjectPinFromPosition(
      viewer,
      Cartesian3.fromDegrees(appliedResult.subject.longitude, appliedResult.subject.latitude, appliedResult.subject.height),
      appliedResult.subject.label,
      appliedResult.subject
    );
    const tripod = setTripodPin(
      viewer,
      Cartesian3.fromDegrees(appliedResult.tripod.longitude, appliedResult.tripod.latitude, appliedResult.tripod.height),
      appliedResult.tripod
    );
    const localizedDate = zonedDateTimeLocalFromDate(appliedResult.date, appliedResult.timeZone);
    setSubjectPoint(subject);
    setTripodPoint(tripod);
    setCameraSettings((current) => ({
      ...current,
      focalLengthMm: appliedResult.focalLengthMm,
    }));
    setCelestialVisibility({
      sun: appliedResult.celestialId === "sun",
      moon: appliedResult.celestialId === "moon",
      milkyWay: appliedResult.celestialId === "milkyWay",
      polaris: false,
    });
    timeZoneRef.current = appliedResult.timeZone;
    setTimeZone(appliedResult.timeZone);
    dateTimeLocalRef.current = localizedDate;
    setDateTimeLocal(localizedDate);
    const center = { latitude: appliedResult.subject.latitude, longitude: appliedResult.subject.longitude };
    mapCenterRef.current = center;
    setMapCenter(center);
    if (mapViewMode === "3d") flyMapToTarget(viewer, center.latitude, center.longitude, subject.height);
    setSpotSearchOpen(false);
    setHighestPrecisionProgress(null);
    setSearchMessage(
      precisionSettings.accuracyMode === "highest"
        ? `${appliedResult.celestialLabel}のGoogleタイルモード構図を適用しました`
        : `${appliedResult.celestialLabel}の構図を適用しました`
    );
  }

  function saveCurrentComposition(): void {
    setProjectSaveTripodOverride(null);
    if (!subjectPoint || !tripodPoint) {
      setSearchMessage("保存するには三脚ピンと被写体ピンを設定してください");
      return;
    }
    setProjectSaveOpen(true);
  }

  async function saveCurrentCompositionFromAr(): Promise<void> {
    if (!subjectPoint) {
      setSearchMessage("保存するには被写体を設定してください");
      return;
    }
    const location = arTracking.location;
    if (!location) {
      setSearchMessage("現在地を取得してから保存してください");
      return;
    }
    // GPSが高度を取得できない場合はDEM（地形データ）へフォールバックする。
    // 0mへ単純フォールバックすると、保存した撮影計画へ実際の地表と大きく
    // 異なる高度が恒久的に入ってしまうため。
    const height = location.altitudeMeters ?? (
      await resolveGroundPoint(location.latitude, location.longitude, "AR現在地")
        .then((point) => point.height)
        .catch(() => 0)
    );
    setProjectSaveTripodOverride({
      latitude: location.latitude,
      longitude: location.longitude,
      height,
      label: "AR現在地",
    });
    setProjectSaveOpen(true);
  }

  function formatProjectFallbackName(date: Date): string {
    const parts = new Intl.DateTimeFormat("ja-JP", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}`;
  }

  function commitProjectSave(name: string, calendarRegistered: boolean): void {
    const effectiveTripod = projectSaveTripodOverride ?? tripodPoint;
    if (!subjectPoint || !effectiveTripod) return;
    const now = new Date();
    const project: PlannerProject = {
      id: crypto.randomUUID?.() ?? `project-${now.getTime()}`,
      name: name || formatProjectFallbackName(now),
      createdAtIso: now.toISOString(), updatedAtIso: now.toISOString(),
      shootingDateTimeLocal: dateTimeLocal, timeZone, calendarRegistered,
      subject: subjectPoint, tripod: effectiveTripod, foregroundObjects,
      cameraSettings, celestialVisibility, previewFrameMode, mapViewMode, mapZoom, mapCenter,
      displaySettings: { celestialMenuOpen },
    };
    setProjects(upsertProject(project));
    setProjectSaveOpen(false);
    setProjectSaveTripodOverride(null);
    setSearchMessage("現在の撮影計画をプロジェクトへ保存しました");
  }

  function loadPlannerProject(project: PlannerProject): void {
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) { setSearchMessage("マップの読込完了後にプロジェクトを読み込んでください"); return; }
    stopAllEditModes();
    const subject = setSubjectPinFromPosition(viewer, Cartesian3.fromDegrees(project.subject.longitude, project.subject.latitude, project.subject.height), project.subject.label, project.subject);
    const tripod = setTripodPin(viewer, Cartesian3.fromDegrees(project.tripod.longitude, project.tripod.latitude, project.tripod.height), project.tripod);
    setSubjectPoint(subject); setTripodPoint(tripod);

    // 2026-08-26追記: プロジェクトを開いた直後の最初の三脚探索が、
    // 距離ヒントなしの全距離走査（8m〜50km）になり、無駄に多くの地形
    // データ取得（実機で205点）が発生していた不具合の修正。
    // 「プロジェクトから呼んでいるので初めてではない」にもかかわらず、
    // tripodHintSubjectRef／tripodCandidatesRef はページ読込のたびに
    // 空の状態から始まるため、ヒントが一切効いていなかった。
    // 保存済みの被写体〜三脚間の距離を使い、プロジェクト保存時点で
    // 有効だった天体それぞれに対する初期ヒントとして復元する。
    const savedDistanceMeters = calculateKarneyLineMetrics(tripod, subject).distanceMeters;
    const enabledCelestialIds = (Object.keys(project.celestialVisibility) as CelestialBodyId[])
      .filter((id) => project.celestialVisibility[id]);
    tripodCandidatesRef.current = enabledCelestialIds.map((id) => ({
      id,
      label: "",
      latitude: tripod.latitude,
      longitude: tripod.longitude,
      height: tripod.height,
      distanceMeters: savedDistanceMeters,
      solutionType: "aligned",
    }));
    tripodHintSubjectRef.current = { latitude: subject.latitude, longitude: subject.longitude };

    // 旧形式（ジオイド高・標高フィールド未保存）のプロジェクトは、標高が
    // 楕円体高のまま扱われ、日本国内で約30〜40mの系統誤差になりうる。
    // 楕円体高（3D位置）自体は保存済みの値のまま変更せず、ジオイド高だけを
    // 取得し直して標高を補正する。
    const geoidBackfillRequestId = ++geoidBackfillRequestRef.current;
    if (!isResolvedGroundPoint(subject)) {
      void resolveGroundPointFrom3dSurface(
        Cartesian3.fromDegrees(subject.longitude, subject.latitude, subject.height),
        subject.label
      ).then((resolved) => {
        if (geoidBackfillRequestId !== geoidBackfillRequestRef.current) return;
        setSubjectPoint((current) =>
          current && current.latitude === subject.latitude && current.longitude === subject.longitude
            ? resolved
            : current
        );
      }).catch((error: unknown) => {
        console.warn("旧形式プロジェクトの被写体標高を補正できませんでした", error);
      });
    }
    if (!isResolvedGroundPoint(tripod)) {
      void resolveGroundPointFrom3dSurface(
        Cartesian3.fromDegrees(tripod.longitude, tripod.latitude, tripod.height),
        tripod.label
      ).then((resolved) => {
        if (geoidBackfillRequestId !== geoidBackfillRequestRef.current) return;
        setTripodPoint((current) =>
          current && current.latitude === tripod.latitude && current.longitude === tripod.longitude
            ? resolved
            : current
        );
      }).catch((error: unknown) => {
        console.warn("旧形式プロジェクトの三脚標高を補正できませんでした", error);
      });
    }
    const loadedForegroundObjects = (project.foregroundObjects ?? []).map((object) => ({
      ...object,
      type: "person" as const,
      heightCm: normalizeForegroundHeightCm(object.heightCm),
    }));
    setForegroundObjects(loadedForegroundObjects);
    const loadedForeground = loadedForegroundObjects[0];
    if (loadedForeground) {
      plannedForegroundHeightCmRef.current = loadedForeground.heightCm;
      setPlannedForegroundHeightCm(loadedForeground.heightCm);
    }
    if (loadedForeground?.enabled && !Number.isFinite(loadedForeground.groundHeightMeters)) {
      const requestId = ++foregroundTerrainRequestRef.current;
      void resolveGroundPoint(
        loadedForeground.latitude,
        loadedForeground.longitude,
        "前景・中景オブジェクト"
      ).then((point) => {
        if (requestId !== foregroundTerrainRequestRef.current) return;
        setForegroundObjects((current) => current.map((object, index) =>
          index === 0 ? { ...object, groundHeightMeters: point.ellipsoidalHeightMeters } : object
        ));
      }).catch((error: unknown) => {
        console.warn("保存済み前景オブジェクト地点の標高を取得できませんでした", error);
      });
    }
    setCameraSettings(project.cameraSettings);
    setCelestialVisibility(project.celestialVisibility); setPreviewFrameMode(project.previewFrameMode);
    setMapZoom(project.mapZoom); setMapCenter(project.mapCenter); mapCenterRef.current = project.mapCenter;
    setCelestialMenuOpen(project.displaySettings.celestialMenuOpen);
    timeZoneRef.current = project.timeZone; setTimeZone(project.timeZone);
    dateTimeLocalRef.current = project.shootingDateTimeLocal; setDateTimeLocal(project.shootingDateTimeLocal);
    setSavedPlansOpen(false); setCalendarOpen(false);
    if (project.mapViewMode !== mapViewMode) changeMapViewMode(project.mapViewMode);
    setSearchMessage(`プロジェクト「${project.name}」を読み込みました`);
  }

  function updatePlannerProject(project: PlannerProject): void { setProjects(upsertProject(project)); }
  function removePlannerProject(id: string): void { setProjects(deleteProject(id)); }

  async function shareUrlViaSystemOrClipboard(url: string): Promise<void> {
    const nav = navigator as Navigator & { share?: (data: { title?: string; url?: string }) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({ title: "AstroSight 撮影計画", url });
        return;
      } catch (error) {
        if ((error as { name?: string } | null)?.name === "AbortError") return;
        // 共有シートが使えない場合はクリップボードへフォールバックする。
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setSearchMessage("共有リンクをコピーしました。相手に送ってください");
    } catch (error) {
      console.warn("共有リンクのクリップボードコピーに失敗しました", error);
      setSearchMessage(`共有リンクを作成しました（コピーは失敗）：${url}`);
    }
  }

  function shareProject(project: PlannerProject): void {
    // 緯度経度・カメラ設定・表示設定だけを載せる。高度は受信側で必ず取り直すため含めない。
    const code = encodeProjectShareCode({
      name: project.name,
      shootingDateTimeLocal: project.shootingDateTimeLocal,
      timeZone: project.timeZone,
      subject: {
        latitude: project.subject.latitude,
        longitude: project.subject.longitude,
        label: project.subject.label,
      },
      tripod: {
        latitude: project.tripod.latitude,
        longitude: project.tripod.longitude,
        label: project.tripod.label,
      },
      foregroundObjects: (project.foregroundObjects ?? []).map((object) => ({
        type: object.type,
        latitude: object.latitude,
        longitude: object.longitude,
        heightCm: object.heightCm,
        enabled: object.enabled,
      })),
      cameraSettings: project.cameraSettings,
      celestialVisibility: project.celestialVisibility,
      previewFrameMode: project.previewFrameMode,
    });
    const url = `${window.location.origin}${window.location.pathname}#share=${code}`;
    setQrShareProjectName(project.name);
    setQrShareUrl(url);
  }

  function closeQrShareDialog(): void {
    setQrShareUrl(null);
    setQrShareProjectName("");
  }

  function handleQrScanned(text: string): void {
    setQrScanOpen(false);
    importShareLinkOrCode(text);
  }

  function cancelSharedImport(): void {
    setSharedImportPayload(null);
    setSharedImportError(null);
    setSharedImportBusy(false);
    if (window.location.hash.startsWith("#share=")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }

  async function confirmSharedImport(): Promise<void> {
    if (!sharedImportPayload) return;
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      setSharedImportError("マップの読込完了後に取り込んでください");
      return;
    }
    setSharedImportBusy(true);
    setSharedImportError(null);
    try {
      // 高度はこの端末のHeightResolverで必ず取り直す。送信側の値は使わない。
      // どれか1つでも失敗したら全体を中止する（部分的な取り込みはしない）。
      const [subject, tripod, resolvedForegroundHeights] = await Promise.all([
        resolveGroundPoint(
          sharedImportPayload.subject.latitude,
          sharedImportPayload.subject.longitude,
          sharedImportPayload.subject.label
        ),
        resolveGroundPoint(
          sharedImportPayload.tripod.latitude,
          sharedImportPayload.tripod.longitude,
          sharedImportPayload.tripod.label
        ),
        Promise.all(
          sharedImportPayload.foregroundObjects.map((object) =>
            resolveGroundPoint(object.latitude, object.longitude, "人物・前景オブジェクト")
          )
        ),
      ]);

      stopAllEditModes();
      const subjectPin = setSubjectPinFromPosition(
        viewer,
        Cartesian3.fromDegrees(subject.longitude, subject.latitude, subject.height),
        subject.label,
        subject
      );
      const tripodPin = setTripodPin(
        viewer,
        Cartesian3.fromDegrees(tripod.longitude, tripod.latitude, tripod.height),
        tripod
      );
      setSubjectPoint(subjectPin);
      setTripodPoint(tripodPin);
      setForegroundObjects(
        sharedImportPayload.foregroundObjects.map((object, index) => ({
          id: crypto.randomUUID?.() ?? `foreground-${Date.now()}-${index}`,
          type: object.type,
          latitude: object.latitude,
          longitude: object.longitude,
          heightCm: normalizeForegroundHeightCm(object.heightCm),
          enabled: object.enabled,
          groundHeightMeters: resolvedForegroundHeights[index]?.ellipsoidalHeightMeters,
        }))
      );
      setCameraSettings(sharedImportPayload.cameraSettings);
      setCelestialVisibility(sharedImportPayload.celestialVisibility);
      setPreviewFrameMode(sharedImportPayload.previewFrameMode);
      timeZoneRef.current = sharedImportPayload.timeZone;
      setTimeZone(sharedImportPayload.timeZone);
      dateTimeLocalRef.current = sharedImportPayload.shootingDateTimeLocal;
      setDateTimeLocal(sharedImportPayload.shootingDateTimeLocal);
      setMapCenter({ latitude: subject.latitude, longitude: subject.longitude });

      // 取り込んだら自動的にプリセット（プロジェクト）としても保存する。
      const now = new Date();
      const importedProject: PlannerProject = {
        id: crypto.randomUUID?.() ?? `project-${now.getTime()}`,
        name: sharedImportPayload.name || formatProjectFallbackName(now),
        createdAtIso: now.toISOString(),
        updatedAtIso: now.toISOString(),
        shootingDateTimeLocal: sharedImportPayload.shootingDateTimeLocal,
        timeZone: sharedImportPayload.timeZone,
        calendarRegistered: false,
        subject: subjectPin,
        tripod: tripodPin,
        foregroundObjects: sharedImportPayload.foregroundObjects.map((object, index) => ({
          id: crypto.randomUUID?.() ?? `foreground-${now.getTime()}-${index}`,
          type: object.type,
          latitude: object.latitude,
          longitude: object.longitude,
          heightCm: normalizeForegroundHeightCm(object.heightCm),
          enabled: object.enabled,
          groundHeightMeters: resolvedForegroundHeights[index]?.ellipsoidalHeightMeters,
        })),
        cameraSettings: sharedImportPayload.cameraSettings,
        celestialVisibility: sharedImportPayload.celestialVisibility,
        previewFrameMode: sharedImportPayload.previewFrameMode,
        mapViewMode, mapZoom, mapCenter,
        displaySettings: { celestialMenuOpen },
      };
      setProjects(upsertProject(importedProject));

      setSharedImportPayload(null);
      setSharedImportBusy(false);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setSearchMessage("共有された撮影計画を取り込み、プリセットに保存しました（高度はこの端末で取得し直しました）");
    } catch (error) {
      console.warn("共有された撮影計画の高度を取得できませんでした", error);
      setSharedImportBusy(false);
      setSharedImportError(
        "高度（標高）を取得できなかったため取り込めませんでした。通信状態を確認して再試行してください"
      );
    }
  }

  /** 共有コードを検証しながら開き、取り込み確認ダイアログを表示する。 */
  function openSharedImportFromCode(code: string): void {
    try {
      setSharedImportPayload(decodeProjectShareCode(code));
      setSharedImportError(null);
    } catch (error) {
      const message = error instanceof ProjectShareCodeError
        ? error.message
        : "共有リンクを読み取れませんでした";
      setSearchMessage(message);
    }
  }

  /** プリセットメニューの「取り込む」欄向け。URL全体・コード単体どちらの貼り付けにも対応する。 */
  function importShareLinkOrCode(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const hashIndex = trimmed.indexOf("#share=");
    const code = hashIndex >= 0 ? trimmed.slice(hashIndex + "#share=".length) : trimmed;
    openSharedImportFromCode(code);
  }

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#share=")) return;
    openSharedImportFromCode(hash.slice("#share=".length));
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleSubjectPlacement() {
    if (placementModeRef.current === "subject") {
      stopPlacementMode();
      setSearchMessage("被写体ピン変更を終了しました");
      return;
    }

    stopAllEditModes();
    setMapTool("none");
    setSpotSearchOpen(false);

    if (mapViewMode === "2d") {
      placementModeRef.current = "subject";
      setSubjectPlacementActive(true);
      setSearchMessage("2D地図上で被写体を置く場所をクリックしてください");
      return;
    }

    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      setSearchMessage("3Dマップの読込完了後にお試しください");
      return;
    }

    placementModeRef.current = "subject";
    disablePlacementRef.current = enableMapPlacement(
      viewer,
      (position) => {
        if (placementModeRef.current !== "subject") return;
        openPlacementConfirm("subject", async (offsetMeters) => {
          const rawPoint = await setSubjectPinFromExplicit3dPick(
            viewer,
            position,
            "手動指定地点"
          );
          const point = offsetMeters !== 0
            ? withLensCenterHeight(rawPoint, offsetMeters, rawPoint.label)
            : rawPoint;
          if (offsetMeters !== 0) {
            setSubjectPinFromPosition(
              viewer,
              Cartesian3.fromDegrees(point.longitude, point.latitude, point.height),
              point.label,
              point
            );
          }
          setSubjectPoint(point);
          setMapCenter({ latitude: point.latitude, longitude: point.longitude });
          setSearchMessage(
            `被写体ピンを変更しました：${point.latitude.toFixed(
              6
            )}, ${point.longitude.toFixed(6)}`
          );
        });
      },
      () => {
        setSearchMessage(
          "被写体の3D表面高度を取得できませんでした。建物・地形など対象面が見える位置で再度クリックしてください"
        );
      }
    );

    setSubjectPlacementActive(true);
    setSearchMessage(
      "地図上の被写体位置をクリックしてください"
    );
  }

  type ForegroundPlacementSource = "subject-pin" | "map-2d" | "map-2d-resolved" | "map-3d" | "drag-3d";

  function placeForegroundAtCoordinates(
    latitude: number,
    longitude: number,
    preferredGroundHeightMeters?: number,
    allowSubjectEndpoint = false,
    preferredHeightCm?: number,
    source: ForegroundPlacementSource = "map-3d"
  ): boolean {
    if (!tripodPoint || !subjectPoint) {
      setSearchMessage("三脚ピンと被写体ピンを先に配置してください");
      return false;
    }

    // 人物位置はユーザーが選択した座標をそのまま保持する。
    // 旧実装の「三脚－被写体間の回廊」制限は、2D地図の投影誤差や
    // スマートフォンのタップ誤差で正しい地点を拒否するため廃止する。
    const constrained = { latitude, longitude };
    void allowSubjectEndpoint;

    const fullDistance = calculateKarneyLineMetrics(tripodPoint, subjectPoint).distanceMeters;
    const placementPoint = {
      latitude: constrained.latitude,
      longitude: constrained.longitude,
      height: tripodPoint.height,
      label: "人物配置地点",
    };
    const distanceFromTripod = calculateKarneyLineMetrics(tripodPoint, placementPoint).distanceMeters;
    const ratio = fullDistance > 0
      ? Math.max(0, Math.min(1, distanceFromTripod / fullDistance))
      : 0;
    const interpolatedHeight = tripodPoint.height +
      (subjectPoint.height - tripodPoint.height) * ratio;
    const immediateGroundHeight = Number.isFinite(preferredGroundHeightMeters)
      ? preferredGroundHeightMeters as number
      : interpolatedHeight;

    setForegroundObjects((current) => [{
      id: current[0]?.id ?? (crypto.randomUUID?.() ?? `foreground-${Date.now()}`),
      type: "person",
      latitude: constrained.latitude,
      longitude: constrained.longitude,
      // 配置直後から表示する。2D配置時だけ後からDEM/地形高度で補正する。
      groundHeightMeters: immediateGroundHeight,
      heightCm: normalizeForegroundHeightCm(
        preferredHeightCm ?? plannedForegroundHeightCmRef.current
      ),
      enabled: true,
    }]);

    // 2D地図には表面高度がないため、この経路（source === "map-2d"、または
    // 既にDEM解決済みの"map-2d-resolved"）だけDEM/地形高度で補正する。
    // 被写体ピン・3Dクリック・3Dドラッグで取得した高さは、建物屋上や橋面を
    // 含む実際の3D表面高度なので、後からDEM地表高で上書きしてはいけない。
    if (source === "map-2d") {
      if (foregroundTerrainTimerRef.current !== null) {
        window.clearTimeout(foregroundTerrainTimerRef.current);
        foregroundTerrainTimerRef.current = null;
      }
      foregroundTerrainRequestRef.current += 1;
    } else if (source === "map-2d-resolved") {
      if (foregroundTerrainTimerRef.current !== null) {
        window.clearTimeout(foregroundTerrainTimerRef.current);
        foregroundTerrainTimerRef.current = null;
      }
      foregroundTerrainRequestRef.current += 1;
    }

    return true;
  }

  function placePersonAtSubjectPoint(): void {
    if (!subjectPoint) {
      setSearchMessage("被写体ピンを先に配置してください");
      return;
    }
    stopAllEditModes();
    if (placeForegroundAtCoordinates(
      subjectPoint.latitude,
      subjectPoint.longitude,
      subjectPoint.height,
      true,
      plannedForegroundHeightCmRef.current,
      "subject-pin"
    )) {
      setSearchMessage(`被写体ピン位置に人物を配置しました（高さ ${plannedForegroundHeightCmRef.current}cm）`);
    }
  }

  function toggleForegroundPlacement(): void {
    if (placementModeRef.current === "foreground") {
      stopPlacementMode();
      return;
    }
    if (!tripodPoint || !subjectPoint) {
      setSearchMessage("三脚ピンと被写体ピンを先に配置してください");
      return;
    }
    stopAllEditModes();
    setMapTool("pin");
    if (mapViewMode === "2d") {
      placementModeRef.current = "foreground";
      setForegroundPlacementActive(true);
      setSearchMessage("人物を配置する場所をタップしてください。配置後は人物をドラッグして移動できます");
      return;
    }
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      setSearchMessage("3Dマップの読込完了後にお試しください");
      return;
    }
    placementModeRef.current = "foreground";
    disablePlacementRef.current = enableMapPlacement(viewer, (position) => {
      if (placementModeRef.current !== "foreground") return;
      const coordinates = cartesianToForegroundCoordinates(position);
      openPlacementConfirm("person", async (offsetMeters) => {
        if (!Number.isFinite(coordinates.groundHeightMeters)) {
          throw new Error("人物を置く3D表面高度を取得できませんでした");
        }
        const placed = placeForegroundAtCoordinates(
          coordinates.latitude,
          coordinates.longitude,
          (coordinates.groundHeightMeters as number) + offsetMeters,
          false,
          undefined,
          "map-3d"
        );
        if (!placed) {
          throw new Error("人物を配置できませんでした");
        }
      });
    }, () => {
      setSearchMessage(
        "人物を置く3D表面高度を取得できませんでした。床・地面・屋上などが見える位置で再度クリックしてください"
      );
    });
    setForegroundPlacementActive(true);
    setSearchMessage("3D地図で人物を配置する場所をクリックしてください");
  }

  function updateForegroundHeight(heightCm: number): void {
    const normalizedHeightCm = normalizeForegroundHeightCm(heightCm);
    plannedForegroundHeightCmRef.current = normalizedHeightCm;
    setPlannedForegroundHeightCm(normalizedHeightCm);
    // 配置済みの場合はCesium Entityとプレビューが同じrender cycleで即時更新される。
    setForegroundObjects((current) => current.map((object, index) =>
      index === 0 ? { ...object, heightCm: normalizedHeightCm } : object
    ));
  }

  function deleteForegroundObject(): void {
    stopPlacementMode();
    if (foregroundTerrainTimerRef.current !== null) {
      window.clearTimeout(foregroundTerrainTimerRef.current);
      foregroundTerrainTimerRef.current = null;
    }
    foregroundTerrainRequestRef.current += 1;
    setForegroundObjects([]);
    setSearchMessage("前景・中景オブジェクトを削除しました");
  }

  function toggleTripodPlacement() {
    if (placementModeRef.current === "tripod") {
      stopPlacementMode();
      setSearchMessage("三脚ピン設置を終了しました");
      return;
    }

    stopAllEditModes();
    setMapTool("none");
    setSpotSearchOpen(false);

    if (mapViewMode === "2d") {
      placementModeRef.current = "tripod";
      setTripodPlacementActive(true);
      setSearchMessage("2D地図上で三脚を置く場所をクリックしてください");
      return;
    }

    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      setSearchMessage("3Dマップの読込完了後にお試しください");
      return;
    }

    placementModeRef.current = "tripod";
    disablePlacementRef.current = enableMapPlacement(
      viewer,
      (position) => {
        if (placementModeRef.current !== "tripod") return;
        // 橋面などDEMに存在しない歩行可能な3D表面も、HeightResolver
        // （resolveGroundPointFrom3dSurface）を経由してそのまま採用する。
        openPlacementConfirm("tripod", async (offsetMeters) => {
          const pickedSurfacePoint = await setTripodPinFromExplicit3dPick(viewer, position);
          // 0m is an explicit 3D-surface placement (roof/bridge/etc.).
          // A non-zero "上空" value is defined relative to the ground at the
          // selected latitude/longitude. This prevents a tower facade or other
          // photogrammetry mesh picked by scene.pickPosition() from becoming the
          // accidental +offset baseline (e.g. Tokyo Skytree +640m).
          const groundPoint = offsetMeters !== 0
            ? await resolveGroundPoint(
                pickedSurfacePoint.latitude,
                pickedSurfacePoint.longitude,
                "三脚位置（上空オフセット基準地表）"
              )
            : pickedSurfacePoint;
          const point = offsetMeters !== 0
            ? withVerticalOffset(groundPoint, offsetMeters, "三脚ピン")
            : pickedSurfacePoint;
          if (offsetMeters !== 0) {
            setTripodPin(
              viewer,
              Cartesian3.fromDegrees(point.longitude, point.latitude, point.height),
              point
            );
          }
          setTripodPoint(point);
          setMapCenter({ latitude: point.latitude, longitude: point.longitude });
          setSearchMessage(
            `三脚ピンを配置しました：${point.latitude.toFixed(
              6
            )}, ${point.longitude.toFixed(6)}`
          );
        });
      },
      () => {
        setSearchMessage(
          "三脚を置く3D表面高度を取得できませんでした。地面・床・屋上・橋面などが見える位置で再度クリックしてください"
        );
      }
    );

    setTripodPlacementActive(true);
    setSearchMessage(
      "地図上の三脚を置きたい場所をクリックしてください"
    );
  }

  function handle2dMapPlacement(
    event: ReactMouseEvent<HTMLButtonElement>
  ) {
    const placementMode = placementModeRef.current;
    if (placementMode === "none") return;
    const viewer = mapViewerRef.current;
    const mapElement = map2dStageRef.current;
    if (!mapElement) return;
    const rect = mapElement.getBoundingClientRect();
    const coordinates = coordinatesAtMapPixel(
      event.clientX - rect.left,
      event.clientY - rect.top,
      mapCenter,
      mapZoom,
      { width: rect.width, height: rect.height }
    );

    if (placementMode === "foreground") {
      openPlacementConfirm("person", async (offsetMeters) => {
        const ground = await resolveGroundPoint(
          coordinates.latitude,
          coordinates.longitude,
          "人物配置地点"
        );
        const placed = placeForegroundAtCoordinates(
          coordinates.latitude,
          coordinates.longitude,
          ground.ellipsoidalHeightMeters + offsetMeters,
          false,
          undefined,
          "map-2d-resolved"
        );
        if (!placed) {
          throw new Error("人物を配置できませんでした");
        }
        setSearchMessage("人物を配置しました。ドラッグして移動できます");
      });
    } else if (placementMode === "subject") {
      openPlacementConfirm("subject", async (offsetMeters) => {
        const rawPoint = viewer && !viewer.isDestroyed()
          ? await setSubjectPinFromCoordinates(
              viewer,
              coordinates.latitude,
              coordinates.longitude,
              "手動指定地点",
              false
            )
          : await resolveGroundPoint(
              coordinates.latitude,
              coordinates.longitude,
              "手動指定地点"
            );
        const point = offsetMeters !== 0
          ? withLensCenterHeight(rawPoint, offsetMeters, rawPoint.label)
          : rawPoint;
        if (offsetMeters !== 0 && viewer && !viewer.isDestroyed()) {
          setSubjectPinFromPosition(
            viewer,
            Cartesian3.fromDegrees(point.longitude, point.latitude, point.height),
            point.label,
            point
          );
        }
        setSubjectPoint(point);
        setSearchMessage(
          `被写体ピンを配置しました：${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`
        );
      });
    } else {
      openPlacementConfirm("tripod", async (offsetMeters) => {
        const rawPoint = viewer && !viewer.isDestroyed()
          ? await setTripodPinFromCoordinates(
              viewer,
              coordinates.latitude,
              coordinates.longitude,
              false
            )
          : await resolveGroundPoint(
              coordinates.latitude,
              coordinates.longitude,
              "三脚位置"
            );
        const point = offsetMeters !== 0
          ? withVerticalOffset(rawPoint, offsetMeters, "三脚ピン")
          : rawPoint;
        if (offsetMeters !== 0 && viewer && !viewer.isDestroyed()) {
          setTripodPin(
            viewer,
            Cartesian3.fromDegrees(point.longitude, point.latitude, point.height),
            point
          );
        }
        setTripodPoint(point);
        setSearchMessage(
          `三脚ピンを配置しました：${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`
        );
      });
    }
  }

  function cancelSubjectEdit() {
    setSubjectEditActive(false);
    setSearchMessage("被写体編集をキャンセルしました");
  }

  function confirmSubjectEdit() {
    const viewer = mapViewerRef.current;

    if (!viewer || viewer.isDestroyed()) {
      setSearchMessage("3Dマップを利用できません");
      return;
    }

    const position = pickCenterPosition(viewer);

    if (!position) {
      setSearchMessage(
        "十字位置の3D座標を取得できませんでした。建物または地形へ十字を合わせてください"
      );
      return;
    }

    openPlacementConfirm("subject", async (offsetMeters) => {
      const rawPoint = await setSubjectPinFromExplicit3dPick(
        viewer,
        position,
        "3D指定地点"
      );
      const point = offsetMeters !== 0
        ? withLensCenterHeight(rawPoint, offsetMeters, rawPoint.label)
        : rawPoint;
      if (offsetMeters !== 0) {
        setSubjectPinFromPosition(
          viewer,
          Cartesian3.fromDegrees(point.longitude, point.latitude, point.height),
          point.label,
          point
        );
      }
      setSubjectPoint(point);
      setMapCenter({ latitude: point.latitude, longitude: point.longitude });
      setSubjectEditActive(false);
      setSearchMessage(
        `正式な被写体点を登録しました：${point.latitude.toFixed(
          6
        )}, ${point.longitude.toFixed(6)}`
      );
    });
  }

  function toggleMapMeasurement(): void {
    if (mapMeasuring) {
      disableMapMeasurementRef.current?.();
      disableMapMeasurementRef.current = null;
      setMapMeasuring(false);
      setMapMeasureDistanceMeters(null);
      return;
    }
    if (mapViewMode !== "3d") {
      setSearchMessage("計測は3D表示でのみ利用できます");
      return;
    }
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      setSearchMessage("3Dマップの読込完了後にお試しください");
      return;
    }
    stopAllEditModes();
    setMapTool("none");
    setMapMeasureDistanceMeters(null);
    disableMapMeasurementRef.current = enableMapMeasurement(
      viewer,
      setMapMeasureDistanceMeters,
      () => setSearchMessage("計測地点の3D表面を取得できませんでした。地形・建物が見える位置でタップしてください")
    );
    setMapMeasuring(true);
    setSearchMessage("地図を2回タップして、2点間の距離を計測してください");
  }

  function openMapFullscreen() {
    void enterElementFullscreen(mapSectionRef.current);
  }

  function publishCurrentLocationMessage(
    message: string,
    autoHide = true
  ): void {
    setSearchMessage(message);
    setCurrentLocationMessage(message);
    if (currentLocationMessageTimerRef.current !== null) {
      window.clearTimeout(currentLocationMessageTimerRef.current);
      currentLocationMessageTimerRef.current = null;
    }
    if (autoHide) {
      currentLocationMessageTimerRef.current = window.setTimeout(() => {
        currentLocationMessageTimerRef.current = null;
        setCurrentLocationMessage("");
      }, 7_000);
    }
  }

  function closeCurrentLocationNotice(): void {
    if (currentLocationMessageTimerRef.current !== null) {
      window.clearTimeout(currentLocationMessageTimerRef.current);
      currentLocationMessageTimerRef.current = null;
    }
    setCurrentLocationMessage("");
    setCurrentLocationPermissionDenied(false);
    setCurrentLocationSettingsTarget("app");
  }

  function handleLocationPermissionDenied(): void {
    setCurrentLocationPermissionDenied(true);
    setCurrentLocationSettingsTarget("app");
    publishCurrentLocationMessage(
      `現在地の使用が許可されていません。${locationPermissionInstructions()}`,
      false
    );
  }

  async function openLocationSettingsFromNotice(): Promise<void> {
    try {
      const settingsOpened = currentLocationSettingsTarget === "system-location"
        ? await openNativeSystemLocationSettings()
        : await openNativeLocationSettings();
      if (settingsOpened) {
        publishCurrentLocationMessage(
          currentLocationSettingsTarget === "system-location"
            ? "Androidの位置情報設定を開きました。「位置情報を使用」をONにしてからアプリへ戻り、現在地を再実行してください"
            : "AstroSightの設定画面を開きました。位置情報を許可してからアプリへ戻り、現在地を再実行してください",
          false
        );
        return;
      }
    } catch (error) {
      console.warn("アプリ個別設定への移動に失敗しました", error);
    }
    // Web/PWAからはOSのアプリ個別設定やChromeのサイト権限を
    // 確実に直接開けないため、対象サイトを明記した操作手順を表示する。
    publishCurrentLocationMessage(locationPermissionInstructions(), false);
  }

  async function showCurrentLocation() {
    if (currentLocationPending) return;
    const nativeAndroid = isNativeAndroidApp();
    if (!nativeAndroid && !window.isSecureContext) {
      publishCurrentLocationMessage("現在地はHTTPS接続でのみ取得できます");
      return;
    }
    if (!nativeAndroid && !navigator.geolocation) {
      publishCurrentLocationMessage("この端末またはブラウザでは現在地を取得できません");
      return;
    }

    const requestId = ++currentLocationRequestRef.current;
    setCurrentLocationPending(true);
    setMapTool("none");
    stopAllEditModes();
    setSpotSearchOpen(false);
    setCurrentLocationPermissionDenied(false);
    setCurrentLocationSettingsTarget("app");
    const initialPermissionState = await geolocationPermissionState();
    publishCurrentLocationMessage(
      nativeAndroid
        ? initialPermissionState === "granted"
          ? "Androidから現在地を取得しています…"
          : "Androidの位置情報権限を確認しています…"
        : isInstalledWebApp() &&
        locationSettingsPlatform() === "android" &&
        initialPermissionState !== "granted"
        ? "インストール版の位置情報権限を確認しています。Androidのアプリ権限欄に位置情報が表示されない場合は、Chromeのサイト権限で許可します…"
        : "現在地を取得しています…",
      false
    );

    try {
      // Androidネイティブ版ではCapacitorがOSの実行時権限を要求する。
      // Web/PWA版は同じ関数内で従来のGeolocation APIへ切り替わる。
      let position: DeviceLocation;
      try {
        // まずGPSを優先する。屋内などでタイムアウトした場合は、
        // Wi-Fi・基地局を利用する低精度取得へ自動的に切り替える。
        position = await getDeviceCurrentPosition({
          enableHighAccuracy: true,
          timeout: 15_000,
          maximumAge: 60_000,
        });
      } catch (firstError) {
        if (
          firstError instanceof DeviceLocationError &&
          (
            firstError.failure === "permission-denied" ||
            firstError.failure === "location-disabled"
          )
        ) {
          throw firstError;
        }
        publishCurrentLocationMessage(
          "GPSで取得できないため、通常精度で再取得しています…",
          false
        );
        position = await getDeviceCurrentPosition({
          enableHighAccuracy: false,
          timeout: 15_000,
          maximumAge: 300_000,
        });
      }

      if (requestId !== currentLocationRequestRef.current) return;
      const { latitude, longitude, accuracy } = position;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error("取得した座標が正しくありません");
      }

      const center = { latitude, longitude };
      setCurrentLocationPermissionDenied(false);
      mapCenterRef.current = center;
      // 新しいオブジェクトを必ず設定し、2D iframe・オーバーレイも再描画させる。
      setMapCenter({ latitude: center.latitude, longitude: center.longitude });

      const viewer = mapViewerRef.current;
      if (mapViewModeRef.current === "3d" && viewer && !viewer.isDestroyed()) {
        flyMapToTarget(viewer, latitude, longitude);
      }

      const accuracyText = Number.isFinite(accuracy)
        ? `（精度 約${Math.max(1, Math.round(accuracy))}m）`
        : "";
      const precisionText = position.precision === "approximate"
        ? "（Androidの概算位置。正確な位置情報をONにすると精度が上がります）"
        : "";
      publishCurrentLocationMessage(
        `現在地を地図の中心へ移動しました${accuracyText}${precisionText}`
      );
    } catch (error) {
      if (requestId !== currentLocationRequestRef.current) return;
      if (error instanceof DeviceLocationError) {
        if (error.failure === "permission-denied") {
          handleLocationPermissionDenied();
        } else if (error.failure === "location-disabled") {
          setCurrentLocationPermissionDenied(true);
          setCurrentLocationSettingsTarget("system-location");
          publishCurrentLocationMessage(
            "Android端末の位置情報サービスがOFFです。位置情報設定を開いて「位置情報を使用」をONにしてください",
            false
          );
        } else if (error.failure === "timeout") {
          publishCurrentLocationMessage(
            "現在地の取得がタイムアウトしました。端末の位置情報を確認して再試行してください"
          );
        } else {
          publishCurrentLocationMessage(
            `現在地を取得できませんでした：${error.message || "不明なエラー"}`
          );
        }
      } else {
        publishCurrentLocationMessage(`現在地を取得できませんでした：${error instanceof Error ? error.message : "不明なエラー"}`);
      }
    } finally {
      if (requestId === currentLocationRequestRef.current) {
        setCurrentLocationPending(false);
      }
    }
  }

  function showSubjectOnMap() {
    if (!subjectPoint) {
      setSearchMessage("被写体ピンを先に配置してください");
      return;
    }
    setMapCenter({
      latitude: subjectPoint.latitude,
      longitude: subjectPoint.longitude,
    });
    const viewer = mapViewerRef.current;
    if (mapViewMode === "3d" && viewer && !viewer.isDestroyed()) {
      flyMapToTarget(viewer, subjectPoint.latitude, subjectPoint.longitude);
    }
    setSearchMessage("被写体を地図の中心へ移動しました");
  }

  function showTripodOnMap() {
    if (!tripodPoint) {
      setSearchMessage("三脚ピンを先に配置してください");
      return;
    }
    setMapCenter({
      latitude: tripodPoint.latitude,
      longitude: tripodPoint.longitude,
    });
    const viewer = mapViewerRef.current;
    if (mapViewMode === "3d" && viewer && !viewer.isDestroyed()) {
      flyMapToTarget(viewer, tripodPoint.latitude, tripodPoint.longitude);
    }
    setSearchMessage("三脚ピンを地図の中心へ移動しました");
  }

  function openSubjectInGoogleMaps() {
    if (!subjectPoint) {
      setSearchMessage("被写体ピンを先に配置してください");
      return;
    }
    const query = `${subjectPoint.latitude.toFixed(8)},${subjectPoint.longitude.toFixed(8)}`;
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setSearchMessage("被写体ピンの場所をGoogleマップへ送りました");
  }

  function openTripodInGoogleMaps() {
    if (!tripodPoint) {
      setSearchMessage("三脚ピンを先に配置してください");
      return;
    }
    const query = `${tripodPoint.latitude.toFixed(8)},${tripodPoint.longitude.toFixed(8)}`;
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setSearchMessage("三脚ピンの場所をGoogle Mapsへ送りました");
  }

  function changeMapViewMode(mode: "2d" | "3d") {
    if (mode !== mapViewModeRef.current && placementModeRef.current !== "none") {
      stopPlacementMode();
    }
    const viewer = mapViewerRef.current;
    if (mode === "3d" && (!mapReady || !viewer || viewer.isDestroyed())) {
      // 標準モードはCesium ionトークンを必要としないため、以前あった
      // 「トークン未設定なら2D地図のまま」という分岐は現在の設計と
      // 合わなくなっていた（標準モードは常に3D表示できる）。
      setSearchMessage("3Dマップを読み込み中です。準備が完了してからもう一度お試しください");
      return;
    }
    let synchronizedCenter = mapCenter;
    if (
      viewer &&
      !viewer.isDestroyed() &&
      mapViewModeRef.current === "3d"
    ) {
      const position = pickCenterPosition(viewer);
      if (position) {
        const cartographic = Cartographic.fromCartesian(position);
        synchronizedCenter = {
          latitude: CesiumMath.toDegrees(cartographic.latitude),
          longitude: CesiumMath.toDegrees(cartographic.longitude),
        };
        setMapCenter(synchronizedCenter);
      }
    }
    mapViewModeRef.current = mode;
    setMapViewMode(mode);
    if (!viewer || viewer.isDestroyed()) return;
    applyMapViewMode(viewer, mode, synchronizedCenter);
  }

  function zoomMap(direction: "in" | "out") {
    if (mapViewMode === "2d") {
      setMapZoom((current) =>
        Math.min(20, Math.max(3, current + (direction === "in" ? 1 : -1)))
      );
      return;
    }

    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const amount = Math.max(20, viewer.camera.positionCartographic.height * 0.22);
    if (direction === "in") {
      viewer.camera.zoomIn(amount);
    } else {
      viewer.camera.zoomOut(amount);
    }
    viewer.scene.requestRender();
  }

  function changePreviewFocalLength(value: number) {
    const focalLengthMm = Math.min(
      FOCAL_LENGTH_MAX,
      Math.max(FOCAL_LENGTH_MIN, Math.round(value))
    );
    setCameraSettings((current) => ({ ...current, focalLengthMm }));
  }

  const openArTransitSearch = useCallback(async () => {
    if (!subjectPoint) {
      setSearchMessage("被写体を設定してください");
      return;
    }
    if (!arCameraOpen) return;
    const location = arTracking.location;
    if (!location) {
      setSearchMessage("現在地を取得してから検索してください");
      return;
    }
    // GPSが高度を取得できない端末・状況では、地形データ（DEM）から
    // その地点の標高を求める。0mへ単純フォールバックすると、山地等で
    // 検索基準の高度が実際の地表から大きくズレるため。
    const height = location.altitudeMeters ?? (
      await resolveGroundPoint(location.latitude, location.longitude, "AR検索開始位置")
        .then((point) => point.height)
        .catch(() => 0)
    );
    // GPSの揺れで検索基準が動かないよう、検索ボタンを押した瞬間の現在地を固定する。
    setArSearchTripod({
      latitude: location.latitude,
      longitude: location.longitude,
      height,
      label: "AR検索開始位置",
    });

    // ARカメラの実FOVを、既存のフルサイズ基準検索へ等価焦点距離として渡す。
    // 実焦点距離そのものを流用するとセンサーサイズ差で画角が破綻するため、FOVから換算する。
    if (arCameraProjection) {
      const hFovRad = arCameraProjection.horizontalFovDeg * Math.PI / 180;
      const vFovRad = arCameraProjection.verticalFovDeg * Math.PI / 180;
      const equivalentFocalLength = 36 / (2 * Math.tan(hFovRad / 2));
      const safeFocalLength = Math.min(
        FOCAL_LENGTH_MAX,
        Math.max(FOCAL_LENGTH_MIN, equivalentFocalLength)
      );
      const aspect = Math.tan(hFovRad / 2) / Math.max(1e-9, Math.tan(vFovRad / 2));
      setArSearchCameraSettings({ ...cameraSettings, focalLengthMm: safeFocalLength });
      setArSearchAspectRatio(Number.isFinite(aspect) && aspect > 0 ? aspect : previewAspectRatio);
    } else {
      setArSearchCameraSettings(null);
      setArSearchAspectRatio(null);
    }
    setCelestialTransitSearchOpen(true);
  }, [
    arCameraOpen,
    arCameraProjection,
    arTracking.location,
    cameraSettings,
    previewAspectRatio,
    setSearchMessage,
    subjectPoint,
  ]);

  function placeTripodAtDisplayedCandidate() {
    if (selectableDisplayedTripodCandidates.length === 0) return;
    if (selectableDisplayedTripodCandidates.length === 1) {
      selectTripodCandidate(selectableDisplayedTripodCandidates[0]);
      return;
    }
    setTripodCandidateSelectionOpen(true);
  }

  const [pendingPreliminaryCandidate, setPendingPreliminaryCandidate] =
    useState<TripodCandidate | null>(null);

  function selectTripodCandidate(candidate: TripodCandidate) {
    // 2026-08-28追記: 「候補点計算中」の暫定候補（地形未確認の理論値）を
    // そのまま設置すると、実際には建物や崖の上など、不正確な場所を
    // 指している可能性がある。確認を一度挟み、同意した場合だけ設置する。
    // 三脚を設置しても、裏側で進行中の精密計算（calculateTripodCandidates）
    // は止めない（このダイアログは表示だけの分岐で、計算処理には一切
    // 触れていないため、自然に両立する）。
    if (candidate.solutionType === "preliminary") {
      setTripodCandidateSelectionOpen(false);
      setPendingPreliminaryCandidate(candidate);
      return;
    }
    placeTripodAtCandidateConfirmed(candidate);
  }

  function placeTripodAtCandidateConfirmed(candidate: TripodCandidate) {
    const viewer = mapViewerRef.current;
    setTripodCandidateSelectionOpen(false);
    stopAllEditModes();
    const point = viewer && !viewer.isDestroyed()
      ? setTripodPin(
          viewer,
          Cartesian3.fromDegrees(
            candidate.longitude,
            candidate.latitude,
            candidate.height
          )
        )
      : {
          latitude: candidate.latitude,
          longitude: candidate.longitude,
          height: candidate.height,
          label: "三脚位置",
        };
    setTripodPoint(point);
    setMapCenter({ latitude: point.latitude, longitude: point.longitude });
    setSearchMessage(candidate.solutionType === "direction-only"
      ? `${candidate.label}の方位上にある三脚確認地点へ移動しました（距離 ${Math.round(candidate.distanceMeters)}m）。プレビューと現地の見通しを確認してください`
      : candidate.solutionType === "preliminary"
        ? `${candidate.label}の概算地点へ移動しました（距離 ${Math.round(candidate.distanceMeters)}m）。精密な地形確認が完了次第、位置が自動で更新されます`
        : `${candidate.label}の地形交点候補へ移動しました（距離 ${Math.round(candidate.distanceMeters)}m）。構図はプレビューで確認してください`
    );
    // 三脚候補の最終配置は、通常の手動三脚ピン／プレビューと同じ
    // resolveGroundPoint() を唯一の地表高解決経路として使用する。
    // 2026-08-30: 探索側も既定 terrainSampler を sampleWorldTerrain に統一したため、
    // aligned候補だけ candidate.height を優先して差し戻す補正は廃止した。
    // これにより「探索時の高さ」と「実プレビュー時の高さ」を同じForward Model
    // から得る。direction-only / preliminary の0mフォールバックもここで正式解決する。
    const requestId = ++geoidBackfillRequestRef.current;
    void resolveGroundPoint(candidate.latitude, candidate.longitude, candidate.label)
      .then((resolved) => {
        if (requestId !== geoidBackfillRequestRef.current) return;
        setTripodPoint((current) =>
          current && current.latitude === point.latitude && current.longitude === point.longitude
            ? resolved
            : current
        );
      })
      .catch((error: unknown) => {
        console.warn("三脚候補の標高を確定できませんでした", error);
      });
  }


  return (
    <main className="app" data-ar-tracking={arTracking.location || arTracking.orientation ? "active" : "idle"}>
      <TopSettingsBar
        settings={cameraSettings}
        onChange={setCameraSettings}
        onOpenSavedPlans={() => {
          setProjects(loadProjects());
          setSavedPlansOpen(true);
        }}
        onSaveCurrentPlan={saveCurrentComposition}
        onOpenCalendar={() => { setProjects(loadProjects()); setCalendarOpen(true); }}
        onOpenMoonAgeCalendar={() => setMoonAgeCalendarOpen(true)}
        onOpenArCamera={() => {
          // iOSではDeviceOrientation権限要求をユーザー操作の同期チェーン内で行う必要がある。
          void requestArOrientationPermissionFromUserGesture().finally(() => setArCameraOpen(true));
        }}
        precisionSettings={precisionSettings}
        onPrecisionSettingsChange={setPrecisionSettings}
        cesiumIonConnected={cesiumIonConnected}
        onConnectCesiumIon={requestCesiumIonConnection}
        onDisconnectCesiumIon={handleDisconnectCesiumIon}
      />
      {arCameraOpen && (
        <Suspense fallback={null}>
          <ArCameraScreen
            open={arCameraOpen}
            dateTimeLocal={dateTimeLocal}
            timeZone={timeZone}
            calculationMode={calculationMode}
            refractionWeather={previewRefractionWeather}
            timelineLocation={tripodPoint ?? subjectPoint}
            visibility={celestialVisibility}
            celestialMenuOpen={celestialMenuOpen}
            lightPollutionEnabled={lightPollutionEnabled}
            subjectAvailable={Boolean(subjectPoint)}
            subjectPoint={subjectPoint}
            accuracyMode={precisionSettings.accuracyMode}
            cesiumIonToken={arCesiumIonToken}
            lensCenterHeightMeters={cameraSettings.lensCenterHeightMeters}
            onClose={() => setArCameraOpen(false)}
            onSaveCurrentPlan={saveCurrentCompositionFromAr}
            onChangeDateTime={setDateTimeLocal}
            onInteractionChange={setTimelineInteracting}
            onToggleCelestialMenu={() => setCelestialMenuOpen((current) => !current)}
            onChangeVisibility={setCelestialVisibility}
            onChangeLightPollution={setLightPollutionEnabled}
            onRequestSearch={openArTransitSearch}
            onCameraProjectionChange={setArCameraProjection}
            onTrackingChange={setArTracking}
          />
        </Suspense>
      )}
      <section
        ref={previewSectionRef}
        className="preview-section"
      >
        <div
          className={`preview-imaging-frame frame-${previewFrameMode}`}
          style={previewImagingFrameStyle}
        >
          <canvas
            ref={previewCanvasRef}
            className="preview-canvas"
          />

          <PreviewGestureLayer
            focalLengthMm={cameraSettings.focalLengthMm}
            minFocalLengthMm={FOCAL_LENGTH_MIN}
            maxFocalLengthMm={FOCAL_LENGTH_MAX}
            aspectRatio={previewAspectRatio}
            onChangeFocalLength={changePreviewFocalLength}
            onPan={(azimuthDeltaDegrees, altitudeDeltaDegrees) => {
              setPreviewViewCorrection((current) => ({
                azimuthDegrees: current.azimuthDegrees + azimuthDeltaDegrees,
                altitudeDegrees: Math.min(
                  89,
                  Math.max(-89, current.altitudeDegrees + altitudeDeltaDegrees)
                ),
              }));
            }}
            measuring={previewMeasuring}
            onMeasureTap={handlePreviewMeasureTap}
          />

          <PreviewMeasurementOverlay
            points={previewMeasurePoints}
            distanceMeters={previewMeasureDistanceMeters}
          />

          <CelestialOverlay
            points={celestialPoints}
            tracks={celestialTracks}
            milkyWayPath={visibleMilkyWayPath}
            visibility={celestialVisibility}
            occlusion={celestialOcclusion}
            discOpacity={celestialDragOpacity}
          />

          <ForegroundPreviewOverlay
            object={foregroundObject}
            tripod={tripodPoint}
            subject={subjectPoint}
            camera={cameraSettings}
            aspectRatio={previewAspectRatio}
            calculationMode={calculationMode}
            viewCorrection={previewViewCorrection}
          />

          {previewReady && !foregroundOverlapsSubjectPin && (
            <div className="preview-subject-center" aria-hidden="true">
              <svg viewBox="0 0 28 40">
                <path d="M14 39C11 32 2 24 2 14A12 12 0 0 1 26 14c0 10-9 18-12 25Z" />
                <circle cx="14" cy="14" r="4.5" />
              </svg>
            </div>
          )}
        </div>

        <PreviewStatus ready={previewReady} />

        <PreviewChrome
          frameMode={previewFrameMode}
          onChangeFrameMode={setPreviewFrameMode}
          onZoomIn={() =>
            changePreviewFocalLength(cameraSettings.focalLengthMm * 1.14)
          }
          onZoomOut={() =>
            changePreviewFocalLength(cameraSettings.focalLengthMm * 0.88)
          }
          onResetToSubject={() => setPreviewViewCorrection(DEFAULT_CAMERA_VIEW_CORRECTION)}
          measuring={previewMeasuring}
          onToggleMeasuring={() => {
            setPreviewMeasuring((current) => !current);
            setPreviewMeasurePoints([]);
          }}
        />

        <CelestialMenu
          open={celestialMenuOpen}
          visibility={celestialVisibility}
          onToggleOpen={() =>
            setCelestialMenuOpen((current) => !current)
          }
          onChangeVisibility={setCelestialVisibility}
          lightPollutionEnabled={lightPollutionEnabled}
          onChangeLightPollution={setLightPollutionEnabled}
        />

        <label className="celestial-drag-opacity-control">
          <span>天体透明度</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={celestialDragOpacity}
            onChange={(event) => setCelestialDragOpacity(Number(event.target.value))}
            aria-label="天体の透明度（時間移動中）"
          />
        </label>

        <div className="preview-load-status">
          {previewStatus}
        </div>
      </section>

      <TimelinePanel
        dateTimeLocal={dateTimeLocal}
        location={tripodPoint ?? subjectPoint}
        timeZone={timeZone}
        calculationMode={calculationMode}
        refractionWeather={previewRefractionWeather}
        onChangeDateTime={setDateTimeLocal}
        onOpenTransitSearch={openCelestialTransitSearch}
        onInteractionChange={setTimelineInteracting}
      />

      <section ref={mapSectionRef} className="map-section">
        <div
          ref={mapRef}
          className={mapViewMode === "3d" ? "map-viewer active" : "map-viewer"}
        />
        <div
          ref={map2dStageRef}
          className={mapViewMode === "2d" ? "map-2d-stage active" : "map-2d-stage"}
        >
          {mapViewMode === "2d" && (
            <iframe
              className="google-map-2d"
              src={googleMapUrl}
              title="Googleマップ 2D表示"
              loading="eager"
              referrerPolicy="no-referrer-when-downgrade"
              allowFullScreen
              onLoad={() => {
                const stage = map2dStageRef.current;
                if (!stage) return;
                stage.style.transform = "";
                stage.style.transformOrigin = "";
                stage.classList.remove("dragging");
              }}
            />
          )}
          {mapViewMode === "2d" && lightPollutionEnabled && celestialVisibility.milkyWay && (
            <LightPollutionTileOverlay
              center={mapCenter}
              zoom={mapZoom}
              size={mapSize}
            />
          )}
          {mapViewMode === "2d" && (
            <Map2DOverlay
              center={mapCenter}
              zoom={mapZoom}
              size={mapSize}
              subject={subjectPoint}
              tripod={tripodPoint}
              tripodSubjectDistanceMeters={metrics?.distanceMeters ?? null}
              points={celestialPoints}
              tracks={celestialTracks}
              milkyWayPath={visibleMilkyWayPath}
              visibility={celestialVisibility}
              candidates={displayedTripodCandidates}
              tripodSearchLines={tripodSearchLines}
              foregroundObject={foregroundObject}
              foregroundEditing={foregroundPlacementActive}
              tripodCandidatesCalculating={tripodCandidateCalculationStatus === "calculating"}
              onMoveForeground={(coordinates) => {
                const requestId = ++foregroundTerrainRequestRef.current;
                setSearchMessage("人物移動先の地形高度を取得しています…");
                void resolveGroundPoint(
                  coordinates.latitude,
                  coordinates.longitude,
                  "人物移動先"
                ).then((ground) => {
                  if (requestId !== foregroundTerrainRequestRef.current) return;
                  placeForegroundAtCoordinates(
                    coordinates.latitude,
                    coordinates.longitude,
                    ground.ellipsoidalHeightMeters,
                    false,
                    undefined,
                    "map-2d-resolved"
                  );
                  setSearchMessage("人物位置を更新しました");
                }).catch((error: unknown) => {
                  if (requestId !== foregroundTerrainRequestRef.current) return;
                  console.warn("人物移動先の高度を取得できませんでした", error);
                  setSearchMessage("地形高度を取得できないため人物位置を変更できません");
                });
              }}
              onSelectCandidate={selectTripodCandidate}
            />
          )}
        </div>
        {mapViewMode === "2d" &&
          !subjectPlacementActive &&
          !tripodPlacementActive &&
          !foregroundPlacementActive && (
            <Map2DInteractionLayer
              stageRef={map2dStageRef}
              center={mapCenter}
              zoom={mapZoom}
              size={mapSize}
              onChangeCenter={setMapCenter}
              onChangeZoom={setMapZoom}
            />
          )}
        {mapViewMode === "2d" &&
          (subjectPlacementActive || tripodPlacementActive || foregroundPlacementActive) && (
            <button
              type="button"
              className="map-2d-placement-layer"
              onClick={handle2dMapPlacement}
              aria-label={
                subjectPlacementActive
                  ? "被写体ピンを置く地点を選択"
                  : tripodPlacementActive
                    ? "三脚ピンを置く地点を選択"
                    : "人物を配置する場所を選択"
              }
            >
              <span>
                {subjectPlacementActive ? "被写体" : tripodPlacementActive ? "三脚" : "人物"}を置く地面をクリック
              </span>
            </button>
          )}

        {!subjectEditActive && (
          <div className={foregroundPlacementActive ? "map-controls-layer foreground-placement-mode" : "map-controls-layer"}>
            <div className="map-native-top-left-mask" aria-hidden="true" />
            <div className="map-left-controls">
              <div className="map-tool-rail" aria-label="地図表示ツール">
                <button type="button" data-tutorial-id="map-mode-2d" className={mapViewMode === "2d" ? "active" : ""} onClick={() => changeMapViewMode("2d")}><span>▣</span><small>2D</small></button>
                <button type="button" data-tutorial-id="map-mode-3d" className={mapViewMode === "3d" ? "active" : ""} onClick={() => changeMapViewMode("3d")}><span>◇</span><small>3D</small></button>
                <button
                  type="button"
                  ref={pinToolButtonRef}
                  className={`map-pin-tool-button${mapTool === "pin" ? " active" : ""}`}
                  aria-label="ピン配置"
                  onClick={() => {
                    setSpotSearchOpen(false);
                    stopAllEditModes();
                    setMapTool((current) => current === "pin" ? "none" : "pin");
                  }}
                >
                  <span className="map-pin-tool-icon" aria-hidden="true">
                    <img src="/app-icon.svg" alt="" />
                    <svg className="map-pin-tool-marker" viewBox="0 0 24 32" focusable="false" aria-hidden="true">
                      <path d="M12 1.5C6.75 1.5 2.5 5.75 2.5 11c0 7.1 9.5 19.5 9.5 19.5S21.5 18.1 21.5 11C21.5 5.75 17.25 1.5 12 1.5Z" />
                      <circle cx="12" cy="11" r="3.6" />
                    </svg>
                  </span>
                  <small>ピン配置</small>
                </button>
              </div>

              <div className="map-zoom-control">
                <button type="button" aria-label="地図を拡大" onClick={() => zoomMap("in")}>＋</button>
                <button type="button" aria-label="地図を縮小" onClick={() => zoomMap("out")}>−</button>
              </div>
            </div>

            <div className="map-search-control">
              <button
                type="button"
                className="map-search-toggle"
                onClick={() => {
                  stopAllEditModes();
                  setMapTool("none");
                  setSpotSearchOpen(true);
                }}
              >
                <span aria-hidden="true">⌕</span>
                スポット検索
              </button>
            </div>

            {currentLocationMessage && (
              <div
                className={
                  currentLocationPermissionDenied
                    ? "map-current-location-status permission-denied"
                    : "map-current-location-status"
                }
                role="status"
              >
                <span>{currentLocationMessage}</span>
                {currentLocationPermissionDenied && (
                  <div className="location-notice-actions">
                    <button
                      type="button"
                      onClick={() => void openLocationSettingsFromNotice()}
                    >
                      {canOpenNativeLocationSettings()
                        ? currentLocationSettingsTarget === "system-location"
                          ? "位置情報設定"
                          : "アプリ設定"
                        : "設定方法"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void showCurrentLocation()}
                    >
                      再試行
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={closeCurrentLocationNotice}
                      aria-label="現在地権限の案内を閉じる"
                    >
                      閉じる
                    </button>
                  </div>
                )}
              </div>
            )}

            {tripodCandidateCalculationStatus !== "idle" && (
              <button
                type="button"
                className={`map-tripod-candidate-status ${tripodCandidateCalculationStatus} ${
                  displayedTripodCandidates.length > 0 ? "tappable" : ""
                }`}
                role={displayedTripodCandidates.length > 0 ? undefined : "status"}
                aria-live="polite"
                disabled={displayedTripodCandidates.length === 0}
                onClick={
                  displayedTripodCandidates.length > 0 ? placeTripodAtDisplayedCandidate : undefined
                }
              >
                {tripodCandidateCalculationStatus === "calculating"
                  ? (Object.keys(preliminaryTripodCandidates).length > 0
                      ? "候補点計算中…（表示中の位置は概算です）"
                      : "三脚候補を精密計算中…")
                  : tripodCandidateCalculationStatus === "complete"
                    ? (Object.keys(preliminaryTripodCandidates).length > 0
                        ? "三脚候補（地形未確定の概算を含む）"
                        : "確定した三脚候補")
                    : tripodCandidateCalculationStatus === "no-solution"
                      ? (displayedTripodCandidates.length > 0
                          ? "確定解なし（概算候補を表示）"
                          : "現在の条件では確定できる三脚候補がありません")
                      : (displayedTripodCandidates.length > 0
                          ? "精密計算に失敗（概算候補を表示）"
                          : "三脚候補の計算に失敗しました")}
              </button>
            )}

            {tripodProgressSnapshot && (
              <p className="map-tripod-progress-snapshot" role="status" aria-live="polite">
                計算中… 経過{tripodProgressSnapshot.elapsedSeconds}秒・
                通信{tripodProgressSnapshot.roundTripCount}回
                {tripodProgressSnapshot.secondsSinceLastRoundTrip !== null
                  ? `・最後の通信から${tripodProgressSnapshot.secondsSinceLastRoundTrip}秒経過`
                  : "・まだ通信していません"}
                {tripodProgressSnapshot.secondsSinceLastRoundTrip !== null &&
                  tripodProgressSnapshot.secondsSinceLastRoundTrip >= 30 && (
                    <><br />⚠ 30秒以上通信が発生していません。処理が停止している可能性があります。</>
                  )}
              </p>
            )}

            {tripodCandidateCalculationStatus !== "idle" &&
              tripodCandidateCalculationStatus !== "calculating" && (
                <div className="map-tripod-diagnostics-actions">
                  <button
                    type="button"
                    className="map-tripod-diagnostics-copy"
                    onClick={handleCopyTripodDiagnostics}
                    title="所要時間・見つかった交点候補数などをコピーします（開発者への報告用）"
                  >
                    {tripodDiagnosticsCopyState === "copied"
                      ? "診断情報をコピーしました"
                      : tripodDiagnosticsCopyState === "failed"
                        ? "コピーできませんでした"
                        : "この検索の診断情報をコピー"}
                  </button>
                  <button
                    type="button"
                    className="map-tripod-diagnostics-copy"
                    onClick={handleResetTripodSeedCache}
                    title="この端末に保存された三脚候補の記憶（前回距離のヒント）を消去します。誤った候補が繰り返し出る場合にお試しください"
                  >
                    {tripodSeedResetState === "done"
                      ? "三脚候補の記憶をリセットしました"
                      : tripodSeedResetState === "failed"
                        ? "リセットできませんでした"
                        : "三脚候補の記憶をリセット"}
                  </button>
                </div>
              )}

            {mapMeasuring && (
              <div className="map-tripod-candidate-status complete" role="status" aria-live="polite">
                {mapMeasureDistanceMeters === null
                  ? "地図を2回タップして距離を計測してください"
                  : mapMeasureDistanceMeters >= 1000
                    ? `距離 ${(mapMeasureDistanceMeters / 1000).toFixed(2)}km（もう一度タップでやり直し）`
                    : `距離 ${Math.round(mapMeasureDistanceMeters)}m（もう一度タップでやり直し）`}
              </div>
            )}

            <div className="map-right-actions">
              <button
                type="button"
                data-tutorial-id="map-measure"
                className={mapMeasuring ? "active" : ""}
                aria-pressed={mapMeasuring}
                onClick={toggleMapMeasurement}
              >
                <span>📏</span><small>計測</small>
              </button>
              <button
                type="button"
                onClick={showCurrentLocation}
                disabled={currentLocationPending}
                aria-busy={currentLocationPending}
              >
                <span>{currentLocationPending ? "⌛" : "◉"}</span>
                <small>{currentLocationPending ? "取得中" : "現在地"}</small>
              </button>
              <button type="button" onClick={showSubjectOnMap}><span>⌖</span><small>被写体</small></button>
              <button type="button" onClick={showTripodOnMap}><span>●</span><small>三脚</small></button>
              <button type="button" data-tutorial-id="map-fullscreen" onClick={openMapFullscreen}><span>⛶</span><small>全画面</small></button>
            </div>

            <button
              type="button"
              className="fullscreen-exit-button map-fullscreen-exit"
              onClick={() => void exitElementFullscreen()}
            >
              <span aria-hidden="true">✕</span>
              全画面を終了
            </button>

            {mapTool === "pin" && !foregroundPlacementActive && (
              <div className="map-pin-drawer" ref={pinDrawerRef}>
                <div className="map-drawer-heading">
                  <strong>ピン設定</strong>
                  <button
                    type="button"
                    onClick={() => {
                      stopAllEditModes();
                      setMapTool("none");
                    }}
                    aria-label="閉じる"
                  >
                    ×
                  </button>
                </div>
                <PinControls
                  subjectActive={subjectPlacementActive}
                  tripodActive={tripodPlacementActive}
                  onSubjectToggle={toggleSubjectPlacement}
                  onOpenSubjectInGoogleMaps={openSubjectInGoogleMaps}
                  subjectAvailable={Boolean(subjectPoint)}
                  onTripodToggle={toggleTripodPlacement}
                  onOpenTripodInGoogleMaps={openTripodInGoogleMaps}
                  tripodAvailable={Boolean(tripodPoint)}
                  onPlaceTripodCandidate={placeTripodAtDisplayedCandidate}
                  tripodCandidateAvailable={selectableDisplayedTripodCandidates.length > 0}
                />
                <ForegroundObjectControls
                  object={foregroundObject}
                  heightCm={plannedForegroundHeightCm}
                  active={foregroundPlacementActive}
                  disabled={!subjectPoint || !tripodPoint}
                  onToggle={toggleForegroundPlacement}
                  onPlaceAtSubject={placePersonAtSubjectPoint}
                  subjectAvailable={Boolean(subjectPoint)}
                  onHeight={updateForegroundHeight}
                  onDelete={deleteForegroundObject}
                />
              </div>
            )}

            {foregroundPlacementActive && (
              <button
                type="button"
                className="foreground-placement-cancel"
                onClick={stopPlacementMode}
              >
                × 配置を中止
              </button>
            )}

            {mapTool === "metrics" && <MetricsPanel metrics={metrics} />}
          </div>
        )}
        <a
          className="gsi-map-attribution"
          href="https://maps.gsi.go.jp/development/ichiran.html"
          target="_blank"
          rel="noreferrer"
        >
          国土地理院 標高タイル
        </a>
      </section>

      <div className="app-status" aria-live="polite">{status}</div>

      {userNotice && (
        <UserNotice
          key={userNotice.id}
          tone={userNotice.tone}
          message={userNotice.message}
          actionLabel={userNotice.actionLabel}
          diagnosticDetail={userNotice.diagnosticDetail}
          prominent={userNotice.prominent}
          onAction={userNotice.onAction
            ? () => {
                userNotice.onAction?.();
                setUserNotice(null);
              }
            : undefined}
          onDismiss={() => setUserNotice(null)}
        />
      )}

      {highestPrecisionProgress && (
        <div
          className="highest-precision-progress"
          role="dialog"
          aria-modal="true"
          aria-label="三脚位置をGoogleタイルモードで計算中"
        >
          <strong>三脚位置をGoogleタイルモードで計算中</strong>
          <span>{highestPrecisionProgress.message}</span>
          <progress max={100} value={highestPrecisionProgress.percent} />
          <small>{highestPrecisionProgress.percent}%</small>
          {highestPrecisionProgress.estimatedRemainingSeconds != null && (
            <small>
              残り予想 {formatEstimatedRemainingTime(
                highestPrecisionProgress.estimatedRemainingSeconds
              )}
            </small>
          )}
        </div>
      )}

      {tripodCandidateSelectionOpen && (
        <div
          className="tripod-candidate-selection-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setTripodCandidateSelectionOpen(false);
            }
          }}
        >
          <section
            className="tripod-candidate-selection-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="三脚候補点の天体を選択"
          >
            <h2>三脚候補点を選択</h2>
            <p>三脚ピンを置く天体の候補点を選択してください。</p>
            <div className="tripod-candidate-selection-list">
              {selectableDisplayedTripodCandidates.map((candidate) => (
                <button
                  key={`${candidate.id}-${candidate.intersectionIndex ?? 1}-${candidate.distanceMeters.toFixed(1)}`}
                  type="button"
                  onClick={() => selectTripodCandidate(candidate)}
                >
                  <strong>
                    {candidate.label}
                    {candidate.intersectionCount && candidate.intersectionCount > 1
                      ? ` 候補${candidate.intersectionIndex}/${candidate.intersectionCount}`
                      : ""}
                  </strong>
                  <small>
                    被写体まで約{Math.round(candidate.distanceMeters)}m
                    {candidate.solutionType === "preliminary" ? "（地形未確認の概算）" : ""}
                  </small>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="tripod-candidate-selection-cancel"
              onClick={() => setTripodCandidateSelectionOpen(false)}
            >
              キャンセル
            </button>
          </section>
        </div>
      )}

      <SubjectEditOverlay
        active={subjectEditActive}
        onConfirm={confirmSubjectEdit}
        onCancel={cancelSubjectEdit}
      />

      {celestialTransitSearchOpen && (
        <Suspense fallback={null}>
          <CelestialTransitSearchDialog
            open={celestialTransitSearchOpen}
            currentDate={selectedDate}
            timeZone={timeZone}
            tripod={arSearchTripod ?? tripodPoint}
            subject={subjectPoint}
            visibility={celestialVisibility}
            precisionSettings={precisionSettings}
            cameraSettings={arSearchCameraSettings ?? cameraSettings}
            previewAspectRatio={arSearchAspectRatio ?? previewAspectRatio}
            viewCorrection={previewViewCorrection}
            onClose={() => {
              setCelestialTransitSearchOpen(false);
              setArSearchTripod(null);
              setArSearchCameraSettings(null);
              setArSearchAspectRatio(null);
            }}
            onSelect={(result, refractionWeather) => {
              const localized = zonedDateTimeLocalFromDate(result.date, timeZone);
              setPreviewRefractionWeather(
                precisionSettings.accuracyMode === "highest" &&
                refractionWeather?.effectiveMode === "weather"
                  ? refractionWeather
                  : undefined
              );
              dateTimeLocalRef.current = localized;
              setDateTimeLocal(localized);
            }}
          />
        </Suspense>
      )}
      <SpotSearchScreen
        open={spotSearchOpen}
        hasCurrentSubject={Boolean(currentSubjectPoint())}
        initialFocalLengthMm={cameraSettings.focalLengthMm}
        initialDate={selectedDate}
        initialTimeZone={timeZone}
        onBack={() => setSpotSearchOpen(false)}
        onSearch={searchFromSpotScreen}
        onResumeSearch={resumeSpotSearch}
        onLocatePin={locatePinFromSpotScreen}
        currentSubject={currentSubjectPoint()}
        history={subjectHistory}
        favorites={favoriteSubjects}
        currentSubjectIsFavorite={isFavoriteSubject(favoriteSubjects, subjectPoint)}
        onSelectStoredSubject={applyStoredSubject}
        onToggleCurrentFavorite={toggleCurrentSubjectFavorite}
        onToggleFavorite={(record) => setFavoriteSubjects(toggleFavoriteSubject(record))}
        onRenameFavorite={(id, label) => setFavoriteSubjects(renameFavoriteSubject(id, label))}
        justRegisteredFavoriteId={justRegisteredFavorite}
        onSelect={applySpotPreset}
      />
      {savedPlansOpen && (
        <Suspense fallback={null}>
          <ProjectsScreen
            open={savedPlansOpen}
            projects={projects}
            onBack={() => setSavedPlansOpen(false)}
            onLoad={loadPlannerProject}
            onUpdate={updatePlannerProject}
            onDelete={removePlannerProject}
            onShare={shareProject}
            onImport={importShareLinkOrCode}
            onOpenQrScan={() => setQrScanOpen(true)}
          />
        </Suspense>
      )}
      <ProjectShareQrDialog
        open={qrShareUrl !== null}
        url={qrShareUrl}
        projectName={qrShareProjectName}
        onClose={closeQrShareDialog}
        onShareLink={() => qrShareUrl && void shareUrlViaSystemOrClipboard(qrShareUrl)}
      />
      <ProjectQrScanDialog
        open={qrScanOpen}
        onClose={() => setQrScanOpen(false)}
        onScanned={handleQrScanned}
      />
      {calendarOpen && (
        <Suspense fallback={null}>
          <CalendarScreen
            open={calendarOpen}
            projects={projects}
            onBack={() => setCalendarOpen(false)}
            onLoad={loadPlannerProject}
          />
        </Suspense>
      )}
      {moonAgeCalendarOpen && (
        <Suspense fallback={null}>
          <MoonAgeCalendarScreen
            open={moonAgeCalendarOpen}
            timeZone={timeZone}
            initialDate={selectedDate}
            onBack={() => setMoonAgeCalendarOpen(false)}
          />
        </Suspense>
      )}
      <ProjectSaveDialog
        open={projectSaveOpen}
        onCancel={() => {
          setProjectSaveOpen(false);
          setProjectSaveTripodOverride(null);
        }}
        onSave={commitProjectSave}
      />
      <SharedProjectImportDialog
        open={sharedImportPayload !== null}
        payload={sharedImportPayload}
        importing={sharedImportBusy}
        errorMessage={sharedImportError}
        onCancel={cancelSharedImport}
        onImport={() => void confirmSharedImport()}
      />
      <PlacementConfirmDialog
        open={pendingPlacement !== null}
        kind={pendingPlacement?.kind ?? null}
        heightOffsetMeters={pendingPlacementOffsetMeters}
        onHeightOffsetChange={setPendingPlacementOffsetMeters}
        busy={pendingPlacementBusy}
        errorMessage={pendingPlacementError}
        onConfirm={() => void confirmPendingPlacement()}
        onCancel={cancelPendingPlacement}
      />
      <CesiumIonConsentDialog
        open={cesiumIonConsentOpen}
        onConfirm={handleConfirmCesiumIonConsent}
        onCancel={() => setCesiumIonConsentOpen(false)}
      />
      {pendingPreliminaryCandidate && (
        <>
          <div
            className="user-notice-backdrop"
            onClick={() => setPendingPreliminaryCandidate(null)}
          />
          <aside className="user-notice warning prominent" role="alertdialog" aria-live="assertive">
            <span>
              まだ計算中の、概算の場所です。地形（建物・崖など）を確認しきれていないため、実際の位置とズレる可能性があります。ここに三脚を設置しますか？（計算は裏側で続き、正確な位置が分かり次第、自動的に更新されます）
            </span>
            <div className="user-notice-actions">
              <button
                type="button"
                onClick={() => {
                  const candidate = pendingPreliminaryCandidate;
                  setPendingPreliminaryCandidate(null);
                  placeTripodAtCandidateConfirmed(candidate);
                }}
              >
                概算のまま設置する
              </button>
              <button type="button" onClick={() => setPendingPreliminaryCandidate(null)}>
                やめる
              </button>
            </div>
          </aside>
        </>
      )}
    </main>
  );
}

export default App;

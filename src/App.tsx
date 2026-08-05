import {
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
import { CelestialOverlay } from "./components/CelestialOverlay";
import { CelestialOcclusionStatus } from "./components/CelestialOcclusionStatus";
import { MetricsPanel } from "./components/MetricsPanel";
import { Map2DOverlay } from "./components/Map2DOverlay";
import { Map2DInteractionLayer } from "./components/Map2DInteractionLayer";
import { PinControls } from "./components/PinControls";
import { PreviewStatus } from "./components/PreviewStatus";
import { PreviewChrome } from "./components/PreviewChrome";
import { CelestialTransitSearchDialog } from "./components/CelestialTransitSearchDialog";
import { PreviewGestureLayer } from "./components/PreviewGestureLayer";
import { ForegroundPreviewOverlay } from "./components/ForegroundPreviewOverlay";
import { ForegroundObjectControls } from "./components/ForegroundObjectControls";
import { SpotSearchScreen } from "./components/SpotSearchScreen";
import { ProjectsScreen } from "./components/ProjectsScreen";
import { CalendarScreen } from "./components/CalendarScreen";
import { MoonAgeCalendarScreen } from "./components/MoonAgeCalendarScreen";
import { ProjectSaveDialog } from "./components/ProjectSaveDialog";
import { SubjectEditOverlay } from "./components/SubjectEditOverlay";
import { TimelinePanel } from "./components/TimelinePanel";
import { TopSettingsBar } from "./components/TopSettingsBar";
import { UserNotice } from "./components/UserNotice";
import { coordinatesAtMapPixel } from "./map/webMercator";
import { adaptiveSearchConcurrency } from "./search/adaptiveConcurrency";
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
  publishUserNotice,
  subscribeUserNotices,
  toUserFacingErrorMessage,
  type UserNoticeEvent,
} from "./errors/userFeedback";

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
  evaluatePhotorealisticMeshSegmentLineOfSight,
  invalidateCelestialOcclusionCaches,
  prepareCelestialLineOfSightObserver,
} from "./cesium/celestialOcclusion";
import {
  buildDirectionalTripodCandidates,
  calculateTripodCandidates,
} from "./cesium/tripodCandidates";
import { buildTripodSearchBaseLines } from "./cesium/tripodSearchLine";
import { updateConnectionLine } from "./cesium/connectionLine";
import { createMapViewer } from "./cesium/createMapViewer";
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
} from "./cesium/subjectPin";
import {
  setTripodPin,
  setTripodPinFromCoordinates,
  updateTripodDistanceLabel,
} from "./cesium/tripodPin";
import { groundPointFromCoordinates } from "./cesium/worldTerrain";
import { cartesianToForegroundCoordinates, enableForegroundObjectDrag, updateForegroundObjectEntity } from "./cesium/foregroundObject";

import {
  DEFAULT_CAMERA_SETTINGS,
  DEFAULT_CAMERA_VIEW_CORRECTION,
  FOCAL_LENGTH_MAX,
  FOCAL_LENGTH_MIN,
} from "./types/camera";
import type { PrecisionSettings } from "./types/precision";
import { DEFAULT_PRECISION_SETTINGS, selectSubjectObstructionExclusionMeters } from "./types/precision";
import type {
  CalculationMode,
  CameraSettings,
  CameraViewCorrection,
  PreviewFrameMode,
} from "./types/camera";
import type {
  CelestialVisibility,
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
import { addSubjectHistory, isFavoriteSubject, loadFavoriteSubjects, loadSubjectHistory, toggleFavoriteSubject } from "./subjectStorage";
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
  const [occlusionRetrySequence, setOcclusionRetrySequence] = useState(0);
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
  const [spotSearchOpen, setSpotSearchOpen] = useState(false);
  const [celestialTransitSearchOpen, setCelestialTransitSearchOpen] = useState(false);
  const openCelestialTransitSearch = useCallback(
    () => setCelestialTransitSearchOpen(true),
    []
  );
  const [savedPlansOpen, setSavedPlansOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [moonAgeCalendarOpen, setMoonAgeCalendarOpen] = useState(false);
  const [projectSaveOpen, setProjectSaveOpen] = useState(false);
  const [projects, setProjects] = useState<PlannerProject[]>(loadProjects);
  const [subjectHistory, setSubjectHistory] = useState<SubjectRecord[]>(loadSubjectHistory);
  const [favoriteSubjects, setFavoriteSubjects] = useState<SubjectRecord[]>(loadFavoriteSubjects);

  const [subjectPoint, setSubjectPoint] =
    useState<GroundPoint | null>(null);
  const [tripodPoint, setTripodPoint] =
    useState<GroundPoint | null>(null);
  const [foregroundObjects, setForegroundObjects] = useState<ForegroundObject[]>([]);
  const foregroundObject = foregroundObjects[0] ?? null;
  // 人物を配置する前に指定した身長を保持し、配置時の初期サイズへ使用する。
  const [plannedForegroundHeightCm, setPlannedForegroundHeightCm] = useState(DEFAULT_FOREGROUND_HEIGHT_CM);
  const plannedForegroundHeightCmRef = useRef(DEFAULT_FOREGROUND_HEIGHT_CM);
  const foregroundTerrainTimerRef = useRef<number | null>(null);
  const foregroundTerrainRequestRef = useRef(0);
  const subjectPlacementRequestRef = useRef(0);
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
  const [previewViewCorrection] =
    useState<CameraViewCorrection>(loadCameraViewCorrection);
  const [precisionSettings, setPrecisionSettings] =
    useState<PrecisionSettings>(loadPrecisionSettings);
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
  const [celestialVisibility, setCelestialVisibility] =
    useState<CelestialVisibility>(loadCelestialVisibility);
  const [celestialOcclusion, setCelestialOcclusion] =
    useState<CelestialOcclusionMap>({});
  const [milkyWayLineOfSight, setMilkyWayLineOfSight] =
    useState<Partial<Record<number, boolean>>>({});
  const [tripodCandidates, setTripodCandidates] =
    useState<TripodCandidate[]>([]);
  const [tripodCandidateSelectionOpen, setTripodCandidateSelectionOpen] =
    useState(false);
  const tripodCandidatesRef = useRef<TripodCandidate[]>([]);
  const [tripodCandidateCalculationStatus, setTripodCandidateCalculationStatus] =
    useState<"idle" | "calculating" | "complete" | "no-solution" | "error">("idle");
  const [dateTimeLocal, setDateTimeLocal] = useState(
    loadCelestialDateTime
  );
  const [timelineInteracting, setTimelineInteracting] = useState(false);
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
    setCelestialTransitSearchOpen(false);
    setSavedPlansOpen(false);
    setCalendarOpen(false);
    setMoonAgeCalendarOpen(false);
    setProjectSaveOpen(false);

    const showMainScreenAfterPageRestore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setSpotSearchOpen(false);
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
    // 連続スクロール中は天の川中心（celestialPoints）だけを毎フレーム更新し、
    // 219点の帯輪郭は停止後に高精度再計算する。
    if (timelineInteracting) return [];

    return calculateMilkyWayScreenPath(
      selectedDate,
      tripodPoint,
      subjectPoint,
      cameraSettings,
      previewAspectRatio,
      calculationMode,
      previewViewCorrection,
      5,
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
    const initialObserver = {
      ...subjectPoint,
      height: subjectPoint.height + cameraSettings.lensCenterHeightMeters,
    };

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

    if (
      precisionSettings.accuracyMode !== "highest"
      || precisionSettings.refractionCorrectionMode !== "auto"
      || !tripodPoint
      || Number.isNaN(selectedDayStart.getTime())
      || Number.isNaN(selectedDayEnd.getTime())
    ) {
      setPreviewRefractionWeather(undefined);
      return () => controller.abort();
    }

    // Phase4-4: プレビュー、軌跡、遮蔽計算は同じ気象コンテキストを共有する。
    // 選択日時そのものを「現在時刻」と誤認せず、実時刻を基準に予報/平年値を選ぶ。
    void prepareRefractionWeatherContext({
      accuracyMode: precisionSettings.accuracyMode,
      mode: precisionSettings.refractionCorrectionMode,
      point: tripodPoint,
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
          message: "最高精度用の気象データを取得できませんでした。気象補正を適用せず表示します。",
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
        message: "最高精度用の気象データ取得に失敗しました。",
      });
    });

    return () => controller.abort();
  }, [
    precisionSettings.accuracyMode,
    precisionSettings.refractionCorrectionMode,
    tripodPoint,
    selectedDayStart,
    selectedDayEnd,
  ]);

  const tripodSearchLines = useMemo(
    () => buildTripodSearchBaseLines(
      subjectPoint,
      tripodCandidateSourcePoints,
      celestialVisibility
    ),
    [subjectPoint, tripodCandidateSourcePoints, celestialVisibility]
  );

  const displayedTripodCandidates = useMemo(() => {
    if (!timelineInteracting || !subjectPoint) return tripodCandidates;
    const previousById = new Map(
      tripodCandidatesRef.current.map((candidate) => [candidate.id, candidate])
    );
    // ドラッグ中は通信を伴うDEM探索を行わず、直前の精密距離を現在時刻の
    // 天体方位へ再投影する。これにより候補点をフレーム単位で滑らかに動かす。
    return tripodCandidateSourcePoints.flatMap((point) => {
      if (!celestialVisibility[point.id] || point.altitudeDegrees <= 0.25) return [];
      const previous = previousById.get(point.id);
      if (!previous) return [];
      const destination = calculateKarneyDestinationPoint(
        subjectPoint,
        (point.azimuthDegrees + 180) % 360,
        previous.distanceMeters
      );
      return [{
        ...previous,
        label: point.label,
        latitude: destination.latitude,
        longitude: destination.longitude,
      }];
    });
  }, [
    celestialVisibility,
    subjectPoint,
    timelineInteracting,
    tripodCandidateSourcePoints,
    tripodCandidates,
  ]);

  const selectableDisplayedTripodCandidates = useMemo(() => {
    const byCelestialBody = new Map<TripodCandidate["id"], TripodCandidate>();
    for (const candidate of displayedTripodCandidates) {
      if (!byCelestialBody.has(candidate.id)) {
        byCelestialBody.set(candidate.id, candidate);
      }
    }
    return Array.from(byCelestialBody.values());
  }, [displayedTripodCandidates]);

  useEffect(() => {
    const enabledPoints = tripodCandidateSourcePoints.filter(
      (point) => celestialVisibility[point.id]
    );
    if (!subjectPoint || enabledPoints.length === 0) {
      tripodCandidatesRef.current = [];
      setTripodCandidates([]);
      setTripodCandidateCalculationStatus("idle");
      return;
    }
    if (timelineInteracting) {
      // 操作中はdisplayedTripodCandidatesの軽量再投影を使用し、
      // 操作停止後に下のDEM精密計算を一度だけ実行する。
      return;
    }

    // DEM精密解を待つ間も天体方位をすぐ確認できるよう、明確に「要確認」と
    // 表示される方位候補を先に描画する。精密解が完了した時だけ確定候補へ置換する。
    const directionalCandidates = buildDirectionalTripodCandidates(
      subjectPoint,
      enabledPoints
    );
    tripodCandidatesRef.current = directionalCandidates;
    setTripodCandidates(directionalCandidates);
    setTripodCandidateCalculationStatus("calculating");

    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void calculateTripodCandidates(
        subjectPoint,
        enabledPoints,
        cameraSettings,
        selectedDate,
        calculationMode,
        undefined,
        controller.signal,
        previewAspectRatio,
        undefined
      )
        .then((candidates) => {
          if (!cancelled) {
            tripodCandidatesRef.current = candidates;
            setTripodCandidates(candidates);
            setTripodCandidateCalculationStatus(
              candidates.length > 0 ? "complete" : "no-solution"
            );
          }
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          console.warn("三脚候補地点を計算できませんでした", error);
          if (!cancelled) {
            tripodCandidatesRef.current = [];
            setTripodCandidates([]);
            setTripodCandidateCalculationStatus("error");
            showUserNotice({
              key: "tripod-candidate-calculation",
              tone: "error",
              message: "地形データを取得できず、三脚候補を計算できませんでした。通信状態を確認して再試行してください。",
              actionLabel: "再試行",
              onAction: () => setTripodCandidateRetrySequence((current) => current + 1),
            });
          }
        });
    }, 0);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    subjectPoint,
    tripodCandidateSourcePoints,
    celestialVisibility,
    cameraSettings,
    selectedDate,
    calculationMode,
    previewAspectRatio,
    timelineInteracting,
    precisionSettings.accuracyMode,
    tripodCandidateRetrySequence,
    showUserNotice,
  ]);

  useEffect(() => {
    if (!mapRef.current) {
      return;
    }

    const token = import.meta.env.VITE_CESIUM_ION_TOKEN;
    const accuracyMode = precisionSettings.accuracyMode;

    if (accuracyMode === "highest" && !token) {
      const message = "高精度3D地図を開始するためのアプリ設定が不足しています。標準モードは利用できます。";
      console.warn("Cesium Ion token is not configured; highest precision map is unavailable");
      setStatus(message);
      showUserNotice({
        key: "map-initialization",
        tone: "error",
        message,
      });
      return;
    }

    let disposed = false;
    let localViewer: Viewer | null = null;
    let removeCameraSync: (() => void) | null = null;

    const authorizeHighPrecision = async (): Promise<void> => {
      if (accuracyMode !== "highest") return;
      const storageKey = "astrosight-high-precision-session-v1";
      const now = Date.now();
      let sessionId = "";
      try {
        const cached = JSON.parse(localStorage.getItem(storageKey) ?? "null") as
          | { sessionId?: string; expiresAt?: number }
          | null;
        if (cached?.sessionId && typeof cached.expiresAt === "number" && cached.expiresAt > now) {
          sessionId = cached.sessionId;
        }
      } catch {
        localStorage.removeItem(storageKey);
      }
      if (!sessionId) {
        sessionId = crypto.randomUUID().replaceAll("-", "");
      }
      const response = await fetch("/api/high-precision-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const result = await response.json() as {
        allowed?: boolean;
        sessionId?: string;
        sessionTtlSeconds?: number;
        count?: number;
        stopLimit?: number;
      };
      if (!response.ok || !result.allowed) {
        throw new Error(
          `今月の高精度モード利用上限に達しました（${result.count ?? "-"}/${result.stopLimit ?? 850}）。標準モードをご利用ください。`
        );
      }
      localStorage.setItem(storageKey, JSON.stringify({
        sessionId: result.sessionId ?? sessionId,
        expiresAt: now + (result.sessionTtlSeconds ?? 10800) * 1000,
      }));
    };

    void authorizeHighPrecision()
      .then(() => createMapViewer(mapRef.current!, token, accuracyMode, setStatus))
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
  }, [mapInitializationAttempt, precisionSettings.accuracyMode, setSearchMessage, showUserNotice]);

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
      // スクロール中は座標描画を優先し、地形・建物の高精度判定は停止後に行う。
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
        await Promise.all(enabledPoints.map(async (point) => {
          const result = await evaluateCelestialLineOfSight(
            viewer,
            observer,
            point,
            controller.signal,
            (demResult) => updatePointOcclusion(point.id, demResult),
            precisionSettings.accuracyMode === "highest"
          );
          updatePointOcclusion(point.id, result);
        }));
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
          showUserNotice({
            key: "celestial-occlusion",
            tone: "warning",
            message: "地形・建物の遮蔽物確認を完了できませんでした。天体は未確認として表示しています。",
            actionLabel: "再試行",
            onAction: () => setOcclusionRetrySequence((current) => current + 1),
          });
        }
      });
    }, 360);
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
                precisionSettings.accuracyMode === "highest"
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
    }, 360);

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
        subjectPoint.label
      );
    }
    if (tripodPoint) {
      setTripodPin(
        viewer,
        Cartesian3.fromDegrees(
          tripodPoint.longitude,
          tripodPoint.latitude,
          tripodPoint.height
        )
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
    return enableForegroundObjectDrag(viewer, (position) => {
      const coordinates = cartesianToForegroundCoordinates(position);
      placeForegroundAtCoordinates(
        coordinates.latitude,
        coordinates.longitude,
        coordinates.groundHeightMeters,
        false,
        undefined,
        "drag-3d"
      );
    });
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
        cameraSettings.lensCenterHeightMeters
      );
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
  ]);

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
            previewViewCorrection
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

    // Preview視点で追加タイルが読み込まれた後に再描画します。
    timers.push(
      window.setTimeout(() => {
        void updatePreview("プレビュー高精細化中…");
      }, 1200)
    );

    timers.push(
      window.setTimeout(() => {
        void updatePreview("プレビュー最終更新中…");
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
  }

  async function resolveSearchSubject(
    latitude: number,
    longitude: number,
    label: string
  ): Promise<GroundPoint> {
    const viewer = mapViewerRef.current;
    if (viewer && !viewer.isDestroyed()) {
      try {
        const position = Cartesian3.fromDegrees(longitude, latitude, 0);
        const clamped = (
          await viewer.scene.clampToHeightMostDetailed([position])
        )[0];
        if (clamped) {
          const cartographic = Cartographic.fromCartesian(clamped);
          return {
            latitude: CesiumMath.toDegrees(cartographic.latitude),
            longitude: CesiumMath.toDegrees(cartographic.longitude),
            height: cartographic.height,
            label,
          };
        }
      } catch (error) {
        console.warn("検索地点の3D表面高を取得できませんでした", error);
        showUserNotice({
          key: "search-subject-3d-fallback",
          tone: "warning",
          message: "Google 3Dの高さを取得できないため、地形データの高さで被写体地点を計算します。",
        });
      }
    }
    return groundPointFromCoordinates(latitude, longitude, label);
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
    const subjectGround = await groundPointFromCoordinates(
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

  async function completeBackgroundSpotSearch(
    active: ActiveSpotSearchJob,
    job: SpotSearchJob,
    signal: AbortSignal,
    onProgress: (message: string, percent: number) => void
  ): Promise<SpotPresetResult[]> {
    const results = deserializeSpotSearchResults(job.results);
    const diagnosticMessage = job.progress.includes("検索診断")
      ? job.progress.slice(job.progress.indexOf("検索診断"))
      : "";
    if (!job.input.criteria.subjectObstructionCheckEnabled) {
      const uncheckedResults = results.map((result) => ({
        ...result,
        candidate3dStatus: "disabled" as const,
      }));
      const returnedResults = job.input.criteria.verifiedVisibilityOnly
        ? []
        : uncheckedResults;
      await finalizeBackgroundSpotSearch(active, returnedResults);
      if (job.input.cacheKey) markSpotSearchPrepared(job.input.cacheKey);
      onProgress(`${uncheckedResults.length}件を取得しました（遮蔽物確認OFF）`, 100);
      return returnedResults;
    }
    if (job.status === "complete") {
      clearActiveSpotSearchJob(active);
      return job.input.criteria.verifiedVisibilityOnly
        ? results.filter((result) => result.candidate3dStatus === "visible")
        : results;
    }
    if (job.input.precisionSettings?.accuracyMode !== "highest") {
      const demOnlyResults = results.map((result) => ({
        ...result,
        candidate3dStatus: "unverified" as const,
      }));
      const returnedResults = job.input.criteria.verifiedVisibilityOnly ? [] : demOnlyResults;
      await finalizeBackgroundSpotSearch(active, returnedResults);
      if (job.input.cacheKey) markSpotSearchPrepared(job.input.cacheKey);
      onProgress(`${demOnlyResults.length}件を取得しました（標準モード：Google 3D確認なし）`, 100);
      return returnedResults;
    }
    let viewer = mapViewerRef.current;
    for (
      let attempt = 0;
      mapReady && (!viewer || viewer.isDestroyed()) && attempt < 120;
      attempt += 1
    ) {
      if (signal.aborted) {
        throw new DOMException("最終3D確認を中止しました", "AbortError");
      }
      onProgress("3Dマップの読込完了を待っています…", 98);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      viewer = mapViewerRef.current;
    }
    if (!viewer || viewer.isDestroyed()) {
      // 3Dを確認できないことを「撮影不可」と同一視しない。
      // 候補は未確認状態で保存し、利用者が三脚ピンとプレビューで確認できるようにする。
      const unverifiedResults = results.map((result) => ({
        ...result,
        candidate3dStatus: "unverified" as const,
      }));
      const returnedResults = job.input.criteria.verifiedVisibilityOnly
        ? []
        : unverifiedResults;
      await finalizeBackgroundSpotSearch(active, returnedResults);
      if (job.input.cacheKey) markSpotSearchPrepared(job.input.cacheKey);
      onProgress(
        `${unverifiedResults.length}件を候補として保持しました（3D未確認）`,
        100
      );
      return returnedResults;
    }
    const assessedResults: SpotPresetResult[] = [];
    const concurrency = adaptiveSearchConcurrency("mesh-los", job.input.calculationMode);
    for (let offset = 0; offset < results.length; offset += concurrency) {
      if (signal.aborted) {
        throw new DOMException("最終3D確認を中止しました", "AbortError");
      }
      onProgress(
        `建物の最終3D遮蔽を確認しています… ${Math.min(
          results.length,
          offset + concurrency
        )}/${results.length}`,
        98 + Math.floor(
          Math.min(results.length, offset + concurrency) /
          Math.max(1, results.length)
        )
      );
      const batch = await Promise.all(
        results.slice(offset, offset + concurrency).map(async (result) => {
          try {
            const observer = await prepareCelestialLineOfSightObserver(
              viewer,
              result.tripod,
              job.input.lensCenterHeightMeters,
              signal
            );
            const subjectPosition = Cartesian3.fromDegrees(
              result.subject.longitude,
              result.subject.latitude,
              result.subject.height
            );
            const subjectDistanceMeters = Cartesian3.distance(
              observer.meshOrigin,
              subjectPosition
            );
            const configuredExclusionSettings =
              job.input.criteria.subjectObstructionExclusionMeters ??
              DEFAULT_PRECISION_SETTINGS.subjectObstructionExclusionMeters;
            const subjectExclusionMeters = selectSubjectObstructionExclusionMeters(
              subjectDistanceMeters,
              configuredExclusionSettings
            );
            const maximumObstructionDistanceMeters = Math.max(
              3,
              subjectDistanceMeters - subjectExclusionMeters
            );
            const visibility = await evaluatePhotorealisticMeshSegmentLineOfSight(
              viewer,
              observer,
              subjectPosition,
              signal,
              maximumObstructionDistanceMeters
            );
            return {
              ...result,
              candidate3dStatus: visibility.verified
                ? visibility.visible
                  ? "visible" as const
                  : "possibly-obstructed" as const
                : "unverified" as const,
              buildingObstructedFractionPercent: visibility.obstructedFractionPercent,
            };
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
              throw error;
            }
            console.warn("候補の最終3D状態を確認できないため未確認として残します", error);
            return { ...result, candidate3dStatus: "unverified" as const };
          }
        })
      );
      assessedResults.push(...batch);
    }
    const returnedResults = job.input.criteria.verifiedVisibilityOnly
      ? assessedResults.filter((result) => result.candidate3dStatus === "visible")
      : assessedResults;
    onProgress("最終3D確認結果を保存しています…", 99);
    await finalizeBackgroundSpotSearch(active, returnedResults);
    if (job.input.cacheKey) markSpotSearchPrepared(job.input.cacheKey);
    const visibleCount = assessedResults.filter(
      (result) => result.candidate3dStatus === "visible"
    ).length;
    const obstructedCount = assessedResults.filter(
      (result) => result.candidate3dStatus === "possibly-obstructed"
    ).length;
    const unverifiedCount = assessedResults.length - visibleCount - obstructedCount;
    onProgress(
      `${assessedResults.length}件を候補として保持しました（確認済み ${visibleCount}／遮蔽可能性 ${obstructedCount}／未確認 ${unverifiedCount}）${diagnosticMessage ? `
${diagnosticMessage}
候補保持: ${assessedResults.length}件` : ""}`,
      100
    );
    return returnedResults;
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
        : await groundPointFromCoordinates(
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
          subject.label
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
      record.label
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
    setFavoriteSubjects(toggleFavoriteSubject(subjectPoint));
  }

  async function applySpotPreset(result: SpotPresetResult): Promise<void> {
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      setSearchMessage("マップの読込完了後に構図を適用してください");
      return;
    }
    let appliedResult = result;
    if (precisionSettings.accuracyMode === "highest") {
      setSpotSearchOpen(false);
      setHighestPrecisionProgress({
        percent: 2,
        message: "三脚位置を高精度計算中",
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
          setHighestPrecisionProgress
        );
        appliedResult = {
          ...result,
          subject: refined.subject,
          tripod: refined.tripod,
        };
      } catch (error) {
        console.warn("最高精度処理を完了できませんでした", error);
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
    stopAllEditModes();
    const subject = setSubjectPinFromPosition(
      viewer,
      Cartesian3.fromDegrees(appliedResult.subject.longitude, appliedResult.subject.latitude, appliedResult.subject.height),
      appliedResult.subject.label
    );
    const tripod = setTripodPin(
      viewer,
      Cartesian3.fromDegrees(appliedResult.tripod.longitude, appliedResult.tripod.latitude, appliedResult.tripod.height)
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
        ? `${appliedResult.celestialLabel}の高精度構図を適用しました`
        : `${appliedResult.celestialLabel}の構図を適用しました`
    );
  }

  function saveCurrentComposition(): void {
    if (!subjectPoint || !tripodPoint) {
      setSearchMessage("保存するには三脚ピンと被写体ピンを設定してください");
      return;
    }
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
    if (!subjectPoint || !tripodPoint) return;
    const now = new Date();
    const project: PlannerProject = {
      id: crypto.randomUUID?.() ?? `project-${now.getTime()}`,
      name: name || formatProjectFallbackName(now),
      createdAtIso: now.toISOString(), updatedAtIso: now.toISOString(),
      shootingDateTimeLocal: dateTimeLocal, timeZone, calendarRegistered,
      subject: subjectPoint, tripod: tripodPoint, foregroundObjects,
      cameraSettings, celestialVisibility, previewFrameMode, mapViewMode, mapZoom, mapCenter,
      displaySettings: { celestialMenuOpen },
    };
    setProjects(upsertProject(project));
    setProjectSaveOpen(false);
    setSearchMessage("現在の撮影計画をプロジェクトへ保存しました");
  }

  function loadPlannerProject(project: PlannerProject): void {
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) { setSearchMessage("マップの読込完了後にプロジェクトを読み込んでください"); return; }
    stopAllEditModes();
    const subject = setSubjectPinFromPosition(viewer, Cartesian3.fromDegrees(project.subject.longitude, project.subject.latitude, project.subject.height), project.subject.label);
    const tripod = setTripodPin(viewer, Cartesian3.fromDegrees(project.tripod.longitude, project.tripod.latitude, project.tripod.height));
    setSubjectPoint(subject); setTripodPoint(tripod);
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
      void groundPointFromCoordinates(
        loadedForeground.latitude,
        loadedForeground.longitude,
        "前景・中景オブジェクト"
      ).then((point) => {
        if (requestId !== foregroundTerrainRequestRef.current) return;
        setForegroundObjects((current) => current.map((object, index) =>
          index === 0 ? { ...object, groundHeightMeters: point.height } : object
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
        const point = setSubjectPinFromPosition(
          viewer,
          position,
          "手動指定地点"
        );

        setSubjectPoint(point);
        setMapCenter({ latitude: point.latitude, longitude: point.longitude });
        setSearchMessage(
          `被写体ピンを変更しました：${point.latitude.toFixed(
            6
          )}, ${point.longitude.toFixed(6)}`
        );
        stopPlacementMode();
      }
    );

    setSubjectPlacementActive(true);
    setSearchMessage(
      "地図上の被写体位置をクリックしてください"
    );
  }

  type ForegroundPlacementSource = "subject-pin" | "map-2d" | "map-3d" | "drag-3d";

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

    // 2D地図には表面高度がないため、この経路だけDEM/地形高度で補正する。
    // 被写体ピン・3Dクリック・3Dドラッグで取得した高さは、建物屋上や橋面を含む
    // 実際の3D表面高度なので、後からDEM地表高で上書きしてはいけない。
    if (source === "map-2d") {
      if (foregroundTerrainTimerRef.current !== null) {
        window.clearTimeout(foregroundTerrainTimerRef.current);
      }
      const requestId = ++foregroundTerrainRequestRef.current;
      foregroundTerrainTimerRef.current = window.setTimeout(() => {
        foregroundTerrainTimerRef.current = null;
        void groundPointFromCoordinates(
          constrained.latitude,
          constrained.longitude,
          "前景・中景オブジェクト"
        ).then((point) => {
          if (requestId !== foregroundTerrainRequestRef.current) return;
          setForegroundObjects((current) => current.map((object, index) =>
            index === 0 &&
            Math.abs(object.latitude - constrained.latitude) < 1e-9 &&
            Math.abs(object.longitude - constrained.longitude) < 1e-9
              ? { ...object, groundHeightMeters: point.height }
              : object
          ));
        }).catch((error: unknown) => {
          if (requestId !== foregroundTerrainRequestRef.current) return;
          console.warn("前景・中景オブジェクト地点の標高を取得できませんでした", error);
          setSearchMessage("人物を配置しました。地表高度の精密補正のみ取得できませんでした");
        });
      }, 180);
    } else {
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
      if (placeForegroundAtCoordinates(
        coordinates.latitude,
        coordinates.longitude,
        coordinates.groundHeightMeters,
        false,
        undefined,
        "map-3d"
      )) {
        stopPlacementMode();
      }
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
        // 橋面などDEMに存在しない歩行可能な3D表面を選べるよう、クリックした実座標を保持する。
        const point = setTripodPin(viewer, position);
        setTripodPoint(point);
        setMapCenter({ latitude: point.latitude, longitude: point.longitude });
        setSearchMessage(
          `三脚ピンを配置しました：${point.latitude.toFixed(
            6
          )}, ${point.longitude.toFixed(6)}`
        );
        stopPlacementMode();
      }
    );

    setTripodPlacementActive(true);
    setSearchMessage(
      "地図上の三脚を置きたい場所をクリックしてください"
    );
  }

  async function handle2dMapPlacement(
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
      if (placeForegroundAtCoordinates(
        coordinates.latitude,
        coordinates.longitude,
        undefined,
        false,
        undefined,
        "map-2d"
      )) {
        stopPlacementMode();
        setSearchMessage("人物を配置しました。ドラッグして移動できます");
      }
    } else if (placementMode === "subject") {
      const requestId = ++subjectPlacementRequestRef.current;
      const provisionalPoint: GroundPoint = {
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        // 3D表面取得を待たず候補基礎ラインを描画する。精密高度取得後に置き換える。
        height: subjectPoint?.height ?? 0,
        label: "手動指定地点（高度確認中）",
      };
      setSubjectPoint(provisionalPoint);
      stopPlacementMode();
      setSearchMessage("被写体位置を確定しました。三脚候補を計算しながら3D表面高度を確認しています…");
      const point = viewer && !viewer.isDestroyed()
        ? await setSubjectPinFromCoordinates(
            viewer,
            coordinates.latitude,
            coordinates.longitude,
            "手動指定地点"
          )
        : await groundPointFromCoordinates(
            coordinates.latitude,
            coordinates.longitude,
            "手動指定地点"
          );
      if (requestId !== subjectPlacementRequestRef.current) return;
      setSubjectPoint(point);
      setSearchMessage(
        `被写体ピンを配置しました：${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`
      );
      return;
    } else {
      const point = viewer && !viewer.isDestroyed()
        ? await setTripodPinFromCoordinates(
            viewer,
            coordinates.latitude,
            coordinates.longitude,
            true
          )
        : await groundPointFromCoordinates(
            coordinates.latitude,
            coordinates.longitude,
            "三脚位置"
          );
      setTripodPoint(point);
      setSearchMessage(
        `三脚ピンを配置しました：${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`
      );
    }
    stopPlacementMode();
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

    const point = setSubjectPinFromPosition(
      viewer,
      position,
      "3D指定地点"
    );

    setSubjectPoint(point);
    setMapCenter({ latitude: point.latitude, longitude: point.longitude });
    setSubjectEditActive(false);
    setSearchMessage(
      `正式な被写体点を登録しました：${point.latitude.toFixed(
        6
      )}, ${point.longitude.toFixed(6)}`
    );
  }

  function savePreview() {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = `ksg-preview-${dateTimeLocal.replace(/[:T]/g, "-")}.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, "image/png");
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
      setSearchMessage(
        import.meta.env.VITE_CESIUM_ION_TOKEN
          ? "3Dマップを読み込み中です。準備が完了してからもう一度お試しください"
          : "3Dマップに必要な設定がないため、2D地図を表示しています"
      );
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

  function placeTripodAtDisplayedCandidate() {
    if (selectableDisplayedTripodCandidates.length === 0) return;
    if (selectableDisplayedTripodCandidates.length === 1) {
      selectTripodCandidate(selectableDisplayedTripodCandidates[0]);
      return;
    }
    setTripodCandidateSelectionOpen(true);
  }

  function selectTripodCandidate(candidate: TripodCandidate) {
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
      : `${candidate.label}と被写体が画角内で重なる三脚候補へ移動しました（距離 ${Math.round(candidate.distanceMeters)}m）`
    );
  }


  return (
    <main className="app">
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
        precisionSettings={precisionSettings}
        onPrecisionSettingsChange={setPrecisionSettings}
      />
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
            onChangeFocalLength={changePreviewFocalLength}
          />

          <CelestialOverlay
            points={celestialPoints}
            tracks={celestialTracks}
            milkyWayPath={visibleMilkyWayPath}
            visibility={celestialVisibility}
            occlusion={celestialOcclusion}
            fastMode={timelineInteracting}
          />

          <CelestialOcclusionStatus
            visibility={celestialVisibility}
            occlusion={celestialOcclusion}
          />

          <ForegroundPreviewOverlay
            object={foregroundObject}
            tripod={tripodPoint}
            subject={subjectPoint}
            camera={cameraSettings}
            aspectRatio={previewAspectRatio}
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
          dateTimeLocal={dateTimeLocal}
          timeZone={timeZone}
          frameMode={previewFrameMode}
          onChangeDateTime={setDateTimeLocal}
          onChangeFrameMode={setPreviewFrameMode}
          onZoomIn={() =>
            changePreviewFocalLength(cameraSettings.focalLengthMm * 1.14)
          }
          onZoomOut={() =>
            changePreviewFocalLength(cameraSettings.focalLengthMm * 0.88)
          }
          onSavePreview={savePreview}
        />

        <CelestialMenu
          open={celestialMenuOpen}
          visibility={celestialVisibility}
          onToggleOpen={() =>
            setCelestialMenuOpen((current) => !current)
          }
          onChangeVisibility={setCelestialVisibility}
        />

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
              onMoveForeground={(coordinates) => placeForegroundAtCoordinates(
                coordinates.latitude,
                coordinates.longitude,
                undefined,
                false,
                undefined,
                "map-2d"
              )}
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
                <button type="button" className={mapViewMode === "2d" ? "active" : ""} onClick={() => changeMapViewMode("2d")}><span>▣</span><small>2D</small></button>
                <button type="button" className={mapViewMode === "3d" ? "active" : ""} onClick={() => changeMapViewMode("3d")}><span>◇</span><small>3D</small></button>
                <button
                  type="button"
                  className={mapTool === "pin" ? "active" : ""}
                  onClick={() => {
                    setSpotSearchOpen(false);
                    stopAllEditModes();
                    setMapTool((current) => current === "pin" ? "none" : "pin");
                  }}
                >
                  <span>⌖</span><small>ピン</small>
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
              <div
                className={`map-tripod-candidate-status ${tripodCandidateCalculationStatus}`}
                role="status"
                aria-live="polite"
              >
                {tripodCandidateCalculationStatus === "calculating"
                  ? "三脚方位候補を表示中・精密計算中…"
                  : tripodCandidateCalculationStatus === "complete"
                    ? `確定した三脚候補：${tripodCandidates.length}件`
                    : tripodCandidateCalculationStatus === "no-solution"
                      ? "現在の条件では確定できる三脚候補がありません"
                      : "三脚候補の計算に失敗しました"}
              </div>
            )}

            <div className="map-right-actions">
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
              <button type="button" onClick={openMapFullscreen}><span>⛶</span><small>全画面</small></button>
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
              <div className="map-pin-drawer">
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
          aria-label="三脚位置を高精度計算中"
        >
          <strong>三脚位置を高精度計算中</strong>
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
                  key={candidate.id}
                  type="button"
                  onClick={() => selectTripodCandidate(candidate)}
                >
                  <strong>{candidate.label}</strong>
                  <small>被写体まで約{Math.round(candidate.distanceMeters)}m</small>
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

      <CelestialTransitSearchDialog
        open={celestialTransitSearchOpen}
        currentDate={selectedDate}
        timeZone={timeZone}
        tripod={tripodPoint}
        subject={subjectPoint}
        visibility={celestialVisibility}
        precisionSettings={precisionSettings}
        cameraSettings={cameraSettings}
        previewAspectRatio={previewAspectRatio}
        viewCorrection={previewViewCorrection}
        onClose={() => setCelestialTransitSearchOpen(false)}
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
      <SpotSearchScreen
        open={spotSearchOpen}
        hasCurrentSubject={Boolean(currentSubjectPoint())}
        initialFocalLengthMm={cameraSettings.focalLengthMm}
        initialDate={selectedDate}
        initialTimeZone={timeZone}
        precisionSettings={precisionSettings}
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
        onSelect={applySpotPreset}
      />
      <ProjectsScreen
        open={savedPlansOpen}
        projects={projects}
        onBack={() => setSavedPlansOpen(false)}
        onLoad={loadPlannerProject}
        onUpdate={updatePlannerProject}
        onDelete={removePlannerProject}
      />
      <CalendarScreen
        open={calendarOpen}
        projects={projects}
        onBack={() => setCalendarOpen(false)}
        onLoad={loadPlannerProject}
      />
      <MoonAgeCalendarScreen
        open={moonAgeCalendarOpen}
        timeZone={timeZone}
        initialDate={selectedDate}
        onBack={() => setMoonAgeCalendarOpen(false)}
      />
      <ProjectSaveDialog
        open={projectSaveOpen}
        onCancel={() => setProjectSaveOpen(false)}
        onSave={commitProjectSave}
      />
    </main>
  );
}

export default App;

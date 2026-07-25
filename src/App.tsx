import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
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
import { coordinatesAtMapPixel } from "./map/webMercator";
import { adaptiveSearchConcurrency } from "./search/adaptiveConcurrency";

import { flyMapToTarget } from "./cesium/camera";
import {
  calculateCelestialScreenPoints,
  calculateCelestialScreenTracks,
  calculateMilkyWayScreenPath,
} from "./cesium/celestial";
import { updateCelestialMapEntities } from "./cesium/celestialMap";
import {
  evaluateCelestialLineOfSight,
  evaluatePhotorealisticMeshLineOfSight,
  prepareCelestialLineOfSightObserver,
} from "./cesium/celestialOcclusion";
import { calculateTripodCandidates } from "./cesium/tripodCandidates";
import { buildTripodSearchBaseLines } from "./cesium/tripodSearchLine";
import { updateConnectionLine } from "./cesium/connectionLine";
import { createMapViewer } from "./cesium/createMapViewer";
import {
  calculateKarneyDestinationPoint,
  calculateKarneyLineMetrics,
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
  FOCAL_LENGTH_MAX,
  FOCAL_LENGTH_MIN,
} from "./types/camera";
import type { PrecisionSettings } from "./types/precision";
import { DEFAULT_PRECISION_SETTINGS } from "./types/precision";
import type {
  CalculationMode,
  CameraSettings,
  CameraViewCorrection,
  PreviewFrameMode,
} from "./types/camera";
import type {
  CelestialVisibility,
  CelestialOcclusionMap,
  TripodCandidate,
} from "./types/celestial";
import type { GroundPoint } from "./types/points";
import type { ForegroundObject } from "./types/foreground";
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

function loadPrecisionSettings(): PrecisionSettings {
  try {
    const saved = localStorage.getItem("ksg-precision-settings");
    if (!saved) return DEFAULT_PRECISION_SETTINGS;

    const parsed = JSON.parse(saved) as Partial<PrecisionSettings>;
    const mode = parsed.refractionCorrectionMode;
    if (mode !== "auto" && mode !== "standard" && mode !== "none") {
      return DEFAULT_PRECISION_SETTINGS;
    }

    return { refractionCorrectionMode: mode };
  } catch {
    return DEFAULT_PRECISION_SETTINGS;
  }
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

function constrainForegroundToSegment(
  latitude: number,
  longitude: number,
  tripod: GroundPoint,
  subject: GroundPoint
): { latitude: number; longitude: number } {
  const line = calculateKarneyLineMetrics(tripod, subject);
  const pointerLine = calculateKarneyLineMetrics(tripod, {
    latitude,
    longitude,
    height: tripod.height,
    label: "前景移動位置",
  });
  const bearingDeltaRadians =
    (pointerLine.bearingDegrees - line.bearingDegrees) * Math.PI / 180;
  const projectedDistanceMeters =
    pointerLine.distanceMeters * Math.cos(bearingDeltaRadians);
  const raw = line.distanceMeters > 0
    ? projectedDistanceMeters / line.distanceMeters
    : 0.5;
  const t = Math.max(0.01, Math.min(0.99, raw));
  const constrained = calculateKarneyDestinationPoint(
    tripod,
    line.bearingDegrees,
    line.distanceMeters * t
  );
  return {
    latitude: constrained.latitude,
    longitude: constrained.longitude,
  };
}

function App() {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewSectionRef = useRef<HTMLElement>(null);
  const mapSectionRef = useRef<HTMLElement>(null);
  const map2dStageRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapViewerRef = useRef<Viewer | null>(null);
  const mapViewModeRef = useRef<"2d" | "3d">(loadLastMapState().viewMode);
  const disablePlacementRef = useRef<(() => void) | null>(null);
  const previewJobRef = useRef(0);
  const previewRenderQueueRef = useRef<Promise<void>>(Promise.resolve());

  const [status, setStatus] = useState("3Dデータを読み込み中…");
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
  const [spotSearchOpen, setSpotSearchOpen] = useState(false);
  const [celestialTransitSearchOpen, setCelestialTransitSearchOpen] = useState(false);
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
  const [plannedForegroundHeightCm, setPlannedForegroundHeightCm] = useState(170);
  const plannedForegroundHeightCmRef = useRef(170);
  const foregroundTerrainTimerRef = useRef<number | null>(null);
  const foregroundTerrainRequestRef = useRef(0);
  const currentLocationRequestRef = useRef(0);

  const [subjectPlacementActive, setSubjectPlacementActive] =
    useState(false);
  const [tripodPlacementActive, setTripodPlacementActive] =
    useState(false);
  const [foregroundPlacementActive, setForegroundPlacementActive] = useState(false);
  const [subjectEditActive, setSubjectEditActive] =
    useState(false);

  const [cameraSettings, setCameraSettings] =
    useState<CameraSettings>(loadCameraSettings);
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
    useState<Record<number, boolean>>({});
  const [tripodCandidates, setTripodCandidates] =
    useState<TripodCandidate[]>([]);
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

  const previewViewCorrection: CameraViewCorrection | undefined = undefined;
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
      previewViewCorrection
    );
  }, [
    selectedDate,
    tripodPoint,
    subjectPoint,
    cameraSettings,
    previewAspectRatio,
    calculationMode,
    previewViewCorrection,
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
      previewViewCorrection
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
  ]);

  const visibleMilkyWayPath = useMemo(
    () => milkyWayPath.map((point, index) => ({
      ...point,
      lineOfSightVisible: milkyWayLineOfSight[index] === true,
    })),
    [milkyWayLineOfSight, milkyWayPath]
  );

  const tripodSearchLines = useMemo(
    () => buildTripodSearchBaseLines(
      subjectPoint,
      celestialPoints,
      celestialVisibility
    ),
    [subjectPoint, celestialPoints, celestialVisibility]
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
      previewViewCorrection
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
  ]);

  useEffect(() => {
    // 被写体ピンを新しく置いた直後は、モバイルのpointer/touch終了イベントが
    // 取りこぼされていても候補計算を再開できるよう、時間操作中フラグを解除する。
    // これにより、被写体確定時点の天体位置から三脚候補点を必ず再計算する。
    if (subjectPoint) setTimelineInteracting(false);
  }, [subjectPoint]);

  useEffect(() => {
    const enabledPoints = celestialPoints.filter(
      (point) => celestialVisibility[point.id]
    );
    if (!subjectPoint || enabledPoints.length === 0) {
      setTripodCandidates([]);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    // 時間スライダー操作中も候補計算を止めず、描画間隔に近い短い待ち時間で追従させる。
    // 操作中は粗いDEM走査で即応し、指を離した直後に通常精度で再計算する。
    const updateDelayMs = timelineInteracting ? 16 : 32;
    const interactionProfile = timelineInteracting
      ? {
          sampleCount: 8,
          refinementPasses: 0,
          refinementSegments: 2,
        }
      : undefined;
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
        undefined,
        interactionProfile
      )
        .then((candidates) => {
          if (!cancelled) setTripodCandidates(candidates);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          console.warn("三脚候補地点を計算できませんでした", error);
          // 操作中の一時的な通信失敗では直前候補を保持し、追従表示を途切れさせない。
          if (!cancelled && !timelineInteracting) setTripodCandidates([]);
        });
    }, updateDelayMs);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    subjectPoint,
    celestialPoints,
    celestialVisibility,
    cameraSettings,
    selectedDate,
    calculationMode,
    previewAspectRatio,
    timelineInteracting,
  ]);

  useEffect(() => {
    if (!mapRef.current) {
      return;
    }

    const token = import.meta.env.VITE_CESIUM_ION_TOKEN;

    if (!token) {
      setStatus(".env.localのCesiumトークンを読み込めません");
      return;
    }

    let disposed = false;
    let localViewer: Viewer | null = null;
    let removeCameraSync: (() => void) | null = null;

    void createMapViewer(mapRef.current, token, setStatus)
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
      })
      .catch((error) => {
        console.error("3Dマップ初期化エラー:", error);

        const message =
          error instanceof Error ? error.message : String(error);

        setStatus(`3Dマップ読込失敗：${message}`);
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
  }, [setSearchMessage]);

  useEffect(() => {
    const element = previewSectionRef.current;

    if (!element) {
      return;
    }

    const updateAspect = () => {
      const rect = element.getBoundingClientRect();
      setPreviewViewportAspectRatio(
        rect.height > 0 ? rect.width / rect.height : 16 / 9
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
      setMapSize({
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      });
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
      "ksg-precision-settings",
      JSON.stringify(precisionSettings)
    );
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
    const parameters = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
    });

    void fetch(`/api/timezone?${parameters}`, { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as { timeZone?: unknown };
        if (!response.ok || typeof data.timeZone !== "string") return;
        if (
          !isValidTimeZone(data.timeZone) ||
          data.timeZone === previousTimeZone
        ) return;
        // 地点変更で時刻そのものがずれないよう、絶対時刻を保って現地表示へ変換する。
        if (!Number.isNaN(absoluteTime.getTime())) {
          const localized = zonedDateTimeLocalFromDate(
            absoluteTime,
            data.timeZone
          );
          dateTimeLocalRef.current = localized;
          setDateTimeLocal(localized);
        }
        timeZoneRef.current = data.timeZone;
        setTimeZone(data.timeZone);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("撮影地点のタイムゾーンを取得できませんでした", error);
      });

    return () => controller.abort();
    // タイムゾーン検索は地点が変わった時だけ行い、日時スクロールでは再取得しない。
  }, [subjectPoint?.latitude, subjectPoint?.longitude, tripodPoint?.latitude, tripodPoint?.longitude]);

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
      celestialPoints.length === 0
    ) {
      setCelestialOcclusion({});
      setMilkyWayLineOfSight({});
      return;
    }
    if (timelineInteracting) {
      // スクロール中は座標描画を優先し、地形・建物の高精度判定は停止後に行う。
      setCelestialOcclusion({});
      setMilkyWayLineOfSight({});
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    // 時刻スクロール中は旧時刻の可視判定を表示せず、停止後に高精度判定する。
    setCelestialOcclusion({});
    setMilkyWayLineOfSight({});
    const timer = window.setTimeout(() => {
      void prepareCelestialLineOfSightObserver(
        viewer,
        tripodPoint,
        cameraSettings.lensCenterHeightMeters,
        controller.signal
      ).then(async (observer) => {
        const enabledPoints = celestialPoints.filter(
          (point) => celestialVisibility[point.id]
        );
        const entries = await Promise.all(enabledPoints.map(async (point) => [
          point.id,
          await evaluateCelestialLineOfSight(
            viewer,
            observer,
            point,
            controller.signal
          ),
        ] as const));
        if (!cancelled) setCelestialOcclusion(Object.fromEntries(entries));
        if (!celestialVisibility.milkyWay) return;
        const pathVisibility: Record<number, boolean> = {};
        const visibleIndexes = milkyWayPath.flatMap((point, index) =>
          point.visibleInFrame ? [index] : []
        );
        // 帯の中心と両端をすべて検証し、未検証部分を風景の手前へ描かない。
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
                controller.signal
              )
            ));
            return [index, checks.every((check) => check.visible && check.verified)] as const;
          }));
          for (const [index, isVisible] of batchResults) {
            pathVisibility[index] = isVisible;
          }
          if (!cancelled) setMilkyWayLineOfSight({ ...pathVisibility });
        }
      }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("天体の地形・建物遮蔽を検証できませんでした", error);
        if (!cancelled) {
          setCelestialOcclusion({});
          setMilkyWayLineOfSight({});
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
    celestialPoints,
    celestialVisibility,
    milkyWayPath,
    cameraSettings.lensCenterHeightMeters,
    timelineInteracting,
  ]);

  useEffect(() => {
    const viewer = mapViewerRef.current;

    if (!viewer || viewer.isDestroyed()) {
      return;
    }
    updateConnectionLine(viewer, tripodPoint, subjectPoint);
  }, [tripodPoint, subjectPoint]);

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
    if (!viewer || viewer.isDestroyed() || !foregroundObject) return;
    return enableForegroundObjectDrag(viewer, (position) => {
      const coordinates = cartesianToForegroundCoordinates(position);
      placeForegroundAtCoordinates(coordinates.latitude, coordinates.longitude);
    });
  }, [mapReady, foregroundObject?.id, tripodPoint, subjectPoint]);

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
    // 2D表示中のCesiumは非表示なので、スクロール中は2Dオーバーレイだけを更新する。
    // 操作停止後に一度同期し、見えない3D Entity更新でフレームを落とさない。
    if (timelineInteracting && mapViewMode === "2d") return;

    try {
      updateCelestialMapEntities(
        viewer,
        tripodPoint,
        subjectPoint,
        celestialPoints,
        celestialTracks,
        mapViewMode === "3d" ? visibleMilkyWayPath : milkyWayPath,
        celestialVisibility,
        tripodCandidates,
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
    milkyWayPath,
    visibleMilkyWayPath,
    celestialVisibility,
    tripodCandidates,
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
          const message =
            error instanceof Error ? error.message : String(error);
          if (!cancelled && jobId === previewJobRef.current) {
            setPreviewStatus(`プレビュー生成失敗：${message}`);
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
  ]);

  function stopPlacementMode() {
    disablePlacementRef.current?.();
    disablePlacementRef.current = null;
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
    if (!mapReady) {
      throw new Error("3Dマップの読込完了後に検索してください");
    }
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
    const cacheKey = spotSearchPreparationKey({ criteria, subject, calculationMode });
    const cacheState = spotSearchCacheState(cacheKey);
    onProgress(
      cacheState === "cold"
        ? "初回検索データを準備しています。初回は通常より時間がかかります。次回以降は保存済みデータを利用して高速化されます。"
        : "保存済みの検索準備データを利用しています…",
      0
    );
    // 登録完了後は画面を閉じてもサーバー側ジョブを中断しない。
    const active = await startBackgroundSpotSearch({
      criteria,
      subject,
      baseDateIso: selectedDate.toISOString(),
      timeZone: searchTimeZone,
      lensCenterHeightMeters: cameraSettings.lensCenterHeightMeters,
      cameraSettings,
      previewAspectRatio,
      subjectGroundHeightMeters: subjectGround.height,
      calculationMode,
      cacheState,
      cacheKey,
    });
    const job = await waitForBackgroundSpotSearch(
      active,
      signal,
      onProgress
    );
    return completeBackgroundSpotSearch(active, job, signal, onProgress);
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
    if (job.status === "complete") {
      clearActiveSpotSearchJob(active);
      return results;
    }
    let viewer = mapViewerRef.current;
    for (let attempt = 0; (!viewer || viewer.isDestroyed()) && attempt < 120; attempt += 1) {
      if (signal.aborted) {
        throw new DOMException("最終3D確認を中止しました", "AbortError");
      }
      onProgress("3Dマップの読込完了を待っています…", 98);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      viewer = mapViewerRef.current;
    }
    if (!viewer || viewer.isDestroyed()) {
      throw new Error("3Dマップを読み込めないため最終遮蔽確認を開始できません");
    }
    const verifiedResults: SpotPresetResult[] = [];
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
        98 + Math.floor((Math.min(results.length, offset + concurrency) / Math.max(1, results.length)) * 2)
      );
      const batch = await Promise.all(
        results.slice(offset, offset + concurrency).map(async (result) => {
          const observer = await prepareCelestialLineOfSightObserver(
            viewer,
            result.tripod,
            job.input.lensCenterHeightMeters,
            signal
          );
          const visibility = await evaluatePhotorealisticMeshLineOfSight(
            viewer,
            observer,
            {
              azimuthDegrees: result.cameraAzimuthDegrees,
              altitudeDegrees: result.cameraAltitudeDegrees,
            },
            signal
          );
          return visibility.verified && visibility.visible ? result : null;
        })
      );
      verifiedResults.push(...batch.filter(
        (result): result is SpotPresetResult => result !== null
      ));
    }
    onProgress("最終3D確認結果を保存しています…", 100);
    await finalizeBackgroundSpotSearch(active, verifiedResults);
    if (job.input.cacheKey) markSpotSearchPrepared(job.input.cacheKey);
    onProgress(
      `${verifiedResults.length}件を最終確定しました${diagnosticMessage ? `
${diagnosticMessage}
最終3D通過: ${verifiedResults.length}件` : ""}`,
      100
    );
    return verifiedResults;
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


  async function locateSubjectFromSpotScreen(
    query: string,
    signal: AbortSignal,
    onProgress: (message: string, percent: number) => void
  ): Promise<void> {
    const viewer = mapViewerRef.current;
    if (!mapReady || !viewer || viewer.isDestroyed()) {
      throw new Error("マップの読込完了後に検索してください");
    }
    onProgress("被写体の位置を検索しています…", 0);
    const location = await resolveSpotLocation(query, signal);
    if (signal.aborted) throw new DOMException("検索中止", "AbortError");
    const subject = await resolveSearchSubject(
      location.latitude,
      location.longitude,
      location.label
    );
    if (signal.aborted) throw new DOMException("検索中止", "AbortError");
    stopAllEditModes();
    const pinned = setSubjectPinFromPosition(
      viewer,
      Cartesian3.fromDegrees(
        subject.longitude,
        subject.latitude,
        subject.height
      ),
      subject.label
    );
    const center = {
      latitude: pinned.latitude,
      longitude: pinned.longitude,
    };
    setSubjectPoint(pinned);
    setSubjectHistory(addSubjectHistory(pinned, /^https?:\/\//i.test(query.trim()) ? "google-maps-url" : "place"));
    mapCenterRef.current = center;
    setMapCenter(center);
    if (mapViewMode === "3d") {
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

  function applySpotPreset(result: SpotPresetResult): void {
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      setSearchMessage("マップの読込完了後に構図を適用してください");
      return;
    }
    stopAllEditModes();
    const subject = setSubjectPinFromPosition(
      viewer,
      Cartesian3.fromDegrees(result.subject.longitude, result.subject.latitude, result.subject.height),
      result.subject.label
    );
    const tripod = setTripodPin(
      viewer,
      Cartesian3.fromDegrees(result.tripod.longitude, result.tripod.latitude, result.tripod.height)
    );
    const localizedDate = zonedDateTimeLocalFromDate(result.date, result.timeZone);
    setSubjectPoint(subject);
    setTripodPoint(tripod);
    setCameraSettings((current) => ({
      ...current,
      focalLengthMm: result.focalLengthMm,
    }));
    setCelestialVisibility({
      sun: result.celestialId === "sun",
      moon: result.celestialId === "moon",
      milkyWay: result.celestialId === "milkyWay",
      polaris: false,
    });
    timeZoneRef.current = result.timeZone;
    setTimeZone(result.timeZone);
    dateTimeLocalRef.current = localizedDate;
    setDateTimeLocal(localizedDate);
    const center = { latitude: result.subject.latitude, longitude: result.subject.longitude };
    mapCenterRef.current = center;
    setMapCenter(center);
    if (mapViewMode === "3d") flyMapToTarget(viewer, center.latitude, center.longitude, subject.height);
    setSpotSearchOpen(false);
    setSearchMessage(`${result.celestialLabel}の構図を適用しました`);
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
    const viewer = mapViewerRef.current;

    if (!viewer || viewer.isDestroyed()) {
      setSearchMessage(
        "3Dマップの読込完了後にお試しください"
      );
      return;
    }

    if (subjectPlacementActive) {
      stopPlacementMode();
      setSearchMessage("被写体ピン変更を終了しました");
      return;
    }

    stopAllEditModes();
    setMapTool("none");
    setSpotSearchOpen(false);

    if (mapViewMode === "2d") {
      setSubjectPlacementActive(true);
      setSearchMessage("2D地図上で被写体を置く場所をクリックしてください");
      return;
    }

    disablePlacementRef.current = enableMapPlacement(
      viewer,
      (position) => {
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

  function placeForegroundAtCoordinates(latitude: number, longitude: number): void {
    if (!tripodPoint || !subjectPoint) {
      setSearchMessage("三脚ピンと被写体ピンを先に配置してください");
      return;
    }
    const constrained = constrainForegroundToSegment(latitude, longitude, tripodPoint, subjectPoint);
    setForegroundObjects((current) => [{
      id: current[0]?.id ?? (crypto.randomUUID?.() ?? `foreground-${Date.now()}`),
      type: "person",
      latitude: constrained.latitude,
      longitude: constrained.longitude,
      // 移動先の標高が確定するまで古い地点の標高を流用しない。
      groundHeightMeters: undefined,
      heightCm: current[0]?.heightCm ?? plannedForegroundHeightCmRef.current,
      enabled: true,
    }]);

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
        setSearchMessage("前景オブジェクト地点の標高を取得できませんでした。位置を再指定してください");
      });
    }, 180);
  }

  function toggleForegroundPlacement(): void {
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed() || !tripodPoint || !subjectPoint) {
      setSearchMessage("三脚ピンと被写体ピンを先に配置してください");
      return;
    }
    if (foregroundPlacementActive) { stopPlacementMode(); return; }
    stopAllEditModes();
    setMapTool("pin");
    if (mapViewMode === "2d") {
      setForegroundPlacementActive(true);
      setSearchMessage("三脚と被写体の間をタップしてください。配置後は人物をドラッグできます");
      return;
    }
    disablePlacementRef.current = enableMapPlacement(viewer, (position) => {
      const coordinates = cartesianToForegroundCoordinates(position);
      placeForegroundAtCoordinates(coordinates.latitude, coordinates.longitude);
      stopPlacementMode();
    });
    setForegroundPlacementActive(true);
    setSearchMessage("3D地図で前景・中景オブジェクトの位置をクリックしてください");
  }

  function updateForegroundHeight(heightCm: number): void {
    plannedForegroundHeightCmRef.current = heightCm;
    setPlannedForegroundHeightCm(heightCm);
    // 配置済みの場合はCesium Entityとプレビューが同じrender cycleで即時更新される。
    setForegroundObjects((current) => current.map((object, index) =>
      index === 0 ? { ...object, heightCm } : object
    ));
  }

  function deleteForegroundObject(): void {
    setForegroundObjects([]);
    setForegroundPlacementActive(false);
    setSearchMessage("前景・中景オブジェクトを削除しました");
  }

  function toggleTripodPlacement() {
    const viewer = mapViewerRef.current;

    if (!viewer || viewer.isDestroyed()) {
      setSearchMessage(
        "3Dマップの読込完了後にお試しください"
      );
      return;
    }

    if (tripodPlacementActive) {
      stopPlacementMode();
      setSearchMessage("三脚ピン設置を終了しました");
      return;
    }

    stopAllEditModes();
    setMapTool("none");
    setSpotSearchOpen(false);

    if (mapViewMode === "2d") {
      setTripodPlacementActive(true);
      setSearchMessage("2D地図上で三脚を置く場所をクリックしてください");
      return;
    }

    disablePlacementRef.current = enableMapPlacement(
      viewer,
      (position) => {
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
    if (!subjectPlacementActive && !tripodPlacementActive && !foregroundPlacementActive) return;
    const viewer = mapViewerRef.current;
    const mapElement = mapSectionRef.current;
    if (!viewer || viewer.isDestroyed() || !mapElement) return;
    const rect = mapElement.getBoundingClientRect();
    const coordinates = coordinatesAtMapPixel(
      event.clientX - rect.left,
      event.clientY - rect.top,
      mapCenter,
      mapZoom,
      { width: rect.width, height: rect.height }
    );

    if (foregroundPlacementActive) {
      placeForegroundAtCoordinates(coordinates.latitude, coordinates.longitude);
      stopPlacementMode();
      setSearchMessage("前景・中景オブジェクトを配置しました。人物をタップして移動できます");
    } else if (subjectPlacementActive) {
      const point = await setSubjectPinFromCoordinates(
        viewer,
        coordinates.latitude,
        coordinates.longitude,
        "手動指定地点"
      );
      setSubjectPoint(point);
      setSearchMessage(
        `被写体ピンを配置しました：${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`
      );
    } else {
      const point = await setTripodPinFromCoordinates(
        viewer,
        coordinates.latitude,
        coordinates.longitude,
        true
      );
      setTripodPoint(point);
      setSearchMessage(
        `三脚ピンを配置しました：${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`
      );
    }
    stopPlacementMode();
  }

  function startSubjectEdit() {
    const viewer = mapViewerRef.current;

    if (!viewer || viewer.isDestroyed()) {
      setSearchMessage(
        "3Dマップの読込完了後にお試しください"
      );
      return;
    }

    if (mapViewMode === "2d") {
      changeMapViewMode("3d");
    }

    stopPlacementMode();
    setSubjectEditActive(true);
    setSearchMessage(
      "3D画面を動かし、狙う位置を中央の十字へ合わせてください"
    );
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

  async function showCurrentLocation() {
    if (!window.isSecureContext) {
      setSearchMessage("現在地はHTTPS接続でのみ取得できます");
      return;
    }
    if (!navigator.geolocation) {
      setSearchMessage("この端末またはブラウザでは現在地を取得できません");
      return;
    }

    const requestId = ++currentLocationRequestRef.current;
    setMapTool("none");
    setSpotSearchOpen(false);
    setSearchMessage("現在地を取得しています…");

    const getPosition = (options: PositionOptions) =>
      new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, options);
      });

    try {
      let position: GeolocationPosition;
      try {
        // まずGPSを優先する。屋内などでタイムアウトした場合は、
        // Wi-Fi・基地局を利用する低精度取得へ自動的に切り替える。
        position = await getPosition({
          enableHighAccuracy: true,
          timeout: 15_000,
          maximumAge: 60_000,
        });
      } catch (firstError) {
        const geolocationError = firstError as GeolocationPositionError;
        if (geolocationError.code === 1) {
          throw geolocationError;
        }
        setSearchMessage("GPSで取得できないため、通常精度で再取得しています…");
        position = await getPosition({
          enableHighAccuracy: false,
          timeout: 15_000,
          maximumAge: 300_000,
        });
      }

      if (requestId !== currentLocationRequestRef.current) return;
      const { latitude, longitude, accuracy } = position.coords;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error("取得した座標が正しくありません");
      }

      const center = { latitude, longitude };
      mapCenterRef.current = center;
      setMapCenter(center);

      const viewer = mapViewerRef.current;
      if (mapViewModeRef.current === "3d" && viewer && !viewer.isDestroyed()) {
        flyMapToTarget(viewer, latitude, longitude);
      }

      const accuracyText = Number.isFinite(accuracy)
        ? `（精度 約${Math.max(1, Math.round(accuracy))}m）`
        : "";
      setSearchMessage(`現在地を地図の中心へ移動しました${accuracyText}`);
    } catch (error) {
      if (requestId !== currentLocationRequestRef.current) return;
      const geolocationError = error as GeolocationPositionError;
      if (typeof geolocationError.code === "number") {
        if (geolocationError.code === 1) {
          setSearchMessage("現在地の使用が許可されていません。端末の設定で、このサイトの位置情報を許可してください");
        } else if (geolocationError.code === 2) {
          setSearchMessage("現在地を特定できませんでした。端末の位置情報をONにして、屋外または電波の届く場所で再試行してください");
        } else if (geolocationError.code === 3) {
          setSearchMessage("現在地の取得がタイムアウトしました。端末の位置情報を確認して再試行してください");
        } else {
          setSearchMessage(`現在地を取得できませんでした：${geolocationError.message || "不明なエラー"}`);
        }
      } else {
        setSearchMessage(`現在地を取得できませんでした：${error instanceof Error ? error.message : "不明なエラー"}`);
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
    const viewer = mapViewerRef.current;
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

  function selectTripodCandidate(candidate: TripodCandidate) {
    const viewer = mapViewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    stopAllEditModes();
    const point = setTripodPin(
      viewer,
      Cartesian3.fromDegrees(
        candidate.longitude,
        candidate.latitude,
        candidate.height
      )
    );
    setTripodPoint(point);
    setMapCenter({ latitude: point.latitude, longitude: point.longitude });
    setSearchMessage(
      `${candidate.label}と被写体が重なる三脚候補へ移動しました（距離 ${Math.round(candidate.distanceMeters)}m）`
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

          <ForegroundPreviewOverlay
            object={foregroundObject}
            tripod={tripodPoint}
            subject={subjectPoint}
            camera={cameraSettings}
            aspectRatio={previewAspectRatio}
          />

          {previewReady && (
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
        onChangeDateTime={setDateTimeLocal}
        onOpenTransitSearch={() => setCelestialTransitSearchOpen(true)}
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
              candidates={tripodCandidates}
              tripodSearchLines={tripodSearchLines}
              foregroundObject={foregroundObject}
              foregroundEditing={foregroundPlacementActive}
              onMoveForeground={(coordinates) => placeForegroundAtCoordinates(coordinates.latitude, coordinates.longitude)}
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
                    : "前景・中景オブジェクトを置く地点を選択"
              }
            >
              <span>
                {subjectPlacementActive ? "被写体" : tripodPlacementActive ? "三脚" : "前景・中景"}を置く地面をクリック
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
                <button type="button" className={mapTool === "pin" ? "active" : ""} onClick={() => { setSpotSearchOpen(false); setMapTool((current) => current === "pin" ? "none" : "pin"); }}><span>⌖</span><small>ピン</small></button>
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
                  setMapTool("none");
                  setSpotSearchOpen(true);
                }}
              >
                <span aria-hidden="true">⌕</span>
                スポット検索
              </button>
            </div>

            <div className="map-right-actions">
              <button type="button" onClick={showCurrentLocation}><span>◉</span><small>現在地</small></button>
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
                  <button type="button" onClick={() => setMapTool("none")} aria-label="閉じる">×</button>
                </div>
                <PinControls
                  subjectActive={subjectPlacementActive}
                  tripodActive={tripodPlacementActive}
                  onSubjectToggle={toggleSubjectPlacement}
                  onSubjectEdit={startSubjectEdit}
                  onTripodToggle={toggleTripodPlacement}
                />
                <ForegroundObjectControls
                  object={foregroundObject}
                  heightCm={plannedForegroundHeightCm}
                  active={foregroundPlacementActive}
                  disabled={!subjectPoint || !tripodPoint}
                  onToggle={toggleForegroundPlacement}
                  onHeight={updateForegroundHeight}
                  onDelete={deleteForegroundObject}
                />
                <button
                  type="button"
                  className="tripod-google-maps-button"
                  onClick={openTripodInGoogleMaps}
                  disabled={!tripodPoint}
                >
                  Google Mapsで三脚位置を開く
                </button>
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
        onClose={() => setCelestialTransitSearchOpen(false)}
        onSelect={(result) => {
          const localized = zonedDateTimeLocalFromDate(result.date, timeZone);
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
        onBack={() => setSpotSearchOpen(false)}
        onSearch={searchFromSpotScreen}
        onResumeSearch={resumeSpotSearch}
        onLocateSubject={locateSubjectFromSpotScreen}
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

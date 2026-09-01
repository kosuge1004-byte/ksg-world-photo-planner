import { Capacitor } from "@capacitor/core";
import { useSyncExternalStore } from "react";

type InstallOutcome = "accepted" | "dismissed";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: InstallOutcome; platform: string }>;
};

export type PwaInstallState = {
  supported: boolean;
  canInstall: boolean;
  installed: boolean;
  installing: boolean;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let initialized = false;
let state: PwaInstallState = {
  supported: false,
  canInstall: false,
  installed: false,
  installing: false,
};
const listeners = new Set<() => void>();

function isStandaloneDisplay(): boolean {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches ||
    navigatorWithStandalone.standalone === true;
}

function updateState(next: Partial<PwaInstallState>): void {
  const updated = { ...state, ...next };
  if (
    updated.supported === state.supported &&
    updated.canInstall === state.canInstall &&
    updated.installed === state.installed &&
    updated.installing === state.installing
  ) {
    return;
  }
  state = updated;
  listeners.forEach((listener) => listener());
}

async function registerServiceWorker(): Promise<void> {
  try {
    await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
  } catch (error) {
    // Service Workerの失敗だけで撮影計画機能を停止させない。
    console.warn("AstroSightのService Workerを登録できませんでした", error);
  }
}

/**
 * 標準3D表示（国土地理院タイル・PLATEAU地形/建物）のオフラインタイル
 * キャッシュ（sw.js側の astrosight-tiles-v1）を削除する。
 * Googleタイルモードのデータはそもそもこのキャッシュに入らない
 * （sw.jsがホスト名で構造的に除外している）ため、ここでの削除対象にもならない。
 */
export async function clearOfflineTileCache(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  const controller = registration?.active ?? navigator.serviceWorker.controller;
  if (!controller) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data === "TILE_CACHE_CLEARED") finish(true);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    controller.postMessage("CLEAR_TILE_CACHE");
    // Service Workerが応答しない環境（未登録・非対応ブラウザ等）でも
    // 呼び出し元を待たせ続けないためのフォールバック。
    setTimeout(() => finish(false), 3000);
  });
}

export function initializePwaInstallSupport(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  const nativeApp = Capacitor.isNativePlatform();
  const supported = !nativeApp && window.isSecureContext && "serviceWorker" in navigator;
  updateState({ supported, installed: !nativeApp && isStandaloneDisplay() });

  window.addEventListener("beforeinstallprompt", (event) => {
    // Chromeが現行のインストール条件を満たした時点のイベントを保持し、
    // ユーザーがメニューを押したときだけ標準プロンプトを表示する。
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    updateState({ canInstall: true });
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    updateState({ canInstall: false, installed: true, installing: false });
  });

  if (supported) {
    if (document.readyState === "complete") {
      void registerServiceWorker();
    } else {
      window.addEventListener("load", () => void registerServiceWorker(), { once: true });
    }
  }
}

export async function requestPwaInstall(): Promise<InstallOutcome | "unavailable" | "installed"> {
  if (state.installed) return "installed";
  const prompt = deferredPrompt;
  if (!prompt || state.installing) return "unavailable";

  updateState({ installing: true });
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    deferredPrompt = null;
    updateState({
      canInstall: false,
      installed: choice.outcome === "accepted" || isStandaloneDisplay(),
    });
    return choice.outcome;
  } finally {
    updateState({ installing: false });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): PwaInstallState {
  return state;
}

export function usePwaInstall(): PwaInstallState & {
  install: typeof requestPwaInstall;
} {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { ...current, install: requestPwaInstall };
}

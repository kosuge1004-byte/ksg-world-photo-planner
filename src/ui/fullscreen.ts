const PSEUDO_FULLSCREEN_CLASS = "ios-pseudo-fullscreen";
const BODY_LOCK_CLASS = "pseudo-fullscreen-active";

function nativeFullscreenElement(): Element | null {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

export async function enterElementFullscreen(element: HTMLElement | null): Promise<void> {
  if (!element) return;

  const target = element as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };

  try {
    if (typeof element.requestFullscreen === "function") {
      await element.requestFullscreen();
      return;
    }
    if (typeof target.webkitRequestFullscreen === "function") {
      await target.webkitRequestFullscreen();
      return;
    }
  } catch {
    // iPhone Safari rejects fullscreen for ordinary elements. Use the in-app fallback.
  }

  document.querySelectorAll(`.${PSEUDO_FULLSCREEN_CLASS}`).forEach((node) => {
    node.classList.remove(PSEUDO_FULLSCREEN_CLASS);
  });
  element.classList.add(PSEUDO_FULLSCREEN_CLASS);
  document.body.classList.add(BODY_LOCK_CLASS);
  window.dispatchEvent(new Event("resize"));
}

export async function exitElementFullscreen(): Promise<void> {
  const doc = document as Document & {
    webkitExitFullscreen?: () => Promise<void> | void;
  };

  if (nativeFullscreenElement()) {
    try {
      if (typeof document.exitFullscreen === "function") {
        await document.exitFullscreen();
      } else if (typeof doc.webkitExitFullscreen === "function") {
        await doc.webkitExitFullscreen();
      }
    } catch {
      // Clear fallback state below even if the native exit fails.
    }
  }

  document.querySelectorAll(`.${PSEUDO_FULLSCREEN_CLASS}`).forEach((node) => {
    node.classList.remove(PSEUDO_FULLSCREEN_CLASS);
  });
  document.body.classList.remove(BODY_LOCK_CLASS);
  window.dispatchEvent(new Event("resize"));
}

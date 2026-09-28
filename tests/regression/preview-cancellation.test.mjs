import assert from "node:assert/strict";
import test from "node:test";

import { waitForPreviewTiles } from "../../src/cesium/previewSnapshot.ts";

test("stale preview tile waits abort promptly and restore resolution", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setTimeout,
    clearTimeout,
  };
  try {
    const viewer = {
      resolutionScale: 1,
      isDestroyed: () => false,
      canvas: { width: 10, height: 10 },
      scene: {
        globe: { show: true, tilesLoaded: false },
        primitives: { length: 0, get: () => undefined },
        requestRender() {},
        render() {},
      },
    };
    const canvas = { width: 10, height: 10 };
    const context = { clearRect() {}, drawImage() {} };
    const controller = new AbortController();
    const started = Date.now();
    const pending = waitForPreviewTiles(viewer, canvas, context, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, (error) => error?.name === "AbortError");
    assert.ok(Date.now() - started < 500, "abort must not wait for the 8 second tile timeout");
    assert.equal(viewer.resolutionScale, 1, "temporary preview resolution must always be restored");
  } finally {
    globalThis.window = previousWindow;
  }
});

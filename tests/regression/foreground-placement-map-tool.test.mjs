// 2026-10-16: 人物配置の開始時にピン設定メニューを開いたままにすると、地図に触れた瞬間に
// 「メニューの外を押した」扱いで配置モードが解除され、タップが三脚配置になっていた。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");

function functionBody(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const open = app.indexOf("{", app.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < app.length; i += 1) {
    if (app[i] === "{") depth += 1;
    if (app[i] === "}") { depth -= 1; if (depth === 0) return app.slice(open, i + 1); }
  }
  throw new Error(`${name} body not closed`);
}

test("all three placement modes close the pin menu so the outside-tap handler cannot cancel them", () => {
  for (const name of ["toggleForegroundPlacement", "toggleSubjectPlacement", "toggleTripodPlacement"]) {
    const body = functionBody(name);
    assert.match(body, /setMapTool\("none"\)/, `${name} must close the pin menu`);
    assert.doesNotMatch(body, /setMapTool\("pin"\)/, `${name} must not keep the pin menu open`);
  }
});

test("the outside-tap handler only runs while the pin menu is open", () => {
  assert.match(app, /if \(mapTool !== "pin"\) return;\s*function handleOutsidePointer/);
});

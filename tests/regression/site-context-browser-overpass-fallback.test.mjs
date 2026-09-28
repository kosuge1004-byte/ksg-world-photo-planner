import assert from "node:assert/strict";
import test from "node:test";

const originalFetch = globalThis.fetch;
let pagesRequests = 0;
let overpassRequests = 0;
let gsiRequests = 0;

globalThis.fetch = async (input) => {
  const value = String(input);
  if (value === "/api/osm-site-context") {
    pagesRequests += 1;
    return Response.json({ error: "Overpass API timeout" }, { status: 422 });
  }
  const url = new URL(value);
  if (url.hostname === "cyberjapandata.gsi.go.jp") {
    gsiRequests += 1;
    return new Response(null, { status: 404 });
  }
  if (url.pathname.endsWith("/api/interpreter")) {
    overpassRequests += 1;
    return Response.json({
      elements: [{
        type: "way",
        id: 123,
        tags: { highway: "footway" },
        geometry: [
          { lat: 34.999, lon: 136 },
          { lat: 35.001, lon: 136 },
        ],
      }],
    });
  }
  throw new Error(`unexpected request: ${value}`);
};

const { fetchSiteContexts } = await import("../../src/search/siteContext.ts");

test("browser falls back to direct read-only Overpass after a Pages egress timeout", async () => {
  const [context] = await fetchSiteContexts(
    [{ latitude: 35, longitude: 136 }],
    undefined,
    true,
    "full"
  );
  assert.equal(pagesRequests, 1);
  assert.ok(gsiRequests > 0);
  assert.equal(overpassRequests, 1);
  assert.equal(context.walkingAccessible, true);
  assert.equal(context.onMappedWay, true);
});

test.after(() => {
  globalThis.fetch = originalFetch;
});

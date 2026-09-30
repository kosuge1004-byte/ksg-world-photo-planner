import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as registerLocalDem } from "../../functions/api/local-dem-register.ts";
import {
  LOCAL_DEM_ENDPOINT_HEARTBEAT_SECONDS,
  LOCAL_DEM_ENDPOINT_REGISTRY_KEY,
  LOCAL_DEM_ENDPOINT_TTL_SECONDS,
  readRegisteredLocalDemEndpoint,
} from "../../server/localDemEndpointRegistry.ts";

const registrationToken = "registration-token-for-tests-" + "x".repeat(40);
const originToken = "origin-token-for-tests-" + "y".repeat(48);

class MemoryEndpointKv {
  value = null;
  writes = [];

  async get(key, options) {
    assert.equal(key, LOCAL_DEM_ENDPOINT_REGISTRY_KEY);
    assert.deepEqual(options, { type: "arrayBuffer" });
    return this.value;
  }

  async put(key, value, options) {
    this.writes.push({ key, value, options });
    this.value = value;
  }
}

function context(request, endpointKv, token = registrationToken, origin = originToken) {
  return {
    request,
    env: {
      LOCAL_DEM_REGISTRATION_TOKEN: token,
      LOCAL_DEM_ORIGIN_TOKEN: origin,
      SPOT_SEARCH_JOBS: endpointKv,
    },
    params: {},
    data: {},
    functionPath: "/api/local-dem-register",
    waitUntil() {},
    passThroughOnException() {},
    next: async () => new Response(null, { status: 404 }),
  };
}

function request(body, token = registrationToken, method = "POST") {
  return new Request("https://astrosight.pages.dev/api/local-dem-register", {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-astrosight-registration-token": token } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

test("registration endpoint requires its independent secret", async () => {
  const kv = new MemoryEndpointKv();
  for (const supplied of ["", "wrong-token-that-is-long-enough-" + "z".repeat(32)]) {
    const response = await registerLocalDem(context(
      request({ url: "https://valid.trycloudflare.com" }, supplied),
      kv
    ));
    assert.equal(response.status, 401);
  }
  assert.equal(kv.writes.length, 0);
});

test("registration endpoint accepts only a root Quick Tunnel HTTPS URL", async () => {
  const rejected = [
    "http://bad.trycloudflare.com",
    "https://example.com",
    "https://sub.domain.trycloudflare.com",
    "https://bad.trycloudflare.com/private",
    "https://bad.trycloudflare.com:8443",
    "https://user:pass@bad.trycloudflare.com",
    "https://bad.trycloudflare.com/?next=internal",
  ];
  for (const url of rejected) {
    const kv = new MemoryEndpointKv();
    const response = await registerLocalDem(context(request({ url }), kv));
    assert.equal(response.status, 400, url);
    assert.equal(kv.writes.length, 0, url);
  }
});

test("valid registration writes one fixed expiring KV record", async () => {
  const kv = new MemoryEndpointKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://valid-origin-123.trycloudflare.com/v1/health");
    assert.equal(init.method, "GET");
    assert.equal(init.headers["X-AstroSight-Origin-Token"], originToken);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  let response;
  try {
    response = await registerLocalDem(context(
      request({ url: "https://valid-origin-123.trycloudflare.com" }),
      kv
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    gatewayVerified: true,
    expiresAt: (await readRegistration(kv)).expiresAt,
    heartbeatSeconds: LOCAL_DEM_ENDPOINT_HEARTBEAT_SECONDS,
  });
  assert.equal(kv.writes.length, 1);
  assert.equal(kv.writes[0].key, LOCAL_DEM_ENDPOINT_REGISTRY_KEY);
  assert.deepEqual(kv.writes[0].options, {
    expirationTtl: LOCAL_DEM_ENDPOINT_TTL_SECONDS,
  });
  assert.equal(
    await readRegisteredLocalDemEndpoint(kv),
    "https://valid-origin-123.trycloudflare.com/v1/elevation/batch"
  );
});

test("registration never publishes an endpoint that fails the edge round-trip", async () => {
  const kv = new MemoryEndpointKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 502 });
  let response;
  try {
    response = await registerLocalDem(context(
      request({ url: "https://unreachable-origin.trycloudflare.com" }),
      kv
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "ORIGIN_HTTP_502");
  assert.equal(kv.writes.length, 0);
});

test("registration requires the separately configured origin secret", async () => {
  const kv = new MemoryEndpointKv();
  const response = await registerLocalDem(context(
    request({ url: "https://valid-origin-123.trycloudflare.com" }),
    kv,
    registrationToken,
    ""
  ));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "ORIGIN_TOKEN_UNAVAILABLE");
  assert.equal(kv.writes.length, 0);
});

async function readRegistration(kv) {
  const decoded = JSON.parse(new TextDecoder().decode(kv.value));
  assert.equal(decoded.version, 1);
  assert.equal(
    decoded.endpoint,
    "https://valid-origin-123.trycloudflare.com/v1/elevation/batch"
  );
  return decoded;
}

test("registration route rejects non-POST methods", async () => {
  const kv = new MemoryEndpointKv();
  const response = await registerLocalDem(context(request({}, registrationToken, "GET"), kv));
  assert.equal(response.status, 405);
  assert.equal(kv.writes.length, 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HttpRequestError,
  readJsonRequest,
  requestErrorStatus,
} from "../../functions/_shared/http.ts";

function jsonRequest(body, headers = {}) {
  return new Request("https://example.test/api", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body,
  });
}

async function rejectsWithStatus(promise, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HttpRequestError);
    assert.equal(requestErrorStatus(error), status);
    return true;
  });
}

test("bounded JSON reader accepts a valid request", async () => {
  assert.deepEqual(await readJsonRequest(jsonRequest('{"ok":true}'), 64), { ok: true });
});

test("bounded JSON reader requires JSON and rejects compressed bodies", async () => {
  await rejectsWithStatus(readJsonRequest(new Request("https://example.test/api", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  }), 64), 415);
  await rejectsWithStatus(readJsonRequest(jsonRequest("{}", {
    "content-encoding": "gzip",
  }), 64), 415);
});

test("bounded JSON reader rejects declared and streamed oversize bodies", async () => {
  await rejectsWithStatus(readJsonRequest(jsonRequest("{}", {
    "content-length": "1000",
  }), 32), 413);
  await rejectsWithStatus(readJsonRequest(jsonRequest(JSON.stringify({ data: "x".repeat(100) })), 32), 413);
});

test("bounded JSON reader rejects malformed JSON and invalid UTF-8", async () => {
  await rejectsWithStatus(readJsonRequest(jsonRequest("{"), 64), 400);
  await rejectsWithStatus(readJsonRequest(new Request("https://example.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new Uint8Array([0xff, 0xfe]),
  }), 64), 400);
});

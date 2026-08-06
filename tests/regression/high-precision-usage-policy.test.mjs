import test from "node:test";
import assert from "node:assert/strict";
import {
  HIGH_PRECISION_STOP_LIMIT,
  HIGH_PRECISION_WARNING_LIMIT,
  decideHighPrecisionAfterCount,
  decideHighPrecisionBeforeCreate,
  highPrecisionMonthKey,
} from "../../server/highPrecisionUsagePolicy.ts";

test("799件では通知せず、次の新規セッションを許可する", () => {
  assert.deepEqual(decideHighPrecisionBeforeCreate({
    count: HIGH_PRECISION_WARNING_LIMIT - 1,
    serviceEnabled: true,
    limitsEnabled: true,
  }), { allowed: true, shouldWarn: false });
});

test("800件到達後は許可を継続しつつ通知対象になる", () => {
  assert.deepEqual(decideHighPrecisionAfterCount({
    count: HIGH_PRECISION_WARNING_LIMIT,
    serviceEnabled: true,
    limitsEnabled: true,
  }), { allowed: true, shouldWarn: true, reason: undefined });
});

test("849件では850件目を許可し、850件到達後は次の新規セッションを停止する", () => {
  assert.equal(decideHighPrecisionBeforeCreate({
    count: HIGH_PRECISION_STOP_LIMIT - 1,
    serviceEnabled: true,
    limitsEnabled: true,
  }).allowed, true);
  assert.equal(decideHighPrecisionAfterCount({
    count: HIGH_PRECISION_STOP_LIMIT,
    serviceEnabled: true,
    limitsEnabled: true,
  }).allowed, true);
  assert.deepEqual(decideHighPrecisionBeforeCreate({
    count: HIGH_PRECISION_STOP_LIMIT,
    serviceEnabled: true,
    limitsEnabled: true,
  }), {
    allowed: false,
    shouldWarn: false,
    reason: "monthly_limit_reached",
  });
});

test("月間制限を無効化すると850件以上でも許可する", () => {
  assert.equal(decideHighPrecisionBeforeCreate({
    count: HIGH_PRECISION_STOP_LIMIT + 100,
    serviceEnabled: true,
    limitsEnabled: false,
  }).allowed, true);
});

test("緊急停止は月間制限設定に関係なく拒否する", () => {
  assert.deepEqual(decideHighPrecisionBeforeCreate({
    count: 0,
    serviceEnabled: false,
    limitsEnabled: false,
  }), {
    allowed: false,
    shouldWarn: false,
    reason: "service_disabled",
  });
});

test("月次キーはAmerica/Los_Angeles基準で切り替わる", () => {
  assert.equal(highPrecisionMonthKey(new Date("2026-09-01T06:59:59Z")), "2026-08");
  assert.equal(highPrecisionMonthKey(new Date("2026-09-01T07:00:00Z")), "2026-09");
});

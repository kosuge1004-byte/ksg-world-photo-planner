import assert from "node:assert/strict";
import { constrainedBicubicInterpolate, isUsableBicubicGrid } from "../../server/constrainedBicubicInterpolation.ts";

const plane = [
  [0, 1, 2, 3],
  [1, 2, 3, 4],
  [2, 3, 4, 5],
  [3, 4, 5, 6],
];
assert.ok(Math.abs(constrainedBicubicInterpolate(plane, 0.5, 0.5) - 3) < 1e-12);

const overshootRisk = [
  [0, 0, 0, 0],
  [0, 10, 10, 0],
  [0, 10, 10, 0],
  [0, 0, 0, 0],
];
const value = constrainedBicubicInterpolate(overshootRisk, 0.5, 0.5);
assert.ok(value >= 10 && value <= 10, `central plateau must remain 10, got ${value}`);

const steep = [
  [0, 0, 100, 100],
  [0, 0, 100, 100],
  [0, 0, 100, 100],
  [0, 0, 100, 100],
];
const bounded = constrainedBicubicInterpolate(steep, 0.5, 0.5);
assert.ok(bounded >= 0 && bounded <= 100, `must not overshoot, got ${bounded}`);

console.log("constrained bicubic interpolation tests passed");


assert.equal(isUsableBicubicGrid(plane), true);
assert.equal(isUsableBicubicGrid([
  [0, 1, 2, 3],
  [1, 2, null, 4],
  [2, 3, 4, 5],
  [3, 4, 5, 6],
]), false);
assert.equal(isUsableBicubicGrid([
  [0, 1, 2, 3],
  [1, 2, Number.NaN, 4],
  [2, 3, 4, 5],
  [3, 4, 5, 6],
]), false);

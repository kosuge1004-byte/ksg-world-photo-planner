import assert from "node:assert/strict";

import {
  parseFocalLengthInput,
} from "../src/utils/focalLengthInput.ts";

for (const [input, expected] of [
  ["9", 9],
  ["40", 40],
  ["50", 50],
  ["1600", 1600],
  ["24.5", 24.5],
  ["５０", 50],
]) {
  assert.deepEqual(parseFocalLengthInput(input), {
    valid: true,
    value: expected,
  });
}

for (const input of [
  "",
  "8",
  "8.999",
  "1600.001",
  "1601",
  "abc",
  "Infinity",
]) {
  assert.deepEqual(parseFocalLengthInput(input), { valid: false });
}

console.log("Focal length input verification: PASS");

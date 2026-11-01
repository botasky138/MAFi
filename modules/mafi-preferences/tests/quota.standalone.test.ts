import assert from "node:assert/strict";
import test from "node:test";
import { quotaMultiplier } from "../backend/quota.ts";
import { sourceQuota } from "@aihot/backend/publication/timeline";

test("cold start is neutral (1x)", () => { assert.equal(quotaMultiplier(0, 0), 1); });
test("multiplier is bounded to [0.5, 2] and monotone", () => {
  assert.equal(quotaMultiplier(1000, 0), 2);
  assert.equal(quotaMultiplier(0, 1000), 0.5);
  assert.ok(quotaMultiplier(3, 0) > 1 && quotaMultiplier(3, 0) < 2);
  assert.ok(quotaMultiplier(0, 3) < 1 && quotaMultiplier(0, 3) > 0.5);
  assert.ok(quotaMultiplier(5, 1) > quotaMultiplier(4, 1));
});
test("quota never reaches zero", () => {
  assert.equal(sourceQuota(2, 0.5), 1);
  assert.equal(sourceQuota(2, 1), 2);
  assert.equal(sourceQuota(2, 2), 4);
  assert.equal(sourceQuota(1, 0.01), 1);
  assert.equal(sourceQuota(2, undefined), 2);
});

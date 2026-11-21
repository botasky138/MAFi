// Unit tests for Docker/systemd worker status derivation in packages/backend/src/site/status.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveWorkerStatus, type WorkerStatusInput } from "@aihot/backend/site/status";

const NOW = new Date("2026-11-21T12:00:00.000Z");

function base(overrides: Partial<WorkerStatusInput> = {}): WorkerStatusInput {
  return {
    now: NOW,
    db: "ok",
    newestArticleAt: "2026-11-21T11:55:00.000Z",
    workerHeartbeatAt: "2026-11-21T11:59:30.000Z",
    collectEnabled: true,
    modelCallsEnabled: true,
    lastScheduleRun: { status: "ok", at: "2026-11-21T11:58:00.000Z" },
    lastSweepRun: { status: "ok", at: "2026-11-21T11:45:00.000Z" },
    lastSourceOkAt: "2026-11-21T11:57:00.000Z",
    enabledSources: 12,
    failingSources: 0,
    lastAnalyzeAt: "2026-11-21T11:40:00.000Z",
    ...overrides,
  };
}

test("healthy worker with active valves reports green", () => {
  const status = deriveWorkerStatus(base());
  assert.equal(status.light, "green");
  assert.equal(status.label, "运行正常");
  assert.equal(status.autoLoop, "running");
  assert.equal(status.collect, "ok");
  assert.equal(status.analyze, "ok");
  assert.equal(status.lastCollectAt, "2026-11-21T11:58:00.000Z");
  assert.equal(status.lastAnalyzeAt, "2026-11-21T11:45:00.000Z");
});

test("healthy worker with valves disabled stays green and marks collect/analyze unknown", () => {
  const status = deriveWorkerStatus(base({
    collectEnabled: false,
    modelCallsEnabled: false,
    lastScheduleRun: null,
    lastSweepRun: null,
    lastSourceOkAt: null,
    lastAnalyzeAt: null,
  }));
  assert.equal(status.light, "green");
  assert.equal(status.autoLoop, "running");
  assert.equal(status.collect, "unknown");
  assert.equal(status.analyze, "unknown");
  assert.match(status.detail, /安全阀关闭/);
});

test("missing worker heartbeat reports yellow", () => {
  const status = deriveWorkerStatus(base({ workerHeartbeatAt: null }));
  assert.equal(status.light, "yellow");
  assert.equal(status.label, "需关注");
  assert.equal(status.autoLoop, "missing");
});

test("stale worker heartbeat (>5m) reports red", () => {
  const status = deriveWorkerStatus(base({ workerHeartbeatAt: "2026-11-21T11:54:00.000Z" }));
  assert.equal(status.light, "red");
  assert.equal(status.label, "服务异常");
  assert.equal(status.autoLoop, "dead");
});

test("failing schedule or all enabled sources failing reports red", () => {
  const failedRun = deriveWorkerStatus(base({ lastScheduleRun: { status: "failed", at: "2026-11-21T11:59:00.000Z" } }));
  assert.equal(failedRun.light, "red");
  assert.equal(failedRun.collect, "failing");

  const allSourcesFailing = deriveWorkerStatus(base({ enabledSources: 4, failingSources: 4 }));
  assert.equal(allSourcesFailing.light, "red");
  assert.equal(allSourcesFailing.collect, "failing");
});

test("stale collection (>15m) reports yellow 采集延迟", () => {
  const status = deriveWorkerStatus(base({
    lastScheduleRun: { status: "ok", at: "2026-11-21T11:40:00.000Z" },
    lastSourceOkAt: "2026-11-21T11:39:00.000Z",
  }));
  assert.equal(status.light, "yellow");
  assert.equal(status.label, "采集延迟");
  assert.equal(status.collect, "stale");
});

test("stale analyze (>90m) reports yellow 运行降级", () => {
  const status = deriveWorkerStatus(base({
    lastSweepRun: { status: "ok", at: "2026-11-21T10:15:00.000Z" },
    lastAnalyzeAt: "2026-11-21T10:00:00.000Z",
  }));
  assert.equal(status.light, "yellow");
  assert.equal(status.label, "运行降级");
  assert.equal(status.analyze, "stale");
});

test("down database reports red", () => {
  const status = deriveWorkerStatus(base({ db: "down", workerHeartbeatAt: null }));
  assert.equal(status.light, "red");
  assert.equal(status.label, "服务异常");
  assert.equal(status.detail, "数据库不可用");
});

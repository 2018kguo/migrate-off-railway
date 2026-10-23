import assert from "node:assert/strict";
import { test } from "node:test";

import { analyze, fargateSize, scaledTaskHours, toMarkdown } from "./railway-usage-replay.mjs";

// 15-minute samples: idle at 2 GB for most of a day, then 4 hours at 40 GB.
const day = Array.from({ length: 96 }, (_, i) => ({ ts: i * 900, mem: i >= 40 && i < 56 ? 40 : 2, cpu: 0.2 }));

test("a task size is the cheapest valid Fargate pair that fits", () => {
  assert.deepEqual(fargateSize(5, 0.5), { vcpu: 1, gb: 5, hour: 1 * 0.04048 + 5 * 0.004445 });
  assert.equal(fargateSize(0.5, 0.25).vcpu, 0.25);
  assert.equal(fargateSize(14, 1).vcpu, 2); // 1 vCPU allows at most 8 GB
  assert.throws(() => fargateSize(200, 1), /No Fargate size/);
});

test("a scaled service runs one task when idle and more only during the burst", () => {
  const size = { vcpu: 2, gb: 16 };
  // No baseline: 40 GB / (16 * 0.5) = 5 tasks during the burst, held 30
  // minutes after.
  const hours = scaledTaskHours(day, size, 8, { baseGb: 0 });
  assert.equal(hours, ((96 - 16 - 2) * 1 + (16 + 2) * 5) * 0.25);
  // The ceiling is Railway's replica count.
  assert.ok(scaledTaskHours(day, size, 3, { baseGb: 0 }) < hours);
});

test("a floor keeps that many tasks even when idle", () => {
  const idle = Array.from({ length: 8 }, (_, i) => ({ ts: i * 900, mem: 0, cpu: 0 }));
  assert.equal(scaledTaskHours(idle, { vcpu: 1, gb: 8 }, 8, { baseGb: 0, floor: 2 }), 8 * 2 * 0.25);
});

test("Railway's per-replica idle baseline isn't charged once per replica", () => {
  // 8 replicas idling at 1 GB each read as 8 GB of memory; one task here
  // carries one baseline, so idle needs one task. Without the baseline the
  // same reading asks for two 8 GB tasks.
  const idle = Array.from({ length: 8 }, (_, i) => ({ ts: i * 900, mem: 8, cpu: 0 }));
  const size = { vcpu: 1, gb: 8 };
  assert.equal(scaledTaskHours(idle, size, 8, { baseGb: 1 }), 8 * 0.25);
  assert.equal(scaledTaskHours(idle, size, 8, { baseGb: 0 }), 8 * 2 * 0.25);
});

test("the report prices fixed and scaled fleets and shows the burst", () => {
  const report = analyze([{ service: "worker", replicas: 8, series: day }]);
  const row = report.rows[0];
  assert.equal(row.perReplica.memMax, 5); // 40 GB across 8 replicas
  assert.ok(row.scaledMonth < row.fixedMonth / 2, "a mostly idle fleet costs far less when it follows the load");
  assert.equal(report.fleet.max, 40);
  const markdown = toMarkdown(report, "demo / production");
  assert.match(markdown, /\| worker \| 8 \|/);
  assert.match(markdown, /hours above twice the median/);
});

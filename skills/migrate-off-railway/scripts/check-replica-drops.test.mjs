import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { replicaDrops } from "./check-replica-drops.mjs";

const service = (index, before, after) => ({
  type: "aws_ecs_service",
  index,
  change: { before: { desired_count: before }, after: { desired_count: after } },
});
const plan = {
  resource_changes: [
    service("scheduler", 1, 0),
    service("web", 2, 2),
    service("worker", 1, 3),
    service("new", null, 1),
    {
      type: "aws_ecs_service",
      index: "renamed-by-typo",
      change: { actions: ["delete"], before: { desired_count: 2 }, after: null },
    },
    {
      type: "aws_ecs_service",
      index: "replaced",
      change: { actions: ["delete", "create"], before: { desired_count: 1 }, after: { desired_count: 1 } },
    },
    { type: "aws_lb", index: null, change: { before: {}, after: {} } },
  ],
};

test("a lower desired_count or a deleted service counts as a drop; a replacement doesn't", () => {
  assert.deepEqual(replicaDrops(plan), [
    { service: "scheduler", before: 1, after: 0 },
    { service: "renamed-by-typo", before: 2, after: 0 },
  ]);
});

test("with autoscaling, a lower ceiling or a new target under the live count is a drop", () => {
  const target = (index, before, after) => ({
    type: "aws_appautoscaling_target",
    index,
    change: { before: before === null ? null : { max_capacity: before }, after: { max_capacity: after } },
  });
  assert.deepEqual(
    replicaDrops({
      resource_changes: [
        service("worker-a", 6, 6),
        target("worker-a", 6, 3),
        service("batch", 8, 8),
        target("batch", null, 8),
        service("worker-b", 4, 4),
        target("worker-b", null, 2),
      ],
    }),
    [
      { service: "worker-a", before: 6, after: 3 },
      { service: "worker-b", before: 4, after: 2 },
    ]
  );
});

test("a drop fails unless the replica file changed", () => {
  const file = join(mkdtempSync(join(tmpdir(), "replica-drops-")), "plan.json");
  writeFileSync(file, JSON.stringify(plan));
  const script = fileURLToPath(new URL("./check-replica-drops.mjs", import.meta.url));
  assert.throws(() => execFileSync("node", [script, file, "false"], { stdio: "pipe" }));
  execFileSync("node", [script, file, "true"], { stdio: "pipe" });
});

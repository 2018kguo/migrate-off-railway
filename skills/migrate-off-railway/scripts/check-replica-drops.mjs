#!/usr/bin/env node
// Fails an apply that would scale a running ECS service down when the
// commits being deployed did not change the replica-count file. Run it on a
// saved plan, before `tofu apply <plan>`:
//
//   tofu plan -out plan.out && tofu show -json plan.out > plan.json
//   node check-replica-drops.mjs plan.json <replica-file-changed: true|false>
//
// It reads only the plan JSON. The caller decides "changed", for example with
// `git diff --quiet <last-applied-commit> HEAD -- path/to/replicas.tfvars`.
// Works the same for Terraform plan JSON. The gate is all-or-nothing: any
// change to the replica file lets every drop in that deploy through, so
// review replica-file changes the way you'd review a scale-down.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function replicaDrops(plan) {
  return (plan.resource_changes ?? [])
    .filter((change) => change.type === "aws_ecs_service")
    .map((change) => {
      const actions = change.change?.actions ?? [];
      const before = change.change?.before?.desired_count;
      // A service removed from the map (or renamed by a typo) plans as a
      // delete; count it as dropping to 0.
      const deleted = actions.includes("delete") && !actions.includes("create");
      const after = deleted ? 0 : change.change?.after?.desired_count;
      return { service: change.index ?? change.address, before, after };
    })
    .filter(
      ({ before, after }) =>
        typeof before === "number" && typeof after === "number" && after < before
    );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const replicaFileChanged = process.argv[3] === "true";
  const drops = replicaDrops(plan);
  for (const drop of drops) {
    console.log(`${drop.service}: ${drop.before} -> ${drop.after}`);
  }
  if (drops.length > 0 && !replicaFileChanged) {
    console.error(
      "This apply scales running services down, but the deployed commits did not change the replica file, so main is probably missing a change made by hand. Nothing was applied."
    );
    process.exit(1);
  }
}

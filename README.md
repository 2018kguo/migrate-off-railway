# migrate-off-railway

A playbook for moving a production app from Railway to AWS (ECS Fargate with
OpenTofu or Terraform) one service at a time, without a maintenance window.
It comes from a real migration and includes the checks that gated each step,
the order traffic moved in, the Railway behaviors that caused trouble, and
what went wrong along the way with the guard that now prevents each problem.

It works for other shapes than the one it came from: an API on Railway with
the frontend elsewhere, a single service, only background workers, or some
services staying on Railway. The skill starts by working out which of its
steps your setup needs.

```bash
npx skills add 2018kguo/migrate-off-railway
```

It never loads on its own. Start it when you want it:

```
/migrate-off-railway
```

A good first request keeps everything read-only until you've seen the plan:

```
/migrate-off-railway inventory our Railway production environment and
propose a plan for our setup. Don't create or change anything yet.
```

## Reading it yourself

To get the whole picture in about ten minutes, read the diagram and the
"Where to stop and ask" list in `SKILL.md`, the table at the top of the
cutover runbook, and the summaries at the top of `railway-footguns.md` and
`incidents.md`. Everything else is detail for when you reach that step.

## What's in it

`skills/migrate-off-railway/SKILL.md` is the entry point: the order of the
work, how to decide what happens to each service, where an agent should stop
and ask, and the checks grouped by when they matter.

The `references` folder holds the detail for each phase:

- `railway-footguns.md` covers Railway behaviors that matter when you leave
- `aws-blueprint.md` covers the AWS stack, the tests that run before every
  apply, the CI deploy workflow and cost
- `cutover-runbook.md` covers the cutover, step by step, with a check and an
  undo for each step
- `incidents.md` covers what went wrong in the original migration
- `failure-drills.md` has a test for each of those failure modes, and the
  checklist and canary for moving egress off NAT gateways
- `cost.md` covers why Railway costs less than a copy of it on Fargate,
  replaying Railway's usage to choose task sizes and between fixed Fargate,
  scaled Fargate and ECS on EC2, scaling queue workers, and what NAT, data
  transfer and discounts change
- `stateful-and-other-cases.md` covers databases with volumes, push-style
  workers, other DNS providers and Kubernetes

The `scripts` folder has three small tools, each with tests:

- `railway-inventory.mjs` writes a read-only Markdown inventory of a Railway
  environment, listing variable names but never values, plus the project's
  other environments and every other project `railway list` shows
- `railway-usage-replay.mjs` reads 30 days of each service's memory and CPU
  from Railway (read-only) and prices fixed Fargate, scaled Fargate and an
  EC2 pool against it
- `check-replica-drops.mjs` fails a deploy that would scale a running ECS
  service down when the replica file didn't change

The other tools from the original migration (env seeding, retiring Railway
services, DNS changes) are described in the references but not included.
They write secrets, delete deployments or depend on one DNS provider, and
copying them into a different setup without reading them carefully is more
dangerous than writing them from the description.

## License

MIT

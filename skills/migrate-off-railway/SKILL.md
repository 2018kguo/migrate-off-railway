---
name: migrate-off-railway
description: Playbook for moving a production app from Railway to AWS (ECS Fargate with OpenTofu or Terraform) one service at a time, with parity tests before every apply and a rollback for every step. Built from a real production migration.
disable-model-invocation: true
---

# Migrate off Railway to AWS ECS

This playbook moves a running production app from Railway to ECS Fargate
without a maintenance window. It assumes the app's databases, queues and
object storage already live outside Railway, which turns the move into a
compute swap and a DNS change. If Railway hosts stateful services (Postgres or
Redis with a volume, buckets), read `references/stateful-and-other-cases.md`
before starting, because those need a data migration that this flow doesn't
cover.

Every rule here comes from something that broke, or nearly broke, in a real
migration. `references/incidents.md` tells those stories,
`references/failure-drills.md` has a test for each failure mode, and the
other references hold the detail for each phase.

## The shape of the work

```
Prepare: nothing moves               Cut over: one piece at a time

  inventory (read-only)         ┌──▶ shadow web (reachable only by you)
      │                         │        │
  images, stack at 0 replicas   │    workers, queue by queue
      │                         │        │
  env seed                      │    web DNS
      │                         │        │
  tests + independent review ───┘    integrations
                                         │
                                     scheduler
                                         │
                                     retire Railway
```

The left column changes nothing users see. Every step on the right has an
undo, until Railway's services are deleted at the very end. For an app with
several services, expect the left column to take most of a day and the right
column an afternoon. Leave the old services stopped but not deleted for at
least a week after the last move.

## Before you start

Check the tools first, and stop to ask for whatever is missing:

- `railway whoami` and `railway --version`. The Railway notes were checked
  against CLI 5.71, so recheck anything marked "observed" on a newer one.
- `aws sts get-caller-identity` names the account you mean to deploy into.
- `tofu version` is 1.10 or later, which locks state without a DynamoDB table.
- Node 22 or later runs the scripts and their tests.
- Something builds images for the CPU architecture your task definitions
  use. Staying on x86 (`X86_64`, what Railway runs) keeps native
  dependencies identical during the move, and arm64 can come later as a
  cost step. Building x86 images by emulating them on an arm64 laptop is
  too slow for a large build.

Then ask the person you're working with, before writing any infrastructure:

- Which AWS account and region. Compute belongs in the region that holds the
  database and queue, and the bucket, cache and vector store belong there
  too: anything elsewhere pays NAT and cross-region transfer on every byte.
- Who hosts DNS for the hostnames users call, and whether records can be
  changed through that provider's API.
- ECS or Kubernetes.
- Which Railway projects and environments are in scope. The inventory lists
  everything else in the account, and staging environments or side projects
  sometimes share variables or a branch with production.
- What the new stack may cost each month. At Railway's replica counts and
  full-size tasks, Fargate can cost several times the Railway bill.
- Whether CI should apply the stack once the move is done, and which CI
  system runs it.

## How to run it

Keep a cutover log from the first command: a timestamped line for every
change to either platform, with the command that undoes it. When something
breaks halfway through, that log answers "what changed" in a minute.

Work in this order, reading the matching reference as you reach each phase.

1. Inventory. Link a directory to the project with `railway link`, and from
   that directory run `node <skill-dir>/scripts/railway-inventory.mjs
   production > inventory.md`, where `<skill-dir>` is the directory holding
   this file. Run `railway metrics --all --network --since 7d -e production`
   once for every service's traffic, which sets the NAT estimate. Fill in
   the decision table below for every service.
   `references/railway-footguns.md` lists what the inventory has to look
   for beyond what the script reports.
2. Capacity and cost. Railway packs services onto shared hosts and bills
   what they use, so its replica counts were never a sizing decision. Run
   `node <skill-dir>/scripts/railway-usage-replay.mjs production --days 30`
   before Railway's history goes away, and choose each service's task size
   and whether its count is fixed or follows the load. A fixed Fargate fleet
   at Railway's counts reserves the peak all month, which can cost several
   times the Railway bill for a bursty app. `references/cost.md`
   explains how to read the replay, scale queue workers and price the rest.
3. Images and stack. Write an OpenTofu stack with every replica count at 0,
   following `references/aws-blueprint.md`, and build the images. Don't
   apply it yet.
4. Env seed. Copy each service's variables into a secret per service,
   committing only the key names. Runbook step 2 has the seed's rules
   (sealed variables, Railway-only hostnames, removed keys).
5. Tests and an independent review. Run the parity tests and have someone, or
   a separate agent with no stake in the design, review the diff for ways it
   breaks production. These gate the first `tofu apply`. In the migration
   this playbook comes from, review found more than ten real defects before
   any traffic moved.
6. Cutover. Follow `references/cutover-runbook.md`. Its steps 1 and 2 apply
   the stack at zero replicas and run the seed from steps 3 and 4 above;
   from step 3 on it moves traffic, one service or queue at a time,
   verifying each step before starting the next. Before each risky step,
   run its drill from `references/failure-drills.md`.

## Fit the flow to your setup

The steps above are the full flow for an app whose frontend, API, background
workers and scheduler all run on Railway. Most apps are shaped differently,
so after the inventory, work out which steps apply and skip the rest.

| If your setup looks like this | What changes |
|---|---|
| The frontend runs elsewhere (Vercel, Netlify, a CDN) and only the API is on Railway | Moving web traffic means moving the API's hostname. If the frontend calls a `*.up.railway.app` URL, give the API a hostname on your own domain first and redeploy the frontend with it, so the switch becomes a DNS change. Check CORS allowed origins, and cookies scoped to the API's domain. |
| A single service handles everything | One task definition, one hostname. The worker and scheduler steps disappear, but the checks on client IP, build env, drain time and secrets still apply. |
| Only background workers run on Railway | No DNS change. Move workers queue by queue, then retire Railway. |
| Workers run on a schedule, or are triggered over HTTP | The queue-sharing step doesn't apply. Treat each one as a singleton or as a web service (`references/stateful-and-other-cases.md`). |
| A database, Redis or bucket with data lives on Railway | Plan and rehearse the data move first. It sets the length of any write freeze. |
| Some services stay on Railway for now | Point the services that move at the ones that stay through their public hostnames, since `*.railway.internal` only resolves inside Railway, and expect egress charges on both sides. |
| The target is Kubernetes (EKS or another cluster) | The order, the checks and the Railway notes carry over; the stack and its settings don't (`references/stateful-and-other-cases.md`). |
| A few services, no release windows or watch patterns on Railway | Deploy every service on every merge and skip the release planner (`references/aws-blueprint.md`, "The CI deploy workflow") and its check. |

## Deciding what happens to each service

| What the inventory shows | Decision |
|---|---|
| Serves requests or pulls jobs, no volume | Move it |
| Railway runs it with several replicas | Treat that count as the ceiling scaling may reach: idle replicas cost almost nothing on Railway and a full task each on Fargate |
| Its 30-day peak is close to its median | Fix its count, sized from its peak per replica |
| Its peak is several times its median, for hours | Let its task count follow the load (`references/cost.md`) |
| Last request or job is weeks old, or the feature it backs has no users | Retire it with the rest of Railway, after confirming usage in the database |
| A volume, or a Railway-managed database that isn't a cache | Plan a data migration first (`references/stateful-and-other-cases.md`) |
| Pinned to a different region than the other services | Find the dependency it sits next to before choosing its new region |
| Called at a `*.up.railway.app` URL configured in a third-party dashboard | Move it, and find the account that owns that registration before the cutover |
| Runs scheduled work or its own poller | Move it as a singleton: stop the old copy before starting the new one, unless it is provably safe to run twice |

## Where to stop and ask the person you're working with

Prepare and verify everything up to these points, then get a clear yes before
going further. Each one either moves real users or is hard to undo.

- Starting new workers on queues that production already uses
- Changing DNS for a hostname that users or integrations call
- Stopping or retiring a Railway service
- Deleting Railway services, shared variables or buckets, after which a
  rollback means rebuilding them
- Changing a URL or setting in a third-party dashboard
- Turning on CI-driven applies
- Writing a newly rotated secret into Railway, if the reason for leaving is a
  security incident there

## Checks, grouped by when they bite

Before the first apply:

| Check | Check with | Good looks like |
|---|---|---|
| The ALB decides the client IP | A test that sends a forged `x-real-ip` and a forged X-Forwarded-For prefix | The app uses only the last X-Forwarded-For entry |
| Singletons never run twice during a deploy | `tofu test` on the scheduler's deployment settings | Min healthy 0, max 100 |
| Workers finish shutting down inside Fargate's 120 second stop timeout | `tofu test` on the shutdown grace env and `stopTimeout` | The worker's force-stop deadline, measured from SIGTERM, is below `stopTimeout` |
| Smaller containers don't shrink the heap by accident | `tofu test` on `NODE_OPTIONS` or the equivalent | An explicit heap size wherever the old limit was much larger, within the headroom rule in `references/cost.md` ("Sizing a task") |
| Build-time env reached the image | Grep the built bundle for a known public value | The value appears in the bundle |
| Deploy cadence matches Railway's, if Railway used watch patterns or release windows | Unit tests on the release planner | An unrelated merge restarts no workers |
| Each task fits its service's peak | `railway-usage-replay.mjs` against the task sizes | Memory comfortably above the peak per replica (a 15-minute average across replicas, so a single replica can go higher), with the heap headroom from `references/cost.md` |
| Scaled workers scale on their load and shrink one task at a time | `tofu test` on the scaling policies | Scale-out on busy slots, target tracking scale-in disabled, a step policy of -1 |

Before traffic moves:

| Check | Check with | Good looks like |
|---|---|---|
| The new egress IPs reach every dependency | A one-off task in the service's own task definition | Every database, cache, queue and API connects |
| CI secrets were rotated along with runtime secrets | The last run of every workflow that uses a database URL or API key | All green since the rotation |
| Deploys wait for their migrations | A commit with an unapplied migration | The deploy holds, then errors after its wait |
| Migrations can't hold a lock on a busy table indefinitely | The migration runner's connection settings | A short `lock_timeout` and a retry on deadlock |
| Egress cost is known | Railway's per-service network metrics | A monthly NAT estimate written down |
| The monthly bill is known | The replay plus the stack's run rate from the AWS Pricing API | Within the budget, and a budget alarm set at it |

Before retiring Railway:

| Check | Check with | Good looks like |
|---|---|---|
| Retired services stay retired | Each retired service's deployment list an hour later, and again a day later | No active deployments |
| CI can't scale production down by accident | `node <skill-dir>/scripts/check-replica-drops.mjs` in the deploy job | A deploy that lowers a replica count or a scaling ceiling without changing the replica file fails |
| Every infrastructure change was seen against production first | A read-only `tofu plan -lock=false` and the guard, before merging (`references/aws-blueprint.md`) | Only the intended resources change |
| Main matches what is running | `tofu plan` against production | No changes |
| Nothing still calls the old platform | Per-service request counts, then the HTTP log for whatever is left | Only clients holding a stale DNS answer or an old connection |
| CI no longer needs Railway | `grep -rli railway .github/` (or your CI's config) | Every match is removed or disabled, including jobs that only read Railway's API |
| No production secrets stay on Railway | The environment's shared variable names | None left, or every one of those secrets rotated |

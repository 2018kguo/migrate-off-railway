# The AWS side: stack, tests and deploys

This file covers what to build on AWS, the settings that keep Railway's
behavior, the tests that run before every apply, how CI deploys once the move
is done, and what it costs.

## Stack

State lives in an S3 bucket with versioning and encryption. OpenTofu 1.10 and
later lock state with a file in the same bucket (`use_lockfile = true`), so
no DynamoDB table is needed.

The network is a VPC with private subnets for tasks and one NAT gateway per
availability zone. Check that each private route table points at the NAT in
its own zone, because traffic that crosses zones costs $0.01 per GB in each
direction. The NAT gateways' elastic IPs are the stack's fixed outbound
addresses, which databases and partners can allowlist. Add an S3 gateway
endpoint to the private route tables as well. It is free, and ECR serves image
layers from S3, so without it every task start downloads its image through
the NAT at $0.045 per GB.

One Application Load Balancer fronts every public service, with an ACM
certificate covering all the hostnames, one listener rule per service matched
on the host header, and a redirect from HTTP to HTTPS. Turn on deletion
protection, `drop_invalid_header_fields`, a TLS 1.3 security policy and access
logs to S3. Access logs need SSE-S3 encryption on the bucket, since the load
balancer can't write to a bucket that uses KMS.

The ECS cluster uses Fargate, plus Fargate Spot for batch work that is safe to
retry. A single typed map of services drives the task definitions, services
and target groups. Each entry corresponds to one Railway service and holds its
image, release group (see "The CI deploy workflow"), CPU and memory, working
directory, hostnames, health path, whether it runs on Spot, and a heap size
where one is needed. Replica counts live apart from it, in one variables
file (the replica file, such as `prod.tfvars`), so changing a count is a
one-line change the deploy guard can watch.

Each service reads its env from one Secrets Manager secret holding a JSON
object. The task definition maps every name listed in a committed
`env-keys.json` with a `valueFrom` of `<secret-arn>:<KEY>::`, so values never
enter git or Tofu state. A value Tofu creates itself, such as the URL of a
cache it provisions, goes in a separate secret.

A Railway Redis without a volume was a cache, and ElastiCache (Valkey) with
TLS and an auth token replaces it.

Tasks get an execution role that can pull from ECR, write logs and read
secrets under one prefix, and a task role with at least what ECS Exec needs.
CI deploys through a GitHub OIDC role whose trust policy names a GitHub
environment that only `main` can deploy to.

For visibility, turn on Container Insights, give every service a log group
with a retention period, alarm on target 5xx responses and on unhealthy
targets per target group, add an AWS Budgets alert on forecast and actual
spend, and send VPC flow logs to S3 with ten-minute aggregation so you can see
where egress goes.

## Settings that reproduce Railway's behavior

```hcl
# A scheduler must never run twice, so the old task stops first.
deployment_minimum_healthy_percent = each.key == "scheduler" ? 0 : 100
deployment_maximum_percent         = each.key == "scheduler" ? 100 : 200

# A release that crash-loops rolls itself back.
deployment_circuit_breaker {
  enable   = true
  rollback = true
}

# Only web rolls back on the web 5xx alarm; give other public services
# their own alarm if they need the same.
dynamic "alarms" {
  for_each = each.key == "web" ? [1] : []
  content {
    alarm_names = [aws_cloudwatch_metric_alarm.web_5xx.alarm_name]
    enable      = true
    rollback    = true
  }
}
```

In the container definition, `stopTimeout` can be at most 120 seconds on
Fargate, and ECS kills the container that long after sending SIGTERM. Set
the worker's own deadlines, measured from SIGTERM, below it: stop taking work
and drain until 100 seconds, then force-stop at 110. Railway only checked health during a
deploy, while an ECS container health check keeps running and replaces tasks
that fail it. A worker whose health endpoint shares an event loop with heavy
jobs will miss a few checks under load, so give workers a long tolerance (a
60 second interval with 10 retries) and a start period long enough for them
to boot. Set the heap size explicitly wherever the new container is much
smaller than the Railway replica was, because Node sizes its default heap
from the memory limit.

The ALB keeps idle connections to a target open for its idle timeout and
reuses them. If the app closes an idle keep-alive connection sooner (Node's
default is 5 seconds), a request the ALB sends down a connection the app
has just closed comes back as a 502 with no response from the target. It
shows up as a steady trickle of 502s whose access-log entries have a target
status of `-` and a response processing time of `-1`. Set the app's
keep-alive timeout above the ALB's idle timeout. When the server is built
by a framework that doesn't pass options through (Nitro's node server, for
one), a small module loaded with `node --import` can set the default on
every `http.createServer` call.

Behind the ALB, the client's IP is the last entry in X-Forwarded-For, because
the load balancer appends the address it received the connection from. Give
the app an explicit setting that says it runs behind an ALB, have it trust
only that last entry and ignore `x-real-ip`, and test it with forged headers.
If a CDN or proxy sits in front of the ALB (a proxied Cloudflare record, for
example), the last entry is that proxy's address, so trust the entry the
proxy appended instead, or the proxy's own client-IP header, and only from
the proxy's published address ranges.

## Tests that run before every apply

`tofu test` with `mock_provider "aws"` and `mock_provider "random"` plans and
applies the whole stack against fake providers in a few seconds. The AWS
provider still validated ARN-shaped arguments against mocks in our runs, so
the mocks need real-looking ARNs, and `random_password` needs a result of at
least sixteen characters, the minimum ElastiCache accepts for an auth token.
These are the mocks the original stack's tests used; add a `mock_resource`
for any other resource whose ARN another resource takes as input.

```hcl
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b", "us-east-1c"] }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/mock/1" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/mock/1/1" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/mock/1" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = { arn = "arn:aws:acm:us-east-1:123456789012:certificate/mock" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:123456789012:mock" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock-logs", id = "mock-logs" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:mock" }
  }
  # Needed once a CloudWatch alarm triggers a scaling policy.
  mock_resource "aws_appautoscaling_policy" {
    defaults = { arn = "arn:aws:autoscaling:us-east-1:123456789012:scalingPolicy:mock:resource/ecs/service/mock/mock:policyName/mock" }
  }
}

mock_provider "random" {
  mock_resource "random_password" {
    defaults = { result = "mockmockmockmockmockmockmockmock" }
  }
}
```

The tests can read the old platform's files directly, so parity checks stay
true when someone edits `railway.json`:
`jsondecode(file("../../apps/api/railway.json")).deploy.healthcheckPath`.

Guard the replica map with variable validations so that `tofu plan` itself
rejects a misspelled service name, which would otherwise run zero copies of
the intended service, and a scheduler count above one. A test proves each
guard by expecting the plan to fail:

```hcl
run "rejects_misspelled_service" {
  command = plan
  variables {
    replicas = { wroker = 2 }
  }
  expect_failures = [var.replicas]
}
```

These assertions earned their place in the original migration:

- each service runs its own release group's image tag;
- no variable name appears in both `environment` and `secrets`;
- each secret maps to the right key in the right secret;
- the certificate covers exactly the routed hostnames, and only services with
  hostnames sit behind the load balancer;
- worker memory exceeds the heap size, and worker shutdown fits inside the
  stop timeout;
- the scheduler's deployment settings never overlap two copies;
- the S3 gateway endpoint is on every private route table;
- web deploys roll back on the 5xx alarm.

Break each asserted setting once on purpose and confirm the suite fails, so
you know the assertions test something. Assert concrete values, not the
expression the resource itself uses: a test that repeats
`lookup(var.replicas, k)` passes whatever the code does.

A few HCL traps make assertions pass or fail for the wrong reason:

- `||` and `&&` don't short-circuit, so `q.id != "x" || q.metric[0].name`
  still evaluates the index on every element. Filter first:
  `[for q in queries : q.metric if q.id == "x"]`.
- Blocks the provider models as sets, such as `step_adjustment`, can't be
  indexed with `[0]`; use a `for` expression.
- A map attribute never equals an object literal: compare with
  `tomap({ ServiceName = k })`.
- A test can read the app's own source with `file()`, which keeps a metric
  name in the infrastructure and the code that emits it from drifting
  apart.

## Autoscaling in the stack

Once Application Auto Scaling owns a service's count, the stack has to stop
setting it:

- Give every service a scalable target. A fixed service gets min and max
  both equal to its count, so the replica file still sets it exactly; a
  scaled service gets a floor below its old count and that count as its
  ceiling.
- Set `lifecycle { ignore_changes = [desired_count] }` on the ECS service,
  so an apply doesn't reset what scaling chose. `desired_count` then only
  seeds a new service.
- Registering a target whose max is below the running count scales the
  service down to fit, and so does lowering max later. The replica-drop
  guard has to read scaling targets, and compare a newly created target's
  max with the service's current count.
- Validate the floor at or below the ceiling, and give the singleton
  scheduler service no scaling policy at all.

`references/cost.md` covers which signals to scale on.

## Before merging an infrastructure change

Plan it against production, read-only, with the image tags that are
deployed:

```
tofu plan -lock=false -var-file=prod.tfvars -var-file=deployed-tags.json -out=plan.out
tofu show -json plan.out > plan.json
node <skill-dir>/scripts/check-replica-drops.mjs plan.json false
```

Read every action in the plan: list every resource whose action isn't
`no-op`, and for each updated one, which attributes change. A plan
also carries every earlier merge that hasn't applied yet (deploys queue),
so look only at the resources your change owns, or plan again after the
earlier apply. A change meant to add scaling should touch only task
definitions and new resources; a state move should show `no-op` moves.
`-lock=false` keeps the read from blocking a CI apply.

## The CI deploy workflow

Railway redeploys a service only when files in its watch patterns change, and
many teams add release windows on top. Keep that behavior per release group,
a set of services that ship together, for example web and small apps on
every merge, with short windows for interactive workers and longer ones for
batch work. A release planner, a CI step that maps the changed files to the
groups whose watch patterns match, decides which groups ship. Two details make the matching correct.
Node's `path.matchesGlob` skips dotfiles where Railway's gitignore-style
patterns don't, so match `dir/**` as a prefix. Run `git diff --name-only
--no-renames` so that a file moved out of a watched directory counts there.

Give each lane its own concurrency group with `cancel-in-progress: false`.
Merges that land during a build then collapse into one pending run for the
newest commit. Serialize the apply step across all lanes with a single
concurrency group that sets `queue: max`, so a merge can't replace a pending
worker release.

Inside that lock, read the currently deployed image tags again, move a group
only to a commit that descends from the one it runs (`git merge-base
--is-ancestor`), and always apply from the newest commit on main. Plan to a
file, run `<skill-dir>/scripts/check-replica-drops.mjs` on it, then apply that saved plan.
A change under the infra directory should apply even when no image needs
building.

Tag each deployed image `deployed-<group>-<sha>`, and add an ECR lifecycle
rule for that tag pattern with a lower `rulePriority` number than the "keep
the last N" rule and a count high enough that it never triggers. ECR
evaluates rules in priority order and won't let a later rule expire an image
that an earlier rule matched, so a rarely redeployed service keeps the image
it runs. The cost is that old `deployed-*` images never expire on their own;
prune them occasionally. Also expire untagged manifests left behind by the
build cache.

Use `shell: bash` on steps that pipe. GitHub's default shell for `run` doesn't
set `pipefail`, so a failing command piped into `tee` passes. When reading
state that may not exist yet, treat only "not found" errors as empty, because
an access-denied error read as "no tags yet" ships every group.

With one apply lock that queues runs, a merge can wait behind several
earlier runs. Watch the run for your own commit (`gh run list --commit
<sha>`), not the newest one. A run dispatched seconds after re-enabling a
paused workflow can sit queued with no jobs and nothing ahead of it;
dispatch again, and check the new run starts.

After a squash merge, the image tags recorded during the migration point at
branch commits that are not ancestors of main, so the ancestry rule refuses
every update. Before the first CI deploy, replace the recorded tags with a
marker such as `bootstrap`, and have the deploy treat a recorded value that
isn't a commit in the repo (`git cat-file -e <value>^{commit}` fails) as "no
previous deploy", which allows the update.

## Cost

`references/cost.md` covers it: why copying Railway's replica counts onto
Fargate costs several times the Railway bill, how to replay Railway's usage
to choose task sizes and a capacity model, how to scale queue workers, and
what NAT, data transfer and observability add.


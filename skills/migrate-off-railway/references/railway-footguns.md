# Railway behaviors that matter when you leave

Railway CLI 5.71, October 2026. Statements marked "observed" come from
running that CLI and aren't in Railway's docs, so recheck them against the
current CLI before relying on them.

## Stopping a service

Railway has no setting for zero replicas. Observed: running `railway scale
<region>=0` on a service that ran in one region removed that region, and the
service fell back to another region and redeployed there, so a command that
looks like "turn it off" started a fresh copy somewhere else.

To stop a service you remove its deployment. `railway down` only sees a
deployment that has finished deploying; a build or deploy still in progress
survives it and starts later. The GraphQL API covers every state:
`deploymentCancel(id)` stops a build, and `deploymentRemove(id)` takes down a
running or deploying one. Loop over the service's deployments until none is
building, deploying or running. A removed deployment drains for the service's
`drainingSeconds`, so work
that is still in flight when the drain ends gets cut off. Idempotent periodic
work picks up again on its next run.

If your repo deploys to Railway from a scheduled job ("deploy main to every
service whose watched files changed"), that job sees a stopped service as
behind and redeploys it at the next window. Add a list of retired services
that the deploy script skips, with a test, before stopping anything. For
queue workers, also point the queue name in their env at a name nothing
publishes to, using `--skip-deploys` so the change itself doesn't redeploy
them. In the migration this comes from, several workers were redeployed
before the skip list reached main, and the dead queue name is the reason they
did no harm. To bring a retired service back, restore its env var, remove it
from the skip list and run `railway redeploy --from-source`.

## CLI and API details

In `railway domain`, the short flag `-p` means `--port`, not `--project`, so
run that command from a directory linked to the project. Commands that take
`--project` need `--environment` given as an ID. Observed: `railway
variables --json` returns sealed variables with a `null` value. They exist,
but nobody can read them back, so a copy has to come from another service
that holds a readable copy, or from the person who set it. A stale CLI login
shows up as "Not Authorized" from the API, and `railway whoami` refreshes it.

Log reads through the CLI and Railway's MCP server are often scoped to the
current deployment, so a service in the middle of redeploying shows no logs at
all. To find out whether something is used, query the database for its most
recent activity instead.

## Hostnames and the edge

Values that point at `*.railway.internal` only resolve inside Railway, and the
env seed should refuse to copy them. Railway-generated `*.up.railway.app`
hostnames are often pasted into third-party dashboards (bot endpoints,
inbound webhooks, OAuth redirect URIs), and each of those needs a person with
access to that dashboard to change it.

Railway's edge sets `x-real-ip` on every request. Code that trusts only that
header either stops seeing client IPs behind an AWS ALB, which passes the
header through untouched, or starts trusting whatever the client sent in it.
The edge also allows requests of about fifteen minutes, which streaming
responses may depend on; set the ALB's `idle_timeout` to match.

A custom domain on Railway needs only a CNAME, but Railway issues the
certificate after the CNAME points at it. Pointing a hostname back at Railway
during a rollback therefore takes a few minutes before HTTPS works.

## Builds

Railway runs builds with the service's variables set. A Docker build in CI
has none of them, so frontend variables that the bundler inlines at build
time (`NEXT_PUBLIC_*`, `VITE_*`) become `undefined`, and post-build steps that
check for `RAILWAY_ENVIRONMENT_ID` skip without saying so. Neither fails the
build.

A `Dockerfile` at the repository root makes Railway build every service from
it instead of using Railpack. Keep a portable Dockerfile for AWS in a
subdirectory and build it with `-f`.

## Defaults you get for free

Each Railway replica gets large CPU and memory limits and is billed for what
it uses, so memory headroom and default heap sizes in your services assume a
big container without anyone having decided that.

Railway stops the previous deployment only after the new one is active, and
`overlapSeconds` and `drainingSeconds` add time on top of that (see Railway's
deployment teardown docs). Two copies of a service therefore run briefly on
every Railway deploy, including a scheduler's, so check whether your
scheduled jobs already tolerate that before relying on it. Railway also gates
a deploy on the healthcheck without killing a running instance that later
fails it, and redeploys a service only when files in its watch patterns
changed. On ECS each of these has to be configured on purpose.

## Metrics and billing

Railway reports a service's CPU, memory and network as the sum across its
replicas. Divide by the replica count before sizing a container. Railway
charges for egress and not for traffic between its own services, whereas AWS
charges NAT processing on traffic in both directions as well as data
transfer out.

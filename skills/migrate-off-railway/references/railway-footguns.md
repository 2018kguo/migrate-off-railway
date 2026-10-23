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

The calls, as the original migration made them: run `railway whoami` to
refresh the login, take the token from `user.accessToken` in
`~/.railway/config.json`, and POST each mutation to
`https://backboard.railway.com/graphql/v2` with `Authorization: Bearer
<token>`. Read the token into a variable inside a script and never echo or
log it. For example `{"query":"mutation { deploymentRemove(id: \"<id>\") }"}`.
`railway deployment list --json -s <service> -e <environment>` gives each
deployment's `id` and `status`. Remove the ones in SUCCESS or DEPLOYING,
cancel the ones in BUILDING, QUEUED, WAITING or INITIALIZING, wait a few
seconds and list again, and fail loudly if anything is still active after a
few rounds.

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
all. Observed: `railway logs --http` printed nothing for a service whose
request log the MCP server's `get-logs` (type `http`) returned in full. For
"is anything calling this", start from per-service request counts (`railway
metrics`, or the MCP server's `http-requests`), then read the HTTP log for
whatever is left. For "does anyone use this feature", query the database for
its most recent activity.

The MCP server's `list-variables` returns values in plain text. To work with
variables without printing secrets, call `railway variables --json` from a
script that prints names only.

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
during a rollback therefore takes a few minutes before HTTPS works, and works
only while the custom domain is still attached to the Railway service. Leave
those domains attached until you give up the rollback.

## Deleting services, variables and buckets

Observed: a batch of `delete-service` calls through Railway's MCP server, sent
in parallel, each returned success, and all but one of the services were still
there afterwards. Delete one service at a time. The API's `serviceDelete(id,
environmentId)` took a minute or two per call, and some calls came back with
an empty body or "Not Authorized" and needed a retry, so judge success by
listing the environment again (`environment(id: "<id>") { serviceInstances {
edges { node { serviceName } } } }`), never by the call's response.

Passing an `environmentId` removes the service from that environment only. A
project often has a staging environment holding the same services and
deploying from the same branch, so read the inventory's list of other
environments and projects first and decide each one on purpose.

Observed: deleting every service in the production environment left its
shared variables in place, every production secret among them. Delete the shared variables once nothing on Railway reads
them, or rotate those secrets. Buckets and volumes are separate resources too.

Before deleting, search CI for Railway. Workflows that deploy to it are easy
to find, but a job that only reads Railway's API for some other purpose (in
the original migration, a reporting job that read deployment history) fails on
every run once the services are gone.

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
replicas. Divide by the replica count before sizing a container. `railway
metrics --all --network --since 7d` prints public network traffic for every
service in the environment, which is the starting point for a NAT estimate. Railway
charges for egress and not for traffic between its own services, whereas AWS
charges NAT processing on traffic in both directions as well as data
transfer out.

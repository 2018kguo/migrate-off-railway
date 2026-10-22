# Cases the main flow doesn't cover

The main flow assumes every service on Railway is stateless. This file covers
the common exceptions. The original migration didn't need them, so treat
this as a plan to verify before relying on it.

## A database or Redis with a volume on Railway

Moving data needs either a short write freeze or replication. For Postgres
under a few tens of gigabytes, a freeze is usually simpler. Stop writers by
putting the app in maintenance mode, or by removing the writing services'
deployments (Railway has no zero-replica setting; see
`railway-footguns.md`), take a `pg_dump` in custom format, restore it into RDS or another
managed Postgres with `pg_restore`, compare row counts and a few checksums
per table, point `DATABASE_URL` at the new database, and start the writers
again. Rehearse it once against a copy so you know how long the freeze lasts.

Larger databases, or apps that can't stop writing, need logical replication.
Railway's Postgres must allow it, which means `wal_level = logical` (changing
it requires a restart) and a user with the replication privilege. Copy the
schema to the target first with `pg_dump --schema-only`, because logical
replication copies rows and not DDL, and freeze schema changes until the
cutover. Every replicated table needs a primary key or a replica identity.
The target then subscribes to a publication on the source until it catches
up. Sequences aren't replicated, so at the cutover, after the last changes
arrive, set each sequence on the target past the source's value with
`setval`, then switch the URL. Check that Railway exposes the database on a
TCP proxy reachable from AWS before planning around this.

Redis that holds only cache data can start empty on ElastiCache. Redis that
holds queues, sessions or anything else you can't lose needs its keys copied
during a write freeze. ElastiCache can't load an RDB file into a running
cluster (it can only seed a new cluster from an RDB in S3 at creation), so
copying key by key with `DUMP` and `RESTORE`, or with a migration tool such
as RIOT, is usually simpler.

A Railway bucket needs its objects copied, for example with `rclone` or an
S3-compatible sync, followed by a final sync during the switch. Update every
service that holds the bucket's credentials.

## Workers that don't pull from a queue

The worker step relies on old and new workers sharing a queue. Workers that
are triggered over HTTP, or that run on a schedule inside the process, can't
share work that way. Treat an HTTP-triggered worker like a web service and
move whatever calls it, with the DNS or URL change that implies. Treat a
worker with an in-process schedule as a singleton, stopping the old copy
before starting the new one, unless its jobs are protected against running
twice.

## DNS hosted somewhere other than the provider used here

The DNS change in the runbook edits one CNAME in place through the DNS
provider's API, with a 60 second TTL, and the same call with the old value
undoes it. Cloudflare's API, Route 53's `ChangeResourceRecordSets` with an
`UPSERT` and most registrars' APIs support an in-place update. On Cloudflare,
a proxied record changes two things. The ALB then sees Cloudflare's address
as the last X-Forwarded-For entry, so the client-IP rule in
`aws-blueprint.md` needs Cloudflare's header and address ranges instead. And
Cloudflare closes requests that wait about 100 seconds for a response, which
cuts off long streams the ALB would allow. ACM's DNS validation records are
unaffected either way, since they are separate CNAMEs that aren't proxied.

## Kubernetes instead of ECS

The cutover order, the checks and the Railway behaviors apply unchanged. The
stack and its tests don't. The ECS deployment settings map to Kubernetes as
follows: a singleton is a Deployment with the `Recreate` strategy and one
replica, the worker drain is `terminationGracePeriodSeconds`, which has no
120 second cap, the health check tolerance is a liveness probe with a high
`failureThreshold`, and the client IP comes from the ingress controller's
real-IP configuration.

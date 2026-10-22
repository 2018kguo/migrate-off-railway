# Cutover runbook

Each step below says how to check it worked and how to undo it. Copy both
into the cutover log before running the step.

## 1. Bootstrap with no traffic

Apply the stack with every replica count at 0. Add the ACM validation records
to DNS early: they don't route anything, and the HTTPS listener can't exist
until the certificate is issued. If you apply everything except the
certificate validation while you wait (`tofu apply -exclude=...`), OpenTofu
1.10 didn't record root outputs on that apply in our runs, so follow it with
`tofu apply -refresh-only`.

Replacing a certificate the listener already uses needs a full apply, not a
targeted one. With `create_before_destroy`, a targeted apply creates the new
certificate and then retries deleting the old one, which the listener still
references, until the provider times out. Add the new validation record, wait
until the certificate shows `ISSUED`, and run a full apply that moves the
listener and deletes the old certificate together.

Check: `tofu plan` shows no changes, and every ECS service exists with a
desired count of 0.
Undo: `tofu destroy`. Nothing depends on the stack yet.

## 2. Seed env and build images

Run the seed as a dry run first; it should print variable names only. Supply
sealed values through an overrides file, apply, and commit `env-keys.json`.
Build images in CI, or in a one-off AWS CodeBuild project fed by `git archive
HEAD | aws s3 cp - s3://<bucket>/src.zip` if CI can't deploy before the first
merge.

Check: every image builds, and a smoke test that starts each app with no
secrets reaches the app's own env validation, which shows the image contains
every module the app imports.
Undo: nothing runs these images yet. Delete the secrets if the seed copied
the wrong service's values.

## 3. Check connectivity from the new egress path

Run a one-off ECS task in a service's own task definition, so it has the same
secrets, subnets and NAT addresses as the real service, with a command
override that connects to each dependency and exits. A Postgres `select 1`, a
Redis `PING`, a read-only call to the queue or workflow engine, an S3
`HeadBucket` and an HTTP GET to each external base URL cover most apps. Print
each dependency's name with ok or the error class, never a value. Command
overrides are limited to 8 KB.

Check: every line says ok. A failure here is usually an IP allowlist on a
managed database, cache or workflow engine, and it is much cheaper to find
now than after traffic moves.
Undo: none needed. The task exits on its own.

## 4. Shadow web

Run web on AWS with DNS still pointing at Railway, and check it without
moving anyone:
`curl --resolve app.example.com:443:<alb-ip> https://app.example.com/health`.

Check: the health endpoint reports the commit you deployed, sign-in pages
load, and the logs show no connection errors. For a signed-in test, point
your own `/etc/hosts` at the load balancer.
Undo: set web's count back to 0. No user reached it.

## 5. Start inbound-only services

A service that only acts on incoming requests, such as a webhook receiver,
does nothing until DNS or a provider's URL points at it, so it can run on AWS
before the cutover. A service with its own poller or scheduler is different.
Run two copies only if the code makes that safe (row locks such as `FOR
UPDATE SKIP LOCKED`, or dedupe keys on scheduled jobs), and otherwise keep it
at 0 until its turn.

Check: each service passes its load balancer health check.
Undo: set its count back to 0.

## 6. Move workers one queue at a time

Workers that pull jobs from a shared queue (SQS, a Redis-backed queue, a
workflow engine's task queue) can run on both platforms at once, which makes
this the gentlest step. For each queue, scale the AWS service up and confirm
it is consuming, using whatever the queue offers: active consumers, receive
counts or the engine's list of pollers. Some engines keep listing a consumer
for several minutes after it stops, so prefer a "last seen" timestamp over a
plain list. On Fargate, a task's hostname is its private IP name (`ip-10-…`),
which tells you which platform a consumer runs on.

New consumers may receive little work at first, either because the queue is
quiet or because some engines keep in-progress work on the worker that
started it. Confirm AWS is doing real work from the jobs themselves: the
worker identity recorded on recently completed jobs, or the AWS service's
logs. Then retire the Railway copy (see `railway-footguns.md`), wait for it
to drain, and watch the queue's failure rate and the AWS service's error
logs. Start with background and batch queues and move the queue behind
user-facing requests last.

Check: AWS consumers active, Railway consumers gone, failures flat.
Undo: restore the Railway service, then lower the AWS count.

## 7. Move web traffic

At least one old TTL before the switch, lower the TTL on the records you will
change to 60 seconds, and confirm with `dig` that resolvers now hand out 60.
Lowering it at switch time doesn't help, because resolvers keep the old
answer for as long as the old TTL said.

Put both stacks on the same commit, so no user sees code go backwards during
the switch. Then edit the existing record in place to point at the load
balancer. Deleting it and creating a new one leaves a gap in which lookups
return NXDOMAIN. A hostname at the zone apex can't be a CNAME, so it needs an
alias record (Route 53) or CNAME flattening (Cloudflare and others).

Check: the load balancer's request count climbs within a couple of minutes,
targets stay healthy and target 5xx stays at zero. A burst of 4xx right after
the switch is normal. Break it down by hostname, path and whether a target
answered. Scanners on the load balancer's raw address, probes for `.env`,
requests to the root of webhook-only hosts and clients holding a cached
answer account for most of it. For any path that looks like real traffic,
compare with the old platform's request log for the same path before
treating it as a regression.
Undo: the same edit with the old target, which takes effect within the 60
second TTL.

Some clients ignore TTLs and hold connections open for a long time, so keep
the old web service running, idle, until its request log goes quiet.

## 8. Move integrations

An integration reached through a hostname on your own domain moves with a
DNS change, like step 7; verify it with a real inbound event. An integration
configured with a URL in a provider's dashboard needs that URL changed, and
the provider's API is usually more reliable than its dashboard. Some
providers re-verify a changed URL with a challenge request, which is a free
end-to-end test of the new service.

While you're changing these URLs, move each integration onto a hostname on
your own domain so the next move is a DNS change. Check the name isn't
already in use for something else, such as a mail record.

Check: one real event arrives at the AWS service for each integration.
Undo: put the old URL back in the provider, or revert the DNS record.

## 9. Move the scheduler

Stop the Railway copy, wait until it has no active deployment, then start the
AWS copy, because both running at once fires every scheduled job twice.

Check: the new scheduler's logs show it enabled, pointing at the right
origin, and firing.
Undo: set the AWS scheduler's count to 0, wait until its task shows
STOPPED, remove the Railway service from the deploy skip list and run
`railway redeploy --from-source`.

## 10. Make main match production, then retire Railway

Before turning on CI-driven applies, land every replica count you set by hand
on main, because the first CI deploy applies main. Then retire the remaining
Railway services, wait a week with them stopped, and delete the services,
their domains and any buckets. Move any static cloud credentials the services
still carry to the task role.

Check: `tofu plan` on main shows no changes, and each retired Railway service
still has no active deployment a day later.
Undo: until you delete the Railway services, restore any of them with the
procedure in `railway-footguns.md` and point its traffic back.

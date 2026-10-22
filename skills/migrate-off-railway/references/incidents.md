# What went wrong, and what now prevents it

These happened, or nearly happened, during a real migration. Each section
describes the sequence of events and the guard that now prevents it.

## Migrations failed silently, then code shipped ahead of its schema

A credential rotation updated the database password in the runtime
environment but not in the CI secret that the migration job uses. The
migration job started failing authentication and nobody was alerted. Some
hours later a pull request deployed code that read a column its own
migration was supposed to add, and a core endpoint returned 500 for every
user. When the migration was then run by hand, it deadlocked against live
traffic on a `DROP TABLE ... CASCADE` and had to be retried.

Rotation checklists now include CI secrets. Deploys wait until the newest
migration in the commit being deployed appears in the live migrations table,
with an override for emergencies. The migration runner sets a short
`lock_timeout` and retries the whole run, which is a single transaction, when
it hits a deadlock (Postgres code 40P01) or a lock timeout (55P03). A failed
migration run alerts the team's channel.

While fixing it, the first question was whether the platform move had caused
the outage. Checking which platform served the failing requests (the DNS
answer, then the commit in `/health`, then that platform's request log)
answered it within a minute and kept the fix focused.

## CI turned production services off

Two services were started on ECS by hand after their Railway copies had been
retired, but the replica file on main still listed them at zero. The next CI
deploys applied main and scaled both to zero, and each was down for about ten
minutes. Pausing the deploy workflow didn't help, because one run had already
been queued before the pause.

Once CI applies the stack, replica counts change only by merging the replica
file. Pausing deploys now includes cancelling queued runs, force-cancelling
any apply that ignores the cancel, and releasing the leftover state lock once
nothing is running. The deploy job also plans to a file and runs
`scripts/check-replica-drops.mjs`, which refuses to lower a running service's
count unless the deployed commits changed the replica file.

## Deploy lanes could roll each other back

Each release lane read the other lanes' deployed image tags when it started
and applied them when it finished, so a slow run could put back an older
image that a faster run had replaced. Applying the whole stack from an older
commit also brought back older infrastructure settings. A review caught this
before it happened.

All lanes now share one apply lock that keeps every pending run in a
queue. Inside the lock, a run re-reads the deployed tags, moves a group only to
a commit that descends from the one it runs, and applies from the newest
commit on main.

## Retired services came back

`railway scale <region>=0` moved a service to another region and redeployed
it instead of stopping it. Later, the repo's scheduled Railway deploy job
redeployed several workers that had been stopped, because it saw them as
behind main.

Services are now retired through Railway's API, which cancels builds and
removes deployments, and are listed in a variable that the deploy script
skips. Retired queue workers also have their queue name pointed at a queue
nothing publishes to, which is why the redeployed ones did no work.

## A scheduler would have run twice during every deploy

An ECS rolling deploy starts the new task before stopping the old one, and
the scheduled-job service had no lock of its own, so every deploy would have
fired any job due during the overlap twice. Railway also overlaps old and new
deployments briefly, so the window existed before, but an ECS deploy that
waits on health checks makes it longer. Review caught it. The scheduler now
deploys with a
minimum healthy percent of 0 and a maximum of 100, and a test asserts it.

## The Docker build lacked the env that Railway's build had

Frontend variables inlined at build time came out undefined, which turned off
client analytics, and a post-build step that archives static assets skipped
itself because it checked for a Railway variable. Neither failed the build.
The build now receives that env as a BuildKit secret, and a check greps the
built bundle for a known public value.

## Client IPs were collapsing or spoofable behind the load balancer

The app trusted only `x-real-ip`, which Railway's edge sets and an AWS load
balancer passes through from the client. Behind the ALB, every request would
have looked like it came from no address, or from whatever the client
claimed. An explicit setting now tells the app it runs behind an ALB, it
trusts only the last X-Forwarded-For entry, and tests send forged headers.

## An image lifecycle rule could have deleted a running image

The ECR rule kept the last few hundred images in a shared repository, and one
rarely redeployed service ran an image old enough to be expired. Deployed
images now carry a `deployed-*` tag. A lifecycle rule with a lower
`rulePriority` number (which ECR evaluates first) matches that tag with a
count too high to trigger, and ECR doesn't let a later rule expire an image
an earlier rule matched.

## A third-party registration nobody could edit

An integration's provider-side registration pointed at a Railway-generated
URL, and nobody on the team could find the account that owned it, so the URL
couldn't be changed, and recreating the registration would have changed
what customers had already installed. The
inventory now lists each provider registration with its owner and whether it
can be recreated, and every integration points at a hostname on the team's
own domain.

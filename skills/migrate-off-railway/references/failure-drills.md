# Failure drills

Every failure mode below either happened in a real migration or was caught
just before it did, and the tables give a command for each check listed
in `SKILL.md`. Each one has a test you can run before the change that
could trigger it, and what a pass looks like. Run them in order of the
phase you're in. Placeholders are in angle brackets.

## Before the first apply

| Failure mode | Test | Pass |
|---|---|---|
| A misspelled service in the replica file runs zero copies of the real one | A `tofu test` run with `replicas = { <misspelled> = 1 }` and `expect_failures = [var.replicas]` | The plan is rejected |
| Two schedulers run during a deploy and fire every job twice | `tofu test` asserting min healthy 0 and max 100 on the scheduler | Asserted, and the assertion fails when you set 100/200 |
| A worker is killed mid-drain | `tofu test` that the worker's force-stop deadline is below `stopTimeout` | Asserted |
| The heap is larger than the container | `tofu test`: memory at least heap plus 2 GB for workers, heap at most 75% for the rest | Asserted for every service |
| The ALB's client IP is spoofable | `curl -H 'x-real-ip: 1.2.3.4' -H 'X-Forwarded-For: 5.6.7.8' https://<shadow-host>/<endpoint that logs the IP>` through the shadow stack | The logged IP is yours, not either forged one |
| Build-time env never reached the image | `docker run --rm <image> grep -rl '<known public value>' <bundle dir>` | At least one file |
| An image misses a module the app imports | Start each image with no secrets | It stops at the app's own env validation, not at an import error |
| An assertion tests nothing | Break each asserted setting once and rerun `tofu test` | Each break fails the suite |

## Before traffic moves

| Failure mode | Test | Pass |
|---|---|---|
| An allowlist on a database, cache or queue blocks the new egress IPs | A one-off task in each service's own task definition that connects to every dependency and prints ok or the error class | Every line says ok |
| CI still uses a rotated secret's old value | The last run of every workflow that reads a database URL or API key | All green since the rotation |
| Code ships before its migration | Push a commit whose migration hasn't run | The deploy waits, then fails |
| A migration holds a lock on a busy table | The migration runner's connection settings | A short `lock_timeout` and a retry on deadlock |
| A DNS change leaves a gap | Run the change and its undo on a hostname nobody uses | `dig` shows the new answer, then the old one, never NXDOMAIN |
| The old TTL keeps clients on the old platform | `dig +noall +answer <host>` from two resolvers, a full old TTL after lowering it | Both hand out 60 |
| Workers on the new platform poll but do no work | Recently completed jobs' worker identity, per queue | The new platform's identities appear |
| Pre-cutover poller counts are wrong | Consumers per queue on the old platform | Equal to that service's replica count |

## Scaling

| Failure mode | Test | Pass |
|---|---|---|
| Missing load data reads as idle and removes tasks | Graph the scale-in alarm's expression for a service over a period with no load data (`aws cloudwatch get-metric-data` with the same metric queries) | It reads 0 throughout; wrap the load metric in `FILL(metric, 100)` so this doesn't depend on how a gap is evaluated |
| The workers never report their load metric | `aws cloudwatch list-metrics --namespace <ns> --metric-name <slot metric>` a few minutes after the image that emits it is out | One series per scaled service |
| Target tracking removes most of a fleet at once | `tofu test` that every target tracking policy has `disable_scale_in = true` | Asserted |
| Scale-in removes more than one task | In a quiet hour, on a service running above its floor: `aws cloudwatch set-alarm-state --alarm-name <scale-in alarm> --state-value ALARM --state-reason drill`, then `aws ecs describe-services`. The removed task's jobs restart | The desired count drops by exactly one, and stays there for the cooldown |
| Scaling stops because the metric is missing | Check the "metric missing" alarm after a deploy that restarted every worker | It returns to OK within its window |
| A stale replica file scales a service down | Lower a replica count in a branch, plan, and run `check-replica-drops.mjs plan.json false` | Exit 1 |
| A new scaling target shrinks a running service | A plan that adds a target with a max below the live count, through the same guard | Exit 1 |
| An apply mixes in someone else's unapplied merge | Read-only `tofu plan -lock=false` before merging, listing every action that isn't `no-op` | Only your resources change |

## Moving egress off NAT gateways

The move in `references/cost.md` keeps the Elastic IPs and changes routes
atomically, but its riskiest moment is the first packet a task sends
through a NAT instance. An instance's own traffic (checks, package
installs, `curl` from the instance) doesn't go through forwarding, so it
proves nothing about whether tasks can get out.

Checklist before routing a zone to its instance:

- Source/destination checking is off on the instance and on its interface:
  `aws ec2 describe-instances --instance-ids <id> --query 'Reservations[0].Instances[0].SourceDestCheck'`
  and the same for the interface. With an existing interface as an
  instance's primary, the AWS provider flips the check between the two on
  alternate applies (hashicorp/terraform-provider-aws#44768). Have the
  instance turn it off for itself at boot, and keep OpenTofu from turning
  it back on (`source_dest_check` in the instance's `ignore_changes`; a
  check on the saved plan in the deploy). Run `tofu plan` twice in a row
  after the instances exist: neither should touch the check.
- `sysctl net.ipv4.ip_forward` is 1 and the MASQUERADE rule is present.
- The canary below passes.

Canary for one zone, without touching production routes:

1. Find a free block in the VPC's CIDR (or add a secondary CIDR), and
   create a small subnet there in the zone, with a route table whose
   default route points at the zone's NAT instance interface. Check that
   the NAT instance's security group and the subnet's network ACL admit
   the new block, or a failure won't mean what you think.
2. Register a minimal task definition that only runs
   `curl -s --max-time 10 https://checkip.amazonaws.com` (a small image
   such as `curlimages/curl`), and run it once in that subnet with a
   service's security group. Don't override the command of a real
   service's task definition: `run-task` can't override the entrypoint,
   so the image may start the real app and take real work.
3. Pass: it prints the instance's current public address (its temporary
   one, until the zone's Elastic IP moves onto it). Fail: a timeout means
   the instance isn't forwarding.
4. Wait for the task to stop and its network interface to be released,
   then delete the subnet, the route table and the task definition.

After switching a zone:

- Within a minute the instance shows flows from the private subnets:
  `conntrack -L | grep -c 'src=<private range>'` over SSM (from
  `conntrack-tools`, or count matching lines in `/proc/net/nf_conntrack`).
  If not, route the zone back immediately.
- Check the error rate on the services in that zone for the next few
  minutes. The load balancer's health checks don't need egress and will
  stay green while tasks can't reach their database.
- Expect connections to reset at each route change, twice per zone.
- Check the zone's outbound address, not only its route. A move that
  stopped after routing to the instance but before the Elastic IP
  attached leaves the zone on the temporary address, and a re-run that
  only checks the route reports success. `curl checkip.amazonaws.com` from
  the instance should print the zone's Elastic IP.

Afterwards: land the code that matches before any apply runs, read its
plan (it should release the temporary addresses and change nothing on the
instances or interfaces), and only then re-enable deploys.

## Leaving Railway

| Failure mode | Test | Pass |
|---|---|---|
| A stopped service comes back | Each retired service's deployment list an hour later and a day later | No active deployments |
| Parallel deletes report success but don't apply | List the environment's services after each delete | One fewer each time |
| A staging environment loses services you meant to keep | `railway-inventory.mjs` before and after; compare the other environments | Unchanged |
| Production secrets stay on Railway | The environment's shared variable names | None, or every one rotated |
| A CI job still calls Railway | `grep -rli railway .github/` | Each match removed or disabled |
| Something still calls the old service | Per-service request counts, then the HTTP log for what remains | Only clients holding a stale DNS answer or an open connection |

# What it costs, and keeping it near Railway's bill

## Why Railway is cheaper than it looks

Railway runs its own servers and packs many customers' containers onto
each one. A service's CPU and memory limits are ceilings that reserve
nothing, and the bill counts what the processes used, minute by minute.
On Railway you set a generous replica count, rely on its packing, and pay
for the average.

Fargate bills what each task reserves, whether it does anything or not. EC2
bills the instance whether or not anything runs on it. Neither shares idle
capacity with other customers. Copying Railway's replica counts onto full
size Fargate tasks reserves the peak all month. For services that sit
near idle most of the time and spike for hours a few days a month, that can
cost several times the Railway bill.

So the capacity model is a decision you make on AWS, where Railway made it
for you, and it needs the same evidence as any other sizing call.

## What is inherent, and what comes from your setup

Some of the gap comes with the platforms and applies to everyone:

- Railway bills average use on shared hosts; AWS bills what you reserve.
  Any service that idles most of the time and spikes looks cheap on
  Railway.
- Anything in an AWS private subnet that talks to the internet, another
  region or a public endpoint pays the NAT gateway's $0.045 per GB on top of
  data transfer. Railway charges only egress, at $0.05 per GB.
- Railway includes load balancing, logs and metrics; AWS bills each.

Some of it comes from choices, which you control:

- Copying Railway's replica counts. Those counts were never a sizing
  decision, because on Railway an extra idle replica costs almost nothing
  and teams set them generously. Treat each as the most a service may need,
  the ceiling scaling may reach.
- A workload's shape. Services that idle and spike for hours, or carry a
  large heap, are the worst case for reserved capacity. A steady web app
  sees a much smaller gap.
- Where dependencies live. A bucket, database or vector store outside the
  compute's region, or reached over public endpoints, sends every byte
  through NAT and across regions. Put them in the same region, reached
  through gateway endpoints or private links, and NAT carries little.
- Wanting fixed outbound IPs, which is what requires NAT at all.

AWS is cheaper per unit for memory and transfer and dearer for CPU. Fargate
memory is about $3.24 per GB-month against Railway's $10, cross-region
transfer is $0.02 per GB against Railway's $0.05 egress, but a Fargate
vCPU is about $29.55 a month against Railway's $20. Savings Plans, Spot and
Graviton have no Railway equivalent. As a rule of thumb, a memory-heavy
service whose average use is above about a third of what you reserve for
it costs less on AWS; a CPU-heavy one needs to be busier. Getting a bursty app
near Railway's bill means making AWS behave like Railway: counts that
follow the load, no per-GB NAT, dependencies in one region, and discounts.

## Size from Railway's history

The first day on the new stack is a poor sample. A quiet day can show
workers using a small fraction of what they will need when a large job
arrives, and spikes often hit every replica at once and last hours. Size
from the old platform's longest history.

`scripts/railway-usage-replay.mjs` reads 30 days of each service's memory
and CPU from Railway's metrics API (read-only), in 15-minute samples:

```
railway whoami
node <skill-dir>/scripts/railway-usage-replay.mjs production --days 30 > replay.md
```

Railway reports each service's memory and CPU summed across its replicas,
so the report divides by the replica count. It shows, per service:

- the median and peak, and the peak per replica, which sets the task size
  (the script adds 25% and picks the cheapest valid Fargate size);
- what the service cost on Railway (usage, without egress);
- a month as a fixed Fargate fleet at Railway's replica counts;
- a month as Fargate tasks whose count follows the load, between 1 and
  Railway's count, on x86 and on arm64.

It also shows how bursty the whole environment is, and what an EC2 pool
sized for its p99.9 would cost. Railway's metrics for a deleted service
stay readable for a while, but run the replay before retiring anything.

Read it in this order. A service whose peak is close to its median is
steady: fix its count and size it. A service whose peak is several times
its median for hours at a time is bursty: let its task count follow the
load. When most of the environment's memory is steady, an EC2 pool can
undercut Fargate; when the bursts dominate, it can't, because the pool has
to hold the burst all month too.

The replay assumes added tasks share the load, which holds for queue
workers and stateless web. Railway's memory is summed over its replicas,
and each replica carries an idle baseline (a runtime's own heap, often
around 1 GB), so the replay takes each service's quietest memory per
replica as its baseline and sizes tasks from the work above it. Without
that, an 8-replica service is charged for 8 idle baselines and the scaled
estimate comes out well above what a single task needs. It doesn't model
how fast scaling reacts, and holds a task for 30 minutes after the load
that needed it, like a cautious scale-in policy.

## Choosing the capacity model

| | Fixed Fargate | Fargate that scales with load | ECS on EC2 |
|---|---|---|---|
| You pay for | every task, always | tasks while they run | instances, always |
| Fits | small, steady services | bursty workers, web | large, steady fleets |
| Bursts | must be reserved all month | add tasks for the burst | must fit in the pool, or wait for an instance |
| A spike in one task | can't touch another | can't touch another | can exhaust a shared host and kill its neighbours |
| You run | nothing | scaling policies and their signal | AMIs, patching, capacity scaling, ENI limits |
| Discounts | Compute Savings Plan, Spot, arm64 | same | Savings Plans, Spot, Reserved, arm64 |

Mixing them is normal: steady services on a fixed count, bursty ones
scaled, and EC2 only when the replay shows a steady base large enough that
the pool undercuts Fargate by more than the operating work costs you.

## Working out both bills

Compare like with like: a month of Railway's actual usage against a month
of the AWS design at its expected counts, both before credits.

Railway:

- The GraphQL `usage` query, grouped by `PROJECT_ID`, returns a period's
  `CPU_USAGE` (vCPU-minutes), `MEMORY_USAGE_GB` (GB-minutes),
  `NETWORK_TX_GB` and `DISK_USAGE_GB` per project. Multiply by the list
  prices ($20 per vCPU-month, $10 per GB-month, $0.05 per GB of egress and
  $0.15 per GB-month of volume in October 2026), then check against an
  invoice. Egress is billed separately and is the line AWS usually charges
  less for, unless NAT gateways carry it.
- Average memory, not peak, is what Railway charged for, which is why a
  service with rare large spikes was cheap there.
- Railway's API sits behind an edge that refused requests with a scripting
  language's default user agent (HTTP 403) and accepted curl's.

AWS:

- The run rate of a running stack is each service's desired count times
  its task size, priced from the AWS Pricing API
  (`aws pricing get-products --service-code AmazonECS` with a `usagetype`
  filter such as `USE1-Fargate-vCPU-Hours:perCPU` or
  `USE1-Fargate-ARM-GB-Hours`). This works on day one, before any bill.
- Cost Explorer lags about a day, so a stack started yesterday isn't in it
  yet. If credits cover the account, the net cost reads $0: filter
  `RECORD_TYPE` to `Usage` to see the cost before credits.
- The same account may carry resources unrelated to the move, so group by
  service and look at what the migration created.

Reading usage on ECS:

- Read Container Insights' service-level `MemoryUtilized` and
  `CpuUtilized` with the `Average` statistic as a per-task figure, and
  multiply by the task count for the service's total. Check which
  statistic a dashboard uses before comparing it with Railway's sums.
- NAT gateway traffic is the sum of `BytesInFromSource` and
  `BytesInFromDestination`, the two directions NAT processing bills. One
  minute periods allow at most 1440 datapoints per request.

## Sizing a task

- Fargate only accepts certain CPU and memory pairs (1 vCPU allows 2-8 GB,
  2 vCPU 4-16 GB, 4 vCPU 8-30 GB), so a memory-heavy task forces a CPU
  minimum. `railway-usage-replay.mjs` picks the cheapest valid pair.
- Set memory from the peak per replica plus headroom, and set the runtime's
  heap explicitly below it: for workers, memory at least the heap plus 2 GB
  for buffers and child processes; for everything else, a heap of at most
  75% of memory. Assert both in `tofu test`. A heap flag baked into the
  image (`ENV NODE_OPTIONS=--max-old-space-size=...`) is overridden by the
  same variable in the task definition, so when a task shrinks, lower the
  heap with it.
- A Node process uses one core for JavaScript. Extra vCPUs help garbage
  collection, worker threads and child processes, so check the CPU peak
  per replica before cutting CPU, not just memory.
- Debugging thresholds copied from the old platform, such as a heap
  snapshot trigger at an RSS above the new task's memory, never fire.

## Scaling queue workers

Workers that pull from a queue need different signals from web services.

- Scale on how full the worker's slots are. Workers that wait on slow
  network calls can have every slot busy with idle CPU and memory, so CPU
  and memory tracking never scales them out. Have each worker publish its
  busy-slot share as a metric. On ECS the cheapest way is CloudWatch's
  Embedded Metric Format: one JSON line on stdout, which the awslogs driver
  already ships and CloudWatch turns into a metric, with no SDK or IAM. A
  process that polls several queues should report its fullest queue, not
  the sum.
- Add tasks fast and remove them slowly. Target tracking scales in
  proportionally, so a service at 8 tasks and 10% load drops to 2 in one
  step and restarts every in-flight job at once. Disable scale-in on the
  target tracking policies and add a step policy that removes one task at
  a time after a quiet half hour.
- Don't scale on memory. Node and other garbage-collected runtimes keep
  their heap after a spike, which pins a service at its maximum or makes
  it flap. Use memory to size the task, and CPU only as a second scale-out
  signal. If CPU can scale out, make the scale-in condition require low
  CPU too, or a few CPU-heavy jobs make it flap.
- Treat missing data as "do nothing", and alarm on it separately: a
  worker that stops reporting can't scale in, and you want to know. In a
  metric-math scale-in alarm, wrap the load metric in `FILL(metric, 100)`
  so a gap reads as fully busy, for example
  `IF(FILL(slots, 100) < 20 AND cpu < 30, 1, 0)`. Without it the result
  depends on how CloudWatch evaluates a gap inside the expression, which
  is easy to get wrong in review; graph the expression over a period with
  no load data to check.
- A step policy fires again every minute while its alarm stays in ALARM;
  its cooldown is what spaces the removals.
- With release windows, the stack can apply the scaling policies before
  the workers run the image that emits their metric. Until then the
  "missing metric" alarm fires and the services sit at their ceiling.
  Ship the image first, or expect that gap until the next worker release.
- ECS moves tasks between availability zones to keep them balanced, and
  each move restarts a task's in-flight jobs, as a scale-in does. For
  workers with long jobs, consider `availability_zone_rebalancing =
  "DISABLED"` on the service.
- Keep a floor above 1 for queues people wait on. Going from 1 to 8 tasks
  takes several scaling steps, about 20 minutes.
- Removing a task restarts its in-flight jobs, as every deploy does.
  Before relying on scale-in, check those jobs tolerate a restart.
- The deploy guard against stale replica files (`check-replica-drops.mjs`)
  has to cover the scaling targets: once autoscaling owns the count, a
  stale file shows up as a lower maximum, not a lower desired count.

## A recipe for ECS on EC2

Not run in the original migration; verify each step.

- A launch template on the ECS-optimized Amazon Linux 2023 AMI, read from
  the SSM parameter
  `/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id`
  (or the `arm64` path), with `ECS_CLUSTER` and
  `ECS_ENABLE_SPOT_INSTANCE_DRAINING=true` in `/etc/ecs/ecs.config`, and an
  instance profile with `AmazonEC2ContainerServiceforEC2Role`.
- An Auto Scaling group across the private subnets, with managed
  termination protection, wrapped in an ECS capacity provider with managed
  scaling at a target capacity of 90-100%. Tasks then choose that capacity
  provider in their strategy.
- Networking: `awsvpc` gives each task its own ENI, and an instance holds
  only a few (3 tasks on an `xlarge`) unless you turn on ENI trunking
  (`awsvpcTrunking` account setting, supported instance types only).
  `bridge` mode avoids the limit but needs `instance` target groups behind
  the load balancer.
- Memory: a container's `memoryReservation` is what placement counts and
  `memory` is its hard limit. Packing on reservations is the saving and
  the risk: when correlated spikes exceed the instance, the kernel kills
  containers. Keep `memory` above the heap the app is allowed, and size the
  pool from the replay's p99.9, not its median.
- Placement: `binpack` on memory to fill instances before starting new
  ones; spread the singleton and web across availability zones.
- Operations: replace instances with an instance refresh when the AMI
  updates, and alarm on the capacity provider's reservation staying at
  100%, which means tasks are waiting for an instance.

## Costs beyond compute

- **NAT gateways** cost about $32 a month each plus $0.045 per GB
  processed in both directions, including traffic to other AWS regions and
  to public endpoints of services in the same region. Measure the flows
  before choosing a fix. Turn on VPC flow logs to S3, keep the records for
  the NAT gateways' network interfaces, and match each remote address
  against AWS's published ranges (`https://ip-ranges.amazonaws.com/ip-ranges.json`,
  most specific prefix first). That splits the bytes into same-region AWS
  services, other AWS regions (a bucket or vector store left elsewhere) and
  the internet, and shows which fix pays: an endpoint, a move to one
  region, or a cheaper NAT.

  A NAT instance per availability zone (a Graviton instance with
  source/destination checks off) has no per-GB charge, but it is a single
  point of failure for its zone where a gateway is redundant within it.
  Size it on baseline network bandwidth and packets per second, because a
  small instance's baseline is a fraction of the "up to" figure and of a
  gateway's. Average throughput is a poor guide: traffic arrives in
  bursts, and a burstable instance can drop packets at its allowances while
  its average sits far below its baseline. A network-optimized type (such
  as c7gn.medium, with a baseline about twelve times a t4g.medium's) is the
  usual choice. After moving a zone, read the ENA counters
  (`ethtool -S`: `bw_in_allowance_exceeded`, `bw_out_allowance_exceeded`,
  `pps_allowance_exceeded`) twice a minute apart; if they rise, the
  instance is too small. To resize without an outage, route the zone
  through another zone's NAT instance, stop the instance, change its type,
  start it, check it forwards, and route the zone back; the interface,
  Elastic IP and saved iptables rules carry over a stop and start. Give each zone a network interface of its
  own, created before the instance, so a replaced instance keeps the
  zone's route and address, with a security group that admits all traffic
  from the VPC's private subnets. On
  Amazon Linux 2023, set it up so it survives a reboot and stays patched:
  load `nf_conntrack` from `/etc/modules-load.d/` (or the conntrack sysctl
  resets), write `latest` to `/etc/dnf/vars/releasever` (or
  `dnf-automatic` never sees an update), and save the iptables rules.
  Install `conntrack-tools` (not there by default) so you can see the
  flows. Alarm on failed status checks (recover and reboot actions), on an
  instance that forwards almost nothing, and on a rise in each of ENA's
  allowance counters (`conntrack_allowance_exceeded`,
  `bw_in_allowance_exceeded`, `bw_out_allowance_exceeded`,
  `pps_allowance_exceeded`), published from `ethtool -S` every minute,
  which is how EC2 reports dropping flows or packets at the instance's
  limits.

  Two failures pass every health check. With an existing interface as an
  instance's primary, the AWS provider flips source/destination checking
  between the instance and the interface on alternate applies
  (hashicorp/terraform-provider-aws#44768), and whenever it is on, EC2
  drops every forwarded packet. Put `source_dest_check` in the instance's
  `ignore_changes`, have the instance turn the check off for itself at
  boot, and refuse any plan that turns it on. `references/failure-drills.md`
  has the checklist and a canary that proves forwarding first, and
  `references/incidents.md` the story. And the instance needs internet at
  boot while the zone's Elastic IP is still on the gateway, so it starts
  with a temporary address: delete that address and its association in
  code before any apply runs after the move, or the apply re-attaches it
  and pushes the allowlisted address off the interface.

  If anything allowlists your egress IPs, move the existing Elastic IPs to
  the instances one zone at a time: point that zone's route at another
  zone's NAT, delete the zone's gateway and wait until it reports
  `deleted` (`aws ec2 wait nat-gateway-deleted`), attach its Elastic IP to
  the instance's interface, and point the route at the instance. Each route
  change is atomic, but connections through the zone reset at both. Pause
  CI applies for the whole move and until the code matches: an apply in
  between would bring the gateway and the temporary address back. If the
  VPC module created the gateways, move them out with one `moved` block per
  index (`module.vpc.aws_nat_gateway.this[0]` and so on); OpenTofu refuses
  a whole-resource move while the module still declares the resource, even
  with a count of 0.
- **Data transfer** between regions costs about $0.02 per GB, on every read
  and write. Keep the app's bucket, database, cache, queue and vector store
  in the compute's region. `aws s3api get-bucket-location` shows a bucket's
  region, and the daily `BucketSizeBytes` and `NumberOfObjects` metrics,
  read in that region, size a move. A bucket can't change region: moving
  one means a new bucket with the old one's settings (CORS, lifecycle,
  policy, encryption), replication of the existing objects, and switching
  the app once replication has caught up, reading from the old bucket when
  an object isn't found yet. Saved absolute URLs that name the old bucket's
  host must keep working. S3's gateway endpoint makes same-region bucket
  traffic free and keeps it out of NAT.
- **Public IPv4** addresses cost $0.005 an hour each, including the load
  balancer's and every Elastic IP.
- **Observability**: Container Insights and log ingestion bill per metric
  and per GB. Railway's logs and metrics were included.
- **Managed caches** have a minimum node size; a cache Railway ran in a
  small container may cost more as ElastiCache.

## Discounts

- **arm64 (Graviton)** is about 20% cheaper on Fargate and EC2. It needs
  arm64 images, so check that every base image and native dependency has
  an arm64 build, and move one service at a time.
- **A Compute Savings Plan** takes roughly 20% (one year, no upfront) off
  Fargate, EC2 and Lambda in exchange for a committed hourly spend. Commit
  to the floor the replay shows, after a month on the final design.
- **Spot** (Fargate Spot or EC2 Spot) is about 70% off for work that can
  be interrupted with two minutes' notice, such as retryable batch jobs.
- **Credits**: startup programs such as AWS Activate offer credits; check
  the balance before treating a month's bill as the steady state.
- Set a budget alarm at the expected bill, so a regression shows up within
  days.

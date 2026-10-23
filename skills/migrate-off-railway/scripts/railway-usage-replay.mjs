#!/usr/bin/env node
// Replays a Railway environment's real usage through AWS designs and prices
// each one. Read-only: it reads `railway status --json` and Railway's metrics
// API, and prints a Markdown report. Nothing is created or changed.
//
// Run it from a directory linked to the project (`railway link`), after
// `railway whoami` (which refreshes the CLI login it reads the token from):
//
//   node railway-usage-replay.mjs [environment-name] [--days 30] [--floor <service>=<n> ...] > replay.md
//
// --floor keeps at least n tasks of a scaled service (default 1), for queues
// people wait on.
//
// Railway reports each service's memory and CPU summed across its replicas,
// sampled here every 15 minutes. From that the report shows each service's
// peak per replica, how bursty the whole environment is, and what a month
// would cost as (a) a fixed Fargate fleet at Railway's replica counts,
// (b) Fargate tasks whose count follows the load, and (c) an EC2 pool.
// Prices are list prices for us-east-1 in October 2026; edit PRICES for your
// region or a later date. Tested with Railway CLI 5.71.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PRICES = {
  railway: { vcpuMonth: 20, gbMonth: 10 }, // usage, per month of use
  fargate: { vcpuHour: 0.04048, gbHour: 0.004445 }, // x86 on-demand
  fargateArm: { vcpuHour: 0.03238, gbHour: 0.00356 },
  ec2: { name: "r7i.xlarge", usableGb: 30.5, hour: 0.2646 }, // 4 vCPU, 32 GB
  ec2Arm: { name: "r7g.xlarge", usableGb: 30.5, hour: 0.2142 },
};
const HOURS_PER_MONTH = 730;
const SAMPLE_SECONDS = 900;

// Fargate's valid task sizes: memory (MB) allowed for each CPU (units).
const FARGATE_SIZES = [
  [256, [512, 1024, 2048]],
  [512, [1024, 2048, 3072, 4096]],
  [1024, range(2048, 8192, 1024)],
  [2048, range(4096, 16384, 1024)],
  [4096, range(8192, 30720, 1024)],
  [8192, range(16384, 61440, 4096)],
  [16384, range(32768, 122880, 8192)],
];
function range(from, to, step) {
  const out = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
}

// The cheapest valid Fargate size with at least `gb` memory and `vcpu` CPU.
export function fargateSize(gb, vcpu, prices = PRICES.fargate) {
  let best = null;
  for (const [cpu, mems] of FARGATE_SIZES) {
    if (cpu / 1024 < vcpu) continue;
    const mem = mems.find((m) => m / 1024 >= gb);
    if (mem === undefined) continue;
    const hour = (cpu / 1024) * prices.vcpuHour + (mem / 1024) * prices.gbHour;
    if (!best || hour < best.hour) best = { vcpu: cpu / 1024, gb: mem / 1024, hour };
  }
  if (!best) throw new Error(`No Fargate size has ${gb} GB and ${vcpu} vCPU.`);
  return best;
}

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

// Task count over time for a service that scales with load: enough tasks
// that each stays under half its memory and 60% of its CPU, between 1 and
// Railway's replica count, removing a task only after `holdSamples` below
// the need. Railway's memory is summed over its replicas, each of which
// carries an idle baseline (a runtime's own heap); one task here carries one
// baseline, so tasks are sized from the work above it, or an 8-replica
// service would be charged for 8 idle baselines. Assumes added tasks share
// the load, which holds for queue workers and stateless web.
export function scaledTaskHours(series, size, maxReplicas, { baseGb = 1, memTarget = 0.5, cpuTarget = 0.6, holdSamples = 2, floor = 1 } = {}) {
  const replicas = Math.max(maxReplicas, 1);
  const need = series.map(({ mem, cpu }) => {
    const work = Math.max(0, mem - replicas * baseGb);
    return Math.min(
      Math.max(replicas, floor),
      Math.max(floor, Math.ceil(work / Math.max(size.gb * memTarget - baseGb, 0.5)), Math.ceil(cpu / (size.vcpu * cpuTarget)))
    );
  });
  const held = need.map((_, i) => Math.max(...need.slice(Math.max(0, i - holdSamples), i + 1)));
  return held.reduce((sum, n) => sum + n, 0) * (SAMPLE_SECONDS / 3600);
}

// Turns raw per-service series into the report's numbers.
export function analyze(services, { prices = PRICES } = {}) {
  const rows = services.map((s) => {
    const mem = s.series.map((p) => p.mem);
    const cpu = s.series.map((p) => p.cpu);
    const replicas = Math.max(s.replicas, 1);
    const perReplica = {
      memMax: Math.max(0, ...mem) / replicas,
      memP99: percentile(mem, 0.99) / replicas,
      cpuMax: Math.max(0, ...cpu) / replicas,
    };
    // Size a task for the service's worst 15 minutes per replica, plus 25%.
    // That peak is a 15-minute average divided across replicas: a single
    // replica, or a spike shorter than a sample, can go higher, so leave
    // headroom beyond it for memory the app can't do without.
    const want = { gb: Math.max(0.5, perReplica.memMax * 1.25), vcpu: Math.max(0.25, perReplica.cpuMax * 1.25) };
    const size = fargateSize(want.gb, want.vcpu, prices.fargate);
    const sizeArm = fargateSize(want.gb, want.vcpu, prices.fargateArm);
    const hours = s.series.length * (SAMPLE_SECONDS / 3600);
    const scale = HOURS_PER_MONTH / Math.max(hours, 1);
    // Each replica's idle baseline: its quietest memory (5th percentile),
    // divided by today's replica count. If the count changed during the
    // window, this is off by that ratio.
    const baseGb = percentile(mem, 0.05) / replicas;
    const taskHours = scaledTaskHours(s.series, size, s.replicas, { baseGb, floor: s.floor ?? 1 });
    return {
      service: s.service,
      replicas: s.replicas,
      memP50: percentile(mem, 0.5),
      memMax: Math.max(0, ...mem),
      cpuP50: percentile(cpu, 0.5),
      cpuMax: Math.max(0, ...cpu),
      perReplica,
      size,
      railwayMonth: mean(mem) * prices.railway.gbMonth + mean(cpu) * prices.railway.vcpuMonth,
      fixedMonth: s.replicas * size.hour * HOURS_PER_MONTH,
      scaledMonth: taskHours * size.hour * scale,
      scaledArmMonth: taskHours * sizeArm.hour * scale,
    };
  });
  const timestamps = [...new Set(services.flatMap((s) => s.series.map((p) => p.ts)))].sort((a, b) => a - b);
  const byTs = new Map(timestamps.map((t) => [t, 0]));
  for (const s of services) for (const p of s.series) byTs.set(p.ts, byTs.get(p.ts) + p.mem);
  const fleet = [...byTs.values()];
  const fleetP999 = percentile(fleet, 0.999);
  const pool = (ec2) => Math.ceil((fleetP999 * 1.3) / ec2.usableGb);
  return {
    rows,
    days: (timestamps.length * SAMPLE_SECONDS) / 86400,
    fleet: {
      p50: percentile(fleet, 0.5),
      p90: percentile(fleet, 0.9),
      p99: percentile(fleet, 0.99),
      max: Math.max(0, ...fleet),
      hoursOver2xMedian: (fleet.filter((v) => v > 2 * percentile(fleet, 0.5)).length * SAMPLE_SECONDS) / 3600,
    },
    ec2: [prices.ec2, prices.ec2Arm].map((ec2) => ({
      name: ec2.name,
      instances: pool(ec2),
      month: pool(ec2) * ec2.hour * HOURS_PER_MONTH,
    })),
  };
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const usd = (v) => `$${Math.round(v).toLocaleString("en-US")}`;
const gb = (v) => `${v.toFixed(1)} GB`;

export function toMarkdown(report, environment) {
  const sum = (key) => report.rows.reduce((total, r) => total + r[key], 0);
  return `${[
    `# Usage replay: ${environment}, last ${Math.round(report.days)} days`,
    "",
    "Railway sums memory and CPU across replicas; the per-replica columns divide by the replica count.",
    "",
    "| service | replicas | memory p50 / max | per replica max | CPU p50 / max (vCPU) | task size | Railway (usage) | fixed Fargate | scaled Fargate | scaled arm64 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...report.rows.map((r) =>
      `| ${r.service} | ${r.replicas} | ${gb(r.memP50)} / ${gb(r.memMax)} | ${gb(r.perReplica.memMax)} | ${r.cpuP50.toFixed(2)} / ${r.cpuMax.toFixed(2)} | ${r.size.vcpu} vCPU / ${r.size.gb} GB | ${usd(r.railwayMonth)} | ${usd(r.fixedMonth)} | ${usd(r.scaledMonth)} | ${usd(r.scaledArmMonth)} |`
    ),
    `| **total** | | | | | | **${usd(sum("railwayMonth"))}** | **${usd(sum("fixedMonth"))}** | **${usd(sum("scaledMonth"))}** | **${usd(sum("scaledArmMonth"))}** |`,
    "",
    "## How bursty the environment is",
    "",
    `All services together: ${gb(report.fleet.p50)} median, ${gb(report.fleet.p90)} p90, ${gb(report.fleet.p99)} p99, ${gb(report.fleet.max)} peak. ${Math.round(report.fleet.hoursOver2xMedian)} hours above twice the median.`,
    "",
    "A peak far above the median that lasts hours is the case where a fixed fleet pays for the peak all month, and where tasks that follow the load (or Railway's usage billing) cost much less.",
    "",
    "## An EC2 pool instead",
    "",
    ...report.ec2.map((e) => `- ${e.instances}× ${e.name}, sized for the p99.9 total plus 30%: ${usd(e.month)}/month, before EBS. Tasks share the instances' memory, so a burst that hits every service at once can exhaust it.`),
    "",
    "The pool is sized on memory only. It ignores CPU, and with `awsvpc` networking an xlarge instance runs only about 3 tasks unless ENI trunking is on, so treat it as a lower bound.",
    "",
    "Compute only. Add NAT, data transfer, load balancer, logs and caches (see references/cost.md). Railway's column omits egress, which it bills at $0.05/GB.",
  ].join("\n")}\n`;
}

// --- live run

function railwayToken() {
  if (process.env.RAILWAY_API_TOKEN) return process.env.RAILWAY_API_TOKEN;
  const user = JSON.parse(readFileSync(join(homedir(), ".railway", "config.json"), "utf8")).user ?? {};
  const token = user.accessToken ?? user.token;
  if (!token) throw new Error("No Railway login found. Run `railway login` (or set RAILWAY_API_TOKEN).");
  return token;
}

async function metrics(token, environmentId, serviceId, start, end) {
  const query = `query($e:String!,$s:String!,$a:DateTime!,$b:DateTime!){metrics(environmentId:$e,serviceId:$s,startDate:$a,endDate:$b,sampleRateSeconds:${SAMPLE_SECONDS},measurements:[MEMORY_USAGE_GB,CPU_USAGE]){measurement values{ts value}}}`;
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    // Railway's edge has refused some HTTP clients' default user agents.
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "railway-usage-replay" },
    body: JSON.stringify({ query, variables: { e: environmentId, s: serviceId, a: start.toISOString(), b: end.toISOString() } }),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Railway metrics for service ${serviceId}: HTTP ${response.status}, not JSON (an edge block or outage). Try again, or check the user agent.`);
  }
  if (!response.ok || body.errors || !Array.isArray(body.data?.metrics)) {
    throw new Error(`Railway metrics for service ${serviceId} failed: HTTP ${response.status} ${body.errors?.[0]?.message ?? "no metrics in the response"}`);
  }
  const by = Object.fromEntries(body.data.metrics.map((m) => [m.measurement, new Map(m.values.map((v) => [v.ts, v.value]))]));
  const ts = [...new Set([...(by.MEMORY_USAGE_GB?.keys() ?? []), ...(by.CPU_USAGE?.keys() ?? [])])].sort((a, b) => a - b);
  return ts.map((t) => ({ ts: t, mem: by.MEMORY_USAGE_GB?.get(t) ?? 0, cpu: by.CPU_USAGE?.get(t) ?? 0 }));
}

function replicasOf(instance) {
  const deploy = (instance.activeDeployments?.[0] ?? instance.latestDeployment)?.meta?.serviceManifest?.deploy ?? {};
  const regions = Object.values(deploy.multiRegionConfig ?? {});
  if (regions.length > 0) return regions.reduce((n, r) => n + (r?.numReplicas ?? 1), 0);
  return deploy.numReplicas ?? instance.numReplicas ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const daysAt = args.indexOf("--days");
  const days = daysAt >= 0 ? Number(args[daysAt + 1]) : 30;
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("--days must be a whole number from 1 to 90.");
  const floors = new Map(
    args.flatMap((a, i) => (args[i - 1] === "--floor" ? [a.split("=")] : [])).map(([name, n]) => {
      if (!name || !Number.isInteger(Number(n)) || Number(n) < 1) throw new Error(`--floor takes <service>=<n>, got "${name}=${n}".`);
      return [name, Number(n)];
    })
  );
  const environmentName = args.find((a, i) => !a.startsWith("--") && !["--days", "--floor"].includes(args[i - 1])) ?? "production";
  const status = JSON.parse(execFileSync("railway", ["status", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const environment = status.environments?.edges?.map((e) => e.node).find((e) => e.name === environmentName);
  if (!environment) throw new Error(`No environment named "${environmentName}" in project ${status.name}.`);
  const names = new Map((status.services?.edges ?? []).map((e) => [e.node.id, e.node.name]));
  const token = railwayToken();
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400 * 1000);
  const services = [];
  for (const instance of environment.serviceInstances.edges.map((e) => e.node)) {
    const service = names.get(instance.serviceId) ?? instance.serviceName ?? instance.serviceId;
    services.push({
      service,
      floor: floors.get(service) ?? 1,
      replicas: replicasOf(instance),
      series: await metrics(token, environment.id, instance.serviceId, start, end),
    });
  }
  process.stdout.write(toMarkdown(analyze(services.filter((s) => s.series.length > 0)), `${status.name} / ${environmentName}`));
}

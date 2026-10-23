#!/usr/bin/env node
// Read-only inventory of one Railway environment, written as Markdown.
//
// Run it from a directory linked to the project (`railway link`):
//
//   node railway-inventory.mjs [environment-name] > inventory.md
//
// It calls `railway status --json` and `railway list --json` once each and
// `railway variables --json` once per service, and prints variable NAMES
// only, never values. Nothing is
// created, changed or deployed. Tested with Railway CLI 5.71 (Oct 2026); if a
// newer CLI changes these JSON shapes, the script fails loudly rather than
// guessing.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PLATFORM_PREFIXES = ["RAILWAY_", "RAILPACK_", "NIXPACKS_"];

// Railway's CLI JSON isn't a documented contract, so a missing field fails
// the run instead of producing a table that looks complete but isn't.
function expect(condition, what) {
  if (!condition) {
    throw new Error(`Unexpected Railway CLI output: ${what}. Check the CLI version (tested with 5.71).`);
  }
}

const nodes = (connection, what) => {
  expect(Array.isArray(connection?.edges), `${what} has no edges list`);
  return connection.edges.map((edge) => edge.node);
};

// One row per service instance, from the deployment's own manifest, since
// that is what Railway actually runs.
export function describeService(instance, serviceName, variables) {
  expect(variables && typeof variables === "object" && !Array.isArray(variables), `variables for ${serviceName} are not a JSON object`);
  const deployment = instance.activeDeployments?.[0] ?? instance.latestDeployment;
  if (deployment) {
    expect(deployment.meta?.serviceManifest, `deployment of ${serviceName} has no meta.serviceManifest`);
  }
  const manifest = deployment?.meta?.serviceManifest ?? {};
  const deploy = manifest.deploy ?? {};
  const build = manifest.build ?? {};
  const regions = Object.entries(deploy.multiRegionConfig ?? {}).map(
    ([region, config]) => `${region}×${config?.numReplicas ?? "?"}`
  );
  const names = Object.keys(variables ?? {}).filter(
    (name) => !PLATFORM_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
  const valueOf = (name) => variables[name];
  return {
    service: serviceName,
    status: deployment ? (deployment.deploymentStopped ? "stopped" : deployment.status ?? "unknown") : "never deployed",
    regions: regions.length > 0 ? regions : deploy.region ? [`${deploy.region}×${deploy.numReplicas ?? 1}`] : [],
    startCommand: deploy.startCommand ?? null,
    healthcheck: deploy.healthcheckPath
      ? `${deploy.healthcheckPath} (${deploy.healthcheckTimeout ?? "default"}s)`
      : null,
    drainingSeconds: deploy.drainingSeconds ?? null,
    overlapSeconds: deploy.overlapSeconds ?? null,
    cronSchedule: deploy.cronSchedule ?? instance.cronSchedule ?? null,
    restartPolicy: deploy.restartPolicyType ?? null,
    builder: build.builder ?? null,
    watchPatterns: build.watchPatterns?.length ?? 0,
    volumeMounts: (deployment?.meta?.volumeMounts ?? []).map((m) => m.mountPath ?? m),
    customDomains: (instance.domains?.customDomains ?? []).map((d) => d.domain),
    railwayDomains: (instance.domains?.serviceDomains ?? []).map((d) => d.domain),
    variableCount: names.length,
    sealed: names.filter((name) => valueOf(name) === null),
    privateHostRefs: names.filter((name) => String(valueOf(name) ?? "").includes(".railway.internal")),
    railwayDomainRefs: names.filter((name) => String(valueOf(name) ?? "").includes(".up.railway.app")),
  };
}

// `projects` is `railway list --json`. Other environments and projects get one
// line each: a staging environment deploying from the same branch, or a
// project nobody remembers, is easy to miss when the time comes to delete.
export function inventory(status, environmentName, variablesFor, projects) {
  expect(Array.isArray(projects), "project list is not an array");
  const environments = nodes(status.environments, "environments");
  const environment = environments.find((env) => env.name === environmentName);
  if (!environment) {
    throw new Error(`No environment named "${environmentName}" in project ${status.name}.`);
  }
  const serviceNames = new Map(nodes(status.services, "services").map((s) => [s.id, s.name]));
  const nameOf = (instance) => {
    const name = serviceNames.get(instance.serviceId) ?? instance.serviceName ?? instance.serviceId;
    expect(name, "a service instance has no id or name");
    return name;
  };
  const services = nodes(environment.serviceInstances, "serviceInstances").map((instance) =>
    describeService(instance, nameOf(instance), variablesFor(instance.serviceId, environment.id))
  );
  // Without the linked project in the list, "other projects" can't be trusted.
  expect(status.id && projects.some((project) => project.id === status.id), "the linked project is missing from `railway list`");
  return {
    project: status.name,
    environment: environmentName,
    services: services.sort((a, b) => a.service.localeCompare(b.service)),
    volumes: nodes(environment.volumeInstances, "volumeInstances").map((v) => v.volume?.name ?? v.id),
    buckets: status.buckets ? nodes(status.buckets, "buckets").map((b) => b.name) : [],
    otherEnvironments: environments
      .filter((env) => env !== environment)
      .map((env) => ({ name: env.name, services: nodes(env.serviceInstances, `serviceInstances of ${env.name}`).map(nameOf).sort() })),
    otherProjects: projects
      .filter((project) => project.id !== status.id)
      .map((project) => ({
        name: project.name,
        workspace: project.workspace?.name ?? null,
        environments: nodes(project.environments, `environments of ${project.name}`).map((env) => env.name),
        services: nodes(project.services, `services of ${project.name}`).map((s) => s.name).sort(),
      })),
  };
}

const cell = (value) =>
  (Array.isArray(value)
    ? value.length > 0
      ? value.join(", ")
      : "–"
    : value === null || value === undefined
      ? "–"
      : String(value)
  ).replaceAll("|", "\\|");

export function toMarkdown(report) {
  const lines = [
    `# Railway inventory: ${report.project} / ${report.environment}`,
    "",
    "Variable names only: values are read to classify them but never printed.",
    "",
    "| service | status | regions×replicas | start | healthcheck | drain s | overlap s | cron | restart | builder | watch patterns | volumes | custom domains | railway domains |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...report.services.map((s) =>
      `| ${[s.service, s.status, s.regions, s.startCommand, s.healthcheck, s.drainingSeconds, s.overlapSeconds, s.cronSchedule, s.restartPolicy, s.builder, s.watchPatterns, s.volumeMounts, s.customDomains, s.railwayDomains].map(cell).join(" | ")} |`
    ),
    "",
    "## Variables that need attention",
    "",
    "| service | variables | sealed (unreadable) | point at *.railway.internal | point at *.up.railway.app |",
    "|---|---|---|---|---|",
    ...report.services.map((s) =>
      `| ${[s.service, s.variableCount, s.sealed, s.privateHostRefs, s.railwayDomainRefs].map(cell).join(" | ")} |`
    ),
    "",
    `Volumes: ${cell(report.volumes)}`,
    `Buckets: ${cell(report.buckets)}`,
    "",
    "Railway's metrics are summed across replicas; divide by the replica count before sizing containers.",
    "",
    "## Everything else on Railway",
    "",
    "Decide each of these on purpose before deleting anything. An environment in the same project can deploy from the same branch.",
    "",
    "| other environment in this project | services |",
    "|---|---|",
    ...(report.otherEnvironments.length > 0
      ? report.otherEnvironments.map((e) => `| ${[e.name, e.services].map(cell).join(" | ")} |`)
      : ["| none | – |"]),
    "",
    "| other project | workspace | environments | services |",
    "|---|---|---|---|",
    ...(report.otherProjects.length > 0
      ? report.otherProjects.map((p) => `| ${[p.name, p.workspace, p.environments, p.services].map(cell).join(" | ")} |`)
      : ["| none | – | – | – |"]),
  ];
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const environmentName = process.argv[2] ?? "production";
  const railway = (args) =>
    JSON.parse(execFileSync("railway", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 }));
  const status = railway(["status", "--json"]);
  const report = inventory(
    status,
    environmentName,
    (serviceId, environmentId) => railway(["variables", "--json", "--service", serviceId, "--environment", environmentId]),
    railway(["list", "--json"])
  );
  process.stdout.write(toMarkdown(report));
}

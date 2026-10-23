import assert from "node:assert/strict";
import { test } from "node:test";

import { describeService, inventory, toMarkdown } from "./railway-inventory.mjs";

const instance = {
  serviceId: "svc-worker",
  domains: { customDomains: [], serviceDomains: [{ domain: "worker-abc.up.railway.app" }] },
  activeDeployments: [
    {
      status: "SUCCESS",
      deploymentStopped: false,
      meta: {
        volumeMounts: [],
        serviceManifest: {
          build: { builder: "RAILPACK", watchPatterns: ["src/**", "package.json"] },
          deploy: {
            startCommand: "node worker.js | tee log",
            healthcheckPath: "/health",
            healthcheckTimeout: 120,
            drainingSeconds: 60,
            overlapSeconds: 0,
            multiRegionConfig: { "region-a": { numReplicas: 3 }, "region-b": { numReplicas: 1 } },
          },
        },
      },
    },
  ],
};

const variables = {
  RAILWAY_SERVICE_ID: "x",
  DATABASE_URL: "postgres://secret@db.example.com/app",
  CACHE_URL: "redis://cache.railway.internal:6379",
  CALLBACK_BASE: "https://worker-abc.up.railway.app",
  SEALED_KEY: null,
};

test("a service row keeps the deploy settings and never carries a value", () => {
  const row = describeService(instance, "worker", variables);
  assert.deepEqual(row.regions, ["region-a×3", "region-b×1"]);
  assert.equal(row.drainingSeconds, 60);
  assert.equal(row.overlapSeconds, 0);
  assert.equal(row.variableCount, 4); // RAILWAY_* dropped
  assert.deepEqual(row.sealed, ["SEALED_KEY"]);
  assert.deepEqual(row.privateHostRefs, ["CACHE_URL"]);
  assert.deepEqual(row.railwayDomainRefs, ["CALLBACK_BASE"]);
  assert.equal(JSON.stringify(row).includes("secret@"), false);
});

const linked = { id: "p-main", name: "demo", environments: { edges: [] }, services: { edges: [] } };

test("the Markdown report names variables and never prints their values", () => {
  const status = {
    id: "p-main",
    name: "demo",
    services: { edges: [{ node: { id: "svc-worker", name: "worker" } }] },
    buckets: { edges: [] },
    environments: {
      edges: [{ node: { id: "env-1", name: "production", serviceInstances: { edges: [{ node: instance }] }, volumeInstances: { edges: [] } } }],
    },
  };
  const markdown = toMarkdown(inventory(status, "production", () => variables, [linked]));
  assert.match(markdown, /\| none \| – \| – \| – \|/); // an empty table says so
  assert.match(markdown, /\| worker \| SUCCESS \| region-a×3, region-b×1 \|/);
  assert.match(markdown, /node worker\.js \\\| tee log/); // a pipe can't split the table
  assert.match(markdown, /SEALED_KEY/);
  for (const value of ["postgres://", "redis://", "secret@"]) {
    assert.equal(markdown.includes(value), false, value);
  }
});

test("the report lists the project's other environments and the account's other projects", () => {
  const status = {
    id: "p-main",
    name: "demo",
    services: { edges: [{ node: { id: "svc-worker", name: "worker" } }] },
    environments: {
      edges: [
        { node: { id: "env-1", name: "production", serviceInstances: { edges: [] }, volumeInstances: { edges: [] } } },
        { node: { id: "env-2", name: "staging", serviceInstances: { edges: [{ node: { serviceId: "svc-worker" } }] }, volumeInstances: { edges: [] } } },
      ],
    },
  };
  const projects = [
    { id: "p-main", name: "demo", workspace: { name: "team" }, environments: { edges: [] }, services: { edges: [] } },
    { id: "p-other", name: "side-project", workspace: { name: "team" }, environments: { edges: [{ node: { name: "production" } }] }, services: { edges: [{ node: { id: "x", name: "api" } }] } },
  ];
  const markdown = toMarkdown(inventory(status, "production", () => ({}), projects));
  assert.match(markdown, /\| staging \| worker \|/);
  assert.match(markdown, /\| side-project \| team \| production \| api \|/);
  assert.equal(markdown.includes("| demo | team"), false); // the linked project isn't listed as "other"
  assert.throws(() => inventory(status, "production", () => ({}), { projects }), /project list is not an array/);
  assert.throws(() => inventory(status, "production", () => ({})), /project list is not an array/);
  assert.throws(() => inventory(status, "production", () => ({}), projects.slice(1)), /linked project is missing/);
  const unnamed = structuredClone(status);
  unnamed.environments.edges[1].node.serviceInstances.edges[0].node = {};
  assert.throws(() => inventory(unnamed, "production", () => ({}), projects), /no id or name/);
});

test("an unknown environment fails instead of reporting nothing", () => {
  const status = { name: "demo", services: { edges: [] }, buckets: { edges: [] }, environments: { edges: [] } };
  assert.throws(() => inventory(status, "production", () => ({}), []), /No environment named "production"/);
});

test("output that doesn't match the expected CLI shape fails loudly", () => {
  const status = { name: "demo", services: { edges: [] }, environments: { edges: [{ node: { id: "e", name: "production", serviceInstances: { edges: [{ node: { serviceId: "s", activeDeployments: [{ status: "SUCCESS", meta: {} }] } }] }, volumeInstances: { edges: [] } } }] } };
  assert.throws(() => inventory(status, "production", () => ({}), []), /no meta\.serviceManifest/);
  const noEdges = { name: "demo", services: {}, environments: { edges: [{ node: { id: "e", name: "production", serviceInstances: { edges: [] }, volumeInstances: { edges: [] } } }] } };
  assert.throws(() => inventory(noEdges, "production", () => ({}), []), /services has no edges list/);
  assert.throws(() => describeService({}, "x", "KEY=value"), /not a JSON object/);
});

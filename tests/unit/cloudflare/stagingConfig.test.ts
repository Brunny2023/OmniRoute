import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";

const root = process.cwd();
const workerSource = readFileSync(resolve(root, "src/cloudflare/index.ts"), "utf8");
const quotaStoreSource = readFileSync(resolve(root, "src/lib/quota/storeFactory.ts"), "utf8");
const circuitBreakerSource = readFileSync(
  resolve(root, "src/lib/warmupScheduler/circuitBreakerFactory.ts"),
  "utf8"
);
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const d1Migration = readFileSync(
  resolve(root, "cloudflare/d1/migrations/0001_control_plane.sql"),
  "utf8"
);
const config = parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8")) as {
  containers?: Array<Record<string, unknown>>;
  durable_objects?: { bindings?: Array<Record<string, unknown>> };
  migrations?: Array<Record<string, unknown>>;
  secrets?: { required?: string[] };
  workers_dev?: boolean;
};

test("Cloudflare staging uses one Worker-fronted OmniRoute Container", () => {
  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.containers, [
    {
      class_name: "OmniRouteContainer",
      image: "./Dockerfile",
      max_instances: 1,
      instance_type: "standard-1",
    },
  ]);
  assert.deepEqual(config.migrations, [
    {
      tag: "v1",
      new_sqlite_classes: ["OmniRouteContainer", "EdgeRateLimiter"],
    },
  ]);
});

test("Cloudflare staging declares the Container and consistent edge rate-limit Durable Objects", () => {
  const bindings = config.durable_objects?.bindings ?? [];
  assert.deepEqual(
    bindings.map((binding) => [binding.name, binding.class_name]),
    [
      ["OMNIROUTE_CONTAINER", "OmniRouteContainer"],
      ["OMNIROUTE_EDGE_RATE_LIMITER", "EdgeRateLimiter"],
    ]
  );
});

test("Cloudflare staging requires secrets and never configures Redis", () => {
  assert.deepEqual(config.secrets?.required, [
    "JWT_SECRET",
    "API_KEY_SECRET",
    "INITIAL_PASSWORD",
    "STORAGE_ENCRYPTION_KEY",
    "OMNIROUTE_WS_BRIDGE_SECRET",
  ]);
  assert.doesNotMatch(JSON.stringify(config), /redis/i);
  assert.doesNotMatch(workerSource, /REDIS_URL|ioredis/i);
});

test("Cloudflare staging prevents every supported Redis connection path", () => {
  assert.match(workerSource, /OMNIROUTE_DISABLE_REDIS: "1"/);
  assert.match(quotaStoreSource, /OMNIROUTE_DISABLE_REDIS === "1"/);
  assert.match(circuitBreakerSource, /redisUrl && !redisDisabled/);
  assert.match(dockerfile, /rm -rf \/app\/node_modules\/ioredis/);
});

test("the first D1 migration is additive and limited to the approved control plane", () => {
  for (const table of [
    "omniroute_control_plane_meta",
    "omniroute_control_plane_kv",
    "omniroute_provider_connections",
    "omniroute_gateway_api_keys",
    "omniroute_routing_combos",
    "omniroute_gateway_usage_summaries",
  ]) {
    assert.match(d1Migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  const executableSql = d1Migration.replace(/^--.*$/gm, "");
  assert.doesNotMatch(executableSql, /DROP\s+(TABLE|INDEX)|ALTER\s+TABLE|storage\.sqlite/i);
});

test("Cloudflare staging preserves streaming and routes live WebSockets through Container fetch", () => {
  assert.match(workerSource, /return this\.containerFetch\(request\);/);
  assert.match(workerSource, /return super\.fetch\(switchPort\(request, LIVE_WS_PORT\)\);/);
  assert.match(workerSource, /await container\.fetch\(forwardedRequest\);/);
  assert.match(workerSource, /url\.pathname === "\/api\/v1\/ws"/);
});

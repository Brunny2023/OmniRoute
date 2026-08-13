---
title: "Cloudflare Staging Audit"
---

# Cloudflare Staging Audit and Selective Persistence Decision

**Repository baseline:** `Brunny2023/OmniRoute`, branch `release/v3.8.50`, commit `7ca73697b0f5b9b5645884817fab616b4608ebdc`.

## Decision summary

This document records the audit completed before the Cloudflare implementation. It authorizes a **staging-only** Worker-to-Container deployment and prohibits a production-domain attachment until staging has passed transport, state recovery, authentication, provider, and backup tests. Redis will not be deployed. No existing local SQLite database will be placed on R2/FUSE or otherwise treated as a durable filesystem.

> Cloudflare Containers have an ephemeral disk after sleep or replacement. Cloudflare documents R2/FUSE as object-storage-backed rather than a POSIX filesystem and warns against native-SSD assumptions. Therefore, SQLite/WAL on the Container filesystem is not production-safe.[1][2]

| Area                | Audited finding                                                                                                                                                                                                                        | Cloudflare staging consequence                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application runtime | Next.js 16 standalone application, launched by `scripts/dev/run-standalone.mjs`; package engines allow Node 22 or Node 24–26.                                                                                                          | Retain the existing Node application inside a Container rather than porting routes to Workers.                                                                                                                       |
| Container image     | `Dockerfile` builds a Linux Node image, defaults to port `20128`, and provides `runner-base`, `runner-web`, and `runner-cli` stages.                                                                                                   | A Cloudflare-specific final image target must use the lean `runner-base` stage and retain port `20128`.                                                                                                              |
| Public protocols    | `/v1` rewrites to `/api/v1`; HTTP streaming is served by the Next runtime. The dashboard live WebSocket uses `/live-ws` and local port `20132`; MCP has SSE and streamable HTTP routes; A2A has JSON-RPC routes.                       | The Worker must forward the original request without buffering. The Container class `fetch()` path must be used for WebSocket upgrades because it supports WebSocket proxying.[3]                                    |
| Redis               | Redis is optional. It is used only by the optional rolling quota-store driver and an optional rate limiter; the default quota-store driver is SQLite.                                                                                  | The Cloudflare Container sets `OMNIROUTE_DISABLE_REDIS=1`, removes `ioredis` from its final image, and uses a Durable Object only for distributed edge request admission. No Redis service or binding is configured. |
| SQLite              | `DATA_DIR` contains `storage.sqlite`, WAL/SHM files, migration backups, logs, and scheduled-backup state. The database contains 18 base tables plus 144 versioned migrations. Provider credentials and API keys are encrypted at rest. | Local SQLite can only be used as ephemeral, rehydratable staging state. It cannot remain the authoritative production control plane after a Container restart.                                                       |
| Background jobs     | Credential-health checks, database health checks, model sync, and backup scheduling use process timers.                                                                                                                                | Treat these as best-effort while a container is running. Durable, scheduled backup and reconciliation work must move to Worker schedules or Durable Object alarms only after the control plane is available.         |

## Staging foundation

The first implementation milestone is intentionally narrow:

```text
Client → Cloudflare Worker → one named Cloudflare Container → OmniRoute on :20128
```

The Worker is the sole public ingress. It will add request identifiers, reject obviously unsafe request sizes, apply a staging edge rate limit, expose a lightweight Worker health endpoint, and proxy all remaining requests unchanged to a named Container instance. Cloudflare Containers are managed through Durable Objects; their class owns lifecycle and port readiness.[4]

The staging runtime will set a writable, **ephemeral** `DATA_DIR` inside the Container. This permits a compatibility test of the existing application without claiming persistence. No custom domain is configured at this stage; the deployment URL will be the Worker staging URL.

## SQLite classification and migration boundary

### Data requiring durable Cloudflare-native persistence

The following state cannot safely remain solely in an ephemeral Container because loss would alter authorization, provider routing, encrypted credential access, or operator configuration. It is the first candidate set for a D1-backed control plane, introduced behind a dedicated adapter rather than by rewriting every SQLite call site at once.

| SQLite domain data                                                                                                                        | Why it is authoritative                                                                     | Target primitive                                      | Migration approach                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `provider_connections`, provider tokens, API keys, and provider-node configuration                                                        | It controls provider connectivity and contains encrypted credentials.                       | D1                                                    | Preserve existing AES-256-GCM ciphertext and key handling; move through a new control-plane repository interface. |
| `api_keys`, API-key scopes, key groups, quotas, and policy configuration                                                                  | It authenticates and authorizes the public gateway.                                         | D1, with a Durable Object for atomic rolling counters | D1 remains the source of truth; the Durable Object provides short-lived consistent admission/rate state.          |
| `key_value` namespaces holding settings, routing policies, feature flags, registered keys, sync tokens, and persistent user configuration | These settings change gateway behavior and must survive replacement.                        | D1                                                    | Migrate only non-cache namespaces in the first durable-control-plane release.                                     |
| `combos`, combo targets, fallback chains, model-combo mappings, and provider limits                                                       | They define request routing and fallback behavior.                                          | D1                                                    | Migrate after the basic credential/API-key path, using a read-through adapter and an explicit schema version.     |
| Cost, usage summaries, budget definitions, quota snapshots, and audit metadata                                                            | They support enforcement, billing metadata, and operational visibility.                     | D1                                                    | Move summary/metadata rows first; retain oversized call artifacts in R2.                                          |
| Provider circuit-breaker and temporary lockout state                                                                                      | Concurrent updates must be serialized to prevent inconsistent admission/fallback decisions. | Durable Objects                                       | Use one named object per provider or API key; persist only state that must survive restart.                       |

### Data that may remain ephemeral or move to object storage

| Data class                                                                                | Initial disposition                                                                                         | Reason                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite WAL, `storage.sqlite`, local migration backups                                     | Ephemeral during compatibility staging only; never mounted from R2/FUSE.                                    | Cloudflare Container disk is not durable and object storage is not a safe SQLite/WAL filesystem.[1][2]                                            |
| Semantic cache, in-process rate-limit cache, provider catalog cache, model-sync snapshots | Ephemeral or eventually-consistent cache, subject to explicit cache keys and TTLs.                          | These can be reconstructed from the control plane or upstream providers.                                                                          |
| Request/response artifacts, exports, uploaded files, archives, database backup bundles    | R2.                                                                                                         | These are large objects rather than relational records.                                                                                           |
| FTS and SQLite extension-backed features                                                  | Remain in the local compatibility layer until a feature-by-feature replacement has passed functional tests. | A transparent D1 replacement does not exist in this codebase; migration must preserve search behavior rather than assume extension compatibility. |

## Proposed minimal D1 control-plane schema

No D1 schema is applied by this document. Before the first database migration, the implementation must introduce a versioned D1 schema with additive, reversible migrations. The initial schema is intentionally limited to control-plane records and durable migration bookkeeping:

```sql
CREATE TABLE control_plane_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE control_plane_kv (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE TABLE provider_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE gateway_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  encrypted_key TEXT NOT NULL UNIQUE,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE routing_combos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  definition_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE gateway_usage_summaries (
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  api_key_id TEXT,
  provider TEXT,
  model TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (period_start, period_end, api_key_id, provider, model)
);
```

The schema deliberately stores encrypted secret-bearing payloads rather than exposing plaintext to D1. It does **not** reproduce all 144 SQLite migrations, replace FTS prematurely, or change the existing encrypted data format. The committed, unbound migration is `cloudflare/d1/migrations/0001_control_plane.sql`; it prefixes table names with `omniroute_` to avoid collision during parallel validation. D1 migrations are versioned SQL files tracked by Wrangler.[6] Before activation, the code must provide an adapter contract, a transfer exporter/importer, row-count and checksum verification, and feature flags that leave the existing SQLite path operational during rollout.

## Compatibility and rollback plan

The current domain modules use a SQLite adapter and direct SQL semantics; there is no existing D1 adapter. A safe migration therefore requires a separate control-plane access layer. The changes are staged as follows:

1. Add the Worker/Container configuration with SQLite clearly marked as ephemeral staging-only.
2. Add a D1 schema and adapter for a narrowly selected control-plane feature; default to existing SQLite reads and writes until a verified import is complete.
3. Export encrypted SQLite control-plane records to an encrypted R2 backup bundle, import into D1, and verify per-table row counts, primary-key sets, and selected encrypted-field round trips.
4. Enable D1 only through an explicit feature flag. If verification fails, disable the flag and redeploy the previous Worker version; the original SQLite export remains intact.
5. Move only subsequent approved domains after API, authentication, provider, streaming, restart, and recovery tests pass.

For recovery, retain timestamped R2 database/export bundles with checksums, schema version, encryption-key version, and manifest. Restoring a control-plane release means deploying the last verified Worker version, importing the recorded D1 export where needed, restoring R2 artifacts by manifest, and running read-only validation before re-enabling writes. D1 accepts SQL imports rather than raw SQLite files and can export schema/data through Wrangler; virtual tables are a documented export limitation.[7]

## Current blockers and non-goals

The current sandbox has no Docker daemon, while official Cloudflare deployment from a Dockerfile requires a local Docker-compatible build environment for `wrangler deploy`.[5] The repository will therefore include a GitHub Actions staging pipeline capable of building the Linux/amd64 image and deploying only the staging environment once account credentials are configured. It will not deploy from every branch and will not attach a custom domain.

The audited upstream base is currently marked red by its `Release-Green` status issue. Any unrelated inherited failure will be reported separately and will not be modified in this branch.

This document does not declare production readiness. A production claim requires successful tests of persistence after sleep/replacement, authenticated and unauthenticated API behavior, `/v1` streaming, WebSocket behavior, provider egress, backup/restore, and deployment rollback.

## References

[1]: https://developers.cloudflare.com/containers/faq/ "Cloudflare Containers FAQ"
[2]: https://developers.cloudflare.com/containers/examples/r2-fuse-mount/ "Cloudflare R2 FUSE mounts for Containers"
[3]: https://developers.cloudflare.com/containers/examples/websocket/ "Cloudflare WebSocket-to-Container example"
[4]: https://developers.cloudflare.com/containers/get-started/ "Cloudflare Containers getting started"
[5]: https://developers.cloudflare.com/containers/platform-details/image-management/ "Cloudflare Container image management"
[6]: https://developers.cloudflare.com/d1/reference/migrations/ "Cloudflare D1 migrations"
[7]: https://developers.cloudflare.com/d1/best-practices/import-export-data/ "Cloudflare D1 import and export"

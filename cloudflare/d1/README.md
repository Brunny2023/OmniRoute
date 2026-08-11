# D1 Control-Plane Migration

`migrations/0001_control_plane.sql` is an **additive, unbound staging artifact**. It has not been applied to a Cloudflare account and the Worker has no D1 binding yet. This separation is deliberate: the current OmniRoute application accesses `storage.sqlite` through a synchronous SQLite adapter, so binding D1 without a verified control-plane repository would create a misleading and unsafe partial migration.

## Approved scope

The first D1 schema contains only the durable control-plane domains identified in `docs/ops/CLOUDFLARE_STAGING_AUDIT.md`:

| D1 table                            | Source domain                                 | Activation condition                                                          |
| ----------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| `omniroute_control_plane_meta`      | Migration and export manifest metadata        | Always created with the schema.                                               |
| `omniroute_control_plane_kv`        | Approved durable `key_value` namespaces       | Namespace-by-namespace export and checksum verification.                      |
| `omniroute_provider_connections`    | Encrypted provider connection configuration   | Ciphertext round-trip verification with the existing encryption-key version.  |
| `omniroute_gateway_api_keys`        | API-key metadata and protected secret payload | Existing authentication behavior verified through the new repository adapter. |
| `omniroute_routing_combos`          | Combo and routing definitions                 | `/v1` model routing regression test passes.                                   |
| `omniroute_gateway_usage_summaries` | Aggregated usage and cost records             | D1 summary results reconcile with the retained SQLite data.                   |

No FTS virtual table, raw request/response artifact, SQLite WAL file, or filesystem backup is moved by this migration. Those remain either ephemeral during compatibility staging or are future R2 object-storage candidates.

## Apply only after the staging database exists

Create a dedicated staging D1 database using the Cloudflare dashboard or the approved staging credentials, then use the **database name** rather than a mutable binding name when applying the migration. Cloudflare tracks applied migrations in its migrations table and supports versioned `.sql` files.[1]

```bash
npx wrangler d1 migrations apply omniroute-staging-control-plane \
  --remote \
  --config wrangler.jsonc \
  --migrations-dir cloudflare/d1/migrations
```

Before this command, create a dated encrypted export of the approved source data and an immutable manifest containing source schema version, table row counts, SHA-256 digests, encryption-key version, and operator identity. A raw SQLite file must first be converted to compatible SQL before a D1 import; Cloudflare does not import a raw `.sqlite3` file directly.[2]

## Verification and rollback

Verification is a hard gate. Compare source and D1 primary-key sets and row counts, run encrypted-field round trips without logging plaintext, and exercise the application read path under an explicit `OMNIROUTE_CONTROL_PLANE_DRIVER=d1` feature flag. Keep the feature flag disabled until all checks pass.

If a migration or import is rejected, leave the D1 tables intact for forensic analysis, keep the application on its SQLite path, and restore only from the verified export manifest. If the D1-backed feature flag causes a fault after activation, disable the flag, redeploy the previously verified Worker version, and restore the D1 database by importing the recorded export. D1 can export schema and data through Wrangler; note that D1 exports do not support virtual tables, which is why FTS remains outside this first phase.[2]

## References

[1]: https://developers.cloudflare.com/d1/reference/migrations/ "Cloudflare D1 migrations"
[2]: https://developers.cloudflare.com/d1/best-practices/import-export-data/ "Cloudflare D1 import and export"

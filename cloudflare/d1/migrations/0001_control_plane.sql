-- Cloudflare staging control-plane schema, version 1.
--
-- This migration is intentionally additive and is not referenced by the staging
-- Worker until a dedicated D1 database has been created, encrypted data export
-- and import have been verified, and OMNIROUTE_CONTROL_PLANE_DRIVER=d1 is ready.
-- Do not import raw storage.sqlite directly: export the approved control-plane
-- tables to SQL/JSON, validate encryption metadata and checksums, then import.

CREATE TABLE IF NOT EXISTS omniroute_control_plane_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS omniroute_control_plane_kv (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE TABLE IF NOT EXISTS omniroute_provider_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ocp_provider_connections_active_priority
  ON omniroute_provider_connections (provider, is_active, priority);

CREATE TABLE IF NOT EXISTS omniroute_gateway_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_payload TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ocp_gateway_api_keys_secret_payload
  ON omniroute_gateway_api_keys (secret_payload);

CREATE TABLE IF NOT EXISTS omniroute_routing_combos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  definition_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS omniroute_gateway_usage_summaries (
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  api_key_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  request_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (period_start, period_end, api_key_id, provider, model)
);
CREATE INDEX IF NOT EXISTS idx_ocp_usage_summaries_period
  ON omniroute_gateway_usage_summaries (period_start, period_end);

INSERT OR IGNORE INTO omniroute_control_plane_meta (key, value, updated_at)
VALUES ('schema_version', '1', CURRENT_TIMESTAMP);

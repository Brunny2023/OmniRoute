# Cloudflare Staging Deployment Guide

This guide deploys the **staging-only** Cloudflare Worker and Container implementation. It does not attach a production custom domain or represent a production-readiness approval.

## Architecture

```text
Internet
  → Cloudflare Worker (request ID, size guard, edge rate limit, health route)
  → named Container Durable Object
  → OmniRoute Next.js runtime on port 20128
  → configured AI providers
```

The Worker is the only public ingress. The Container is never directly exposed. HTTP, SSE, and WebSocket upgrades are forwarded through the Container-class `fetch()` path; Cloudflare documents that this is the supported WebSocket proxying path.[1]

The staging Container uses `/tmp/omniroute` as `DATA_DIR`. It is **deliberately ephemeral** so that compatibility testing does not incorrectly imply persistence. SQLite/WAL must not be treated as durable there because Container disks reset after a sleep or replacement.[2]

## Required access and prerequisites

The deployment must use a Cloudflare account on a Workers Paid plan, because Containers are a paid Workers feature.[3] The first deployment requires a Docker-compatible builder. Official Cloudflare guidance specifies that `wrangler deploy` builds a Dockerfile image locally and uploads it to the Cloudflare registry.[4]

| Requirement                           | Purpose                                                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare API token                  | Deploy the Worker, Container image, Durable Objects, and observability configuration. Give it only account-scoped permissions required for Workers/Containers deployment and use a separately scoped token for CI. |
| Cloudflare account ID                 | Targets the intended account when deploying from CI.                                                                                                                                                               |
| Docker-compatible Linux/amd64 builder | Builds the existing OmniRoute Dockerfile. The current repository Dockerfile is used with its lean `runner-cloudflare` final stage.                                                                                 |
| Five staging secrets                  | Starts OmniRoute with secure dashboard sessions, encrypted API-key storage, an initial administrator password, database encryption, and the WebSocket bridge secret.                                               |
| GitHub repository secrets             | Needed only for the optional CI deployment workflow.                                                                                                                                                               |

## Configure secrets

Never commit secret values. Configure these secret names in the Cloudflare Worker before deploying:

```bash
printf '%s' "$JWT_SECRET" | npx wrangler secret put JWT_SECRET --config wrangler.jsonc
printf '%s' "$API_KEY_SECRET" | npx wrangler secret put API_KEY_SECRET --config wrangler.jsonc
printf '%s' "$INITIAL_PASSWORD" | npx wrangler secret put INITIAL_PASSWORD --config wrangler.jsonc
printf '%s' "$STORAGE_ENCRYPTION_KEY" | npx wrangler secret put STORAGE_ENCRYPTION_KEY --config wrangler.jsonc
printf '%s' "$OMNIROUTE_WS_BRIDGE_SECRET" | npx wrangler secret put OMNIROUTE_WS_BRIDGE_SECRET --config wrangler.jsonc
```

All five names are declared in `wrangler.jsonc`. The Container receives them only as runtime environment variables from the Worker. Provider credentials are not configured through this deployment file; they must be supplied through the dashboard only after the selected persistent control-plane path is implemented and verified.

## Deploy staging

From a Docker-enabled Linux/amd64 environment:

```bash
npm ci --ignore-scripts
npx wrangler deploy --config wrangler.jsonc
npx wrangler containers list
```

The deployment URL is reported by Wrangler and uses the account’s `workers.dev` subdomain. Wait for the Container deployment status to become ready before performing API tests. Cloudflare notes that Container provisioning can take several minutes after a first deployment.[5]

## Staging verification sequence

Use the returned Worker URL as `STAGING_URL`.

```bash
curl --fail --show-error "$STAGING_URL/__cf/health"
curl --fail --show-error "$STAGING_URL/api/monitoring/health"
curl --show-error "$STAGING_URL/v1/models"
```

The authenticated API test must use a staging API key created in the dashboard after persistent key management is available. Until then, a successful unauthenticated rejection is expected because `REQUIRE_API_KEY=true` is enforced in the Container environment.

Streaming, WebSocket, provider, restart, and recovery tests are mandatory before a production claim:

| Test                                       | Expected evidence                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `/v1/models`                               | JSON response or the documented authentication rejection, never a container-port exposure.                                 |
| `/v1/chat/completions` with `stream: true` | Incremental SSE frames traverse Worker → Container without buffering.                                                      |
| `/live-ws`                                 | Same-origin WebSocket connection is accepted and reconnects after a Container restart.                                     |
| Container restart/sleep                    | No false persistence claim; ephemeral SQLite loss is observed and recorded until D1 control-plane migration is enabled.    |
| Provider egress                            | A provider request succeeds using a credential stored through the approved control-plane path.                             |
| Backup/restore                             | A signed manifest, checksum validation, and R2 export/import test succeed after the persistence adaptation is implemented. |

## CI deployment

`.github/workflows/cloudflare-staging.yml` deploys only the `cloudflare-staging` branch and manual workflow runs. It never deploys experimental branches automatically. Configure the following GitHub repository secrets before enabling that branch flow:

| GitHub secret           | Description                                                 |
| ----------------------- | ----------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Dedicated CI token with the minimum deployment permissions. |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the staging Worker.                       |

The Cloudflare application secrets listed earlier belong in Cloudflare Worker Secrets, not GitHub Actions secrets. Do not add provider keys, passwords, database keys, or Cloudflare login credentials to the repository or workflow logs.

## Rollback and shutdown

To rollback a Worker version, select the prior verified deployment in Cloudflare’s deployment history, then verify `__cf/health`, the dashboard login route, `/v1/models`, and a streaming request. Deleting or rolling back a Container image must be coordinated with the associated Worker version because a Worker version referencing a removed Container image cannot start it.[4]

To pause staging traffic without a custom domain, disable the Worker deployment or restrict access through the Cloudflare dashboard. Do not delete D1 or R2 resources when they are introduced; first create and verify a recovery export.

## References

[1]: https://developers.cloudflare.com/containers/examples/websocket/ "Cloudflare WebSocket-to-Container example"
[2]: https://developers.cloudflare.com/containers/faq/ "Cloudflare Containers FAQ"
[3]: https://developers.cloudflare.com/containers/ "Cloudflare Containers overview"
[4]: https://developers.cloudflare.com/containers/platform-details/image-management/ "Cloudflare Container image management"
[5]: https://developers.cloudflare.com/containers/get-started/ "Cloudflare Containers getting started"

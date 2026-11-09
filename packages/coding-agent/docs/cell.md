# CELL Agent

CELL wraps the Pi agent runtime behind a tenant API Key and a LiteLLM-only model/MCP boundary:

```text
CELL API Key -> CELL Auth/Sync Backend -> Supabase key binding -> LiteLLM Virtual Key
                         |                                      |
                         +-> tenant metadata                    +-> models and MCP gateway
```

## Build and run

```bash
npm ci --ignore-scripts
npm run build
npm link --workspace @earendil-works/pi-coding-agent
cell --help
```

The package exposes both `pi` and `cell`. CELL uses `~/.cell/agent` (or `$CELL_HOME/agent`) and
`.cell/`; it does not read Pi credentials, sessions, or `.pi` resources.

## Login

An administrator issues a tenant API Key. Interactive login hides the key:

```bash
cell login
cell whoami
cell logout
```

Automation must use stdin; a positional key is intentionally unsupported:

```bash
printf '%s' "$CELL_TENANT_API_KEY" | cell login --api-key-stdin
```

`CELL_AUTH_URL` overrides the bundled Auth Backend base URL. CELL sends
`Authorization: Bearer <tenant-api-key>` to `POST <CELL_AUTH_URL>/v1/login`. The tenant key is
verified once and is never stored. A successful v1 response is:

```json
{
  "version": 1,
  "tenant": { "id": "tenant-id", "name": "Tenant Name" },
  "api_key_id": "api-key-record-id",
  "litellm": { "base_url": "https://llm.example/v1", "api_key": "sk-..." },
  "mcp_servers": [
    { "name": "litellm-upload", "url": "https://llm.example/upload_file/mcp" }
  ]
}
```

CELL validates `/v1/models` before atomically replacing the previous login. `auth.json` stores only
the scoped LiteLLM key and response metadata, with mode `0600`. Every CELL startup fetches the
current LiteLLM model list. A 401 clears the local login; a 403 or transient failure does not.

The Auth response controls only managed MCP names and URLs. Names must use the reserved
`litellm-*` namespace. CELL fixes Streamable HTTP, `enabled: true`, `exposure: direct`, and injects
`x-litellm-api-key: Bearer <virtual-key>` in memory. The key is never written to `mcp.json`. MCP URLs
must share the LiteLLM origin unless their origin is included in the deployment-controlled
`CELL_MCP_ALLOWED_ORIGINS` list. Production URLs require HTTPS; loopback HTTP is allowed for local
development.

## Supabase schema and webhook

Apply [001_cell_api_keys.sql](../docker/cell/supabase/001_cell_api_keys.sql) to the Supabase project.
It creates `cell_tenants`, `cell_api_keys`, restrictive RLS, and the asynchronous Database Webhook
trigger. Store the webhook endpoint and its independent secret in Vault outside the migration:

```sql
select vault.create_secret(
  'https://cell-auth.example/v1/webhooks/api-keys',
  'cell_sync_webhook_url'
);
select vault.create_secret('a-long-random-secret', 'cell_webhook_secret');
```

The trigger sends `pending` and `revoking` rows to the backend. The backend also reconciles these
states periodically, so lost, duplicate, and out-of-order deliveries converge. Operations are
idempotent by row ID, status, and `sync_version`.

Supabase stores only a SHA-256 tenant-key hash plus prefix/last-four metadata. Each API-key row owns
one LiteLLM Virtual Key and each tenant maps to one LiteLLM Team. The Virtual Key is encrypted before
writeback using AES-256-GCM. `CELL_KEY_ENCRYPTION_KEY` must be a base64-encoded 32-byte key kept only
by the backend/KMS. Revocation is `active -> revoking -> revoked`; the encrypted key material is
removed after LiteLLM deletion.

## Administrator CLI

The repository-only CLI reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `.env` or its
process environment. The Service Role Key is never shipped to CELL:

```bash
node packages/coding-agent/docker/cell/admin.mjs tenants create "Acme" <litellm-team-id>
node packages/coding-agent/docker/cell/admin.mjs keys create <tenant-id>
node packages/coding-agent/docker/cell/admin.mjs keys list [tenant-id]
node packages/coding-agent/docker/cell/admin.mjs keys revoke <api-key-id>
node packages/coding-agent/docker/cell/admin.mjs keys retry <failed-api-key-id>
```

Creation prints the plaintext only after LiteLLM synchronization becomes active. A timeout or sync
error prints no key. Retry revokes the inaccessible row and generates an entirely new API Key.

## Docker integration environment

The Docker environment runs pinned LiteLLM, PostgreSQL, a deterministic OpenAI-compatible upstream,
the CELL Auth/Sync Backend, and an upload MCP server. Supabase remains the project supplied in `.env`:

```bash
SUPABASE_URL=https://project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=server-only-service-role-key
# Only when Supabase runs locally on the Docker host:
CELL_DOCKER_SUPABASE_URL=http://host.docker.internal:8000
CELL_WEBHOOK_SECRET=separate-long-random-secret
CELL_KEY_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
LITELLM_MASTER_KEY=sk-long-random-local-master-key
LITELLM_SALT_KEY=sk-long-random-stable-salt-key
```

Start and test:

```bash
npm run cell:docker:up
npm run cell:docker:test
npm run cell:docker:down
```

The smoke test creates a LiteLLM Team, Supabase tenant/key binding, exercises the authenticated
webhook handler, exchanges the tenant API Key, calls model discovery/completion and LiteLLM MCP,
then revokes the key and verifies LiteLLM rejects it. The reconciliation loop also remains active as
the safety net for real Database Webhook delivery.

For manual local CELL use:

```bash
export CELL_AUTH_URL=http://127.0.0.1:14010
cell login
```

Never expose the Docker defaults beyond localhost. Keep the Service Role, webhook secret, LiteLLM
Master Key, and encryption key out of the CELL client and source control.

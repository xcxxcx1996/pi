// Synchronizes Supabase API-key rows with LiteLLM and serves CELL's v1 login exchange.

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const port = positiveInteger("PORT", 4010);
const supabaseUrl = required("SUPABASE_URL").replace(/\/+$/u, "");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const webhookSecret = required("CELL_WEBHOOK_SECRET");
const encryptionKey = Buffer.from(required("CELL_KEY_ENCRYPTION_KEY"), "base64");
if (encryptionKey.length !== 32) throw new Error("CELL_KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
const encryptionKeyVersion = positiveInteger("CELL_KEY_ENCRYPTION_KEY_VERSION", 1);
const liteLlmUrl = required("LITELLM_URL").replace(/\/+$/u, "");
const publicLiteLlmBaseUrl = required("CELL_LITELLM_PUBLIC_BASE_URL").replace(/\/+$/u, "");
const liteLlmMasterKey = required("LITELLM_MASTER_KEY");
const defaultMcpServers = [{ name: "litellm-upload", url: `${new URL(publicLiteLlmBaseUrl).origin}/upload_file/mcp` }];
const mcpServers = parseMcpServers(process.env.CELL_MCP_SERVERS_JSON || JSON.stringify(defaultMcpServers));
const reconcileIntervalMs = positiveInteger("CELL_RECONCILE_INTERVAL_MS", 30_000);

function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function positiveInteger(name, fallback) {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
}

function parseMcpServers(raw) {
	const value = JSON.parse(raw);
	if (!Array.isArray(value)) throw new Error("CELL_MCP_SERVERS_JSON must be an array");
	return value.map((entry) => {
		if (typeof entry?.name !== "string" || !entry.name.startsWith("litellm-") || typeof entry.url !== "string") {
			throw new Error("CELL_MCP_SERVERS_JSON entries require a litellm-* name and URL");
		}
		return { name: entry.name, url: entry.url };
	});
}

function json(response, status, body) {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"x-content-type-options": "nosniff",
	});
	response.end(JSON.stringify(body));
}

async function jsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 1_000_000) throw new Error("request body is too large");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function responseJson(response, service) {
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`${service} returned invalid JSON (${response.status})`);
	}
	if (!response.ok) {
		const detail = body?.error?.message ?? body?.message ?? body?.msg ?? body?.error;
		throw new Error(`${service} rejected the request (${response.status})${typeof detail === "string" ? `: ${detail}` : ""}`);
	}
	return body;
}

async function supabaseRequest(path, init = {}) {
	const headers = {
		accept: "application/json",
		apikey: serviceRoleKey,
		authorization: `Bearer ${serviceRoleKey}`,
		...(init.body === undefined ? {} : { "content-type": "application/json" }),
		...(init.headers ?? {}),
	};
	const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
		...init,
		headers,
		signal: AbortSignal.timeout(15_000),
	});
	return responseJson(response, "Supabase");
}

async function liteLlmRequest(path, body, tolerateMissing = false) {
	const response = await fetch(`${liteLlmUrl}${path}`, {
		method: "POST",
		headers: {
			accept: "application/json",
			authorization: `Bearer ${liteLlmMasterKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	});
	if (tolerateMissing && (response.status === 400 || response.status === 404)) return undefined;
	return responseJson(response, "LiteLLM");
}

function encrypt(value) {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
	const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return {
		litellm_key_ciphertext: ciphertext.toString("base64"),
		litellm_key_nonce: nonce.toString("base64"),
		litellm_key_tag: cipher.getAuthTag().toString("base64"),
		litellm_key_version: encryptionKeyVersion,
	};
}

function decrypt(row) {
	const decipher = createDecipheriv(
		"aes-256-gcm",
		encryptionKey,
		Buffer.from(row.litellm_key_nonce, "base64"),
	);
	decipher.setAuthTag(Buffer.from(row.litellm_key_tag, "base64"));
	return Buffer.concat([
		decipher.update(Buffer.from(row.litellm_key_ciphertext, "base64")),
		decipher.final(),
	]).toString("utf8");
}

async function updateRow(row, values) {
	const claimFilter = row.sync_claim_token ? `&sync_claim_token=eq.${row.sync_claim_token}` : "";
	const updated = await supabaseRequest(
		`cell_api_keys?id=eq.${encodeURIComponent(row.id)}&sync_version=eq.${row.sync_version}&status=eq.${row.status}${claimFilter}`,
		{
			method: "PATCH",
			headers: { prefer: "return=representation" },
			body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }),
		},
	);
	if (!Array.isArray(updated) || updated.length !== 1) throw new Error(`stale sync lease for ${row.id}`);
	return updated[0];
}

async function loadTenant(id) {
	const rows = await supabaseRequest(`cell_tenants?id=eq.${encodeURIComponent(id)}&select=id,name,litellm_team_id`);
	if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`tenant ${id} was not found`);
	return rows[0];
}

async function syncPending(row) {
	if (row.litellm_key_ciphertext) {
		await updateRow(row, {
			status: "active",
			sync_error: null,
			sync_claim_token: null,
			sync_claimed_at: null,
			activated_at: new Date().toISOString(),
		});
		return;
	}
	const tenant = await loadTenant(row.tenant_id);
	const alias = `cell-${row.id}`;
	// A worker can die after LiteLLM creates a key but before Supabase records it. A reclaimed lease
	// removes that orphan before recreating the one binding for this API-key row.
	await liteLlmRequest("/key/delete", { key_aliases: [alias] }, true);
	const generated = await liteLlmRequest("/key/generate", {
		team_id: tenant.litellm_team_id,
		key_alias: alias,
		metadata: { cell_api_key_id: row.id, cell_sync_version: row.sync_version },
	});
	if (typeof generated.key !== "string" || !generated.key) throw new Error("LiteLLM did not return a Virtual Key");
	await updateRow(row, {
		...encrypt(generated.key),
		litellm_key_id: typeof generated.key_name === "string" ? generated.key_name : null,
		status: "active",
		sync_error: null,
		sync_claim_token: null,
		sync_claimed_at: null,
		activated_at: new Date().toISOString(),
	});
}

async function syncRevoking(row) {
	if (row.litellm_key_ciphertext) {
		await liteLlmRequest("/key/delete", { keys: [decrypt(row)] }, true);
	}
	await updateRow(row, {
		status: "revoked",
		sync_error: null,
		sync_claim_token: null,
		sync_claimed_at: null,
		revoked_at: new Date().toISOString(),
		litellm_key_ciphertext: null,
		litellm_key_nonce: null,
		litellm_key_tag: null,
		litellm_key_version: null,
	});
}

async function syncRow(row) {
	const token = randomUUID();
	const claimed = await supabaseRequest("rpc/cell_claim_api_key_sync", {
		method: "POST",
		body: JSON.stringify({
			p_id: row.id,
			p_sync_version: row.sync_version,
			p_status: row.status,
			p_token: token,
		}),
	});
	if (claimed !== true) return;
	row.sync_claim_token = token;
	try {
		if (row.status === "pending") await syncPending(row);
		else if (row.status === "revoking") await syncRevoking(row);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await updateRow(row, {
			sync_error: message.slice(0, 2000),
			sync_claim_token: null,
			sync_claimed_at: null,
		}).catch(() => undefined);
		throw error;
	}
}

async function reconcile() {
	const rows = await supabaseRequest(
		"cell_api_keys?status=in.(pending,revoking)&select=*&order=updated_at.asc&limit=100",
	);
	if (!Array.isArray(rows)) throw new Error("Supabase returned an invalid reconciliation result");
	for (const row of rows) await syncRow(row).catch((error) => console.error(`Sync ${row.id} failed: ${error.message}`));
}

function bearerToken(request) {
	const authorization = request.headers.authorization;
	if (!authorization?.startsWith("Bearer ")) return undefined;
	return authorization.slice("Bearer ".length).trim() || undefined;
}

function validWebhookSecret(token) {
	if (!token) return false;
	const actual = Buffer.from(token);
	const expected = Buffer.from(webhookSecret);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function login(apiKey) {
	const hash = createHash("sha256").update(apiKey).digest("hex");
	const rows = await supabaseRequest(
		`cell_api_keys?key_hash=eq.${hash}&status=eq.active&select=id,tenant_id,litellm_key_ciphertext,litellm_key_nonce,litellm_key_tag,litellm_key_version,cell_tenants!inner(id,name)`,
	);
	if (!Array.isArray(rows) || rows.length !== 1) return undefined;
	const row = rows[0];
	if (row.litellm_key_version !== encryptionKeyVersion) throw new Error("unsupported encrypted key version");
	return {
		version: 1,
		tenant: { id: row.cell_tenants.id, name: row.cell_tenants.name },
		api_key_id: row.id,
		litellm: { base_url: publicLiteLlmBaseUrl, api_key: decrypt(row) },
		mcp_servers: mcpServers,
	};
}

const server = createServer(async (request, response) => {
	if (request.method === "GET" && request.url === "/health") {
		json(response, 200, { status: "ok" });
		return;
	}
	try {
		if (request.method === "POST" && request.url === "/v1/webhooks/api-keys") {
			if (!validWebhookSecret(bearerToken(request))) {
				json(response, 401, { error: "invalid_webhook_secret" });
				return;
			}
			const payload = await jsonBody(request);
			const row = payload.record ?? payload.old_record;
			if (row?.id) await syncRow(row);
			json(response, 202, { accepted: true });
			return;
		}
		if (request.method === "POST" && request.url === "/v1/login") {
			const token = bearerToken(request);
			if (!token) {
				json(response, 401, { error: "missing_api_key" });
				return;
			}
			const session = await login(token);
			if (!session) {
				json(response, 401, { error: "invalid_api_key" });
				return;
			}
			json(response, 200, session);
			return;
		}
		json(response, 404, { error: "not_found" });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		json(response, 502, { error: "backend_unavailable" });
	}
});

server.listen(port, "0.0.0.0", () => console.log(`CELL Auth Backend listening on ${port}`));
const timer = setInterval(() => void reconcile().catch((error) => console.error(`Reconciliation failed: ${error.message}`)), reconcileIntervalMs);
timer.unref();
void reconcile().catch((error) => console.error(`Initial reconciliation failed: ${error.message}`));

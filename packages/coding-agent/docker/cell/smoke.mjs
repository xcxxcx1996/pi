// Runs the API-key lifecycle through Supabase, the sync backend, LiteLLM, MCP, and the model upstream.

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const fileEnv = parseEnv(await readFile(resolve(process.cwd(), ".env"), "utf8"));
const env = { ...fileEnv, ...process.env };
const supabaseUrl = required("SUPABASE_URL").replace(/\/+$/u, "");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const webhookSecret = required("CELL_WEBHOOK_SECRET");
const authBackendUrl = `http://127.0.0.1:${env.CELL_AUTH_BACKEND_PORT ?? "14010"}`;
const liteLlmUrl = `http://127.0.0.1:${env.CELL_LITELLM_PORT ?? "14000"}`;
const liteLlmMasterKey = env.LITELLM_MASTER_KEY ?? "sk-cell-local-master-key-change-before-shared-use";

function parseEnv(text) {
	return Object.fromEntries(text.split(/\r?\n/u).flatMap((line) => {
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim());
		if (!match) return [];
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		return [[match[1], value]];
	}));
}

function required(name) {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} must be set in .env`);
	return value;
}

async function jsonRequest(url, init, service, expected = undefined) {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
	const text = await response.text();
	let body;
	try {
		if (response.headers.get("content-type")?.includes("text/event-stream")) {
			const data = text.split(/\r?\n/u).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
			body = data.length > 0 ? JSON.parse(data.join("\n")) : null;
		} else {
			body = text ? JSON.parse(text) : null;
		}
	} catch {
		throw new Error(`${service} returned invalid JSON (${response.status})`);
	}
	if (expected !== undefined ? response.status !== expected : !response.ok) {
		throw new Error(`${service} failed (${response.status}): ${JSON.stringify(body)}`);
	}
	return body;
}

function supabase(path, init = {}) {
	return jsonRequest(`${supabaseUrl}/rest/v1/${path}`, {
		...init,
		headers: {
			accept: "application/json",
			apikey: serviceRoleKey,
			authorization: `Bearer ${serviceRoleKey}`,
			...(init.body === undefined ? {} : { "content-type": "application/json" }),
			...(init.headers ?? {}),
		},
	}, "Supabase");
}

function liteLlm(path, body) {
	return jsonRequest(`${liteLlmUrl}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${liteLlmMasterKey}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	}, "LiteLLM admin");
}

async function deliverWebhook(record) {
	return jsonRequest(`${authBackendUrl}/v1/webhooks/api-keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${webhookSecret}`, "content-type": "application/json" },
		body: JSON.stringify({ type: "UPDATE", table: "cell_api_keys", schema: "public", record, old_record: null }),
	}, "CELL Database Webhook", 202);
}

async function waitFor(id, status) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const rows = await supabase(`cell_api_keys?id=eq.${id}&select=*`);
		if (rows[0]?.status === status) return rows[0];
		if (rows[0]?.sync_error) throw new Error(`Sync failed: ${rows[0].sync_error}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
	}
	throw new Error(`Timed out waiting for API-key row ${id} to become ${status}`);
}

const suffix = `${Date.now()}-${randomBytes(5).toString("hex")}`;
const tenantApiKey = `cell_${randomBytes(32).toString("base64url")}`;
let teamId;
let tenantId;
let apiKeyId;

try {
	const team = await liteLlm("/team/new", { team_alias: `cell-e2e-${suffix}`, models: ["cell-test"] });
	teamId = team.team_id;
	if (typeof teamId !== "string") throw new Error("LiteLLM did not return a team_id");

	const tenants = await supabase("cell_tenants", {
		method: "POST",
		headers: { prefer: "return=representation" },
		body: JSON.stringify({ name: `CELL E2E ${suffix}`, litellm_team_id: teamId }),
	});
	tenantId = tenants[0]?.id;
	if (!tenantId) throw new Error("Supabase did not return a tenant id");

	const rows = await supabase("cell_api_keys", {
		method: "POST",
		headers: { prefer: "return=representation" },
		body: JSON.stringify({
			tenant_id: tenantId,
			key_hash: createHash("sha256").update(tenantApiKey).digest("hex"),
			key_prefix: tenantApiKey.slice(0, 12),
			key_last4: tenantApiKey.slice(-4),
		}),
	});
	apiKeyId = rows[0]?.id;
	if (!apiKeyId) throw new Error("Supabase did not return an API-key id");
	await deliverWebhook(rows[0]);
	await waitFor(apiKeyId, "active");

	const session = await jsonRequest(`${authBackendUrl}/v1/login`, {
		method: "POST",
		headers: { authorization: `Bearer ${tenantApiKey}` },
	}, "CELL login");
	if (session.version !== 1 || session.api_key_id !== apiKeyId || session.tenant?.id !== tenantId) {
		throw new Error("CELL login returned incorrect tenant metadata");
	}
	const virtualKey = session.litellm?.api_key;
	if (typeof virtualKey !== "string") throw new Error("CELL login did not return a LiteLLM key");

	const models = await jsonRequest(`${liteLlmUrl}/v1/models`, {
		headers: { authorization: `Bearer ${virtualKey}` },
	}, "LiteLLM model discovery");
	if (!models.data?.some((model) => model.id === "cell-test")) throw new Error("Virtual Key cannot discover cell-test");

	const completion = await jsonRequest(`${liteLlmUrl}/v1/chat/completions`, {
		method: "POST",
		headers: { authorization: `Bearer ${virtualKey}`, "content-type": "application/json" },
		body: JSON.stringify({ model: "cell-test", messages: [{ role: "user", content: "CELL E2E" }] }),
	}, "LiteLLM completion");
	if (completion.choices?.[0]?.message?.content !== "CELL Docker integration is working.") {
		throw new Error("Unexpected model response");
	}

	const mcp = await jsonRequest(`${liteLlmUrl}/upload_file/mcp`, {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"x-litellm-api-key": `Bearer ${virtualKey}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
	}, "LiteLLM MCP");
	if (!mcp.result?.tools?.some((tool) => tool.name.includes("upload_file"))) throw new Error("LiteLLM MCP did not expose upload_file");

	const active = await waitFor(apiKeyId, "active");
	const updated = await supabase(`cell_api_keys?id=eq.${apiKeyId}`, {
		method: "PATCH",
		headers: { prefer: "return=representation" },
		body: JSON.stringify({ status: "revoking", sync_version: active.sync_version + 1, sync_error: null }),
	});
	await deliverWebhook(updated[0]);
	await waitFor(apiKeyId, "revoked");
	await jsonRequest(`${liteLlmUrl}/v1/models`, { headers: { authorization: `Bearer ${virtualKey}` } }, "Revoked LiteLLM key", 401);

	console.log("CELL Docker E2E passed: API Key -> Webhook -> LiteLLM -> MCP/model -> revoke.");
} finally {
	if (apiKeyId) await supabase(`cell_api_keys?id=eq.${apiKeyId}`, { method: "DELETE" }).catch(() => undefined);
	if (tenantId) await supabase(`cell_tenants?id=eq.${tenantId}`, { method: "DELETE" }).catch(() => undefined);
	if (teamId) await liteLlm("/team/delete", { team_ids: [teamId] }).catch(() => undefined);
}

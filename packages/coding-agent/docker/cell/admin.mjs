#!/usr/bin/env node
// Repository-only operations CLI for CELL tenants and one-time API-key issuance.

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const fileEnv = await loadEnv();
const env = { ...fileEnv, ...process.env };
const supabaseUrl = required("SUPABASE_URL").replace(/\/+$/u, "");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");

async function loadEnv() {
	try {
		const text = await readFile(resolve(process.cwd(), ".env"), "utf8");
		return Object.fromEntries(text.split(/\r?\n/u).flatMap((line) => {
			const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim());
			if (!match) return [];
			let value = match[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
			return [[match[1], value]];
		}));
	} catch (error) {
		if (error?.code === "ENOENT") return {};
		throw error;
	}
}

function required(name) {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} must be set in .env or the process environment`);
	return value;
}

async function request(path, init = {}) {
	const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
		...init,
		headers: {
			accept: "application/json",
			apikey: serviceRoleKey,
			authorization: `Bearer ${serviceRoleKey}`,
			...(init.body === undefined ? {} : { "content-type": "application/json" }),
			...(init.headers ?? {}),
		},
		signal: AbortSignal.timeout(15_000),
	});
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		throw new Error(`Supabase returned invalid JSON (${response.status})`);
	}
	if (!response.ok) throw new Error(`Supabase rejected the request (${response.status}): ${JSON.stringify(body)}`);
	return body;
}

async function createTenant(name, teamId) {
	const rows = await request("cell_tenants", {
		method: "POST",
		headers: { prefer: "return=representation" },
		body: JSON.stringify({ name, litellm_team_id: teamId }),
	});
	console.log(JSON.stringify(rows[0], null, 2));
}

async function waitForActivation(id) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const rows = await request(`cell_api_keys?id=eq.${encodeURIComponent(id)}&select=id,status,sync_error`);
		const row = rows[0];
		if (!row) throw new Error(`API-key row ${id} disappeared`);
		if (row.status === "active") return;
		if (row.status === "revoked") throw new Error(`API-key row ${id} was revoked`);
		if (row.sync_error) throw new Error(`API-key synchronization failed: ${row.sync_error}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	throw new Error(`API-key synchronization timed out for ${id}; the plaintext key was not displayed`);
}

async function createKey(tenantId) {
	const plaintext = `cell_${randomBytes(32).toString("base64url")}`;
	const rows = await request("cell_api_keys", {
		method: "POST",
		headers: { prefer: "return=representation" },
		body: JSON.stringify({
			tenant_id: tenantId,
			key_hash: createHash("sha256").update(plaintext).digest("hex"),
			key_prefix: plaintext.slice(0, 12),
			key_last4: plaintext.slice(-4),
		}),
	});
	const row = rows[0];
	if (!row?.id) throw new Error("Supabase did not return the new API-key row");
	await waitForActivation(row.id);
	console.log(`API key ID: ${row.id}`);
	console.log(`API key (shown once): ${plaintext}`);
}

async function revokeKey(id) {
	const rows = await request(`cell_api_keys?id=eq.${encodeURIComponent(id)}&status=in.(pending,active)`, {
		method: "PATCH",
		headers: { prefer: "return=representation" },
		body: JSON.stringify({ status: "revoking", sync_version: await nextSyncVersion(id), sync_error: null }),
	});
	if (rows.length !== 1) throw new Error(`Active API-key row ${id} was not found`);
	console.log(`Revocation queued for ${id}.`);
}

async function nextSyncVersion(id) {
	const rows = await request(`cell_api_keys?id=eq.${encodeURIComponent(id)}&select=sync_version`);
	if (rows.length !== 1) throw new Error(`API-key row ${id} was not found`);
	return rows[0].sync_version + 1;
}

async function retryKey(id) {
	const rows = await request(`cell_api_keys?id=eq.${encodeURIComponent(id)}&select=tenant_id,status`);
	if (rows.length !== 1) throw new Error(`API-key row ${id} was not found`);
	if (rows[0].status !== "pending") throw new Error("Only a failed pending API-key row can be retried");
	await revokeKey(id);
	await createKey(rows[0].tenant_id);
}

async function listKeys(tenantId) {
	const filter = tenantId ? `&tenant_id=eq.${encodeURIComponent(tenantId)}` : "";
	const rows = await request(`cell_api_keys?select=id,tenant_id,key_prefix,key_last4,status,sync_version,sync_error,created_at,activated_at,revoked_at${filter}&order=created_at.desc`);
	console.log(JSON.stringify(rows, null, 2));
}

function usage() {
	return [
		"Usage:",
		"  node admin.mjs tenants create <name> <litellm-team-id>",
		"  node admin.mjs keys create <tenant-id>",
		"  node admin.mjs keys revoke <api-key-id>",
		"  node admin.mjs keys retry <failed-api-key-id>",
		"  node admin.mjs keys list [tenant-id]",
	].join("\n");
}

const [resource, action, ...values] = process.argv.slice(2);
try {
	if (resource === "tenants" && action === "create" && values.length === 2) await createTenant(values[0], values[1]);
	else if (resource === "keys" && action === "create" && values.length === 1) await createKey(values[0]);
	else if (resource === "keys" && action === "revoke" && values.length === 1) await revokeKey(values[0]);
	else if (resource === "keys" && action === "retry" && values.length === 1) await retryKey(values[0]);
	else if (resource === "keys" && action === "list" && values.length <= 1) await listKeys(values[0]);
	else throw new Error(usage());
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

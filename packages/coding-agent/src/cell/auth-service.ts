// CELL API-key exchange and LiteLLM credential lifecycle.

import { setTimeout as sleep } from "node:timers/promises";
import type { AuthInteraction, Credential, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import type { CellConfig } from "./config.ts";

export const CELL_MODEL_CREDENTIAL = "litellm";

export interface CellMcpServer {
	name: string;
	url: string;
}

export interface CellSession {
	tenant: { id: string; name: string };
	apiKeyId: string;
	liteLlm: { baseUrl: string; apiKey: string };
	mcpServers: CellMcpServer[];
}

interface CellStoredCredential extends OAuthCredential {
	cellVersion: 1;
	tenantId: string;
	tenantName: string;
	apiKeyId: string;
	baseUrl: string;
	mcpServers: CellMcpServer[];
}

const LOGIN_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [250, 1_000];
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string, service: string): string {
	const value = record[field];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${service} response is missing ${field}`);
	return value.trim();
}

function validateServiceUrl(value: string, label: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} is not a valid URL`);
	}
	if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
		throw new Error(`${label} must use HTTPS, except on a loopback host`);
	}
	url.pathname = url.pathname.replace(/\/+$/u, "");
	return url.toString().replace(/\/+$/u, "");
}

function parseLoginResponse(body: unknown, config: CellConfig): CellSession {
	if (!isRecord(body) || body.version !== 1 || !isRecord(body.tenant) || !isRecord(body.litellm)) {
		throw new Error("CELL Auth Backend returned an invalid v1 response");
	}
	if (!Array.isArray(body.mcp_servers)) throw new Error("CELL Auth Backend response is missing mcp_servers");
	const baseUrl = validateServiceUrl(requiredString(body.litellm, "base_url", "CELL Auth Backend"), "LiteLLM URL");
	const parsedBaseUrl = new URL(baseUrl);
	if (parsedBaseUrl.search || parsedBaseUrl.hash) throw new Error("LiteLLM URL must not contain a query or fragment");
	const allowedOrigins = new Set([parsedBaseUrl.origin, ...config.auth.allowedMcpOrigins]);
	const names = new Set<string>();
	const mcpServers = body.mcp_servers.map((entry, index): CellMcpServer => {
		if (!isRecord(entry)) throw new Error(`CELL Auth Backend returned invalid mcp_servers[${index}]`);
		const name = requiredString(entry, "name", "CELL Auth Backend");
		if (!name.startsWith("litellm-")) throw new Error(`Managed MCP server name must start with litellm-: ${name}`);
		if (names.has(name)) throw new Error(`CELL Auth Backend returned duplicate MCP server ${name}`);
		names.add(name);
		const url = validateServiceUrl(requiredString(entry, "url", "CELL Auth Backend"), `MCP URL for ${name}`);
		if (!allowedOrigins.has(new URL(url).origin))
			throw new Error(`MCP URL for ${name} is not on an allowed LiteLLM origin`);
		return { name, url };
	});
	return {
		tenant: {
			id: requiredString(body.tenant, "id", "CELL Auth Backend"),
			name: requiredString(body.tenant, "name", "CELL Auth Backend"),
		},
		apiKeyId: requiredString(body, "api_key_id", "CELL Auth Backend"),
		liteLlm: {
			baseUrl,
			apiKey: requiredString(body.litellm, "api_key", "CELL Auth Backend"),
		},
		mcpServers,
	};
}

function toCredential(session: CellSession): CellStoredCredential {
	return {
		type: "oauth",
		access: session.liteLlm.apiKey,
		refresh: "cell-api-key-exchange-v1",
		expires: Number.MAX_SAFE_INTEGER,
		cellVersion: 1,
		tenantId: session.tenant.id,
		tenantName: session.tenant.name,
		apiKeyId: session.apiKeyId,
		baseUrl: session.liteLlm.baseUrl,
		mcpServers: session.mcpServers,
	};
}

/** Parse CELL metadata from its single stored LiteLLM credential. */
export function cellSessionFromCredential(credential: Credential | undefined): CellSession | undefined {
	if (credential?.type !== "oauth") return undefined;
	const value = credential as OAuthCredential & Record<string, unknown>;
	if (
		value.cellVersion !== 1 ||
		typeof value.tenantId !== "string" ||
		typeof value.tenantName !== "string" ||
		typeof value.apiKeyId !== "string" ||
		typeof value.baseUrl !== "string" ||
		!Array.isArray(value.mcpServers)
	)
		return undefined;
	const mcpServers: CellMcpServer[] = [];
	for (const entry of value.mcpServers) {
		if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.url !== "string") return undefined;
		mcpServers.push({ name: entry.name, url: entry.url });
	}
	return {
		tenant: { id: value.tenantId, name: value.tenantName },
		apiKeyId: value.apiKeyId,
		liteLlm: { baseUrl: value.baseUrl, apiKey: credential.access },
		mcpServers,
	};
}

async function errorDetail(response: Response): Promise<string | undefined> {
	try {
		const body: unknown = await response.json();
		if (!isRecord(body)) return undefined;
		const detail = body.message ?? body.error_description ?? body.error;
		if (typeof detail === "string") return detail;
		return isRecord(detail) && typeof detail.message === "string" ? detail.message : undefined;
	} catch {
		return undefined;
	}
}

/** Owns CELL API-key exchange and the resulting scoped LiteLLM session. */
export class CellAuthService {
	private readonly config: CellConfig;
	private readonly credentials: CredentialStore;

	constructor(config: CellConfig, credentials: CredentialStore) {
		this.config = config;
		this.credentials = credentials;
	}

	private async exchange(apiKey: string, signal: AbortSignal): Promise<CellSession> {
		const deadline = Date.now() + LOGIN_TIMEOUT_MS;
		const endpoint = `${this.config.auth.baseUrl}/v1/login`;
		for (let attempt = 0; ; attempt++) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("CELL login timed out");
			try {
				const response = await fetch(endpoint, {
					method: "POST",
					headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
					signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
				});
				if (response.ok) return parseLoginResponse(await response.json(), this.config);
				if (!RETRYABLE_STATUSES.has(response.status) || attempt === RETRY_DELAYS_MS.length) {
					const detail = await errorDetail(response);
					throw new Error(
						`CELL Auth Backend rejected the API Key (${response.status})${detail ? `: ${detail}` : ""}`,
					);
				}
			} catch (error) {
				if (signal.aborted) signal.throwIfAborted();
				if (!(error instanceof TypeError) || attempt === RETRY_DELAYS_MS.length) throw error;
			}
			await sleep(RETRY_DELAYS_MS[attempt] ?? 1_000, undefined, { signal });
		}
	}

	private async validateLiteLlm(session: CellSession, signal: AbortSignal): Promise<void> {
		const response = await fetch(`${session.liteLlm.baseUrl}/models`, {
			headers: { accept: "application/json", authorization: `Bearer ${session.liteLlm.apiKey}` },
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		});
		if (!response.ok) throw new Error(`LiteLLM rejected the exchanged key (${response.status})`);
		const body: unknown = await response.json();
		if (!isRecord(body) || !Array.isArray(body.data) || body.data.length === 0) {
			throw new Error("LiteLLM returned no models for this API Key");
		}
	}

	/** Exchange a tenant API Key, validate LiteLLM, then atomically replace the old session. */
	async loginWithApiKey(apiKey: string, signal: AbortSignal): Promise<CellSession> {
		const key = apiKey.trim();
		if (!key) throw new Error("API Key must not be empty");
		const session = await this.exchange(key, signal);
		await this.validateLiteLlm(session, signal);
		await this.credentials.modify(CELL_MODEL_CREDENTIAL, async () => toCredential(session), { signal });
		return session;
	}

	/** Interactive login shared by the CLI and `/login`. */
	async login(interaction: AuthInteraction): Promise<CellSession> {
		const signal = interaction.signal ?? new AbortController().signal;
		return this.loginWithApiKey(await interaction.prompt({ type: "secret", message: "CELL API Key" }), signal);
	}

	/** Remove the local LiteLLM key and managed CELL metadata. */
	async logout(signal?: AbortSignal): Promise<void> {
		await this.credentials.delete(CELL_MODEL_CREDENTIAL, { signal });
	}

	/** Return current non-secret tenant and endpoint metadata. */
	async whoami(signal?: AbortSignal): Promise<(Omit<CellSession, "liteLlm"> & { liteLlmUrl: string }) | undefined> {
		const session = cellSessionFromCredential(await this.credentials.read(CELL_MODEL_CREDENTIAL, { signal }));
		return session
			? {
					tenant: session.tenant,
					apiKeyId: session.apiKeyId,
					mcpServers: session.mcpServers,
					liteLlmUrl: session.liteLlm.baseUrl,
				}
			: undefined;
	}

	/** Read the current session without exposing it through normal UI output. */
	async getSession(signal?: AbortSignal): Promise<CellSession | undefined> {
		return cellSessionFromCredential(await this.credentials.read(CELL_MODEL_CREDENTIAL, { signal }));
	}

	/** Read the canonical provider credential after a successful login. */
	async getCredential(signal?: AbortSignal): Promise<OAuthCredential | undefined> {
		const credential = await this.credentials.read(CELL_MODEL_CREDENTIAL, { signal });
		return credential?.type === "oauth" ? credential : undefined;
	}

	/** Read the provisioned LiteLLM key for model and managed MCP requests. */
	async getModelKey(signal?: AbortSignal): Promise<string | undefined> {
		return (await this.getSession(signal))?.liteLlm.apiKey;
	}
}

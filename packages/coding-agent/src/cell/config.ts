// Loads CELL's application-level authentication and model metadata configuration.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";

export interface CellModelMetadata {
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
}

export interface CellGatewayConfig {
	type: "litellm";
	defaultBaseUrl: string;
	defaultModel: string;
	allowDirectProvider: false;
	requestTimeoutMs: number;
	maxRetries: number;
	models: Readonly<Record<string, CellModelMetadata>>;
}

export interface CellAuthConfig {
	baseUrl: string;
	allowedMcpOrigins: readonly string[];
}

export interface CellConfig {
	gateway: CellGatewayConfig;
	auth: CellAuthConfig;
}

const DEFAULT_GATEWAY_URL = "http://litellm.internal:4000/v1";
const DEFAULT_AUTH_URL = "http://cell-auth.internal:4010";

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function parseOrigins(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => new URL(entry).origin);
}

function parseModelMetadata(value: unknown): Readonly<Record<string, CellModelMetadata>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const result: Record<string, CellModelMetadata> = {};
	for (const [id, entry] of Object.entries(value)) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const raw = entry as Record<string, unknown>;
		const input = Array.isArray(raw.input)
			? raw.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
			: undefined;
		result[id] = {
			...(nonEmptyString(raw.name) ? { name: nonEmptyString(raw.name) } : {}),
			...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
			...(input?.length ? { input } : {}),
			...(typeof raw.contextWindow === "number" && raw.contextWindow > 0
				? { contextWindow: raw.contextWindow }
				: {}),
			...(typeof raw.maxTokens === "number" && raw.maxTokens > 0 ? { maxTokens: raw.maxTokens } : {}),
		};
	}
	return result;
}

/** Load CELL's bundled defaults plus optional local model metadata. */
export async function loadCellConfig(path = join(getAgentDir(), "models.json")): Promise<CellConfig> {
	let root: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(stripJsonComments(stripBom(await readFile(path, "utf8"))));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected an object");
		root = parsed as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(
				`Invalid CELL configuration in ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const rawGateway =
		typeof root.gateway === "object" && root.gateway !== null && !Array.isArray(root.gateway)
			? (root.gateway as Record<string, unknown>)
			: {};
	if (rawGateway.type !== undefined && rawGateway.type !== "litellm")
		throw new Error('CELL gateway.type must be "litellm"');
	if (rawGateway.allowDirectProvider === true) throw new Error("CELL does not permit direct provider access");
	const defaultBaseUrl =
		nonEmptyString(rawGateway.baseUrl) ?? process.env.CELL_LITELLM_BASE_URL ?? DEFAULT_GATEWAY_URL;
	return {
		gateway: {
			type: "litellm",
			defaultBaseUrl: defaultBaseUrl.replace(/\/+$/u, ""),
			defaultModel: nonEmptyString(rawGateway.defaultModel) ?? "cell-default",
			allowDirectProvider: false,
			requestTimeoutMs: positiveInteger(rawGateway.requestTimeoutMs, 60_000),
			maxRetries: nonNegativeInteger(rawGateway.maxRetries, 2),
			models: parseModelMetadata(rawGateway.models),
		},
		auth: {
			baseUrl: (process.env.CELL_AUTH_URL ?? DEFAULT_AUTH_URL).replace(/\/+$/u, ""),
			allowedMcpOrigins: parseOrigins(process.env.CELL_MCP_ALLOWED_ORIGINS),
		},
	};
}

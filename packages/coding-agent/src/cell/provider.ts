// LiteLLM-only model provider for CELL.

import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	type Model,
	type Provider,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { CellAuthService } from "./auth-service.ts";
import type { CellConfig, CellModelMetadata } from "./config.ts";

interface LiteLlmModelEntry {
	id: string;
}

function modelEntry(value: unknown): LiteLlmModelEntry | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const id = (value as Record<string, unknown>).id;
	return typeof id === "string" && id ? { id } : undefined;
}

function toModel(id: string, metadata: CellModelMetadata | undefined, baseUrl: string): Model<"openai-completions"> {
	return {
		id,
		name: metadata?.name ?? id,
		api: "openai-completions",
		provider: "litellm",
		baseUrl,
		reasoning: metadata?.reasoning ?? false,
		input: metadata?.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: metadata?.contextWindow ?? 128_000,
		maxTokens: metadata?.maxTokens ?? 16_384,
	};
}

function clearLoginOnUnauthorized(
	upstream: AssistantMessageEventStream,
	authService: CellAuthService,
): AssistantMessageEventStream {
	const forwarded = createAssistantMessageEventStream();
	void (async () => {
		for await (const event of upstream) {
			forwarded.push(event);
			if (event.type === "error" && /(?:\b401\b|unauthori[sz]ed)/iu.test(event.error.errorMessage ?? "")) {
				void authService.logout().catch(() => undefined);
			}
		}
		forwarded.end();
	})();
	return forwarded;
}

/** Create CELL's only model provider. Every request uses the configured LiteLLM base URL. */
export function createCellLiteLlmProvider(
	config: CellConfig,
	authService: CellAuthService,
): Provider<"openai-completions"> {
	const { gateway } = config;
	const streams = openAICompletionsApi();
	const gatewayStreams: ProviderStreams = {
		stream: (model, context, options) =>
			clearLoginOnUnauthorized(
				streams.stream(model, context, {
					...options,
					timeoutMs: options?.timeoutMs ?? gateway.requestTimeoutMs,
					maxRetries: options?.maxRetries ?? gateway.maxRetries,
				}),
				authService,
			),
		streamSimple: (model, context, options) =>
			clearLoginOnUnauthorized(
				streams.streamSimple(model, context, {
					...options,
					timeoutMs: options?.timeoutMs ?? gateway.requestTimeoutMs,
					maxRetries: options?.maxRetries ?? gateway.maxRetries,
				}),
				authService,
			),
	};
	return createProvider({
		id: "litellm",
		name: "CELL Model Gateway",
		baseUrl: gateway.defaultBaseUrl,
		auth: {
			oauth: {
				name: "CELL API Key",
				loginLabel: "Sign in to CELL",
				login: async (interaction) => {
					await authService.login(interaction);
					const credential = await authService.getCredential(interaction.signal);
					if (!credential) throw new Error("CELL login did not provision model access");
					return credential;
				},
				refresh: async (credential) => credential,
				toAuth: async (credential) => {
					const baseUrl = typeof credential.baseUrl === "string" ? credential.baseUrl : gateway.defaultBaseUrl;
					return { apiKey: credential.access, baseUrl };
				},
			},
		},
		models: [],
		fetchModels: async (context) => {
			const key = context.credential?.type === "oauth" ? context.credential.access : undefined;
			if (!key) return [];
			const baseUrl =
				context.credential?.type === "oauth" && typeof context.credential.baseUrl === "string"
					? context.credential.baseUrl
					: gateway.defaultBaseUrl;
			const response = await fetch(`${baseUrl}/models`, {
				headers: { accept: "application/json", authorization: `Bearer ${key}` },
				signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
			});
			if (!response.ok) {
				if (response.status === 401) await authService.logout(context.signal);
				throw new Error(`LiteLLM model discovery failed (${response.status})`);
			}
			const body: unknown = await response.json();
			if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
				throw new Error("LiteLLM returned an invalid model list");
			}
			const ids = body.data.flatMap((item) => {
				const entry = modelEntry(item);
				return entry ? [entry.id] : [];
			});
			ids.sort((left, right) => {
				if (left === gateway.defaultModel) return -1;
				if (right === gateway.defaultModel) return 1;
				return left.localeCompare(right);
			});
			return ids.map((id) => toModel(id, gateway.models[id], baseUrl));
		},
		api: gatewayStreams,
	});
}

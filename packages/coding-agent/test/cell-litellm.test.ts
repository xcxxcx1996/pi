import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CellAuthService } from "../src/cell/auth-service.ts";
import type { CellConfig } from "../src/cell/config.ts";
import { createCellLiteLlmProvider } from "../src/cell/provider.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

interface MockState {
	chatRequests: number;
	mode: "stream" | "timeout" | "unauthorized";
}

let server: Server | undefined;

afterEach(async () => {
	if (!server) return;
	server.closeAllConnections();
	server.close();
	await once(server, "close");
	server = undefined;
});

async function mockLiteLlm(): Promise<{ baseUrl: string; state: MockState }> {
	const state: MockState = { chatRequests: 0, mode: "stream" };
	server = createServer((request, response) => {
		if (request.headers.authorization !== "Bearer user-key") {
			response.writeHead(401).end('{"error":"unauthorized"}');
			return;
		}
		if (request.url === "/v1/models") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ data: [{ id: "other" }, { id: "cell-default" }] }));
			return;
		}
		if (request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		state.chatRequests++;
		if (state.mode === "unauthorized") {
			response.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
			return;
		}
		if (state.mode === "timeout") {
			setTimeout(() => response.writeHead(504).end(), 200);
			return;
		}
		if (state.chatRequests === 1) {
			response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
			response.end('{"error":{"message":"slow down"}}');
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		const chunks = [
			{
				id: "chatcmpl-cell",
				object: "chat.completion.chunk",
				created: 0,
				model: "cell-default",
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call-1",
									type: "function",
									function: { name: "read", arguments: '{"path":"README.md"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-cell",
				object: "chat.completion.chunk",
				created: 0,
				model: "cell-default",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
			},
		];
		for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return { baseUrl: `http://127.0.0.1:${port}/v1`, state };
}

function config(baseUrl: string, timeout = 1000): CellConfig {
	return {
		gateway: {
			type: "litellm",
			defaultBaseUrl: baseUrl,
			defaultModel: "cell-default",
			allowDirectProvider: false,
			requestTimeoutMs: timeout,
			maxRetries: 1,
			models: { "cell-default": { reasoning: true, contextWindow: 32_000, maxTokens: 4096 } },
		},
		auth: { baseUrl: "https://auth.example", allowedMcpOrigins: [] },
	};
}

function credential(baseUrl: string, key: string) {
	return {
		type: "oauth" as const,
		access: key,
		refresh: "cell-api-key-exchange-v1",
		expires: Number.MAX_SAFE_INTEGER,
		cellVersion: 1,
		tenantId: "tenant-1",
		tenantName: "Tenant One",
		apiKeyId: "api-key-1",
		baseUrl,
		mcpServers: [],
	};
}

async function runtime(baseUrl: string, key = "user-key", timeout = 1000): Promise<ModelRuntime> {
	const credentials = AuthStorage.inMemory({ litellm: credential(baseUrl, key) });
	const cellConfig = config(baseUrl, timeout);
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		providers: [createCellLiteLlmProvider(cellConfig, new CellAuthService(cellConfig, credentials))],
		refreshOnCreate: false,
	});
	await modelRuntime.refresh({ allowNetwork: true });
	return modelRuntime;
}

describe("CELL LiteLLM gateway", () => {
	it("discovers models, retries 429, streams tool calls, and preserves usage", async () => {
		const mock = await mockLiteLlm();
		const modelRuntime = await runtime(mock.baseUrl);
		const model = modelRuntime.getAvailableSnapshot()[0];
		expect(model).toMatchObject({ id: "cell-default", provider: "litellm", baseUrl: mock.baseUrl });
		if (!model) throw new Error("model missing");

		const result = await modelRuntime.completeSimple(model, { messages: [] });
		expect(mock.state.chatRequests).toBe(2);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "toolCall", name: "read", arguments: { path: "README.md" } }),
		);
		expect(result.usage).toMatchObject({ input: 3, output: 4, totalTokens: 7 });
	});

	it("does not fall back when LiteLLM rejects authentication", async () => {
		const mock = await mockLiteLlm();
		const credentials = AuthStorage.inMemory({ litellm: credential(mock.baseUrl, "wrong-key") });
		const cellConfig = config(mock.baseUrl);
		const modelRuntime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			providers: [createCellLiteLlmProvider(cellConfig, new CellAuthService(cellConfig, credentials))],
			refreshOnCreate: false,
		});
		const refresh = await modelRuntime.refresh({ allowNetwork: true });
		expect(modelRuntime.getProviders().map((provider) => provider.id)).toEqual(["litellm"]);
		expect(modelRuntime.getAvailableSnapshot()).toEqual([]);
		expect(refresh.errors.get("litellm")?.message).toContain("401");
		expect(await credentials.read("litellm")).toBeUndefined();
	});

	it("applies the configured gateway timeout", async () => {
		const mock = await mockLiteLlm();
		const modelRuntime = await runtime(mock.baseUrl, "user-key", 25);
		const model = modelRuntime.getAvailableSnapshot()[0];
		if (!model) throw new Error("model missing");
		mock.state.mode = "timeout";
		const result = await modelRuntime.completeSimple(model, { messages: [] });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage?.toLowerCase()).toContain("timed out");
	});

	it("clears the local login when a model request returns 401", async () => {
		const mock = await mockLiteLlm();
		const credentials = AuthStorage.inMemory({ litellm: credential(mock.baseUrl, "user-key") });
		const cellConfig = config(mock.baseUrl);
		const modelRuntime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			providers: [createCellLiteLlmProvider(cellConfig, new CellAuthService(cellConfig, credentials))],
			refreshOnCreate: false,
		});
		await modelRuntime.refresh({ allowNetwork: true });
		const model = modelRuntime.getAvailableSnapshot()[0];
		if (!model) throw new Error("model missing");
		mock.state.mode = "unauthorized";

		const result = await modelRuntime.completeSimple(model, { messages: [] });
		await vi.waitFor(async () => expect(await credentials.read("litellm")).toBeUndefined());
		expect(result.stopReason).toBe("error");
	});
});

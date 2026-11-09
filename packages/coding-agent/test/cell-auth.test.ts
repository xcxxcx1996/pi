import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CellAuthService } from "../src/cell/auth-service.ts";
import type { CellConfig } from "../src/cell/config.ts";
import { withCellManagedMcpServers } from "../src/cell/managed-mcp.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";

const config: CellConfig = {
	gateway: {
		type: "litellm",
		defaultBaseUrl: "https://fallback.example/v1",
		defaultModel: "cell-default",
		allowDirectProvider: false,
		requestTimeoutMs: 60_000,
		maxRetries: 2,
		models: {},
	},
	auth: { baseUrl: "https://auth.example", allowedMcpOrigins: [] },
};

function loginResponse(apiKey = "litellm-user-key") {
	return {
		version: 1,
		tenant: { id: "tenant-1", name: "Tenant One" },
		api_key_id: "api-key-1",
		litellm: { base_url: "https://litellm.example/v1", api_key: apiKey },
		mcp_servers: [{ name: "litellm-upload", url: "https://litellm.example/upload_file/mcp" }],
	};
}

afterEach(() => vi.restoreAllMocks());

describe("CELL authentication", () => {
	it("exchanges a tenant API Key and stores only the LiteLLM session metadata", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		fetch.mockResolvedValueOnce(Response.json(loginResponse()));
		fetch.mockResolvedValueOnce(Response.json({ data: [{ id: "cell-default" }] }));
		const credentials = AuthStorage.inMemory();
		const service = new CellAuthService(config, credentials);

		await service.loginWithApiKey("tenant-secret", AbortSignal.timeout(1000));

		expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer tenant-secret" });
		expect(await service.whoami()).toMatchObject({
			tenant: { id: "tenant-1", name: "Tenant One" },
			apiKeyId: "api-key-1",
			liteLlmUrl: "https://litellm.example/v1",
		});
		expect(await credentials.read("litellm")).toMatchObject({
			type: "oauth",
			access: "litellm-user-key",
			baseUrl: "https://litellm.example/v1",
		});
		expect(JSON.stringify(await credentials.read("litellm"))).not.toContain("tenant-secret");
	});

	it("preserves the old login when the new LiteLLM key fails validation", async () => {
		const old = {
			type: "oauth" as const,
			access: "old-key",
			refresh: "cell-api-key-exchange-v1",
			expires: Number.MAX_SAFE_INTEGER,
			cellVersion: 1,
			tenantId: "old-tenant",
			tenantName: "Old Tenant",
			apiKeyId: "old-record",
			baseUrl: "https://litellm.example/v1",
			mcpServers: [],
		};
		const credentials = AuthStorage.inMemory({ litellm: old });
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(Response.json(loginResponse("bad-key")))
			.mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 }));
		const service = new CellAuthService(config, credentials);

		await expect(service.loginWithApiKey("new-tenant-key", AbortSignal.timeout(1000))).rejects.toThrow("401");
		expect(await credentials.read("litellm")).toEqual(old);
	});

	it("does not read a fake Pi credential from HOME", () => {
		const home = mkdtempSync(join(tmpdir(), "cell-home-"));
		try {
			const piDir = join(home, ".pi", "agent");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "auth.json"),
				JSON.stringify({ litellm: { type: "api_key", key: "fake-pi-token" } }),
			);
			const repo = resolve(import.meta.dirname, "../../..");
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					join(repo, "packages/coding-agent/src/experimental/source-resolver.ts"),
					join(repo, "packages/coding-agent/src/cell-cli.ts"),
					"whoami",
				],
				{ cwd: repo, encoding: "utf8", env: { ...process.env, HOME: home, CELL_HOME: join(home, ".cell") } },
			);
			expect(result.stdout).toContain("Not logged in to CELL.");
			expect(result.stdout).not.toContain("fake-pi-token");
			expect(result.status).toBe(1);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("injects managed MCP authentication and rejects user entries in the reserved namespace", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "cell-agent-"));
		try {
			const credentials = AuthStorage.create(join(agentDir, "auth.json"));
			await credentials.modify("litellm", async () => ({
				type: "oauth",
				access: "virtual-key",
				refresh: "cell-api-key-exchange-v1",
				expires: Number.MAX_SAFE_INTEGER,
				cellVersion: 1,
				tenantId: "tenant-1",
				tenantName: "Tenant One",
				apiKeyId: "api-key-1",
				baseUrl: "https://litellm.example/v1",
				mcpServers: [{ name: "litellm-upload", url: "https://litellm.example/upload_file/mcp" }],
			}));
			const loaded = withCellManagedMcpServers(
				{
					servers: [
						{
							name: "litellm-user-defined",
							config: { url: "https://attacker.example/mcp" },
							source: "/project/.cell/mcp.json",
						},
					],
					errors: [],
				},
				agentDir,
			);

			expect(loaded.servers).toEqual([
				expect.objectContaining({
					name: "litellm-upload",
					config: expect.objectContaining({
						headers: { "x-litellm-api-key": "Bearer virtual-key" },
						enabled: true,
						exposure: "direct",
					}),
				}),
			]);
			expect(loaded.errors[0]).toContain("reserved CELL namespace");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

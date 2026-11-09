// Builds CELL-managed LiteLLM MCP entries from the atomic login credential.

import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { readStoredCredential } from "../core/auth-storage.ts";
import type { LoadedMcpConfig, McpServerEntry } from "../extensions/mcp/config.ts";
import { CELL_MODEL_CREDENTIAL, cellSessionFromCredential } from "./auth-service.ts";

const MANAGED_PREFIX = "litellm-";

/** Reserve the litellm-* namespace and add authenticated servers returned by CELL login. */
export function withCellManagedMcpServers(loaded: LoadedMcpConfig, agentDir = getAgentDir()): LoadedMcpConfig {
	const rejected = loaded.servers.filter((entry) => entry.name.startsWith(MANAGED_PREFIX));
	const session = cellSessionFromCredential(readStoredCredential(CELL_MODEL_CREDENTIAL, join(agentDir, "auth.json")));
	const managed: McpServerEntry[] = (session?.mcpServers ?? []).map((server) => ({
		name: server.name,
		config: {
			url: server.url,
			headers: { "x-litellm-api-key": `Bearer ${session?.liteLlm.apiKey ?? ""}` },
			enabled: true,
			exposure: "direct",
		},
		source: "builtin:CELL",
		scope: "extension",
	}));
	return {
		...loaded,
		servers: [...loaded.servers.filter((entry) => !entry.name.startsWith(MANAGED_PREFIX)), ...managed],
		errors: [
			...loaded.errors,
			...rejected.map(
				(entry) => `${entry.source}: server "${entry.name}" uses the reserved CELL namespace "litellm-*"`,
			),
		],
	};
}

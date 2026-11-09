// CELL login, logout, and identity CLI commands.

import { join } from "node:path";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { createProcessLoginTerminal } from "../cli/auth-terminal.ts";
import { getAgentDir } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { CellAuthService } from "./auth-service.ts";
import { loadCellConfig } from "./config.ts";

function usage(command: string): string {
	return command === "login" ? "Usage: cell login [--api-key-stdin]" : `Usage: cell ${command}`;
}

async function loginInteractively(
	service: CellAuthService,
	controller: AbortController,
	interrupt: () => void,
): Promise<void> {
	const terminal = createProcessLoginTerminal(interrupt);
	if (!terminal.interactive) throw new Error('CELL requires a login. Run "cell login --api-key-stdin" first.');
	const interaction: AuthInteraction = {
		signal: controller.signal,
		prompt(prompt: AuthPrompt): Promise<string> {
			const placeholder = "placeholder" in prompt ? prompt.placeholder : undefined;
			const message = `${prompt.message}${placeholder ? ` (${placeholder})` : ""}: `;
			return prompt.type === "secret"
				? terminal.secret(message, prompt.signal ?? controller.signal)
				: terminal.question(message, prompt.signal ?? controller.signal);
		},
		notify: (event) => {
			if (event.type === "info" || event.type === "progress") terminal.write(event.message);
		},
	};
	await service.login(interaction);
}

/** Require a CELL login before normal startup, prompting only in interactive mode. */
export async function ensureCellLogin(interactive: boolean): Promise<void> {
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.on("SIGINT", interrupt);
	try {
		const agentDir = getAgentDir();
		const service = new CellAuthService(
			await loadCellConfig(join(agentDir, "models.json")),
			AuthStorage.create(join(agentDir, "auth.json")),
		);
		if (await service.whoami(controller.signal)) return;
		if (!interactive) throw new Error('CELL requires a login. Run "cell login --api-key-stdin" first.');
		await loginInteractively(service, controller, interrupt);
		console.log("Logged in to CELL.");
	} finally {
		process.off("SIGINT", interrupt);
	}
}

/** Handle a CELL authentication command, or return false for normal startup. */
export async function runCellCommand(args: string[]): Promise<boolean> {
	const command = args[0];
	if (command !== "login" && command !== "logout" && command !== "whoami" && command !== "auth") return false;
	if (command === "auth") {
		console.error('CELL does not expose provider authentication. Use "cell login", "cell logout", or "cell whoami".');
		process.exitCode = 1;
		return true;
	}

	const apiKeyStdin = args[1] === "--api-key-stdin";
	if ((command === "login" && args.length > (apiKeyStdin ? 2 : 1)) || (command !== "login" && args.length !== 1)) {
		console.error(usage(command));
		process.exitCode = 1;
		return true;
	}
	if (command === "login" && args[1] !== undefined && !apiKeyStdin) {
		console.error(usage(command));
		process.exitCode = 1;
		return true;
	}

	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.on("SIGINT", interrupt);
	try {
		const agentDir = getAgentDir();
		const service = new CellAuthService(
			await loadCellConfig(join(agentDir, "models.json")),
			AuthStorage.create(join(agentDir, "auth.json")),
		);
		if (command === "logout") {
			await service.logout(controller.signal);
			console.log("Logged out of CELL.");
			return true;
		}
		if (command === "whoami") {
			const identity = await service.whoami(controller.signal);
			if (!identity) {
				console.log("Not logged in to CELL.");
				process.exitCode = 1;
			} else {
				console.log(`Tenant: ${identity.tenant.name} (${identity.tenant.id})`);
				console.log(`API Key record: ${identity.apiKeyId}`);
				console.log(`LiteLLM: ${identity.liteLlmUrl}`);
			}
			return true;
		}
		if (apiKeyStdin) {
			process.stdin.setEncoding("utf8");
			let apiKey = "";
			for await (const chunk of process.stdin) apiKey += chunk;
			await service.loginWithApiKey(apiKey, controller.signal);
			console.log("Logged in to CELL.");
			return true;
		}

		await loginInteractively(service, controller, interrupt);
		console.log("Logged in to CELL.");
		return true;
	} catch (error) {
		console.error(`CELL authentication failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
		return true;
	} finally {
		process.off("SIGINT", interrupt);
	}
}

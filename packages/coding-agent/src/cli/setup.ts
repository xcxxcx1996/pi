import { APP_NAME, IS_CELL_APP } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";

export function setupCli(): void {
	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = IS_CELL_APP ? "cell" : "pi";
	if (IS_CELL_APP) {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		process.env.PI_TELEMETRY = "0";
	}
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	configureHttpDispatcher();
}

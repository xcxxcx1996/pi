#!/usr/bin/env node
// CELL entry point: set product identity before loading any shared runtime module.

process.env.CELL_AGENT_RUNTIME = "1";

const [{ setupCli }, { main }] = await Promise.all([import("./cli/setup.ts"), import("./main.ts")]);

setupCli();
await main(process.argv.slice(2));

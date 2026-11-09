// Deterministic OpenAI-compatible upstream used behind the real LiteLLM proxy.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const port = Number(process.env.PORT ?? "8080");
const apiKey = process.env.MOCK_OPENAI_API_KEY ?? "cell-local-upstream-key";

function json(response, status, body) {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

async function readJson(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function completion(body) {
	const tool = Array.isArray(body.tools) ? body.tools[0]?.function : undefined;
	const message = tool
		? {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_cell_docker",
						type: "function",
						function: { name: tool.name, arguments: '{"path":"README.md"}' },
					},
				],
			}
		: { role: "assistant", content: "CELL Docker integration is working." };
	return {
		id: `chatcmpl-${randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: "cell-test",
		choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
		usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
	};
}

function streamCompletion(response, body) {
	const result = completion(body);
	response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
	const message = result.choices[0].message;
	const delta = message.tool_calls
		? { role: "assistant", tool_calls: message.tool_calls.map((tool, index) => ({ ...tool, index })) }
		: { role: "assistant", content: message.content };
	response.write(
		`data: ${JSON.stringify({ ...result, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }], usage: undefined })}\n\n`,
	);
	response.write(
		`data: ${JSON.stringify({ ...result, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: result.choices[0].finish_reason }] })}\n\n`,
	);
	response.end("data: [DONE]\n\n");
}

const server = createServer(async (request, response) => {
	if (request.url === "/health") {
		json(response, 200, { status: "ok" });
		return;
	}
	if (request.headers.authorization !== `Bearer ${apiKey}`) {
		json(response, 401, { error: { message: "invalid mock upstream key" } });
		return;
	}
	if (request.method === "GET" && request.url === "/v1/models") {
		json(response, 200, { object: "list", data: [{ id: "cell-test", object: "model" }] });
		return;
	}
	if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
		json(response, 404, { error: { message: "not found" } });
		return;
	}
	try {
		const body = await readJson(request);
		if (body.stream === true) streamCompletion(response, body);
		else json(response, 200, completion(body));
	} catch {
		json(response, 400, { error: { message: "invalid request" } });
	}
});

server.listen(port, "0.0.0.0", () => console.log(`Mock OpenAI upstream listening on ${port}`));

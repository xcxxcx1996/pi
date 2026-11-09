// Exposes a stateless Streamable HTTP MCP tool that saves uploaded files to a mounted directory.

import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const port = Number(process.env.PORT ?? "8080");
const uploadDirectory = process.env.UPLOAD_DIRECTORY ?? "/data/uploads";
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES ?? String(10 * 1024 * 1024));

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid port number");
if (!Number.isInteger(maxUploadBytes) || maxUploadBytes < 1) {
	throw new Error("MAX_UPLOAD_BYTES must be a positive integer");
}

function sendJson(response, status, body) {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"x-content-type-options": "nosniff",
	});
	response.end(JSON.stringify(body));
}

function rpcResult(response, id, result) {
	sendJson(response, 200, { jsonrpc: "2.0", id, result });
}

function rpcError(response, id, code, message, status = 200) {
	sendJson(response, status, { jsonrpc: "2.0", id, error: { code, message } });
}

async function readJson(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > maxUploadBytes * 2) throw new Error("request_too_large");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function decodeBase64(value) {
	if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
		throw new Error("base64_content must be valid Base64");
	}
	const content = Buffer.from(value, "base64");
	if (content.length > maxUploadBytes) throw new Error(`file exceeds the ${maxUploadBytes}-byte limit`);
	return content;
}

async function uploadFile(argumentsValue) {
	const filename = argumentsValue?.filename;
	if (typeof filename !== "string" || !filename.trim()) throw new Error("filename is required");
	const safeName = basename(filename.trim());
	if (safeName === "." || safeName === ".." || safeName !== filename.trim() || safeName.includes("\0")) {
		throw new Error("filename must not contain a directory path");
	}

	const content = decodeBase64(argumentsValue.base64_content);
	await mkdir(uploadDirectory, { recursive: true });
	const destination = join(uploadDirectory, safeName);
	await writeFile(destination, content, { flag: "wx", mode: 0o600 });
	return {
		content: [{ type: "text", text: `Uploaded ${safeName} (${content.length} bytes) to ${destination}` }],
		structuredContent: { filename: safeName, bytes: content.length, path: destination },
	};
}

const tools = [
	{
		name: "upload_file",
		title: "Upload local file",
		description: "Save a Base64-encoded file in the MCP server upload directory. Existing files are not overwritten.",
		inputSchema: {
			type: "object",
			properties: {
				filename: { type: "string", description: "Destination filename without a directory path" },
				base64_content: { type: "string", description: "Complete file content encoded as Base64" },
			},
			required: ["filename", "base64_content"],
			additionalProperties: false,
		},
	},
];

const server = createServer(async (request, response) => {
	if (request.method === "GET" && request.url === "/health") {
		sendJson(response, 200, { status: "ok" });
		return;
	}
	if (request.method !== "POST" || request.url !== "/mcp") {
		sendJson(response, 404, { error: "not_found" });
		return;
	}

	let message;
	try {
		message = await readJson(request);
	} catch (error) {
		const tooLarge = error instanceof Error && error.message === "request_too_large";
		rpcError(response, null, -32700, tooLarge ? "Request body is too large" : "Invalid JSON", tooLarge ? 413 : 400);
		return;
	}

	const id = message?.id ?? null;
	if (message?.jsonrpc !== "2.0" || typeof message?.method !== "string") {
		rpcError(response, id, -32600, "Invalid Request", 400);
		return;
	}
	if (message.id === undefined) {
		response.writeHead(202).end();
		return;
	}

	if (message.method === "initialize") {
		rpcResult(response, id, {
			protocolVersion: "2025-06-18",
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: "upload-mcp", version: "1.0.0" },
			instructions: "Use upload_file with a plain filename and Base64-encoded file content.",
		});
		return;
	}
	if (message.method === "ping") {
		rpcResult(response, id, {});
		return;
	}
	if (message.method === "tools/list") {
		rpcResult(response, id, { tools });
		return;
	}
	if (message.method === "tools/call") {
		if (message.params?.name !== "upload_file") {
			rpcError(response, id, -32602, "Unknown tool");
			return;
		}
		try {
			rpcResult(response, id, await uploadFile(message.params.arguments));
		} catch (error) {
			const messageText = error instanceof Error ? error.message : String(error);
			rpcResult(response, id, { content: [{ type: "text", text: messageText }], isError: true });
		}
		return;
	}

	rpcError(response, id, -32601, "Method not found");
});

server.listen(port, "0.0.0.0", () => {
	console.log(`Upload MCP listening on http://0.0.0.0:${port}/mcp`);
});

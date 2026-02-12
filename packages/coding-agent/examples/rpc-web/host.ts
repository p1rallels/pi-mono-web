/**
 * RPC Web Host Example
 *
 * Runs a lightweight HTTP server that:
 * - serves a browser client (static files under ./public)
 * - spawns pi in RPC mode per browser session
 * - bridges JSON-RPC commands from browser to pi stdin
 * - streams pi events/responses via SSE
 *
 * Usage:
 *   cd packages/coding-agent
 *   npx tsx examples/rpc-web/host.ts
 */

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "../../src/modes/rpc/rpc-types.js";

interface StartSessionRequest {
	provider?: string;
	modelId?: string;
	cwd?: string;
	noSession?: boolean;
	loadRpcDemoExtension?: boolean;
	extraExtensions?: string[];
}

interface StopResult {
	ok: true;
}

type HostToClientEvent =
	| { type: "session_started"; sessionId: string }
	| { type: "rpc_response"; sessionId: string; response: RpcResponse }
	| { type: "agent_event"; sessionId: string; event: AgentEvent }
	| { type: "extension_ui_request"; sessionId: string; request: RpcExtensionUIRequest }
	| { type: "stderr"; sessionId: string; text: string }
	| { type: "session_error"; sessionId: string; message: string }
	| { type: "session_stopped"; sessionId: string; code: number | null; signal: NodeJS.Signals | null };

interface RpcSession {
	id: string;
	child: ChildProcessWithoutNullStreams;
	rl: ReadlineInterface;
	clients: Set<ServerResponse>;
	heartbeat: Map<ServerResponse, NodeJS.Timeout>;
	idleTimer?: NodeJS.Timeout;
	stopped: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..", "..");
const publicDir = join(__dirname, "public");
const defaultRpcDemoExtension = join(packageRoot, "examples", "extensions", "rpc-demo.ts");

const host = process.env.PI_RPC_WEB_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PI_RPC_WEB_PORT || "4317", 10);
const sessions = new Map<string, RpcSession>();
const rpcCommandTypes: ReadonlySet<RpcCommand["type"]> = new Set([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"new_session",
	"get_state",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"compact",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"fork",
	"get_fork_messages",
	"get_last_assistant_text",
	"set_session_name",
	"get_messages",
	"get_commands",
]);

function safeJson(res: ServerResponse, statusCode: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(data);
}

function withCors(res: ServerResponse): void {
	res.setHeader("access-control-allow-origin", "*");
	res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
	res.setHeader("access-control-allow-headers", "content-type");
}

async function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];

		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new Error("Request too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", reject);
	});
}

function sendSse(res: ServerResponse, event: HostToClientEvent): void {
	res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(session: RpcSession, event: HostToClientEvent): void {
	for (const client of session.clients) {
		sendSse(client, event);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isRpcResponse(value: unknown): value is RpcResponse {
	if (!isRecord(value)) return false;
	return value.type === "response" && typeof value.command === "string" && typeof value.success === "boolean";
}

function isExtensionUIRequest(value: unknown): value is RpcExtensionUIRequest {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_request" && typeof value.id === "string" && typeof value.method === "string";
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!isRecord(value)) return false;
	return typeof value.type === "string" && value.type !== "response" && value.type !== "extension_ui_request";
}

function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value)) return false;
	if (value.type !== "extension_ui_response" || typeof value.id !== "string") return false;
	return "value" in value || "confirmed" in value || value.cancelled === true;
}

function isRpcCommand(value: unknown): value is RpcCommand {
	if (!isRecord(value)) return false;
	if (typeof value.type !== "string") return false;
	return rpcCommandTypes.has(value.type as RpcCommand["type"]);
}

function isRpcInput(value: unknown): value is RpcCommand | RpcExtensionUIResponse {
	return isRpcCommand(value) || isRpcExtensionUIResponse(value);
}

function ensureExecutable(): { cmd: string; args: string[] } {
	const hasPi =
		process.platform === "win32"
			? spawnSync("where", ["pi"], { stdio: "ignore" }).status === 0
			: spawnSync("which", ["pi"], { stdio: "ignore" }).status === 0;
	if (hasPi) {
		return { cmd: "pi", args: [] };
	}

	const distCli = join(packageRoot, "dist", "cli.js");
	if (existsSync(distCli)) {
		return { cmd: process.execPath, args: [distCli] };
	}

	// Fallback for source checkout without build artifacts.
	const npx = process.platform === "win32" ? "npx.cmd" : "npx";
	const srcCli = join(packageRoot, "src", "cli.ts");
	return { cmd: npx, args: ["--yes", "tsx", srcCli] };
}

function buildStartArgs(request: StartSessionRequest): { cmd: string; args: string[]; cwd: string } {
	const { cmd, args: baseArgs } = ensureExecutable();
	const args = [...baseArgs, "--mode", "rpc"];

	if (request.provider) {
		args.push("--provider", request.provider);
	}
	if (request.modelId) {
		args.push("--model", request.modelId);
	}

	const noSession = request.noSession ?? true;
	if (noSession) {
		args.push("--no-session");
	}

	const extensions: string[] = [];
	if ((request.loadRpcDemoExtension ?? true) && existsSync(defaultRpcDemoExtension)) {
		extensions.push(defaultRpcDemoExtension);
	}
	if (request.extraExtensions) {
		for (const ext of request.extraExtensions) {
			if (typeof ext === "string" && ext.length > 0) {
				extensions.push(ext);
			}
		}
	}
	for (const ext of extensions) {
		args.push("--extension", ext);
	}

	const cwd = request.cwd && request.cwd.length > 0 ? request.cwd : process.cwd();
	return { cmd, args, cwd };
}

function clearIdleTimer(session: RpcSession): void {
	if (session.idleTimer) {
		clearTimeout(session.idleTimer);
		session.idleTimer = undefined;
	}
}

function scheduleIdleStop(session: RpcSession): void {
	clearIdleTimer(session);
	session.idleTimer = setTimeout(() => {
		void stopSession(session.id, "idle timeout");
	}, 30_000);
}

async function stopSession(sessionId: string, reason: string): Promise<StopResult> {
	const session = sessions.get(sessionId);
	if (!session) {
		return { ok: true };
	}
	if (session.stopped) {
		return { ok: true };
	}
	session.stopped = true;

	clearIdleTimer(session);
	broadcast(session, { type: "session_error", sessionId, message: `Stopping session: ${reason}` });

	for (const [client, timer] of session.heartbeat.entries()) {
		clearInterval(timer);
		client.end();
	}
	session.heartbeat.clear();
	session.clients.clear();
	session.rl.close();

	if (session.child.exitCode === null && !session.child.killed) {
		session.child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const killTimer = setTimeout(() => {
				if (session.child.exitCode === null && !session.child.killed) {
					session.child.kill("SIGKILL");
				}
				resolve();
			}, 2000);

			session.child.once("exit", () => {
				clearTimeout(killTimer);
				resolve();
			});
		});
	}

	sessions.delete(sessionId);
	return { ok: true };
}

function createSession(request: StartSessionRequest): { sessionId: string } {
	const { cmd, args, cwd } = buildStartArgs(request);
	const child = spawn(cmd, args, {
		cwd,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const rl = createInterface({ input: child.stdout, terminal: false });
	const sessionId = randomUUID();
	const session: RpcSession = {
		id: sessionId,
		child,
		rl,
		clients: new Set(),
		heartbeat: new Map(),
		stopped: false,
	};

	sessions.set(sessionId, session);

	rl.on("line", (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			broadcast(session, { type: "session_error", sessionId, message: `Invalid JSON from agent: ${line}` });
			return;
		}

		if (isRpcResponse(parsed)) {
			broadcast(session, { type: "rpc_response", sessionId, response: parsed });
			return;
		}
		if (isExtensionUIRequest(parsed)) {
			broadcast(session, { type: "extension_ui_request", sessionId, request: parsed });
			return;
		}
		if (isAgentEvent(parsed)) {
			broadcast(session, { type: "agent_event", sessionId, event: parsed });
			return;
		}

		broadcast(session, {
			type: "session_error",
			sessionId,
			message: `Unknown stdout payload from agent: ${line.slice(0, 240)}`,
		});
	});

	child.stderr.on("data", (chunk: Buffer) => {
		broadcast(session, { type: "stderr", sessionId, text: chunk.toString("utf8") });
	});

	child.on("exit", (code, signal) => {
		if (!session.stopped) {
			broadcast(session, {
				type: "session_stopped",
				sessionId,
				code,
				signal,
			});
		}

		for (const [client, timer] of session.heartbeat.entries()) {
			clearInterval(timer);
			client.end();
		}
		session.heartbeat.clear();
		session.clients.clear();
		sessions.delete(sessionId);
	});

	return { sessionId };
}

function attachSse(session: RpcSession, res: ServerResponse): void {
	clearIdleTimer(session);

	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
	});
	res.write("\n");
	session.clients.add(res);
	sendSse(res, { type: "session_started", sessionId: session.id });

	const heartbeat = setInterval(() => {
		res.write(": ping\n\n");
	}, 15_000);
	session.heartbeat.set(res, heartbeat);

	const cleanup = () => {
		clearInterval(heartbeat);
		session.heartbeat.delete(res);
		session.clients.delete(res);
		if (session.clients.size === 0) {
			scheduleIdleStop(session);
		}
	};
	res.on("close", cleanup);
	res.on("error", cleanup);
}

async function serveStatic(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
	try {
		const bytes = await readFile(filePath);
		res.writeHead(200, { "content-type": contentType });
		res.end(bytes);
	} catch {
		res.writeHead(404);
		res.end("Not found");
	}
}

function parseSessionPath(urlPath: string): { sessionId: string; action: "events" | "command" | "stop" } | null {
	const parts = urlPath.split("/").filter((p) => p.length > 0);
	if (parts.length !== 4) return null;
	if (parts[0] !== "api" || parts[1] !== "session") return null;
	if (parts[3] !== "events" && parts[3] !== "command" && parts[3] !== "stop") return null;
	return {
		sessionId: parts[2],
		action: parts[3],
	};
}

const server = createServer(async (req, res) => {
	withCors(res);

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	const url = new URL(req.url || "/", `http://${host}:${port}`);
	const path = url.pathname;

	if (req.method === "GET" && path === "/") {
		await serveStatic(res, join(publicDir, "index.html"), "text/html; charset=utf-8");
		return;
	}
	if (req.method === "GET" && path === "/app.js") {
		await serveStatic(res, join(publicDir, "app.js"), "text/javascript; charset=utf-8");
		return;
	}
	if (req.method === "GET" && path === "/favicon.ico") {
		res.writeHead(204);
		res.end();
		return;
	}
	if (req.method === "GET" && path === "/health") {
		safeJson(res, 200, { ok: true, sessions: sessions.size });
		return;
	}
	if (req.method === "POST" && path === "/api/session/start") {
		try {
			const bodyText = await readBody(req);
			const body = bodyText.trim().length === 0 ? {} : (JSON.parse(bodyText) as StartSessionRequest);
			const { sessionId } = createSession(body);
			safeJson(res, 200, { sessionId });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to start session";
			safeJson(res, 400, { error: message });
		}
		return;
	}

	const sessionPath = parseSessionPath(path);
	if (!sessionPath) {
		res.writeHead(404);
		res.end("Not found");
		return;
	}

	const session = sessions.get(sessionPath.sessionId);
	if (!session) {
		safeJson(res, 404, { error: "Session not found" });
		return;
	}

	if (req.method === "GET" && sessionPath.action === "events") {
		attachSse(session, res);
		return;
	}
	if (req.method === "POST" && sessionPath.action === "command") {
		try {
			const bodyText = await readBody(req);
			const payload = JSON.parse(bodyText) as unknown;
			if (!isRpcInput(payload)) {
				safeJson(res, 400, { error: "Invalid RPC command payload" });
				return;
			}

			if (session.child.stdin.destroyed || session.child.exitCode !== null) {
				safeJson(res, 409, { error: "Session process is not running" });
				return;
			}

			session.child.stdin.write(`${JSON.stringify(payload)}\n`);
			safeJson(res, 200, { ok: true });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to send command";
			safeJson(res, 400, { error: message });
		}
		return;
	}
	if (req.method === "POST" && sessionPath.action === "stop") {
		await stopSession(sessionPath.sessionId, "explicit stop");
		safeJson(res, 200, { ok: true });
		return;
	}

	res.writeHead(405);
	res.end("Method not allowed");
});

async function shutdown(signal: string): Promise<void> {
	for (const sessionId of [...sessions.keys()]) {
		await stopSession(sessionId, `server shutdown (${signal})`);
	}
	server.close();
}

process.on("SIGINT", () => {
	void shutdown("SIGINT").finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
	void shutdown("SIGTERM").finally(() => process.exit(0));
});

server.listen(port, host, () => {
	console.log(`RPC web host listening on http://${host}:${port}`);
});

/**
 * Web mode: run the real interactive TUI in a PTY and expose it in a browser.
 *
 * This mode is intended for exact terminal parity by rendering the same CLI
 * process output in xterm.js via WebSocket.
 */

import { spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import * as nodePty from "node-pty";
import * as ws from "ws";

type WebSessionState = "starting" | "running" | "stopped";

interface WebClientInputMessage {
	type: "input";
	data: string;
}

interface WebClientResizeMessage {
	type: "resize";
	cols: number;
	rows: number;
}

interface WebClientPingMessage {
	type: "ping";
}

type WebClientToServerMessage = WebClientInputMessage | WebClientResizeMessage | WebClientPingMessage;

interface WebServerOutputMessage {
	type: "output";
	data: string;
}

interface WebServerStatusMessage {
	type: "status";
	state: WebSessionState;
	reason?: string;
}

interface WebServerErrorMessage {
	type: "error";
	message: string;
}

interface WebServerPongMessage {
	type: "pong";
}

type WebServerToClientMessage =
	| WebServerOutputMessage
	| WebServerStatusMessage
	| WebServerErrorMessage
	| WebServerPongMessage;

interface ResolvedChildInvocation {
	command: string;
	args: string[];
}

export interface WebModeOptions {
	rawArgs: string[];
	host?: string;
	port?: number;
	token?: string;
	openBrowser?: boolean;
	reconnectMs?: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const DEFAULT_RECONNECT_MS = 30_000;
const MAX_BUFFER_CHARS = 250_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = join(__dirname, "public");

const require = createRequire(import.meta.url);

function contentType(pathname: string): string {
	if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
	if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
	if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
	if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
	return "text/plain; charset=utf-8";
}

function safeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
	res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(payload));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value;
}

function parseClientMessage(raw: string): WebClientToServerMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!isRecord(parsed) || typeof parsed.type !== "string") {
		return null;
	}

	if (parsed.type === "input") {
		return typeof parsed.data === "string" ? { type: "input", data: parsed.data } : null;
	}

	if (parsed.type === "resize") {
		const cols = asFiniteNumber(parsed.cols);
		const rows = asFiniteNumber(parsed.rows);
		if (cols === undefined || rows === undefined) return null;
		const normalizedCols = Math.max(2, Math.floor(cols));
		const normalizedRows = Math.max(2, Math.floor(rows));
		return { type: "resize", cols: normalizedCols, rows: normalizedRows };
	}

	if (parsed.type === "ping") {
		return { type: "ping" };
	}

	return null;
}

function sendWsMessage(client: ws.WebSocket | null, message: WebServerToClientMessage): void {
	if (!client || client.readyState !== ws.WebSocket.OPEN) return;
	client.send(JSON.stringify(message));
}

function generateToken(): string {
	return randomBytes(20).toString("hex");
}

function sanitizeArgsForChild(rawArgs: string[]): string[] {
	const args: string[] = [];

	for (let i = 0; i < rawArgs.length; i += 1) {
		const arg = rawArgs[i];

		if (arg === "--mode" && rawArgs[i + 1] === "web") {
			i += 1;
			continue;
		}

		if (arg === "--web-host" || arg === "--web-port" || arg === "--web-token" || arg === "--web-reconnect-ms") {
			i += 1;
			continue;
		}

		if (arg === "--web-open") {
			continue;
		}

		args.push(arg);
	}

	return args;
}

function resolveChildInvocation(childArgs: string[]): ResolvedChildInvocation {
	const scriptPath = process.argv[1];
	if (!scriptPath) {
		throw new Error("Unable to resolve CLI script path for web mode child process.");
	}

	if (scriptPath.endsWith(".ts")) {
		const tsxCliPath = resolveVendorPath("tsx/cli");
		if (!tsxCliPath) {
			throw new Error("Unable to resolve tsx runtime for TypeScript web mode child process.");
		}
		return {
			command: process.execPath,
			args: [tsxCliPath, scriptPath, ...childArgs],
		};
	}

	return {
		command: process.execPath,
		args: [scriptPath, ...childArgs],
	};
}

function tryOpenBrowser(url: string): void {
	try {
		if (process.platform === "darwin") {
			const proc = spawnProcess("open", [url], { detached: true, stdio: "ignore" });
			proc.unref();
			return;
		}
		if (process.platform === "win32") {
			const proc = spawnProcess("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
			proc.unref();
			return;
		}
		const proc = spawnProcess("xdg-open", [url], { detached: true, stdio: "ignore" });
		proc.unref();
	} catch {
		// Non-fatal; user can open URL manually.
	}
}

function resolveVendorPath(modulePath: string): string | null {
	try {
		return require.resolve(modulePath);
	} catch {
		return null;
	}
}

async function ensureNodePtyHelperExecutable(): Promise<void> {
	if (process.platform === "win32") return;

	let packageJsonPath: string;
	try {
		packageJsonPath = require.resolve("node-pty/package.json");
	} catch {
		return;
	}

	const packageRoot = dirname(packageJsonPath);
	const helperCandidates = [
		join(packageRoot, "build/Release/spawn-helper"),
		join(packageRoot, "build/Debug/spawn-helper"),
		join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
	];

	for (const helperPath of helperCandidates) {
		try {
			await access(helperPath, fsConstants.F_OK);
			await chmod(helperPath, 0o755);
			return;
		} catch {
			// Try next candidate.
		}
	}
}

export async function runWebMode(options: WebModeOptions): Promise<void> {
	const host = options.host ?? DEFAULT_HOST;
	const port = options.port ?? DEFAULT_PORT;
	const token = options.token && options.token.length > 0 ? options.token : generateToken();
	const reconnectMs = options.reconnectMs ?? DEFAULT_RECONNECT_MS;
	const openBrowser = options.openBrowser ?? false;
	const childArgs = sanitizeArgsForChild(options.rawArgs);
	const childInvocation = resolveChildInvocation(childArgs);

	const indexTemplate = await readFile(join(publicDir, "index.html"), "utf8");
	const appJsPath = join(publicDir, "app.js");

	const xtermJsPath = resolveVendorPath("@xterm/xterm/lib/xterm.js");
	const xtermCssPath = resolveVendorPath("@xterm/xterm/css/xterm.css");
	const xtermFitPath = resolveVendorPath("@xterm/addon-fit/lib/addon-fit.js");

	let sessionState: WebSessionState = "starting";
	let sessionReason: string | undefined;
	let outputBuffer = "";
	let activeClient: ws.WebSocket | null = null;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let ptyProcess: nodePty.IPty | null = null;
	let shuttingDown = false;

	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		try {
			const url = new URL(req.url ?? "/", `http://${host}:${port}`);
			const pathname = url.pathname;

			if (req.method === "GET" && pathname === "/") {
				const bootstrapPayload = JSON.stringify({
					token,
					reconnectMs,
					wsPath: "/ws",
				});
				const html = indexTemplate.replace("__PI_WEB_BOOTSTRAP_JSON__", bootstrapPayload);
				res.writeHead(200, { "content-type": contentType("index.html"), "cache-control": "no-store" });
				res.end(html);
				return;
			}

			if (req.method === "GET" && pathname === "/app.js") {
				const bytes = await readFile(appJsPath);
				res.writeHead(200, { "content-type": contentType("app.js"), "cache-control": "no-store" });
				res.end(bytes);
				return;
			}

			if (req.method === "GET" && pathname === "/vendor/xterm.js") {
				if (!xtermJsPath) {
					safeJson(res, 500, { error: "Missing dependency: @xterm/xterm" });
					return;
				}
				const bytes = await readFile(xtermJsPath);
				res.writeHead(200, { "content-type": contentType("xterm.js"), "cache-control": "no-store" });
				res.end(bytes);
				return;
			}

			if (req.method === "GET" && pathname === "/vendor/xterm.css") {
				if (!xtermCssPath) {
					safeJson(res, 500, { error: "Missing dependency: @xterm/xterm" });
					return;
				}
				const bytes = await readFile(xtermCssPath);
				res.writeHead(200, { "content-type": contentType("xterm.css"), "cache-control": "no-store" });
				res.end(bytes);
				return;
			}

			if (req.method === "GET" && pathname === "/vendor/xterm-addon-fit.js") {
				if (!xtermFitPath) {
					safeJson(res, 500, { error: "Missing dependency: @xterm/addon-fit" });
					return;
				}
				const bytes = await readFile(xtermFitPath);
				res.writeHead(200, { "content-type": contentType("xterm-addon-fit.js"), "cache-control": "no-store" });
				res.end(bytes);
				return;
			}

			if (req.method === "GET" && pathname === "/health") {
				safeJson(res, 200, {
					ok: true,
					state: sessionState,
					reason: sessionReason,
					connected: Boolean(activeClient && activeClient.readyState === ws.WebSocket.OPEN),
				});
				return;
			}

			if (req.method === "GET" && pathname === "/favicon.ico") {
				res.writeHead(204);
				res.end();
				return;
			}

			res.writeHead(404);
			res.end("Not found");
		} catch (error) {
			safeJson(res, 500, { error: `Web mode host error: ${error instanceof Error ? error.message : "unknown"}` });
		}
	});

	const wss = new ws.WebSocketServer({ noServer: true });

	const updateState = (state: WebSessionState, reason?: string): void => {
		sessionState = state;
		sessionReason = reason;
		sendWsMessage(activeClient, { type: "status", state, reason });
	};

	const appendOutput = (data: string): void => {
		if (data.length === 0) return;
		outputBuffer += data;
		if (outputBuffer.length > MAX_BUFFER_CHARS) {
			outputBuffer = outputBuffer.slice(outputBuffer.length - MAX_BUFFER_CHARS);
		}
		sendWsMessage(activeClient, { type: "output", data });
	};

	const clearReconnectTimer = (): void => {
		if (!reconnectTimer) return;
		clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
	};

	const shutdown = async (reason: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		clearReconnectTimer();
		updateState("stopped", reason);

		for (const client of wss.clients) {
			if (client.readyState === ws.WebSocket.OPEN) {
				sendWsMessage(client, { type: "status", state: "stopped", reason });
				client.close(1000, reason.slice(0, 120));
			}
		}

		if (ptyProcess) {
			try {
				ptyProcess.kill();
			} catch {
				// Ignore kill failures.
			}
			ptyProcess = null;
		}

		await new Promise<void>((resolve) => {
			wss.close(() => resolve());
		});

		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	};

	const scheduleReconnectShutdown = (): void => {
		clearReconnectTimer();
		reconnectTimer = setTimeout(() => {
			void shutdown(`No browser connection for ${reconnectMs}ms`);
		}, reconnectMs);
	};

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", `http://${host}:${port}`);
		if (url.pathname !== "/ws") {
			socket.destroy();
			return;
		}

		const requestToken = url.searchParams.get("token");
		if (requestToken !== token) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}

		if (activeClient && activeClient.readyState === ws.WebSocket.OPEN) {
			socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (client) => {
			wss.emit("connection", client, req);
		});
	});

	wss.on("connection", (client) => {
		activeClient = client;
		clearReconnectTimer();
		sendWsMessage(client, { type: "status", state: sessionState, reason: sessionReason });
		if (outputBuffer.length > 0) {
			sendWsMessage(client, { type: "output", data: outputBuffer });
		}

		client.on("message", (payload) => {
			const rawText = typeof payload === "string" ? payload : payload.toString("utf8");
			const message = parseClientMessage(rawText);
			if (!message) {
				sendWsMessage(client, { type: "error", message: "Invalid client message payload." });
				return;
			}

			if (message.type === "input") {
				ptyProcess?.write(message.data);
				return;
			}

			if (message.type === "resize") {
				try {
					ptyProcess?.resize(message.cols, message.rows);
				} catch {
					sendWsMessage(client, { type: "error", message: "Failed to resize terminal." });
				}
				return;
			}

			if (message.type === "ping") {
				sendWsMessage(client, { type: "pong" });
			}
		});

		client.on("close", () => {
			if (activeClient === client) {
				activeClient = null;
				if (!shuttingDown && sessionState !== "stopped") {
					scheduleReconnectShutdown();
				}
			}
		});

		client.on("error", () => {
			// Socket-level errors are handled by close + reconnect path.
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve());
	});

	let startupError: Error | null = null;
	try {
		await ensureNodePtyHelperExecutable();

		ptyProcess = nodePty.spawn(childInvocation.command, childInvocation.args, {
			name: process.env.TERM || "xterm-256color",
			cols: 120,
			rows: 36,
			cwd: process.cwd(),
			env: {
				...process.env,
				TERM: process.env.TERM || "xterm-256color",
			},
		});
	} catch (error) {
		startupError = error instanceof Error ? error : new Error("Failed to spawn PTY child process.");
	}

	if (startupError) {
		updateState("stopped", startupError.message);
		await shutdown(`Failed to start terminal session: ${startupError.message}`);
		throw startupError;
	}

	updateState("running");

	if (!ptyProcess) {
		const error = new Error("PTY process was not initialized.");
		await shutdown(error.message);
		throw error;
	}

	const activePty = ptyProcess;

	activePty.onData((data) => {
		appendOutput(data);
	});

	activePty.onExit((event) => {
		updateState("stopped", `CLI exited (code ${event.exitCode}${event.signal ? `, signal ${event.signal}` : ""})`);
		void shutdown(`CLI process exited (code ${event.exitCode})`);
	});

	const baseUrl = `http://${host}:${port}`;
	console.log(chalk.green(`Web mode listening on ${baseUrl}`));
	console.log(chalk.dim(`WebSocket token: ${token}`));
	console.log(chalk.dim("Open the URL above in a browser to use the interactive TUI."));
	if (openBrowser) {
		tryOpenBrowser(baseUrl);
	}

	const handleSignal = (signal: NodeJS.Signals) => {
		void shutdown(`Host received ${signal}`).finally(() => process.exit(0));
	};

	process.once("SIGINT", handleSignal);
	process.once("SIGTERM", handleSignal);

	await new Promise<void>((resolve) => {
		server.once("close", () => {
			resolve();
		});
	});

	process.removeListener("SIGINT", handleSignal);
	process.removeListener("SIGTERM", handleSignal);
}

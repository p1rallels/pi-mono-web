/**
 * Web mode: run the real interactive TUI in a PTY and expose it in a browser.
 *
 * This mode is intended for exact terminal parity by rendering the same CLI
 * process output in xterm.js via WebSocket.
 */

import { spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import * as nodePty from "node-pty";
import * as ws from "ws";
import { getAgentDir } from "../../config.js";
import { SessionManager } from "../../core/session-manager.js";

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

interface WebProject {
	id: string;
	path: string;
	createdAt: string;
	updatedAt: string;
}

type WebRecentSessionState = "running" | "stopped" | "error";

interface WebRecentSession {
	id: string;
	projectId?: string;
	cwd: string;
	provider?: string;
	model?: string;
	sessionPath?: string;
	noSession: boolean;
	startedAt: string;
	endedAt?: string;
	state: WebRecentSessionState;
}

interface WebLaunchDefaults {
	provider?: string;
	model?: string;
	sessionPath?: string;
	noSession: boolean;
}

interface WebLaunchConfig extends WebLaunchDefaults {
	cwd: string;
	projectId?: string;
}

interface WebActiveSession {
	id: string;
	projectId?: string;
	cwd: string;
	provider?: string;
	model?: string;
	sessionPath?: string;
	noSession: boolean;
	startedAt: string;
}

interface WebHostStateResponse {
	state: WebSessionState;
	reason?: string;
	connected: boolean;
	launchDefaults: WebLaunchDefaults;
	activeSession: WebActiveSession | null;
}

interface WebProjectCreateRequest {
	path?: string;
	id?: string;
}

interface WebSessionStartRequest {
	projectId?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	sessionPath?: string;
	noSession?: boolean;
}

interface WebSavedSessionSummary {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const DEFAULT_RECONNECT_MS = 30_000;
const MAX_BUFFER_CHARS = 250_000;
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_RECENT_SESSIONS = 80;
const STORE_VERSION = 1;

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

function nowIso8601(): string {
	return new Date().toISOString();
}

function normalizeOptionalText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeProjectId(value: string): string | null {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return null;
	const normalized = trimmed
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	if (!normalized) return null;
	if (!/^[a-z0-9_-]+$/.test(normalized)) return null;
	return normalized;
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

function extractLaunchDefaults(childArgs: string[]): WebLaunchDefaults {
	let provider: string | undefined;
	let model: string | undefined;
	let sessionPath: string | undefined;
	let noSession = false;

	for (let i = 0; i < childArgs.length; i += 1) {
		const arg = childArgs[i];
		if (arg === "--provider" && i + 1 < childArgs.length) {
			provider = childArgs[i + 1];
			i += 1;
			continue;
		}
		if (arg === "--model" && i + 1 < childArgs.length) {
			model = childArgs[i + 1];
			i += 1;
			continue;
		}
		if (arg === "--session" && i + 1 < childArgs.length) {
			sessionPath = childArgs[i + 1];
			i += 1;
			continue;
		}
		if (arg === "--no-session") {
			noSession = true;
		}
	}

	if (sessionPath !== undefined) {
		noSession = false;
	}

	return { provider, model, sessionPath, noSession };
}

function stripOptionWithValue(args: string[], option: string): string[] {
	const next: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === option) {
			i += 1;
			continue;
		}
		next.push(arg);
	}
	return next;
}

function upsertOptionWithValue(args: string[], option: string, value: string | undefined): string[] {
	const next = stripOptionWithValue(args, option);
	if (value === undefined) return next;
	return [...next, option, value];
}

function upsertBooleanFlag(args: string[], flag: string, enabled: boolean): string[] {
	const next = args.filter((entry) => entry !== flag);
	if (!enabled) return next;
	return [...next, flag];
}

function stripBooleanFlags(args: string[], flags: readonly string[]): string[] {
	const ignored = new Set(flags);
	return args.filter((entry) => !ignored.has(entry));
}

function buildChildArgsForLaunch(baseChildArgs: string[], launch: WebLaunchConfig): string[] {
	let args = [...baseChildArgs];
	args = stripBooleanFlags(args, ["--continue", "-c", "--resume", "-r"]);
	args = upsertOptionWithValue(args, "--provider", launch.provider);
	args = upsertOptionWithValue(args, "--model", launch.model);
	args = upsertOptionWithValue(args, "--session", launch.sessionPath);
	args = upsertBooleanFlag(args, "--no-session", launch.sessionPath ? false : launch.noSession);
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

function expandHomePath(inputPath: string): string {
	if (inputPath === "~") return homedir();
	if (inputPath.startsWith("~/")) return join(homedir(), inputPath.slice(2));
	return inputPath;
}

async function ensureDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
	try {
		const content = await readFile(path, "utf8");
		return JSON.parse(content);
	} catch {
		return undefined;
	}
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await ensureDirectory(dirname(path));
	const content = `${JSON.stringify(value, null, 2)}\n`;
	await writeFile(path, content, "utf8");
}

function asProjects(value: unknown): WebProject[] {
	const entries = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.projects)
			? value.projects
			: [];
	const projects: WebProject[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (typeof entry.id !== "string" || typeof entry.path !== "string") continue;
		const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : nowIso8601();
		const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : createdAt;
		projects.push({
			id: entry.id,
			path: entry.path,
			createdAt,
			updatedAt,
		});
	}
	return projects;
}

function asRecentSessions(value: unknown): WebRecentSession[] {
	const entries = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.sessions)
			? value.sessions
			: [];
	const sessions: WebRecentSession[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (typeof entry.id !== "string" || typeof entry.cwd !== "string" || typeof entry.startedAt !== "string")
			continue;
		const state =
			entry.state === "running" || entry.state === "stopped" || entry.state === "error" ? entry.state : "stopped";
		sessions.push({
			id: entry.id,
			projectId: typeof entry.projectId === "string" ? entry.projectId : undefined,
			cwd: entry.cwd,
			provider: typeof entry.provider === "string" ? entry.provider : undefined,
			model: typeof entry.model === "string" ? entry.model : undefined,
			sessionPath: typeof entry.sessionPath === "string" ? entry.sessionPath : undefined,
			noSession: typeof entry.noSession === "boolean" ? entry.noSession : false,
			startedAt: entry.startedAt,
			endedAt: typeof entry.endedAt === "string" ? entry.endedAt : undefined,
			state,
		});
	}
	return sessions;
}

function generateProjectIdFromPath(path: string, existing: Set<string>): string {
	const base = normalizeProjectId(basename(path)) ?? "repo";
	let candidate = base;
	let counter = 2;
	while (existing.has(candidate)) {
		candidate = `${base}-${counter}`;
		counter += 1;
	}
	return candidate;
}

async function validateDirectoryPath(path: string): Promise<string> {
	const expanded = expandHomePath(path);
	const resolvedPath = resolve(expanded);
	const stats = await stat(resolvedPath);
	if (!stats.isDirectory()) {
		throw new Error(`Not a directory: ${resolvedPath}`);
	}
	return resolvedPath;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
	return await new Promise<string>((resolveBody, rejectBody) => {
		let totalBytes = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			totalBytes += chunk.length;
			if (totalBytes > MAX_REQUEST_BYTES) {
				rejectBody(new Error("Request body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			resolveBody(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", rejectBody);
	});
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
	const body = await readRequestBody(req);
	const trimmed = body.trim();
	if (trimmed.length === 0) return {};
	return JSON.parse(trimmed);
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
	const baseChildArgs = sanitizeArgsForChild(options.rawArgs);

	const indexTemplate = await readFile(join(publicDir, "index.html"), "utf8");
	const appJsPath = join(publicDir, "app.js");

	const xtermJsPath = resolveVendorPath("@xterm/xterm/lib/xterm.js");
	const xtermCssPath = resolveVendorPath("@xterm/xterm/css/xterm.css");
	const xtermFitPath = resolveVendorPath("@xterm/addon-fit/lib/addon-fit.js");

	const webStoreDir = join(getAgentDir(), "web-mode");
	const projectsStorePath = join(webStoreDir, "projects.json");
	const recentStorePath = join(webStoreDir, "recent-sessions.json");
	await ensureDirectory(webStoreDir);

	let launchDefaults = extractLaunchDefaults(baseChildArgs);
	const projects = asProjects(await readJsonFile(projectsStorePath));
	let recentSessions = asRecentSessions(await readJsonFile(recentStorePath)).slice(0, MAX_RECENT_SESSIONS);

	let sessionState: WebSessionState = "starting";
	let sessionReason: string | undefined;
	let outputBuffer = "";
	let activeClient: ws.WebSocket | null = null;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let ptyProcess: nodePty.IPty | null = null;
	let ptyGeneration = 0;
	let shuttingDown = false;
	let activeSession: WebActiveSession | null = null;
	let activeLaunchForRestart: WebLaunchConfig = {
		cwd: process.cwd(),
		provider: launchDefaults.provider,
		model: launchDefaults.model,
		sessionPath: launchDefaults.sessionPath,
		noSession: launchDefaults.noSession,
	};
	let lifecycleQueue: Promise<void> = Promise.resolve();
	let helperPrepared = false;

	const persistProjects = async (): Promise<void> => {
		await writeJsonFile(projectsStorePath, { version: STORE_VERSION, projects });
	};

	const persistRecentSessions = async (): Promise<void> => {
		await writeJsonFile(recentStorePath, { version: STORE_VERSION, sessions: recentSessions });
	};

	const trimRecentSessions = (): void => {
		if (recentSessions.length > MAX_RECENT_SESSIONS) {
			recentSessions = recentSessions.slice(0, MAX_RECENT_SESSIONS);
		}
	};

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

	const enqueueLifecycle = async <T>(operation: () => Promise<T>): Promise<T> => {
		const run = lifecycleQueue.then(operation, operation);
		lifecycleQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return await run;
	};

	const markRecentSessionState = async (sessionId: string, state: WebRecentSessionState): Promise<void> => {
		const session = recentSessions.find((entry) => entry.id === sessionId);
		if (!session) return;
		session.state = state;
		session.endedAt = nowIso8601();
		await persistRecentSessions();
	};

	const stopActiveSession = async (reason: string, state: WebRecentSessionState): Promise<boolean> => {
		if (!ptyProcess) {
			updateState("stopped", reason);
			return false;
		}

		const pty = ptyProcess;
		ptyProcess = null;
		ptyGeneration += 1;
		try {
			pty.kill();
		} catch {
			// Best effort.
		}

		if (activeSession) {
			await markRecentSessionState(activeSession.id, state);
			activeSession = null;
		}
		updateState("stopped", reason);
		return true;
	};

	const startPtySession = async (
		launch: WebLaunchConfig,
		params?: { resetBuffer?: boolean; announce?: boolean },
	): Promise<WebActiveSession> => {
		await stopActiveSession("Switching session", "stopped");

		if (!helperPrepared) {
			await ensureNodePtyHelperExecutable();
			helperPrepared = true;
		}

		if (params?.resetBuffer === true) {
			outputBuffer = "";
		}

		const childArgs = buildChildArgsForLaunch(baseChildArgs, launch);
		const childInvocation = resolveChildInvocation(childArgs);
		updateState("starting", `Starting in ${launch.cwd}`);

		let spawned: nodePty.IPty;
		try {
			spawned = nodePty.spawn(childInvocation.command, childInvocation.args, {
				name: process.env.TERM || "xterm-256color",
				cols: 120,
				rows: 36,
				cwd: launch.cwd,
				env: {
					...process.env,
					TERM: process.env.TERM || "xterm-256color",
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to spawn PTY child process.";
			updateState("stopped", message);
			throw new Error(message);
		}

		ptyProcess = spawned;
		const generation = ++ptyGeneration;

		const sessionId = randomBytes(12).toString("hex");
		const sessionInfo: WebActiveSession = {
			id: sessionId,
			projectId: launch.projectId,
			cwd: launch.cwd,
			provider: launch.provider,
			model: launch.model,
			sessionPath: launch.sessionPath,
			noSession: launch.noSession,
			startedAt: nowIso8601(),
		};

		activeSession = sessionInfo;
		activeLaunchForRestart = launch;
		launchDefaults = {
			provider: launch.provider,
			model: launch.model,
			sessionPath: launch.sessionPath,
			noSession: launch.noSession,
		};

		recentSessions.unshift({
			id: sessionInfo.id,
			projectId: sessionInfo.projectId,
			cwd: sessionInfo.cwd,
			provider: sessionInfo.provider,
			model: sessionInfo.model,
			sessionPath: sessionInfo.sessionPath,
			noSession: sessionInfo.noSession,
			startedAt: sessionInfo.startedAt,
			state: "running",
		});
		trimRecentSessions();
		await persistRecentSessions();

		spawned.onData((data) => {
			if (generation !== ptyGeneration || ptyProcess !== spawned) return;
			appendOutput(data);
		});

		spawned.onExit((event) => {
			if (generation !== ptyGeneration || ptyProcess !== spawned) return;
			ptyProcess = null;
			const reason = `CLI exited (code ${event.exitCode}${event.signal ? `, signal ${event.signal}` : ""})`;
			updateState("stopped", reason);
			const nextState: WebRecentSessionState = event.exitCode === 0 ? "stopped" : "error";
			if (activeSession && activeSession.id === sessionInfo.id) {
				void markRecentSessionState(sessionInfo.id, nextState);
				activeSession = null;
			}
		});

		updateState("running");
		if (params?.announce === true) {
			appendOutput(`\r\n[web] Started session in ${launch.cwd}\r\n`);
		}
		return sessionInfo;
	};

	const snapshotState = (): WebHostStateResponse => {
		return {
			state: sessionState,
			reason: sessionReason,
			connected: Boolean(activeClient && activeClient.readyState === ws.WebSocket.OPEN),
			launchDefaults,
			activeSession,
		};
	};

	const findProjectById = (rawProjectId: string): WebProject | undefined => {
		const normalized = normalizeProjectId(rawProjectId);
		if (!normalized) return undefined;
		return projects.find((project) => project.id === normalized);
	};

	const listSavedSessions = async (
		rawProjectId: string | null,
		rawCwd: string | null,
	): Promise<WebSavedSessionSummary[]> => {
		let cwd: string;

		const requestedProject = normalizeOptionalText(rawProjectId ?? undefined);
		if (requestedProject !== undefined) {
			const project = findProjectById(requestedProject);
			if (!project) {
				throw new Error(`Unknown project: ${requestedProject}`);
			}
			cwd = project.path;
		} else {
			const requestedCwd = normalizeOptionalText(rawCwd ?? undefined);
			if (requestedCwd !== undefined) {
				cwd = await validateDirectoryPath(requestedCwd);
			} else {
				cwd = await validateDirectoryPath(activeSession?.cwd ?? activeLaunchForRestart.cwd ?? process.cwd());
			}
		}

		const sessions = await SessionManager.list(cwd);
		return sessions.slice(0, MAX_RECENT_SESSIONS).map((session) => ({
			path: session.path,
			id: session.id,
			cwd: session.cwd,
			name: session.name,
			parentSessionPath: session.parentSessionPath,
			created: session.created.toISOString(),
			modified: session.modified.toISOString(),
			messageCount: session.messageCount,
			firstMessage: session.firstMessage,
		}));
	};

	const resolveLaunchFromRequest = async (
		payload: WebSessionStartRequest,
		fallbackLaunch: WebLaunchConfig,
	): Promise<WebLaunchConfig> => {
		const provider = normalizeOptionalText(payload.provider) ?? fallbackLaunch.provider;
		const model = normalizeOptionalText(payload.model) ?? fallbackLaunch.model;
		const requestedSessionPath = normalizeOptionalText(payload.sessionPath) ?? fallbackLaunch.sessionPath;
		const requestedNoSession = typeof payload.noSession === "boolean" ? payload.noSession : fallbackLaunch.noSession;
		const noSession = requestedSessionPath ? false : requestedNoSession;

		const requestedProject = normalizeOptionalText(payload.projectId);
		if (requestedProject !== undefined) {
			const project = findProjectById(requestedProject);
			if (!project) {
				throw new Error(`Unknown project: ${requestedProject}`);
			}
			return {
				projectId: project.id,
				cwd: project.path,
				provider,
				model,
				sessionPath: requestedSessionPath,
				noSession,
			};
		}

		const requestedCwd = normalizeOptionalText(payload.cwd);
		if (requestedCwd !== undefined) {
			return {
				cwd: await validateDirectoryPath(requestedCwd),
				provider,
				model,
				sessionPath: requestedSessionPath,
				noSession,
			};
		}

		return {
			cwd: await validateDirectoryPath(fallbackLaunch.cwd),
			projectId: fallbackLaunch.projectId,
			provider,
			model,
			sessionPath: requestedSessionPath,
			noSession,
		};
	};

	const scheduleReconnectShutdown = (): void => {
		clearReconnectTimer();
		reconnectTimer = setTimeout(() => {
			void shutdown(`No browser connection for ${reconnectMs}ms`);
		}, reconnectMs);
	};

	const shutdown = async (reason: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		clearReconnectTimer();

		await enqueueLifecycle(async () => {
			await stopActiveSession(reason, "stopped");
		});

		updateState("stopped", reason);

		for (const client of wss.clients) {
			if (client.readyState === ws.WebSocket.OPEN) {
				sendWsMessage(client, { type: "status", state: "stopped", reason });
				client.close(1000, reason.slice(0, 120));
			}
		}

		await new Promise<void>((resolveClose) => {
			wss.close(() => resolveClose());
		});

		await new Promise<void>((resolveClose) => {
			server.close(() => resolveClose());
		});
	};

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
					activeSessionId: activeSession?.id ?? null,
				});
				return;
			}

			if (req.method === "GET" && pathname === "/api/web/state") {
				safeJson(res, 200, snapshotState());
				return;
			}

			if (req.method === "GET" && pathname === "/api/web/projects") {
				safeJson(res, 200, projects);
				return;
			}

			if (req.method === "POST" && pathname === "/api/web/projects") {
				let body: unknown;
				try {
					body = await parseJsonBody(req);
				} catch (error) {
					safeJson(res, 400, {
						error: `Invalid JSON body: ${error instanceof Error ? error.message : "unknown"}`,
					});
					return;
				}

				if (!isRecord(body)) {
					safeJson(res, 400, { error: "Invalid request body." });
					return;
				}

				const request = body as WebProjectCreateRequest;
				const rawPath = normalizeOptionalText(request.path);
				if (!rawPath) {
					safeJson(res, 400, { error: "Missing project path." });
					return;
				}

				let validatedPath: string;
				try {
					validatedPath = await validateDirectoryPath(rawPath);
				} catch (error) {
					safeJson(res, 400, { error: error instanceof Error ? error.message : "Invalid project path." });
					return;
				}

				if (projects.some((project) => project.path === validatedPath)) {
					safeJson(res, 409, { error: `Project path already exists: ${validatedPath}` });
					return;
				}

				const existingIds = new Set(projects.map((project) => project.id));
				const requestedId = normalizeOptionalText(request.id);
				let projectId: string;
				if (requestedId) {
					const normalized = normalizeProjectId(requestedId);
					if (!normalized) {
						safeJson(res, 400, { error: `Invalid project id: ${requestedId}` });
						return;
					}
					if (existingIds.has(normalized)) {
						safeJson(res, 409, { error: `Project id already exists: ${normalized}` });
						return;
					}
					projectId = normalized;
				} else {
					projectId = generateProjectIdFromPath(validatedPath, existingIds);
				}

				const now = nowIso8601();
				const created: WebProject = {
					id: projectId,
					path: validatedPath,
					createdAt: now,
					updatedAt: now,
				};
				projects.push(created);
				projects.sort((left, right) => left.id.localeCompare(right.id));
				await persistProjects();
				safeJson(res, 200, created);
				return;
			}

			if (req.method === "DELETE" && pathname.startsWith("/api/web/projects/")) {
				const rawId = decodeURIComponent(pathname.slice("/api/web/projects/".length));
				const projectId = normalizeProjectId(rawId);
				if (!projectId) {
					safeJson(res, 400, { error: `Invalid project id: ${rawId}` });
					return;
				}
				const index = projects.findIndex((project) => project.id === projectId);
				if (index < 0) {
					safeJson(res, 404, { error: `Project not found: ${projectId}` });
					return;
				}
				projects.splice(index, 1);
				await persistProjects();
				safeJson(res, 200, { ok: true });
				return;
			}

			if (req.method === "GET" && pathname === "/api/web/sessions/recent") {
				safeJson(res, 200, recentSessions);
				return;
			}

			if (req.method === "GET" && pathname === "/api/web/sessions") {
				try {
					const sessions = await listSavedSessions(url.searchParams.get("projectId"), url.searchParams.get("cwd"));
					safeJson(res, 200, sessions);
				} catch (error) {
					safeJson(res, 400, {
						error: error instanceof Error ? error.message : "Failed to list saved sessions.",
					});
				}
				return;
			}

			if (req.method === "POST" && pathname === "/api/web/session/start") {
				let body: unknown;
				try {
					body = await parseJsonBody(req);
				} catch (error) {
					safeJson(res, 400, {
						error: `Invalid JSON body: ${error instanceof Error ? error.message : "unknown"}`,
					});
					return;
				}
				if (!isRecord(body)) {
					safeJson(res, 400, { error: "Invalid request body." });
					return;
				}

				const fallback: WebLaunchConfig = {
					cwd: process.cwd(),
					provider: launchDefaults.provider,
					model: launchDefaults.model,
					sessionPath: launchDefaults.sessionPath,
					noSession: launchDefaults.noSession,
				};
				let launch: WebLaunchConfig;
				try {
					launch = await resolveLaunchFromRequest(body as WebSessionStartRequest, fallback);
				} catch (error) {
					safeJson(res, 400, {
						error: error instanceof Error ? error.message : "Failed to resolve session launch.",
					});
					return;
				}

				try {
					const started = await enqueueLifecycle(async () => {
						return await startPtySession(launch, { resetBuffer: true, announce: true });
					});
					safeJson(res, 200, { ok: true, sessionId: started.id });
				} catch (error) {
					safeJson(res, 500, { error: error instanceof Error ? error.message : "Failed to start session." });
				}
				return;
			}

			if (req.method === "POST" && pathname === "/api/web/session/restart") {
				let body: unknown = {};
				try {
					body = await parseJsonBody(req);
				} catch (error) {
					safeJson(res, 400, {
						error: `Invalid JSON body: ${error instanceof Error ? error.message : "unknown"}`,
					});
					return;
				}
				if (!isRecord(body)) {
					safeJson(res, 400, { error: "Invalid request body." });
					return;
				}

				let launch: WebLaunchConfig;
				try {
					launch = await resolveLaunchFromRequest(body as WebSessionStartRequest, activeLaunchForRestart);
				} catch (error) {
					safeJson(res, 400, {
						error: error instanceof Error ? error.message : "Failed to resolve restart launch.",
					});
					return;
				}

				try {
					const started = await enqueueLifecycle(async () => {
						return await startPtySession(launch, { resetBuffer: true, announce: true });
					});
					safeJson(res, 200, { ok: true, sessionId: started.id });
				} catch (error) {
					safeJson(res, 500, { error: error instanceof Error ? error.message : "Failed to restart session." });
				}
				return;
			}

			if (req.method === "POST" && pathname === "/api/web/session/stop") {
				try {
					const stopped = await enqueueLifecycle(async () => {
						return await stopActiveSession("Stopped from web menu", "stopped");
					});
					safeJson(res, 200, { ok: true, stopped });
				} catch (error) {
					safeJson(res, 500, { error: error instanceof Error ? error.message : "Failed to stop session." });
				}
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
				if (!shuttingDown) {
					scheduleReconnectShutdown();
				}
			}
		});

		client.on("error", () => {
			// Socket-level errors are handled by close + reconnect path.
		});
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(port, host, () => resolveListen());
	});

	const initialLaunch: WebLaunchConfig = {
		cwd: process.cwd(),
		provider: launchDefaults.provider,
		model: launchDefaults.model,
		sessionPath: launchDefaults.sessionPath,
		noSession: launchDefaults.noSession,
	};

	let startupError: Error | null = null;
	try {
		await enqueueLifecycle(async () => {
			await startPtySession(initialLaunch, { resetBuffer: false, announce: false });
		});
	} catch (error) {
		startupError = error instanceof Error ? error : new Error("Failed to start terminal session.");
	}

	if (startupError) {
		updateState("stopped", startupError.message);
		await shutdown(`Failed to start terminal session: ${startupError.message}`);
		throw startupError;
	}

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

	await new Promise<void>((resolveClose) => {
		server.once("close", () => {
			resolveClose();
		});
	});

	process.removeListener("SIGINT", handleSignal);
	process.removeListener("SIGTERM", handleSignal);
}

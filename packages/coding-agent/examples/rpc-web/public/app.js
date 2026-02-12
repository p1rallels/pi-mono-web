const statusLine = document.getElementById("status-line");
const providerInput = document.getElementById("provider");
const modelInput = document.getElementById("model");
const cwdInput = document.getElementById("cwd");
const promptInput = document.getElementById("prompt");
const assistantStream = document.getElementById("assistant-stream");
const terminalFeed = document.getElementById("terminal-feed");
const log = document.getElementById("log");
const extensionStatus = document.getElementById("extension-status");
const widgets = document.getElementById("widgets");

const startSessionButton = document.getElementById("start-session");
const stopSessionButton = document.getElementById("stop-session");
const sendPromptButton = document.getElementById("send-prompt");
const abortButton = document.getElementById("abort-prompt");
const runRpcInputButton = document.getElementById("run-rpc-input");
const runRpcEditorButton = document.getElementById("run-rpc-editor");
const runRpcPrefillButton = document.getElementById("run-rpc-prefill");

let sessionId = null;
let eventSource = null;
let currentAssistantText = "";
let isStreaming = false;
let hasTextOutput = false;
const statusMap = new Map();
const widgetMap = new Map();
const terminalLines = [];
const MAX_TERMINAL_LINES = 1000;

const COLORS = {
	green: "green",
	yellow: "yellow",
	blue: "blue",
	magenta: "magenta",
	red: "red",
	dim: "dim",
};

function setSessionState(text, good) {
	statusLine.innerHTML = `Session: <span class="${good ? "good" : "bad"}">${text}</span>`;
}

function appendLog(text) {
	const ts = new Date().toISOString().slice(11, 19);
	log.textContent += `[${ts}] ${text}\n`;
	log.scrollTop = log.scrollHeight;
}

function appendTerminal(text, color = null) {
	terminalLines.push({ text, color });
	if (terminalLines.length > MAX_TERMINAL_LINES) {
		terminalLines.splice(0, terminalLines.length - MAX_TERMINAL_LINES);
	}
	renderTerminal();
}

function appendTerminalRaw(text) {
	if (terminalLines.length === 0) {
		terminalLines.push({ text, color: null });
	} else {
		terminalLines[terminalLines.length - 1].text += text;
	}
	renderTerminal();
}

function renderTerminal() {
	terminalFeed.innerHTML = "";
	for (const line of terminalLines) {
		const row = document.createElement("div");
		row.className = `terminal-line${line.color ? ` ${line.color}` : ""}`;
		row.textContent = line.text;
		terminalFeed.appendChild(row);
	}
	terminalFeed.scrollTop = terminalFeed.scrollHeight;
}

function renderStatusMap() {
	if (statusMap.size === 0) {
		extensionStatus.textContent = "(none)";
		return;
	}
	const rows = [];
	for (const [key, value] of statusMap.entries()) {
		rows.push(`${key}: ${value ?? "(cleared)"}`);
	}
	extensionStatus.textContent = rows.join("\n");
}

function renderWidgets() {
	widgets.innerHTML = "";
	if (widgetMap.size === 0) {
		widgets.textContent = "(none)";
		return;
	}

	for (const [key, value] of widgetMap.entries()) {
		const block = document.createElement("div");
		block.className = "widget-block";

		const placement = value.placement || "aboveEditor";
		const lines = Array.isArray(value.lines) ? value.lines : [];
		block.textContent = `${key} (${placement})\n${lines.join("\n")}`;
		widgets.appendChild(block);
	}
}

function updateButtons() {
	const running = Boolean(sessionId);
	startSessionButton.disabled = running;
	stopSessionButton.disabled = !running;
	sendPromptButton.disabled = !running;
	abortButton.disabled = !running || !isStreaming;
	runRpcInputButton.disabled = !running;
	runRpcEditorButton.disabled = !running;
	runRpcPrefillButton.disabled = !running;
}

async function postJson(path, payload) {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(body.error || `${res.status} ${res.statusText}`);
	}
	return body;
}

async function sendCommand(command) {
	if (!sessionId) return;
	await postJson(`/api/session/${sessionId}/command`, command);
}

function getEventPromptDefaults(request) {
	if (request.method === "select") {
		const options = Array.isArray(request.options) ? request.options : [];
		const title = request.title || "Select an option";
		return {
			title,
			defaultValue: options[0] || "",
			description: options.length > 0 ? `\n\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : "",
		};
	}
	if (request.method === "confirm") {
		const title = request.title || "Confirm";
		const message = request.message || "";
		return {
			title,
			defaultValue: "Yes",
			description: message ? `\n\n${message}\n\nType Yes or No` : "\n\nType Yes or No",
		};
	}
	if (request.method === "input") {
		return {
			title: request.title || "Input",
			defaultValue: request.placeholder || "",
			description: "",
		};
	}
	if (request.method === "editor") {
		return {
			title: request.title || "Editor",
			defaultValue: request.prefill || "",
			description: "\n\nMulti-line edits: use \\n for line breaks.",
		};
	}
	return {
		title: request.method || "Extension request",
		defaultValue: "",
		description: "",
	};
}

async function handleExtensionUiRequest(request) {
	const id = request.id;
	const method = request.method;
	appendLog(`extension_ui_request: ${method}`);

	if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
		const cfg = getEventPromptDefaults(request);
		const value = window.prompt(`${cfg.title}${cfg.description}`, cfg.defaultValue);

		if (value === null) {
			await sendCommand({ type: "extension_ui_response", id, cancelled: true });
			return;
		}

		if (method === "confirm") {
			const confirmed = /^y(es)?$/i.test(value.trim());
			await sendCommand({ type: "extension_ui_response", id, confirmed });
			return;
		}

		await sendCommand({ type: "extension_ui_response", id, value });
		return;
	}

	if (method === "notify") {
		const level = request.notifyType || "info";
		appendTerminal(`Notification: ${request.message || ""}`, level === "error" ? COLORS.red : level === "warning" ? COLORS.yellow : COLORS.magenta);
		return;
	}

	if (method === "setStatus") {
		statusMap.set(request.statusKey, request.statusText);
		renderStatusMap();
		return;
	}

	if (method === "setWidget") {
		if (request.widgetLines === undefined) {
			widgetMap.delete(request.widgetKey);
		} else {
			widgetMap.set(request.widgetKey, {
				lines: request.widgetLines,
				placement: request.widgetPlacement,
			});
		}
		renderWidgets();
		return;
	}

	if (method === "setTitle") {
		document.title = request.title || "pi RPC Web Example";
		return;
	}

	if (method === "set_editor_text") {
		promptInput.value = request.text || "";
		return;
	}
}

function handleAgentEvent(event) {
	if (event.type === "agent_start") {
		isStreaming = true;
		hasTextOutput = false;
		updateButtons();
		appendLog("agent_start");
		return;
	}

	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		if (update?.type === "text_delta") {
			if (!hasTextOutput) {
				hasTextOutput = true;
				appendTerminal("", null);
				appendTerminal("Agent:", COLORS.blue);
			}

			const delta = update.delta || "";
			currentAssistantText += delta;
			assistantStream.textContent = currentAssistantText;

			const parts = delta.split("\n");
			for (let i = 0; i < parts.length; i += 1) {
				if (i > 0) appendTerminal("", null);
				if (parts[i]) appendTerminalRaw(parts[i]);
			}
		}
		return;
	}

	if (event.type === "tool_execution_start") {
		appendTerminal(`[tool: ${event.toolName}]`, COLORS.dim);
		return;
	}

	if (event.type === "tool_execution_end") {
		const preview = JSON.stringify(event.result).slice(0, 120);
		appendTerminal(`[result: ${preview}...]`, COLORS.dim);
		return;
	}

	if (event.type === "agent_end") {
		isStreaming = false;
		updateButtons();
		appendLog("agent_end");
		appendTerminal("", null);
		return;
	}
}

function connectEvents() {
	if (!sessionId) return;
	if (eventSource) {
		eventSource.close();
		eventSource = null;
	}

	eventSource = new EventSource(`/api/session/${sessionId}/events`);
	eventSource.onmessage = async (msg) => {
		const payload = JSON.parse(msg.data);
		const type = payload.type;

		if (type === "session_started") {
			setSessionState(`running (${payload.sessionId.slice(0, 8)})`, true);
			appendLog(`session_started: ${payload.sessionId}`);
			return;
		}
		if (type === "rpc_response") {
			const response = payload.response || {};
			if (response.success === false) {
				appendLog(`rpc_error ${response.command}: ${response.error || "unknown error"}`);
				appendTerminal(`[error] ${response.command}: ${response.error || "unknown error"}`, COLORS.red);
			}
			return;
		}
		if (type === "agent_event") {
			handleAgentEvent(payload.event || {});
			return;
		}
		if (type === "extension_ui_request") {
			await handleExtensionUiRequest(payload.request || {});
			return;
		}
		if (type === "stderr") {
			const text = (payload.text || "").trim();
			if (text.length > 0) {
				appendLog(`stderr: ${text}`);
				appendTerminal(`[stderr] ${text}`, COLORS.red);
			}
			return;
		}
		if (type === "session_error") {
			appendLog(`session_error: ${payload.message}`);
			appendTerminal(`[session_error] ${payload.message}`, COLORS.yellow);
			return;
		}
		if (type === "session_stopped") {
			appendLog(`session_stopped (code=${payload.code}, signal=${payload.signal})`);
			appendTerminal(`[session_stopped] code=${payload.code} signal=${payload.signal}`, COLORS.yellow);
			stopLocalSessionState();
			return;
		}
	};

	eventSource.onerror = () => {
		appendLog("SSE connection closed");
	};
}

function stopLocalSessionState() {
	if (eventSource) {
		eventSource.close();
		eventSource = null;
	}
	sessionId = null;
	isStreaming = false;
	currentAssistantText = "";
	setSessionState("stopped", false);
	updateButtons();
}

async function startSession() {
	try {
		const provider = providerInput.value.trim();
		const modelId = modelInput.value.trim();
		const cwd = cwdInput.value.trim();
		const body = {
			provider: provider || undefined,
			modelId: modelId || undefined,
			cwd: cwd || undefined,
			noSession: true,
			loadRpcDemoExtension: true,
		};
		const response = await postJson("/api/session/start", body);
		sessionId = response.sessionId;
		currentAssistantText = "";
		assistantStream.textContent = "";
		statusMap.clear();
		widgetMap.clear();
		renderStatusMap();
		renderWidgets();
		connectEvents();
		updateButtons();
		appendLog(`session start request accepted: ${sessionId}`);
		appendTerminal("RPC Chat", null);
		appendTerminal("Type a prompt and press Send Prompt. Abort to interrupt.", COLORS.dim);
		appendTerminal("RPC extension shortcuts: /rpc-input /rpc-editor /rpc-prefill", COLORS.dim);
		appendTerminal("", null);
	} catch (error) {
		appendLog(`failed to start session: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function stopSession() {
	if (!sessionId) return;
	try {
		await postJson(`/api/session/${sessionId}/stop`, {});
		appendLog("stop session requested");
		appendTerminal("[stopped]", COLORS.yellow);
	} catch (error) {
		appendLog(`failed to stop session: ${error instanceof Error ? error.message : String(error)}`);
	}
	stopLocalSessionState();
}

async function sendPrompt(prompt) {
	const text = prompt.trim();
	if (!text || !sessionId) return;
	currentAssistantText = "";
	assistantStream.textContent = "";
	appendTerminal(`You: ${text}`, COLORS.green);
	await sendCommand({ type: "prompt", message: text });
	appendLog(`prompt: ${text}`);
}

startSessionButton.addEventListener("click", () => {
	void startSession();
});

stopSessionButton.addEventListener("click", () => {
	void stopSession();
});

sendPromptButton.addEventListener("click", () => {
	const text = promptInput.value;
	promptInput.value = "";
	void sendPrompt(text);
});

abortButton.addEventListener("click", () => {
	void sendCommand({ type: "abort" });
	appendTerminal("[aborted]", COLORS.yellow);
});

runRpcInputButton.addEventListener("click", () => {
	void sendPrompt("/rpc-input");
});
runRpcEditorButton.addEventListener("click", () => {
	void sendPrompt("/rpc-editor");
});
runRpcPrefillButton.addEventListener("click", () => {
	void sendPrompt("/rpc-prefill");
});

promptInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		const text = promptInput.value;
		promptInput.value = "";
		void sendPrompt(text);
	}
});

window.addEventListener("beforeunload", () => {
	void stopSession();
});

setSessionState("stopped", false);
renderStatusMap();
renderWidgets();
appendTerminal("No active session.", COLORS.dim);
updateButtons();

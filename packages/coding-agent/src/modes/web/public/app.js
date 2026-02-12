const bootstrap = window.__PI_WEB_BOOTSTRAP__;
const statusEl = document.getElementById("status");
const detailEl = document.getElementById("detail");
const reconnectButton = document.getElementById("reconnect");
const terminalEl = document.getElementById("terminal");

if (!bootstrap || typeof bootstrap.token !== "string" || typeof bootstrap.wsPath !== "string") {
	throw new Error("Invalid web bootstrap configuration");
}

const terminal = new Terminal({
	cursorBlink: true,
	convertEol: false,
	fontSize: 14,
	lineHeight: 1.2,
	fontFamily: "Iosevka Web, JetBrains Mono, SFMono-Regular, Menlo, monospace",
	scrollback: 5000,
	theme: {
		background: "#05070d",
		foreground: "#e5e7eb",
		cursor: "#7dd3fc",
		selectionBackground: "#1f2937aa",
	},
});

const fitAddon = new FitAddon.FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalEl);
fitAddon.fit();
terminal.focus();

let socket = null;
let reconnectTimer = null;
let isStopped = false;

function setStatus(state, detail) {
	statusEl.textContent = state;
	statusEl.className = `status ${state}`;
	detailEl.textContent = detail || "";
}

function socketUrl() {
	const scheme = window.location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${window.location.host}${bootstrap.wsPath}?token=${encodeURIComponent(bootstrap.token)}`;
}

function clearReconnectTimer() {
	if (!reconnectTimer) return;
	window.clearTimeout(reconnectTimer);
	reconnectTimer = null;
}

function sendMessage(message) {
	if (!socket || socket.readyState !== WebSocket.OPEN) return;
	socket.send(JSON.stringify(message));
}

function sendResize() {
	sendMessage({
		type: "resize",
		cols: terminal.cols,
		rows: terminal.rows,
	});
}

function scheduleReconnect() {
	clearReconnectTimer();
	if (isStopped) return;
	reconnectTimer = window.setTimeout(() => {
		connect();
	}, 800);
}

function handleServerMessage(rawData) {
	let message;
	try {
		message = JSON.parse(rawData);
	} catch {
		return;
	}

	if (!message || typeof message.type !== "string") {
		return;
	}

	if (message.type === "output" && typeof message.data === "string") {
		terminal.write(message.data);
		return;
	}

	if (message.type === "status" && typeof message.state === "string") {
		const detail = typeof message.reason === "string" ? message.reason : "";
		if (message.state === "running") {
			setStatus("connected", detail || "Connected to interactive pi session");
		} else if (message.state === "starting") {
			setStatus("connecting", detail || "Starting interactive session...");
		} else if (message.state === "stopped") {
			isStopped = true;
			setStatus("stopped", detail || "Session stopped");
			clearReconnectTimer();
		}
		return;
	}

	if (message.type === "error" && typeof message.message === "string") {
		terminal.writeln(`\r\n[host error] ${message.message}\r\n`);
		return;
	}
}

function connect() {
	if (isStopped) return;
	clearReconnectTimer();
	setStatus("connecting", "Connecting terminal bridge...");

	const wsUrl = socketUrl();
	const nextSocket = new WebSocket(wsUrl);
	socket = nextSocket;

	nextSocket.addEventListener("open", () => {
		setStatus("connected", "Connected");
		sendResize();
	});

	nextSocket.addEventListener("message", (event) => {
		const raw = typeof event.data === "string" ? event.data : "";
		handleServerMessage(raw);
	});

	nextSocket.addEventListener("close", () => {
		if (isStopped) return;
		setStatus("disconnected", "Connection closed, retrying...");
		scheduleReconnect();
	});

	nextSocket.addEventListener("error", () => {
		// Errors are followed by close; reconnect is handled there.
	});
}

terminal.onData((data) => {
	sendMessage({ type: "input", data });
});

let resizeTimer = null;
window.addEventListener("resize", () => {
	if (resizeTimer) {
		window.clearTimeout(resizeTimer);
	}
	resizeTimer = window.setTimeout(() => {
		fitAddon.fit();
		sendResize();
	}, 80);
});

reconnectButton.addEventListener("click", () => {
	if (socket && socket.readyState === WebSocket.OPEN) {
		return;
	}
	isStopped = false;
	connect();
});

window.addEventListener("beforeunload", () => {
	if (socket && socket.readyState <= WebSocket.OPEN) {
		socket.close();
	}
});

terminal.writeln("pi web terminal ready.");
terminal.writeln("Waiting for session output...\r\n");
setStatus("connecting", "Booting interactive session...");
connect();

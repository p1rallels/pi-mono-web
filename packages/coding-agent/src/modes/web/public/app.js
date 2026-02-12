const bootstrap = window.__PI_WEB_BOOTSTRAP__;
const statusEl = document.getElementById("status");
const detailEl = document.getElementById("detail");
const reconnectButton = document.getElementById("reconnect");
const terminalEl = document.getElementById("terminal");
const terminalWrapperEl = document.getElementById("terminal-wrapper");
const mobileKeybarEl = document.getElementById("mobile-keybar");
const mobileKeyButtons = Array.from(document.querySelectorAll("#mobile-keybar [data-key]"));
const mobileWidthQuery = window.matchMedia("(max-width: 900px)");
const coarsePointerQuery = window.matchMedia("(pointer: coarse)");

if (!bootstrap || typeof bootstrap.token !== "string" || typeof bootstrap.wsPath !== "string") {
	throw new Error("Invalid web bootstrap configuration");
}

if (!statusEl || !detailEl || !reconnectButton || !terminalEl || !terminalWrapperEl || !mobileKeybarEl) {
	throw new Error("Missing required web terminal UI elements");
}

const MOBILE_KEY_SEQUENCES = {
	esc: "\u001b",
	tab: "\t",
	up: "\u001b[A",
	down: "\u001b[B",
	left: "\u001b[D",
	right: "\u001b[C",
	enter: "\r",
	ctrlc: "\u0003",
};

const TOUCH_SCROLL_PIXELS_PER_LINE = 18;
const HORIZONTAL_SWIPE_THRESHOLD = 54;
const VERTICAL_SWIPE_TOLERANCE = 24;
const TAP_FOCUS_THRESHOLD = 8;

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

let socket = null;
let reconnectTimer = null;
let isStopped = false;
let fitTimer = null;
let mobileUiEnabled = false;
let touchSession = null;

function isTouchDevice() {
	return navigator.maxTouchPoints > 0 || coarsePointerQuery.matches;
}

function updateViewportHeight() {
	const viewport = window.visualViewport;
	const nextHeight = viewport ? Math.round(viewport.height) : window.innerHeight;
	document.documentElement.style.setProperty("--app-height", `${Math.max(nextHeight, 320)}px`);
}

function setMobileUiEnabled(enabled) {
	if (mobileUiEnabled === enabled) return;
	mobileUiEnabled = enabled;
	document.body.classList.toggle("mobile-ui-enabled", mobileUiEnabled);
	mobileKeybarEl.setAttribute("aria-hidden", mobileUiEnabled ? "false" : "true");
	if (!mobileUiEnabled) {
		touchSession = null;
	}
}

function refreshMobileUiMode() {
	setMobileUiEnabled(isTouchDevice() && mobileWidthQuery.matches);
}

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

function sendInput(data, options = {}) {
	sendMessage({ type: "input", data });
	if (options.focus === true) {
		terminal.focus();
	}
}

function sendResize() {
	sendMessage({
		type: "resize",
		cols: terminal.cols,
		rows: terminal.rows,
	});
}

function fitTerminal() {
	fitAddon.fit();
	sendResize();
}

function getTerminalViewportElement() {
	return terminalEl.querySelector(".xterm-viewport");
}

function shouldKeepViewportPinned() {
	const viewportEl = getTerminalViewportElement();
	if (!viewportEl) return true;
	return viewportEl.scrollTop + viewportEl.clientHeight >= viewportEl.scrollHeight - 8;
}

function desiredFontSize() {
	if (!mobileUiEnabled) return 14;

	const viewport = window.visualViewport;
	const width = Math.round(viewport ? viewport.width : window.innerWidth);
	const height = Math.round(viewport ? viewport.height : window.innerHeight);

	let fontSize = 14;
	if (width <= 430) fontSize = 13;
	if (width <= 390) fontSize = 12;
	if (height <= 640) fontSize = Math.min(fontSize, 12);
	if (height <= 520) fontSize = Math.min(fontSize, 11);

	return fontSize;
}

function updateTerminalTypography() {
	const nextFontSize = desiredFontSize();
	if (terminal.options.fontSize !== nextFontSize) {
		terminal.options.fontSize = nextFontSize;
	}
}

function scheduleFit(delay = 70) {
	if (fitTimer) {
		window.clearTimeout(fitTimer);
	}
	fitTimer = window.setTimeout(() => {
		fitTimer = null;
		fitTerminal();
	}, delay);
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

function handleMobileKeyClick(event) {
	const key = event.currentTarget?.getAttribute("data-key");
	if (!key) return;
	const sequence = MOBILE_KEY_SEQUENCES[key];
	if (!sequence) return;
	const keepPinned = shouldKeepViewportPinned();
	sendInput(sequence, { focus: false });
	if (keepPinned) {
		window.requestAnimationFrame(() => {
			terminal.scrollToBottom();
		});
	}
}

for (const button of mobileKeyButtons) {
	button.addEventListener("pointerdown", (event) => {
		if (!mobileUiEnabled) return;
		event.preventDefault();
	});
	button.addEventListener("click", handleMobileKeyClick);
}

function handleTouchStart(event) {
	if (!mobileUiEnabled || event.touches.length !== 1) return;
	const touch = event.touches[0];
	touchSession = {
		lastX: touch.clientX,
		lastY: touch.clientY,
		totalX: 0,
		totalY: 0,
		scrollRemainder: 0,
		didScroll: false,
	};
}

function handleTouchMove(event) {
	if (!mobileUiEnabled || !touchSession || event.touches.length !== 1) return;

	const touch = event.touches[0];
	const deltaX = touch.clientX - touchSession.lastX;
	const deltaY = touch.clientY - touchSession.lastY;
	touchSession.lastX = touch.clientX;
	touchSession.lastY = touch.clientY;
	touchSession.totalX += deltaX;
	touchSession.totalY += deltaY;

	if (Math.abs(touchSession.totalY) < Math.abs(touchSession.totalX)) {
		return;
	}

	event.preventDefault();
	touchSession.scrollRemainder += deltaY;
	const lines = Math.trunc(-touchSession.scrollRemainder / TOUCH_SCROLL_PIXELS_PER_LINE);
	if (lines === 0) return;

	terminal.scrollLines(lines);
	touchSession.scrollRemainder += lines * TOUCH_SCROLL_PIXELS_PER_LINE;
	touchSession.didScroll = true;
}

function handleTouchEnd() {
	if (!mobileUiEnabled || !touchSession) return;
	const { totalX, totalY, didScroll } = touchSession;
	touchSession = null;

	if (didScroll) return;

	if (Math.abs(totalX) <= TAP_FOCUS_THRESHOLD && Math.abs(totalY) <= TAP_FOCUS_THRESHOLD) {
		terminal.focus();
		return;
	}

	if (Math.abs(totalX) < HORIZONTAL_SWIPE_THRESHOLD || Math.abs(totalY) > VERTICAL_SWIPE_TOLERANCE) {
		return;
	}

	sendInput(totalX > 0 ? MOBILE_KEY_SEQUENCES.right : MOBILE_KEY_SEQUENCES.left, { focus: false });
}

terminalWrapperEl.addEventListener("touchstart", handleTouchStart, { passive: true });
terminalWrapperEl.addEventListener("touchmove", handleTouchMove, { passive: false });
terminalWrapperEl.addEventListener("touchend", handleTouchEnd, { passive: true });
terminalWrapperEl.addEventListener("touchcancel", handleTouchEnd, { passive: true });

terminal.onData((data) => {
	sendMessage({ type: "input", data });
});

reconnectButton.addEventListener("click", () => {
	if (socket && socket.readyState === WebSocket.OPEN) {
		return;
	}
	isStopped = false;
	connect();
});

const handleViewportChange = () => {
	updateViewportHeight();
	refreshMobileUiMode();
	updateTerminalTypography();
	scheduleFit(45);
};

window.addEventListener("resize", handleViewportChange);
window.addEventListener("orientationchange", handleViewportChange);
if (window.visualViewport) {
	window.visualViewport.addEventListener("resize", handleViewportChange);
	window.visualViewport.addEventListener("scroll", handleViewportChange);
}

if (typeof mobileWidthQuery.addEventListener === "function") {
	mobileWidthQuery.addEventListener("change", handleViewportChange);
} else if (typeof mobileWidthQuery.addListener === "function") {
	mobileWidthQuery.addListener(handleViewportChange);
}

if (typeof coarsePointerQuery.addEventListener === "function") {
	coarsePointerQuery.addEventListener("change", handleViewportChange);
} else if (typeof coarsePointerQuery.addListener === "function") {
	coarsePointerQuery.addListener(handleViewportChange);
}

window.addEventListener("beforeunload", () => {
	if (socket && socket.readyState <= WebSocket.OPEN) {
		socket.close();
	}
	if (window.visualViewport) {
		window.visualViewport.removeEventListener("resize", handleViewportChange);
		window.visualViewport.removeEventListener("scroll", handleViewportChange);
	}
	if (typeof mobileWidthQuery.removeEventListener === "function") {
		mobileWidthQuery.removeEventListener("change", handleViewportChange);
	} else if (typeof mobileWidthQuery.removeListener === "function") {
		mobileWidthQuery.removeListener(handleViewportChange);
	}
	if (typeof coarsePointerQuery.removeEventListener === "function") {
		coarsePointerQuery.removeEventListener("change", handleViewportChange);
	} else if (typeof coarsePointerQuery.removeListener === "function") {
		coarsePointerQuery.removeListener(handleViewportChange);
	}
});

updateViewportHeight();
refreshMobileUiMode();
updateTerminalTypography();
fitTerminal();
terminal.focus();
terminal.writeln("pi web terminal ready.");
terminal.writeln("Waiting for session output...\r\n");
setStatus("connecting", "Booting interactive session...");
connect();

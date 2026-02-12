const bootstrap = window.__PI_WEB_BOOTSTRAP__;
const reconnectButton = document.getElementById("reconnect");
const terminalEl = document.getElementById("terminal");
const terminalWrapperEl = document.getElementById("terminal-wrapper");
const mobileKeybarEl = document.getElementById("mobile-keybar");
const connectionDotEl = document.getElementById("connection-dot");
const mobileKeyButtons = Array.from(document.querySelectorAll("#mobile-keybar [data-key]"));
const mobileWidthQuery = window.matchMedia("(max-width: 900px)");
const coarsePointerQuery = window.matchMedia("(pointer: coarse)");

if (!bootstrap || typeof bootstrap.token !== "string" || typeof bootstrap.wsPath !== "string") {
	throw new Error("Invalid web bootstrap configuration");
}

if (!reconnectButton || !terminalEl || !terminalWrapperEl || !mobileKeybarEl || !connectionDotEl) {
	throw new Error("Missing required web terminal UI elements");
}

const MOBILE_KEY_SEQUENCES = {
	esc: "\u001b",
	up: "\u001b[A",
	down: "\u001b[B",
	enter: "\r",
};

const TOUCH_SCROLL_PIXELS_PER_LINE = 14;
const TAP_FOCUS_THRESHOLD = 8;
const MOMENTUM_MIN_START_VELOCITY = 0.035;
const MOMENTUM_STOP_VELOCITY = 0.01;
const MOMENTUM_MAX_VELOCITY = 2.4;
const MOMENTUM_DECAY_PER_FRAME = 0.94;
const MOMENTUM_BOOST = 2.5;
const SCROLLBAR_GUTTER_PX = 26;
const FRAME_DURATION_MS = 16.67;

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
let lockedMobileFontSize = null;
let pinAnimationFrame = null;
let pinnedViewportUntil = 0;
let reconnectingManually = false;
let momentumAnimationFrame = null;
let momentumVelocity = 0;
let momentumLastTime = 0;
let momentumRemainder = 0;

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
		lockedMobileFontSize = null;
	}
}

function refreshMobileUiMode() {
	setMobileUiEnabled(isTouchDevice() && mobileWidthQuery.matches);
}

function setStatus(state) {
	const isConnected = state === "connected" || state === "running";
	connectionDotEl.classList.toggle("connected", isConnected);
	connectionDotEl.setAttribute("aria-label", isConnected ? "Connected" : "Disconnected");
	reconnectButton.setAttribute("title", isConnected ? "Reconnect (connected)" : "Reconnect");
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

function computeMobileFontSize() {
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

function desiredFontSize() {
	if (!mobileUiEnabled) return 14;
	const computed = computeMobileFontSize();
	if (lockedMobileFontSize === null || computed < lockedMobileFontSize) {
		lockedMobileFontSize = computed;
	}
	return lockedMobileFontSize;
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

function getTerminalViewportElement() {
	return terminalEl.querySelector(".xterm-viewport");
}

function shouldKeepViewportPinned() {
	const viewportEl = getTerminalViewportElement();
	if (!viewportEl) return true;
	return viewportEl.scrollTop + viewportEl.clientHeight >= viewportEl.scrollHeight - 8;
}

function scrollTerminalByLines(lines) {
	if (lines === 0) return false;
	const viewportEl = getTerminalViewportElement();
	const before = viewportEl ? viewportEl.scrollTop : null;
	terminal.scrollLines(lines);
	if (!viewportEl || before === null) return true;
	return viewportEl.scrollTop !== before;
}

function stopMomentumScroll() {
	if (momentumAnimationFrame !== null) {
		window.cancelAnimationFrame(momentumAnimationFrame);
		momentumAnimationFrame = null;
	}
	momentumVelocity = 0;
	momentumRemainder = 0;
	momentumLastTime = 0;
}

function isScrollbarGestureStart(touch) {
	const viewportEl = getTerminalViewportElement();
	if (!viewportEl) return false;
	const bounds = viewportEl.getBoundingClientRect();
	return touch.clientX >= bounds.right - SCROLLBAR_GUTTER_PX;
}

function startMomentumScroll(initialVelocity) {
	if (!mobileUiEnabled) return;

	const clampedVelocity = Math.max(-MOMENTUM_MAX_VELOCITY, Math.min(MOMENTUM_MAX_VELOCITY, initialVelocity));
	if (Math.abs(clampedVelocity) < MOMENTUM_MIN_START_VELOCITY) return;

	stopMomentumScroll();
	momentumVelocity = clampedVelocity;
	momentumLastTime = performance.now();

	const step = (now) => {
		const deltaMs = Math.max(1, now - momentumLastTime);
		momentumLastTime = now;

		const decay = Math.pow(MOMENTUM_DECAY_PER_FRAME, deltaMs / FRAME_DURATION_MS);
		momentumVelocity *= decay;

		if (Math.abs(momentumVelocity) < MOMENTUM_STOP_VELOCITY) {
			stopMomentumScroll();
			return;
		}

		momentumRemainder += momentumVelocity * deltaMs;
		const lines = Math.trunc(-momentumRemainder / TOUCH_SCROLL_PIXELS_PER_LINE);

		let moved = true;
		if (lines !== 0) {
			moved = scrollTerminalByLines(lines);
			momentumRemainder += lines * TOUCH_SCROLL_PIXELS_PER_LINE;
		}

		if (!moved) {
			stopMomentumScroll();
			return;
		}

		momentumAnimationFrame = window.requestAnimationFrame(step);
	};

	momentumAnimationFrame = window.requestAnimationFrame(step);
}

function pinViewportFor(durationMs = 150) {
	if (!mobileUiEnabled) return;
	pinnedViewportUntil = performance.now() + durationMs;

	if (pinAnimationFrame !== null) {
		return;
	}

	const step = () => {
		if (performance.now() >= pinnedViewportUntil) {
			pinAnimationFrame = null;
			return;
		}
		terminal.scrollToBottom();
		pinAnimationFrame = window.requestAnimationFrame(step);
	};

	step();
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
		if (message.state === "running") {
			setStatus("connected");
		} else if (message.state === "starting") {
			setStatus("connecting");
		} else if (message.state === "stopped") {
			isStopped = true;
			setStatus("stopped");
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
	setStatus("connecting");

	const wsUrl = socketUrl();
	const nextSocket = new WebSocket(wsUrl);
	socket = nextSocket;

	nextSocket.addEventListener("open", () => {
		reconnectingManually = false;
		setStatus("connected");
		sendResize();
	});

	nextSocket.addEventListener("message", (event) => {
		const raw = typeof event.data === "string" ? event.data : "";
		handleServerMessage(raw);
	});

	nextSocket.addEventListener("close", () => {
		if (isStopped) return;
		if (reconnectingManually) {
			reconnectingManually = false;
			return;
		}
		setStatus("disconnected");
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
		pinViewportFor(150);
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
	stopMomentumScroll();
	const touch = event.touches[0];
	touchSession = {
		lastX: touch.clientX,
		lastY: touch.clientY,
		lastTime: performance.now(),
		velocityY: 0,
		ignoreGesture: isScrollbarGestureStart(touch),
		totalX: 0,
		totalY: 0,
		scrollRemainder: 0,
		didScroll: false,
	};
}

function handleTouchMove(event) {
	if (!mobileUiEnabled || !touchSession || event.touches.length !== 1) return;
	if (touchSession.ignoreGesture) return;

	const touch = event.touches[0];
	const deltaX = touch.clientX - touchSession.lastX;
	const deltaY = touch.clientY - touchSession.lastY;
	const now = performance.now();
	const deltaMs = Math.max(1, now - touchSession.lastTime);
	const instantVelocityY = deltaY / deltaMs;

	touchSession.lastX = touch.clientX;
	touchSession.lastY = touch.clientY;
	touchSession.lastTime = now;
	touchSession.velocityY = touchSession.velocityY * 0.75 + instantVelocityY * 0.25;
	touchSession.totalX += deltaX;
	touchSession.totalY += deltaY;

	if (Math.abs(touchSession.totalY) < Math.abs(touchSession.totalX)) {
		return;
	}

	event.preventDefault();
	touchSession.scrollRemainder += deltaY;
	const lines = Math.trunc(-touchSession.scrollRemainder / TOUCH_SCROLL_PIXELS_PER_LINE);
	if (lines === 0) return;

	const moved = scrollTerminalByLines(lines);
	touchSession.scrollRemainder += lines * TOUCH_SCROLL_PIXELS_PER_LINE;
	if (moved) {
		touchSession.didScroll = true;
	}
}

function handleTouchEnd() {
	if (!mobileUiEnabled || !touchSession) return;
	const { totalX, totalY, didScroll, velocityY, ignoreGesture } = touchSession;
	touchSession = null;

	if (ignoreGesture) return;

	if (didScroll) {
		const releaseVelocity = Math.abs(velocityY) >= MOMENTUM_MIN_START_VELOCITY ? velocityY : 0;
		if (releaseVelocity !== 0 && Math.sign(releaseVelocity) === Math.sign(totalY || releaseVelocity)) {
			startMomentumScroll(releaseVelocity * MOMENTUM_BOOST);
		}
		return;
	}

	if (Math.abs(totalX) <= TAP_FOCUS_THRESHOLD && Math.abs(totalY) <= TAP_FOCUS_THRESHOLD) {
		terminal.focus();
	}
}

terminalWrapperEl.addEventListener("touchstart", handleTouchStart, { passive: true });
terminalWrapperEl.addEventListener("touchmove", handleTouchMove, { passive: false });
terminalWrapperEl.addEventListener("touchend", handleTouchEnd, { passive: true });
terminalWrapperEl.addEventListener("touchcancel", handleTouchEnd, { passive: true });

terminal.onData((data) => {
	sendMessage({ type: "input", data });
});

reconnectButton.addEventListener("click", () => {
	isStopped = false;
	clearReconnectTimer();

	if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
		reconnectingManually = true;
		try {
			socket.close(1000, "manual reconnect");
		} catch {
			// Ignore close failures.
		}
		window.setTimeout(() => {
			if (!isStopped) {
				connect();
			}
		}, 40);
		return;
	}

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
	stopMomentumScroll();
	if (pinAnimationFrame !== null) {
		window.cancelAnimationFrame(pinAnimationFrame);
		pinAnimationFrame = null;
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
setStatus("connecting");
connect();

const bootstrap = window.__PI_WEB_BOOTSTRAP__;
const reconnectButton = document.getElementById("reconnect");
const menuToggleButton = document.getElementById("menu-toggle");
const menuCloseButton = document.getElementById("menu-close");
const panelBackdropEl = document.getElementById("panel-backdrop");
const controlPanelEl = document.getElementById("control-panel");
const panelTabs = Array.from(document.querySelectorAll(".panel-tab"));
const panelSections = Array.from(document.querySelectorAll(".panel-section"));
const panelStatusTextEl = document.getElementById("panel-status-text");
const panelActiveSessionEl = document.getElementById("panel-active-session");
const panelStartSessionButton = document.getElementById("panel-start-session");
const panelStopSessionButton = document.getElementById("panel-stop-session");
const panelRestartSessionButton = document.getElementById("panel-restart-session");
const panelRefreshButton = document.getElementById("panel-refresh");
const panelProviderInput = document.getElementById("panel-provider-input");
const panelModelInput = document.getElementById("panel-model-input");
const panelNoSessionInput = document.getElementById("panel-no-session");
const panelSelectedProjectEl = document.getElementById("panel-selected-project");
const panelProjectPathInput = document.getElementById("panel-project-path");
const panelProjectIdInput = document.getElementById("panel-project-id");
const panelProjectAddButton = document.getElementById("panel-project-add");
const panelProjectListEl = document.getElementById("panel-project-list");
const panelRecentListEl = document.getElementById("panel-recent-list");
const panelSavedSessionListEl = document.getElementById("panel-saved-session-list");
const terminalEl = document.getElementById("terminal");
const terminalWrapperEl = document.getElementById("terminal-wrapper");
const mobileKeybarEl = document.getElementById("mobile-keybar");
const mobileKeyButtons = Array.from(document.querySelectorAll("#mobile-keybar [data-key]"));
const mobileWidthQuery = window.matchMedia("(max-width: 900px)");
const coarsePointerQuery = window.matchMedia("(pointer: coarse)");

if (!bootstrap || typeof bootstrap.token !== "string" || typeof bootstrap.wsPath !== "string") {
	throw new Error("Invalid web bootstrap configuration");
}

if (
	!reconnectButton ||
	!menuToggleButton ||
	!menuCloseButton ||
	!panelBackdropEl ||
	!controlPanelEl ||
	!panelStatusTextEl ||
	!panelActiveSessionEl ||
	!panelStartSessionButton ||
	!panelStopSessionButton ||
	!panelRestartSessionButton ||
	!panelRefreshButton ||
	!panelProviderInput ||
	!panelModelInput ||
	!panelNoSessionInput ||
	!panelSelectedProjectEl ||
	!panelProjectPathInput ||
	!panelProjectIdInput ||
	!panelProjectAddButton ||
	!panelProjectListEl ||
	!panelRecentListEl ||
	!panelSavedSessionListEl ||
	!terminalEl ||
	!terminalWrapperEl ||
	!mobileKeybarEl
) {
	throw new Error("Missing required web terminal UI elements");
}

const MOBILE_KEY_SEQUENCES = {
	esc: "\u001b",
	up: "\u001b[A",
	down: "\u001b[B",
	enter: "\r",
};

const TOUCH_SCROLL_PIXELS_PER_LINE = 10;
const TAP_FOCUS_THRESHOLD = 8;
const MOMENTUM_MIN_START_VELOCITY = 0.015;
const MOMENTUM_STOP_VELOCITY = 0.004;
const MOMENTUM_MAX_VELOCITY = 8.0;
const MOMENTUM_BOOST = 4.0;
const MOMENTUM_DECAY_SLOW = 0.99;
const MOMENTUM_DECAY_FAST = 0.97;
const MOMENTUM_DECAY_SPEED_THRESHOLD = 1.5;
const VELOCITY_SAMPLE_WINDOW_MS = 80;
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
let panelOpen = false;
let panelActiveTab = "session";
let panelSelectedProjectId = null;
let panelHostState = null;
let panelProjects = [];
let panelRecentSessions = [];
let panelSavedSessions = [];
let panelSavedSessionsSource = null;
let panelSavedSessionsInFlight = null;
let panelSyncInFlight = null;
let panelMessageTimeout = null;
let panelTransientMessage = null;

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

function statusLabel(state) {
	if (state === "connected") return "running";
	if (state === "disconnected") return "disconnected";
	if (state === "connecting") return "connecting";
	if (state === "stopped") return "stopped";
	return state;
}

function setStatus(state) {
	const isConnected = state === "connected" || state === "running";
	reconnectButton.setAttribute("title", isConnected ? "Reconnect (connected)" : "Reconnect");
	if (menuToggleButton) {
		menuToggleButton.setAttribute("title", `Session menu (${statusLabel(state)})`);
	}
	if (panelHostState) {
		panelHostState = { ...panelHostState, connected: isConnected, state: statusLabel(state) };
		renderPanel();
	}
}

function setPanelOpen(open) {
	panelOpen = open;
	document.body.classList.toggle("panel-open", panelOpen);
	controlPanelEl.setAttribute("aria-hidden", panelOpen ? "false" : "true");
	if (panelOpen) {
		void syncPanelState(true).then(() => {
			void syncSavedSessions(true);
		});
	}
}

function setPanelTab(tabName) {
	panelActiveTab = tabName === "repos" ? "repos" : "session";
	for (const tab of panelTabs) {
		const tabNameValue = tab.getAttribute("data-panel-tab");
		const isActive = tabNameValue === panelActiveTab;
		tab.classList.toggle("active", isActive);
		tab.setAttribute("aria-selected", isActive ? "true" : "false");
	}
	for (const section of panelSections) {
		const sectionName = section.getAttribute("data-panel-section");
		section.hidden = sectionName !== panelActiveTab;
	}
	if (panelActiveTab === "session") {
		void syncSavedSessions(false);
	}
}

function trimToUndefined(value) {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function getSelectedProject() {
	if (!panelSelectedProjectId) return null;
	return panelProjects.find((project) => project.id === panelSelectedProjectId) || null;
}

function formatRelativeTime(value) {
	if (typeof value !== "string") return "";
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return "";
	const deltaMinutes = Math.floor((Date.now() - timestamp) / 60000);
	if (deltaMinutes < 1) return "just now";
	if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
	const deltaHours = Math.floor(deltaMinutes / 60);
	if (deltaHours < 24) return `${deltaHours}h ago`;
	const deltaDays = Math.floor(deltaHours / 24);
	return `${deltaDays}d ago`;
}

function launchPayloadFromInputs() {
	return {
		provider: trimToUndefined(panelProviderInput.value),
		model: trimToUndefined(panelModelInput.value),
		noSession: Boolean(panelNoSessionInput.checked),
	};
}

function setPanelNotice(message) {
	panelTransientMessage = message;
	if (panelMessageTimeout) {
		window.clearTimeout(panelMessageTimeout);
	}
	panelMessageTimeout = window.setTimeout(() => {
		panelTransientMessage = null;
		renderPanel();
	}, 2800);
	renderPanel();
}

function panelErrorMessage(error, fallback) {
	if (error && typeof error === "object" && typeof error.message === "string") {
		return error.message;
	}
	return fallback;
}

async function fetchJson(path, init = {}) {
	const requestInit = {
		cache: "no-store",
		...init,
	};
	const response = await fetch(path, requestInit);
	let body = null;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	if (!response.ok) {
		const message =
			body && typeof body === "object" && typeof body.error === "string"
				? body.error
				: `Request failed: ${response.status}`;
		throw new Error(message);
	}
	return body;
}

function renderPanelProjects() {
	panelProjectListEl.replaceChildren();
	if (!Array.isArray(panelProjects) || panelProjects.length === 0) {
		const empty = document.createElement("div");
		empty.className = "panel-empty";
		empty.textContent = "No repos configured.";
		panelProjectListEl.appendChild(empty);
		return;
	}

	for (const project of panelProjects) {
		const item = document.createElement("div");
		item.className = "panel-list-item";
		if (project.id === panelSelectedProjectId) {
			item.classList.add("active");
		}

		const title = document.createElement("div");
		title.className = "panel-item-title";
		title.textContent = project.id;

		const path = document.createElement("div");
		path.className = "panel-item-path";
		path.textContent = project.path;

		const row = document.createElement("div");
		row.className = "panel-row-3";

		const useButton = document.createElement("button");
		useButton.type = "button";
		useButton.textContent = "Use";
		useButton.addEventListener("click", () => {
			panelSelectedProjectId = project.id;
			renderPanel();
			void syncSavedSessions(true);
		});

		const startButton = document.createElement("button");
		startButton.type = "button";
		startButton.textContent = "Start";
		startButton.addEventListener("click", () => {
			panelSelectedProjectId = project.id;
			void startSessionFromPanel();
		});

		const deleteButton = document.createElement("button");
		deleteButton.type = "button";
		deleteButton.textContent = "Delete";
		deleteButton.addEventListener("click", () => {
			void deleteProject(project.id);
		});

		row.append(useButton, startButton, deleteButton);
		item.append(title, path, row);
		panelProjectListEl.appendChild(item);
	}
}

function renderPanelRecent() {
	panelRecentListEl.replaceChildren();
	if (!Array.isArray(panelRecentSessions) || panelRecentSessions.length === 0) {
		const empty = document.createElement("div");
		empty.className = "panel-empty";
		empty.textContent = "No recent sessions.";
		panelRecentListEl.appendChild(empty);
		return;
	}

	for (const session of panelRecentSessions.slice(0, 12)) {
		const item = document.createElement("div");
		item.className = "panel-list-item";

		const title = document.createElement("div");
		title.className = "panel-item-title";
		title.textContent = session.projectId ? `${session.projectId}` : "Host directory";

		const path = document.createElement("div");
		path.className = "panel-item-path";
		path.textContent = session.cwd;

		const meta = document.createElement("div");
		meta.className = "panel-item-meta";
		const modelLabel = session.model ? `${session.provider || "default"}/${session.model}` : session.provider || "default";
		meta.textContent = `${session.state} • ${modelLabel}`;

		const row = document.createElement("div");
		row.className = "panel-row";

		const relaunchButton = document.createElement("button");
		relaunchButton.type = "button";
		relaunchButton.textContent = "Relaunch";
		relaunchButton.addEventListener("click", () => {
			void relaunchRecentSession(session);
		});

		const useButton = document.createElement("button");
		useButton.type = "button";
		useButton.textContent = "Use Repo";
		useButton.disabled = !session.projectId;
		useButton.addEventListener("click", () => {
			if (!session.projectId) return;
			panelSelectedProjectId = session.projectId;
			renderPanel();
			void syncSavedSessions(true);
		});

		row.append(relaunchButton, useButton);
		item.append(title, path, meta, row);
		panelRecentListEl.appendChild(item);
	}
}

function renderSavedSessions() {
	panelSavedSessionListEl.replaceChildren();
	const project = getSelectedProject();
	if (!project) {
		const empty = document.createElement("div");
		empty.className = "panel-empty";
		empty.textContent = "Select a repo in Repos first.";
		panelSavedSessionListEl.appendChild(empty);
		return;
	}

	if (!Array.isArray(panelSavedSessions) || panelSavedSessions.length === 0) {
		const empty = document.createElement("div");
		empty.className = "panel-empty";
		empty.textContent = "No saved sessions in this repo.";
		panelSavedSessionListEl.appendChild(empty);
		return;
	}

	for (const session of panelSavedSessions.slice(0, 20)) {
		const item = document.createElement("div");
		item.className = "panel-list-item";

		const title = document.createElement("div");
		title.className = "panel-item-title";
		title.textContent = session.name ? `${session.name}` : `Session ${session.id.slice(0, 8)}`;

		const path = document.createElement("div");
		path.className = "panel-item-path";
		path.textContent = session.path;

		const meta = document.createElement("div");
		meta.className = "panel-item-meta";
		meta.textContent = `${session.messageCount} msgs • ${formatRelativeTime(session.modified)}`;

		const row = document.createElement("div");
		row.className = "panel-row";

		const resumeButton = document.createElement("button");
		resumeButton.type = "button";
		resumeButton.textContent = "Resume";
		resumeButton.addEventListener("click", () => {
			void startSessionFromPanel({
				projectId: project.id,
				sessionPath: session.path,
				noSession: false,
			});
		});

		const useButton = document.createElement("button");
		useButton.type = "button";
		useButton.textContent = "Copy Prompt";
		useButton.disabled = typeof session.firstMessage !== "string" || session.firstMessage.length === 0;
		useButton.addEventListener("click", async () => {
			const text = typeof session.firstMessage === "string" ? session.firstMessage : "";
			if (!text) return;
			try {
				await navigator.clipboard.writeText(text);
				setPanelNotice("First prompt copied");
			} catch {
				setPanelNotice("Clipboard unavailable");
			}
		});

		row.append(resumeButton, useButton);
		item.append(title, path, meta, row);
		panelSavedSessionListEl.appendChild(item);
	}
}

function renderPanel() {
	const hostState = panelHostState || { state: "unknown", reason: undefined, connected: false };
	const reasonText = hostState.reason ? ` (${hostState.reason})` : "";
	panelStatusTextEl.textContent = `State: ${hostState.state}${reasonText}`;
	if (panelTransientMessage) {
		panelStatusTextEl.textContent += ` • ${panelTransientMessage}`;
	}

	const activeSession = hostState.activeSession;
	if (activeSession) {
		const modelLabel = activeSession.model ? `${activeSession.provider || "default"}/${activeSession.model}` : activeSession.provider || "default";
		panelActiveSessionEl.textContent = `${activeSession.cwd} • ${modelLabel}`;
	} else {
		panelActiveSessionEl.textContent = "No active session";
	}

	if (hostState.launchDefaults) {
		if (document.activeElement !== panelProviderInput) {
			panelProviderInput.value = hostState.launchDefaults.provider || "";
		}
		if (document.activeElement !== panelModelInput) {
			panelModelInput.value = hostState.launchDefaults.model || "";
		}
		panelNoSessionInput.checked = Boolean(hostState.launchDefaults.noSession);
	}

	const selectedProject = getSelectedProject();
	panelSelectedProjectEl.textContent = selectedProject
		? `${selectedProject.id} • ${selectedProject.path}`
		: "No repo selected.";

	const hasActiveSession = Boolean(activeSession);
	panelStopSessionButton.disabled = !hasActiveSession;
	panelRestartSessionButton.disabled = !hasActiveSession;

	renderPanelProjects();
	renderPanelRecent();
	renderSavedSessions();
}

async function syncPanelState(force = false) {
	if (panelSyncInFlight && !force) {
		return panelSyncInFlight;
	}
	panelSyncInFlight = (async () => {
		const [state, projects, recent] = await Promise.all([
			fetchJson("/api/web/state"),
			fetchJson("/api/web/projects"),
			fetchJson("/api/web/sessions/recent"),
		]);
		panelHostState = state;
		panelProjects = Array.isArray(projects) ? projects : [];
		panelRecentSessions = Array.isArray(recent) ? recent : [];
		if (panelSelectedProjectId && !panelProjects.some((project) => project.id === panelSelectedProjectId)) {
			panelSelectedProjectId = null;
		}
		if (!panelSelectedProjectId && state && state.activeSession && state.activeSession.projectId) {
			panelSelectedProjectId = state.activeSession.projectId;
		}
		renderPanel();
		void syncSavedSessions(false);
	})()
		.catch((error) => {
			const message = panelErrorMessage(error, "Failed to sync menu state");
			panelTransientMessage = message;
			renderPanel();
			terminal.writeln(`\r\n[web] ${message}\r\n`);
		})
		.finally(() => {
			panelSyncInFlight = null;
		});
	return panelSyncInFlight;
}

async function syncSavedSessions(force = false) {
	const project = getSelectedProject();
	if (!project) {
		panelSavedSessions = [];
		panelSavedSessionsSource = null;
		renderSavedSessions();
		return;
	}
	if (
		panelSavedSessionsInFlight &&
		!force &&
		panelSavedSessionsSource === project.id
	) {
		return panelSavedSessionsInFlight;
	}
	panelSavedSessionsSource = project.id;
	panelSavedSessionsInFlight = (async () => {
		const sessions = await fetchJson(`/api/web/sessions?projectId=${encodeURIComponent(project.id)}`);
		panelSavedSessions = Array.isArray(sessions) ? sessions : [];
		renderSavedSessions();
	})()
		.catch((error) => {
			panelSavedSessions = [];
			setPanelNotice(panelErrorMessage(error, "Failed to load saved sessions"));
			renderSavedSessions();
		})
		.finally(() => {
			panelSavedSessionsInFlight = null;
		});
	return panelSavedSessionsInFlight;
}

async function startSessionFromPanel(overrides = {}) {
	const payload = {
		...launchPayloadFromInputs(),
		...overrides,
	};
	if (!payload.projectId && panelSelectedProjectId) {
		payload.projectId = panelSelectedProjectId;
	}
	if (payload.sessionPath) {
		payload.noSession = false;
	}
	try {
		await fetchJson("/api/web/session/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		setPanelNotice("Session started");
		await syncPanelState(true);
		await syncSavedSessions(true);
	} catch (error) {
		setPanelNotice(panelErrorMessage(error, "Failed to start session"));
	}
}

async function stopSessionFromPanel() {
	try {
		await fetchJson("/api/web/session/stop", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		setPanelNotice("Session stopped");
		await syncPanelState(true);
		await syncSavedSessions(true);
	} catch (error) {
		setPanelNotice(panelErrorMessage(error, "Failed to stop session"));
	}
}

async function restartSessionFromPanel() {
	try {
		await fetchJson("/api/web/session/restart", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(launchPayloadFromInputs()),
		});
		setPanelNotice("Session restarted");
		await syncPanelState(true);
		await syncSavedSessions(true);
	} catch (error) {
		setPanelNotice(panelErrorMessage(error, "Failed to restart session"));
	}
}

async function addProjectFromPanel() {
	const path = panelProjectPathInput.value.trim();
	const id = panelProjectIdInput.value.trim();
	if (path.length === 0) {
		setPanelNotice("Repo path is required");
		return;
	}
	try {
		const created = await fetchJson("/api/web/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				path,
				id: id.length > 0 ? id : undefined,
			}),
		});
		panelProjectPathInput.value = "";
		panelProjectIdInput.value = "";
		if (created && typeof created.id === "string") {
			panelSelectedProjectId = created.id;
		}
		setPanelNotice("Repo added");
		await syncPanelState(true);
		await syncSavedSessions(true);
	} catch (error) {
		setPanelNotice(panelErrorMessage(error, "Failed to add repo"));
	}
}

async function deleteProject(projectId) {
	const project = panelProjects.find((entry) => entry.id === projectId);
	const label = project ? project.id : projectId;
	if (!window.confirm(`Delete repo '${label}'?`)) {
		return;
	}
	try {
		await fetchJson(`/api/web/projects/${encodeURIComponent(projectId)}`, {
			method: "DELETE",
		});
		if (panelSelectedProjectId === projectId) {
			panelSelectedProjectId = null;
		}
		setPanelNotice("Repo deleted");
		await syncPanelState(true);
		await syncSavedSessions(true);
	} catch (error) {
		setPanelNotice(panelErrorMessage(error, "Failed to delete repo"));
	}
}

async function relaunchRecentSession(session) {
	const payload = {
		projectId: session.projectId || undefined,
		cwd: session.projectId ? undefined : session.cwd,
		provider: session.provider || undefined,
		model: session.model || undefined,
		sessionPath: session.sessionPath || undefined,
		noSession: session.sessionPath ? false : Boolean(session.noSession),
	};
	try {
		await fetchJson("/api/web/session/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (session.projectId) {
			panelSelectedProjectId = session.projectId;
		}
		setPanelNotice("Session relaunched");
		await syncPanelState(true);
		await syncSavedSessions(true);
	} catch (error) {
		setPanelNotice(panelErrorMessage(error, "Failed to relaunch session"));
	}
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

		const absV = Math.abs(momentumVelocity);
		const t = Math.min(1, absV / MOMENTUM_DECAY_SPEED_THRESHOLD);
		const frameDecay = MOMENTUM_DECAY_SLOW * (1 - t) + MOMENTUM_DECAY_FAST * t;
		const decay = Math.pow(frameDecay, deltaMs / FRAME_DURATION_MS);
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
			setStatus("stopped");
		}
		void syncPanelState(true);
		return;
	}

	if (message.type === "error" && typeof message.message === "string") {
		terminal.writeln(`\r\n[host error] ${message.message}\r\n`);
	}
}

function connect() {
	clearReconnectTimer();
	setStatus("connecting");

	const wsUrl = socketUrl();
	const nextSocket = new WebSocket(wsUrl);
	socket = nextSocket;

	nextSocket.addEventListener("open", () => {
		reconnectingManually = false;
		setStatus("connected");
		sendResize();
		void syncPanelState(true);
	});

	nextSocket.addEventListener("message", (event) => {
		const raw = typeof event.data === "string" ? event.data : "";
		handleServerMessage(raw);
	});

	nextSocket.addEventListener("close", () => {
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
	const now = performance.now();
	touchSession = {
		lastX: touch.clientX,
		lastY: touch.clientY,
		lastTime: now,
		samples: [{ y: touch.clientY, t: now }],
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

	touchSession.lastX = touch.clientX;
	touchSession.lastY = touch.clientY;
	touchSession.lastTime = now;
	touchSession.samples.push({ y: touch.clientY, t: now });
	const cutoff = now - VELOCITY_SAMPLE_WINDOW_MS * 2;
	while (touchSession.samples.length > 2 && touchSession.samples[0].t < cutoff) {
		touchSession.samples.shift();
	}
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

function computeReleaseVelocity(samples) {
	const now = performance.now();
	const windowStart = now - VELOCITY_SAMPLE_WINDOW_MS;
	let startIdx = samples.length - 1;
	for (let i = samples.length - 1; i >= 0; i--) {
		if (samples[i].t >= windowStart) startIdx = i;
		else break;
	}
	const first = samples[startIdx];
	const last = samples[samples.length - 1];
	const dt = last.t - first.t;
	if (dt < 5) return 0;
	return (last.y - first.y) / dt;
}

function handleTouchEnd() {
	if (!mobileUiEnabled || !touchSession) return;
	const { totalX, totalY, didScroll, samples, ignoreGesture } = touchSession;
	touchSession = null;

	if (ignoreGesture) return;

	if (didScroll) {
		const velocityY = computeReleaseVelocity(samples);
		if (Math.abs(velocityY) >= MOMENTUM_MIN_START_VELOCITY) {
			startMomentumScroll(velocityY * MOMENTUM_BOOST);
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
	clearReconnectTimer();

	if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
		reconnectingManually = true;
		try {
			socket.close(1000, "manual reconnect");
		} catch {
			// Ignore close failures.
		}
		window.setTimeout(() => {
			connect();
		}, 40);
		return;
	}

	connect();
});

menuToggleButton.addEventListener("click", () => {
	setPanelOpen(!panelOpen);
});

menuCloseButton.addEventListener("click", () => {
	setPanelOpen(false);
});

panelBackdropEl.addEventListener("click", () => {
	setPanelOpen(false);
});

for (const tab of panelTabs) {
	tab.addEventListener("click", () => {
		const tabName = tab.getAttribute("data-panel-tab") || "session";
		setPanelTab(tabName);
	});
}

panelStartSessionButton.addEventListener("click", () => {
	void startSessionFromPanel();
});

panelStopSessionButton.addEventListener("click", () => {
	void stopSessionFromPanel();
});

panelRestartSessionButton.addEventListener("click", () => {
	void restartSessionFromPanel();
});

panelRefreshButton.addEventListener("click", () => {
	void syncPanelState(true).then(() => {
		void syncSavedSessions(true);
	});
});

panelProjectAddButton.addEventListener("click", () => {
	void addProjectFromPanel();
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
	if (panelMessageTimeout) {
		window.clearTimeout(panelMessageTimeout);
		panelMessageTimeout = null;
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
setPanelTab("session");
renderPanel();
void syncPanelState(true);
fitTerminal();
terminal.focus();
terminal.writeln("pi web terminal ready.");
terminal.writeln("Waiting for session output...\r\n");
setStatus("connecting");
connect();

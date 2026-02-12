# spec-zzz: Browser-Hosted `pi` (RPC Mode) With Terminal-Parity UX

## 1) Goal
Deliver a browser client for `pi` coding-agent that preserves the core CLI/TUI interaction model by running `pi --mode rpc` on the host and bridging to web UI over HTTP + SSE.

Primary intent:
- Reuse existing `pi-mono` components and protocol contracts
- Minimize bespoke protocol invention
- Keep the browser experience behaviorally close to terminal usage
- Be robust enough for unattended overnight progress

## 2) Context and Constraints
- Repository: `pi-mono`
- Implement in-repo first (close to core code, fast reuse, no drift)
- Commit allowed; do not push
- Live model validation target: `openrouter / z-ai/glm-4.7`
- Process hygiene required (no leaked host, agent, or browser automation processes)
- After code edits: `npm run check` must pass

## 3) Why This Is Doable
This is already structurally supported:
1. RPC protocol is fully documented and typed in `packages/coding-agent/src/modes/rpc/rpc-types.ts`
1. Existing RPC client implementation exists in `packages/coding-agent/src/modes/rpc/rpc-client.ts`
1. Extension UI RPC protocol (dialog + fire-and-forget methods) is already defined and used
1. Existing examples (`examples/rpc-extension-ui.ts`, `examples/extensions/rpc-demo.ts`) provide reference interaction behavior
1. `packages/web-ui` already contains message rendering and runtime-bridge patterns to reuse for long-term UX

No protocol redesign is required for MVP.

## 4) Product Definition of Done
Done means all of the following are true:
1. Browser can start a local RPC session and receive a stable session id
1. Browser prompt sends produce streamed assistant text
1. Abort interrupts active run
1. Extension UI methods work end-to-end:
   - dialog: `select`, `confirm`, `input`, `editor`
   - fire-and-forget: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`
1. Terminal-parity behavior is visible in browser:
   - user/assistant turn rhythm
   - tool start/result line feedback
   - status/widget updates
1. Session lifecycle is robust:
   - explicit stop
   - idle timeout cleanup
   - host shutdown cleanup for all children
1. `npm run check` passes
1. Browser smoke passes with Playwright CLI using `openrouter/z-ai/glm-4.7`
1. No orphan processes remain after tests
1. Local commit created (no push)

## 5) Architecture
### 5.1 Runtime Model
Browser <-> local host (HTTP/SSE) <-> `pi --mode rpc` subprocess.

### 5.2 Host Responsibilities
- Serve static web client
- Start/stop RPC subprocesses (one per browser session)
- Forward command payloads to stdin
- Parse stdout JSON lines and classify:
  - `RpcResponse`
  - `RpcExtensionUIRequest`
  - `AgentEvent`
- Stream all events to browser via SSE
- Enforce cleanup semantics

### 5.3 Browser Responsibilities
- Session controls (start/stop)
- Prompt + abort
- Stream rendering (assistant + terminal-style feed)
- Extension UI request handling (prompt/confirm/select/editor dialogs)
- Status and widget projection

### 5.4 Reuse-first Principle
Prefer imports and patterns from existing code:
1. RPC protocol types from `src/modes/rpc/rpc-types.ts`
1. Event handling behavior from `examples/rpc-extension-ui.ts`
1. UI composition ideas from `packages/web-ui` for long-term follow-up

## 6) API Contract (Local Host)
### `POST /api/session/start`
Input:
- `provider?: string`
- `modelId?: string`
- `cwd?: string`
- `noSession?: boolean` (default true)
- `loadRpcDemoExtension?: boolean` (default true)
- `extraExtensions?: string[]`

Output:
- `{ sessionId: string }`

### `GET /api/session/:id/events`
SSE stream of host-framed events:
- `session_started`
- `rpc_response`
- `agent_event`
- `extension_ui_request`
- `stderr`
- `session_error`
- `session_stopped`

### `POST /api/session/:id/command`
Input:
- `RpcCommand` OR `RpcExtensionUIResponse`

Output:
- `{ ok: true }` or typed error response

### `POST /api/session/:id/stop`
Output:
- `{ ok: true }`

### `GET /health`
Output:
- `{ ok: true, sessions: number }`

## 7) Executable Resolution Strategy
Host selects startup path by precedence:
1. `pi` from `PATH`
1. local built CLI (`dist/cli.js`)
1. source fallback (`npx --yes tsx src/cli.ts`)

This prevents environment-specific startup failures and supports both installed and source workflows.

## 8) Terminal-Parity UX Contract (Browser)
The browser must emulate key terminal mental model:
1. clear separation of `You:` and `Agent:` outputs
1. incremental text delta rendering
1. compact tool lifecycle lines (`[tool: ...]`, `[result: ...]`)
1. visible notifications/status/widgets
1. simple, keyboard-friendly send behavior (Ctrl/Cmd+Enter)

Not required for MVP:
- exact TUI keybinding parity
- full ncurses-like control
- all interactive-mode specific widgets

## 9) Failure Model and Recovery
### 9.1 Failure Classes
1. Process startup failure
1. Protocol parse failure
1. Session process died mid-stream
1. Invalid client command payload
1. SSE disconnect and stale session
1. Provider/model auth/runtime errors

### 9.2 Required Recovery Behavior
1. Emit `session_error` with actionable text
1. Keep host alive even if one session crashes
1. Auto-stop idle disconnected sessions
1. Kill all sessions on host shutdown signals
1. Surface rpc `success:false` errors in event log and terminal feed

## 10) Blocker-Clearing Protocol (Overnight)
Whenever blocked:
1. run `date` and note timestamp
1. capture failing command and error signature
1. classify blocker:
   - env/tooling
   - type/build
   - runtime integration
   - provider/model
1. choose shortest unblocking path without dropping scope
1. rerun minimal failing step
1. rerun full validation gate before marking resolved

Never stop at partial workaround if core Done criteria remain unmet.

## 11) Validation Matrix
### 11.1 Static/Type Gate
- `npm run check`
- must be clean (errors/warnings/infos fixed)

### 11.2 Host/API Gate
1. start host
1. `GET /health`
1. start session via API
1. send prompt command
1. observe stream and rpc responses
1. stop session

### 11.3 Browser/UX Gate (Playwright CLI)
1. open page
1. start session
1. send deterministic prompt (`reply with exactly: OK`)
1. verify streamed assistant contains `OK`
1. trigger `/rpc-input`, `/rpc-editor`, `/rpc-prefill`
1. handle browser dialog and verify round-trip behavior
1. stop session

### 11.4 Cleanup Gate
1. stop host process
1. close and kill Playwright sessions
1. verify no leftover matching processes

## 12) Logging and Output Discipline
- Keep terminal output concise; prefer filtered summaries (`rg`) over large dumps
- Capture full logs only when needed for debugging
- Summarize key pass/fail lines in final report

## 13) Roadmap (MVP -> Production-grade)
### Phase A: MVP (current)
- Example host + browser client
- Typed RPC bridge
- Extension UI method coverage
- Playwright smoke + check gate

### Phase B: Shared-core hardening
- Extract host session manager into reusable module
- Add integration tests for command/event bridge
- Add reconnect token and resumable SSE
- Add structured logs + metrics counters

### Phase C: Web UX convergence
- Replace custom DOM rendering with reusable `packages/web-ui` building blocks
- Align message rendering with existing message components
- Add persistent sessions and conversation list
- Add model/thinking selectors with same semantics as terminal mode

### Phase D: Multi-user deployment
- Authn/authz layer
- tenant-scoped session processes
- quota and rate controls
- deployment topology and observability

## 14) Open Risks and Mitigations
1. Risk: drift between custom web event handling and core RPC changes
   Mitigation: strict reuse of `rpc-types.ts` and compile-time typing
1. Risk: source fallback startup failures in partial builds
   Mitigation: executable precedence + health checks + error surfacing
1. Risk: long-lived orphan sessions
   Mitigation: idle timeout + signal-based global shutdown + cleanup checks
1. Risk: browser dialogs are simplistic vs TUI interactivity
   Mitigation: keep for MVP; move to richer modal components in Phase C

## 15) Deliverables and File Map
- `packages/coding-agent/examples/rpc-web/host.ts`
- `packages/coding-agent/examples/rpc-web/public/index.html`
- `packages/coding-agent/examples/rpc-web/public/app.js`
- `packages/coding-agent/examples/rpc-web/README.md`
- `packages/coding-agent/examples/README.md`
- `spec-zzz.md` (this document)

## 16) Acceptance Checklist (Binary)
- [ ] Typed host bridge uses shared RPC types
- [ ] Browser stream shows user/agent/tool rhythm
- [ ] Extension UI protocol fully round-tripped
- [ ] Start/stop/abort/idle cleanup verified
- [ ] `npm run check` clean
- [ ] Playwright smoke clean with target provider/model
- [ ] Processes cleaned
- [ ] Local commit done (no push)

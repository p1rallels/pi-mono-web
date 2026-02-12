# RPC Web Example

Browser-hosted example for `pi --mode rpc` with a local Node host.

This demo provides:
- Session start/stop lifecycle
- Prompt + streaming output
- Abort support
- Extension UI protocol handling:
  - `select`, `confirm`, `input`, `editor`
  - `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`
- Terminal-style browser feed (`You:`, `Agent:`, tool/result lines) for TUI parity

## Run

```bash
cd packages/coding-agent
npx tsx examples/rpc-web/host.ts
```

Open:

```text
http://127.0.0.1:4317
```

## Model Setup

Defaults in the UI:
- Provider: `openrouter`
- Model: `z-ai/glm-4.7`

The host uses your existing pi credentials/environment from the machine where it runs.
Credentials never go to the browser directly.

Execution precedence:
1. `pi` from `PATH` (preferred)
2. local `dist/cli.js` if present
3. source fallback (`npx --yes tsx src/cli.ts`)

## Reuse-first Design

This example reuses existing coding-agent contracts instead of introducing custom protocol shapes:
- RPC command/response/event types from `src/modes/rpc/rpc-types.ts`
- Event interaction patterns from `examples/rpc-extension-ui.ts`
- Existing extension demo from `examples/extensions/rpc-demo.ts` for UI method exercise

## Notes

- By default the host starts sessions with `--no-session`.
- The host auto-loads `examples/extensions/rpc-demo.ts` so extension UI methods can be exercised.
- Sessions are stopped automatically when:
  - you click **Stop Session**
  - the browser disconnects and remains disconnected for 30s
  - the host receives `SIGINT`/`SIGTERM`

## API Endpoints (example host)

- `POST /api/session/start`
- `GET /api/session/:id/events` (SSE)
- `POST /api/session/:id/command`
- `POST /api/session/:id/stop`
- `GET /health`

`POST /api/session/:id/command` accepts:
- any valid `RpcCommand`
- `RpcExtensionUIResponse` for extension UI dialog replies

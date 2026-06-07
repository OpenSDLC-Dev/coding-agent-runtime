---
name: coding-agent-runtime-verify-web
description: Use after any UI change in coding-agent-runtime apps/web (page, component, typography, CSS). Drives the playground in a real browser via the Claude-in-Chrome MCP to confirm it works and is clean before responding.
---

# Verify a web change in a browser

Run a two-step pass in a real browser. Fix issues and re-verify before responding to the user.

## Setup

1. Start the runtime: `pnpm --filter @app/runtime dev` (`127.0.0.1:8080`).
2. Start the playground: `pnpm --filter @app/web dev` (Vite on `http://localhost:5173`).
3. Load the Claude-in-Chrome MCP tools (`ToolSearch` → `select:mcp__claude-in-chrome__...`),
   then open a new tab at `http://localhost:5173`.

## Step 1 — behaves as expected

1. **Connect.** Click the connection chip (`button.conn`), type `http://127.0.0.1:8080` into
   `input[aria-label="runtime base url"]`, and press Enter. Confirm the dot turns connected
   (`.conn-dot.ok`) and the model picker (`select[aria-label="model"]`) populates from `/config`.
2. **Send a turn.** Type a prompt in `textarea[aria-label="prompt"]` and send (Enter). Confirm a
   user bubble (`.msg-row.user .bubble.user`) and a streaming assistant bubble
   (`.msg-row.assistant .bubble.assistant`) render, and a result row (`.result-row` with
   `.rr-stats`) appears with token/cost/turn meta.
3. **Tool card.** If the turn used tools, expand a card (`.tool-card` → click `.tc-head`) and
   confirm the body (`.tc-body`) shows input/result.
4. **Stop.** Send another turn and stop it mid-stream; confirm the UI reflects the aborted state.
5. **New session.** Use the sidebar new-session control (`.new-session`); confirm a new item
   appears in `.session-list` (`.session-item` with a `.si-dot` status).

## Step 2 — quick audit

1. Read the browser console (`mcp__claude-in-chrome__read_console_messages`) — there must be no
   errors.
2. Watch for layout shift, overflow, or slow navigation while interacting.
3. (Optional, for performance-sensitive changes) capture a trace / Core Web Vitals via the
   Chrome DevTools MCP.

Selectors above reflect the current `apps/web/src/components/*`; if the DOM has changed, confirm
against the components first. This skill is the web branch of
`coding-agent-runtime-delivery-workflow`'s verify phase.

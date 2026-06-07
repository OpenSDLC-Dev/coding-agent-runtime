#!/usr/bin/env node
// Portable end-to-end smoke test for a *running* runtime.
//
// Polls /healthz, runs one real turn over SSE against POST /sessions, and asserts the
// stream carried both an `init` and a `result` event. This is the single source of truth
// for the real-turn smoke: the CI `smoke` job and local runs share this one file (no more
// curl + grep duplicated inside ci.yml). Pure HTTP client built on Node's global fetch
// (Node >= 18), so it runs identically on Windows, macOS, Linux, and CI without bash.
//
// The runtime under test holds the API key/backend config; this script never needs them.
//
// Usage:
//   node scripts/smoke.mjs                         # against http://127.0.0.1:8080
//   BASE_URL=http://host:port node scripts/smoke.mjs
//   node scripts/smoke.mjs --prompt "Reply with: ok"
//
// Env: BASE_URL, PROMPT, HEALTH_TIMEOUT_MS (default 30000), TURN_TIMEOUT_MS (default 120000).
// Exit: 0 = init + result observed; 1 = unreachable, HTTP error, or missing events.

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const args = process.argv.slice(2);
const promptFlag = args.indexOf("--prompt");
const PROMPT =
  promptFlag !== -1
    ? args[promptFlag + 1]
    : (process.env.PROMPT ?? "Reply with the single word: ok");
const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS ?? 30000);
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 120000);
const REQUIRED_EVENTS = ["init", "result"];

const log = (msg) => console.log(`[smoke] ${msg}`);
const fail = (msg) => {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) {
        log(`healthz ok at ${BASE_URL}`);
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  fail(`runtime not healthy within ${HEALTH_TIMEOUT_MS}ms at ${BASE_URL}/healthz`);
}

async function runTurn() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE_URL}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: PROMPT }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    fail(`POST /sessions failed: ${err.message}`);
  }
  if (!res.ok || !res.body) fail(`POST /sessions returned HTTP ${res.status}`);

  const seen = new Set();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // keep the trailing partial line for the next chunk
    for (const raw of lines) {
      const m = raw.trimEnd().match(/^event:\s*(.+)$/);
      if (m) {
        seen.add(m[1]);
        log(`event: ${m[1]}`);
      }
    }
  }
  clearTimeout(timer);
  return seen;
}

await waitForHealth();
const seen = await runTurn();
const missing = REQUIRED_EVENTS.filter((e) => !seen.has(e));
if (missing.length) {
  fail(`missing SSE events: ${missing.join(", ")} (saw: ${[...seen].join(", ") || "none"})`);
}
log(`OK — observed ${REQUIRED_EVENTS.join(" + ")}`);
process.exit(0);

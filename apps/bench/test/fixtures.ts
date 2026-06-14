// Recorded SSE streams mirroring the runtime's POST /sessions output (see apps/runtime mapMessage).
// Kept as TypeScript string fixtures (not loose files) so they are typed and biome-clean. They are
// the harness analog of the runtime tests' `sampleMessages`.

// A successful turn: init -> (keepalive comment) -> assistant -> result(success), with usage + trace.
export const SUCCESS_SSE = `event: init
data: {"sessionId":"sess-1","model":"MiniMax-M3","cwd":"/workspace","tools":["Bash","Read"],"traceId":"trace-abc"}
id: u-init

: keepalive

event: assistant
data: {"text":"fixing it","toolUses":[]}
id: u-asst

event: result
data: {"sessionId":"sess-1","usage":{"input_tokens":10,"output_tokens":20},"total_cost_usd":0.01,"modelUsage":{},"num_turns":1,"is_error":false,"traceId":"trace-abc"}
id: u-result

`;

// A turn that ended in an error event.
export const ERROR_SSE = `event: init
data: {"sessionId":"sess-err","traceId":"trace-err"}
id: u-init

event: error
data: {"message":"internal error","correlationId":"corr-1"}

`;

// A turn that was aborted (e.g. turn timeout / max turns).
export const ABORTED_SSE = `event: init
data: {"sessionId":"sess-abr"}
id: u-init

event: aborted
data: {"sessionId":"sess-abr"}

`;

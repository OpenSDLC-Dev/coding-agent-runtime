import type { Extension } from "./types.js";

/**
 * Compiled-in code extensions. This is the programmatic authoring tier: an operator
 * who needs custom in-process tools or hook callbacks adds an `Extension` module here.
 * Kept empty by default — declarative-only setups use the JSON manifest instead.
 */
export const BUILTIN_EXTENSIONS: Extension[] = [];

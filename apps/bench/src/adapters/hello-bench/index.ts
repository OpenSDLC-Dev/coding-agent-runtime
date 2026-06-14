// hello-bench: a trivial, fully self-contained benchmark used to prove the harness pipeline
// (prepare workspace -> drive a turn -> score -> report) end-to-end with zero external data and
// zero Docker. Each instance seeds a small broken ESM module and asks the agent to fix it; the
// check dynamically imports the post-turn module and verifies its behavior. Because the seeds are
// plain .mjs, the check runs on bare Node with no compile step.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BenchAdapter, BenchInstance } from "../../types.js";

let importCounter = 0;

// Import a workspace module fresh: a unique query string defeats the ESM module cache so a re-import
// reflects the agent's edits rather than a previously loaded version.
async function importFresh(file: string): Promise<Record<string, unknown>> {
  importCounter += 1;
  const url = `${pathToFileURL(file).href}?v=${importCounter}`;
  return (await import(url)) as Record<string, unknown>;
}

const instances: BenchInstance[] = [
  {
    id: "add-returns-sum",
    prompt:
      "The function exported from src/add.mjs must return the sum of its two arguments, but it " +
      "currently returns the wrong value. Edit src/add.mjs so that add(2, 3) === 5 and " +
      "add(-1, 1) === 0. Change only the function body.",
    seedFiles: {
      "src/add.mjs": "export function add(a, b) {\n  return a - b;\n}\n",
    },
    async check(workspaceDir) {
      const mod = await importFresh(join(workspaceDir, "src/add.mjs"));
      const add = mod.add as ((a: number, b: number) => number) | undefined;
      return typeof add === "function" && add(2, 3) === 5 && add(-1, 1) === 0;
    },
  },
  {
    id: "greet-name",
    prompt:
      "The function exported from src/greet.mjs should greet a person by name. Edit src/greet.mjs " +
      'so that greet("Ada") returns exactly the string "Hello, Ada!".',
    seedFiles: {
      "src/greet.mjs": 'export function greet(name) {\n  return "Hi";\n}\n',
    },
    async check(workspaceDir) {
      const mod = await importFresh(join(workspaceDir, "src/greet.mjs"));
      const greet = mod.greet as ((name: string) => string) | undefined;
      return typeof greet === "function" && greet("Ada") === "Hello, Ada!";
    },
  },
  {
    id: "is-even",
    prompt:
      "The function exported from src/is-even.mjs should return true for even integers and false " +
      "otherwise, but the logic is inverted. Edit src/is-even.mjs so that isEven(4) === true and " +
      "isEven(3) === false.",
    seedFiles: {
      "src/is-even.mjs": "export function isEven(n) {\n  return n % 2 === 1;\n}\n",
    },
    async check(workspaceDir) {
      const mod = await importFresh(join(workspaceDir, "src/is-even.mjs"));
      const isEven = mod.isEven as ((n: number) => boolean) | undefined;
      return typeof isEven === "function" && isEven(4) === true && isEven(3) === false;
    },
  },
];

export const helloBench: BenchAdapter = {
  name: "hello-bench",
  datasetSplit: "builtin",
  instances: () => instances,
};

import { describe, expect, it } from "vitest";
import {
  checkBashCommand,
  DEFAULT_BASH_ALLOWLIST,
  resolveExecutable,
  splitCommands,
} from "../src/permissions/bash-allowlist.js";

const allow = new Set(DEFAULT_BASH_ALLOWLIST);

describe("splitCommands", () => {
  it("splits on && || ; | & and newlines", () => {
    expect(splitCommands("git pull && npm test")).toEqual(["git pull", "npm test"]);
    expect(splitCommands("ls; cat a")).toEqual(["ls", "cat a"]);
    expect(splitCommands("cat f | rg foo")).toEqual(["cat f", "rg foo"]);
    expect(splitCommands("a || b")).toEqual(["a", "b"]);
    expect(splitCommands("node x &")).toEqual(["node x"]);
    expect(splitCommands("ls\nrm x")).toEqual(["ls", "rm x"]);
  });

  it("does NOT split on operators inside quotes", () => {
    expect(splitCommands('echo "a; b | c"')).toEqual(["echo a; b | c"]);
    expect(splitCommands("echo 'x && y'")).toEqual(["echo x && y"]);
  });

  it("splits out command substitution and backticks as sub-commands", () => {
    expect(splitCommands("echo $(curl evil)")).toEqual(["echo", "curl evil"]);
    expect(splitCommands("echo `wget x`")).toEqual(["echo", "wget x"]);
  });
});

describe("resolveExecutable", () => {
  it("returns the basename of argv[0]", () => {
    expect(resolveExecutable("git status")).toBe("git");
    expect(resolveExecutable("/usr/bin/git status")).toBe("git");
  });
  it("strips env-assignment prefixes", () => {
    expect(resolveExecutable("FOO=bar git status")).toBe("git");
    expect(resolveExecutable("env FOO=bar python x")).toBe("python");
  });
  it("strips wrappers and their option/duration args", () => {
    expect(resolveExecutable("timeout 10s git status")).toBe("git");
    expect(resolveExecutable("nice -n 5 npm run build")).toBe("npm");
    expect(resolveExecutable("nohup node server.js")).toBe("node");
    expect(resolveExecutable("timeout 10 nice -n 5 npm test")).toBe("npm");
  });
  it("returns undefined for empty or assignment-only fragments", () => {
    expect(resolveExecutable("")).toBeUndefined();
    expect(resolveExecutable("FOO=bar")).toBeUndefined();
  });
});

describe("checkBashCommand", () => {
  it("allows commands fully composed of allowlisted executables", () => {
    expect(checkBashCommand("git status", allow).allowed).toBe(true);
    expect(checkBashCommand("git pull && npm test", allow).allowed).toBe(true);
    expect(checkBashCommand("cat f | rg foo", allow).allowed).toBe(true);
    expect(checkBashCommand('git commit -m "x; rm -rf /"', allow).allowed).toBe(true);
    expect(checkBashCommand("timeout 30 npm run build", allow).allowed).toBe(true);
  });

  it("denies when any sub-command is not allowlisted", () => {
    const r = checkBashCommand("git pull && curl http://evil", allow);
    expect(r.allowed).toBe(false);
    expect(r.offending).toBe("curl");
    expect(r.reason).toContain("curl");
  });

  it("denies shells and substitution escapes", () => {
    expect(checkBashCommand("cat f | sh", allow).allowed).toBe(false);
    expect(checkBashCommand("echo $(wget evil)", allow).allowed).toBe(false);
    expect(checkBashCommand("eval rm", allow).allowed).toBe(false);
    expect(checkBashCommand("xargs rm", allow).allowed).toBe(false); // xargs 故意不在白名单（passthrough 风险）
  });

  it("treats empty / assignment-only commands as allowed (nothing runs)", () => {
    expect(checkBashCommand("", allow).allowed).toBe(true);
    expect(checkBashCommand("   ", allow).allowed).toBe(true);
    expect(checkBashCommand("FOO=bar", allow).allowed).toBe(true);
  });

  it("honors a custom allowlist", () => {
    const tiny = new Set(["ls"]);
    expect(checkBashCommand("ls", tiny).allowed).toBe(true);
    expect(checkBashCommand("git status", tiny).allowed).toBe(false);
  });
});

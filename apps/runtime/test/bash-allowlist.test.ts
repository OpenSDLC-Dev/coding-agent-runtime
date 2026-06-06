import { describe, expect, it } from "vitest";
import {
  checkBashCommand,
  createBashAllowlistHook,
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

  it("does NOT split on redirection operators (2>&1, >&2, &>, > file)", () => {
    // The `&` in `2>&1` is a dup redirection, not a background/control operator, so it must not be split.
    expect(splitCommands("npm test 2>&1 | cat")).toEqual(["npm test 2>&1", "cat"]);
    expect(splitCommands("node x >&2")).toEqual(["node x >&2"]);
    expect(splitCommands("node x &>out.log")).toEqual(["node x &>out.log"]);
    expect(splitCommands("node x >out 2>&1")).toEqual(["node x >out 2>&1"]);
    expect(splitCommands("node x > out.log 2>&1")).toEqual(["node x > out.log 2>&1"]);
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

  it("allows commands with shell redirections (2>&1, >&2, &>, > file)", () => {
    expect(checkBashCommand("npm test 2>&1 | cat", allow).allowed).toBe(true);
    expect(checkBashCommand("npm test 2>&1 | tee log", allow).allowed).toBe(true);
    expect(checkBashCommand("node x > out.log 2>&1", allow).allowed).toBe(true);
    expect(checkBashCommand("node x >&2", allow).allowed).toBe(true);
    expect(checkBashCommand("node x &>out.log", allow).allowed).toBe(true);
    // Redirection must not weaken the allowlist: a non-allowlisted command after a pipe is still denied.
    const r = checkBashCommand("npm test 2>&1 | sh", allow);
    expect(r.allowed).toBe(false);
    expect(r.offending).toBe("sh");
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
    expect(checkBashCommand("xargs rm", allow).allowed).toBe(false); // xargs is intentionally not allowlisted (passthrough risk)
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

describe("createBashAllowlistHook", () => {
  const hook = createBashAllowlistHook(["git", "ls"]);
  const base = {
    session_id: "s",
    transcript_path: "/t",
    cwd: "/workspace",
    tool_use_id: "tu-1",
  };
  const opts = { signal: new AbortController().signal };

  it("denies a non-allowlisted Bash command with a reason", async () => {
    const out = await hook(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "curl http://x" },
      } as never,
      "tu-1",
      opts,
    );
    expect(
      (
        out as {
          hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
        }
      ).hookSpecificOutput?.permissionDecision,
    ).toBe("deny");
    expect(
      (out as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput
        ?.permissionDecisionReason,
    ).toContain("curl");
  });

  it("allows an allowlisted Bash command (empty output)", async () => {
    const out = await hook(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      } as never,
      "tu-1",
      opts,
    );
    expect(out).toEqual({});
  });

  it("ignores non-Bash tools and non-PreToolUse events", async () => {
    expect(
      await hook(
        {
          ...base,
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: "/x" },
        } as never,
        "tu-1",
        opts,
      ),
    ).toEqual({});
    expect(
      await hook(
        {
          ...base,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "curl x" },
        } as never,
        "tu-1",
        opts,
      ),
    ).toEqual({});
  });

  it("ignores a Bash call with a non-string command", async () => {
    const out = await hook(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {},
      } as never,
      "tu-1",
      opts,
    );
    expect(out).toEqual({});
  });
});

// Workspace preparation for the outer loop: the runtime agent works in a single directory
// (RUNTIME_CWD), so the harness materializes each instance's seed files into a clean workspace
// before the turn and empties it between instances. Resetting clears the directory's contents but
// keeps the directory itself, so a bind-mounted workspace inode survives across instances.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";

// Guard against catastrophic deletes: the reset path removes everything under the workspace, so
// refuse anything that is not an absolute, non-root path.
function assertSafeWorkspace(dir: string): void {
  if (!dir || !isAbsolute(dir)) {
    throw new Error(`workspace must be an absolute path, got: ${JSON.stringify(dir)}`);
  }
  if (parse(dir).root === dir) {
    throw new Error(`refusing to use a filesystem root as the workspace: ${dir}`);
  }
}

export async function resetWorkspace(dir: string): Promise<void> {
  assertSafeWorkspace(dir);
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  // Last-line safety net: never wipe what looks like a git repository root. A misconfigured
  // --workspace / RUNTIME_CWD pointing at a checkout would otherwise lose uncommitted work.
  if (entries.includes(".git")) {
    throw new Error(`refusing to wipe a directory that looks like a git repository root: ${dir}`);
  }
  await Promise.all(entries.map((e) => rm(join(dir, e), { recursive: true, force: true })));
}

// Remove a `.git` directory a prepare() hook (e.g. a SWE-bench clone) left in the workspace, so the
// next instance's resetWorkspace sees a plain file tree instead of tripping its repo-root guard. Uses
// fs.rm (force = no error if absent), never a shelled `rm -rf`. Safe to call unconditionally: it only
// runs after a successful resetWorkspace proved the dir held no .git at the start of the instance, so
// the only .git it can delete is one this run's prepare() just created — never a real checkout.
export async function removeGitDir(dir: string): Promise<void> {
  assertSafeWorkspace(dir);
  await rm(join(dir, ".git"), { recursive: true, force: true });
}

export async function seedFiles(dir: string, files: Record<string, string>): Promise<void> {
  assertSafeWorkspace(dir);
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

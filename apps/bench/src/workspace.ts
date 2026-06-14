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
  await Promise.all(entries.map((e) => rm(join(dir, e), { recursive: true, force: true })));
}

export async function seedFiles(dir: string, files: Record<string, string>): Promise<void> {
  assertSafeWorkspace(dir);
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

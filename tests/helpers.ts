import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const thisFilePath = fileURLToPath(import.meta.url);
export const repoRoot = path.resolve(path.dirname(thisFilePath), "..");

export async function createTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "novel-creator-gpt-"));
}

export async function cleanupTempRoot(rootDir: string): Promise<void> {
  await rm(rootDir, { recursive: true, force: true });
}

export async function writeRootBlueprint(rootDir: string, blueprint: string): Promise<void> {
  await writeFile(path.join(rootDir, "STORY_BLUEPRINT.md"), blueprint, "utf8");
}

export async function readJson<T>(targetPath: string): Promise<T> {
  return JSON.parse(await readFile(targetPath, "utf8")) as T;
}

export function runChapterCli(args: string[], rootDir: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    "npm",
    ["run", "chapter", "--", ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NOVEL_CREATOR_ROOT: rootDir,
      },
      encoding: "utf8",
    },
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

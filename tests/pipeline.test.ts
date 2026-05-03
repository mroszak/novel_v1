import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoot, createTempRoot, readJson, runChapterCli } from "./helpers.js";

test("smoke pipeline completes successfully in an isolated root", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const result = runChapterCli(["--smoke"], rootDir);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /Status: SUCCESS/);
  assert.match(result.stdout, /Published chapter:/);
  assert.match(result.stdout, /Cost summary:/);

  const statusArtifact = await readJson<any>(path.join(rootDir, "artifacts", "chapters", "chapter-1-status.json"));
  assert.equal(statusArtifact.data.status, "SUCCESS");
});

test("smoke judge-only rerun reuses earlier artifacts in an isolated root", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const firstRun = runChapterCli(["--smoke"], rootDir);
  assert.equal(firstRun.status, 0, `stdout:\n${firstRun.stdout}\n\nstderr:\n${firstRun.stderr}`);

  const rerun = runChapterCli(["--smoke", "--judge-only"], rootDir);
  assert.equal(rerun.status, 0, `stdout:\n${rerun.stdout}\n\nstderr:\n${rerun.stderr}`);
  assert.match(rerun.stdout, /Status: SUCCESS/);
  assert.match(rerun.stdout, /Reused artifacts:/);
  assert.match(rerun.stdout, /chapter-draft/);
});

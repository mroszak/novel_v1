import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileChapterFunctions } from "../src/blueprint/compile-chapter-functions.js";
import { compileGenreContract } from "../src/blueprint/compile-genre-contract.js";
import { compileStoryCore } from "../src/blueprint/compile-story-core.js";
import { parseBlueprint } from "../src/blueprint/parse-blueprint.js";
import { validateBlueprint } from "../src/blueprint/validate-blueprint.js";
import {
  FIXTURE_BLUEPRINT,
  INVALID_BLUEPRINT,
  VALID_BLUEPRINT,
} from "./fixtures/blueprint-fixture.js";

async function writeBlueprint(markdown: string, filename = "STORY_BLUEPRINT.md"): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "novel-blueprint-test-"));
  const filePath = path.join(tempDir, filename);
  await writeFile(filePath, markdown, "utf8");
  return filePath;
}

test("fixture blueprint parses and validates", async (t) => {
  const blueprintPath = await writeBlueprint(FIXTURE_BLUEPRINT);
  t.after(async () => {
    await rm(path.dirname(blueprintPath), { recursive: true, force: true });
  });

  const parsed = await parseBlueprint(blueprintPath);
  validateBlueprint(parsed);

  assert.equal(parsed.metadata.title, "Fixture Novel");
  assert.equal(parsed.metadata.totalChapters, 2);
  assert.equal(parsed.chapterOutline.length, 2);
  assert.equal(parsed.chapterOutline[0]?.function, "opening");
});

test("fixture blueprint compiles deterministic runtime artifacts", async (t) => {
  const blueprintPath = await writeBlueprint(FIXTURE_BLUEPRINT);
  t.after(async () => {
    await rm(path.dirname(blueprintPath), { recursive: true, force: true });
  });

  const parsed = await parseBlueprint(blueprintPath);
  validateBlueprint(parsed);

  const storyCore = compileStoryCore(parsed);
  const genreContract = await compileGenreContract(parsed, { noGenreAi: true });
  const chapterFunctions = compileChapterFunctions(parsed);

  assert.equal(storyCore.characters.length, 2);
  assert.equal(genreContract.aiRefinementUsed, false);
  assert.equal(genreContract.controls.pacingCurve, "fast rise with tight reversals");
  assert.equal(chapterFunctions.chapterProfiles[0]?.profile.function, "opening");
  assert.equal(chapterFunctions.chapterProfiles[1]?.profile.function, "escalation");
  assert.equal(path.basename(blueprintPath), "STORY_BLUEPRINT.md");
});

test("parse and validate blueprint fixture", async (t) => {
  const blueprintPath = await writeBlueprint(VALID_BLUEPRINT, "fixture-blueprint.md");
  t.after(async () => {
    await rm(path.dirname(blueprintPath), { recursive: true, force: true });
  });

  const parsed = await parseBlueprint(blueprintPath);
  validateBlueprint(parsed);

  assert.equal(parsed.metadata.title, "Fixture Title");
  assert.equal(parsed.chapterOutline.length, 1);
  assert.equal(parsed.genre.primaryGenre, "psychological thriller");
});

test("validation rejects placeholder blueprint content", async (t) => {
  const blueprintPath = await writeBlueprint(INVALID_BLUEPRINT, "fixture-blueprint.md");
  t.after(async () => {
    await rm(path.dirname(blueprintPath), { recursive: true, force: true });
  });

  const parsed = await parseBlueprint(blueprintPath);
  assert.throws(() => validateBlueprint(parsed), /placeholder text/i);
});

test("validation rejects unknown active cast references", async (t) => {
  const invalidCastBlueprint = VALID_BLUEPRINT.replace("  - Elias Ward", "  - Unknown Witness");
  const blueprintPath = await writeBlueprint(invalidCastBlueprint, "fixture-blueprint.md");
  t.after(async () => {
    await rm(path.dirname(blueprintPath), { recursive: true, force: true });
  });

  const parsed = await parseBlueprint(blueprintPath);
  assert.throws(() => validateBlueprint(parsed), /Active Cast references unknown character/i);
});

test("Secondary Cameo Beats parse from blueprint and flow through compileStoryCore; absent sections default to []", async (t) => {
  const blueprintPath = await writeBlueprint(FIXTURE_BLUEPRINT);
  t.after(async () => {
    await rm(path.dirname(blueprintPath), { recursive: true, force: true });
  });

  const parsed = await parseBlueprint(blueprintPath);
  validateBlueprint(parsed);

  const chapter1 = parsed.chapterOutline[0];
  const chapter2 = parsed.chapterOutline[1];
  assert.ok(chapter1, "Chapter 1 should be present in fixture.");
  assert.ok(chapter2, "Chapter 2 should be present in fixture.");

  assert.deepEqual(chapter1.secondaryCameoBeats, [
    "One human detail for a background courier in passing through Mira's POV.",
    "Rowan briefly registers an analyst he respects without naming her.",
  ]);
  assert.deepEqual(
    chapter2.secondaryCameoBeats,
    [],
    "Absent Secondary Cameo Beats section must default to an empty array, not undefined.",
  );

  const storyCore = compileStoryCore(parsed);
  assert.deepEqual(
    storyCore.chapterOutline[0]?.secondaryCameoBeats,
    chapter1.secondaryCameoBeats,
    "compileStoryCore must forward secondaryCameoBeats unchanged so downstream packet builders see them.",
  );
  assert.deepEqual(storyCore.chapterOutline[1]?.secondaryCameoBeats, []);
});

test("genre compilation applies deterministic presets and overrides", async (t) => {
  const blueprintPath = await writeBlueprint(VALID_BLUEPRINT, "fixture-blueprint.md");
  t.after(async () => {
    await rm(path.dirname(blueprintPath), { recursive: true, force: true });
  });

  const parsed = await parseBlueprint(blueprintPath);
  const contract = await compileGenreContract(parsed, { noGenreAi: true });

  assert.equal(contract.primaryGenre, "psychological thriller");
  assert.equal(contract.controls.hookStyle, "question-driven dread");
  assert.ok(contract.controls.revealCadence.length > 0);
  assert.equal(contract.aiRefinementUsed, false);
});

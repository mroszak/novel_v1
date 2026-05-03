import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { promises as fs } from "node:fs";

import {
  applyPolishPatches,
  collectPolishZones,
  DEFAULT_POLISH_CONFIDENCE_THRESHOLD,
} from "../src/pipeline/polish-pass.js";
import {
  locateEndingSlice,
  locateOpeningSlice,
  locateTitleSlice,
} from "../src/pipeline/opening-ending-tournament.js";
import {
  buildVoiceFingerprint,
  buildGuidanceLines,
} from "../src/blueprint/extract-voice-fingerprint.js";
import { buildDraftSystemPrompt } from "../src/pipeline/generate-draft.js";
import { judgeDraft } from "../src/pipeline/judge-draft.js";
import { config } from "../src/config.js";
import { createArtifact } from "../src/pipeline/stage-utils.js";
import type {
  BlueprintCompilationArtifacts,
  ChapterDraft,
  ChapterFunctionMap,
  ChapterPacket,
  ChapterSpec,
  CompiledStoryBlueprint,
  GenreContract,
  PolishPatch,
  ReaderSimulation,
  VoiceTarget,
} from "../src/types/index.js";
import { cleanupTempRoot, createTempRoot, readJson, runChapterCli } from "./helpers.js";

// Long enough that paragraphs past the ~200-word opening become mid-chapter
// candidates and not protected by the opening zone.
const OPENING_FILLER_LINES = [
  "She entered the room without knocking. The door swung back on its hinges and she did not turn to watch it close. The walls were the same shade of unremarkable cream. The carpet had a small dark stain near the threshold that nobody had ever explained. The smell was of coffee gone cold and printer toner that nobody used because the printer had been broken for months.",
  "She counted three steps to the window without looking at her feet. The blinds were down but not closed. A horizontal stripe of streetlight cut the floor in pale rungs. She did not adjust them. The chair had been moved an inch to the left of where she had left it. She catalogued this without comment and pressed her palm flat against the desk.",
  "The pane was cool. The traffic outside was the same low hum as every night, broken at predictable intervals by a bus that always arrived a minute later than it should. She stood there long enough to count two of those buses without moving. The hallway behind her produced its usual sequence of small sounds: a door fitting, a kettle starting, a pair of footsteps that walked past her door without pausing, the way they always did.",
  "She unfolded the note in her pocket without reading it. She had read it nine times since lunch. The handwriting was no different the tenth time. The paper was no warmer for being against her thigh all day, although she had let herself imagine it would be.",
];
const OPENING_FILLER = OPENING_FILLER_LINES.join("\n\n");

const SAMPLE_PROSE = [
  "Chapter Heading",
  "",
  OPENING_FILLER,
  "",
  "Three small steps later she was at the window. The view was the same as always: streetlight, parked truck, the long crack in the curb. She pressed her palm against the glass and felt nothing change.",
  "",
  "He was already there, his back to her, watching the street. \"You took your time,\" he said, not turning. The room held its breath while he kept his back turned.",
  "",
  "---",
  "",
  "An hour later they were in the car. Rain had started without committing to the act, a hesitant drizzle that smudged the windshield and refused to clean it. The wipers worked on intermittent, leaving streaks across her vision.",
  "",
  "\"Where to?\" he asked.",
  "",
  "She didn't answer immediately. The map app was open on her phone but she hadn't picked a destination. The cursor blinked in the search field while she stared at it, waiting for something to occur.",
  "",
  "Outside, the rain finally committed and began washing the windshield clean.",
].join("\n");

test("collectPolishZones excludes opening, ending, scene-break markers, and protected first paragraphs", () => {
  const zones = collectPolishZones(SAMPLE_PROSE);
  assert.ok(zones.length > 0, "Should find at least one mid-chapter zone");
  for (const zone of zones) {
    assert.notEqual(zone.paragraphIndex, 0, "Title paragraph must be protected");
    const paragraphs = SAMPLE_PROSE.split(/\n\n+/);
    assert.notEqual(zone.paragraphIndex, paragraphs.length - 1, "Final paragraph must be protected");
  }
  // At least one scene-break-leadout zone should be detected
  assert.ok(
    zones.some((z) => z.zone === "scene-break-leadout"),
    "Should detect scene-break lead-out",
  );
});

test("applyPolishPatches respects confidence threshold and zone constraints", () => {
  const paragraphs = SAMPLE_PROSE.split(/\n\n+/);
  // Find a mid-chapter paragraph index that's neither title nor ending and has the tail we want.
  const targetIdx = paragraphs.findIndex((p) =>
    p.endsWith("She pressed her palm against the glass and felt nothing change."),
  );
  assert.ok(targetIdx > 0 && targetIdx < paragraphs.length - 1);

  // originalText must match the paragraph tail exactly, including trailing punctuation.
  const lowConfidencePatch: PolishPatch = {
    zone: "paragraph-end",
    paragraphIndex: targetIdx,
    originalText: "She pressed her palm against the glass and felt nothing change.",
    proposedText: "Her palm met the glass and the glass refused her.",
    rationale: "Sharper image at paragraph end.",
    confidence: 0.5,
  };
  const highConfidencePatch: PolishPatch = {
    ...lowConfidencePatch,
    confidence: 0.85,
  };

  const lowResult = applyPolishPatches({ prose: SAMPLE_PROSE, patches: [lowConfidencePatch] });
  assert.equal(lowResult.applied.length, 0);
  assert.equal(lowResult.skipped.length, 1);
  assert.match(lowResult.skipped[0]!.skipReason, /confidence/i);
  assert.equal(lowResult.prose, SAMPLE_PROSE);

  const highResult = applyPolishPatches({ prose: SAMPLE_PROSE, patches: [highConfidencePatch] });
  assert.equal(highResult.applied.length, 1);
  assert.ok(highResult.prose.includes("Her palm met the glass and the glass refused her."));
  assert.ok(!highResult.prose.includes("She pressed her palm against the glass and felt nothing change."));
});

test("applyPolishPatches rejects paragraph-end patches that don't end the paragraph", () => {
  const paragraphs = SAMPLE_PROSE.split(/\n\n+/);
  const targetIdx = paragraphs.findIndex((p) =>
    p.endsWith("She pressed her palm against the glass and felt nothing change."),
  );
  assert.ok(targetIdx > 0);

  // originalText is in the middle of the paragraph, not the tail.
  const middlePatch: PolishPatch = {
    zone: "paragraph-end",
    paragraphIndex: targetIdx,
    originalText: "the same as always",
    proposedText: "stubbornly familiar",
    rationale: "Sharper image (but not at paragraph end).",
    confidence: 0.95,
  };
  const result = applyPolishPatches({ prose: SAMPLE_PROSE, patches: [middlePatch] });
  assert.equal(result.applied.length, 0, "Mid-paragraph polish must be rejected");
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.skipReason, /ending sentence|does not match/i);
  assert.equal(result.prose, SAMPLE_PROSE);
});

test("applyPolishPatches rejects patches that target the chapter opening or ending", () => {
  const openingPatch: PolishPatch = {
    zone: "paragraph-end",
    paragraphIndex: 0,
    originalText: "Chapter Heading",
    proposedText: "New Title",
    rationale: "Try to rewrite the title.",
    confidence: 0.95,
  };
  const paragraphs = SAMPLE_PROSE.split(/\n\n+/);
  const lastIdx = paragraphs.length - 1;
  const endingPatch: PolishPatch = {
    zone: "paragraph-end",
    paragraphIndex: lastIdx,
    originalText: paragraphs[lastIdx]!.split(" ").slice(0, 4).join(" "),
    proposedText: "Different opening words",
    rationale: "Try to rewrite the ending.",
    confidence: 0.95,
  };

  const result = applyPolishPatches({ prose: SAMPLE_PROSE, patches: [openingPatch, endingPatch] });
  assert.equal(result.applied.length, 0, "Both protected zones must be skipped");
  assert.equal(result.skipped.length, 2);
  for (const skipped of result.skipped) {
    assert.match(skipped.skipReason, /protected|originalText/i);
  }
});

test("applyPolishPatches uses default 0.7 confidence threshold", () => {
  assert.equal(DEFAULT_POLISH_CONFIDENCE_THRESHOLD, 0.7);
});

test("locateOpeningSlice returns first ~200 words skipping the title line", () => {
  const slice = locateOpeningSlice(SAMPLE_PROSE);
  assert.ok(slice, "Opening slice must exist");
  assert.ok(!slice!.text.startsWith("Chapter Heading"), "Title should be skipped");
  assert.ok(slice!.paragraphs.length > 0);
});

test("locateEndingSlice returns the final non-empty paragraph", () => {
  const slice = locateEndingSlice(SAMPLE_PROSE);
  assert.ok(slice);
  assert.ok(slice!.text.includes("rain finally committed"));
});

test("locateTitleSlice returns short title-like first line", () => {
  const slice = locateTitleSlice(SAMPLE_PROSE);
  assert.ok(slice);
  assert.equal(slice!.paragraphIndex, 0);
  assert.equal(slice!.text, "Chapter Heading");
});

test("locateTitleSlice returns null when first paragraph is full prose", () => {
  const proseWithoutTitle = "She entered the room. The door swung. Light bled from a lamp. She paused for a beat, listening to the building.\n\nA second paragraph here.";
  assert.equal(locateTitleSlice(proseWithoutTitle), null);
});

function makeBlueprint(): CompiledStoryBlueprint {
  return {
    metadata: {
      title: "Test",
      author: "Author",
      blueprintVersion: "1.0.0",
      totalChapters: 1,
      defaultChapterWordCount: 2000,
      defaultQualityProfile: "max",
    },
    storyPromise: {
      corePremise: "A woman discovers she is becoming her own ghost.",
      storyPromise: "Each chapter blurs the line between memory and place.",
      readerPromise: "Quiet dread, sharp images, characters speaking around the truth.",
      endingPromise: "The cost of remembering will be paid in flesh and time.",
    },
    marketPositioning: {
      marketCategory: "literary suspense",
      audience: "readers who want quiet, image-heavy literary suspense",
      shelfPositioning: "haunting, ghost-adjacent, literary",
      comparables: ["The Haunting of Hill House", "Piranesi"],
    },
    genre: {
      primaryGenre: "literary suspense",
      subgenres: ["psychological"],
      toneKeywords: ["haunting", "intimate"],
      readerExperience: "Quiet dread.",
      runtimeOverrides: {},
    },
    canonLaw: [],
    antiPatterns: [],
    styleRules: ["Lean on close third.", "Let setting carry mood."],
    motifBank: ["seam lines in glass", "afterimage of streetlight"],
    characters: [],
    chapterOutline: [],
    sectionDigests: {},
  };
}

test("buildVoiceFingerprint extracts non-empty stats from prose", () => {
  const fingerprint = buildVoiceFingerprint({
    text: SAMPLE_PROSE,
    blueprint: makeBlueprint(),
  });
  assert.ok(fingerprint.sentenceLength.mean > 0);
  assert.ok(fingerprint.sentenceLength.median >= 1);
  assert.ok(fingerprint.paragraphRhythm.meanWords > 0);
  assert.ok(fingerprint.dialogueTagConventions.tagsPer1000Words >= 0);
  assert.ok(fingerprint.povInteriorityDensity.interiorMarkersPer1000Words >= 0);
});

test("buildGuidanceLines produces actionable lines from a fingerprint", () => {
  const fingerprint = buildVoiceFingerprint({
    text: SAMPLE_PROSE,
    blueprint: makeBlueprint(),
  });
  const guidance = buildGuidanceLines(fingerprint);
  assert.ok(guidance.length > 0);
  assert.ok(guidance.some((l) => /sentence-length/i.test(l)));
});

test("buildDraftSystemPrompt embeds voice target guidance and previous reader flags", () => {
  const voiceTarget: VoiceTarget = {
    source: "derived",
    derivedFromChapters: [1, 2],
    fingerprint: buildVoiceFingerprint({ text: SAMPLE_PROSE, blueprint: makeBlueprint() }),
    guidanceLines: ["Sentence-length target: mean ~14 words.", "Lean on signature words: smoke, glass."],
  };
  const previousReaderSimulation: ReaderSimulation = {
    personas: [
      { persona: "airport", skimRisk: 60, confusionRisk: 30, turnPull: 60, shareScore: 50, notes: "Skimmed midchapter." },
      { persona: "book-club", skimRisk: 30, confusionRisk: 20, turnPull: 70, shareScore: 65, notes: "Strong subtext." },
      { persona: "genre-obsessive", skimRisk: 40, confusionRisk: 30, turnPull: 65, shareScore: 60, notes: "Wanted more tradecraft." },
    ],
    flaggedPassages: [
      { excerpt: "Atmospheric stretch", reason: "Pacing dipped during the bridge section.", persona: "airport" },
    ],
    averageTurnPull: 65,
    averageShareScore: 58,
    summary: "Turn-pull is solid but can be tightened.",
  };

  const genreContract: GenreContract = {
    primaryGenre: "literary suspense",
    contributingGenres: [],
    toneKeywords: ["haunting"],
    readerExperience: "Quiet dread.",
    controls: {
      pacingCurve: "slow-burn",
      sceneDensity: "medium",
      dialogueRatioTarget: "balanced",
      interiorityRatioTarget: "close",
      revealCadence: "controlled",
      hookStyle: "image",
      endingMode: "haunting",
      povDistance: "close",
      ambiguityTolerance: "high",
      sensoryDensity: "image-heavy",
      proseCompression: "lyrical",
      emotionalDwellExpectation: "earned",
      violenceExplicitness: "implied",
      romanceProminence: "low",
      validatorThresholdOverrides: [],
    },
    aiRefinementUsed: false,
    aiRefinementNotes: [],
  };

  const prompt = buildDraftSystemPrompt({
    genreContract,
    storyPromise: makeBlueprint().storyPromise,
    marketPositioning: makeBlueprint().marketPositioning,
    chapterFunction: { function: "opening", riskLevel: "high", pacingDirective: "Open with pressure.", judgeWeights: {} },
    styleRules: ["Lean on close third."],
    antiPatterns: ["No info dumps."],
    comparables: ["Piranesi"],
    voiceTarget,
    previousReaderSimulation,
  });

  assert.match(prompt, /VOICE SIGNATURE TARGET/);
  assert.match(prompt, /Sentence-length target/);
  assert.match(prompt, /PREVIOUS-CHAPTER READER FLAGS/);
  assert.match(prompt, /airport/);
});

test("buildDraftSystemPrompt omits voice and reader-flag sections when absent", () => {
  const prompt = buildDraftSystemPrompt({
    genreContract: {
      primaryGenre: "literary suspense",
      contributingGenres: [],
      toneKeywords: [],
      readerExperience: "x",
      controls: {
        pacingCurve: "slow",
        sceneDensity: "medium",
        dialogueRatioTarget: "balanced",
        interiorityRatioTarget: "close",
        revealCadence: "controlled",
        hookStyle: "image",
        endingMode: "haunting",
        povDistance: "close",
        ambiguityTolerance: "high",
        sensoryDensity: "image-heavy",
        proseCompression: "lyrical",
        emotionalDwellExpectation: "earned",
        violenceExplicitness: "implied",
        romanceProminence: "low",
        validatorThresholdOverrides: [],
      },
      aiRefinementUsed: false,
      aiRefinementNotes: [],
    },
    storyPromise: makeBlueprint().storyPromise,
    marketPositioning: makeBlueprint().marketPositioning,
    chapterFunction: { function: "opening", riskLevel: "low", pacingDirective: "Open quietly.", judgeWeights: {} },
    styleRules: [],
    antiPatterns: [],
    comparables: [],
  });
  assert.doesNotMatch(prompt, /VOICE SIGNATURE TARGET/);
  assert.doesNotMatch(prompt, /PREVIOUS-CHAPTER READER FLAGS/);
});

test("smoke pipeline writes Phase 1 artifacts and voice-target.json", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const result = runChapterCli(["--smoke"], rootDir);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`);

  const polishDiff = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-1-polish-diff.json"),
  );
  assert.ok(polishDiff.data, "polish-diff artifact must have data");
  assert.match(polishDiff.data.status, /no-patches|skipped|applied/);

  const polishPlan = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-1-polish-plan.json"),
  );
  assert.ok(Array.isArray(polishPlan.data.patches));

  const readerSim = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-1-reader-sim.json"),
  );
  assert.ok(Array.isArray(readerSim.data.personas));
  assert.equal(readerSim.data.personas.length, 3);
  assert.ok(typeof readerSim.data.averageTurnPull === "number");

  const tournamentMerged = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-1-tournament-merged.json"),
  );
  assert.ok(["applied", "skipped", "validators-failed", "rejudge-regressed"].includes(tournamentMerged.data.status));

  const voiceTarget = await readJson<any>(
    path.join(rootDir, "artifacts", "blueprint", "voice-target.json"),
  );
  assert.equal(voiceTarget.artifactType, "voice-target");
  assert.ok(voiceTarget.data.fingerprint.sentenceLength.mean > 0);
  assert.equal(voiceTarget.data.source, "derived");
  assert.deepEqual(voiceTarget.data.derivedFromChapters, [1]);
});

test("smoke chapter 2 packet picks up previous reader-sim and voice-target", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const run1 = runChapterCli(["--smoke"], rootDir);
  assert.equal(run1.status, 0, run1.stderr || run1.stdout);

  const run2 = runChapterCli(["--smoke", "--chapter", "2"], rootDir);
  assert.equal(run2.status, 0, run2.stderr || run2.stdout);

  const packet = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-2-packet.json"),
  );
  assert.ok(packet.data.voiceTarget, "Chapter 2 packet must carry voice target");
  assert.ok(packet.data.previousReaderSimulation, "Chapter 2 packet must carry previous reader simulation");
  assert.ok(Array.isArray(packet.data.previousReaderSimulation.personas));
});

test("estimate-cost includes Phase 1 stage entries", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const estimate = runChapterCli(["--smoke", "--estimate-cost"], rootDir);
  assert.equal(estimate.status, 0, estimate.stderr || estimate.stdout);

  const costEstimate = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-1-cost-estimate.json"),
  );
  const stageNames: string[] = costEstimate.data.stages.map((s: any) => s.stage);

  assert.ok(stageNames.includes("polish-plan"), "estimate must include polish-plan");
  assert.ok(stageNames.includes("polish-rejudge"), "estimate must include polish-rejudge");
  assert.ok(stageNames.includes("reader-simulation"), "estimate must include reader-simulation");
  assert.ok(stageNames.includes("voice-calibration"), "estimate must include voice-calibration");
  assert.ok(stageNames.includes("tournament-rejudge"), "estimate must include tournament-rejudge");
  for (const zonePrefix of ["opening-candidate", "ending-candidate", "title-candidate"]) {
    for (let i = 1; i <= 3; i += 1) {
      assert.ok(
        stageNames.includes(`${zonePrefix}-${i}`),
        `estimate must include ${zonePrefix}-${i}`,
      );
    }
  }
  for (const zone of ["opening", "ending", "title"]) {
    for (let i = 1; i <= 2; i += 1) {
      assert.ok(
        stageNames.includes(`tournament-selection-${zone}-${i}`),
        `estimate must include tournament-selection-${zone}-${i}`,
      );
    }
  }
});

test("estimate-cost on standard profile omits all Phase 1 stages", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const estimate = runChapterCli(
    ["--smoke", "--estimate-cost", "--quality", "standard"],
    rootDir,
  );
  assert.equal(estimate.status, 0, estimate.stderr || estimate.stdout);

  const costEstimate = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-1-cost-estimate.json"),
  );
  const stageNames: string[] = costEstimate.data.stages.map((s: any) => s.stage);

  for (const phase1Stage of [
    "polish-plan",
    "polish-rejudge",
    "reader-simulation",
    "voice-calibration",
    "tournament-rejudge",
    "opening-candidate-1",
    "ending-candidate-1",
    "title-candidate-1",
    "tournament-selection-opening-1",
  ]) {
    assert.ok(
      !stageNames.includes(phase1Stage),
      `standard profile must NOT include Phase 1 stage ${phase1Stage}`,
    );
  }
});

test("smoke pipeline preserves the original draft-review and revised-review artifacts", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const run = runChapterCli(["--smoke"], rootDir);
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const draftReview = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-1-draft-review.json"),
  );
  const revisedReview = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-1-revised-review.json"),
  );

  assert.equal(
    draftReview.artifactType,
    "draft-review",
    "draft-review artifact must keep its original artifactType (not be overwritten by polish/tournament rejudge)",
  );
  assert.equal(draftReview.data.candidateId, "draft");
  assert.equal(
    revisedReview.artifactType,
    "revised-review",
    "revised-review artifact must keep its original artifactType (not be overwritten by polish/tournament rejudge)",
  );
  assert.equal(revisedReview.data.candidateId, "revision");
});

test("smoke standard profile skips Phase 1 stages and writes no Phase 1 artifacts", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const run = runChapterCli(["--smoke", "--quality", "standard"], rootDir);
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const phase1Artifacts = [
    "chapter-1-polish-plan.json",
    "chapter-1-polish-diff.json",
    "chapter-1-polish-rejudge.json",
    "chapter-1-reader-sim.json",
    "chapter-1-tournament-opening.json",
    "chapter-1-tournament-ending.json",
    "chapter-1-tournament-title.json",
    "chapter-1-tournament-merged.json",
    "chapter-1-tournament-rejudge.json",
  ];
  for (const fileName of phase1Artifacts) {
    const target = path.join(rootDir, "artifacts", "chapters", fileName);
    let exists = false;
    try {
      await fs.stat(target);
      exists = true;
    } catch {
      exists = false;
    }
    assert.equal(exists, false, `standard profile must not write ${fileName}`);
  }

  const voiceTargetPath = path.join(rootDir, "artifacts", "blueprint", "voice-target.json");
  let voiceExists = false;
  try {
    await fs.stat(voiceTargetPath);
    voiceExists = true;
  } catch {
    voiceExists = false;
  }
  assert.equal(voiceExists, false, "standard profile must not extract voice-target.json");
});

test("packet drops a voice-target.json whose blueprintHash no longer matches", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  // Run the smoke pipeline once to write a real voice-target.json.
  const run = runChapterCli(["--smoke"], rootDir);
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const voiceTargetPath = path.join(rootDir, "artifacts", "blueprint", "voice-target.json");
  const onDisk = await readJson<any>(voiceTargetPath);
  assert.ok(onDisk.blueprintHash, "voice-target must carry a blueprintHash");

  // Mutate the on-disk voice-target.json to carry a stale blueprintHash, then
  // re-run chapter 2 packet-only to verify the packet drops the stale target.
  const mutated = { ...onDisk, blueprintHash: "stale-hash-that-does-not-match" };
  await fs.writeFile(voiceTargetPath, JSON.stringify(mutated, null, 2), "utf8");

  const packetOnly = runChapterCli(
    ["--smoke", "--chapter", "2", "--packet-only"],
    rootDir,
  );
  assert.equal(packetOnly.status, 0, packetOnly.stderr || packetOnly.stdout);

  const packet = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-2-packet.json"),
  );
  assert.equal(
    packet.data.voiceTarget,
    null,
    "Stale-blueprint-hash voice-target must be silently dropped from the packet",
  );
});

test("packet drops a previous reader-sim whose blueprintHash no longer matches", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const run = runChapterCli(["--smoke"], rootDir);
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const readerSimPath = path.join(rootDir, "artifacts", "chapters", "chapter-1-reader-sim.json");
  const onDisk = await readJson<any>(readerSimPath);
  const mutated = { ...onDisk, blueprintHash: "stale-hash-that-does-not-match" };
  await fs.writeFile(readerSimPath, JSON.stringify(mutated, null, 2), "utf8");

  const packetOnly = runChapterCli(
    ["--smoke", "--chapter", "2", "--packet-only"],
    rootDir,
  );
  assert.equal(packetOnly.status, 0, packetOnly.stderr || packetOnly.stdout);

  const packet = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-2-packet.json"),
  );
  assert.equal(
    packet.data.previousReaderSimulation,
    null,
    "Stale-blueprint-hash previous reader-sim must be silently dropped from the packet",
  );
});

test("packet drops a previous reader-sim whose chapterNumber is wrong", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const run = runChapterCli(["--smoke"], rootDir);
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const readerSimPath = path.join(rootDir, "artifacts", "chapters", "chapter-1-reader-sim.json");
  const onDisk = await readJson<any>(readerSimPath);
  // Same blueprint hash/version/profile, but a chapterNumber that doesn't
  // match the previous chapter slot the loader expects.
  const mutated = { ...onDisk, chapterNumber: 99 };
  await fs.writeFile(readerSimPath, JSON.stringify(mutated, null, 2), "utf8");

  const packetOnly = runChapterCli(
    ["--smoke", "--chapter", "2", "--packet-only"],
    rootDir,
  );
  assert.equal(packetOnly.status, 0, packetOnly.stderr || packetOnly.stdout);

  const packet = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-2-packet.json"),
  );
  assert.equal(
    packet.data.previousReaderSimulation,
    null,
    "Reader-sim with mismatched chapterNumber must be silently dropped from the packet",
  );
});

function makeMinimalPhase1ChapterPacket(): ChapterPacket {
  const characters = [
    {
      name: "Alex",
      role: "protagonist",
      desire: "Solve the case.",
      fear: "Being too late.",
      contradiction: "Trusts no one but acts on instinct.",
      publicFace: "Calm operator.",
      privateTruth: "Already burned out.",
      voiceNotes: ["Clipped under pressure.", "Speaks around feelings."],
      knowledgeBoundary: "Does not know the architect identity.",
      rawBody: "",
    },
  ];
  return {
    chapterNumber: 1,
    title: "Phase 1 Test Chapter",
    qualityProfile: "max",
    riskLevel: "medium",
    purpose: "Verify rejudge artifact identity.",
    chapterFunction: {
      function: "opening",
      riskLevel: "medium",
      pacingDirective: "Open with pressure.",
      judgeWeights: {},
    },
    openingHandoff: "Open with pressure.",
    previousChapterExcerpt: null,
    activeCast: characters,
    mandatoryBeats: ["Establish tension."],
    revealBudget: { show: ["the room"], hint: ["the device"], reveal: [], withhold: ["the architect"] },
    callbackObligations: ["The scar"],
    targetWordBand: { min: 1500, target: 2000, max: 2500 },
    endingHookTarget: "Land on a sharp turn.",
    voiceGuidance: ["Lean on close third."],
    pacingGuidance: ["Slow burn."],
    continuityNotes: [],
    chapterNotes: [],
    rollingMemory: null,
    handoffMemory: null,
    compactContext: {
      previousChapterFull: null,
      olderHistory: [],
      revealLedger: [],
      knowledgeWarnings: [],
    },
    voiceTarget: null,
    previousReaderSimulation: null,
  };
}

function makeMinimalPhase1BlueprintArtifacts(): BlueprintCompilationArtifacts {
  const compiledBlueprintData: CompiledStoryBlueprint = {
    metadata: {
      title: "Phase 1 Rejudge Test",
      author: "Test",
      blueprintVersion: "1.0.0",
      totalChapters: 1,
      defaultChapterWordCount: 2000,
      defaultQualityProfile: "max",
    },
    storyPromise: {
      corePremise: "Test premise.",
      storyPromise: "Test story promise.",
      readerPromise: "Test reader promise.",
      endingPromise: "Test ending promise.",
    },
    marketPositioning: {
      marketCategory: "thriller",
      audience: "Readers.",
      shelfPositioning: "Test shelf.",
      comparables: ["Comparable Title"],
    },
    genre: {
      primaryGenre: "thriller",
      subgenres: [],
      toneKeywords: ["tense"],
      readerExperience: "Pressure.",
      runtimeOverrides: {},
    },
    canonLaw: [],
    antiPatterns: [],
    styleRules: ["Lean on close third."],
    motifBank: [],
    characters: [],
    chapterOutline: [],
    sectionDigests: {},
  };
  const genreContractData: GenreContract = {
    primaryGenre: "thriller",
    contributingGenres: [],
    toneKeywords: ["tense"],
    readerExperience: "Pressure.",
    controls: {
      pacingCurve: "rising",
      sceneDensity: "medium",
      dialogueRatioTarget: "balanced",
      interiorityRatioTarget: "close",
      revealCadence: "controlled",
      hookStyle: "image",
      endingMode: "cliff",
      povDistance: "close",
      ambiguityTolerance: "medium",
      sensoryDensity: "medium",
      proseCompression: "tight",
      emotionalDwellExpectation: "earned",
      violenceExplicitness: "implied",
      romanceProminence: "low",
      validatorThresholdOverrides: [],
    },
    aiRefinementUsed: false,
    aiRefinementNotes: [],
  };
  const chapterFunctionsData: ChapterFunctionMap = {
    chapterProfiles: [
      {
        chapterNumber: 1,
        title: "Phase 1 Test Chapter",
        function: "opening",
        profile: {
          function: "opening",
          riskLevel: "medium",
          pacingDirective: "Open with pressure.",
          judgeWeights: {},
        },
      },
    ],
  };
  return {
    compiledBlueprint: createArtifact({
      artifactType: "compiled-blueprint",
      blueprintHash: "test-hash",
      blueprintVersion: "1.0.0",
      data: compiledBlueprintData,
    }),
    genreContract: createArtifact({
      artifactType: "genre-contract",
      blueprintHash: "test-hash",
      blueprintVersion: "1.0.0",
      data: genreContractData,
    }),
    chapterFunctions: createArtifact({
      artifactType: "chapter-functions",
      blueprintHash: "test-hash",
      blueprintVersion: "1.0.0",
      data: chapterFunctionsData,
    }),
  };
}

function makePhase1JudgeFixtures() {
  const packet = makeMinimalPhase1ChapterPacket();
  const blueprintArtifacts = makeMinimalPhase1BlueprintArtifacts();
  const packetArtifact = createArtifact<ChapterPacket>({
    artifactType: "chapter-packet",
    blueprintHash: "test-hash",
    blueprintVersion: "1.0.0",
    chapterNumber: 1,
    qualityProfile: "max",
    data: packet,
  });
  const approvedSpecArtifact = createArtifact<ChapterSpec>({
    artifactType: "approved-chapter-spec",
    blueprintHash: "test-hash",
    blueprintVersion: "1.0.0",
    chapterNumber: 1,
    qualityProfile: "max",
    data: {
      title: packet.title,
      purpose: packet.purpose,
      openingImage: "Open.",
      scenePlan: [
        {
          sceneNumber: 1,
          location: "Room",
          objective: "Establish.",
          summary: "First beat.",
          turn: "Pressure rises.",
          revealHandling: "Hint only.",
          exitCondition: "End on hook.",
          emotionalArc: "Rising.",
          sensoryAnchor: "Cold.",
          dialogueStrategy: "Subtext.",
        },
      ],
      mandatoryBeatCoverage: [{ beat: "Establish tension.", deliveryPlan: "Through action." }],
      callbackPlan: [],
      revealControl: { show: [], hint: [], reveal: [], withhold: [] },
      continuityWatchouts: [],
      proseGuidance: [],
      endingBeat: "Land on a sharp turn.",
    },
  });
  const draftArtifact = createArtifact<ChapterDraft>({
    artifactType: "chapter-draft",
    blueprintHash: "test-hash",
    blueprintVersion: "1.0.0",
    chapterNumber: 1,
    qualityProfile: "max",
    data: { prose: "A short smoke prose body.", wordCount: 6 },
  });
  return { packetArtifact, approvedSpecArtifact, draftArtifact, blueprintArtifacts };
}

test("judgeDraft honors stageOverride and artifactType when persistArtifact is false", async () => {
  // persistArtifact:false means no file write happens, so this is a pure
  // in-memory test — the polish/tournament rejudge contract verified.
  const { packetArtifact, approvedSpecArtifact, draftArtifact, blueprintArtifacts } = makePhase1JudgeFixtures();

  const polishRejudge = await judgeDraft({
    candidateId: "draft",
    packetArtifact,
    approvedSpecArtifact,
    draftArtifact,
    blueprintArtifacts,
    smoke: true,
    stageOverride: config.stageProfiles.polishRejudge,
    artifactType: "polish-rejudge",
    persistArtifact: false,
  });
  assert.equal(polishRejudge.artifactType, "polish-rejudge");

  const tournamentRejudge = await judgeDraft({
    candidateId: "revision",
    packetArtifact,
    approvedSpecArtifact,
    draftArtifact,
    blueprintArtifacts,
    smoke: true,
    artifactType: "tournament-rejudge",
    persistArtifact: false,
  });
  assert.equal(tournamentRejudge.artifactType, "tournament-rejudge");
});

test("judgeDraft default call preserves draft-review / revised-review artifactType", async () => {
  const { packetArtifact, approvedSpecArtifact, draftArtifact, blueprintArtifacts } = makePhase1JudgeFixtures();

  const draftReview = await judgeDraft({
    candidateId: "draft",
    packetArtifact,
    approvedSpecArtifact,
    draftArtifact,
    blueprintArtifacts,
    smoke: true,
    persistArtifact: false,
  });
  assert.equal(draftReview.artifactType, "draft-review");

  const revisedReview = await judgeDraft({
    candidateId: "revision",
    packetArtifact,
    approvedSpecArtifact,
    draftArtifact,
    blueprintArtifacts,
    smoke: true,
    persistArtifact: false,
  });
  assert.equal(revisedReview.artifactType, "revised-review");
});

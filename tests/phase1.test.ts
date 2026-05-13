import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { promises as fs } from "node:fs";

import {
  applyZoneToProse,
  composeTournamentMergedProse,
  locateEndingSlice,
  locateOpeningSlice,
} from "../src/pipeline/opening-ending-tournament.js";
import type { TournamentResult } from "../src/types/index.js";
import {
  buildVoiceFingerprint,
  buildGuidanceLines,
} from "../src/blueprint/extract-voice-fingerprint.js";
import { buildDraftSystemPrompt } from "../src/pipeline/generate-draft.js";
import { judgeDraft } from "../src/pipeline/judge-draft.js";
import { createArtifact } from "../src/pipeline/stage-utils.js";
import type {
  BlueprintCompilationArtifacts,
  ChapterDraft,
  ChapterFunctionMap,
  ChapterPacket,
  ChapterSpec,
  CompiledStoryBlueprint,
  GenreContract,
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

test("composeTournamentMergedProse splices opening then ending against preProse", () => {
  const opening = locateOpeningSlice(SAMPLE_PROSE)!;
  const ending = locateEndingSlice(SAMPLE_PROSE)!;

  const openingWinnerText = "She cracked the door open and listened. Nothing answered. Nothing ever did.\n\nShe stepped inside anyway, counting the small refusals it cost her.";
  const endingWinnerText = "Outside, the rain stopped pretending and committed to the windshield like it had wanted to all night.";

  const openingResult: TournamentResult = {
    zone: "opening",
    candidates: [
      { id: "opening-original", text: opening.text, rationale: "original" },
      { id: "opening-1", text: openingWinnerText, rationale: "candidate" },
    ],
    rounds: [{ pair: ["opening-original", "opening-1"], winner: "opening-1", rationale: "tighter" }],
    winnerId: "opening-1",
    winnerText: openingWinnerText,
    applied: true,
    skipReason: null,
  };
  const endingResult: TournamentResult = {
    zone: "ending",
    candidates: [
      { id: "ending-original", text: ending.text, rationale: "original" },
      { id: "ending-1", text: endingWinnerText, rationale: "candidate" },
    ],
    rounds: [{ pair: ["ending-original", "ending-1"], winner: "ending-1", rationale: "stronger out-beat" }],
    winnerId: "ending-1",
    winnerText: endingWinnerText,
    applied: true,
    skipReason: null,
  };

  const composed = composeTournamentMergedProse({
    preProse: SAMPLE_PROSE,
    openingResult,
    endingResult,
  });

  // Reference: apply opening, then ending (which re-locates against the post-opening prose).
  const afterOpening = applyZoneToProse({ prose: SAMPLE_PROSE, zone: "opening", zoneResult: openingResult });
  const expected = applyZoneToProse({ prose: afterOpening, zone: "ending", zoneResult: endingResult });

  assert.equal(composed.mergedProse, expected);
  assert.notEqual(composed.mergedProse, SAMPLE_PROSE);
  assert.ok(composed.mergedProse.includes(openingWinnerText));
  assert.ok(composed.mergedProse.endsWith(endingWinnerText));
  assert.equal(composed.openingResult!.applied, true);
  assert.equal(composed.endingResult!.applied, true);
});

test("composeTournamentMergedProse marks zone applied=false when its splice is a no-op", () => {
  const opening = locateOpeningSlice(SAMPLE_PROSE)!;
  const openingResult: TournamentResult = {
    zone: "opening",
    candidates: [],
    rounds: [],
    winnerId: "opening-1",
    winnerText: opening.text,
    applied: true,
    skipReason: null,
  };

  const composed = composeTournamentMergedProse({
    preProse: SAMPLE_PROSE,
    openingResult,
    endingResult: null,
  });

  assert.equal(composed.mergedProse, SAMPLE_PROSE);
  assert.equal(composed.openingResult!.applied, false);
  assert.match(composed.openingResult!.skipReason ?? "", /splice did not change prose/i);
});

function makeBlueprint(): CompiledStoryBlueprint {
  return {
    metadata: {
      title: "Test",
      author: "Author",
      blueprintVersion: "1.0.0",
      totalChapters: 1,
      defaultChapterWordCount: 2000,
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
    marketPromise: null,
    genre: {
      primaryGenre: "literary suspense",
      subgenres: ["psychological"],
      toneKeywords: ["haunting", "intimate"],
      readerExperience: "Quiet dread.",
      runtimeOverrides: {},
    },
    continuityManifest: null,
    locations: null,
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

test("buildDraftSystemPrompt embeds voice target guidance", () => {
  const voiceTarget: VoiceTarget = {
    source: "derived",
    derivedFromChapters: [1, 2],
    fingerprint: buildVoiceFingerprint({ text: SAMPLE_PROSE, blueprint: makeBlueprint() }),
    guidanceLines: ["Sentence-length target: mean ~14 words.", "Lean on signature words: smoke, glass."],
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
  });

  assert.match(prompt, /VOICE SIGNATURE TARGET/);
  assert.match(prompt, /Sentence-length target/);
});

test("buildDraftSystemPrompt instructs the model to land mandatory beats before texture", () => {
  const prompt = buildDraftSystemPrompt({
    genreContract: {
      primaryGenre: "literary suspense",
      contributingGenres: [],
      toneKeywords: [],
      readerExperience: "x",
      controls: {
        pacingCurve: "slow", sceneDensity: "medium", dialogueRatioTarget: "balanced",
        interiorityRatioTarget: "close", revealCadence: "controlled", hookStyle: "image",
        endingMode: "haunting", povDistance: "close", ambiguityTolerance: "high",
        sensoryDensity: "image-heavy", proseCompression: "lyrical",
        emotionalDwellExpectation: "earned", violenceExplicitness: "implied",
        romanceProminence: "low", validatorThresholdOverrides: [],
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
  assert.match(prompt, /Land EVERY mandatory beat/);
  assert.match(prompt, /trim the early luxuriance, not the required ending/);
  assert.match(prompt, /targetWordBand/);
});

test("buildDraftSystemPrompt omits voice section when absent", () => {
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
});

test("smoke pipeline writes tournament-merged + voice-target.json", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const result = runChapterCli(["--smoke"], rootDir);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`);

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

test("smoke chapter 2 packet picks up voice-target", async (t) => {
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
});

test("estimate-cost includes voice-calibration and tournament stage entries", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const estimate = runChapterCli(["--smoke", "--estimate-cost"], rootDir);
  assert.equal(estimate.status, 0, estimate.stderr || estimate.stdout);

  const costEstimate = await readJson<any>(
    path.join(rootDir, "artifacts", "chapters", "chapter-1-cost-estimate.json"),
  );
  const stages: any[] = costEstimate.data.stages;
  const stageNames: string[] = stages.map((s: any) => s.stage);
  const byName = new Map<string, any>(stages.map((s: any) => [s.stage, s]));

  assert.ok(stageNames.includes("voice-calibration"), "estimate must include voice-calibration");
  for (const zonePrefix of ["opening-candidate", "ending-candidate"]) {
    assert.ok(
      stageNames.includes(`${zonePrefix}-1`),
      `estimate must include ${zonePrefix}-1`,
    );
  }
  for (const zone of ["opening", "ending"]) {
    assert.ok(
      stageNames.includes(`tournament-selection-${zone}-1`),
      `estimate must include tournament-selection-${zone}-1`,
    );
  }

  for (const removed of [
    "polish-plan",
    "polish-rejudge",
    "reader-simulation",
    "tournament-rejudge",
    "title-candidate-1",
    "tournament-selection-title-1",
    "opening-candidate-2",
    "opening-candidate-3",
  ]) {
    assert.ok(!stageNames.includes(removed), `estimate must NOT include ${removed}`);
  }

  // genre-compilation must be present and zero-cost under --smoke (forces noGenreAi).
  assert.ok(stageNames.includes("genre-compilation"), "estimate must include genre-compilation");
  const genreCompilation = byName.get("genre-compilation");
  assert.equal(genreCompilation.estimatedInputTokens, 0, "smoke must zero-cost genre-compilation");
  assert.equal(genreCompilation.estimatedCostUsd, 0, "smoke must zero-cost genre-compilation");
  assert.match(
    genreCompilation.notes.join(" "),
    /Disabled by --no-genre-ai/i,
    "genre-compilation must carry the disabled-by-flag note under smoke",
  );

  // author-brief must be zero-cost under --smoke (deterministic fallback brief).
  const authorBrief = byName.get("author-brief");
  assert.ok(authorBrief, "estimate must include author-brief");
  assert.equal(authorBrief.estimatedInputTokens, 0, "smoke must zero-cost author-brief");
  assert.equal(authorBrief.estimatedCostUsd, 0, "smoke must zero-cost author-brief");
  assert.match(
    authorBrief.notes.join(" "),
    /Disabled by --no-genre-ai/i,
    "author-brief must carry the disabled-by-flag note under smoke",
  );

  // voice-calibration is a deterministic post-publish step; it must stay zero-cost.
  const voiceCal = byName.get("voice-calibration");
  assert.ok(voiceCal, "estimate must include voice-calibration");
  assert.equal(voiceCal.estimatedInputTokens, 0, "voice-calibration must be zero-token");
  assert.equal(voiceCal.estimatedCostUsd, 0, "voice-calibration must be zero-cost");

  // Gate-specific notes for the post-selection / fail-soft stages.
  const expectedNotes: Array<[string, RegExp]> = [
    ["revision", /Skipped when draft scores >= skipRevisionThreshold and has no blocking signals\./],
    ["literary-judge-revision", /Skipped when draft scores >= skipRevisionThreshold and has no blocking signals\./],
    ["pairwise-selection", /deterministic gates decide the winner/i],
    ["voice-grit-plan", /runs only when a voice-target is available/i],
    ["voice-grit-rejudge", /voice-grit-plan returned applied patches that passed validators/i],
    ["opening-candidate-1", /zone is locatable in the selected prose/i],
    ["ending-candidate-1", /zone is locatable in the selected prose/i],
    ["tournament-selection-opening-1", /candidate generation succeeded for that zone/i],
    ["tournament-selection-ending-1", /candidate generation succeeded for that zone/i],
  ];
  for (const [name, pattern] of expectedNotes) {
    const stage = byName.get(name);
    assert.ok(stage, `estimate must include ${name}`);
    assert.match(stage.notes.join(" | "), pattern, `${name} must carry note matching ${pattern}`);
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
    secondaryCameoBeats: [],
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
    marketPromise: null,
    continuityActiveSlice: null,
    locations: null,
    authorBrief: { authorialPersona: "Test persona.", craftDirectives: ["Test directive."], source: "deterministic" },
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
    marketPromise: null,
    genre: {
      primaryGenre: "thriller",
      subgenres: [],
      toneKeywords: ["tense"],
      readerExperience: "Pressure.",
      runtimeOverrides: {},
    },
    continuityManifest: null,
    locations: null,
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
    marketPromise: createArtifact({
      artifactType: "market-promise",
      blueprintHash: "test-hash",
      blueprintVersion: "1.0.0",
      data: null,
    }),
    continuityManifest: createArtifact({
      artifactType: "continuity-manifest",
      blueprintHash: "test-hash",
      blueprintVersion: "1.0.0",
      data: null,
    }),
    locations: createArtifact({
      artifactType: "locations",
      blueprintHash: "test-hash",
      blueprintVersion: "1.0.0",
      data: null,
    }),
    authorBrief: createArtifact({
      artifactType: "author-brief",
      blueprintHash: "test-hash",
      blueprintVersion: "1.0.0",
      data: { authorialPersona: "Test persona.", craftDirectives: ["Test directive."], source: "deterministic" as const },
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
    data: packet,
  });
  const approvedSpecArtifact = createArtifact<ChapterSpec>({
    artifactType: "approved-chapter-spec",
    blueprintHash: "test-hash",
    blueprintVersion: "1.0.0",
    chapterNumber: 1,
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
          humanGrain: null,
        },
      ],
      mandatoryBeatCoverage: [{ beat: "Establish tension.", deliveryPlan: "Through action." }],
      callbackPlan: [],
      revealControl: { show: [], hint: [], reveal: [], withhold: [] },
      continuityWatchouts: [],
      proseGuidance: [],
      physicalClueAnchors: [],
      endingBeat: "Land on a sharp turn.",
    },
  });
  const draftArtifact = createArtifact<ChapterDraft>({
    artifactType: "chapter-draft",
    blueprintHash: "test-hash",
    blueprintVersion: "1.0.0",
    chapterNumber: 1,
    data: { prose: "A short smoke prose body.", wordCount: 6 },
  });
  return { packetArtifact, approvedSpecArtifact, draftArtifact, blueprintArtifacts };
}

test("judgeDraft honors artifactType when persistArtifact is false", async () => {
  const { packetArtifact, approvedSpecArtifact, draftArtifact, blueprintArtifacts } = makePhase1JudgeFixtures();

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

# Commercial Fiction Engine v2

TypeScript CLI for blueprint-first, chapter-by-chapter commercial-fiction generation. Single canonical pipeline; no quality profiles.

## What Matters

- `BLUEPRINT_TEMPLATE.md` is the canonical authoring template. The runtime reads `STORY_BLUEPRINT.md` (a copy of the template that the author fills in).
- `chapters/` contains published prose output. Do not rewrite it unless the user explicitly asks.
- `artifacts/` contains checkpointed runtime state. Treat it as runtime output, not source code.
- `src/index.ts` is the CLI entrypoint.
- `src/pipeline/run-chapter.ts` is the main orchestrator.
- `src/pipeline/generate-spec.ts` owns the spec loop: spec generation, self-red-team, default-on/required Opus critique, and approved-spec revision.
- `src/pipeline/judge-draft.ts` owns the 15-dimension literary rubric, anti-committee principles, the bestseller question, pass-threshold logic, and blocking-review signal handling.
- `src/pipeline/revise-draft.ts` routes revision: patch-list planning by default (`revisionPatch`) and whole-chapter structural rewrite only when `shouldStructurallyRewrite`, patch-budget overflow, or model self-escalation requires it.
- `src/pipeline/fix-continuity.ts` owns continuity-fix patch planning. It emits `RevisionPlan` JSON and persists `RevisionDiff` at `chapter-N-fix-attempt-K.json`; no whole-chapter rewrite fallback.
- `src/pipeline/apply-revision-patches.ts` is the shared deterministic apply/accountability helper for revision-patch and continuity-fix.
- `src/pipeline/voice-grit-pass.ts` owns the post-selection voice-grit pass per `docs/voice-grit-spec.md`.
- `src/pipeline/opening-ending-tournament.ts` owns the 1-candidate-per-zone opening + ending compare. No title generation, no rejudge stage.
- `src/pipeline/final-audit.ts` merges deterministic validator results with the model audit. The auditor flags any visible violation of the declared reader job as an error.
- `src/pipeline/update-continuity-state.ts` owns the deterministic post-publish state merge that writes `continuity-state-after-N.json` (consuming declared spec reveals + extracted `ChapterDelta`) and exports `loadPersistedContinuityState` / `projectStateToManifest` so the next chapter's packet builder consumes the live state.
- `src/blueprint/extract-voice-fingerprint.ts` deterministically extracts the voice fingerprint from published chapters (or `STYLE_SAMPLE.md`) and writes `artifacts/blueprint/voice-target.json`. Runs after publish AND at `compileBlueprintRuntime` time when the file is absent (via `ensureVoiceTargetSeeded`) so chapter 1's voice-grit always has a target — seed `effectTics` catalog when no corpus exists, corpus-derived overwrite once chapters publish. Existing voice-targets are never clobbered by the seed step.
- `src/blueprint/compile-author-brief.ts` produces the cached authorial-persona statement plus 6-10 craft directives that combine genre tradition with the specific commercial promise of THIS book. One model call per blueprint, deterministic fallback when no credentials.
- `src/blueprint/compile-market-promise.ts`, `src/blueprint/compile-continuity-manifest.ts`, and `src/blueprint/compile-locations.ts` are deterministic compiles of the optional `## Market Promise`, `## Continuity Manifest`, and `## Locations` sections. Locations is static naming canon (`name | type | description | aliases`) distinct from the Continuity Manifest's stateful Spatial Registry; the full table is carried in the packet and surfaced to spec + drafter prompts.
- `src/pipeline/estimate-cost.ts` is the operator-facing budgeting estimate. Keep its stage list, notes, and stage names aligned with runtime behavior, but treat it as heuristic rather than exact reconciliation.
- `src/config.ts` defines model defaults, stage budgets, `qualitySettings`, and paths.
- `src/types/index.ts` is the contract layer for CLI options, artifacts, statuses, and pipeline data.
- `src/pipeline/stage-utils.ts` owns artifact paths, envelopes, and blocked-status plumbing.
- `src/validators/index.ts` is the deterministic validator entrypoint.
- `src/validators/continuity-manifest.ts` checks object-state contradictions, sealed-section regressions, timeline reversals, premature reveals, and motif evolution skips.
- Default provider split: OpenAI `gpt-5.5` for planning, judging, selection, memory, audit, author-brief, voice-grit-rejudge, and tournament-selection stages; Anthropic `claude-opus-4-7` for critique, drafting, revision/`revisionPatch`, continuity fixes, voice-grit-plan, and tournament candidate generation.
- `.cursor/rules/*.mdc` and this file are persistent agent context. Keep them aligned with runtime behavior when model defaults, stage contracts, testing patterns, or project ownership rules change.

## Safe Workflow

1. Prefer `npm test` and `npm run typecheck` after substantive TypeScript changes.
2. Prefer `npm run smoke` or isolated-root CLI tests over live provider calls.
3. Use live OpenAI/Anthropic runs only when the change cannot be validated locally.
4. Do not require real API keys in tests.
5. If code and maintenance docs/rules disagree, trust the code, then update the stale context in the same task.

## Pipeline Contract

When changing stages, reruns, or artifacts, review these files together:

- `src/config.ts`
- `src/index.ts`
- `src/types/index.ts`
- `src/pipeline/run-chapter.ts`
- `src/pipeline/stage-utils.ts`
- `README.md`
- `AGENTS.md` and relevant `.cursor/rules/*.mdc`
- relevant tests under `tests/`

Preserve these invariants:

- Stage outputs should be written as `ArtifactEnvelope<T>`.
- Reused artifacts must still validate `artifactType`, `blueprintHash`, `blueprintVersion`, and `chapterNumber`.
- Blocked runtime paths should surface structured statuses, not silent fallbacks.
- CLI exit code `2` means a blocked pipeline result; exit code `1` means an unexpected runtime/CLI failure.

Skip-revision artifact contract (CRITICAL):

- When the draft clears `qualitySettings.skipRevisionThreshold` AND has no blocking review signals, revision is skipped.
- The skip path MUST still write `chapter-N-selection.json`, `chapter-N-selected.json`, and `chapter-N-review.json` before voice-grit runs. `--rerun-from judge`, `--rerun-from memory`, and `--audit-only` depend on these.
- When revision runs, `reviseDraft()` returns `{ artifact, usageStage }`; `artifact.data` remains `ChapterDraft`. Patch path also writes `chapter-N-revision-diff.json`; structural rewrite does not.

Voice-grit + tournament invariants:

- Voice-grit runs before the opening/ending tournament so the tournament still owns its reserved zones (opening ~200 words, ending paragraph, paragraph-end sentences, scene-break leadout sentences).
- Both passes are advisory and fail-soft. Throw or discard leaves `selected` unchanged downstream.
- Voice-grit follows `docs/voice-grit-spec.md`: reserved zones blocked, ticSource validated, count caps enforced, atomic whole-batch discard on rejudge regression > 1pt or new blocking review signal.
- Tournament is 1-candidate-per-zone (opening + ending only). No title generation. No separate rejudge stage. Pairwise compare runs new candidate vs current zone text; only splices when the new candidate wins.

## Project-Specific Hot Spots

- In `src/pipeline/build-rolling-memory.ts`, de-duping must preserve the most specific fact, not the shortest paraphrase.
- In `src/pipeline/build-rolling-memory.ts`, `mustNotKnowYet` may clear only when a single `knows` entry fully covers the forbidden fact; loose overlap is not enough.
- Keep `activeTraits`, `dialogueHabits`, and `tabooNotes` distinct when merging rolling memory and voice cards.
- Any voice card synthesized from chapter data should carry a valid `updatedFromChapter`.
- In `src/pipeline/generate-spec.ts`, `mapChapterFunctionToReaderJob` is the single source for translating `ChapterFunction` to `ChapterRetentionFunction`. Reuse it from judge + draft + audit prompts.
- Optional `CharacterCard.noticingEngine`, required `ChapterSpec.physicalClueAnchors` (default `[]`), and required nullable per-scene `scenePlan[].humanGrain` are surfaced to spec/draft/judge prompts; the judge adds two weakness signals (clue-anchor legibility → `specificity`; missing in-POV use of `noticingEngine` → `voiceConsistency`) plus the `SCENE TURN CHECK` (→ `forwardMotion`) and `NAMED WITHOUT FUTURE USE` (→ `freshness`) instruction blocks. None add a 16th rubric dimension.
- Density-discipline weakness signals (no new rubric dimension, no blocking signal): `PHYSICAL CLUE ANCHOR CHECK` requires the before/after change to be statable in one sentence each, anchored to a single fixed marker (→ `specificity`, weakness + revisionAction); `CLARITY FLOOR AT DANGER REVEALS` (inside the same clue-anchor block) requires at least one short plain restatable sentence at the moment a `physicalClueAnchors` change becomes visible — lyrical compression is welcome alongside, never instead of, the plain sentence (→ `proseQuality`, weakness + revisionAction); `NAMED WITHOUT FUTURE USE` adds an inventory-to-consequence clause for POV inventories of ≥3 named figures (→ `freshness`, weakness + revisionAction); `WITHHELD ACTION VARIETY` mirrors the `WITHHELD_ACTION_VARIETY` validator and asks the judge to count `did/had not + perception/action verb` beats themselves so the signal reaches the revision pass without round-tripping through final audit (→ `freshness`, weakness + revisionAction); `EXPERT INACTION JUSTIFICATION` requires that when an expert POV (architect/engineer/doctor/pilot/etc.) observes a structural anomaly and stays passive within the chapter, the prose makes the reason for delay legible — a reader should be able to answer "why didn't they just tell someone?" from material already on the page (→ `characterTruth`, weakness + revisionAction); `OVER-COMPOSED CLUSTER CHECK` flags the densest ornate cluster identified by opening phrase + scene number (→ `proseQuality`, weakness + revisionAction); `ANTI-COMMITTEE PRINCIPLES` carries the necessity-over-abundance line as a principle paired with the density governors (no per-signal action surface); `DOMINANT JOB DISCIPLINE` reads `ChapterSpec.purpose` directly from the approved-spec JSON in the judge prompt and flags competing material (→ `forwardMotion`, weakness + revisionAction). The revision pass consumes both `weaknesses` and `revisionActions`. Voice-grit downstream does not see judge review and is unchanged by these signals. The drafter's CHAPTER-1 LESSONS H3 and D2 carry the same `CLARITY FLOOR` and expert-inaction-justified requirements so the drafter targets the rules at write time, not only revision time.
- `buildSpecGenerationRequest` requires `purpose` to be a single-sentence dominant job ("one job, not a list"). The `DOMINANT JOB DISCIPLINE` judge block reads this field directly from the approved-spec JSON; do not thread a separate `purpose` parameter through `buildJudgeInstructions` or `judgeDraft`.
- In `src/pipeline/run-chapter.ts`, `skipRevisionThreshold` may short-circuit revision only when the first draft passes threshold and has no blocking review signals. The skip path must still write `selection`, `selected`, and `review`.
- In `src/pipeline/run-chapter.ts`, final audit blocking should follow the audit contract consistently, `POST_FIX_WORD_COUNT` remains advisory-only, and `qualitySettings.maxFixAttempts` (default 2) caps the continuity fix loop.
- `TrackedIssue` ids are engine-minted (`${origin}#${index}`) and every planner input issue must appear in `RevisionDiff.issueCoverage` as patched, skipped, covered by another patch, or unaddressed. Advisory warnings ride along only when a planner is already invoked by mandatory findings.
- Validator-only blocking (every error-severity audit issue has `source: "validator"`) must NOT trigger the continuity patch planner. Downgrade those errors to warnings via `downgradeValidatorOnlyErrors`, persist the audit, and break the loop. Deterministic validators are useful as smoke detectors, but they are too false-positive-prone to overrule a literary-judge-approved chapter.
- `mergeAuditWithValidator` MUST tag every audit issue with `source: "model" | "validator"` so the gate above can tell them apart.
- Publish-candidate immutability: the prose entering the final audit (post pairwise-selection, post voice-grit, post tournament) is the publish candidate. It is persisted as `chapter-N-publish-candidate.json`. After any fix-loop pass, the publish-candidate ratchet runs BEFORE the post-fix threshold gate. The pipeline reverts when EITHER the post-fix re-judge score regressed beyond `qualitySettings.publishCandidateRegressionTolerance` (default 1pt) OR the post-fix dropped below `qualitySettings.judgePassThreshold` while the candidate had cleared it. On revert: prose, review, delta, memory, and audit are restored to the candidate, any blocking audit errors on the candidate are downgraded to warnings via `downgradeAllErrorsToWarnings` (severity flips, `source` is preserved so operators still see model vs validator provenance), the audit summary is annotated by `annotateRevertedAuditSummary` so `requiresFix: false` reads as intentional, and the chapter publishes. The post-fix `BLOCKED_QUALITY` gate only fires when the candidate also failed threshold (no good prose to revert toward). Later stages may improve or repair, never quietly degrade — including by nudging a publishable candidate just under threshold.
- Voice-grit must NOT touch reserved zones; the tournament owns opening + ending; polish-pass and reader-simulation are NOT part of v2.
- `voice-target.json`, `market-promise.json`, `continuity-manifest.json`, `locations.json`, `author-brief.json`, and `continuity-state-after-N.json` are loaded with soft metadata validation (schema, artifactType, `blueprintHash`, `blueprintVersion`). Mismatches drop silently rather than throwing.
- Mistaken-belief tracking: per-POV `mistakenBeliefs` flow `ChapterDelta.mistakenBeliefDeltas` (introduce/reinforce/question/correct/exploit) → `update-continuity-state` deterministic merge (case-insensitive trim duplicate-collapse; `corrected` is sticky against subsequent reinforces) → `compile-chapter-packet` reads `ContinuityState.mistakenBeliefs` directly (NOT through `projectStateToManifest`, which stays static-blueprint-derived) → spec/draft/judge surfacing (PromptCharacterView projects active+questioned only; D2 carve-out asks the drafter to let beliefs drive scene-reading; `buildVoiceCardSummary` appends `believes=[...]`). `normalizeChapterDelta` backfills `mistakenBeliefDeltas: []` after every model output, smoke output, and `--rerun-from` artifact load.
- Repeated-effect detection: voice-grit gains a 7th texture `repeated-effect` and `VoiceFingerprint.effectTics` (seven sub-arrays) extracted deterministically by `extract-voice-fingerprint.ts` (seed-catalog fallback when no corpus). `buildEffectTicLookup(voiceTarget)` is threaded through `applyVoiceGritPatches` so `ticSource` of the form `effectTics.<category>:<entry>` validates against the lookup. Tabooed entries excluded; reserved zones, count caps, and atomic-discard-on-rejudge-regression rule unchanged.
- Voice-target seeding at compile time: `compileBlueprintRuntime` calls `ensureVoiceTargetSeeded` after both cache-hit and cache-miss paths. When `voice-target.json` is absent, it invokes `extractAndPersistVoiceTarget` (which falls back to the seed `effectTics` catalog if no published chapters yield ≥200 chars). When the file is present (even with a stale blueprint hash), the seed step is a no-op — soft validation in `loadVoiceTargetIfPresent` still drops stale targets at packet build time.
- Judge POV demographic block (no-discretion rule): unsourced demographic assertions about non-cast walk-ons (ethnicity, nationality, exact age, training history, professional background, biographical fact) are STRUCTURAL POV violations and must enter `blockingIssues` every time, not weakness/revisionAction only. The bar for blocking is intentionally low because the fix is trivial (observable description, or have a cast character introduce the fact).
- In `src/validators/prose-quality.ts`, knowledge-leak matching should stay boundary-aware: allow punctuated mentions like `Lena,` or `Lena's`, but reject substring matches like `annual` for `Ann`.
- In `src/validators/prose-quality.ts`, `detectNamedCharacterCapExceeded` is warning-only and runs from the blueprint character cast. First-name and full-name matches are case-insensitive; surname-only matching is opt-in via `CharacterCard.surnameAlias` and case-sensitive (so common-noun surnames like `Park` or `Crane` don't tip on prose like `the crane lifted`). `ChapterPacket.namedCharacterCap` is optional; absent = no cap.
- In `src/validators/prose-quality.ts`, `INVERTED_NP_CONTRAST`, `WITHHOLDING_TIC`, `WITHHELD_ACTION_VARIETY`, and `EXPLANATORY_BECAUSE_CLUSTER` are warning-only narration-only detectors that run after `stripDialogueForNarration`; the seed phrase/subject/system-noun lists are partly predictive — extend them rather than lower thresholds when calibrating. `WITHHELD_ACTION_VARIETY` is chapter-level min-count gated (default 6) and uses two paired seed lists (`WITHHELD_ACTION_VERBS_BASE` for `did/does/do + not + <base>`, `WITHHELD_ACTION_VERBS_PAST` for `had/has/have + not + <past participle>`); extend both in lockstep.
- In `src/pipeline/smoke-helpers.ts`, keep smoke prose deterministic and validator-clean so calibration stays interpretable.

## Testing Patterns

- CLI tests should use isolated temp roots via `NOVEL_CREATOR_ROOT`.
- Smoke tests are the default way to validate end-to-end orchestration.
- If you change rerun logic, artifact metadata, judge thresholds, critique gating, skip-revision behavior, fix-loop/post-fix judge behavior, memory merge rules, deterministic validators, smoke-helper calibration, audit gating, voice-grit validation, or the continuity validator/state merge, add a focused regression test.

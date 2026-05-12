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
- `src/pipeline/voice-grit-pass.ts` owns the post-selection voice-grit pass per `docs/voice-grit-spec.md`.
- `src/pipeline/opening-ending-tournament.ts` owns the 1-candidate-per-zone opening + ending compare. No title generation, no rejudge stage.
- `src/pipeline/final-audit.ts` merges deterministic validator results with the model audit. The auditor flags any visible violation of the declared reader job as an error.
- `src/pipeline/update-continuity-state.ts` owns the deterministic post-publish state merge that writes `continuity-state-after-N.json` (consuming declared spec reveals + extracted `ChapterDelta`) and exports `loadPersistedContinuityState` / `projectStateToManifest` so the next chapter's packet builder consumes the live state.
- `src/blueprint/extract-voice-fingerprint.ts` deterministically extracts the voice fingerprint from published chapters (or `STYLE_SAMPLE.md`) and writes `artifacts/blueprint/voice-target.json`. Runs after publish.
- `src/blueprint/compile-author-brief.ts` produces the cached authorial-persona statement plus 6-10 craft directives that combine genre tradition with the specific commercial promise of THIS book. One model call per blueprint, deterministic fallback when no credentials.
- `src/blueprint/compile-market-promise.ts` and `src/blueprint/compile-continuity-manifest.ts` are deterministic compiles of the optional `## Market Promise` and `## Continuity Manifest` sections.
- `src/pipeline/estimate-cost.ts` is the operator-facing budgeting estimate. Keep its stage list, notes, and stage names aligned with runtime behavior, but treat it as heuristic rather than exact reconciliation.
- `src/config.ts` defines model defaults, stage budgets, `qualitySettings`, and paths.
- `src/types/index.ts` is the contract layer for CLI options, artifacts, statuses, and pipeline data.
- `src/pipeline/stage-utils.ts` owns artifact paths, envelopes, and blocked-status plumbing.
- `src/validators/index.ts` is the deterministic validator entrypoint.
- `src/validators/continuity-manifest.ts` checks object-state contradictions, sealed-section regressions, timeline reversals, premature reveals, and motif evolution skips.
- Default provider split: OpenAI `gpt-5.5` for planning, judging, selection, memory, audit, author-brief, voice-grit-rejudge, and tournament-selection stages; Anthropic `claude-opus-4-7` for critique, drafting, revision, continuity fixes, voice-grit-plan, and tournament candidate generation.
- `.cursor/rules/*.mdc` and this file are persistent agent context. Keep them aligned with runtime behavior when model defaults, stage contracts, testing patterns, or project ownership rules change.

## Safe Workflow

1. Prefer `npm test` and `npm run typecheck` after substantive TypeScript changes.
2. Prefer `npm run smoke` or isolated-root CLI tests over live provider calls.
3. Use live OpenAI/Anthropic runs only when the change cannot be validated locally.
4. Do not require real API keys in tests.

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
- In `src/pipeline/run-chapter.ts`, `skipRevisionThreshold` may short-circuit revision only when the first draft passes threshold and has no blocking review signals. The skip path must still write `selection`, `selected`, and `review`.
- In `src/pipeline/run-chapter.ts`, final audit blocking should follow the audit contract consistently, `POST_FIX_WORD_COUNT` remains advisory-only, and `qualitySettings.maxFixAttempts` (default 2) caps the continuity fix loop.
- Validator-only blocking (every error-severity audit issue has `source: "validator"`) must NOT trigger the wholesale `fixContinuity` rewrite. Downgrade those errors to warnings via `downgradeValidatorOnlyErrors`, persist the audit, and break the loop. Deterministic validators are useful as smoke detectors, but they are too false-positive-prone to overrule a literary-judge-approved chapter.
- `mergeAuditWithValidator` MUST tag every audit issue with `source: "model" | "validator"` so the gate above can tell them apart.
- Publish-candidate immutability: the prose entering the final audit (post pairwise-selection, post voice-grit, post tournament) is the publish candidate. It is persisted as `chapter-N-publish-candidate.json`. After any fix-loop pass, the post-fix re-judge score must remain within `candidateScore - qualitySettings.publishCandidateRegressionTolerance` (default 1pt) or the pipeline reverts: prose, review, delta, memory, and audit are restored to the candidate, any blocking audit errors on the candidate are downgraded to warnings via `downgradeAllErrorsToWarnings` (severity flips, `source` is preserved so operators still see model vs validator provenance), the audit summary is annotated by `annotateRevertedAuditSummary` so `requiresFix: false` reads as intentional, and the chapter publishes. Later stages may improve or repair, never quietly degrade.
- Voice-grit must NOT touch reserved zones; the tournament owns opening + ending; polish-pass and reader-simulation are NOT part of v2.
- `voice-target.json`, `market-promise.json`, `continuity-manifest.json`, `author-brief.json`, and `continuity-state-after-N.json` are loaded with soft metadata validation (schema, artifactType, `blueprintHash`, `blueprintVersion`). Mismatches drop silently rather than throwing.
- In `src/validators/prose-quality.ts`, knowledge-leak matching should stay boundary-aware: allow punctuated mentions like `Lena,` or `Lena's`, but reject substring matches like `annual` for `Ann`.
- In `src/validators/prose-quality.ts`, `detectNamedCharacterCapExceeded` is warning-only and runs from the blueprint character cast. First-name and full-name matches are case-insensitive; surname-only matching is opt-in via `CharacterCard.surnameAlias` and case-sensitive (so common-noun surnames like `Park` or `Crane` don't tip on prose like `the crane lifted`). `ChapterPacket.namedCharacterCap` is optional; absent = no cap.
- In `src/pipeline/smoke-helpers.ts`, keep smoke prose deterministic and validator-clean so calibration stays interpretable.

## Testing Patterns

- CLI tests should use isolated temp roots via `NOVEL_CREATOR_ROOT`.
- Smoke tests are the default way to validate end-to-end orchestration.
- If you change rerun logic, artifact metadata, judge thresholds, critique gating, skip-revision behavior, fix-loop/post-fix judge behavior, memory merge rules, deterministic validators, smoke-helper calibration, audit gating, voice-grit validation, or the continuity validator/state merge, add a focused regression test.

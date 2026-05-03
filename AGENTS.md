# Novel Creator GPT

TypeScript CLI for blueprint-first, chapter-by-chapter novel generation.

## What Matters

- `STORY_BLUEPRINT.md` is the author-owned source of truth.
- `chapters/` contains published prose output. Do not rewrite it unless the user explicitly asks.
- `artifacts/` contains checkpointed runtime state. Treat it as runtime output, not source code.
- `src/index.ts` is the CLI entrypoint.
- `src/pipeline/run-chapter.ts` is the main orchestrator.
- `src/pipeline/generate-spec.ts` owns the spec loop: spec generation, self-red-team, optional/required Opus critique, and approved-spec revision.
- `src/pipeline/judge-draft.ts` owns the 15-dimension literary rubric, pass-threshold logic, and blocking-review signal handling.
- `src/pipeline/final-audit.ts` merges deterministic validator results with the model audit.
- `src/pipeline/polish-pass.ts` owns the Phase 1 post-selection polish pass (mid-chapter zones only; opening/ending/title are reserved for the tournament).
- `src/pipeline/opening-ending-tournament.ts` owns the Phase 1 opening/ending/title candidate tournament. It reuses polish's plan/apply/validate/re-judge fail-soft pattern and never overlaps polish's mid-chapter zones.
- `src/pipeline/reader-simulation.ts` owns the Phase 1 advisory 3-persona reader simulation. It always runs on the final enhanced prose (after polish + tournament) and feeds `flaggedPassages` forward into the next chapter's draft prompt as advisory context.
- `src/blueprint/extract-voice-fingerprint.ts` deterministically extracts the voice fingerprint from published chapters (or `STYLE_SAMPLE.md`) and writes `artifacts/blueprint/voice-target.json`. It runs after publish and feeds into the next chapter's draft system prompt.
- `src/pipeline/estimate-cost.ts` is the operator-facing budgeting estimate. Keep its stage list, notes, and stage names aligned with runtime behavior, but treat it as heuristic rather than exact reconciliation.
- `src/config.ts` defines model/stage budgets, quality profiles, and paths.
- `src/types/index.ts` is the contract layer for CLI options, artifacts, statuses, and pipeline data.
- `src/pipeline/stage-utils.ts` owns artifact paths, envelopes, and blocked-status plumbing.
- `src/validators/index.ts` is the deterministic validator entrypoint.
- `src/validators/prose-quality.ts` owns prose-level repetition, filter-word, dialogue, paragraph, and knowledge-leak checks, while `src/validators/index.ts` also enforces structural continuity checks such as word band, mandatory beats, unresolved threads, knowledge boundaries, and entity consistency.
- Default provider split: OpenAI `gpt-5.5` for planning, judging, selection, memory, audit, reader-simulation, and tournament-selection stages; Anthropic `claude-opus-4-7` for critique, drafting, revision, continuity fixes, polish-plan, and tournament candidate generation.
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
- Reused artifacts must still validate `artifactType`, `blueprintHash`, `blueprintVersion`, `chapterNumber`, and `qualityProfile`.
- Blocked runtime paths should surface structured statuses, not silent fallbacks.
- CLI exit code `2` means a blocked pipeline result; exit code `1` means an unexpected runtime/CLI failure.
- Parallelized or skipped paths must still preserve the downstream artifact contract for `selection`, `selected`, and `review`.
- Parallel stage scheduling must not drop usage/cost collection or change required-vs-optional critique semantics.
- Stage-name changes in runtime must stay aligned with usage collection and cost-estimate naming, including `literary-judge-revision`, `literary-judge-post-fix`, and the `*-fix-N` loop stages.

## Project-Specific Hot Spots

- In `src/pipeline/build-rolling-memory.ts`, de-duping must preserve the most specific fact, not the shortest paraphrase.
- In `src/pipeline/build-rolling-memory.ts`, `mustNotKnowYet` may clear only when a single `knows` entry fully covers the forbidden fact; loose overlap is not enough.
- Keep `activeTraits`, `dialogueHabits`, and `tabooNotes` distinct when merging rolling memory and voice cards.
- Any voice card synthesized from chapter data should carry a valid `updatedFromChapter`.
- In `src/pipeline/generate-spec.ts`, keep optional profile-driven critique separate from required high-risk/escalated critique.
- In `src/pipeline/run-chapter.ts`, `skipRevisionThreshold` may short-circuit revision only when the first draft passes threshold and has no blocking review signals. The skip path must still write `selection`, `selected`, and `review`.
- In `src/pipeline/run-chapter.ts`, final audit blocking should follow the audit contract consistently, `POST_FIX_WORD_COUNT` remains advisory-only, and any fix-loop changes must preserve the post-fix literary judge behavior.
- Phase 1 post-selection stages (polish-pass, opening/ending tournament, reader-simulation) are advisory and fail-soft. They must never block publish on their own — failure means downstream consumes `selected` unchanged. Reader-simulation must run on the final enhanced prose, not raw `selected`, so its `flaggedPassages` reference text that actually exists.
- Phase 1 stages run only on the `max` quality profile. `standard` and `rerun` keep their pre-Phase-1 behavior (no polish, no tournament, no reader-sim, no voice extraction or packet voice/reader-sim load) until a future opt-in flag is added.
- Polish-pass and the opening/ending tournament must own mutually exclusive zones. Polish only edits mid-chapter paragraph-end and scene-break lead-out sentences; the tournament owns the chapter opening (~200 words), the chapter ending (last paragraph), and the chapter title.
- `applyPolishPatches` requires every `paragraph-end` and `scene-break-leadout` patch's `originalText` to end the target paragraph (after trimming trailing whitespace). Mid-paragraph rewrites are silently skipped.
- Polish and tournament rejudges must call `judgeDraft({ persistArtifact: false })` and write their own `chapter-N-polish-rejudge.json` / `chapter-N-tournament-rejudge.json` artifacts. They must NOT overwrite the original `chapter-N-draft-review.json` or `chapter-N-revised-review.json` audit trail.
- Tournament zone artifacts (`chapter-N-tournament-{opening,ending,title}.json`) must record the final `applied` state for that zone before the artifact is persisted. The merged outcome lives in `chapter-N-tournament-merged.json`.
- Voice calibration is a deterministic, post-publish, no-model-call pass that runs on `max` after every chapter and writes `artifacts/blueprint/voice-target.json`. Chapter 1's DRAFT prompt has no derived voice unless `STYLE_SAMPLE.md` is present (extraction has not run yet). After chapter 1 publishes, the engine derives the fingerprint from `chapter-1.md` so chapter 2's packet and draft prompt can pick it up. `STYLE_SAMPLE.md`, when present, takes precedence over derived prose. Failure to extract or load is fail-soft.
- `voice-target.json` and prior `chapter-N-reader-sim.json` are loaded with soft metadata validation (schema, artifactType, `blueprintHash`, `blueprintVersion`, plus `qualityProfile` for reader-sim). Mismatches silently drop the advisory from the next packet rather than throwing.
- In `src/validators/prose-quality.ts`, knowledge-leak matching should stay boundary-aware: allow punctuated mentions like `Lena,` or `Lena's`, but reject substring matches like `annual` for `Ann`.
- In `src/pipeline/smoke-helpers.ts`, keep smoke prose deterministic and validator-clean so calibration stays interpretable.

## Testing Patterns

- CLI tests should use isolated temp roots via `NOVEL_CREATOR_ROOT`.
- Smoke tests are the default way to validate end-to-end orchestration.
- If you change rerun logic, artifact metadata, judge thresholds, critique gating, skip-revision behavior, fix-loop/post-fix judge behavior, memory merge rules, deterministic validators, smoke-helper calibration, or audit gating, add a focused regression test.

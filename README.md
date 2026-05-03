# Novel Creator GPT

Blueprint-first, chapter-by-chapter novel generation CLI.

`STORY_BLUEPRINT.md` is the single author-owned source of truth. The runtime compiles that blueprint into machine-usable artifacts, generates a continuity-aware chapter, audits it, and only publishes prose that clears both literary and factual gates.

## Pipeline Overview

The main run in `src/pipeline/run-chapter.ts` is not a simple linear draft-only flow. It currently works like this:

1. Compile the blueprint into `compiled-blueprint`, `genre-contract`, and `chapter-functions` artifacts.
2. Build a chapter packet with active cast, reveal budget, pacing/voice guidance, rolling memory, handoff memory, previous chapter context, and the target word band.
3. Run the spec loop:
   - `spec-generation`
   - `self-red-team`
   - optional or required `spec-critique`
   - `spec-revision` to produce the approved spec
4. Draft the chapter.
5. Judge the draft on the 15-dimension literary rubric.
6. Either:
   - skip revision when the first draft clears `skipRevisionThreshold`, passes threshold, and has no blocking review signals, or
   - run `revision`, `literary-judge-revision`, and `pairwise-selection`
7. If the selected winner still fails the literary threshold, run a capped literary retry loop:
   - `revision-retry-N`
   - `literary-judge-retry-N`
8. (Phase 1, `max` profile only.) Run the post-selection enhancement stages on the selected prose. All advisory and fail-soft — failure means downstream consumes `selected` unchanged. `standard` and `rerun` profiles skip these:
   - `polish-plan` + `polish-rejudge` (mid-chapter paragraph-end and scene-break lead-out polish; rejudge persists to `chapter-N-polish-rejudge.json` and never overwrites the per-candidate review trail)
   - opening/ending/title tournament (`opening-candidate-1..3`, `ending-candidate-1..3`, `title-candidate-1..3`, `tournament-selection-*`, `tournament-rejudge`; rejudge persists to `chapter-N-tournament-rejudge.json`)
   - `reader-simulation` (3 personas, advisory; flagged passages feed forward into next chapter's draft prompt)
9. Extract the chapter delta and update rolling memory.
10. Run deterministic validators and the final audit.
11. If the audit blocks, first try deterministic localized audit patching and re-audit the chapter without rebuilding delta or memory.
12. If the audit still blocks, run the surgical continuity fix loop:
   - `continuity-fix-N`
   - `chapter-delta-fix-N`
   - `memory-update-fix-N`
   - `final-audit-fix-N`
13. If any localized patch or fix was applied, re-judge the selected prose with `literary-judge-post-fix`.
14. If the post-fix judge fails, run one post-fix literary rescue pass when literary retries are enabled for the profile:
   - `revision-post-fix-rescue`
   - `literary-judge-post-fix-rescue`
   - `chapter-delta-post-fix-rescue`
   - `memory-update-post-fix-rescue`
   - `final-audit-post-fix-rescue`
15. Publish only if the chapter still clears the literary gate and the audit gate.
16. (Phase 1, `max` profile only.) After publish, run the deterministic voice-calibration pass to refresh `artifacts/blueprint/voice-target.json` from the latest published chapters (or from the optional `STYLE_SAMPLE.md` override). The next chapter's packet loads it back with soft metadata validation (mismatched blueprint identity is silently dropped).

Experimental Wave 5 work such as scene-by-scene drafting, editing passes, and act review is deferred and not active in the main pipeline.

## Quick Start

If `.env` is configured and `STORY_BLUEPRINT.md` is ready:

```bash
npm install
npm run compile:blueprint
npm run chapter -- --chapter 1 --estimate-cost
npm run chapter -- --chapter 1 --packet-only
npm run chapter -- --chapter 1
```

Useful day-to-day commands:

```bash
npm run chapter -- --help
npm run smoke
npm test
npm run typecheck
```

## Requirements

- Node.js `>=20`
- npm
- OpenAI API access
- Anthropic API access

## Key Project Files

- `STORY_BLUEPRINT.md`: active blueprint used by the engine
- `STORY_BLUEPRINT_TEMPLATE.md`: preserved blank template
- `.env`: local runtime configuration
- `AGENTS.md`: persistent agent context for project structure and invariants
- `.cursor/rules/`: scoped Cursor rules that keep future work aligned with current contracts
- `chapters/`: published chapter output
- `artifacts/`: disposable runtime artifacts, checkpoints, caches, memory, and status files
- `src/index.ts`: CLI entrypoint
- `src/pipeline/run-chapter.ts`: orchestration
- `src/pipeline/generate-spec.ts`: spec loop and critique gating
- `src/pipeline/judge-draft.ts`: 15-dimension literary judge
- `src/pipeline/estimate-cost.ts`: pre-run budgeting estimate
- `src/validators/index.ts`: deterministic validator entrypoint

## Environment Variables

The CLI loads `.env` automatically with `import "dotenv/config"`.

Required:

```env
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

Optional model overrides:

```env
OPENAI_MODEL_GPT55=gpt-5.5
ANTHROPIC_MODEL_OPUS47=claude-opus-4-7
```

Optional pricing env vars for cost estimates and summaries:

```env
OPENAI_GPT55_INPUT_COST_PER_1M=...
OPENAI_GPT55_OUTPUT_COST_PER_1M=...
ANTHROPIC_OPUS47_INPUT_COST_PER_1M=...
ANTHROPIC_OPUS47_OUTPUT_COST_PER_1M=...
```

Legacy `OPENAI_MODEL_GPT54`, `ANTHROPIC_MODEL_OPUS46`, and matching pricing env vars are still accepted so older local `.env` files keep working.

Optional root override:

```env
NOVEL_CREATOR_ROOT=/absolute/path/to/project-root
```

If `NOVEL_CREATOR_ROOT` is not set, the runtime uses the current working directory.

## Models And Quality Profiles

Current defaults:

- OpenAI planning/judging/audit model: `gpt-5.5`
- Anthropic drafting/revision/fix model: `claude-opus-4-7`
- Default quality profile: `max`

Quality profiles:

| Profile | Judge Pass | Pairwise Tolerance | Max Literary Retries | Max Fix Attempts | Spec Critique Default | Skip Revision |
| --- | --- | --- | --- | --- | --- | --- |
| `max` | `86` | `3` | `2` | `3` | Always runs unless `--skip-spec-critique` and not required | `93` |
| `standard` | `80` | `4` | `1` | `1` | Only when high-risk or escalated | Disabled |
| `rerun` | `78` | `5` | `0` | `1` | Only when high-risk or escalated | Disabled |

Notes:

- `--skip-spec-critique` suppresses only optional critique. High-risk or escalated critique still runs.
- Skip-revision only applies when the first draft already passes threshold and carries no blocking review signals.
- Literary retries only run after selection when the chosen chapter still fails the literary threshold.

## Top-Level Scripts

```bash
npm run build
npm run typecheck
npm test
npm run compile:blueprint
npm run smoke
npm run chapter -- --help
```

What they do:

- `npm run build`: compile TypeScript in `src/`
- `npm run typecheck`: typecheck `src/` and `tests/`
- `npm test`: run the automated test suite
- `npm run compile:blueprint`: parse, validate, compile, and cache the active blueprint
- `npm run smoke`: run the full deterministic smoke pipeline
- `npm run chapter -- ...`: main CLI entrypoint for live, partial, rerun, or estimate-only runs

## Main Commands

### Validate Blueprint

```bash
npm run compile:blueprint
```

Writes:

- `artifacts/blueprint/compiled-blueprint.json`
- `artifacts/blueprint/genre-contract.json`
- `artifacts/blueprint/chapter-functions.json`

### Estimate Chapter Cost

```bash
npm run chapter -- --chapter 1 --estimate-cost
```

Writes a pre-run token and cost estimate without calling providers.

Important caveats:

- It is a budgeting aid, not an exact mirror of the eventual `cost-summary`.
- It uses the real compiled packet plus representative downstream smoke fixtures to size later-stage inputs.
- It annotates conditional stages such as optional critique, skip-revision stages, literary retry stages, localized re-audit stages, fix-loop stages, post-fix judge stages, and post-fix literary rescue stages.
- The live `cost-summary` artifact is the source of truth for actual provider usage.

### Build Only The Chapter Packet

```bash
npm run chapter -- --chapter 1 --packet-only
```

Useful when you want to inspect assembled context before a full run.

### Stop After Approved Spec

```bash
npm run chapter -- --chapter 1 --spec-only
```

### Stop After Draft

```bash
npm run chapter -- --chapter 1 --draft-only
```

### Judge / Revise / Select From Existing Draft

```bash
npm run chapter -- --chapter 1 --judge-only
```

Runs the first judge and then either the skip-revision fast path or the full revision/revision-judge/selection path, followed by capped literary retries if the selected chapter still fails threshold.

### Audit / Fix From Existing Selected Chapter

```bash
npm run chapter -- --chapter 1 --audit-only
```

### Full Chapter Run

```bash
npm run chapter -- --chapter 1
```

Publishes only if the selected prose clears literary quality and final audit gates.

## CLI Flags

```bash
npm run chapter -- --help
```

Supported flags:

- `--chapter <N>`: chapter number to run
- `--quality <max|standard|rerun>`: override quality profile
- `--packet-only`: stop after chapter packet generation
- `--spec-only`: stop after approved spec generation
- `--draft-only`: stop after draft generation
- `--judge-only`: run judge, optional revision path, selection, and capped literary retries using existing draft artifacts
- `--audit-only`: run memory, audit, and fix loop using existing selected artifacts
- `--rerun-from <packet|spec|draft|judge|memory|audit>`: resume from a checkpointed stage
- `--estimate-cost`: write a pre-run token/cost estimate only
- `--compile-blueprint`: compile blueprint only
- `--smoke`: run the built-in deterministic smoke fixture
- `--blueprint <path>`: use an alternate blueprint file
- `--skip-spec-critique`: skip optional Opus spec critique; required critique still runs
- `--no-genre-ai`: skip GPT genre refinement and stay deterministic for genre controls
- `--help`: show CLI help

## Rerun Modes

The engine checkpoints artifacts by stage so you can reuse earlier work.

Examples:

```bash
npm run chapter -- --chapter 1 --rerun-from judge
npm run chapter -- --chapter 1 --rerun-from audit
npm run chapter -- --chapter 1 --judge-only
npm run chapter -- --chapter 1 --audit-only
```

Rerun stages:

- `packet`
- `spec`
- `draft`
- `judge`
- `memory`
- `audit`

The runtime validates artifact metadata on reuse, so stale artifacts from a different blueprint hash, blueprint version, chapter number, or quality profile fail fast instead of being mixed silently into a run.

## Smoke Mode

Smoke mode runs the full architecture against a built-in deterministic fixture blueprint and stand-in model stages.

```bash
npm run smoke
```

or

```bash
npm run chapter -- --smoke
```

Smoke mode is useful for:

- validating the full pipeline without provider spend
- checking rerun behavior
- verifying artifact generation and stage naming
- calibrating prompts, validators, thresholds, and estimate-stage coverage

## Validators And Audit

Deterministic validators run before the final audit result is finalized and are merged into the factual audit artifact.

Current validator coverage includes:

- chapter word band
- placeholder/meta text
- mandatory beat presence
- dropped unresolved threads
- knowledge boundary violations
- entity consistency
- repetition and duplicate paragraphs
- filter-word density
- paragraph distribution
- dialogue tag variety
- prose-level knowledge leaks

The final audit remains model-based, but deterministic findings are treated as first-class input.

## Published Output And Artifacts

Published chapters:

- `chapters/chapter-N.md`

Blueprint and cache artifacts:

- `artifacts/blueprint/compiled-blueprint.json`
- `artifacts/blueprint/genre-contract.json`
- `artifacts/blueprint/chapter-functions.json`
- `artifacts/blueprint/voice-target.json` (Phase 1 voice fingerprint, refreshed after each publish)
- `artifacts/cache/blueprints/<blueprint-hash>/...`

Optional author-supplied override (gitignored):

- `STYLE_SAMPLE.md` — when present at the project root, this prose takes precedence over the auto-derived voice fingerprint. Remove it to fall back to derived voice from your published chapters.

Chapter artifacts:

- `artifacts/chapters/chapter-N-packet.json`
- `artifacts/chapters/chapter-N-spec.json`
- `artifacts/chapters/chapter-N-self-red-team-report.json`
- `artifacts/chapters/chapter-N-spec-critique.json` when critique runs
- `artifacts/chapters/chapter-N-approved-spec.json`
- `artifacts/chapters/chapter-N-draft.json`
- `artifacts/chapters/chapter-N-draft-review.json`
- `artifacts/chapters/chapter-N-revised-draft.json` when revision runs
- `artifacts/chapters/chapter-N-revised-review.json` when revision runs
- `artifacts/chapters/chapter-N-selection.json`
- `artifacts/chapters/chapter-N-selected.json` including `literaryRetries` metadata when rescue retries run
- `artifacts/chapters/chapter-N-review.json`
- `artifacts/chapters/chapter-N-polish-plan.json` and `chapter-N-polish-diff.json` (Phase 1 polish pass; `max` profile only)
- `artifacts/chapters/chapter-N-polished-selected.json` when polish patches apply
- `artifacts/chapters/chapter-N-polish-rejudge.json` when polish-pass rejudges merged prose (separate file from the per-candidate `draft-review` / `revised-review` artifacts)
- `artifacts/chapters/chapter-N-tournament-opening.json`, `chapter-N-tournament-ending.json`, `chapter-N-tournament-title.json`, `chapter-N-tournament-merged.json` (Phase 1 opening/ending tournament; `max` profile only)
- `artifacts/chapters/chapter-N-tournament-rejudge.json` when the tournament rejudges merged prose (separate file)
- `artifacts/chapters/chapter-N-reader-sim.json` (Phase 1 reader simulation, advisory; `max` profile only)
- `artifacts/chapters/chapter-N-delta.json`
- `artifacts/chapters/chapter-N-validators.json`
- `artifacts/chapters/chapter-N-final-audit.json`
- `artifacts/chapters/chapter-N-fix-attempt-N.json` when the fix loop runs
- `artifacts/chapters/chapter-N-cost-estimate.json`
- `artifacts/chapters/chapter-N-cost-summary.json`
- `artifacts/chapters/chapter-N-status.json`

Rolling memory:

- `artifacts/memory/after-chapter-N.json`

Smoke fixture output:

- `artifacts/smoke/smoke-blueprint.md`

`artifacts/` is runtime output. It is safe to clear when you want a fresh generation pass.

## Emotional State And Memory Surfaces

Waves 1-4 expanded the continuity model beyond a simple summary string.

Important runtime surfaces now include:

- scene-level `emotionalArc`, `sensoryAnchor`, and `dialogueStrategy` in chapter specs
- `characterEmotionalStates` in chapter deltas
- `emotionalStates` in rolling memory
- per-character `characterStates` in `nextChapterOpeningHandoff`
- active character voice cards with `activeTraits`, `dialogueHabits`, `tabooNotes`, and `updatedFromChapter`

## Pipeline Statuses And Exit Codes

Success:

- `SUCCESS`

Blocked states:

- `BLOCKED_BLUEPRINT_UNDERSPECIFIED`
- `BLOCKED_BUDGET`
- `BLOCKED_QUALITY`
- `BLOCKED_RUNTIME_CONFIGURATION`
- `BLOCKED_PROVIDER_FAILURE`
- `BLOCKED_AUDIT_FIX_LOOP_EXHAUSTED`

Exit behavior:

- blocked pipeline outcomes exit with code `2`
- unexpected CLI/runtime errors exit with code `1`

## Recommended First Live Run

1. Validate the blueprint.

```bash
npm run compile:blueprint
```

2. Estimate spend.

```bash
npm run chapter -- --chapter 1 --estimate-cost
```

3. Inspect the packet if desired.

```bash
npm run chapter -- --chapter 1 --packet-only
```

4. Run the full chapter.

```bash
npm run chapter -- --chapter 1
```

Lower-friction first pass:

```bash
npm run chapter -- --chapter 1 --quality rerun --no-genre-ai
```

Strongest default pass:

```bash
npm run chapter -- --chapter 1 --quality max
```

## Troubleshooting

If blueprint compilation fails:

- check section names against `STORY_BLUEPRINT_TEMPLATE.md`
- remove placeholders like `Replace this with...`
- ensure chapter numbers are sequential
- ensure every `Active Cast` name exists in `Character Architecture`

If a live run fails immediately:

- verify `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`
- verify model override names match the runtime:
  - `OPENAI_MODEL_GPT55`
  - `ANTHROPIC_MODEL_OPUS47`

If a rerun fails:

- a reused artifact likely does not match the current blueprint hash, version, chapter number, or quality profile
- rerun from an earlier stage or clear outdated artifacts

If an estimate and a real run differ:

- the estimate is heuristic and stages may be conditional
- check the written stage notes in `chapter-N-cost-estimate.json`
- use `chapter-N-cost-summary.json` for actual provider usage after a live run

## Typical Operator Flow

For day-to-day work:

```bash
npm run compile:blueprint
npm run chapter -- --chapter 1 --estimate-cost
npm run chapter -- --chapter 1 --packet-only
npm run chapter -- --chapter 1
```

Then continue:

```bash
npm run chapter -- --chapter 2
npm run chapter -- --chapter 3
```

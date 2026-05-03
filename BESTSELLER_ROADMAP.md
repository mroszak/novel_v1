# Bestseller Roadmap

> **v2 status (2026).** This document is now historical context for v2 of the engine. The v2 build collapsed and reshaped the original 4-phase plan into the single canonical pipeline that now ships in this repo. Read this for the intent and rationale behind individual items; read `README.md`, `AGENTS.md`, and `docs/voice-grit-spec.md` for what actually runs today.
>
> What shipped to v2 canon:
>
> - **Item 16 (Voice grit pass)** shipped. Canonical contract lives at `docs/voice-grit-spec.md`. Implemented by `src/pipeline/voice-grit-pass.ts`. Always advisory + fail-soft.
> - **Continuity foundation** shipped. The `## Continuity Manifest` blueprint section, the parser, the deterministic compile, the `ContinuityActiveSlice` packet field, the post-publish `update-continuity-state.ts`, and the continuity-manifest validators are all live.
> - **Market Promise** shipped. The `## Market Promise` blueprint section drives the spec, draft, judge, and audit prompts — including the chapter-function-aware reader job ("opening = make the premise irresistible", etc.).
> - **Author brief** shipped. One cached model call per blueprint; deterministic fallback when no credentials.
> - **Anti-committee judge + bestseller question** shipped in `judge-draft.ts`.
> - **Opening + ending tournament** simplified to 1 candidate per zone (no title generation, no separate rejudge stage). Permanent v2 feature.
>
> What dropped:
>
> - **Polish-pass** removed entirely. The mid-chapter polish zones are no longer rewritten.
> - **Reader-simulation** removed entirely. Fold it back in only if Phase 9 acceptance testing surfaces a clear page-turn gap.
> - **Quality profiles** (`max` / `standard` / `rerun`) removed entirely. One canonical pipeline, one `qualitySettings` block in `src/config.ts`.
> - **Title-candidate tournament** removed. The chapter title comes from the spec.
> - **Tournament rejudge stage** collapsed. The 1-candidate compare is itself the quality gate.
> - **Literary retry loop** + **post-fix literary rescue** removed. Continuity-fix loop capped at 1 attempt.
> - **`--quality` CLI flag** and **`Default Quality Profile` blueprint metadata** removed.
>
> What's deferred:
>
> - Reader-simulation (advisory, ~$0.30/chapter) is reintroducible if Phase 9 testing shows a page-turn observability gap.
> - Future "bestseller" gating that promotes voice-grit and reader-job adherence to hard blockers — not active in v2.
>
> The remainder of this file is the original 4-phase plan. Treat it as design rationale, not as a description of the running engine.

---

A 4-phase plan to evolve the Novel Creator GPT pipeline from a high-quality chapter generator into a **reader-addiction engine** capable of producing commercial-masterpiece-tier output, while preserving the existing drop-in-blueprint operator workflow.

This document is the canonical reference for the 15 planned upgrades, their scope, build order, fail-soft behavior, and acceptance criteria.

---

## Purpose

Today's pipeline (blueprint → spec loop → draft → judge → revise → select → audit) produces solid upper-mid commercial prose. The published chapters of `The Deep Hotel` demonstrate disciplined POV, subtext-laden dialogue, and motif evolution. The remaining gap to "commercial masterpiece" tier is **architectural**, not prose-level:

- The engine optimizes for **craft quality**, not **reader compulsion**.
- Continuity is tracked, but **reader-curiosity loops** are not.
- Chapters are judged in isolation, with no **macro tension architecture**.
- Voice is consistent across chapters, but lacks a **distinctive authorial signature**.
- High-leverage real estate (chapter openings, paragraph endings, scene exits) gets the same care as average prose.

The 15 items below address these gaps.

---

## Design Principles

These constraints apply to every item in the roadmap:

1. **Fail-soft.** If any new stage fails to plan, apply, validate, or re-judge — or regresses an existing artifact — downstream consumes the previous artifact and the chapter publishes normally. The run is **not blocked** in Phases 1-3. Only `bestseller` mode (Phase 4) converts these into hard gates.
2. **Zero new authoring burden.** The user provides only `STORY_BLUEPRINT.md`. No new env vars, no new dependencies, no blueprint-format changes, no required user-authored files.
3. **Existing operator workflow preserved.** `npm run compile:blueprint && npm run chapter -- --chapter N` works identically before and after every phase.
4. **Published chapters are immutable.** No item retroactively rewrites `chapters/*.md`. Lessons feed forward into the next chapter's spec, not backward into prose.
5. **Artifact contract preserved.** Every new stage writes `ArtifactEnvelope<T>` with the standard metadata (`artifactType`, `blueprintHash`, `blueprintVersion`, `chapterNumber`, `qualityProfile`).
6. **Cost transparency.** Every new stage is annotated in `estimate-cost.ts` so operators see the full per-chapter spend before running.

---

## Operator Workflow

Unchanged before and after the full roadmap ships:

```bash
npm run compile:blueprint
npm run chapter -- --chapter 1
```

After Phase 4 the only new optional flag is `--quality bestseller`. Default remains `--quality max`.

---

## Status Tracker

| # | Item | Phase | Status |
|---|---|---|---|
| 1 | Polish pass | 1 | Shipped (advisory, fail-soft) |
| 2 | Reader simulation | 1 | Shipped (advisory, fail-soft) |
| 3a | Voice calibration — draft-context | 1 | Shipped (deterministic local extraction) |
| 3b | Voice calibration — judge dimension | 2 | Not started |
| 4 | Opening/Ending tournament | 1 | Shipped (advisory, fail-soft) |
| 5 | Compulsion-loop ledger | 2 | Not started |
| 6 | Commercial promise judge | 2 | Not started |
| 7 | Tension-curve artifact | 2 | Not started |
| 8 | Act-Level Editor | 2 | Not started |
| 9 | Motif evolution engine | 2 | Not started |
| 10 | Scene Doctor | 3 | Not started |
| 11 | Highlight prediction | 3 | Not started |
| 12 | Scared-author critique | 3 | Not started |
| 13 | Cold-open hardened audit | 3 | Not started |
| 14 | Iconic chapter-title generation | 3 | Not started |
| 15 | Bestseller Mode profile | 4 | Not started |
| 16 | Voice grit pass | 3 | Not started (designed) |

---

# Phase 1 — Foundations

Goal: ship four additive, fail-soft stages that produce a visibly noticeable lift on the next chapter generated, with zero risk to current behavior. All four are mutually independent and can land in a single PR.

---

## Item 1 — Polish pass

**Goal.** A surgical post-selection pass that improves the highest-leverage prose without rewriting the chapter, with auto-revert on regression.

**Why it matters.** The last sentence of every paragraph and the lead-out before every scene break are read 3-10× more often than the average sentence (skimmer eye-tracking). Lifting their quality lifts perceived quality of the whole chapter.

**Pipeline placement.**

```
selection → selected → polish-plan → polish-apply → polish-validate → polish-rejudge → delta → memory → audit
```

**Sub-stages.**

- `polish-plan` (Anthropic Opus). Reads `selected` prose, voice-target, style rules, anti-patterns, motifs. Returns a structured patch list. Each patch carries `targetSpan`, `originalText`, `proposedText`, `rationale`, `confidence` (0-1).
- `polish-apply` (deterministic). Applies only patches with `confidence >= threshold` (default 0.7) to allowed zones. Pure code, no model call.
- `polish-validate`. Re-runs existing validators on polished prose.
- `polish-rejudge` (OpenAI focused literary check). Compares overall score against pre-polish review. If score regresses by more than 2 points or any blocking signal appears → revert.

**Touched zones (v1, exhaustive).**

- Mid-chapter paragraph-end sentences only.
- Scene-break lead-out sentences (the last sentence before each `---`).

**Protected zones (reserved for item 4).**

- Chapter opening — first ~200 words / opening paragraph.
- Chapter ending — final paragraph.
- Chapter title.

**Artifacts.**

- `artifacts/chapters/chapter-N-polish-plan.json`
- `artifacts/chapters/chapter-N-polished-selected.json`
- `artifacts/chapters/chapter-N-polish-diff.json`

**Touch surface.**

- New: `src/pipeline/polish-pass.ts`
- New: stage profiles in `src/config.ts` (`polishPlan`, `polishRejudge`)
- New: types in `src/types/index.ts` (`PolishPlan`, `PolishedSelected`, `PolishDiff`)
- Modify: `src/pipeline/run-chapter.ts` (insert stages between `selected` and `chapter-delta`)
- Modify: `src/pipeline/estimate-cost.ts` (annotate new conditional stages)
- Modify: `src/pipeline/stage-utils.ts` (artifact path helpers)
- Tests: `tests/polish-pass.test.ts`, smoke fixtures in `src/pipeline/smoke-helpers.ts`

**Fail-soft behavior.**

| Failure point | Action |
|---|---|
| `polish-plan` errors / returns no patches | Skip apply, downstream uses `selected` |
| `polish-apply` fails (all patches low confidence or invalid zones) | Skip, downstream uses `selected` |
| `polish-validate` fails | Revert to `selected` |
| `polish-rejudge` regresses >2 points or blocks | Revert to `selected` |

In every failure case, the run continues, the chapter publishes, and a `reason` field is written to `polish-diff.json` for diagnostics.

**Acceptance criteria.**

- Smoke run produces `polished-selected.json` with deterministic content.
- Live chapter run shows polished spans in `polish-diff.json` with non-empty rationales.
- Forced regression test (mock judge returning low score) triggers revert and chapter publishes original `selected`.
- Zero existing tests fail.

**Cost impact.** ~+$0.40-1.00 per chapter at `max` profile.

**Dependencies.** None. (Voice calibration improves polish quality but isn't required.)

---

## Item 2 — Reader simulation

**Goal.** Catch "competent but skimmable" prose that the literary judge cannot detect.

**Why it matters.** Editors notice quality. Readers notice **wanting to skip**. Those are different signals.

**Pipeline placement.** New stage that runs on the **final enhanced prose** — after polish-pass and opening/ending tournament have both either applied changes or fallen back to `selected` per fail-soft. Critical: running on raw `selected` would let polish/tournament-introduced issues escape reader feedback, and `flaggedPassages` could point to text that no longer exists. Cannot be parallelized with polish/tournament for this reason.

**Personas (3).**

- **Airport reader** — wants forward motion, clarity, efficient prose.
- **Book-club reader** — wants emotional resonance, character truth, conversation-worthy themes.
- **Genre obsessive** — wants tradecraft accuracy, trope-aware execution, signature moves.

**Per-persona scores.** All 0-100.

- `skimRisk` — where did I want to skip?
- `confusionRisk` — where did I lose track?
- `turnPull` — would I turn the page right now?
- `shareScore` — would I text a friend about this?

Plus `flaggedPassages: { excerpt, reason, persona }[]`.

**Artifact.** `artifacts/chapters/chapter-N-reader-sim.json`

**Touch surface.**

- New: `src/pipeline/reader-simulation.ts`
- New: stage profile in `src/config.ts` (`readerSimulation`)
- New: types in `src/types/index.ts` (`ReaderSimulation`, `ReaderPersonaReview`)
- Modify: `src/pipeline/run-chapter.ts` (insert after `selected`)
- Modify: `src/pipeline/compile-chapter-packet.ts` (load previous chapter's reader-sim as advisory context for next spec)
- Modify: `src/pipeline/estimate-cost.ts`
- Tests + smoke fixtures.

**Fail-soft behavior.** Failure → skip stage, no impact on publishing. Future-chapter advisory simply unavailable.

**Status across profiles.**

- `max`: advisory (always runs, never blocks)
- `standard`/`rerun`: opt-in via flag (future)
- `bestseller` (Phase 4): hard gate — `turnPull < 70` averaged across personas blocks

**Acceptance criteria.**

- Smoke produces deterministic 3-persona output.
- Live chapter run produces non-empty `flaggedPassages`.
- Next chapter's spec stage receives the advisory context when available.

**Cost impact.** ~+$0.30-0.80 per chapter at `max`.

**Dependencies.** None.

---

## Item 3 — Voice calibration

**Goal.** Lock in a recognizable authorial voice signature that compounds across chapters.

**Why it matters.** The current pipeline ensures voice **consistency** but not voice **identity**. Every Lee Child novel sounds like Lee Child; every Tana French novel sounds like Tana French. This stage establishes that signature and enforces it.

**Scope split (de-risked into two phases).**

- **Item 3a — Phase 1 (low risk).** Fingerprint extraction + voice-target.json + feed into draft system prompt. No judge schema changes. No scoring changes. Drafting becomes voice-aware; everything downstream behaves as today.
- **Item 3b — Deferred to Phase 2 (medium risk).** Add `voiceSignature` as a 16th scored judge dimension. Touches `judge-draft.ts` schema (`additionalProperties: false` → must include the new field), `judgeWeights` re-normalization, smoke fixtures, and `calculateOverallScore` behavior. Shipped only after the draft-context approach has produced enough chapters to set realistic thresholds.

The remainder of this item describes the combined eventual state. Item 3a alone is what ships in Phase 1.

**Sourcing strategy (auto-derive default + optional override).**

- **Default — auto-derive from your own published chapters.** After chapter 1 publishes, the engine extracts a voice fingerprint from your prose. Chapter 2+ uses it as a constraint. Self-bootstrapping. Zero authoring burden.
- **Chapter 1.** No prior prose exists, so engine falls back to current behavior (style rules + comparables in blueprint). Same as today.
- **Optional override.** If you ever want to override your own voice (e.g., calibrate to a different style than your published chapters), drop in `STYLE_SAMPLE.md` at project root and it takes precedence. `.gitignored` by default.

**Extracted fingerprint includes.**

- Sentence-length distribution (mean, std dev, distribution shape).
- Paragraph rhythm (paragraph-length distribution, paragraph-end cadence patterns).
- Signature lexicon (high-frequency content words / phrases unique to the voice).
- Recurring metaphor families.
- Dialogue-tag conventions (frequency, variety).
- POV interiority density (interior thoughts per 1000 words).

**Artifacts.**

- `artifacts/blueprint/voice-target.json` — the active voice fingerprint
- `STYLE_SAMPLE.md` (optional, gitignored) — user override

**Touch surface.**

- New: `src/blueprint/extract-voice-fingerprint.ts`
- New: stage profile in `src/config.ts` (`voiceCalibration`)
- New: types in `src/types/index.ts` (`VoiceTarget`, `VoiceFingerprint`)
- Modify: `src/pipeline/compile-chapter-packet.ts` (load voice-target into packet)
- Modify: `src/pipeline/generate-draft.ts` (feed voice-target into system prompt)
- Modify: `src/pipeline/judge-draft.ts` (add `voiceSignature` as a 16th scored dimension)
- Modify: `.gitignore` (add `STYLE_SAMPLE.md`)
- Modify: `src/pipeline/run-chapter.ts` (extract voice-target after publish)
- Tests + smoke fixtures.

**Fail-soft behavior.**

- No prior chapters AND no `STYLE_SAMPLE.md` → engine runs as today (current behavior).
- Voice extraction fails → skip update, keep last successful target.
- Voice judge dimension fails to score → omit from overall score (recompute from remaining 15 dimensions).

**Acceptance criteria.**

- After chapter 1 publishes, `voice-target.json` exists with non-empty fingerprint.
- Chapter 2 draft prompt includes voice-target context.
- Chapter 2 judge produces a `voiceSignature` score.
- Adding `STYLE_SAMPLE.md` causes engine to use it instead of derived target.
- Removing `STYLE_SAMPLE.md` causes engine to fall back to derived target.

**Cost impact.** ~$0 per chapter — Phase 1 ships voice calibration as a deterministic local extraction (no model call). Annotated in `estimate-cost.ts` as a near-zero stage so operators still see the surface in their per-chapter budget. (Item 3b in Phase 2 will introduce a model call when the voice judge dimension is added.)

**Dependencies.** None for chapter 1; needs at least one published chapter for chapter 2+ benefit.

---

## Item 4 — Opening/Ending tournament

**Goal.** Generate multiple candidates for the highest-leverage prose spans and pairwise-select the most irresistible.

**Why it matters.** Commercial fiction lives or dies on entrances and exits. Every chapter opening re-sells the book; every chapter ending sells the page-turn. These spans deserve more attempts than the rest of the prose.

**Sequencing constraint.** Build only after polish-pass has shipped and proven stable in production. Both stages modify post-selection prose using zone-based merging; landing them simultaneously compounds merge-bug risk. Polish-pass bakes first, then tournament reuses its merge/revert pattern.

**Owned zones (mutually exclusive with polish-pass).**

- Chapter opening — first ~200 words / opening paragraph.
- Chapter ending — final paragraph.
- Chapter title.

**Pipeline placement.** Runs after polish-pass (or after `selected` if polish reverted). Replaces only the owned zones in the polished/selected prose.

**Process per zone.**

1. Generate 3 candidates (Anthropic Opus, varied sampling).
2. Pairwise-rank using existing `pairwise-selection` infrastructure.
3. Replace the corresponding span in the prose.
4. Validate the merged result (existing validators).
5. Re-judge focused on the affected spans only.

**Artifacts.**

- `artifacts/chapters/chapter-N-tournament-opening.json` (candidates + rankings)
- `artifacts/chapters/chapter-N-tournament-ending.json`
- `artifacts/chapters/chapter-N-tournament-title.json`
- `artifacts/chapters/chapter-N-tournament-merged.json` (final prose)

**Touch surface.**

- New: `src/pipeline/opening-ending-tournament.ts`
- New: stage profiles in `src/config.ts` (`openingCandidate`, `endingCandidate`, `titleCandidate`, `tournamentSelection`)
- New: types in `src/types/index.ts` (`TournamentCandidate`, `TournamentResult`)
- Modify: `src/pipeline/run-chapter.ts` (insert after polish-pass)
- Modify: `src/pipeline/estimate-cost.ts`
- Reuse: `src/pipeline/select-draft.ts` (existing pairwise infrastructure)
- Tests + smoke fixtures.

**Fail-soft behavior.**

- Any candidate generation fails → skip that zone, keep current text.
- Tournament selection fails → keep current text.
- Validation fails on merged result → revert to pre-tournament text.

**Acceptance criteria.**

- Smoke produces deterministic candidates and selections per zone.
- Live chapter run produces 3 candidates per owned zone.
- Polish-pass and tournament never touch overlapping spans (verified by test).
- Failure of one zone (e.g., title) does not block other zones (e.g., ending).

**Cost impact.** ~+$1.50-3.00 per chapter (3 zones × 3 candidates each).

**Dependencies.** Reuses existing `pairwise-selection` machinery from `src/pipeline/select-draft.ts`.

---

## Phase 1 Acceptance

Phase 1 is "done" when:

- [ ] All 4 items shipped across **separate sequential PRs**, fail-soft.
- [ ] One full live chapter run completes successfully with all 4 stages executing.
- [ ] Disabling any one stage (mock failure) results in chapter still publishing.
- [ ] Existing test suite passes.
- [ ] `--estimate-cost` reflects new stages.
- [ ] No changes to operator workflow (`npm run chapter -- --chapter N` unchanged).

**Phase 1 PR sequence (one item per PR, sequential, each must ship and prove stable before the next):**

1. **PR 1.1** — Polish pass. Establishes the post-selection enhancement pattern (plan → apply → validate → re-judge → fail-soft revert). Smaller-scope merge logic that tournament will later reuse.
2. **PR 1.2** — Reader simulation. Runs on the final enhanced prose (after polish). Advisory only.
3. **PR 1.3** — Voice calibration *draft-context only* (Item 3a). Fingerprint extraction + draft prompt context. **Item 3b (judge dimension) is deferred to Phase 2** to avoid changing the 15-dimension scoring schema and weights in the same window as drafting changes.
4. **PR 1.4** — Opening/Ending tournament. Reuses polish's merge/revert pattern, owns the protected zones polish does not touch.

Rationale for splitting: Phase 1 touches `run-chapter.ts`, `compile-chapter-packet.ts`, `judge-draft.ts`, `generate-draft.ts`, `config.ts`, `types/index.ts`, plus 12+ new files. Bundling all four into one PR is technically safe (mutually independent + fail-soft) but practically un-reviewable.

Total Phase 1 cost impact across all 4 PRs: ~+$2.20-4.80 per chapter at `max`. (Voice calibration ships as a deterministic local extraction at no model cost; the original ~$0.10-0.30 line item was reserved for a model-driven extraction that proved unnecessary.)

---

# Phase 2 — Architectural Depth

Goal: ship the deep bestseller mechanisms — compulsion architecture, macro tension, commercial promise enforcement, multi-chapter editorial intelligence, and motif evolution. These items touch existing pipeline contracts and must each land as their own PR.

---

## Item 5 — Compulsion-loop ledger

**Goal.** Track open reader-curiosity loops across the whole book and require the spec to advance them deliberately.

**Why it matters.** Continuity (plot threads) is *what the writer owes the plot*. Compulsion (curiosity loops) is *what the writer owes the reader*. Bestsellers run 4-7 simultaneous "I need to know" loops at any moment, opening, partial-answering, and re-opening on a deliberate schedule. The current engine tracks the former and not the latter.

**Loop entity.**

```typescript
interface CompulsionLoop {
  id: string;
  question: string;            // "What is Eleanor hiding in the red-tabbed memo?"
  openedChapter: number;
  partialAnswers: { chapter: number; partial: string }[];
  plannedPayoffChapter: number | null;
  status: "open" | "partially-answered" | "closed";
  audience: "primary" | "secondary";  // primary loops are the book's core mysteries
}
```

**Touch surface (4 stages).**

- `src/blueprint/compile-blueprint.ts` — extract initial loops from chapter outline.
- `src/pipeline/compile-chapter-packet.ts` — **materialize active loops into the packet** so spec sees them. Critical: without this, spec cannot advance loops intentionally.
- `src/pipeline/generate-spec.ts` — spec must declare per-chapter which loops advance, partial-answer, or close.
- `src/pipeline/judge-draft.ts` — score `compulsionVelocity` (loops opened, partial-answered, closed in this chapter).
- `src/pipeline/build-rolling-memory.ts` — update loop state from chapter delta.

**Artifacts.**

- `artifacts/loops/loops-state.json` — current loop ledger
- `artifacts/loops/after-chapter-N.json` — loop snapshot per chapter

**Fail-soft behavior.** Failure to extract or update loops → continue with empty ledger; advisory in `max`.

**Acceptance criteria.**

- Initial loops extracted from `STORY_BLUEPRINT.md` chapter outline.
- Each chapter's spec stage declares loop changes.
- Each chapter's judge scores loop velocity.
- Loop ledger updates after each chapter.
- Bestseller mode (Phase 4) requires ≥1 loop opened or partial-answered per chapter.

**Cost impact.** ~+$0.40-0.80 per chapter (extra spec/judge context).

**Dependencies.** None. Should ship before items 6-9 because compulsion loops are the foundation of commercial promise judgment.

---

## Item 6 — Commercial promise judge

**Goal.** Score chapters on whether they fulfill the marketed book promise, not just whether they're well-written.

**Why it matters.** Bestsellers fail on promise-violation more than on prose. Reader trust is built or broken at the chapter-promise level: "Did this chapter make the book more like what I was promised?"

**Pipeline placement.** Post-selection advisory. Runs on the final enhanced prose alongside reader simulation. Note: `selected` already incorporates the literary judge's output through pairwise selection, so "parallel with literary judge" would be contradictory — the literary judge has already run by the time `selected` exists.

**Scored dimensions (0-100 each).**

- `promiseCompounded` — did this chapter advance or amplify the marketed story promise?
- `readerDebtOut` — how many open compulsion loops is the reader carrying out of this chapter? (Should be ≥3.)
- `recommendScore` — would the target reader text a friend about this?
- `genreContractFit` — does this match the genre's bestseller patterns specifically?

Plus `promiseGaps[]`, `recommendBlockers[]`.

**Artifact.** `artifacts/chapters/chapter-N-commercial-judge.json`

**Touch surface.**

- New: `src/pipeline/commercial-promise-judge.ts`
- New: stage profile in `src/config.ts` (`commercialPromiseJudge`)
- New: types in `src/types/index.ts`
- Modify: `src/pipeline/run-chapter.ts` (parallel with literary judge)
- Modify: `src/pipeline/estimate-cost.ts`

**Fail-soft behavior.** Failure → skip, advisory only.

**Status across profiles.**

- `max`: advisory.
- `bestseller`: hard gate weighted heavier than literary judge.

**Acceptance criteria.**

- Live chapter run produces commercial judge artifact with all 4 dimensions.
- Inputs include `storyPromise`, `marketPositioning`, compulsion-loops state.
- Bestseller mode treats `recommendScore < 70` as blocking.

**Cost impact.** ~+$0.50-1.00 per chapter.

**Dependencies.** Item 5 (compulsion loops) for the `readerDebtOut` dimension.

---

## Item 7 — Tension-curve artifact

**Goal.** Re-project the next 3 chapters' macro tension/emotional curve every 3 chapters, dynamically bending the arc rather than relying on the static blueprint.

**Why it matters.** The blueprint defines chapter obligations but not a *living* tension curve. Bestsellers bend a macro tension shape — false summits, midpoint reversals, dark night, "and then it gets worse" rhythms. A static blueprint cannot adapt to what's actually happening on the page.

**Process.** After every 3rd chapter publishes:

1. Read all published chapters' literary scores, reader-sim scores, commercial judge scores, loop velocity.
2. Project the ideal tension arc for the next 3 chapters relative to the book's overall act structure.
3. Write `artifacts/tension-curve.json` with per-chapter target tension level, target loop count, target emotional dwell.
4. Spec stage consumes this as required input for upcoming chapters.

**Artifact.** `artifacts/tension-curve.json`

**Touch surface.**

- New: `src/pipeline/project-tension-curve.ts`
- New: stage profile in `src/config.ts` (`tensionCurveProjection`)
- New: types in `src/types/index.ts`
- Modify: `src/pipeline/run-chapter.ts` (run after every 3rd chapter publishes)
- Modify: `src/pipeline/compile-chapter-packet.ts` (load curve into packet)
- Modify: `src/pipeline/generate-spec.ts` (must consume curve)

**Fail-soft behavior.** Failure → keep last successful curve. No curve → spec stage operates on blueprint defaults (current behavior).

**Acceptance criteria.**

- After chapter 3 publishes, `tension-curve.json` exists with projections for chapters 4-6.
- Chapter 4 spec stage references the curve.
- Forced failure of curve projection → chapter 4 still generates using current behavior.

**Cost impact.** ~+$0.20-0.50 per 3-chapter cycle.

**Dependencies.** Item 5 (loops), Item 6 (commercial judge) — for richer projection inputs.

---

## Item 8 — Act-Level Editor

**Goal.** Advisory editorial-board pass after structural milestones (ch 3, 6, 9, 12 in a 12-chapter book) checking sag, repetition, escalation, POV balance, and commercial momentum.

**Why it matters.** Single-chapter judging cannot detect macro-level problems: the same emotional beat repeating, a POV character being neglected, escalation flattening, the book becoming more correct but less addictive.

**Process.** After ch 3/6/9/12 publishes:

1. Read all published chapters in the act.
2. Run an editorial-board prompt evaluating: sag points, repetitive emotional beats, escalation curve, POV balance, commercial momentum trend, structural risks.
3. Write `artifacts/act-review/after-chapter-N.json`.
4. **Never rewrites published chapters.** Next chapter's spec stage **must** consume the most recent advisory.

**Artifact.** `artifacts/act-review/after-chapter-N.json`

**Touch surface.**

- New: `src/pipeline/act-level-editor.ts`
- New: stage profile in `src/config.ts` (`actLevelEditor`)
- New: types in `src/types/index.ts`
- Modify: `src/pipeline/run-chapter.ts` (run conditionally after milestone chapters)
- Modify: `src/pipeline/compile-chapter-packet.ts` (load most recent act-review)
- Modify: `src/pipeline/generate-spec.ts` (must consume act-review when present)

**Fail-soft behavior.** Failure → skip, no impact. Future spec simply doesn't have the advisory.

**Acceptance criteria.**

- After chapter 3 publishes, act-review artifact exists.
- Chapter 4 spec includes the act-review in its context.
- Act-review identifies at least 3 specific issues per pass when issues exist.

**Cost impact.** ~+$1.00-2.50 per milestone chapter (only 4 of every 12 chapters).

**Dependencies.** None.

---

## Item 9 — Motif evolution engine

**Goal.** Formalize the motif evolution that currently happens by accident in `The Deep Hotel` (e.g., the "counting" → "the counting is faster").

**Why it matters.** Motifs that evolve across chapters create the feeling of a book that means something. The pipeline already has a `motifBank` in the blueprint, but no motif **state machine**. Right now this is an emergent property of good prose. Make it deliberate.

**Process.**

1. Initial motif state seeded from blueprint `motifBank` after compile.
2. After each chapter delta extraction, update motif state: which motifs appeared, how they evolved, what the next required mutation is.
3. Spec stage must declare per-chapter motif handling: which motifs appear, in what evolved form, or which deliberately rest this chapter.
4. Judge scores motif execution.

**Motif entity.**

```typescript
interface MotifState {
  motif: string;                  // "the counting"
  firstAppearance: number | null; // chapter
  lastAppearance: number | null;
  currentForm: string;            // "rhythmic floor pulses, faster than ch 1"
  requiredNextMutation: string;   // "must escalate to audible across the structure"
  appearancesByChapter: { chapter: number; form: string }[];
}
```

**Artifact.** `artifacts/motifs/motifs-state.json`

**Touch surface.**

- New: `src/pipeline/track-motifs.ts`
- New: stage profile in `src/config.ts` (`motifTracking`)
- New: types in `src/types/index.ts`
- Modify: `src/pipeline/compile-blueprint.ts` (seed initial state)
- Modify: `src/pipeline/extract-chapter-delta.ts` (update motif appearances)
- Modify: `src/pipeline/generate-spec.ts` (consume + declare motif handling)
- Modify: `src/pipeline/judge-draft.ts` (score motif execution)

**Fail-soft behavior.** Failure → skip, no impact. Engine falls back to existing motif-bank-as-text behavior.

**Acceptance criteria.**

- After compile, motif state seeded from blueprint.
- After chapter 1 publishes, motif state shows which motifs actually appeared.
- Chapter 2 spec declares motif handling.
- Forced failure → chapter still generates with current behavior.

**Cost impact.** ~+$0.20-0.40 per chapter.

**Dependencies.** None.

---

## Phase 2 Acceptance

Phase 2 is "done" when:

- [ ] All 5 items shipped across separate PRs (item 5 first; 6-9 can be split or bundled by judgment).
- [ ] Compulsion loops, commercial judge, tension curve, act-review, and motif state all written and consumed by spec stage.
- [ ] Each item is fail-soft and chapter publishes on failure.
- [ ] Existing test suite passes.

**Suggested PR sequence within Phase 2:**

1. PR 2a: Item 5 (compulsion loops) — solo because of subsystem touch-surface
2. PR 2b: Item 6 (commercial promise judge)
3. PR 2c: Items 7+8+9 bundled (motif, tension curve, act-review — all advisory, all fail-soft)

Total Phase 2 cost impact: ~+$2.30-5.20 per chapter at `max`.

---

# Phase 3 — Surgical Micro-Craft

Goal: ship six small craft-tightening stages in a single bundled PR. Each is small, additive, fail-soft, and addresses a specific micro-craft gap.

---

## Item 10 — Scene Doctor

**Goal.** Audit each scene against goal/obstacle/turn/cost/exit at the prose level (not the spec level). Trigger surgical scene-only revision when a scene scores poorly.

**Why it matters.** The current spec already requires `objective`, `turn`, `exitCondition` per scene — but it's checked at the spec stage and easy to fake in the spec while the actual prose lacks the structure. This audits the actual drafted prose.

**Process.**

1. After `selected` is finalized, run scene-by-scene audit on the prose.
2. Each scene scored 0-5 on: goal clarity, obstacle weight, turn execution, cost escalation, exit necessity.
3. If any scene scores ≤3 average → trigger **surgical scene-only revision** (Anthropic Opus rewrites just that scene).
4. Re-validate, re-merge.

**Artifact.** `artifacts/chapters/chapter-N-scene-doctor.json`

**Touch surface.**

- New: `src/pipeline/scene-doctor.ts`
- New: stage profiles in `src/config.ts` (`sceneAudit`, `sceneRevision`)
- New: types in `src/types/index.ts`
- Modify: `src/pipeline/run-chapter.ts` (insert after `selected`, before polish)

**Fail-soft.** Failure → skip, downstream uses `selected`.

**Cost impact.** ~+$0.30-1.50 per chapter (depends on revisions triggered).

---

## Item 11 — Highlight prediction

**Goal.** Predict the 3-5 sentences a Kindle reader would highlight. Used as a literary-judge **signal** (peaks-per-chapter ≥3), not a hard gate.

**Why it matters.** Avoids forcing purple prose via quotas. Measures where the prose already sings.

**Artifact.** `artifacts/chapters/chapter-N-highlights.json`

**Touch surface.**

- New: `src/pipeline/predict-highlights.ts`
- Modify: `src/pipeline/judge-draft.ts` (consume as `peaksPerChapter` signal)

**Cost impact.** ~+$0.15 per chapter.

---

## Item 12 — Scared-author critique

**Goal.** Force a single ruthless prompt after the judge passes: *"You are the author at 3am, terrified this chapter is competent but forgettable. What would you tear up?"*

**Why it matters.** Politeness is the enemy of bestsellers. Forces a critique uncolored by editorial diplomacy.

**Process.** Runs after literary judge passes. If critique returns substantive issues (>3 specific concerns), force one targeted revision pass.

**Artifact.** `artifacts/chapters/chapter-N-scared-author.json`

**Touch surface.**

- New: `src/pipeline/scared-author-critique.ts`
- Modify: `src/pipeline/run-chapter.ts`

**Cost impact.** ~+$0.30-0.80 per chapter.

---

## Item 13 — Cold-open hardened audit

**Goal.** Chapter 1 only. Separate, harder judge on the first 500 words. Pass threshold ~92.

**Why it matters.** The first page sells the book. Deserves its own gate.

**Touch surface.**

- New: `src/pipeline/cold-open-audit.ts`
- Modify: `src/pipeline/run-chapter.ts` (chapter 1 only)

**Cost impact.** ~+$0.20 (one-time per book).

---

## Item 14 — Iconic chapter-title generation

**Goal.** Generate 3 candidate titles per chapter using the book's own motif lexicon. Judge for resonance. Pick winner.

**Why it matters.** Chapter titles are read 5-10× more often than the average sentence. Worth deliberate optimization.

**Note.** Bundles cleanly with Item 4 (Opening/Ending tournament) when both exist. If item 4 is already shipped, this becomes a sub-feature there rather than a standalone stage.

**Touch surface.**

- New: `src/pipeline/generate-chapter-title.ts` OR fold into existing `opening-ending-tournament.ts`
- Modify: `src/pipeline/run-chapter.ts`

**Cost impact.** ~+$0.20 per chapter.

---

## Item 16 — Voice grit pass

**Goal.** Surgical post-selection pass that removes AI tells (rhythmic balance, total semantic completeness, polished sentence symmetry) by injecting small, locally-earned textures from the book's own voice system, without changing plot or lowering quality.

**Why it matters.** The pipeline optimizes hard for craft quality, which makes finished chapters technically excellent and starting to read like it. Voice grit puts back the friction that distinguishes human prose from competent AI prose. Anchoring every edit to an `activeTrait` or `dialogueHabit` from the rolling memory keeps it from becoming a generic humanizer.

**Pipeline placement.** Critical — must run **before** polish-pass and the opening/ending tournament so they retain ownership of their reserved zones. Reader-simulation continues to see the final enhanced prose.

```
selected → voice-grit → polish → tournament → reader-sim
```

**Allowed texture menu (planner picks 0–6, locally earned only — menu, not checklist).**

1. `prosody-irregularity` — break a metronomic sentence run with one fragment or one earned long sentence.
2. `voice-tic` — surface one `activeTrait` or `dialogueHabit` from the POV character's voice card. `ticSource` is REQUIRED and must cite a real voice-card entry.
3. `interrupted-observation` — one trailing em-dash thought the POV doesn't finish processing. **Max one per chapter.**
4. `strategic-under-explanation` — delete 1–2 consecutive sentences that narrate what the prior beat already showed. **Max one patch of this type per chapter.**
5. `specificity-swap` — replace one abstract noun phrase with a hyper-specific concrete detail consistent with POV expertise.
6. `asymmetric-paragraph-weight` — split or merge a balanced paragraph where it serves emotional pressure.

**Hard constraints (validator-enforced).**

- Total patches: 0–6. Empty is a valid answer.
- Reserved zones blocked: chapter opening (~200 words), chapter ending (last paragraph), chapter title, paragraph-end sentences, scene-break leadout sentences. (Owned by polish/tournament.)
- Each `originalText` must appear verbatim exactly once in the chapter.
- Max 2 patches per scene.
- `tabooNote` is **excluded** from `ticSource` — taboos flow to the planner only as a "DO NOT SURFACE" constraint section.
- No new plot, info, character knowledge, or world facts. No typos, grammatical errors, or vocal hedges in narration.

**Rejudge atomicity (critical).** Rejudge runs **once** on the fully-patched prose. Score drop > 1pt or any new blocking review signal → **discard the entire batch**, downstream consumes pre-grit `selected`. No partial-patch publishing.

**Sub-stages.**

- `voice-grit-plan` (Anthropic Opus, small thinking budget). Returns 0–6 structured patches with `earnedJustification` naming the specific AI tell removed.
- `voice-grit-apply` (deterministic). Patch validator drops invalid patches first (zone overlap, exact-span miss, bad `ticSource`, count caps); survivors apply atomically to the prose.
- `voice-grit-validate` (deterministic). Re-runs existing prose validators on the patched prose.
- `voice-grit-rejudge` (own stage name in telemetry; model profile mirrors `literaryJudge`). Compares against pre-grit review, discards whole batch on regression.

**Artifacts.**

- `artifacts/chapters/chapter-N-voice-grit-plan.json`
- `artifacts/chapters/chapter-N-voice-grit-applied.json`
- `artifacts/chapters/chapter-N-voice-grit-rejudge.json`

**Touch surface.**

- New: `src/pipeline/voice-grit-pass.ts`
- New: stage profiles in `src/config.ts` (`voiceGritPlan`, `voiceGritRejudge` — distinct stage name even though it reuses `literaryJudge` model profile, so cost/usage stays readable)
- New: types in `src/types/index.ts` (`GritTexture`, `GritPatch`, `VoiceGritResult`)
- Modify: `src/pipeline/run-chapter.ts` (insert between `selected` and polish-pass, `max`-only)
- Modify: `src/pipeline/estimate-cost.ts`
- Tests: focused validator tests (zone overlap, tabooNote rejection, exact-span miss, count caps, ticSource validation) + one orchestration regression for fail-soft on rejudge regression
- Doc-sync: `AGENTS.md` and `.cursor/rules/pipeline-contract.mdc`

**Fail-soft behavior.**

| Failure point | Action |
|---|---|
| `voice-grit-plan` errors / returns empty patches | Skip, downstream uses `selected` |
| All patches rejected by validator | Skip, downstream uses `selected` |
| `voice-grit-validate` fails on patched prose | Discard, downstream uses `selected` |
| `voice-grit-rejudge` regresses >1pt or introduces blocking signal | Discard whole batch, downstream uses `selected` |
| No voice-target available (chapter 1 with no `STYLE_SAMPLE.md`, or extract/load fail-soft) | Skip, downstream uses `selected` (matches voice-cal behavior) |

**Status across profiles.**

- `max`: advisory (always runs when voice-target available, never blocks).
- `standard`/`rerun`: skipped entirely (matches existing Phase 1 stage gating).
- `bestseller` (Phase 4): potential promotion to `requiresVoiceGritPass: true` after Phase 1-3 advisory data shows reliable lift.

**Acceptance criteria.**

- Smoke produces deterministic empty-patch result.
- Live chapter run produces non-empty patches with `earnedJustification` strings naming specific AI tells removed.
- Forced rejudge regression triggers whole-batch discard; chapter publishes pre-grit `selected`.
- Validator rejects: tabooNote-as-tic, originalText not found / found multiple times, edit in reserved zone, voice-tic without ticSource, count caps exceeded.
- Polish-pass and tournament zones untouched (verified by test).

**Cost impact.** ~+$0.50–1.00 per chapter (one Anthropic plan call + one OpenAI rejudge call when patches survive validation).

**Dependencies.** Item 3a (voice calibration draft-context) for `voiceTarget` and voice cards. Item 1 (polish-pass) and Item 4 (tournament) for the reserved-zone definitions and fail-soft pattern reuse.

---

## Phase 3 Acceptance

Phase 3 is "done" when all 6 items ship in a single bundled PR, all fail-soft, all advisory in `max`, with eligible stages promoted to gates in `bestseller` mode.

Total Phase 3 cost impact: ~+$1.65-3.85 per chapter at `max`.

---

# Phase 4 — Bestseller Mode Profile

## Item 15 — Bestseller Mode

**Goal.** A new entry in `config.qualityProfiles` above `max` that activates Phase 1-3 stages as **hard gates** rather than advisory.

**Why ship last.** Otherwise it becomes a flag full of aspirational gates instead of proven machinery. By Phase 4, all stages exist and have run advisory under `max` long enough to set realistic thresholds.

**Profile definition.**

```typescript
bestseller: {
  judgePassThreshold: 90,         // up from 86
  pairwiseTolerance: 2,           // tighter than max's 3
  maxFixAttempts: 4,              // up from 3
  maxLiteraryRetryAttempts: 3,    // up from 2
  alwaysRunSpecCritique: true,
  skipRevisionThreshold: null,    // never skip

  // New gates (hard-blocking)
  reqReaderTurnPull: 70,
  reqCommercialRecommend: 70,
  reqLoopVelocity: 1,             // ≥1 loop opened or partial-answered
  reqHighlightPeaks: 3,
  requiresPolishPass: true,
  requiresOpeningEndingTournament: true,
  requiresSceneDoctor: true,
  requiresColdOpenAudit: true,    // chapter 1 only
}
```

**Touch surface.**

- Modify: `src/config.ts` (add `bestseller` entry)
- Modify: `src/types/index.ts` (add `"bestseller"` to `QualityProfile`)
- Modify: `src/index.ts` (CLI accepts `--quality bestseller`)
- Modify: `src/pipeline/run-chapter.ts` (route advisory→gate behavior based on profile)
- Modify: `src/pipeline/judge-draft.ts` (apply higher threshold)
- Modify: `src/pipeline/estimate-cost.ts` (annotate hard-gate retries)
- Modify: `README.md` (document bestseller mode)
- Tests for blocking behavior on each new gate.

**CLI usage.**

```bash
npm run chapter -- --chapter 1 --quality bestseller
```

**Acceptance criteria.**

- `--quality bestseller` activates the profile.
- All gates defined above block when threshold not met.
- Default behavior of `--quality max` is unchanged (Phase 1-3 stages still advisory).
- Cost estimate reflects hard-gate retry logic.

**Cost impact.** ~$15-40 per chapter typical, $50+ when retries pile up. 1.5-2.5× longer wall-time than `max`.

**Dependencies.** All of Phase 1-3 must be shipped and proven.

---

# Build Sequence

| PR | Phase | Items | Notes |
|---|---|---|---|
| 1 | 1 | 1 — polish pass | Solo. Establishes post-selection enhancement pattern. |
| 2 | 1 | 2 — reader simulation | Solo. Runs on final enhanced prose. |
| 3 | 1 | 3a — voice cal (draft-context only) | Solo. Item 3b (judge dimension) deferred. |
| 4 | 1 | 4 — opening/ending tournament | Solo. Only after polish has proven stable. |
| 5 | 2 | 5 — compulsion-loop ledger | Solo. Subsystem touching 4 stages. |
| 6 | 2 | 6 — commercial promise judge | Solo. Post-selection advisory. |
| 7 | 2 | 7, 8, 9 — tension curve, act editor, motif engine | Bundled. All advisory, all fail-soft. |
| 8 | 2 | 3b — voice judge dimension | Solo. Adds 16th scored dimension; touches schema, weights, smoke. |
| 9 | 3 | 10, 11, 12, 13, 14, 16 — micro-craft | Bundled. |
| 10 | 4 | 15 — bestseller mode profile | Solo. Ships last. |

**Total: 10 PRs, 16 items (17 with the voice-judge-dimension split).**

Each PR ships, gets one live chapter run for validation, then the next PR begins. Conservative cadence — favors clean reviews and easy rollback over speed. Phase 1 PR 1.1 alone (polish pass) should produce a visibly noticeable lift on the next chapter generated.

---

# Profile Comparison Matrix

| | `max` (current default) | `bestseller` (Phase 4) |
|---|---|---|
| **Optimizes for** | Literary craft + soundness | Reader addiction + signature + promise fulfillment |
| **Editor would say** | "This is well-written." | "I couldn't stop reading." |
| **Reader simulation** | Advisory | Hard gate (`turnPull ≥ 70`) |
| **Commercial promise judge** | Advisory | Hard gate, weighted heavier than literary |
| **Polish pass + tournament** | Run if confident | Required |
| **Voice grit pass** | Advisory (when voice-target available) | Could promote to required |
| **Compulsion-loop velocity** | Tracked | Enforced (≥1 per chapter) |
| **Highlight peaks per chapter** | Tracked (signal) | Required (≥3) |
| **Scared-author critique** | Skipped | Always run |
| **Cost per chapter (rough)** | ~$8-15 today / ~$13-23 after Phase 1-3 | ~$20-50 |
| **Chance of blocking** | Low | Higher |
| **Generation time** | Baseline | 1.5-2.5× longer |

**When to pick which.**

- `max` — literary fiction, character studies, slower books, or when you want lower cost / faster iteration.
- `bestseller` — commercial fiction targeting mass-market success. **The Deep Hotel fits here exactly.**

---

# Explicitly Dropped Ideas

These were considered and removed during design discussion. Recorded here so they don't get re-proposed.

- **Comp-title prose fingerprints.** Replaced by Voice Calibration (Item 3) for copyright reasons. Storing licensed prose excerpts on disk is a liability we don't need; auto-derived voice fingerprints from the user's own prose serve the same calibration function.
- **Iconic-line quota.** Replaced by Highlight Prediction (Item 11). Measurement beats mandate; quotas force purple prose, predictions reward natural peaks.
- **Multi-chapter parallelism for Phase 1.** Considered bundling Phase 2 items into one PR. Rejected because compulsion-loop ledger alone touches 5 stages and deserves its own PR for review and rollback safety.
- **Hard-gate Phase 1-3 stages in `max` profile.** Rejected to preserve "no regression to current behavior" guarantee. Hard gates only exist in the new `bestseller` profile.

---

# Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| Polish pass introduces continuity drift | High | Validators + focused re-judge after polish; fail-soft revert |
| Reader-sim feedback loop overconstrains future chapters | Medium | Reader-sim is advisory only in `max`; enters spec context as suggestions, not constraints |
| Voice calibration locks in early-chapter mistakes | Medium | Auto-derive from latest published chapters means it self-corrects; `STYLE_SAMPLE.md` override available |
| Voice judge dimension (Item 3b) breaks 15-dimension scoring schema | Medium | Ship voice cal in two phases — draft-context first (Phase 1), judge dimension later (Phase 2). Deferral lets the new dimension piggyback on already-tuned weights and smoke fixtures rather than landing alongside drafting changes. |
| Tournament merge logic regresses polish-pass merge logic | Medium | Tournament ships only after polish-pass has proven stable in production. Tournament reuses polish's plan/apply/validate/revert pattern rather than inventing a parallel one. |
| Tournament generation costs explode on retry-heavy chapters | Medium | Per-zone failure isolation; fail-soft on each zone independently |
| Compulsion-loop ledger becomes brittle to blueprint changes | High | Loops carry their own IDs; mismatched loops trigger re-extraction, not failure |
| Bestseller mode rejects too many chapters in practice | Medium | Phase 4 only ships after Phase 1-3 advisory data shows realistic thresholds |
| Commercial promise judge and literary judge produce contradictory signals | Medium | Bestseller mode weights commercial heavier; `max` keeps both as advisory inputs to spec |
| Voice grit pass produces quirk spray (random tics not anchored to character voice) | Medium | Validator requires `ticSource` to cite an `activeTrait` or `dialogueHabit` from voice cards; `tabooNote` excluded from `ticSource`; rejudge atomicity discards entire batch on >1pt regression or new blocking signal |

---

# Glossary

- **Compulsion loop** — an open question in the reader's mind, distinct from a plot thread. Plot threads are the writer's debt; loops are the reader's debt.
- **Promise compounding** — a chapter that makes the book more like its marketed promise (genre, story promise, reader promise) than the previous chapter.
- **Reader debt out** — number of open loops the reader is carrying when they close the chapter. Bestsellers hold 3-7 simultaneously.
- **Protected zone (polish)** — prose spans owned exclusively by the opening/ending tournament: chapter opening (~200 words), chapter ending (last paragraph), chapter title.
- **Voice fingerprint** — quantified sentence-length distribution, paragraph rhythm, signature lexicon, recurring metaphor families, dialogue conventions, and POV interiority density extracted from the user's own published prose or from `STYLE_SAMPLE.md`.
- **Fail-soft** — any new stage failing or regressing causes downstream to use the previous artifact. The chapter publishes; the run does not block.

---

*This document is the canonical reference for the bestseller roadmap. Update it when scope, sequencing, or acceptance criteria change.*

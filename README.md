# Commercial Fiction Engine v2

Blueprint-first, chapter-by-chapter generation engine for commercially viable, high-retention genre fiction.

`STORY_BLUEPRINT.md` (a copy of [`BLUEPRINT_TEMPLATE.md`](BLUEPRINT_TEMPLATE.md)) is the single author-owned source of truth. The runtime compiles that blueprint into cached machine-readable artifacts, generates a continuity-aware chapter, audits it, and only publishes prose that clears both the literary and factual gates.

There are no quality profiles. One canonical pipeline runs end-to-end every time.

## Pipeline overview

```
compile blueprint
  → compiled-blueprint
  → genre-contract
  → chapter-functions
  → market-promise        (deterministic, optional Market Promise section)
  → continuity-manifest   (deterministic, optional Continuity Manifest section)
  → locations             (deterministic, optional Locations section)
  → author-brief          (one cached model call per blueprint)

per chapter:
  packet
  → spec → self-red-team → (default-on/required Opus critique) → spec-revision
  → draft (Opus, prepended with author brief + chapter-function reader job)
  → judge (medium reasoning; anti-committee principles + bestseller question)
  → IF score >= skipRevisionThreshold AND no blocking signals:
       write selection.json + selected.json + review.json
     ELSE:
       revise → judge → pairwise-select → write the same artifacts
  → voice-grit pass        (advisory, fail-soft; reserved zones blocked)
  → opening + ending tournament (1 candidate per zone, advisory, fail-soft)
  → delta → memory → final audit → (up to 2 fix attempts if needed) → publish
  → continuity-state-update (deterministic post-publish merge)
  → voice-calibration       (deterministic post-publish extraction)
```

All post-selection passes (voice-grit, tournament) are advisory and fail-soft. If either throws or discards, downstream consumes `selected` unchanged. The skip-revision path still writes `selection.json`, `selected.json`, and `review.json` so `--rerun-from judge`, `--rerun-from memory`, `--audit-only` still work end-to-end.

## Quick start

```bash
npm install
cp BLUEPRINT_TEMPLATE.md STORY_BLUEPRINT.md   # then fill it in
npm run compile:blueprint
npm run chapter -- --chapter 1 --estimate-cost
npm run chapter -- --chapter 1 --packet-only
npm run chapter -- --chapter 1
```

Run the deterministic smoke pipeline (no real provider calls):

```bash
npm run smoke
```

## CLI flags

| Flag | Effect |
|---|---|
| `--chapter N` | chapter number to generate |
| `--packet-only` | stop after writing the chapter packet |
| `--spec-only` | stop after writing the approved spec |
| `--draft-only` | draft from existing packet + approved spec |
| `--judge-only` | run judge + revision + selection from an existing draft |
| `--audit-only` | run delta + memory + audit + fix loop from existing selected |
| `--rerun-from <stage>` | one of `packet, spec, draft, judge, memory, audit` |
| `--estimate-cost` | write a per-stage token/cost estimate, no live calls |
| `--compile-blueprint` | compile and cache blueprint artifacts only |
| `--smoke` | run the full pipeline against the built-in smoke fixture |
| `--blueprint <path>` | alternate blueprint path |
| `--skip-spec-critique` | skip the default-on Opus spec critique (required critique still runs for high-risk/escalated chapters) |
| `--no-genre-ai` | skip GPT genre + author-brief refinement, use deterministic fallback |

## Authoring contracts

Three optional sections in the blueprint shape every model call:

### Market Promise

The commercial spine. Spec, draft, judge, and audit all read these fields:

- Reader Avatar, Shelf / Comps, Core Commercial Hook, Trope Stack, Freshness Angle
- Pacing Contract, Emotional Promise
- Cover/Blurb Keywords, Series Potential
- Chapter-Level Retention Strategy (per chapter-function reader job: opening = make the premise irresistible; midpoint = change what the reader thinks the story is; etc.)

The chapter-function reader job is targeted explicitly by spec, draft, judge, and audit prompts. Failure to honor it is a flag.

### Continuity Manifest

The structural spine. Six pipe-delimited sub-sections:

- Persistent Objects: `name | state | possessor | last-seen-chapter`
- Spatial Registry: `name | description | access | condition`
- Timeline Anchors: `label | description | offset`
- Reveal Schedule: `thread | learner | chapter | mode`
- Relationship States: `pair | trust | distance | dependency | rivalry`
- Motif States: `motif | intensity | last-chapter | stage`

The packet carries a filtered `ContinuityActiveSlice` (active cast + mandatory beats + reveal budget, hard-capped at ~4000 tokens via iterative tail-trimming with floors). After publish, `update-continuity-state.ts` writes a deterministic `continuity-state-after-N.json` baseline that merges declared spec reveals with the extracted `ChapterDelta` (reveal/payoff deliveries, persistent-object state changes, irreversible-change notes). Chapter `N+1`'s packet builder loads that state (soft metadata validation, falls back to the static manifest on mismatch) so last-seen bumps, motif progression, and delivered reveals carry forward. The continuity-manifest validator catches sealed-section regressions, timeline reversals, and premature reveals.

### Locations

Static naming canon for recurring spaces, vehicles, districts, routes, etc. Distinct from the Continuity Manifest's Spatial Registry: Locations declares the canonical `name` + `aliases` for a place, the Spatial Registry tracks its dynamic `access` + `condition`. One pipe-delimited table:

- Locations: `name | type | description | aliases`

`type` is freeform (`interior`, `exterior`, `landmark`, `route`, `vehicle`, `district`, etc.). `aliases` is a comma-separated list. The full Locations table is carried in the chapter packet and surfaced to spec + drafter prompts on every chapter, with an instruction to use the canonical `name` (or one of its `aliases`) rather than invent variant names. No deterministic validator yet — drift is caught by prompt-side visibility for now.

All three sections (Market Promise, Continuity Manifest, Locations) are optional. An empty/absent section means the engine works with the empty contract; behavior degrades gracefully to the pre-section packet shape.

### Per-chapter constraints (optional)

Optional fields on each chapter outline propagate from blueprint → packet → spec/drafter prompts → validator.

- **Named Character Cap**: positive integer soft cap on the number of distinct named blueprint characters that may appear in this chapter's prose. The spec generator and drafter see it as a constraint; the validator emits a `CHARACTER_CAP` warning when prose exceeds it. Unnamed walk-ons (`the waiter`, `the senator's aide`, `a girl in service black`) never count because they aren't in the blueprint cast. Off by default.

Character cards also accept an optional `Surname Alias: true` flag so the validator counts surname-only prose references (e.g. `Crane` for Felix Crane) case-sensitively. Off by default — surnames that are also common nouns (`Park`, `Crane`) would otherwise generate false matches.

## Cost / time targets (typical happy path; not guarantees)

| Stage | Provider | Est. cost |
|---|---|---|
| spec gen + red-team + revise | GPT-5.5 high | ~$0.90 |
| draft | Opus thinking 8k, 16k output | ~$2.00 |
| judge | GPT-5.5 medium | ~$0.30 |
| voice-grit plan + rejudge | Opus + GPT-5.5 medium | ~$0.50 |
| opening + ending tournament (1+1) | Opus + selection | ~$0.65 |
| delta + memory | GPT-5.5 medium | ~$0.40 |
| audit | GPT-5.5 high | ~$0.30 |
| **typical chapter total** | | **~$5.05** |
| author-brief (one-time per blueprint) | GPT-5.5 medium | ~$0.05 amortized |
| continuity-state-update / continuity-manifest / market-promise / locations compiles | deterministic | $0.00 |

With one revision pass: ~$7.35. With revision + up to 2 fix attempts: ~$10–13. Twelve chapters: $70–160. Wall-time: ~10–20 min/chapter typical.

Real numbers come from `--estimate-cost` and from actual provider invoices after the first live runs.

## Key files

- `src/index.ts` — CLI entrypoint
- `src/pipeline/run-chapter.ts` — main orchestrator
- `src/pipeline/voice-grit-pass.ts` — voice-grit pass (canonical contract: `docs/voice-grit-spec.md`)
- `src/pipeline/opening-ending-tournament.ts` — 1-candidate-per-zone opening + ending compare
- `src/pipeline/judge-draft.ts` — literary judge with anti-committee principles + bestseller question
- `src/pipeline/update-continuity-state.ts` — deterministic post-publish state merge
- `src/blueprint/parse-blueprint.ts` — Market Promise + Continuity Manifest + Locations parsers
- `src/blueprint/compile-author-brief.ts` — cached authorial-persona compile
- `src/validators/continuity-manifest.ts` — sealed-regression, timeline, reveal, motif validators
- `src/config.ts` — model defaults, stage budgets, `qualitySettings`, paths
- `src/types/index.ts` — contract layer
- `BLUEPRINT_TEMPLATE.md` — author-facing template
- `docs/voice-grit-spec.md` — canonical voice-grit contract
- `AGENTS.md` — agent context (read before substantive runtime edits)

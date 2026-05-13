# Prompt: Wire Chapter-1 Lessons Into Spec, Draft, and Judge

You are working in `Novel_Creator_v2`.

Implement the minimum-viable structural upgrade derived from review of `chapters/chapter-1.md`. Three small schema additions, two prompt patches, two judge instruction tweaks. No validator changes. No published-prose changes.

## Goal

Codify what Chapter 1 already does well so it survives iteration:

1. Per-POV noticing engine — each POV character perceives through a specific job/fear/training/class/guilt/habit, not through a shared narrator voice.
2. Physical-clue anchoring — clues that change later are tied to a fixed marker with unmistakable before/after states (the "fourth screw" pattern).
3. Conditional human grain — when a scene would otherwise read purely symbolic, ground it with ordinary behavior.
4. Compact craft directives in the drafter — replace ad-hoc additions with a tiered rule block (hard rules vs. defaults).
5. Two judge prompt nudges — per-scene turn check (feeds `forwardMotion`) and a "named without future use" signal (feeds `freshness`).

## Out Of Scope (do not touch in this pass)

- `STORY_BLUEPRINT.md` is author-owned; do not edit it. Author may add `Noticing Engine:` lines at their discretion.
- Published `chapters/*.md` and `artifacts/`.
- `src/validators/*` — none of these have a clean false-positive-free regex. Resist the urge.
- `update-continuity-state.ts`, voice-grit, tournament, audit gating, fix-loop behavior, blueprint hashing semantics.
- Stage profiles, stage budgets, model defaults, CLI flags, exit codes.
- Telemetry / new logging surfaces.

## Existing Contracts To Preserve

- `CharacterCard` is parsed from `## Character Architecture` in the blueprint by `src/blueprint/parse-blueprint.ts` (`parseCharacters`). Optional fields (e.g. `surnameAlias`) are read via `parseStructuredFields` and only set when present.
- `ChapterPacket.activeCast: CharacterCard[]` flows from `compile-chapter-packet.ts` into the drafter directly (raw card, via `stripHeavyPacketFields`) and into the spec via a projected `PromptCharacterView` in `src/pipeline/prompt-packet-views.ts`. The judge consumes a hand-built `voiceCardSummary` line per cast member in `judge-draft.ts` (~lines 202–213). New CharacterCard fields surface to the drafter for free; surfacing to spec or judge requires updating those projection points explicitly.
- `ChapterSpec.scenePlan[]` already has required string fields per scene (`turn`, `emotionalArc`, `sensoryAnchor`, `dialogueStrategy`). The OpenAI structured-output schema in `src/pipeline/generate-spec.ts` mirrors these and uses `additionalProperties: false`.
- **OpenAI strict-schema constraint (critical):** `src/api/openai.ts` sends `strict: true` for every structured-output call. Under OpenAI strict mode, every property declared in `properties` MUST also appear in `required`. There are no truly-optional fields in the JSON schema. The repo's existing pattern uses `anyOf: [{ type: "<concrete>" }, { type: "null" }]` for fields that can be absent (see `reviewSchema.issues[].evidence` in `judge-draft.ts`). Any new "optional" spec field must be required-and-nullable (string | null) OR required-with-an-always-present-default-value (e.g. arrays default to `[]`). The TS interface in `src/types/index.ts` MUST mirror the schema (`field: string | null` or `field: T[]`, NOT `field?: T`).
- `ChapterSpec` revisions go through `alignMandatoryBeatCoverage` and `assertMandatoryBeatCoverage`. New fields must not break those checks.
- `judgeDraft` writes `chapter-N-draft-review.json` / `chapter-N-revised-review.json`. Do not change the 15-dimension rubric, the score schema, the scale-normalization, or `passesThreshold` derivation.
- `BlueprintHash` covers the parsed blueprint. Adding optional `Noticing Engine:` lines to the blueprint will alter the hash and invalidate cached blueprint artifacts; that is acceptable. The change to `BLUEPRINT_TEMPLATE.md` (template-only) does not affect any current `blueprintHash`.
- Skip-revision artifact contract, voice-grit + tournament invariants, publish-candidate ratchet, validator-only-error downgrade — all unchanged.

## Step 1 — Schema: `CharacterCard.noticingEngine`

`CharacterCard` is parsed from the blueprint and not constrained by the OpenAI strict-schema rules. A real optional field is fine here.

`src/types/index.ts` (`CharacterCard`):

- Add `noticingEngine?: string;` after `knowledgeBoundary`. Document inline as: *what this character perceives the world through — job, fear, training, class position, guilt, or habit. One sentence. Used by the drafter and judge to keep POV voices distinct.*

`src/blueprint/parse-blueprint.ts` (`parseCharacters`):

- Read `Noticing Engine` from `parseStructuredFields`. When present and non-empty, include `noticingEngine: asString(...)` on the card; when absent, omit entirely (mirror the `surnameAlias` pattern).

`BLUEPRINT_TEMPLATE.md`:

- Add a single optional bullet on each character archetype after `Knowledge Boundary`:
  - `- Noticing Engine: Optional. One sentence describing what this character perceives through (job, fear, training, class position, guilt, or habit). Used by the drafter and judge to keep POVs distinct.`

`STORY_BLUEPRINT.md` is author-owned. Do NOT add `Noticing Engine:` lines to it in this pass.

## Step 2 — Schema: `ChapterSpec.physicalClueAnchors`

Scope is **same-chapter** physical state changes only (the "fourth screw" pattern from chapter 1: line short of marker → line past marker, both visible in this chapter's prose). Cross-chapter clue plants stay in `revealControl.show` / `revealControl.hint` and are picked up by the next chapter's spec — declaring a future change here would false-penalize the current chapter's prose under the judge check in Step 5.

`src/types/index.ts` (`ChapterSpec`):

- Add `physicalClueAnchors: Array<{ clue: string; anchor: string; beforeState: string; afterState: string }>` after `proseGuidance`. Required field; default to `[]` when not applicable. Do NOT use `?` — the schema requires it (see strict-schema constraint above).
- Document as: *clues whose physical state changes within this same chapter must be tied to a simple fixed marker (a screw, nick, mark, seam, gauge, light, sound, position) with unmistakable before/after states. Both states must be visible in this chapter's prose. Use an empty array when no in-chapter physical change is planned. Cross-chapter plants belong in `revealControl`, not here.*

`src/pipeline/generate-spec.ts` (`chapterSpecSchema`):

- `chapterSpecSchema` is currently declared as a private `const` (line 21). Convert it to `export const chapterSpecSchema` so tests can validate populated and empty shapes against it directly. The existing internal references (`typeof chapterSpecSchema` on lines 343 and 474, plus the two `schema: chapterSpecSchema` usages on lines 407 and 491) continue to work unchanged — exporting only widens visibility.
- Add `physicalClueAnchors` to `properties` as an array of objects with `{ clue, anchor, beforeState, afterState }` (all `string`, `minLength: 1`), each item using `additionalProperties: false` AND listing all four keys in `required`.
- Add `"physicalClueAnchors"` to the top-level schema's `required` list. Required + array is the strict-mode-compatible analog of "optional" — empty array means no anchors.

`buildSpecGenerationRequest` instructions (in `generate-spec.ts`):

- Add one short instruction: *When this chapter contains a clue whose physical state visibly changes between two scenes within the chapter, declare it in `physicalClueAnchors` with a simple fixed marker and an unmistakable before/after pair. Both states must be observable in the chapter's prose. Leave the array empty when no in-chapter physical change is planned; cross-chapter plants belong in `revealControl`, not here.*

Smoke spec helper (`src/pipeline/smoke-helpers.ts`): populate `physicalClueAnchors: []` so smoke specs satisfy the schema. No other smoke prose change.

## Step 3 — Schema: `scenePlan[].humanGrain`

Conditional, NOT a per-scene mandate. Scenes that already carry ordinary friction set this to `null`.

`src/types/index.ts` (`ChapterSpec.scenePlan` element type):

- Add `humanGrain: string | null;` after `dialogueStrategy`. Required field, nullable. Do NOT use `?` — the schema requires it under strict mode.
- Document as: *one ordinary human beat (mistake, fatigue, joke, practical interruption, small kindness, routine task, social awkwardness) used to ground a scene that would otherwise read purely symbolic or elegant. Set to `null` when the scene's existing material already carries human friction; do not invent forced business.*

`src/pipeline/generate-spec.ts` scene schema:

- Add `humanGrain: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] }` to scene `properties`. Add `"humanGrain"` to the scene's `required` list. This mirrors the existing nullable pattern used in `judge-draft.ts`'s `reviewSchema.issues[].evidence`.
- One instruction line in `buildSpecGenerationRequest`: *For each scene, set `humanGrain` only when the scene risks reading purely symbolic or elegant. Otherwise set it to null. Do not invent forced business; if existing scene material already carries ordinary friction, leave it null.*

Smoke spec helper (`src/pipeline/smoke-helpers.ts`): set `humanGrain: null` on each smoke scene to satisfy the schema. No other smoke prose change.

## Step 4 — Drafter Prompt Patch

`src/pipeline/generate-draft.ts` `buildDraftSystemPrompt`:

Replace nothing existing. Append one new section after `UNIVERSAL CRAFT CONSTRAINTS` and before the `comparables` block, titled `CHAPTER-1 LESSONS (HARD RULES + DEFAULTS)`. Tier the rules explicitly so the model knows where to spend attention.

Use this exact text (do not paraphrase the rules; they are calibrated):

```
CHAPTER-1 LESSONS — HARD RULES (treat as contracts; violation is a craft failure):

- H1. Every scene must turn the story. By the end, someone must know more, hide more, fear more, misread something, make a choice, lose control, or shift loyalty. Atmosphere alone is not a turn.
- H2. Earn a remembered name with a future hook. Name a character only when the name will do work the reader needs later — recurrence, recognition, recall, or a hook the plot will collect. For everyone else, render through role + one vivid detail (a press attendant in service black, a steward at the cloakroom, a journalist she half-recognized, a senator holding his glass in both hands the way a man holds a child he has just lifted up). Naming a walk-on is a cost the chapter must be willing to pay; if the name has no future job, drop it.
- H3. Anchor any clue whose physical state changes within this chapter. Tie it to a simple fixed marker (a screw, nick, seam, gauge, light, sound, position). Before-state and after-state must be visually unmistakable in the prose. When `physicalClueAnchors` is set on the spec, follow it. Cross-chapter plants belong in `revealControl`, not here.
- H4. Each chapter ending must create an irreversible shift in knowledge, danger, guilt, loyalty, or control. The reader and at least one character must be unable to return to the prior state of certainty.

CHAPTER-1 LESSONS — DEFAULTS (break only with reason):

- D1. Give every POV a distinct noticing engine. When `noticingEngine` is set on a character card, that character must perceive the scene through it (job, fear, training, class, guilt, or habit). No two POV sections in a chapter should sound like the same narrator wearing different hats.
- D2. Keep suspense procedural. Characters first process danger through role, habit, etiquette, denial, or training before they understand the full threat. Do not let them narrate the theme or explain the danger on contact.
- D3. Technical details must do at least one job: create tension, clarify space, reveal character, set up consequence, or produce later irony. If a detail only sounds cool, cut it.
- D4. Use big cinematic imagery only at structural thresholds: arrival, reveal, disaster, realization, irreversible ending. Between thresholds, keep prose concrete and functional.
- D5. Motifs may repeat only when they escalate, reverse, or gain new context. Do not repeat the same image at the same emotional intensity.
- D6. Maintain the core contrast: social performance and luxury above, machinery and procedure underneath. Both surfaces should be present in any scene that occupies the contested space.
- D7. Charismatic characters may be genuinely graceful or useful early; their grace may be instinct, performance, or both. This ambiguity has a shelf life — defer to the chapter function profile and pacing contract for when the ambiguity must close.
- D8. Keep dialogue mixed and human: formal speech, work speech, evasions, interruptions, jokes, corrections, plain reactions. Not every line should be quotable. When a scene risks reading too polished, ground it with ordinary behavior — a practical concern, fatigue, awkwardness, a small kindness, a routine task. Use `humanGrain` from the scene plan when it is non-null; do not invent forced business when it is null.
- D9. Do not over-explain what an image, action, silence, or gesture already proves. Withholding should be structural, not narrated.
- D10. When `revealControl` carries multiple mysteries (`show` / `hint` / `reveal` / `withhold`), do not spotlight all of them equally. Treat the most plot-bearing one as the primary mystery the reader actively tracks, others as secondary mysteries to notice, and the rest as atmospheric — felt, not explained.
```

Notes:

- "Hard rules" map to existing judge dimensions (`forwardMotion`, `endingHookStrength`, `revealControl`, `voiceConsistency`) — no new score dimension.
- D7's "shelf life" is intentionally soft. The chapter function profile and `marketPromise.pacingContract` already encode where ambiguity must close. Do not hard-code chapter numbers in this prompt.
- D10 reads existing `revealControl.{show,hint,reveal,withhold}` only. The directive is interpretive, not structural — no new spec field.

## Step 5 — Judge Prompt Tweaks (and surfacing fix)

### 5a. Surface `noticingEngine` to the judge

`src/pipeline/judge-draft.ts` currently builds a per-cast `voiceCardSummary` (~lines 202–213) that emits only `voiceNotes` (or, when present, runtime-card traits/habits/stress/taboo). The judge will not see `noticingEngine` unless we add it.

Update the summary builder to append a `notices=` segment when `c.noticingEngine` is set. Keep the existing line shape intact for cards without it; mirror the pattern used by `traits=` / `habits=`. Example shape:

```
Erik (protagonist): traits=[...]; habits=[...]; stress="..."; taboo=[...]; notices="<noticingEngine here>"
```

When no runtime card exists, append the same `notices="..."` segment to the voice-notes line:

```
Erik (protagonist): <voiceNotes joined>; notices="<noticingEngine here>"
```

Omit the segment entirely when `noticingEngine` is not set on the card.

### 5b. Add the two judge instructions

`src/pipeline/judge-draft.ts` `judgeDraft` instructions block:

Add two short instruction lines, slotted after the existing POV DISCIPLINE block and before the ANTI-COMMITTEE PRINCIPLES block. Do NOT alter the 15-dimension rubric, weights, or schema.

```
SCENE TURN CHECK (feeds forwardMotion).
For each scene break in the candidate prose, evaluate whether the scene actually changed the story state — someone now knows more, hides more, fears more, has misread something, has made a choice, has lost control, or has shifted loyalty. Atmosphere alone is not a turn. When a scene fails this check, lower forwardMotion, name the failing scene in weaknesses with a one-line reason, and add a concrete fix to revisionActions.

NAMED WITHOUT FUTURE USE (feeds freshness).
Flag named figures who appear in this chapter but have neither an on-page hook for future appearance, recognition, or recall, NOR a packet/spec reason to be named (active cast, mandatory beat participants, secondary cameos already scheduled). Required active-cast names are not flagged. The target is the named walk-on whose name does no work — give them a hook the reader will need later, or render them by role + one vivid detail. When this pattern appears, lower freshness slightly and list the over-named figures in weaknesses. Judging this from one chapter is necessarily uncertain; bias toward not flagging when in doubt.
```

Both feed existing dimensions; do not add a 16th dimension. Do not promote either to a `blockingIssues` entry by default — they are weakness signals, not gating errors. (POV violations remain blocking under the existing POV DISCIPLINE rule.)

### 5c. Conditional weakness signals on the new spec/card fields

When the approved spec contains a non-empty `physicalClueAnchors` array and a referenced clue's before/after geometry is not legible in the prose (the marker is missing, the before-state is fuzzy, the after-state cannot be told apart from the before-state), lower `specificity` and add a one-line entry to `weaknesses`.

When a `noticingEngine` is set on a character card (now visible in the `voiceCardSummary` per 5a) and the prose makes no use of it during that character's POV section (the character notices the scene through generic narrator perception instead of their declared engine), lower `voiceConsistency` and add a one-line entry to `weaknesses`.

## Step 6 — Surface `noticingEngine` to the spec (drafter is already covered)

`src/pipeline/prompt-packet-views.ts`:

- `PromptCharacterView` (lines 14–22) currently carries 7 fields and is used by both `buildSpecPacketView` and `buildDeltaPacketView`. Add `noticingEngine?: string;` to the interface and to `buildPromptCharacterView`, mirroring the existing pattern: include the key only when the source card has a non-empty value, omit it otherwise. This surfaces the field to the spec generation prompt (and to the delta path that consumes the same view).
- Do not change packet hashing or envelope shape.

Drafter path: no code change required. `src/pipeline/generate-draft.ts` calls `stripHeavyPacketFields(packetArtifact.data)` which keeps `activeCast: CharacterCard[]` raw, so `noticingEngine` already flows through to the drafter as soon as Step 1 lands. Verify by inspection only.

`src/pipeline/compile-chapter-packet.ts`: no change. The cast is propagated as `CharacterCard[]`; the new optional field passes through automatically.

Judge path: handled in Step 5a above.

## Step 7 — Tests

Add focused regression tests. Prefer `tests/runtime-safety.test.ts` (the existing home for this kind of regression) unless that file is already crowded; in which case use a sibling `tests/system-rules.test.ts`.

Cover:

1. `parseCharacters` reads `Noticing Engine:` when present and omits the field when absent. Synthetic blueprint fragment, no real blueprint touched.
2. Schema shape: confirm that smoke specs (which now must populate `physicalClueAnchors: []` and `humanGrain: null` per scene) round-trip through the existing spec write/read paths without throwing, and confirm a representative populated spec (one anchor entry, one scene with non-null `humanGrain`) also round-trips. If the existing test toolchain has a JSON-schema validator, run the exported `chapterSpecSchema` constant against both shapes; otherwise exercise via the request-builder + a stubbed provider. Match the pattern used by existing schema tests.
3. `buildDraftSystemPrompt` includes the `CHAPTER-1 LESSONS` section. One assertion on the section header and one on rule `H1` text is sufficient; do not snapshot the whole prompt.
4. `judgeDraft` instructions include the SCENE TURN CHECK and NAMED WITHOUT FUTURE USE blocks. Same shape — header presence + one rule line each.
5. The judge `voiceCardSummary` builder appends a `notices="..."` segment when a CharacterCard has `noticingEngine` set, and omits the segment when it does not. Cover both the runtime-card path and the voice-notes-only path.
6. `prompt-packet-views.buildPromptCharacterView` surfaces `noticingEngine` on the resulting view when set on the source `CharacterCard`, and omits the key when not set.

Tests must not require provider calls or real API keys. Smoke runs must remain deterministic and validator-clean. If any new test would require touching the smoke helpers' synthetic prose, leave the smoke prose unchanged and adjust the test instead.

## Calibration

Before marking the change done, run a smoke pipeline end-to-end (`npm run smoke` or the equivalent isolated-root CLI test) and confirm:

- Smoke spec generation still passes mandatory beat coverage with the new optional fields wired.
- Smoke draft still produces deterministic, validator-clean prose.
- Cost estimator still resolves (no stage-list drift introduced; this change adds zero new stages).

If smoke breaks, the two most likely culprits are: (a) a strict-schema rejection because a new property was added to `properties` without being added to `required`, or (b) the smoke spec helper not populating `physicalClueAnchors: []` / per-scene `humanGrain: null`. Fix by aligning the helper or the `required` list, not by relaxing the contract or dropping `strict: true`.

## Doc-Sync Note

After substantive edits, sync these docs in the same commit:

- `AGENTS.md` — Project-Specific Hot Spots: add a one-line entry under the existing spec/judge bullets noting the new optional `noticingEngine` (CharacterCard), `physicalClueAnchors` (ChapterSpec), and per-scene `humanGrain` fields, and the two new judge weakness signals.
- `BLUEPRINT_TEMPLATE.md` — already updated in Step 1 (the optional `Noticing Engine:` line on each character archetype).
- `.cursor/rules/pipeline-contract.mdc` — extend the "Pipeline Contract" file list only if the new fields cross a stage boundary the rule didn't already cover. Most likely a one-line addition to the spec/draft/judge bullets, no new bullets.
- No change required in `BESTSELLER_ROADMAP.md`, `STORYBOARD_PIPELINE.md`, `docs/voice-grit-spec.md`, or `README.md` — none of those describe spec/draft/judge prompt internals at this granularity.

## Validation

After edits, run:

```bash
npm test
npm run typecheck
```

Preserve CLI exit semantics. Do not change published chapter files. Do not change cost estimates beyond what naturally follows from the prompt-text additions.

## Deferred (do NOT implement here)

- A `mysteryHierarchy` structured field on `ChapterSpec`. D10 reads existing `revealControl` intent only.
- Cross-chapter `physicalClueAnchors` plants. The current scope is same-chapter only; cross-chapter plants stay in `revealControl`.
- A new validator for clue-anchoring or scene-turn. Both are too false-positive-prone for deterministic regex; they live in the judge prompt.
- A 16th rubric dimension. The two new judge signals feed existing dimensions (`forwardMotion`, `freshness`, `specificity`, `voiceConsistency`).
- Hard-coded chapter-number gates for D7's "shelf life on charm." Rely on the existing chapter function profile + pacing contract.
- Author-side edits to `STORY_BLUEPRINT.md`. Author may add `Noticing Engine:` lines at their discretion in a separate change.

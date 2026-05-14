# Prompt: Add `mistakenBeliefs` + Extend Voice-Grit Tic Catalog

You are working in `Novel_Creator_v2`.

Two surgical updates that move the system from "writes beautiful scenes" toward "manages the novel's pressure system." No new pipeline stages. No new H/D rules in the drafter prompt. No plainness pass. No structured mystery hierarchy. No mandatory-ordinary-object rules.

One **explicit carve-out:** Part A appends a single trailing sentence to the existing `D2` line. This is not a new rule — it modifies an existing default. No other drafter prompt expansion is permitted in this pass.

## Goal

1. **Track dramatic irony.** Add `mistakenBeliefs` to the continuity state so the system knows what each POV character believes that is wrong, and can write/judge against that gap.
2. **Catch repeated effects, not just repeated words.** Extend the existing voice-grit tic catalog (and the `VoiceTarget` fingerprint) to detect body anchors, gestures, rhetorical structures, modifier tics, sensory tics, and balanced-clause tics, then route them through voice-grit's existing KEEP / VARY / CUT discipline.

Both must be ratchet-safe and fail-soft. Smoke must remain deterministic and validator-clean.

## Out Of Scope (do not touch in this pass)

- A new "plainness pass" stage. Defer.
- A structured `mysteryHierarchy` field on `ChapterSpec`. The existing D10 directive over `revealControl` is enough for now.
- Mandatory ordinary-object / mandatory-humor rules in the drafter prompt.
- Any further expansion of the drafter prompt's `CHAPTER-1 LESSONS` block beyond the single D2 modification carved out above. The drafter prompt is at its attention budget.
- `STORY_BLUEPRINT.md` (author-owned), `chapters/*.md` (published prose), `artifacts/*` (runtime output).
- New deterministic validators in `src/validators/*` for either feature. Both live in the model-driven layer (continuity merge + voice-grit pass).
- `update-continuity-state.ts` post-publish merge contract beyond adding the new field. Audit gating, fix-loop behavior, publish-candidate ratchet, voice-grit reserved zones, tournament invariants — all unchanged.
- Stage profiles, stage budgets, model defaults, CLI flags, exit codes, telemetry surfaces.

## Existing Contracts To Preserve

- `ContinuityState` (src/types/index.ts ~line 237) is keyed by string identifiers (character name strings, persistent-object names). Do **not** introduce a `CharacterId` type. Continue using `CharacterCard.name` as the string key for character-scoped fields.
- `ContinuityManifest` (src/types/index.ts ~line 203) is the **static blueprint-derived shape** consumed by the packet builder via `projectStateToManifest`. It is the projection target, not the home for runtime state. Do **not** bolt new runtime fields (like `mistakenBeliefs`) onto `ContinuityManifest` or onto `projectStateToManifest`'s output. Keep them on `ContinuityState` and surface to the packet through a separate top-level packet field.
- `ChapterDelta` (src/types/index.ts ~line 633) is the deterministic carrier from drafter/judge into the post-publish merge. New per-chapter belief signals must enter via `ChapterDelta`, not via a new post-publish "extract beliefs" stage. `--rerun-from` paths read older `chapter-N-delta.json` artifacts that may pre-date the new field; provide an explicit `normalizeChapterDelta(...)` helper that backfills only fields newly added in this pass (initially `mistakenBeliefDeltas: []`) and call it after every model output, smoke output, and rerun artifact load. The helper must NOT invent values for required fields that pre-date this change.
- `update-continuity-state.ts` is the single deterministic writer for `continuity-state-after-N.json`. The merge consumes declared spec reveals + extracted `ChapterDelta`. New fields go through the same deterministic merge.
- `loadPersistedContinuityState` reads `continuity-state-after-N.json`. It must default any missing top-level fields to safe empty values (`{}` or `[]`) for backward compatibility with older persisted artifacts. Mismatches drop silently rather than throwing.
- `VoiceFingerprint` (src/types/index.ts ~line 720) is computed by `extract-voice-fingerprint.ts` from published chapters with a deterministic fallback when no chapters or no usable source text. The extractor is deterministic only — pure regex / token math, no provider calls, no credential logic. New fingerprint fields must follow the same pattern.
- `VoiceTarget` (src/types/index.ts ~line 748) is loaded with soft metadata validation by `loadVoiceTargetIfPresent`. Same soft-load rule.
- Voice-grit follows `docs/voice-grit-spec.md`. Reserved zones, `ticSource` validation against `activeTraits` / `dialogueHabits` (taboos excluded), 0–6 patch cap, max 2 per scene, atomic whole-batch discard on rejudge regression > 1pt or new blocking review signal — all unchanged.
- `GritTexture` enum (src/types/index.ts ~line 254) currently has 6 textures. Adding a new texture or reusing `voice-tic` are both acceptable; do not silently alter the meaning of an existing one.
- OpenAI strict-schema rule (still in force): every property in a structured-output `properties` block must appear in `required`. Use required-and-nullable (`anyOf` with `null`) or required-with-default (arrays default to `[]`) for "optional" fields. TS interfaces mirror (`field: T | null` or `field: T[]`, never `field?: T`) for any field that flows through a strict schema.
- Skip-revision artifact contract, voice-grit + tournament invariants, publish-candidate ratchet, validator-only-error downgrade — all unchanged.

## Part A — `mistakenBeliefs` on Continuity State

Scope is **per-POV-character mistaken beliefs that materially affect future action, delay, suspense, or reversal**. Not every uncertainty. Not every thing a character does not yet know.

### A.1 Schema

`src/types/index.ts`:

- Add `MistakenBelief` interface:

  ```ts
  export type MistakenBeliefStatus = "active" | "questioned" | "corrected" | "exploited";

  export interface MistakenBelief {
    belief: string;
    basis: string | null;
    introducedInChapter: number;
    lastReinforcedInChapter: number | null;
    status: MistakenBeliefStatus;
    readerKnowsItIsWrong: boolean;
    consequence: string | null;
  }
  ```

  All fields required. Nullable strings use `string | null` (never `string?`) so the schema flowing through structured outputs stays strict-mode-compatible.

- Extend `ContinuityState` with:

  ```ts
  mistakenBeliefs: Record<string, MistakenBelief[]>;
  ```

  Required field. Default to `{}` when no beliefs exist. Key is character name string (matching `CharacterCard.name`).

- Extend `ChapterDelta` with:

  ```ts
  mistakenBeliefDeltas: MistakenBeliefDelta[];
  ```

  Where:

  ```ts
  export type MistakenBeliefDeltaOp = "introduce" | "reinforce" | "question" | "correct" | "exploit";

  export interface MistakenBeliefDelta {
    character: string;
    op: MistakenBeliefDeltaOp;
    belief: string;
    basis: string | null;
    readerKnowsItIsWrong: boolean;
    consequence: string | null;
  }
  ```

  Required field on `ChapterDelta`; default `[]`. The merge maps `op` to `status`: `introduce` → `active`, `reinforce` → preserves prior status (or `active` if new), `question` → `questioned`, `correct` → `corrected`, `exploit` → `exploited`.

### A.2 Producer: extract-chapter-delta.ts

`src/pipeline/extract-chapter-delta.ts`:

- Add `mistakenBeliefDeltas` to the structured-output schema. Each item is an object with `additionalProperties: false`, all six keys in `required`, `op` constrained via `enum`, `basis` and `consequence` as `anyOf [{type:"string", minLength:1}, {type:"null"}]`.
- Add the field to the prompt instructions:

  > Extract **only** mistaken beliefs that materially affect future action, delay, failed warnings, social cover-ups, professional misclassification, reversals, or reader suspense. A mistaken belief is something the character believes, assumes, classifies, or dismisses incorrectly — not merely something they do not yet know. For each: name the character (matching the active cast), choose `op` (`introduce` for first appearance, `reinforce` if it persists, `question` if the character starts to doubt it, `correct` if they learn the truth, `exploit` if another character uses it against them), state the belief in one sentence, the on-page basis if any, whether the reader knows it is wrong, and the dramatic consequence in one sentence. Empty array is valid; do not invent beliefs to fill it.

- Smoke fixture path (`src/pipeline/smoke-helpers.ts`): default `mistakenBeliefDeltas: []` on smoke deltas. No prose change.

### A.3 Merge: update-continuity-state.ts

`src/pipeline/update-continuity-state.ts`:

- Apply `mistakenBeliefDeltas` deterministically:
  - `introduce`: append a new `MistakenBelief` to `mistakenBeliefs[character]` with `status: "active"`, `introducedInChapter: chapterNumber`, `lastReinforcedInChapter: null`. Skip if a near-duplicate `belief` already exists for that character (case-insensitive trim match) — duplicates fold into a `reinforce` instead.
  - `reinforce`: find the matching belief (case-insensitive trim match on `belief`); set `lastReinforcedInChapter: chapterNumber`. If status was `corrected`, leave it `corrected`. If no match, treat as `introduce`.
  - `question`: find the matching belief; set `status: "questioned"`, `lastReinforcedInChapter: chapterNumber`.
  - `correct`: find the matching belief; set `status: "corrected"`, `lastReinforcedInChapter: chapterNumber`.
  - `exploit`: find the matching belief; set `status: "exploited"`, `lastReinforcedInChapter: chapterNumber`.
- All five ops update `consequence` from the delta when the delta provides a non-null value; otherwise preserve.
- Older `continuity-state-after-N.json` artifacts may not have `mistakenBeliefs`. The reader (`loadPersistedContinuityState`) must default the field to `{}` when absent — never throw.

### A.4 Surface to next chapter

`src/pipeline/compile-chapter-packet.ts`:

- After `loadPersistedContinuityState` returns the prior chapter's `ContinuityState`, read `state.mistakenBeliefs` directly (default `{}` when absent) and surface it as a **top-level `ChapterPacket` field** `mistakenBeliefs: Record<string, MistakenBelief[]>` (default `{}`).
- Do **not** route through `projectStateToManifest` — `ContinuityManifest` is the static blueprint-derived projection shape and stays unchanged.
- Do **not** strip the new field in `stripHeavyPacketFields` — it's small and the drafter/spec/judge need it.

`src/types/index.ts`: extend `ChapterPacket` with the required `mistakenBeliefs: Record<string, MistakenBelief[]>` field. Default `{}` on construction. Smoke fixture must populate `{}` (or a representative case) so the packet schema is satisfied.

### A.5 Surface to spec, draft, judge

- `src/pipeline/prompt-packet-views.ts`: `PromptCharacterView` is per-character. Add `mistakenBeliefs: string[]` (project the `belief` strings for active/questioned beliefs only; omit `corrected` and `exploited`). Empty array is valid. Source the per-character belief list from `ChapterPacket.mistakenBeliefs[characterName]`.
- `src/pipeline/generate-spec.ts` `buildSpecGenerationRequest`: one short instruction line — *Each POV character's `mistakenBeliefs` lists what that character currently believes that is wrong. Treat them as live pressure: scenes may reinforce, question, correct, or exploit them, but the chapter must engage with them rather than ignore them. Do not narrate around a belief that should be operative.*
- `src/pipeline/generate-draft.ts` `buildDraftSystemPrompt` — **carve-out edit, not a new rule.** Append one short trailing sentence to the existing `D2` (denial-as-action) line: *When a POV character's voice card lists `mistakenBeliefs`, the prose should let those beliefs drive their reading of the scene (classification, dismissal, comforting interpretation), not contradict them prematurely.* No new H or D rule. No other drafter prompt edit.
- `src/pipeline/judge-draft.ts`: the existing exported `buildVoiceCardSummary` helper (added in the prior session) currently takes the per-character runtime card + `noticingEngine`. Extend its signature to also receive the per-character active/questioned belief strings, and update the single call site in `judgeDraft` to pass `ChapterPacket.mistakenBeliefs[characterName]` (filtered to `active`/`questioned`, defaulting to `[]` when absent). When the array is non-empty, append `; believes=["belief 1", "belief 2"]` to the summary line; omit the segment when empty. No new rubric dimension. The signal feeds existing `characterTruth` and `revealControl`.

### A.6 Soft validation + normalization helper

- The reader of `continuity-state-after-N.json` (`loadPersistedContinuityState`) defaults missing `mistakenBeliefs` to `{}`.
- Add an explicit exported helper that backfills **only** the fields newly added in this pass on legacy delta artifacts (initially just `mistakenBeliefDeltas`). Define a narrow input type, NOT `Partial<ChapterDelta>`:

  ```ts
  type LegacyChapterDelta = Omit<ChapterDelta, "mistakenBeliefDeltas"> & {
    mistakenBeliefDeltas?: MistakenBeliefDelta[];
  };

  export function normalizeChapterDelta(delta: LegacyChapterDelta): ChapterDelta;
  ```

  Behavior: copies the input through, sets `mistakenBeliefDeltas: delta.mistakenBeliefDeltas ?? []`, returns a fully-typed `ChapterDelta`. Must NOT invent values for required pre-existing fields like `nextChapterOpeningHandoff`. As future fields are added to `ChapterDelta` in later passes, extend `LegacyChapterDelta` and the helper body to backfill them too — same narrow-shape pattern. Call sites:
  - immediately after structured-output extraction in `extract-chapter-delta.ts`;
  - inside the smoke fixture path in `smoke-helpers.ts`;
  - in every `--rerun-from` artifact load that consumes a persisted `chapter-N-delta.json` (so reruns against pre-update artifacts don't crash).
- Neither absence throws.

## Part B — Voice-Grit Tic Catalog Extension (Effect Tics)

Goal: detect repeated **effects** in addition to repeated words. Body anchors, gestures, rhetorical structures, modifier tics, sensory tics, abstraction tics, balanced-clause tics. Route them through voice-grit's existing KEEP / VARY / CUT discipline. **No new pipeline stage.**

### B.1 Fingerprint extension

`src/types/index.ts` — extend `VoiceFingerprint` with:

```ts
effectTics: {
  bodyAnchors: string[];
  rhetoricalStructures: string[];
  modifierTics: string[];
  sensoryTics: string[];
  gestureTics: string[];
  abstractionTics: string[];
  balancedClauseTics: string[];
};
```

All seven sub-arrays required; each defaults to `[]`. Older `voice-target.json` artifacts may lack the field — `loadVoiceTargetIfPresent` defaults it to all-empty when absent (never throws).

### B.2 Extractor

`src/blueprint/extract-voice-fingerprint.ts` is **deterministic only** today (pure regex / token math, no provider calls). Keep it deterministic. No new stages, no new budgets.

- Populate `effectTics` deterministically from published-chapter text using token/regex matchers analogous to `buildSignatureLexicon`:
  - `bodyAnchors`: token-frequency match against the seed list (case-insensitive); keep entries that appear ≥ 3 times across the corpus.
  - `modifierTics`: same approach against the seed list.
  - `rhetoricalStructures`, `sensoryTics`, `gestureTics`, `abstractionTics`, `balancedClauseTics`: regex-pattern occurrence counts against seed-derived patterns; keep entries with ≥ 2 corpus matches.
- When no published chapters exist (first-chapter run or `STYLE_SAMPLE.md`-only paths), emit the **seed catalog as-is** as the deterministic fallback. Use this exact seed catalog:

  ```json
  {
    "bodyAnchors": ["ribs", "palm", "hands flat", "breath", "teeth", "throat", "chest", "wrist", "thumb"],
    "rhetoricalStructures": ["the way X does Y", "as if", "as though", "not X but Y", "X and not X", "before he had time to", "without meaning to", "he did not let himself", "he had learned"],
    "modifierTics": ["small", "clean", "soft", "private", "precise", "polite", "warm", "wrong"],
    "sensoryTics": ["warmth/cold contrast", "music as atmosphere", "light dimming/returning", "pressure felt through body", "object pressing against ribs", "glass/acrylic surface description"],
    "gestureTics": ["touching rail", "setting palm flat", "checking pocket", "making clipboard mark", "not drinking", "turning away before answering", "counting silently"],
    "abstractionTics": ["shame as a physical presence", "room as an actor", "silence as an object", "professional category as emotional shield"],
    "balancedClauseTics": ["It was X, and it was not X", "He had Y, and he had not Y", "The room had recovered; the building had not", "beautiful but wrong", "public order/private failure"]
  }
  ```

- The seed catalog is the deterministic-fallback default. The corpus-derived version overrides per-book once published chapters exist.
- All seven sub-arrays must always be present (default `[]`); no nullable fields.

### B.3 Voice-grit planner integration

`src/pipeline/voice-grit-pass.ts`:

- Surface `voiceTarget.fingerprint.effectTics` into the planner prompt as a `KNOWN EFFECT TICS` section. The planner already sees the voice fingerprint; this is one new sub-section.
- Add a `repeated-effect` reduction texture to the existing menu by extending the `GritTexture` enum:

  ```ts
  export type GritTexture =
    | "prosody-irregularity"
    | "voice-tic"
    | "interrupted-observation"
    | "strategic-under-explanation"
    | "specificity-swap"
    | "asymmetric-paragraph-weight"
    | "repeated-effect";
  ```

- `repeated-effect` patches **vary or cut** a sentence whose dominant effect (body anchor, gesture, rhetorical structure, modifier, sensory beat, abstraction, balanced-clause turn) duplicates an effect from another sentence within the same chapter, **without escalation, inversion, or new information**.
- Each `repeated-effect` patch must:
  - Cite the duplicated effect in `earnedJustification` (e.g., *"third 'palm flat against' body anchor in scene 3; no escalation"*).
  - Set `ticSource` to the canonical form `effectTics.<category>:<entry>` (e.g., `effectTics.bodyAnchors:palm` — no quotes, no whitespace, exact match against the lookup entry). The existing `ticSource` validation must be widened: previously `ticSource` was required to cite an `activeTrait` / `dialogueHabit`; for `repeated-effect` it cites an `effectTics` entry instead. **Taboo exclusion still applies.**
  - Honor reserved zones, the 0–6 total patch cap, and the max-2-patches-per-scene cap. Reuse the existing patch validator path; do not duplicate it.
- Planner instruction (one short paragraph, append to the existing planner prompt):

  > Detect repeated effects in addition to repeated words. For each repeated body anchor, gesture, rhetorical structure, modifier tic, sensory beat, abstraction tic, or balanced-clause turn, classify it as **KEEP** (intentional motif that escalates or changes meaning), **VARY** (useful effect but the phrasing or gesture repeats too closely), or **CUT** (duplicate effect that adds no new pressure, character, or information). Only emit a `repeated-effect` patch for VARY or CUT — KEEP is recorded in `earnedJustification` only. Do not flatten intentional motifs. The goal is to prevent the chapter from sounding uniformly polished or generated, not to remove all repetition.

- `repeated-effect` patches operate on the same atomic-discard rejudge contract as every other voice-grit batch. Score drop > 1pt or any new blocking review signal → discard the entire batch including the new patches. **No partial-patch publishing.**

### B.4 Cross-POV diagnostic

The repeated-effect detection needs to see all POV sections together, not per-batch. Voice-grit already operates over the full `selected` prose, so the planner naturally has chapter-wide visibility. No structural change required — only the planner prompt language above ("within the same chapter").

### B.5 Validator widening

`src/pipeline/voice-grit-pass.ts` patch validator:

- Today `applyVoiceGritPatches` receives `voiceCards: VoiceCardLookup` (shape: `{ activeTraits, dialogueHabits, taboos }`). It does **not** see the voice fingerprint. Widen the call signature to also accept an effect-tic lookup sourced from `voiceTarget.fingerprint.effectTics`:

  ```ts
  type EffectTicCategory =
    | "bodyAnchors"
    | "rhetoricalStructures"
    | "modifierTics"
    | "sensoryTics"
    | "gestureTics"
    | "abstractionTics"
    | "balancedClauseTics";

  type EffectTicLookup = Record<EffectTicCategory, Set<string>>;

  function buildEffectTicLookup(voiceTarget: VoiceTarget | null): EffectTicLookup;
  ```

  Build the lookup from `voiceTarget.fingerprint.effectTics` when present; default each set to empty when `voiceTarget` is null. Pass it into `applyVoiceGritPatches` alongside `voiceCards`. Update the caller in `voice-grit-pass.ts` accordingly.
- Widen `ticSource` validation:
  - `voice-tic` patches: existing behavior. `ticSource` must match `activeTraits` or `dialogueHabits`. Tabooed entries excluded.
  - `repeated-effect` patches: `ticSource` must follow the form `effectTics.<category>:<entry>` where `<category>` is one of the seven enum values above and `<entry>` is a member of `effectTicLookup[<category>]`. Anything else fails with a skip-reason via the existing path.
- Cross-shape misuse skips with a clear reason (e.g. a `voice-tic` patch citing an `effectTics` source, or a `repeated-effect` patch citing an `activeTrait`).
- Tabooed entries remain excluded from `ticSource` regardless of texture.

### B.6 Spec sync

`docs/voice-grit-spec.md`:

- Update the "Allowed texture menu" section to add a 7th texture: `repeated-effect — VARY or CUT one sentence whose dominant effect duplicates another within the chapter without escalation, inversion, or new information. ticSource cites an effectTics entry from the voice fingerprint. Honors reserved zones, count caps, and the atomic discard rule.`
- Update "Hard constraints" to note that `ticSource` may cite either an `activeTrait`/`dialogueHabit` (for `voice-tic`) or an `effectTics` entry (for `repeated-effect`); taboos still excluded.
- No other spec change.

## Part C — Tests

Add focused regression tests. Prefer `tests/runtime-safety.test.ts` if it has room; otherwise `tests/system-rules.test.ts`. No provider calls, no real API keys. Smoke prose unchanged.

Cover:

1. `MistakenBeliefDelta` round-trips through `extract-chapter-delta` schema (smoke fixture with `mistakenBeliefDeltas: []` and a representative populated case with one belief per `op`).
2. `update-continuity-state` deterministic merge: `introduce` adds a new belief; duplicate `introduce` folds into `reinforce`; `question`/`correct`/`exploit` flip status correctly; `lastReinforcedInChapter` updates; `consequence` is preserved when the delta is null and overwritten when the delta provides a non-null value.
3. `loadPersistedContinuityState` defaults `mistakenBeliefs: {}` when absent from an older persisted artifact (synthetic fixture).
4. `normalizeChapterDelta` backfills `mistakenBeliefDeltas: []` (and any other newly-required arrays) on a synthetic pre-update delta artifact, and is a no-op on an already-normalized delta. Round-trip the normalized delta through the merge.
5. `compile-chapter-packet` surfaces `mistakenBeliefs` on the packet from the prior chapter's persisted `ContinuityState` (NOT through `projectStateToManifest`); defaults to `{}` when no prior state exists or the prior state lacks the field.
6. `PromptCharacterView` projects only `active` and `questioned` belief strings (not `corrected` / `exploited`), keyed off `ChapterPacket.mistakenBeliefs[characterName]`.
7. `judge-draft.ts` `voiceCardSummary` builder appends `believes=[...]` when the character has any active/questioned beliefs and omits the segment when empty.
8. `VoiceFingerprint` deterministic fallback in `extract-voice-fingerprint.ts` populates the seven `effectTics` sub-arrays from the seed catalog when no chapters; corpus-derived path overrides per-book when text is provided (one assertion per arm is enough).
9. `loadVoiceTargetIfPresent` defaults `effectTics` to all-empty sub-arrays when absent from an older `voice-target.json`.
10. `buildEffectTicLookup` constructs `EffectTicLookup` correctly from a `VoiceTarget` and returns all-empty sets when given `null`.
11. Voice-grit patch validator (covers the new shape):
    - `repeated-effect` patch with `ticSource: "effectTics.bodyAnchors:ribs"` (canonical form, no quotes around `ribs`) and `ribs` present in the lookup → survives.
    - `repeated-effect` patch with `ticSource: "effectTics.bodyAnchors:notpresent"` → dropped with a skip-reason.
    - `repeated-effect` patch with an `activeTraits`-shaped `ticSource` → dropped (wrong shape).
    - `voice-tic` patch with an `effectTics`-shaped `ticSource` → dropped (wrong shape).
    - Tabooed entries are still excluded for both textures.
12. `repeated-effect` patches honor reserved zones and the 0–6 / max-2-per-scene caps via the existing validator path (one assertion is enough; do not re-test the validator's full surface).

## Part D — Validation

After edits, run:

```bash
npm test
npm run typecheck
npm run smoke
```

Confirm:

- Smoke spec generation still passes mandatory beat coverage.
- Smoke draft remains deterministic and validator-clean.
- Smoke continuity-state-after-1.json includes `mistakenBeliefs: {}` (empty for the deterministic smoke path is fine; populated entries are also fine if the smoke fixture exercises beliefs).
- Smoke voice-target.json includes all seven `effectTics` sub-arrays as required keys. The seed catalog only appears verbatim when the deterministic-fallback path is exercised (no published chapters); when smoke publishes a chapter and `extract-voice-fingerprint` runs over the published prose, the corpus-derived path may legitimately override seed entries. Assert presence and shape, not specific seed values, in the smoke validation.
- Cost estimator still resolves; no new stages added.

If smoke breaks, the most likely culprits are: (a) strict-schema rejection because a new property was added to `properties` without being added to `required`; (b) the smoke fixture missing `mistakenBeliefDeltas: []` on the delta or `mistakenBeliefs: {}` on the packet; (c) `--rerun-from` against a pre-update `chapter-N-delta.json` artifact crashing because `normalizeChapterDelta` was not called at the artifact-load site; (d) the voice-grit patch validator rejecting `repeated-effect` patches because the `EffectTicLookup` was not threaded through `applyVoiceGritPatches`. Fix the helper, the rerun normalize call, the lookup wiring, or the validator — not the contract.

After substantive edits, run `ReadLints` on every edited file and fix any lints introduced.

## Part E — Doc-Sync

After the edits, sync these docs in the same commit:

- `AGENTS.md` — Project-Specific Hot Spots: one-line entry under the existing continuity bullets noting `mistakenBeliefs` flows through `ChapterDelta.mistakenBeliefDeltas` → `update-continuity-state` merge → `compile-chapter-packet` reads `ContinuityState.mistakenBeliefs` directly (NOT through `projectStateToManifest`) → spec/draft/judge surfacing; mention `normalizeChapterDelta` for backward-compatible delta loading. One-line entry under the voice-grit bullets noting the new `repeated-effect` texture, the `effectTics` fingerprint section (deterministic extraction with seed-catalog fallback), and the `EffectTicLookup` threaded through `applyVoiceGritPatches`.
- `docs/voice-grit-spec.md` — already updated in Part B.6.
- `.cursor/rules/pipeline-contract.mdc` — extend the bullet list only if the new fields cross a stage boundary the rule doesn't already cover. Most likely a one-line addition under the continuity-state bullet, no new bullets.
- `BLUEPRINT_TEMPLATE.md` — no change required. Mistaken beliefs are derived from prose, not declared by the author.
- `STORY_BLUEPRINT.md` — no change. Author-owned.
- `README.md`, `BESTSELLER_ROADMAP.md`, `STORYBOARD_PIPELINE.md` — no change.

## Constraints

- Preserve CLI exit semantics: `1` for unexpected runtime/CLI failure, `2` for blocked pipeline outcomes.
- Do not change published chapter files.
- Do not change cost estimates beyond what naturally follows from the new `ChapterDelta` field and the planner prompt addition.
- Both features must remain ratchet-protected and fail-soft. Voice-grit's atomic-discard rule is non-negotiable.

## Deferred (do NOT implement here)

- A separate "plainness pass" stage. Reconsider after one or two chapters demonstrate the effect-tic detection is doing its job.
- Mandatory ordinary-object / mandatory-humor rules in the drafter prompt.
- A structured `mysteryHierarchy` field on `ChapterSpec`. D10 over `revealControl` is the v2 approach.
- A 16th rubric dimension. The two new signals feed `characterTruth`, `revealControl`, `voiceConsistency`, and `freshness` (existing dimensions).
- A new validator for either feature. Both live in the model-driven layer.
- Hard-coded chapter-number gates for when beliefs must be corrected. Rely on the chapter function profile + pacing contract.
- Author-side edits to `STORY_BLUEPRINT.md`.

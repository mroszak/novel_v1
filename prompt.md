# Convert whole-chapter rewrites to surgical patches everywhere they aren't structurally required

## Problem

The pipeline has **two** stages that ask Opus to emit the entire chapter prose to fix problems that are usually surgical:

1. **`src/pipeline/fix-continuity.ts`** (`continuity-fix` stage, 16,000 output token cap). Triggered when the final audit finds error-severity issues (timestamps, units, POV access leaks, length-band misses). System prompt says "make the smallest possible delta" but the output contract is full chapter prose. **Chapter 2 just truncated here**: Opus hit `max_tokens: 16000`, the rewrite was cut mid-paragraph, pipeline blocked `BLOCKED_PROVIDER_FAILURE`. The five errors that triggered it were trivially surgical (one missing word, two timestamps, one units swap, one current-bearing reconciliation, one POV access leak).

2. **`src/pipeline/revise-draft.ts`** (`revision` stage, 24,000 output token cap). Triggered when the literary judge scores below `qualitySettings.skipRevisionThreshold` OR fires blocking signals. System prompt says "Target surgical improvement, not rewrite" but the output contract is full chapter prose. Hasn't truncated yet, but its safety net (`publish-candidate ratchet`) exists precisely because wholesale rewrites empirically regress good passages.

Additionally, three accountability gaps exist today:

- **Warning-severity issues** (judge `issues`, audit `issues`, validators) are documented but never acted on.
- **Validator-only errors** are downgraded to warnings and silently dropped from fix consideration.
- **No per-issue verification** that each `weakness` / `revisionAction` / audit error was actually addressed by the rewrite. Today's `ContinuityFixResult.appliedFixes` claims to record this but is set to `audit.issues.map(i => i.title)` — i.e., every issue is marked applied regardless of whether the model touched it.

And every model-touching stage currently receives a maximalist context bundle. That makes the model's reasoning noisier and burns input tokens.

## Goal

Convert **both** stages to a patch-list contract modeled on `src/pipeline/voice-grit-pass.ts`, with three orthogonal improvements layered on:

1. **Patches instead of whole-prose rewrites** — model emits `{originalText, replacementText, errorRef, justification}` patches; engine applies deterministically with validation.
2. **Per-issue accountability** — every issue surfaced to the planner is either patched, explicitly skipped with a reason, or recorded as unaddressed. No silent drops.
3. **Minimal context per stage** — patch planners receive only the specific issues to fix, the chapter prose, and a narrow POV/voice slice. No blueprint dumps, no rolling-memory walls, no previous-chapter inclusion.

Fall back to full rewrite only when a defined threshold says the chapter genuinely needs to be re-written end-to-end.

## Reference pattern (read first)

- `src/pipeline/voice-grit-pass.ts` — `applyVoiceGritPatches` is the canonical patch-apply implementation. Mirror its validation, skip-reasoning, and atomic-discard structure.
- `src/types/index.ts` — `GritPatch`, `GritPlan`, `VoiceGritDiff` are the canonical patch-shape types.
- `src/pipeline/localized-audit-patch.ts` — existing narrow patch path for temporal audit issues. The new shared helper supersedes it; mark the file for deletion at the end of the PR after migrating its one regression test.
- `docs/voice-grit-spec.md` — the canonical patch-contract spec. Mirror its structure when writing `docs/revision-patch-spec.md`.
- AGENTS.md "Publish-candidate immutability" + "Validator-only blocking" rules — both still apply unchanged after the port.

## New shared patch shape

### Types (add to `src/types/index.ts`)

```ts
export type IssueOrigin =
  | "judge-blocking"
  | "judge-weakness"
  | "judge-revision-action"
  | "judge-issue-error"
  | "judge-issue-warning"
  | "audit-error-model"
  | "audit-error-validator"
  | "audit-warning-model"
  | "audit-warning-validator"
  | "validator-warning"
  | "validator-error";

export interface TrackedIssue {
  // Stable identifier the patch planner uses in `errorRef`. Engine-assigned,
  // not model-assigned. Format: `${origin}#${index}` (e.g., "audit-error-model#3").
  id: string;
  origin: IssueOrigin;
  // Short single-sentence summary. Render in prompts; never paste in full audit JSON.
  title: string;
  // Optional concrete fix hint from the source (audit's `fixInstruction`,
  // judge's `revisionAction` text). One short paragraph max.
  fixHint: string | null;
  // Whether the planner MUST address this issue. True for blocking/error
  // origins; false for warnings/advisories.
  mandatory: boolean;
}

export interface RevisionPatch {
  // The TrackedIssue.id this patch addresses. The planner must reference
  // a known issue id from the input bundle (or "manual" for self-directed
  // patches inside a structural rewrite path — rare; logged).
  errorRef: string;
  // Exact existing prose. Must match exactly once in the working prose for
  // the patch to apply. Use 2-4 disambiguating context words when the
  // semantic match would otherwise be ambiguous.
  originalText: string;
  // Replacement string. Empty string means delete.
  replacementText: string;
  // One short sentence tying the patch to the error and naming the
  // improvement (e.g., "Removes Beckwith's visual access to Cole while
  // preserving the dialogue").
  justification: string;
}

export interface RevisionPlan {
  patches: RevisionPatch[];
  // Optional length-band extension. Only honored when ALL other mandatory
  // errors are patched AND a length-band miss remains. Appended at the end.
  scopedExtension?: string | null;
  // For each tracked issue id present in input, the planner declares its
  // intent. Missing ids are treated as `unaddressed` with reason "no entry".
  issueOutcomes: Array<{
    id: string;
    status: "patched" | "skipped" | "unaddressed";
    reason: string;
  }>;
  notes: string[];
  // Model self-escalation. Engine respects this for revision pass; ignored
  // for continuity-fix (audit errors are surgical by construction).
  requiresStructuralRewrite: boolean;
  structuralRewriteReason: string | null;
}

export interface RevisionDiff {
  status:
    | "applied"
    | "no-patches"
    | "skipped"
    | "structural-rewrite"
    | "validators-failed"
    | "post-fix-regressed";
  reason: string;
  appliedPatches: RevisionPatch[];
  skippedPatches: Array<RevisionPatch & { skipReason: string }>;
  // Per-issue accountability: every TrackedIssue in input appears here.
  issueCoverage: Array<{
    id: string;
    origin: IssueOrigin;
    title: string;
    status:
      | "patched"          // a patch with this errorRef applied successfully
      | "skip-validation"  // a patch existed but the engine skipped it
      | "skip-planner"     // the planner self-declared skip with reason
      | "unaddressed"      // neither a patch nor a planner declaration
      | "covered-by-other";// the planner declared this covered by another patch
    reason: string | null;
  }>;
  preProse: string;
  finalProse: string;
}
```

Both `fix-continuity` and `revise-draft` use this same shared shape. Two stages, one mechanism.

## Per-issue accountability (closes Category 3 gap)

Every issue passed to the planner has a stable id assigned BY the engine, not the model. The planner can `errorRef` an id. After the engine applies patches, it produces `issueCoverage` showing every input issue's outcome. Operators can grep the diff for `unaddressed` to find dropped issues.

The engine assigns ids deterministically from origin + index. Helper `buildTrackedIssues(review, audit, validators)` lives in `src/pipeline/track-issues.ts` (NEW) and is the single source of truth for issue id mint format.

## Advisory signal handling (closes Category 2 gap, partial)

Today, warning-severity issues from judge, audit, and validators are documented but never fed to a fix stage. With patches being cheap, the planner gets them as **advisory** input alongside mandatory issues. Rule:

- **Mandatory issues** (judge blocking + weaknesses + revisionActions + error-severity issues; audit error-severity model-source) — the planner MUST address each with either a patch or an `issueOutcomes` entry justifying the skip.
- **Advisory issues** (judge warning + audit warning + validator warning + validator-only-downgraded errors) — the planner MAY propose patches when the fix is obvious and cheap (e.g., a single phrase repeated 4× → swap 2 instances; a single over-composed cluster → trim its densest sentence). The planner MUST emit an `issueOutcomes` entry for each advisory id it sees, either patching it or declaring `skipped` with a reason.

The "MUST emit an entry" rule is what gives Category 2 partial coverage without committing the engine to act on every false-positive. The planner has discretion; the diff has accountability.

Validators that are "warning-only forever" per AGENTS.md (PARAGRAPH_DISTRIBUTION, NAMED_CHARACTER_CAP, INVERTED_NP_CONTRAST, WITHHOLDING_TIC, EXPLANATORY_BECAUSE_CLUSTER) flow into the advisory list. Knowledge-leak and entity-without-blueprint-support validators also flow in as advisory. Whether the planner acts on any of them is a per-instance literary judgment.

## Context hygiene — what each planner sees

The patch planners run on dramatically less context than the current full-rewrite stages. Specific bundles:

### Continuity-fix patch planner input

```
<tracked_issues>
  ${TrackedIssues filtered to: audit-error-model + audit-error-validator + audit-warning-model + audit-warning-validator + validator-warning}
  Format: each issue on one line as `[${id}] ${origin}: ${title} — ${fixHint or "no hint"}`
</tracked_issues>

<chapter_prose>
  ${full prose}
</chapter_prose>

<pov_context>
  Only include character voice card lines for POVs implicated by at least one issue's title or fixHint.
  Format: `${name} (${role}): notices=${noticingEngine}; traits=[...]; knowledgeBoundary=${...}`
  Skip when no issue mentions a POV character.
</pov_context>

<previous_chapter_anchor>
  Last 200 words of the previous chapter, INCLUDED ONLY when at least one issue's title or fixHint
  mentions continuity, timeline, or callback. Otherwise omitted entirely.
</previous_chapter_anchor>
```

Estimated input: ~6-10k tokens for a typical chapter+audit. Compare to today's ~18k for fix-continuity.

NOT included: genre contract, story promise, market positioning, full chapter packet, rolling memory, motif bank, style rules, anti-patterns, voice target. Patches don't need them. If the model needs a piece of context for an unusual issue, the fixHint already includes it.

### Revision-pass patch planner input

```
<tracked_issues>
  ${TrackedIssues filtered to: judge-blocking + judge-weakness + judge-revision-action + judge-issue-error + judge-issue-warning + validator-warning}
  Format: each issue on one line as above.
</tracked_issues>

<score_summary>
  overall: ${overallScore}
  failing dimensions: [${dim}:${score}, ...]  // dims below 80
  strongest dimensions: [${dim}:${score}, ...]  // top 3
</score_summary>

<draft_prose>
  ${full draft prose}
</draft_prose>

<pov_voice_cards>
  Only POVs used in this draft (parsed from prose or declared in spec.scenePlan).
  Format same as continuity-fix.
</pov_voice_cards>

<approved_spec_purpose>
  ${spec.purpose}  // one sentence; planner needs it for DOMINANT JOB DISCIPLINE consistency
</approved_spec_purpose>
```

Estimated input: ~8-12k tokens. Compare to today's ~30-40k for revision.

NOT included: full spec JSON, genre contract, market promise, motif bank, rolling memory, handoff memory, previous chapter, anti-patterns wall, voice target target lines. The planner is fixing issues that are already specifically identified by the judge.

### Structural-rewrite path (fallback) input

Unchanged from today's revision-pass context. Whole-chapter rewrites need the wider context because they're remaking the chapter. That's why the threshold exists: limit this expensive context bundle to the cases that actually need it.

## Stage-by-stage behavior

### `continuity-fix` (always patches, no fallback)

Audit errors are surgical by construction (specific marker + before/after state, or a specific quoted line + correction). Convert to patch-list **with no full-rewrite fallback**.

1. Drop `maxOutputTokens` from 16,000 to **3,000**. Keep `thinkingBudgetTokens` at 3,500.
2. Opus returns a `RevisionPlan` via structured output. `requiresStructuralRewrite` MUST be false; if the model sets it true, treat as a hard error and surface `BLOCKED_PROVIDER_FAILURE` with the model's reason as the message.
3. Deterministic apply via `applyRevisionPatches` (new shared helper in `src/pipeline/apply-revision-patches.ts`).
4. Re-judge + re-audit + publish-candidate ratchet unchanged.

### `revise-draft` (hybrid: patches by default, structural rewrite at threshold)

1. Drop `maxOutputTokens` on the patch path from 24,000 to **4,000** (covers ~15 patches with comfortable headroom). Keep full-rewrite path at 24,000.
2. Decision happens BEFORE the model is called, in `run-chapter.ts`:

```ts
function shouldStructurallyRewrite(review: DraftReview): {
  rewrite: boolean;
  reason: string | null;
} {
  const cfg = config.qualitySettings.revisionRouting;
  const sb = review.scoreBreakdown;

  // (1) Catastrophic voice failure — patches can't recover the chapter's voice.
  if (sb.voiceConsistency < cfg.voiceConsistencyFloorForPatch) {
    return { rewrite: true, reason: `voiceConsistency ${sb.voiceConsistency} below patch floor ${cfg.voiceConsistencyFloorForPatch}` };
  }

  // (2) Multi-dimensional literary failure — the chapter is broken across the
  // rubric. Patches would explode in count.
  const failingDims = Object.entries(sb)
    .filter(([k, v]) => k !== "repetitionPenalty" && v < cfg.dimensionFailingFloor)
    .map(([k]) => k);
  if (failingDims.length >= cfg.maxFailingDimensionsForPatch) {
    return { rewrite: true, reason: `${failingDims.length} dimensions below ${cfg.dimensionFailingFloor}: ${failingDims.join(", ")}` };
  }

  // (3) Structural hook weak — patches at the structural pivots are
  // higher-risk than a targeted rewrite (the tournament will further polish).
  if (sb.openingPower < cfg.structuralHookFloor || sb.endingHookStrength < cfg.structuralHookFloor) {
    return { rewrite: true, reason: `structural hook below ${cfg.structuralHookFloor}` };
  }

  return { rewrite: false, reason: null };
}
```

3. Default config (add to `src/config.ts`):

```ts
revisionRouting: {
  voiceConsistencyFloorForPatch: 70,
  dimensionFailingFloor: 70,
  maxFailingDimensionsForPatch: 3,
  structuralHookFloor: 70,
  maxPatchesPerPlan: 15,
},
```

4. When `shouldStructurallyRewrite` returns `rewrite: true`, run the existing whole-chapter revision (24,000 token cap). When it returns false, run the patch path.
5. Patch path also respects **model self-escalation**: if Opus's `RevisionPlan` comes back with `requiresStructuralRewrite: true` AND a non-null `structuralRewriteReason`, the engine retries through the structural-rewrite path (one retry max).
6. Patch path also escalates when the plan would exceed `maxPatchesPerPlan` (15). The model emits an empty patch list with `requiresStructuralRewrite: true` and an auto-generated reason ("Issue count exceeds patch budget").

### `generate-draft` (initial write — unchanged)

The initial draft has no prior prose to patch. Full write is correct. Leave alone.

### `voice-grit-pass` (already patches — unchanged)

Already patch-based. Untouched.

### `tournament` (already zone-spliced — unchanged in mechanism; gated by score)

Already targeted. Mechanism untouched. Conditional skip added below (see "Pipeline parallelization and skip-gating").

## Pipeline parallelization and skip-gating

Three orthogonal speedups in this PR. All are quality-neutral by construction: parallelization changes order without changing work, and the skip gates only fire on chapters the judge has already scored as clean in those specific dimensions.

### Parallelize voice-grit-plan with tournament candidate generation

Currently sequential:

```
voice-grit-plan (Opus)
  → voice-grit-apply (deterministic)
  → [tournament-opening-candidate (Opus), tournament-ending-candidate (Opus)] (parallel)
  → tournament-splice + tournament-selection
```

After:

```
[voice-grit-plan (Opus), tournament-opening-candidate (Opus), tournament-ending-candidate (Opus)] (3-way parallel)
  → voice-grit-apply (deterministic, runs first)
  → tournament-splice + tournament-selection (runs second on the voice-grit-applied prose)
```

The AGENTS.md invariant "voice-grit applies before tournament splices" is preserved — only the **generation** phase parallelizes. The application phase still sequences voice-grit then tournament so the tournament owns its reserved zones.

Implementation: in `src/pipeline/run-chapter.ts`, replace the sequential `voiceGritPlan → applyVoiceGrit → tournament` block with `Promise.all([voiceGritPlan, openingCandidate, endingCandidate])` followed by sequential apply + tournament-splice + tournament-selection. Tournament candidates are generated against the **selected** (post-judge) prose, not the voice-grit-applied prose, because at parallel-launch time voice-grit hasn't applied yet. This is a no-op change in practice: voice-grit only touches non-reserved zones, so the opening/ending candidate's source context is identical either way.

Saves: ~1 Opus round-trip per chapter (10–20s). Zero quality impact.

### Skip-voice-grit gate

When the literary judge review reports BOTH:

- `repetitionPenalty < qualitySettings.voiceGritSkipBelowRepetitionPenalty` (default **15**)
- No `voice-tic` or `repeated-effect` signal in `weaknesses` / `revisionActions` / `issues` (case-insensitive substring scan for `"voice-tic"`, `"repeated-effect"`, `"repeated phrase"`, `"signature phrase"`, `"tic"`)

…skip the voice-grit pass entirely. Persist `chapter-N-voice-grit-skipped.json` recording the skip reason and the trigger scores. The chapter proceeds straight to the opening/ending tournament (or the tournament's own skip gate, below).

Add to `src/config.ts`:

```ts
voiceGritSkipBelowRepetitionPenalty: 15,
```

Saves: 1 Opus call (voice-grit-plan) + 1 OpenAI call (voice-grit-rejudge) = ~15–30s.

Quality argument: voice-grit exists to fix repetition. When the judge says there's no repetition to fix, voice-grit has no work to do. The threshold of 15 is conservative — the judge fires `repetitionPenalty` aggressively at the slightest pattern, so anything below 15 is effectively clean.

### Tournament skip gate

When the literary judge review reports BOTH:

- `openingPower ≥ qualitySettings.tournamentSkipMinZoneScore` (default **92**)
- `endingHookStrength ≥ qualitySettings.tournamentSkipMinZoneScore` (default **92**)

…skip the opening/ending tournament entirely. Persist `chapter-N-tournament-skipped.json` recording skip reasons + trigger scores.

Add to `src/config.ts`:

```ts
tournamentSkipMinZoneScore: 92,
```

Saves: 2 Opus candidate calls + 2 OpenAI selection calls = ~30–60s.

Quality argument: at 92+ on both zone hooks, the chapter's structural pivots are already excellent. The tournament's expected lift is statistically negligible (judge dimensions cap at 100; getting from 92 to 95 is a finer pass than from 85 to 92). The publish-candidate ratchet still protects downstream; bypassing the tournament removes a no-op stage, not a load-bearing one.

### Stage interaction matrix

| Voice-grit | Tournament | Publish-candidate source |
|---|---|---|
| Runs | Runs | Post-tournament prose (today's path) |
| **Skipped** | Runs | Post-judge prose → tournament splices on it directly |
| Runs | **Skipped** | Post-voice-grit prose |
| **Skipped** | **Skipped** | Post-judge prose; selection becomes publish-candidate directly |

The publish-candidate immutability rule and the publish-candidate ratchet behave identically across all four cases. Skips are logged; nothing is silently dropped.

## Shared apply helper

Create `src/pipeline/apply-revision-patches.ts` exporting `applyRevisionPatches(params: { prose: string; patches: RevisionPatch[]; maxPatches: number; })`. Both `continuity-fix` and `revise-draft` use this same helper. Mirror `applyVoiceGritPatches`'s structure exactly:

- Validate `originalText` non-empty.
- Validate `originalText` appears **exactly once** in current working prose; skip with reason `"zero-match"` or `"multi-match"` otherwise.
- Apply via `String.prototype.replace` in plan order; each subsequent patch operates on the post-previous-patch state.
- Reject patches whose `originalText` is the entire chapter (defense against the model trying to whole-rewrite via one giant patch). Skip reason: `"whole-prose-replacement"`.
- Cap applied count at `maxPatches`; remainder skipped with reason `"patch-budget-exceeded"`.
- Reject patches whose `errorRef` does not match any known TrackedIssue id; skip reason `"unknown-error-ref"`. (Manual ids are allowed but logged.)

## Files to touch

Direct edits:

- `src/types/index.ts` — add `TrackedIssue`, `IssueOrigin`, `RevisionPatch`, `RevisionPlan`, `RevisionDiff`.
- `src/pipeline/track-issues.ts` (NEW) — `buildTrackedIssues(review, audit, validators) → TrackedIssue[]` plus id-mint helpers.
- `src/pipeline/apply-revision-patches.ts` (NEW) — shared deterministic apply helper + `issueCoverage` builder.
- `src/pipeline/fix-continuity.ts` — replace whole-prose contract with plan-then-apply via shared helper. Export `planContinuityFix`. Drop the old wholesale-rewrite path entirely.
- `src/pipeline/revise-draft.ts` — add `planRevisionPatches` (new) plus keep `reviseDraft` as the structural-rewrite fallback. Single `reviseDraft` export becomes a router that picks between the two modes based on `shouldStructurallyRewrite` + model self-escalation. Export `shouldStructurallyRewrite`.
- `src/pipeline/run-chapter.ts` — call site for revision now consults `shouldStructurallyRewrite`. Continuity-fix call site shape unchanged but expects new artifact diff. Publish-candidate ratchet runs unchanged after either mode. **Also**: replace the sequential `voiceGritPlan → applyVoiceGrit → tournament` block with a 3-way `Promise.all` for voice-grit-plan + opening-candidate + ending-candidate generation, followed by sequential apply. Add the skip-voice-grit and skip-tournament score gates (read judge review scores; persist `chapter-N-voice-grit-skipped.json` / `chapter-N-tournament-skipped.json` artifacts with reason + trigger scores; bypass the respective stages).
- `src/config.ts` — update `continuityFix` stage profile (`maxOutputTokens: 3000`). Add `revisionPatch` stage profile (`maxOutputTokens: 4000`, mirror `revision`'s other params). Add `revisionRouting` block to `qualitySettings`. Add `voiceGritSkipBelowRepetitionPenalty: 15` and `tournamentSkipMinZoneScore: 92` to `qualitySettings`.
- `src/pipeline/estimate-cost.ts` — update both stages' cost rows. Continuity-fix drops to plan-size. Revision shows two possible paths.
- `src/pipeline/localized-audit-patch.ts` — delete after migrating its existing temporal-patch regression test to `tests/apply-revision-patches.test.ts`. The new shared helper covers temporal patches uniformly.

Tests:

- `tests/apply-revision-patches.test.ts` (NEW):
  - Clean apply of 5 patches against a synthetic chapter
  - Patch with zero matches → skipped `"zero-match"`
  - Patch with multi matches → skipped `"multi-match"`
  - Patch whose `originalText` equals entire prose → skipped `"whole-prose-replacement"`
  - Patch with unknown `errorRef` → skipped `"unknown-error-ref"`
  - `maxPatches` cap honored, overflow skipped with reason
  - Patches applied in plan order; later patches see post-earlier state
  - `issueCoverage` reports every input issue's outcome including `unaddressed`
- `tests/track-issues.test.ts` (NEW):
  - Mandatory vs advisory split for every IssueOrigin
  - Stable ids across runs (deterministic minting)
  - Validator-only error included as mandatory pre-downgrade; advisory post-downgrade (this happens upstream)
- `tests/system-rules.test.ts` — add:
  - `shouldStructurallyRewrite` returns `true` for catastrophic voiceConsistency, multi-dim failure, weak structural hooks
  - `shouldStructurallyRewrite` returns `false` for the chapter-2-style profile (92.15, 5 small issues)
  - `RevisionPlan` with `requiresStructuralRewrite: true` triggers structural rewrite path
- `tests/runtime-safety.test.ts` — adjust assertions for new artifact shape; preserve existing ratchet/downgrade behavior tests.
- `tests/context-budget.test.ts` (NEW):
  - Continuity-fix planner prompt for a representative input is under 12,000 tokens (assert via `tokenCount` heuristic or character cap as a proxy).
  - Revision-patch planner prompt for a representative input is under 16,000 tokens.
  - Structural rewrite prompt is unchanged from today (sanity test).
- `tests/skip-gates.test.ts` (NEW):
  - Skip-voice-grit gate fires when `repetitionPenalty: 12` and no tic/effect signals → asserts voice-grit-skipped artifact persists with reason and `voice-grit-applied.json` does NOT exist.
  - Skip-voice-grit gate does NOT fire when `repetitionPenalty: 22` (above threshold) → voice-grit runs normally.
  - Skip-voice-grit gate does NOT fire when `repetitionPenalty: 12` but `weaknesses` contains "repeated phrase" → voice-grit runs normally.
  - Skip-tournament gate fires when `openingPower: 94, endingHookStrength: 95` → tournament-skipped artifact persists; tournament-merged.json does NOT exist.
  - Skip-tournament gate does NOT fire when `openingPower: 88, endingHookStrength: 95` → tournament runs normally.
  - All four matrix cells (both run / voice-grit skipped / tournament skipped / both skipped) produce a valid publish-candidate.
- `tests/pipeline-parallelization.test.ts` (NEW):
  - Smoke fixture records stage start/end timestamps. Voice-grit-plan starts BEFORE voice-grit-apply finishes. Opening-candidate and ending-candidate start BEFORE voice-grit-apply finishes. Voice-grit-apply finishes BEFORE tournament-splice starts.
  - All three generation calls share an overlapping wall-time window (deterministic in smoke mode where each "model call" is a no-op promise).

Docs:

- `docs/revision-patch-spec.md` (NEW) — one-page contract mirroring `docs/voice-grit-spec.md`. Covers BOTH continuity-fix and revision-patch (they share the type/apply shape).
- AGENTS.md — update relevant hot-spot bullets: revision pass and continuity-fix both default to patches. Document `revisionRouting` thresholds, `TrackedIssue` accountability, advisory-signal handling, context-hygiene principles.
- `.cursor/rules/memory-and-audit-hotspots.mdc` — same updates.
- `.cursor/rules/pipeline-contract.mdc` — add bullets for `revisionRouting`, shared patch contract, and per-issue accountability.
- README.md if it documents the fix loop or revision; update only existing references.

## Invariants that MUST be preserved

- `qualitySettings.maxFixAttempts` (default 2) — unchanged.
- The validator-only downgrade rule (`downgradeValidatorOnlyErrors`) — unchanged. Runs BEFORE the patch planner sees the issue list, so downgraded errors arrive as advisory.
- The publish-candidate ratchet (`shouldRevertToPublishCandidate`) — unchanged. Runs after EVERY mode.
- Reserved zones for voice-grit and tournament — unchanged. Revision patches MAY touch reserved zones; tournament still owns its zones downstream.
- Audit contract (`FinalAuditReport` shape, severity rules, `source` tagging) — unchanged.
- Skip-revision path — unchanged. When the first draft clears `skipRevisionThreshold` with no blocking signals, no patch/rewrite runs.
- CLI exit code semantics (1 = unexpected runtime, 2 = blocked pipeline) — unchanged.
- Smoke mode determinism — preserved. Smoke paths return deterministic empty `RevisionPlan` with `issueOutcomes` declaring every issue as `skipped: "smoke"`. Skip gates work the same way in smoke (smoke review fabricates scores that exercise both run-and-skip paths in tests).
- Artifact paths (`chapter-N-fix-attempt-K.json`, `chapter-N-revised-draft.json`) — same paths, new payload shape.
- Voice-grit before tournament — sequencing of APPLICATION (apply voice-grit before tournament splices) is unchanged. Only generation runs in parallel.
- AGENTS.md "Voice-grit and tournament are advisory and fail-soft" — unchanged. Skip gates are an additional fail-soft path: throwing in either stage's generation still leaves `selected` unchanged downstream.

## Acceptance criteria

1. `npm run typecheck && npm test` pass.
2. The chapter 2 publish-candidate's five real errors can be expressed as a five-patch plan and applied without invoking a whole-chapter rewrite. Use the actual `chapter-2-publish-candidate.json` + `chapter-2-final-audit.json` as a fixture in a new integration-shaped unit test.
3. A synthetic "broken chapter" (voiceConsistency 55, 4 dimensions below 70) routes to structural rewrite via `shouldStructurallyRewrite`.
4. A synthetic "lightly weak chapter" (voiceConsistency 78, one dimension 78, rest above 85) routes to patch path.
5. **Per-issue accountability**: `issueCoverage` in a produced `RevisionDiff` contains an entry for every TrackedIssue passed to the planner. No `unaddressed` entry can be silently dropped — running `--audit-only` after a fix run prints a coverage summary including unaddressed counts.
6. **Context budget**: continuity-fix planner prompt is ≤ 12,000 tokens; revision-patch planner prompt is ≤ 16,000 tokens; structural-rewrite prompt is unchanged.
7. Estimated cost per continuity-fix attempt drops by at least 5×. Patch-path revision drops by at least 4×. Structural-rewrite revision unchanged.
8. Publish-candidate ratchet still reverts on regression, regardless of mode.
9. Smoke runs (`npm run smoke`) still produce a clean deterministic chapter with no real provider calls.
10. **Wall-time**: a clean-scoring chapter run (clean enough to trip both skip gates) generates without the voice-grit pass or the tournament. Skip artifacts persist with reason and trigger scores.
11. **Parallelization**: smoke-mode pipeline-parallelization test asserts voice-grit-plan, opening-candidate, and ending-candidate all start before voice-grit-apply runs.

## Out of scope

- Do NOT touch `generate-draft` (initial write — nothing to patch).
- Do NOT touch the literary judge, voice-grit, tournament, audit, or any blueprint compile stage.
- Do NOT change CLI flags or exit code semantics.
- Do NOT add a 16th rubric dimension.
- Do NOT regenerate or hand-edit any published chapter. The chapter 2 publish-candidate becomes a test fixture; that's sufficient.
- Do NOT delete or rewrite existing artifacts under `artifacts/`.
- Do NOT introduce new MCP or external dependencies.
- Do NOT add a routing decision to continuity-fix (it's always patches; the chapter 2 evidence proves audit errors are always surgical by construction).
- Do NOT make threshold values runtime-tunable via CLI flags. They are `qualitySettings` config — file-edit only.
- Do NOT promote any "warning-only forever" validator to error severity. Advisory-signal handling means the planner SEES warnings; it doesn't mean warnings become blocking.

## Why this is the right architecture

- **The publish-candidate ratchet already exists** *because* full rewrites empirically regress good prose. Removing the rewrite where it isn't needed addresses the root cause; the ratchet remains as a safety net for the rewrite path that's still appropriate.
- **The model's reasoning load with patches is O(error count)**, not O(chapter length). With patches, the model reads "the timestamp on line 14 says 2318Z, anchor implies 2300Z, propose a fix" — three sentences of reasoning per error.
- **Context cleanliness is the second win**. Patch planners get only the issues + the prose + a narrow POV slice. Today's stages receive the full blueprint, genre contract, market promise, rolling memory, handoff memory, previous chapter, motif bank, voice target, anti-pattern wall, style rules, and chapter packet. Cleaner input → sharper output.
- **Per-issue accountability is the third win**. Every tracked issue has a deterministic id, every patch references one, every input id appears in `issueCoverage` after apply. Silent issue drops become impossible.
- **Patches are auditable** as a human-readable changelog. A whole rewrite is a wall of prose with no diff.
- **Truncation failure mode is eliminated** for surgical fixes. The chapter 2 `BLOCKED_PROVIDER_FAILURE` becomes structurally impossible.
- **Parallelization is free quality**. Running voice-grit-plan alongside tournament-candidate generation does the same work in less wall time. No tradeoff.
- **Skip gates are conservative**. They fire only on chapters the literary judge has already scored as clean in the relevant dimensions. A chapter that needs polish never trips a skip gate; only a chapter where polish would be no-op skips polish. The publish-candidate ratchet still runs, so skips don't lose the regression safety net for any downstream fix attempts.

## When to stop

Stop after acceptance criteria are met. Do not extend the patch shape to spec generation, spec revision, or any other stage in this PR — those are JSON, cheap, and not subject to the "preserve good prose" concern. The goal here is one bounded, reviewable change: every prose-output stage that's fixing problems uses patches by default, falls back to full rewrite only when the chapter genuinely needs structural reshaping, surfaces advisory signals to the planner without enforcing action on them, accounts for every input issue in the diff, runs on a minimal context bundle, parallelizes independent generation stages, and skips polish stages that have no work to do.

Speedups deferred (out of scope here; require empirical quality measurement before adoption): lowering `selfRedTeam` and `chapterDelta` reasoning effort from `high` to `medium`; using Claude Sonnet for voice-grit-plan and tournament candidate generation. Both are tracked for a follow-up PR after this one ships.

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

## Implementation order (suggested)

The dependency graph is linear; follow this order to avoid wasted work:

1. **Types first**: add `TrackedIssue`, `IssueOrigin`, `RevisionPatch`, `RevisionPlan`, `RevisionDiff` to `src/types/index.ts`. Delete `ContinuityFixResult` last (after callers migrated).
2. **Shared utilities**: extract `parseAnthropicJson` to `src/utils/parse-anthropic-json.ts`; update `generate-spec.ts` to import from the new location (zero behavior change). Add `src/pipeline/revision-plan-schema.ts` with `validateRevisionPlan`.
3. **Helpers**: implement `src/pipeline/track-issues.ts` (issue id minting + mandatory/advisory split) and `src/pipeline/apply-revision-patches.ts` (patch apply + scopedExtension + issueCoverage reconciliation). Both are pure functions, immediately unit-testable.
4. **Planners**: implement `planContinuityFix` in `src/pipeline/fix-continuity.ts` (replaces the old wholesale-rewrite body; delete `ContinuityFixResult` and `applyFixResult` here; add the new `applyRevisionDiffToSelected` helper). Implement `planRevisionPatches` + `shouldStructurallyRewrite` + the `reviseDraft` router in `src/pipeline/revise-draft.ts` (keep the old whole-chapter body, renamed `runStructuralRewrite`, as the fallback).
5. **Config**: update `continuityFix` profile, add `revisionPatch` profile, add `revisionRouting` to `qualitySettings` in `src/config.ts`.
6. **Orchestrator**: update the single revision call site in `src/pipeline/run-chapter.ts` to destructure `{ artifact, usageStage }` and pass `usageStage` to `collectUsage`. Update the continuity-fix call site to expect the new `RevisionDiff` payload.
7. **Cost estimate + cleanup**: update `src/pipeline/estimate-cost.ts`. Delete `src/pipeline/localized-audit-patch.ts` after migrating its test.
8. **Tests**: add the new test files (parser, schema, apply-revision-patches, track-issues, validator-only-path, planner-failure-paths). Update existing tests that reference deleted shapes.
9. **Docs**: write `docs/revision-patch-spec.md`. Update AGENTS.md and `.cursor/rules/*.mdc` to reflect new hot spots.

Do not commit unless the user explicitly asks. The project's commit-hygiene rule (`.cursor/rules/commit-hygiene.mdc`) and git-identity rule (`.cursor/rules/git-identity.mdc`) require explicit user approval for every commit, and the auto-push policy means commits push immediately to GitHub — so committing-without-asking pushes-without-asking. **If** the user does ask for commits, each numbered step above is independently committable, and smaller commits give more recovery points. The only hard ordering constraint is: types before consumers, helpers before planners, planners before orchestrator. `npm run typecheck && npm test` between steps is recommended; mandatory before any user-requested commit.

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
  | "audit-warning-validator";

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
  // a known issue id from the input bundle. Patches with no matching id
  // are skipped at apply time with reason "unknown-error-ref"; the engine
  // never accepts free-form ids.
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
  // Status reflects only what `applyRevisionPatches` itself can determine
  // from the plan + patch outcomes. Downstream concerns (re-judge regression,
  // validator failures, structural-rewrite escalation) are owned by the
  // orchestrator and the publish-candidate ratchet — they do NOT mutate
  // this diff after the helper returns.
  status:
    | "applied"     // at least one patch landed (with or without other skips)
    | "no-patches"  // planner emitted zero patches and no scopedExtension
    | "skipped";    // patches were emitted but every one was skipped at apply time
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

Both `fix-continuity` and `revise-draft` use this same shared shape. Two stages, one mechanism — but they **persist it differently**:

| Stage | Primary artifact (returned by stage fn) | Sidecar artifact |
|---|---|---|
| `continuity-fix` patches | `chapter-N-fix-attempt-K.json` carries `ArtifactEnvelope<RevisionDiff>` (replaces the deleted `ContinuityFixResult`). Engine applies `RevisionDiff.finalProse` to the `SelectedChapter` via `applyRevisionDiffToSelected`. | None — the fix-attempt artifact is the diff. |
| `revise-draft` patches | `chapter-N-revised-draft.json` carries `ArtifactEnvelope<ChapterDraft>` (unchanged shape — `{prose, wordCount}`). Downstream consumers (`judgeDraft`, `selectDraft`) read this exactly as today. | `chapter-N-revision-diff.json` (NEW) carries `ArtifactEnvelope<RevisionDiff>` for accountability + debugging. |
| `revise-draft` structural rewrite (fallback) | `chapter-N-revised-draft.json` carries `ArtifactEnvelope<ChapterDraft>` (unchanged from today). | No diff sidecar (no patch list exists for a full rewrite). |

The asymmetry is deliberate: the continuity-fix artifact already lives at `chapter-N-fix-attempt-K.json` and has no downstream consumer beyond `applyFixResult` (which this PR replaces with `applyRevisionDiffToSelected`), so switching its payload to `RevisionDiff` is contained. The revised-draft artifact is consumed by `judgeDraft` and `selectDraft`, which expect `ChapterDraft.prose`. Keeping that contract intact eliminates downstream churn; the `RevisionDiff` lives alongside as a sidecar.

## Per-issue accountability (closes Category 3 gap)

Every issue passed to the planner has a stable id assigned BY the engine, not the model. The planner can `errorRef` an id. After the engine applies patches, it produces `issueCoverage` showing every input issue's outcome. Operators can grep the diff for `unaddressed` to find dropped issues.

The engine assigns ids deterministically from origin + index. Helper `buildTrackedIssues({ review?, audit? })` lives in `src/pipeline/track-issues.ts` (NEW) and is the single source of truth for issue id mint format. No separate `validators` argument: PR1 has no revision-time validator artifact (validators only run during final audit), and at continuity-fix time, validator-origin issues are already merged into `audit.issues` with `source: "validator"` via the existing `mergeAuditWithValidator` step. Each call site passes only the inputs available at its point in the pipeline:

- Revision-pass planner: `buildTrackedIssues({ review })` — judge issues only.
- Continuity-fix planner: `buildTrackedIssues({ audit })` — merged audit (model-source + validator-source) only.

## Advisory signal handling (closes Category 2 gap, partial)

Today, warning-severity issues from judge, audit, and validators are documented but never fed to a fix stage. With patches being cheap, the planner gets them as **advisory** input alongside mandatory issues — **when a planner is already running**. Rule:

- **Mandatory issues** (judge blocking + weaknesses + revisionActions + error-severity judge issues; audit error-severity issues from EITHER source — see the validator-only path below for when validator-source errors do or don't reach the planner) — the planner MUST address each with either a patch or an `issueOutcomes` entry justifying the skip.
- **Advisory issues** (judge warning + audit warning, including validator-source audit warnings — i.e., **original-severity warnings only**, never post-downgrade errors) — the planner MAY propose patches when the fix is obvious and cheap (e.g., a single phrase repeated 4× → swap 2 instances; a single over-composed cluster → trim its densest sentence). The planner MUST emit an `issueOutcomes` entry for each advisory id it sees, either patching it or declaring `skipped` with a reason.

The "MUST emit an entry" rule is what gives Category 2 partial coverage without committing the engine to act on every false-positive. The planner has discretion; the diff has accountability.

### When advisory warnings actually reach a planner

This PR does NOT change the trigger conditions for revision or continuity-fix. Advisory warnings flow into a planner ONLY when that planner is invoked for an independent (mandatory) reason:

- **Revision pass** is invoked only when the literary judge returns `passesThreshold: false` OR fires blocking signals. A clean-scoring chapter with judge warnings but no blocking errors skips revision entirely; those warnings never reach the revision-pass planner. This is unchanged from today's `skipRevisionThreshold` behavior.
- **Continuity-fix loop** is invoked only when the final audit reports at least one `error`-severity issue (`hasBlockingAuditIssues(audit)`). A warning-only audit never enters the fix loop; those warnings never reach the continuity-fix planner. This is unchanged from today's fix-loop trigger.

Net effect: advisory warnings are "free riders" on planner invocations that mandatory issues triggered. A chapter whose only findings are warnings remains in the same publish path it has today (no fix loop, no revision pass), and the warnings remain documented in their source artifacts as advisory-only. The patch architecture closes Category 2 *partially* — for chapters where a planner runs anyway — not universally. Universal warning handling would require new trigger conditions, which is out of scope for PR1.

Validators that are "warning-only forever" per AGENTS.md (PARAGRAPH_DISTRIBUTION, NAMED_CHARACTER_CAP, INVERTED_NP_CONTRAST, WITHHOLDING_TIC, EXPLANATORY_BECAUSE_CLUSTER) flow into the advisory list when continuity-fix runs. Knowledge-leak and entity-without-blueprint-support validators also flow in as advisory under the same condition. Whether the planner acts on any of them is a per-instance literary judgment.

### Validator-only path (unchanged from today)

When EVERY error-severity audit issue has `source: "validator"`, the existing `downgradeValidatorOnlyErrors` runs unchanged: errors flip to warnings, the cleaned audit is persisted, the fix loop breaks. **The patch planner is never called in this case.** This is the deliberate AGENTS.md rule that "deterministic validators are too false-positive-prone to overrule a literary-judge-approved chapter." The patch architecture inherits it byte-for-byte.

The "downgraded errors arrive as advisory" language from earlier drafts of this prompt was wrong — downgraded errors don't reach the planner at all, because the loop has already exited. The advisory bucket is fed by **original-severity warnings** from judge / audit / validators, not by post-downgrade errors.

## Context hygiene — what each planner sees

The patch planners run on dramatically less context than the current full-rewrite stages. Specific bundles:

### Continuity-fix patch planner input

The patch planner is **only** invoked in the mixed-source case (at least one model-source error present). The validator-only case (every error has `source: "validator"`) exits the fix loop via `downgradeValidatorOnlyErrors` BEFORE any planner call — see "Validator-only path" below.

In the mixed-source case, the planner receives both model-source and validator-source errors, since validators are not downgraded when model errors are also present. Validator errors in this case are real audit findings, not downgraded noise.

```
<tracked_issues>
  ${TrackedIssues filtered to: audit-error-model + audit-error-validator + audit-warning-model + audit-warning-validator}
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

Validators do not run until the final audit phase (after selection, voice-grit, and tournament). The revision pass runs immediately after `judgeDraft`, so no validator artifact exists yet. The revision planner therefore receives ONLY judge-sourced issues. Validator warnings flow into continuity-fix later in the pipeline, where they do exist.

```
<tracked_issues>
  ${TrackedIssues filtered to: judge-blocking + judge-weakness + judge-revision-action + judge-issue-error + judge-issue-warning}
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
2. Opus is prompted to return a `RevisionPlan` as strict JSON. The Anthropic API in this repo only emits plain text (see `src/api/anthropic.ts`), so the engine handles structured output in two steps: (a) `parseAnthropicJson<RevisionPlan>` (the shared helper at `src/utils/parse-anthropic-json.ts` — see "Files to touch") converts the model text to an object, and (b) `validateRevisionPlan(raw)` (the hand-rolled runtime validator at `src/pipeline/revision-plan-schema.ts` — see "Files to touch") asserts every required field is present and well-typed. The two-step design is deliberate: the parser is generic and reusable; the validator is shape-aware and the only enforcement of the actual `RevisionPlan` contract at runtime. Add the JSON-only instruction to the system prompt the same way `buildSpecCritiqueRequest` does ("Return strict JSON only with keys patches, scopedExtension, issueOutcomes, notes, requiresStructuralRewrite, structuralRewriteReason"). On EITHER parse failure (parser throws) OR shape-validation failure (`validateRevisionPlan` throws), the engine does **not** persist a fix-attempt artifact (there's no valid `RevisionDiff` to serialize). Instead it writes a status artifact with `status: BLOCKED_PROVIDER_FAILURE` and stores the raw model text in the status `details` field (key: `rawPlannerText`) along with `details.parseError` (the thrown error message — either parser or validator). The chapter ends in the same blocked state as today's `max_tokens` truncation, only with a different failure mode tagged.
3. `requiresStructuralRewrite` MUST be `false` in continuity-fix output; if the model sets it `true`, treat as a hard error and surface `BLOCKED_PROVIDER_FAILURE` with the model's reason as the message.
4. Deterministic apply via `applyRevisionPatches` (new shared helper in `src/pipeline/apply-revision-patches.ts`).
5. Re-judge + re-audit + publish-candidate ratchet unchanged.

### `revise-draft` (hybrid: patches by default, structural rewrite at threshold)

1. Drop `maxOutputTokens` on the patch path from 24,000 to **4,000** (covers ~15 patches with comfortable headroom). Keep full-rewrite path at 24,000.
2. Same Anthropic JSON convention as continuity-fix: Opus is prompted to return strict JSON; engine parses via `parseAnthropicJson<RevisionPlan>` then runtime-validates via `validateRevisionPlan`; parse/shape failures surface `BLOCKED_PROVIDER_FAILURE` with the raw text and parse-error message stored in the status artifact's `details` (no revised-draft artifact, no diff sidecar — only a status artifact). Same failure-handling shape as continuity-fix.
3. **Routing lives inside `reviseDraft()`**, not in `run-chapter.ts`. The router already has the `draftReviewArtifact` it needs; pushing the decision up to the orchestrator would duplicate the read and split single-responsibility. `run-chapter.ts` continues to call `reviseDraft(params)` once and gets `{ artifact, usageStage }` back regardless of path; the inner `artifact.data` is a `ChapterDraft` either way, so downstream consumers are unchanged. `reviseDraft()` internally consults `shouldStructurallyRewrite(review)` and dispatches. `shouldStructurallyRewrite` remains an exported pure function for direct unit testing:

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

4. Default config (add to `src/config.ts`):

```ts
revisionRouting: {
  voiceConsistencyFloorForPatch: 70,
  dimensionFailingFloor: 70,
  maxFailingDimensionsForPatch: 3,
  structuralHookFloor: 70,
  maxPatchesPerPlan: 15,
},
```

5. When `shouldStructurallyRewrite` returns `rewrite: true`, `reviseDraft` runs the existing whole-chapter revision (24,000 token cap, `revision` stage profile). When it returns false, `reviseDraft` runs the patch path (4,000 token cap, `revisionPatch` stage profile).
6. Patch path also respects **model self-escalation**: if Opus's `RevisionPlan` comes back with `requiresStructuralRewrite: true` AND a non-null `structuralRewriteReason`, `reviseDraft` retries internally through the structural-rewrite path (one retry max). The orchestrator sees the same `{ artifact, usageStage }` return shape either way; only `usageStage` differs to reflect which path actually ran.
7. Patch path also escalates when the plan would exceed `maxPatchesPerPlan` (15). The model emits an empty patch list with `requiresStructuralRewrite: true` and an auto-generated reason ("Issue count exceeds patch budget").
8. **Artifact contract**: `reviseDraft()` returns `{ artifact, usageStage }`; `artifact` is always `ArtifactEnvelope<ChapterDraft>` regardless of which path ran. On every path it writes `chapter-N-revised-draft.json` (the existing path, unchanged payload shape). On the patch path ONLY, it ALSO writes `chapter-N-revision-diff.json` carrying the `RevisionDiff` as a sidecar. Downstream `judgeDraft` and `selectDraft` continue to consume `artifact.data` as a `ChapterDraft` exactly as today — no signature or call-site changes required for them.
9. **Usage accounting**: `StageUsage` and `ArtifactEnvelope` do not carry a stage name today, so the orchestrator can't infer which profile ran from the returned artifact alone. The smallest-blast-radius fix is a local return wrapper: `reviseDraft()` returns `{ artifact: ArtifactEnvelope<ChapterDraft>; usageStage: "revision" | "revisionPatch" }` instead of `ArtifactEnvelope<ChapterDraft>` directly. The single caller in `run-chapter.ts` destructures both fields and passes `usageStage` into `collectUsage`. No shared types touched, no `StageUsage` / `ArtifactEnvelope` / `telemetry` plumbing changes. Without this fix the operator-visible cost report mislabels every patch-path run as a structural rewrite.

### `generate-draft` (initial write — unchanged)

The initial draft has no prior prose to patch. Full write is correct. Leave alone.

### `voice-grit-pass` (already patches — unchanged)

Already patch-based. Untouched.

### `tournament` (unchanged in PR1)

Already targeted. Mechanism and timing untouched in this PR. Conditional skip is deferred to **PR2** (see appendix at the end of this document).

## Shared apply helper

Create `src/pipeline/apply-revision-patches.ts` exporting `applyRevisionPatches(params: { prose: string; plan: RevisionPlan; trackedIssues: TrackedIssue[]; maxPatches: number; })`. Both `continuity-fix` and `revise-draft` use this same helper. The signature is wider than `applyVoiceGritPatches` because this helper does three jobs at once: patch application, scopedExtension application, and `issueCoverage` reconciliation. Mirror `applyVoiceGritPatches`'s structure where it overlaps.

Patch application rules:

- Validate `originalText` non-empty.
- Validate `originalText` appears **exactly once** in current working prose; skip with reason `"zero-match"` or `"multi-match"` otherwise.
- Apply via `String.prototype.replace` in plan order; each subsequent patch operates on the post-previous-patch state.
- Reject patches whose `originalText` is the entire chapter (defense against the model trying to whole-rewrite via one giant patch). Skip reason: `"whole-prose-replacement"`.
- Cap applied count at `maxPatches`; remainder skipped with reason `"patch-budget-exceeded"`.
- Reject patches whose `errorRef` does not match any id in `trackedIssues`; skip reason `"unknown-error-ref"`.

`scopedExtension` application rules (mirror the type comment: *"Only honored when ALL other mandatory errors are patched AND a length-band miss remains"*):

- Only applied AFTER all patch application has completed.
- Validate it is a string between 50 and 500 words; if outside that range, skip with reason `"scoped-extension-out-of-bounds"`.
- Validate at least one entry in `trackedIssues` mentions length/word-band concerns (case-insensitive substring scan on `title` + `fixHint` for `"word count"`, `"word band"`, `"length"`, `"under band"`); if no such issue exists, skip with reason `"scoped-extension-not-justified"`.
- **Validate every mandatory TrackedIssue (those with `mandatory: true`) OTHER than the length-band-related ones is resolved** — i.e., reconciles to `patched` or `covered-by-other` in the issueCoverage computed from patches applied so far. If any non-length-band mandatory issue would land in `skip-validation`, `skip-planner`, or `unaddressed`, skip the extension with reason `"scoped-extension-mandatory-issues-unresolved"` and list the unresolved ids in the diff's `notes`. This prevents the model from padding length while leaving real continuity errors broken.
- When all validations pass: append `scopedExtension` to the post-patch prose with a single blank line separator. The appended text becomes part of `finalProse`.
- When skipped at any step: the diff's `notes` records the reason. **Coverage override**: any TrackedIssue that matched the length-band detection scan has its `issueCoverage` status forcibly set to `unaddressed`, regardless of what status the reconciliation rules would otherwise assign (including `skip-planner` from a planner-emitted outcome). The override `reason` is the scopedExtension skip reason, prefixed with `"scoped-extension-skipped: "`. Rationale: when the planner declared the extension as the length-band fix mechanism and that mechanism didn't run, `unaddressed` is the correct operator-facing signal — `skip-planner` would falsely imply the planner intentionally dropped the issue.

`issueCoverage` reconciliation rules (runs last, builds the `RevisionDiff.issueCoverage` array):

- For every TrackedIssue id passed in: one entry appears in `issueCoverage`.
- `patched`: at least one applied patch's `errorRef` matches the id.
- `skip-validation`: a patch existed with this id, but it was skipped at apply time (zero-match, multi-match, whole-prose-replacement, patch-budget-exceeded, unknown-error-ref).
- `skip-planner`: the planner emitted an `issueOutcomes` entry for this id with `status: "skipped"` and no corresponding patch; the engine respects this without retry. `reason` is copied from the planner's outcome entry.
- `covered-by-other`: planner emitted an `issueOutcomes` entry with `status: "patched"` but the actual patch references a different id — the planner is declaring that one patch resolves multiple issues (e.g., a single sentence rewrite that addresses both a POV leak and a timestamp). `reason` is copied.
- `unaddressed`: the planner emitted no `issueOutcomes` entry for this id AND no patch references it. This is the audit-trail entry that prevents silent issue drops.

Output: `applyRevisionPatches` returns `RevisionDiff` (the full diff including `appliedPatches`, `skippedPatches`, `issueCoverage`, `preProse`, `finalProse`). Callers persist it (continuity-fix as the fix-attempt artifact; revise-draft as the revision-diff sidecar).

## Files to touch

Direct edits:

- `src/types/index.ts` — add `TrackedIssue`, `IssueOrigin`, `RevisionPatch`, `RevisionPlan`, `RevisionDiff`.
- `src/utils/parse-anthropic-json.ts` (NEW) — extract the existing `parseAnthropicJson<T>` helper currently private at `src/pipeline/generate-spec.ts:169` into a shared utility and export it. Update `generate-spec.ts` to import from the new location instead of defining its own. Both new patch planners (`fix-continuity.ts`, `revise-draft.ts`) will import from this shared module. No behavior change to the existing spec-critique parse path. **Important**: `parseAnthropicJson<T>` is a generic JSON parse and TypeScript's type assertion is erased at runtime — it does NOT validate that the parsed object actually conforms to `T`. Shape validation must happen separately (see next item).
- `src/pipeline/revision-plan-schema.ts` (NEW) — defines `validateRevisionPlan(raw: unknown): RevisionPlan` that runtime-checks every required field: `patches` is an array of objects each with `{errorRef: string, originalText: string, replacementText: string, justification: string}`; `issueOutcomes` is an array of objects each with `{id: string, status: "patched" | "skipped" | "unaddressed", reason: string}`; `notes` is a `string[]`; `requiresStructuralRewrite` is a `boolean`; `structuralRewriteReason` is `string | null`; `scopedExtension` is `string | null | undefined`. Throws a descriptive error (used by the caller to build `details.parseError`) on the first missing/mistyped field. Used by `planContinuityFix` and `planRevisionPatches` immediately after `parseAnthropicJson<RevisionPlan>` succeeds. Lightweight hand-rolled validator — do not introduce zod / ajv / external dependencies; mirror the style of `validateBlueprint` in `src/blueprint/parse-blueprint.ts`.
- `src/pipeline/track-issues.ts` (NEW) — `buildTrackedIssues({ review?, audit? }) → TrackedIssue[]` plus id-mint helpers. Single source of truth for issue id format. Each call site passes only what's available (revision pass passes `review`; continuity-fix passes `audit`).
- `src/pipeline/apply-revision-patches.ts` (NEW) — shared deterministic apply helper + `issueCoverage` builder.
- `src/pipeline/fix-continuity.ts` — replace whole-prose contract with plan-then-apply via shared helper. Export `planContinuityFix`. Drop the old wholesale-rewrite path entirely. **Also**: delete the `ContinuityFixResult` interface from `src/types/index.ts` and delete the `applyFixResult` helper from `fix-continuity.ts`. They are superseded by `RevisionDiff` + the new `applyRevisionDiffToSelected` helper (in `src/pipeline/apply-revision-patches.ts`), which reads `RevisionDiff.finalProse` and rebuilds the `SelectedChapter` artifact the same way `applyFixResult` did. Update all import sites (`run-chapter.ts` is the only consumer today) to call the new helper. Persisted artifact at `chapter-N-fix-attempt-K.json` switches from `ArtifactEnvelope<ContinuityFixResult>` to `ArtifactEnvelope<RevisionDiff>` — same path, new payload shape.
- `src/pipeline/revise-draft.ts` — add `planRevisionPatches` (new) plus keep the existing whole-chapter `reviseDraft` body, renamed internally as `runStructuralRewrite`, as the fallback. The single `reviseDraft` export becomes the router: it reads `draftReviewArtifact.data`, consults `shouldStructurallyRewrite(review)` + the planner's `requiresStructuralRewrite` self-escalation, dispatches to either `planRevisionPatches → applyRevisionPatches → ChapterDraft` (patch path) or `runStructuralRewrite → ChapterDraft` (fallback path). **Return type changes** from `ArtifactEnvelope<ChapterDraft>` to `{ artifact: ArtifactEnvelope<ChapterDraft>; usageStage: "revision" | "revisionPatch" }` so the caller can attribute usage correctly. The downstream `artifact.data` shape is still `ChapterDraft` — only the wrapper changes, so `judgeDraft` and `selectDraft` need no signature changes, only the single call site in `run-chapter.ts` updates to destructure. On the patch path, write `chapter-N-revised-draft.json` (`ChapterDraft`) AND `chapter-N-revision-diff.json` (`RevisionDiff` sidecar). On the structural-rewrite path, write `chapter-N-revised-draft.json` only. Export `shouldStructurallyRewrite` for unit testing; the orchestrator does NOT call it directly. Smoke path returns `usageStage: "revision"` (smoke calibration uses the structural-rewrite path's smoke prose).
- `src/pipeline/run-chapter.ts` — revision call site updates to destructure the new return shape: `const { artifact: revisedDraftArtifact, usageStage: revisionUsageStage } = await reviseDraft(params);`. The hardcoded `collectUsage(usages, config.stageProfiles.revision.stageName, revisedDraftArtifact)` (today at ~line 520) changes to `collectUsage(usages, config.stageProfiles[revisionUsageStage].stageName, revisedDraftArtifact)`. Continuity-fix call site shape unchanged but expects the new `RevisionDiff` payload at `chapter-N-fix-attempt-K.json`. Publish-candidate ratchet runs unchanged after either mode.
- `src/config.ts` — update `continuityFix` stage profile (`maxOutputTokens: 3000`). Add `revisionPatch` stage profile (`maxOutputTokens: 4000`, mirror `revision`'s other params). Add `revisionRouting` block to `qualitySettings`.
- `src/pipeline/estimate-cost.ts` — update both stages' cost rows. Continuity-fix drops to plan-size. Revision shows two possible paths.
- `src/pipeline/localized-audit-patch.ts` — delete after migrating its existing temporal-patch regression test to `tests/apply-revision-patches.test.ts`. The new shared helper covers temporal patches uniformly.

Tests:

- `tests/fixtures/chapter-2-regression/` — two fixture files (`chapter-2-publish-candidate.json` + `chapter-2-final-audit.json`) staged in the working tree at this path. These are the real artifacts from the failed chapter-2 run that motivated PR1, captured on May 17, 2026 at 18:06 / 18:10. **Pre-handoff prerequisite**: the user must `git add tests/fixtures/chapter-2-regression/ && git commit` before handing off, otherwise a fresh-clone agent won't have them. The agent does NOT generate or copy them — they are already-present files to commit then read. Do not modify the contents — the fixture's value is that it pins the exact failure case. Reference from the chapter-2-regression integration test (see acceptance criterion #2).
- `tests/apply-revision-patches.test.ts` (NEW):
  - Clean apply of 5 patches against a synthetic chapter
  - Patch with zero matches → skipped `"zero-match"`
  - Patch with multi matches → skipped `"multi-match"`
  - Patch whose `originalText` equals entire prose → skipped `"whole-prose-replacement"`
  - Patch with unknown `errorRef` → skipped `"unknown-error-ref"`
  - `maxPatches` cap honored, overflow skipped with reason
  - Patches applied in plan order; later patches see post-earlier state
  - `issueCoverage` reports every input issue's outcome including `unaddressed`
  - `scopedExtension` happy path: valid extension applied when length-band issue exists, all bounds met, and all other mandatory issues are resolved.
  - `scopedExtension` skipped (out-of-bounds, not-justified, mandatory-issues-unresolved) → each reason produced, diff `notes` records it.
  - **`scopedExtension` precedence override**: when the planner emits `issueOutcomes` with `status: "skipped"` for a length-band TrackedIssue AND `scopedExtension` is skipped, the issue's `issueCoverage` entry MUST be `unaddressed` with reason prefix `"scoped-extension-skipped: "`, not `skip-planner`. Pins the explicit override rule.
- `tests/track-issues.test.ts` (NEW):
  - Mandatory vs advisory split for every IssueOrigin (validator-only-downgrade is NOT a TrackedIssue origin — downgraded errors never reach the planner)
  - Stable ids across runs (deterministic minting)
  - `audit-error-validator` is a `mandatory` origin and only appears in the planner's input when at least one model-source error is also present (the mixed case)
- `tests/system-rules.test.ts` — add:
  - `shouldStructurallyRewrite` returns `true` for catastrophic voiceConsistency, multi-dim failure, weak structural hooks
  - `shouldStructurallyRewrite` returns `false` for the chapter-2-style profile (92.15, 5 small issues)
  - `RevisionPlan` with `requiresStructuralRewrite: true` triggers structural rewrite path
- `tests/runtime-safety.test.ts` — adjust assertions for new artifact shape; preserve existing ratchet/downgrade behavior tests.
- `tests/context-budget.test.ts` (NEW):
  - Continuity-fix planner prompt for a representative input is under 12,000 tokens (assert via `tokenCount` heuristic or character cap as a proxy).
  - Revision-patch planner prompt for a representative input is under 16,000 tokens.
  - Structural rewrite prompt is unchanged from today (sanity test).
- `tests/validator-only-path.test.ts` (NEW or extension of existing test):
  - When all audit errors have `source: "validator"`, the patch planner is NOT called. `downgradeValidatorOnlyErrors` runs; loop breaks; chapter publishes.
  - When errors are mixed (model + validator), the planner IS called and the input TrackedIssues include `audit-error-validator` entries as mandatory.
- `tests/parse-anthropic-json.test.ts` (NEW) — pins parser behavior for the shared helper now used by spec critique + both patch planners:
  - Fenced JSON (```json\n{...}\n```) parses correctly.
  - Code-fence variant (```\n{...}\n```) parses correctly.
  - JSON embedded in commentary text (`Here is the plan: {...} -- end`) parses via the fallback regex match.
  - Malformed JSON (mismatched braces, trailing comma in invalid position) throws.
- `tests/revision-plan-schema.test.ts` (NEW) — pins `validateRevisionPlan` runtime shape checks:
  - Valid `RevisionPlan` passes through unchanged.
  - Missing `patches` field throws with a descriptive error.
  - `patches` present but contains an item without `originalText` throws with a descriptive error.
  - `requiresStructuralRewrite` set to a non-boolean throws.
  - `issueOutcomes[].status` set to an unknown enum value throws.
  - `scopedExtension` absent OR explicitly `null` is accepted (it's optional).
- `tests/planner-failure-paths.test.ts` (NEW) — pins the parse-or-shape failure → blocked-status contract for both planners:
  - `planContinuityFix` receives malformed JSON from Opus → `BLOCKED_PROVIDER_FAILURE` raised, status artifact written with `details.rawPlannerText` + `details.parseError`, NO `chapter-N-fix-attempt-K.json` written.
  - `planContinuityFix` receives valid JSON missing a required `RevisionPlan` field → same blocked-status contract, `details.parseError` reflects the `validateRevisionPlan` error message.
  - `planRevisionPatches` same two cases → same blocked-status contract, NO `chapter-N-revised-draft.json` and NO `chapter-N-revision-diff.json` written.

Docs:

- `docs/revision-patch-spec.md` (NEW) — one-page contract mirroring `docs/voice-grit-spec.md`. Covers BOTH continuity-fix and revision-patch (they share the type/apply shape).
- AGENTS.md — update relevant hot-spot bullets: revision pass and continuity-fix both default to patches. Document `revisionRouting` thresholds, `TrackedIssue` accountability, advisory-signal handling, context-hygiene principles.
- `.cursor/rules/memory-and-audit-hotspots.mdc` — same updates.
- `.cursor/rules/pipeline-contract.mdc` — add bullets for `revisionRouting`, shared patch contract, and per-issue accountability.
- README.md if it documents the fix loop or revision; update only existing references.

## Invariants that MUST be preserved

- `qualitySettings.maxFixAttempts` (default 2) — unchanged.
- The publish-candidate ratchet (`shouldRevertToPublishCandidate`) — unchanged. Runs after EVERY mode.
- Reserved zones for voice-grit and tournament — unchanged. Revision patches MAY touch reserved zones; tournament still owns its zones downstream.
- Audit contract (`FinalAuditReport` shape, severity rules, `source` tagging) — unchanged.
- Skip-revision path — unchanged. When the first draft clears `skipRevisionThreshold` with no blocking signals, no patch/rewrite runs.
- CLI exit code semantics (1 = unexpected runtime, 2 = blocked pipeline) — unchanged.
- Smoke mode determinism — preserved. Smoke paths return deterministic empty `RevisionPlan` with `issueOutcomes` declaring every issue as `skipped: "smoke"`.
- Artifact paths and payload contracts:
  - `chapter-N-fix-attempt-K.json` — **same path, payload switches** from `ContinuityFixResult` → `RevisionDiff`.
  - `chapter-N-revised-draft.json` — **same path, payload unchanged** (`ChapterDraft`). Downstream `judgeDraft` + `selectDraft` keep reading it exactly as today.
  - `chapter-N-revision-diff.json` — **new sidecar**, payload `RevisionDiff`, written only on the revision patch path (not on structural rewrite). Not consumed by any downstream stage; pure accountability/debugging.
- Voice-grit / tournament sequencing (apply voice-grit before tournament splices, both still run on every chapter in PR1) — unchanged.
- The validator-only downgrade gate (`isValidatorOnlyBlocking` → `downgradeValidatorOnlyErrors` → loop break) — unchanged in both code path and trigger condition.

## Acceptance criteria

1. `npm run typecheck && npm test` pass.
2. The chapter 2 publish-candidate's five real errors can be expressed as a five-patch plan and applied without invoking a whole-chapter rewrite. The fixture files exist at `tests/fixtures/chapter-2-regression/chapter-2-publish-candidate.json` and `tests/fixtures/chapter-2-regression/chapter-2-final-audit.json`. **Pre-handoff prerequisite**: these files are currently in the working tree but untracked (`git status` shows `?? tests/fixtures/chapter-2-regression/`) — the user must `git add tests/fixtures/chapter-2-regression/ && git commit` before handing off, otherwise a fresh agent on a clean clone won't have them. Once committed, the agent reads them directly; do not synthesize fakes. The five errors they contain are: word band 1 word short, two Zulu timestamps, range-units swap (nm→yards), current-bearing reconciliation, and a Beckwith POV access leak across a handset. The integration-shaped unit test is **fixture-backed only — no live provider calls, no API keys required**: it reads the real audit fixture, constructs a deterministic five-patch `RevisionPlan` in the test file (representing what the planner ought to return given those five errors), feeds it directly into `applyRevisionPatches` along with the real publish-candidate prose, and asserts the resulting `RevisionDiff` has `status: "applied"`, five patches all in `appliedPatches`, zero `unaddressed` entries in `issueCoverage`, and `finalProse.length` greater than the pre-patch length (since the word-band fix adds at least one word). The test never calls Opus or OpenAI. The deterministic plan also serves as documentation of what a correct planner output looks like for this exact case. This matches the project guardrail "Prefer smoke or fixture-backed validation over live provider calls."
3. A synthetic "broken chapter" (voiceConsistency 55, 4 dimensions below 70) routes to structural rewrite via `shouldStructurallyRewrite`.
4. A synthetic "lightly weak chapter" (voiceConsistency 78, one dimension 78, rest above 85) routes to patch path.
5. **Per-issue accountability**: `issueCoverage` in a produced `RevisionDiff` contains an entry for every TrackedIssue passed to the planner. No `unaddressed` entry can be silently dropped — running `--audit-only` after a fix run prints a coverage summary including unaddressed counts.
6. **Context budget**: continuity-fix planner prompt is ≤ 12,000 tokens; revision-patch planner prompt is ≤ 16,000 tokens; structural-rewrite prompt is unchanged.
7. Estimated cost per continuity-fix attempt drops by at least 5×. Patch-path revision drops by at least 4×. Structural-rewrite revision unchanged.
8. Publish-candidate ratchet still reverts on regression, regardless of mode.
9. Smoke runs (`npm run smoke`) still produce a clean deterministic chapter with no real provider calls.
10. **Validator-only path**: regression test confirms that when every audit error has `source: "validator"`, the planner is not called and the chapter publishes via the downgrade gate (unchanged from today's behavior).
11. **Revised-draft artifact contract**: on the patch path, the run produces BOTH `chapter-N-revised-draft.json` (`ChapterDraft`) AND `chapter-N-revision-diff.json` (`RevisionDiff` sidecar). On the structural-rewrite path, the run produces `chapter-N-revised-draft.json` ONLY. Test asserts both file presence and payload `artifactType` per path.
12. **Usage attribution**: in the resulting cost-summary artifact, patch-path revision usage is attributed to `revisionPatch`; structural-rewrite revision usage is attributed to `revision`. No revision usage is silently logged under the wrong stage name.

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

## When to stop

Stop after acceptance criteria are met. Do not extend the patch shape to spec generation, spec revision, or any other stage in this PR — those are JSON, cheap, and not subject to the "preserve good prose" concern. The goal here is one bounded, reviewable change: every prose-output stage that's fixing problems uses patches by default, falls back to full rewrite only when the chapter genuinely needs structural reshaping, surfaces advisory signals to the planner without enforcing action on them, accounts for every input issue in the diff, and runs on a minimal context bundle.

Speedups deferred to **PR2** (see appendix below): voice-grit skip gate, tournament skip gate. Cross-stage generation-phase parallelization is **out of scope entirely** (tournament reads full chapter prose; parallelizing with voice-grit generation would give the tournament stale body context). Lowering `selfRedTeam` / `chapterDelta` reasoning effort and switching narrow stages to Claude Sonnet are also deferred and require empirical quality measurement.

---

## Appendix: PR2 — skip-gate speedups (separate follow-up PR)

These changes are explicitly **out of scope for PR1**. They are documented here for the next PR after the patch migration ships and stabilizes. They are conservative score-gated skips on chapters the literary judge has already scored as clean in the relevant dimensions.

### Skip-voice-grit gate

When the literary judge review reports BOTH:

- `repetitionPenalty < qualitySettings.voiceGritSkipBelowRepetitionPenalty` (default **15**)
- No voice-tic or repeated-effect signal in `weaknesses` / `revisionActions` / `issues` (case-insensitive substring scan for `"voice-tic"`, `"repeated-effect"`, `"repeated phrase"`, `"signature phrase"`, `"tic"`)

…skip the voice-grit pass. Persist `chapter-N-voice-grit-skipped.json` with reason + trigger scores.

Add `voiceGritSkipBelowRepetitionPenalty: 15` to `qualitySettings`. Saves ~15–30s.

### Tournament skip gate

When the literary judge review reports BOTH:

- `openingPower ≥ qualitySettings.tournamentSkipMinZoneScore` (default **92**)
- `endingHookStrength ≥ qualitySettings.tournamentSkipMinZoneScore` (default **92**)

…skip the opening/ending tournament. Persist `chapter-N-tournament-skipped.json` with reason + trigger scores.

Add `tournamentSkipMinZoneScore: 92` to `qualitySettings`. Saves ~30–60s.

### Required type extension

`PublishCandidateSnapshot.capturedAfter` currently has the literal type `"selection" | "voice-grit" | "tournament"`, and `run-chapter.ts` always writes `"tournament"`. PR2 must make `run-chapter.ts` write the value that reflects what actually ran:

- Both stages ran → `"tournament"` (today's behavior)
- Voice-grit skipped, tournament ran → `"tournament"`
- Voice-grit ran, tournament skipped → `"voice-grit"`
- Both skipped → `"selection"`

No type change is needed — the existing union already covers these cases. Only the write-site logic in `run-chapter.ts` updates.

### Tests for PR2

- `tests/skip-gates.test.ts` (NEW): exercises the four cells of the run/skip matrix, asserts skip artifacts persist with reason + trigger scores, asserts `capturedAfter` reflects the actually-run stages.
- The stage-interaction matrix from the deleted PR1 section moves here.

### Why PR2 is separate

The patch migration is large and load-bearing. Stacking the skip gates on top compounds review surface and failure modes. The skip gates are conservative (only fire on already-clean chapters) and quality-neutral, but their interaction with the publish-candidate ratchet and `capturedAfter` semantics deserves its own focused PR after PR1 has shipped and stabilized in production runs.

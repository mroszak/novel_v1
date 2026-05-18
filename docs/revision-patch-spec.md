# Revision Patch Spec

This spec is the contract for `src/pipeline/apply-revision-patches.ts` and the patch planners in `fix-continuity.ts` and `revise-draft.ts`.

## Goal

Fix known chapter problems with exact prose patches instead of whole-chapter rewrites whenever the issue is local.

## Pipeline Placement

```
draft → judge → revision-patch OR structural revision → judge → selection

selected → delta → memory → final audit → continuity-fix patches → re-audit → publish
```

## Shared Contract

Both planners return a `RevisionPlan`:

- `patches[]`: `{ errorRef, originalText, replacementText, justification }`
- `issueOutcomes[]`: one declared outcome for each tracked issue
- `scopedExtension`: optional 50-500 word length-band repair
- `requiresStructuralRewrite`: revision-only escalation flag

`errorRef` must match an engine-minted `TrackedIssue.id`. Unknown ids are skipped.

## Apply Rules

- `originalText` must be non-empty and match exactly once in current prose.
- Whole-chapter replacement patches are skipped.
- Patches apply in plan order; later patches see earlier edits.
- Applied patches are capped by `qualitySettings.revisionRouting.maxPatchesPerPlan`.
- Every tracked issue appears in `RevisionDiff.issueCoverage` as patched, skipped, covered by another patch, or unaddressed.
- `covered-by-other` requires the planner's `issueOutcomes[].reason` to cite the applied patch's exact `errorRef` in square brackets, e.g. `[audit-error-model#1]`; otherwise the issue remains unaddressed.

## Stage Behavior

- `revision-patch` is the default revision path when `shouldStructurallyRewrite` says patches are safe.
- `revision` remains the structural fallback for catastrophic voice failure, broad rubric failure, weak structural hooks, patch-budget overflow, or model self-escalation.
- `continuity-fix` always uses patches. It never falls back to a full rewrite.
- Validator-only blocking still downgrades to warnings before any continuity planner call.

## Artifacts

- `chapter-N-revised-draft.json`: unchanged `ChapterDraft` payload on both revision paths.
- `chapter-N-revision-diff.json`: `RevisionDiff` sidecar, patch path only.
- `chapter-N-fix-attempt-K.json`: `RevisionDiff` payload for continuity-fix attempts.

## Status

Patch planning is blocking if the model fails to return valid JSON or a valid `RevisionPlan`; the run records `BLOCKED_PROVIDER_FAILURE` with the raw planner text and parse error.

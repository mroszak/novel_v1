# Voice Grit Spec (canonical)

This spec is the contract for `src/pipeline/voice-grit-pass.ts`. The implementation must match this document; if the implementation diverges, fix the doc or fix the code, but never ship them out of sync.

## Goal

Surgical post-selection pass that removes AI tells (rhythmic balance, total semantic completeness, polished sentence symmetry) by injecting small, locally-earned textures from the book's own voice system, without changing plot or lowering quality.

## Why it matters

The pipeline optimizes hard for craft quality, which makes finished chapters technically excellent and starting to read like it. Voice grit puts back the friction that distinguishes human prose from competent AI prose. Anchoring every edit to an `activeTrait` or `dialogueHabit` from the rolling memory keeps it from becoming a generic humanizer.

## Pipeline placement

Critical — must run **before** the opening/ending tournament so the tournament retains ownership of its reserved zones.

```
selected → voice-grit → tournament → delta → memory → audit → publish
```

## Allowed texture menu

Planner picks 0–6 textures. Empty is a valid plan. Locally earned only — this is a menu, not a checklist.

1. `prosody-irregularity` — break a metronomic sentence run with one fragment or one earned long sentence.
2. `voice-tic` — surface one `activeTrait` or `dialogueHabit` from the POV character's voice card. `ticSource` is **required** and must cite a real voice-card entry.
3. `interrupted-observation` — one trailing em-dash thought the POV doesn't finish processing. **Max one per chapter.**
4. `strategic-under-explanation` — delete 1–2 consecutive sentences that narrate what the prior beat already showed. **Max one patch of this type per chapter.**
5. `specificity-swap` — replace one abstract noun phrase with a hyper-specific concrete detail consistent with POV expertise.
6. `asymmetric-paragraph-weight` — split or merge a balanced paragraph where it serves emotional pressure.

## Hard constraints (validator-enforced)

- Total patches: 0–6. Empty is a valid answer.
- Reserved zones blocked: chapter opening (~200 words), chapter ending (last paragraph), chapter title, paragraph-end sentences, scene-break leadout sentences. (Owned by the opening/ending tournament.)
- Each `originalText` must appear verbatim **exactly once** in the chapter.
- Max 2 patches per scene.
- `tabooNote` is **excluded** from `ticSource` — taboos flow to the planner only as a "DO NOT SURFACE" constraint section.
- No new plot, info, character knowledge, or world facts. No typos, grammatical errors, or vocal hedges in narration.

## Rejudge atomicity

Rejudge runs **once** on the fully-patched prose. Score drop > 1pt or any new blocking review signal → **discard the entire batch**, downstream consumes pre-grit `selected`. No partial-patch publishing.

## Sub-stages

- `voice-grit-plan` — Anthropic Opus, small thinking budget. Returns 0–6 structured patches with `earnedJustification` naming the specific AI tell removed.
- `voice-grit-apply` — deterministic. Patch validator drops invalid patches first (zone overlap, exact-span miss, bad `ticSource`, count caps); survivors apply atomically to the prose.
- `voice-grit-validate` — deterministic. Re-runs existing prose validators on the patched prose.
- `voice-grit-rejudge` — own stage name in telemetry; model profile mirrors `literaryJudge`. Compares against pre-grit review, discards whole batch on regression.

## Artifacts

- `artifacts/chapters/chapter-N-voice-grit-plan.json`
- `artifacts/chapters/chapter-N-voice-grit-applied.json`
- `artifacts/chapters/chapter-N-voice-grit-rejudge.json`

## Touch surface

- New: `src/pipeline/voice-grit-pass.ts`
- New: stage profiles in `src/config.ts` (`voiceGritPlan`, `voiceGritRejudge` — distinct stage name even though it reuses the `literaryJudge` model profile, so cost/usage stays readable)
- New: types in `src/types/index.ts` (`GritTexture`, `GritPatch`, `VoiceGritResult`)
- Modify: `src/pipeline/run-chapter.ts` — insert between `selected` and the opening/ending tournament
- Modify: `src/pipeline/estimate-cost.ts`
- Tests: focused validator tests (zone overlap, tabooNote rejection, exact-span miss, count caps, ticSource validation) + one orchestration regression for fail-soft on rejudge regression

## Fail-soft behavior

| Failure point | Action |
|---|---|
| `voice-grit-plan` errors / returns empty patches | Skip, downstream uses `selected` |
| All patches rejected by validator | Skip, downstream uses `selected` |
| `voice-grit-validate` fails on patched prose | Discard, downstream uses `selected` |
| `voice-grit-rejudge` regresses > 1pt or introduces blocking signal | Discard whole batch, downstream uses `selected` |
| No voice-target available (chapter 1 with no `STYLE_SAMPLE.md`, or extract/load fail-soft) | Skip, downstream uses `selected` |

## Status

Voice grit is advisory and fail-soft. It always runs when a voice-target is available; it never blocks publish on its own.

## Acceptance criteria

- Smoke produces a deterministic empty-patch result.
- Live chapter run produces non-empty patches with `earnedJustification` strings naming specific AI tells removed.
- Forced rejudge regression triggers whole-batch discard; chapter publishes pre-grit `selected`.
- Validator rejects: `tabooNote`-as-tic, `originalText` not found or found multiple times, edit in a reserved zone, `voice-tic` without `ticSource`, count caps exceeded.
- Tournament zones remain untouched (verified by test).

## Cost impact

~+$0.50 per chapter (one Anthropic plan call + one OpenAI rejudge call when patches survive validation).

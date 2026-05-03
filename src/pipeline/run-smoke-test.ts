import path from "node:path";

import { config } from "../config.js";
import type { RunChapterOptions, RunChapterResult } from "../types/index.js";
import { writeText } from "../utils/index.js";
import { runChapter } from "./run-chapter.js";

const SMOKE_BLUEPRINT = `---
title: "Smoke Signal"
author: "System Fixture"
version: "1.0.0"
---

# STORY BLUEPRINT

## Metadata
- Title: Smoke Signal
- Author: System Fixture
- Blueprint Version: 1.0.0
- Total Chapter Count: 2
- Default Chapter Word Count: 2200

## Story Promise and Ending Promise
- Core Premise: A courier carrying a dangerous memory device discovers the city has been quietly rewritten around her.
- Story Promise: Each chapter tightens paranoia, emotional cost, and immediate consequence.
- Reader Promise: The reader should feel forward pull, destabilized trust, and clean causal escalation.
- Ending Promise: The ending reveals the cost of surviving the rewrite, not a loophole around it.

## Market Positioning
- Market Category: speculative suspense
- Audience: readers who want tense, fast literary suspense with a speculative edge
- Shelf Positioning: A compact speculative suspense novel driven by paranoia, consequence, and identity pressure.
- Comparables:
  - Dark Matter
  - The Gone World
  - Recursion

## Genre Contract
- Primary Genre: science fiction
- Subgenres:
  - suspense
  - psychological thriller
- Tone Keywords:
  - tense
  - intimate
  - destabilizing
- Reader Experience: The reader should feel trapped inside a widening conspiracy without losing emotional clarity.
- Runtime Overrides:
  - pacingCurve: fast rise with tight reversals
  - revealCadence: clue drip with controlled rupture
  - hookStyle: dread plus momentum

## Tonal Contract and Reader Experience
Use close third person, concrete scene work, and clipped momentum. Chapters should end on actionable consequence, not atmospheric vagueness.

## Canon Law and World Rules
- Memory editing exists but leaves physical evidence in objects and routine.
- Rewrites cannot erase emotional residue instantly.
- Institutions protect the rewrite because they depend on it.
- Every intervention transfers cost rather than removing it.

## Character Architecture
### Lena Vale
- Name: Lena Vale
- Role: protagonist
- Desire: Deliver the memory device and learn who altered her history.
- Fear: Discover she volunteered for the rewrite.
- Contradiction: She wants truth but survives by strategic omission.
- Public Face: Efficient courier who never lingers.
- Private Truth: She keeps testing reality because she no longer trusts her own mind.
- Voice Notes:
  - Notices physical inconsistencies before emotional meaning.
  - Speaks in compressed, practical language under stress.
- Knowledge Boundary: She must not know the rewrite's original architect in chapter 1.

### Adrian Kess
- Name: Adrian Kess
- Role: ally
- Desire: Keep Lena alive long enough to expose the archive.
- Fear: Lena will remember the one betrayal that destroyed them.
- Contradiction: He protects her by withholding critical truth.
- Public Face: Calm systems analyst with controlled affect.
- Private Truth: He helped design the first failed rewrite.
- Voice Notes:
  - Uses precise language and deflects with dry wit.
  - Reveals care through logistics rather than confession.
- Knowledge Boundary: He must not openly confess his role in chapter 1.

### Director Sloane
- Name: Director Sloane
- Role: antagonist
- Desire: Recover the memory device before the archive becomes public.
- Fear: The city will see how much it already agreed to forget.
- Contradiction: She believes control prevents mass harm while creating it.
- Public Face: Measured civic protector.
- Private Truth: She remembers every prior rewrite and calls that burden mercy.
- Voice Notes:
  - Speaks with managerial certainty.
  - Treats moral damage as administrative arithmetic.
- Knowledge Boundary: She must remain mostly offstage in chapter 1.

## Relationship Dynamics
Lena distrusts Adrian because he always arrives with useful timing and partial truths. Adrian still loves Lena but expresses it as risk management. Sloane sees both of them as operational variables, not people.

## Belief Arcs and Internal Contradictions
Lena starts believing survival requires emotional isolation. Adrian believes withholding truth buys time. Both beliefs must crack as the rewrite cost becomes personal.

## Knowledge Boundaries and Reveal Timing
The reader may sense Lena's past with Adrian before either of them names it. The true architect, original consent, and scale of civic complicity must remain withheld until later chapters.

## Act Spine and Chapter-by-Chapter Obligations
Act one establishes the rewrite threat and the personal betrayal beneath it. Chapter 1 is an opening pressure chapter. Chapter 2 is an escalation chapter that ends with a harder proof of conspiracy.

## Setup/Payoff Map and Ghost-Thread Map
Plant the scar on Lena's wrist as a silent trace of prior rewrites. Plant Adrian's habit of pre-answering unasked questions. Plant the memory device as both evidence and temptation.

## Style Bible and Prose Rules
- Rules:
  - Keep sentences clean and pressure-forward.
  - Favor concrete objects over abstract explanation.
  - Let dialogue carry subtext rather than exposition.
  - End scenes on changed tactical reality.
  - Use recurring imagery of seams, residue, and duplicated motion.

## Motif/Symbol Bank and Imagery Palette
- Motifs:
  - seam lines in glass and metal
  - repeated routes that feel fractionally wrong
  - static-charged touch and fluorescent afterimage

## Anti-Patterns and Genre Failure Modes
- Banned Moves:
  - No lore dumps explaining the entire rewrite system at once.
  - No villain monologue replacing earned discovery.
  - No emotional reset after a major reveal.

## Chapter Outline
### Chapter 1
- Title: The Wrong Route
- Function: opening
- POV: Lena Vale
- Summary: Lena notices her delivery route has been subtly rewritten and realizes the package she carries is being tracked by people who already know her habits.
- Chapter Goal: Establish the rewrite threat, Lena's distrust, and the personal pressure between Lena and Adrian.
- Target Word Count: 2200
- Ending Hook: Adrian arrives knowing the package contents before Lena tells him what she is carrying.
- Active Cast:
  - Lena Vale
  - Adrian Kess
- Mandatory Beats:
  - Lena detects a physical inconsistency on her route.
  - The package becomes visibly dangerous to keep.
  - Adrian proves he knows more than he should.
- Callback Obligations:
  - The scar on Lena's wrist should quietly matter.
- Show:
  - The wrong route
  - the package's immediate threat
- Hint:
  - Lena and Adrian share a damaged past
- Reveal:
  - Adrian knows the package matters
- Withhold:
  - who ordered the rewrite
- Risk Flags:
  - anchor
- Notes:
  - Keep the opening in motion.

### Chapter 2
- Title: Residue Pattern
- Function: escalation
- POV: Lena Vale
- Summary: Lena and Adrian test the package, confirm the city records are altered, and trace the first visible evidence of institutional complicity.
- Chapter Goal: Convert suspicion into proof while making Adrian more dangerous to trust.
- Target Word Count: 2200
- Ending Hook: Lena finds her own name buried inside an erased authorization chain.
- Active Cast:
  - Lena Vale
  - Adrian Kess
  - Director Sloane
- Mandatory Beats:
  - Lena verifies the rewrite has physical residue.
  - Adrian's withholding creates a new tactical risk.
  - The conspiracy becomes personally undeniable.
- Callback Obligations:
  - The memory device should expose a hidden pattern.
- Show:
  - rewrite residue
  - institutional reach
- Hint:
  - Lena may have once consented
- Reveal:
  - Lena's name appears in the authorization chain
- Withhold:
  - the full origin of Adrian's betrayal
- Risk Flags:
  - complex
- Notes:
  - Let pressure rise through proof, not exposition.
`;

export async function runSmokeTest(overrides: Partial<RunChapterOptions> = {}): Promise<RunChapterResult> {
  const blueprintPath = path.join(config.paths.smokeArtifacts, "smoke-blueprint.md");
  await writeText(blueprintPath, SMOKE_BLUEPRINT);

  return runChapter({
    blueprintPath,
    chapterNumber: overrides.chapterNumber ?? config.defaults.smokeChapterNumber,
    packetOnly: overrides.packetOnly ?? false,
    specOnly: overrides.specOnly ?? false,
    draftOnly: overrides.draftOnly ?? false,
    judgeOnly: overrides.judgeOnly ?? false,
    auditOnly: overrides.auditOnly ?? false,
    rerunFrom: overrides.rerunFrom ?? null,
    compileBlueprintOnly: overrides.compileBlueprintOnly ?? false,
    estimateCost: overrides.estimateCost ?? false,
    smoke: true,
    noGenreAi: true,
    skipSpecCritique: overrides.skipSpecCritique ?? false,
  });
}

import { generateText as generateAnthropicText } from "../api/anthropic.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterPacket,
  FinalAuditReport,
  RevisionDiff,
  RevisionPlan,
  RollingMemory,
  SelectedChapter,
  TrackedIssue,
} from "../types/index.js";
import { tailExcerpt, writeJson } from "../utils/index.js";
import { parseAnthropicJson } from "../utils/parse-anthropic-json.js";
import { applyRevisionPatches } from "./apply-revision-patches.js";
import { validateRevisionPlan } from "./revision-plan-schema.js";
import { BlockedPipelineError, chapterArtifactPath, createArtifact } from "./stage-utils.js";
import { buildTrackedIssues } from "./track-issues.js";

function buildSmokePlan(trackedIssues: TrackedIssue[]): RevisionPlan {
  return {
    patches: [],
    scopedExtension: null,
    issueOutcomes: trackedIssues.map((issue) => ({
      id: issue.id,
      status: "skipped",
      reason: "smoke",
    })),
    notes: ["smoke"],
    requiresStructuralRewrite: false,
    structuralRewriteReason: null,
  };
}

function formatTrackedIssues(issues: TrackedIssue[]): string {
  if (issues.length === 0) return "(no tracked issues)";
  return issues
    .map((issue) => `[${issue.id}] ${issue.origin}: ${issue.title} — ${issue.fixHint ?? "no hint"}`)
    .join("\n");
}

function buildPovContext(packet: ChapterPacket, issues: TrackedIssue[]): string | null {
  const issueText = issues.map((issue) => `${issue.title} ${issue.fixHint ?? ""}`).join("\n").toLowerCase();
  const lines = packet.activeCast
    .filter((character) => issueText.includes(character.name.toLowerCase()))
    .map((character) => {
      const voiceCard = packet.rollingMemory?.activeCharacterVoiceCards.find(
        (card) => card.character.toLowerCase() === character.name.toLowerCase(),
      );
      const traits = voiceCard?.activeTraits ?? character.voiceNotes;
      return `${character.name} (${character.role}): notices=${character.noticingEngine ?? "unspecified"}; traits=[${traits.join("; ")}]; knowledgeBoundary=${character.knowledgeBoundary}`;
    });
  return lines.length > 0 ? lines.join("\n") : null;
}

function shouldIncludePreviousAnchor(issues: TrackedIssue[]): boolean {
  const issueText = issues.map((issue) => `${issue.title} ${issue.fixHint ?? ""}`).join("\n").toLowerCase();
  return ["continuity", "timeline", "callback"].some((needle) => issueText.includes(needle));
}

export function buildContinuityFixRequest(params: {
  packet: ChapterPacket;
  selected: SelectedChapter;
  trackedIssues: TrackedIssue[];
}): { system: string; prompt: string } {
  const povContext = buildPovContext(params.packet, params.trackedIssues);
  const previousAnchor = shouldIncludePreviousAnchor(params.trackedIssues)
    && params.packet.compactContext.previousChapterFull
    ? tailExcerpt(params.packet.compactContext.previousChapterFull, 200)
    : null;

  return {
    system: [
      "You are Opus planning surgical continuity patches for a novel chapter.",
      "Return strict JSON only with keys patches, scopedExtension, issueOutcomes, notes, requiresStructuralRewrite, structuralRewriteReason.",
      "Use this shape: {\"patches\":[{\"errorRef\":\"tracked id\",\"originalText\":\"exact current prose\",\"replacementText\":\"replacement prose\",\"justification\":\"one sentence\"}],\"scopedExtension\":null,\"issueOutcomes\":[{\"id\":\"tracked id\",\"status\":\"patched|skipped|unaddressed\",\"reason\":\"short reason\"}],\"notes\":[],\"requiresStructuralRewrite\":false,\"structuralRewriteReason\":null}.",
      "Every patch must reference a known tracked issue id. originalText must match the chapter exactly and should include enough local context to match once.",
      "Address mandatory issues with patches unless the prose is already correct; advisory issues may be skipped with a reason.",
      "If one patch covers multiple issue ids, set each covered issueOutcomes entry to patched and cite the applied patch's exact errorRef in square brackets, e.g. [audit-error-model#1].",
      "Do not rewrite the chapter. Do not emit diff markup. requiresStructuralRewrite must be false for continuity-fix.",
    ].join("\n"),
    prompt: [
      "<tracked_issues>",
      formatTrackedIssues(params.trackedIssues),
      "</tracked_issues>",
      "<chapter_prose>",
      params.selected.prose,
      "</chapter_prose>",
      ...(povContext ? ["<pov_context>", povContext, "</pov_context>"] : []),
      ...(previousAnchor ? ["<previous_chapter_anchor>", previousAnchor, "</previous_chapter_anchor>"] : []),
    ].join("\n"),
  };
}

function parsePlanOrBlock(rawText: string): RevisionPlan {
  try {
    return validateRevisionPlan(parseAnthropicJson<RevisionPlan>(rawText));
  } catch (error) {
    throw new BlockedPipelineError(
      "BLOCKED_PROVIDER_FAILURE",
      "continuity-fix",
      "Continuity-fix planner did not return a valid RevisionPlan.",
      {
        rawPlannerText: rawText,
        parseError: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export async function planContinuityFix(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  memoryArtifact: ArtifactEnvelope<RollingMemory>;
  auditArtifact: ArtifactEnvelope<FinalAuditReport>;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  attemptNumber: number;
  smoke: boolean;
}): Promise<ArtifactEnvelope<RevisionDiff>> {
  const {
    packetArtifact,
    selectedArtifact,
    auditArtifact,
    attemptNumber,
    smoke,
  } = params;

  const trackedIssues = buildTrackedIssues({ audit: auditArtifact.data });
  let plan: RevisionPlan;
  let usage: ArtifactEnvelope<RevisionDiff>["usage"];

  if (smoke) {
    plan = buildSmokePlan(trackedIssues);
    usage = undefined;
  } else {
    const request = buildContinuityFixRequest({
      packet: packetArtifact.data,
      selected: selectedArtifact.data,
      trackedIssues,
    });
    const result = await generateAnthropicText({
      stage: config.stageProfiles.continuityFix,
      system: request.system,
      prompt: request.prompt,
    });

    plan = parsePlanOrBlock(result.value);
    usage = result.usage;
  }

  if (plan.requiresStructuralRewrite) {
    throw new BlockedPipelineError(
      "BLOCKED_PROVIDER_FAILURE",
      "continuity-fix",
      plan.structuralRewriteReason ?? "Continuity-fix planner requested a structural rewrite.",
      { structuralRewriteReason: plan.structuralRewriteReason },
    );
  }

  const diff = applyRevisionPatches({
    prose: selectedArtifact.data.prose,
    plan,
    trackedIssues,
    maxPatches: config.qualitySettings.revisionRouting.maxPatchesPerPlan,
  });

  const artifact = createArtifact<RevisionDiff>({
    artifactType: "continuity-fix",
    blueprintHash: packetArtifact.blueprintHash,
    blueprintVersion: packetArtifact.blueprintVersion,
    chapterNumber: packetArtifact.chapterNumber,
    data: diff,
    usage,
  });
  await writeJson(
    chapterArtifactPath(packetArtifact.data.chapterNumber, `fix-attempt-${attemptNumber}`),
    artifact,
  );

  return artifact;
}

export const fixContinuity = planContinuityFix;

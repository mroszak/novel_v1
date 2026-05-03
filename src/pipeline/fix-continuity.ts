import { generateText as generateAnthropicText } from "../api/anthropic.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterPacket,
  ContinuityFixResult,
  FinalAuditReport,
  RollingMemory,
  SelectedChapter,
} from "../types/index.js";
import { compactJson, tailExcerpt, writeJson } from "../utils/index.js";
import { chapterArtifactPath, countWords, createArtifact } from "./stage-utils.js";
import { stripHeavyPacketFields } from "./generate-draft.js";

function buildSmokeFix(
  selected: SelectedChapter,
  audit: FinalAuditReport,
  attemptNumber: number,
): ContinuityFixResult {
  return {
    prose: `${selected.prose}\n\n[Smoke fix attempt ${attemptNumber} applied.]`,
    appliedFixes: audit.issues.map((issue) => issue.title),
  };
}

function buildAuditChecklist(audit: FinalAuditReport): string {
  const errorIssues = audit.issues.filter((issue) => issue.severity === "error");
  if (errorIssues.length === 0) {
    return "(no error-severity issues; warnings appear in <audit_report> for context but are not mandatory fixes for this pass)";
  }
  return errorIssues
    .map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.title}: ${issue.fixInstruction}`)
    .join("\n");
}

export async function fixContinuity(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  memoryArtifact: ArtifactEnvelope<RollingMemory>;
  auditArtifact: ArtifactEnvelope<FinalAuditReport>;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  attemptNumber: number;
  smoke: boolean;
}): Promise<ArtifactEnvelope<ContinuityFixResult>> {
  const {
    packetArtifact,
    selectedArtifact,
    memoryArtifact,
    auditArtifact,
    blueprintArtifacts,
    attemptNumber,
    smoke,
  } = params;

  let fixResult: ContinuityFixResult;
  let usage: ArtifactEnvelope<ContinuityFixResult>["usage"];

  if (smoke) {
    fixResult = buildSmokeFix(selectedArtifact.data, auditArtifact.data, attemptNumber);
    usage = undefined;
  } else {
    const result = await generateAnthropicText({
      stage: config.stageProfiles.continuityFix,
      system: [
        "You are Opus performing a surgical continuity fix on a novel chapter.",
        "Address ONLY the error-severity issues in <audit_checklist>. Warning-severity items in <audit_report> are advisory; do not regenerate prose to address them in this pass.",
        "Make the smallest possible delta. Sentences not implicated by an error must remain byte-identical. Do NOT reword, polish, or paraphrase clean prose.",
        "If a previous fix attempt has already cleaned the chapter and only added length-band issues remain, you may add a short scene-extension paragraph rather than rewriting earlier prose.",
        "If a line causes a knowledge-boundary or factual-audit error, cut or relocate it instead of preserving it for style.",
        "If an issue says a POV character knows too much, remove the forbidden inference rather than paraphrasing it in the same POV.",
        "If an issue says route naming or geography is inconsistent, pick one clear label and use it consistently everywhere.",
        "Voice notes and motif phrases in the chapter packet are BEHAVIOR DESCRIPTIONS, not lines to write into prose. Never quote them verbatim; never use any four-word span from the packet as prose. Render the same behavior with varied surface wording.",
        "Output only the fixed chapter prose. No commentary, no diff markup.",
      ].join("\n"),
      prompt: [
        "<audit_checklist>",
        buildAuditChecklist(auditArtifact.data),
        "</audit_checklist>",
        "<genre_contract>",
        compactJson(blueprintArtifacts.genreContract.data),
        "</genre_contract>",
        "<chapter_packet>",
        compactJson(stripHeavyPacketFields(packetArtifact.data)),
        "</chapter_packet>",
        "<rolling_memory>",
        compactJson(memoryArtifact.data),
        "</rolling_memory>",
        "<audit_report>",
        compactJson(auditArtifact.data),
        "</audit_report>",
        ...(packetArtifact.data.compactContext.previousChapterFull
          ? [
            "<previous_chapter_tail>",
            tailExcerpt(packetArtifact.data.compactContext.previousChapterFull, 500),
            "</previous_chapter_tail>",
          ]
          : []),
        "<chapter_prose>",
        selectedArtifact.data.prose,
        "</chapter_prose>",
      ].join("\n"),
    });

    fixResult = {
      prose: result.value,
      appliedFixes: auditArtifact.data.issues.map((issue) => issue.title),
    };
    usage = result.usage;
  }

  const artifact = createArtifact<ContinuityFixResult>({
    artifactType: "continuity-fix",
    blueprintHash: packetArtifact.blueprintHash,
    blueprintVersion: packetArtifact.blueprintVersion,
    chapterNumber: packetArtifact.chapterNumber,
    data: fixResult,
    usage,
  });
  await writeJson(
    chapterArtifactPath(packetArtifact.data.chapterNumber, `fix-attempt-${attemptNumber}`),
    artifact,
  );

  return artifact;
}

export function applyFixResult(
  selectedArtifact: ArtifactEnvelope<SelectedChapter>,
  fixArtifact: ArtifactEnvelope<ContinuityFixResult>,
): ArtifactEnvelope<SelectedChapter> {
  return {
    ...selectedArtifact,
    createdAt: new Date().toISOString(),
    data: {
      ...selectedArtifact.data,
      prose: fixArtifact.data.prose,
      wordCount: countWords(fixArtifact.data.prose),
    },
  };
}

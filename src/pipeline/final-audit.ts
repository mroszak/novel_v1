import { generateStructuredOutput } from "../api/openai.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterDelta,
  ChapterPacket,
  DraftReview,
  FinalAuditIssue,
  FinalAuditReport,
  GenreContract,
  MemoryUpdateProposal,
  RollingMemory,
  SelectedChapter,
  ValidatorReport,
} from "../types/index.js";
import { runDeterministicValidators } from "../validators/index.js";
import { compactJson, tailExcerpt, writeJson } from "../utils/index.js";
import { createSmokeAudit } from "./smoke-helpers.js";
import { chapterArtifactPath, createArtifact } from "./stage-utils.js";
import { stripMemoryPacketFields } from "./update-memory.js";

const finalAuditSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["clean", "issues_found"] },
    summary: { type: "string", minLength: 1 },
    factualConfidence: { type: "number", minimum: 0, maximum: 1 },
    requiresFix: { type: "boolean" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["info", "warning", "error"] },
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          fixInstruction: { type: "string", minLength: 1 },
        },
        required: ["severity", "title", "description", "fixInstruction"],
        additionalProperties: false,
      },
    },
  },
  required: ["status", "summary", "factualConfidence", "requiresFix", "issues"],
  additionalProperties: false,
} as const;

function validatorIssuesToAuditIssues(validator: ValidatorReport): FinalAuditIssue[] {
  return validator.issues.map((issue) => ({
    severity: issue.severity === "error" ? "error" : "warning",
    title: issue.code,
    description: issue.message,
    fixInstruction: issue.evidence.length > 0
      ? `Resolve the issue using this evidence: ${issue.evidence.join(" | ")}`
      : "Resolve the deterministic validator failure without changing correct chapter facts.",
  }));
}

function mergeAuditWithValidator(
  audit: FinalAuditReport,
  validator: ValidatorReport,
): FinalAuditReport {
  const normalizedAudit: FinalAuditReport = {
    ...audit,
    status: audit.status === "issues_found"
      || audit.requiresFix
      || audit.issues.some((issue) => issue.severity === "error")
      ? "issues_found"
      : "clean",
    requiresFix: audit.requiresFix || audit.issues.some((issue) => issue.severity === "error"),
  };

  if (validator.errorCount === 0 && validator.warningCount === 0) {
    return normalizedAudit;
  }

  return {
    status: validator.errorCount > 0 ? "issues_found" : normalizedAudit.status,
    summary: validator.errorCount > 0
      ? `${normalizedAudit.summary} Deterministic validators also reported blocking issues.`
      : normalizedAudit.summary,
    factualConfidence: normalizedAudit.factualConfidence,
    requiresFix: normalizedAudit.requiresFix || validator.errorCount > 0,
    issues: [...normalizedAudit.issues, ...validatorIssuesToAuditIssues(validator)],
  };
}

function buildAuditReviewSnapshot(review: DraftReview): Pick<
  DraftReview,
  "candidateId" | "overallScore" | "passesThreshold" | "blockingIssues" | "revisionActions" | "issues" | "summary"
> {
  return {
    candidateId: review.candidateId,
    overallScore: review.overallScore,
    passesThreshold: review.passesThreshold,
    blockingIssues: review.blockingIssues,
    revisionActions: review.revisionActions,
    issues: review.issues,
    summary: review.summary,
  };
}

export function buildFinalAuditPrompt(params: {
  genreContract: GenreContract;
  packet: ChapterPacket;
  selectedReview: DraftReview;
  delta: ChapterDelta;
  memory: RollingMemory | MemoryUpdateProposal;
  validatorReport: ValidatorReport;
  selectedProse: string;
}): string {
  const sections = [
    `Genre contract: ${compactJson(params.genreContract)}`,
    `Chapter packet core: ${compactJson(stripMemoryPacketFields(params.packet))}`,
    `Selected review: ${compactJson(buildAuditReviewSnapshot(params.selectedReview))}`,
    `Chapter delta: ${compactJson(params.delta)}`,
    `Rolling memory: ${compactJson(params.memory)}`,
    `Deterministic validators: ${compactJson(params.validatorReport)}`,
    `Selected chapter prose:\n${params.selectedProse}`,
  ];

  if (params.packet.compactContext.previousChapterFull) {
    sections.splice(
      2,
      0,
      `Previous chapter ending (last ~500 words):\n${tailExcerpt(params.packet.compactContext.previousChapterFull, 500)}`,
    );
  }

  return sections.join("\n\n");
}

export async function runFinalAudit(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  selectedReviewArtifact: ArtifactEnvelope<DraftReview>;
  deltaArtifact: ArtifactEnvelope<ChapterDelta>;
  memoryArtifact: ArtifactEnvelope<RollingMemory>;
  previousMemory: RollingMemory | null;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  smoke: boolean;
}): Promise<{
  validatorArtifact: ArtifactEnvelope<ValidatorReport>;
  auditArtifact: ArtifactEnvelope<FinalAuditReport>;
}> {
  const {
    packetArtifact,
    selectedArtifact,
    selectedReviewArtifact,
    deltaArtifact,
    memoryArtifact,
    previousMemory,
    blueprintArtifacts,
    smoke,
  } = params;

  const validatorReport = runDeterministicValidators({
    packet: packetArtifact.data,
    selected: selectedArtifact.data,
    delta: deltaArtifact.data,
    memory: memoryArtifact.data,
    previousMemory,
    blueprintArtifacts,
  });

  const validatorArtifact = createArtifact<ValidatorReport>({
    artifactType: "deterministic-validators",
    blueprintHash: packetArtifact.blueprintHash,
    blueprintVersion: packetArtifact.blueprintVersion,
    chapterNumber: packetArtifact.chapterNumber,
    data: validatorReport,
  });
  await writeJson(chapterArtifactPath(packetArtifact.data.chapterNumber, "validators"), validatorArtifact);

  let audit: FinalAuditReport;
  let usage: ArtifactEnvelope<FinalAuditReport>["usage"];

  if (smoke) {
    audit = createSmokeAudit(validatorReport);
    usage = undefined;
  } else {
    const result = await generateStructuredOutput<FinalAuditReport>({
      stage: config.stageProfiles.finalAudit,
      instructions: [
        "You are the final factual auditor for a chapter-by-chapter novel engine.",
        "Audit only factual continuity, reveal discipline, contract adherence, and chapter-to-chapter causality.",
        "Take deterministic validator findings seriously and escalate concrete repair actions when needed.",
      ].join("\n"),
      prompt: buildFinalAuditPrompt({
        genreContract: blueprintArtifacts.genreContract.data,
        packet: packetArtifact.data,
        selectedReview: selectedReviewArtifact.data,
        delta: deltaArtifact.data,
        memory: memoryArtifact.data,
        validatorReport,
        selectedProse: selectedArtifact.data.prose,
      }),
      schemaName: "final_audit_report",
      schema: finalAuditSchema,
    });

    audit = result.value;
    usage = result.usage;
  }

  const mergedAudit = mergeAuditWithValidator(audit, validatorReport);
  const auditArtifact = createArtifact<FinalAuditReport>({
    artifactType: "final-audit",
    blueprintHash: packetArtifact.blueprintHash,
    blueprintVersion: packetArtifact.blueprintVersion,
    chapterNumber: packetArtifact.chapterNumber,
    data: mergedAudit,
    usage,
  });
  await writeJson(chapterArtifactPath(packetArtifact.data.chapterNumber, "final-audit"), auditArtifact);

  return {
    validatorArtifact,
    auditArtifact,
  };
}

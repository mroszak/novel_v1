import type {
  ArtifactEnvelope,
  FinalAuditIssue,
  FinalAuditReport,
  LocalizedAuditPatchResult,
  SelectedChapter,
} from "../types/index.js";
import { chapterArtifactPath, countWords, createArtifact } from "./stage-utils.js";
import { writeJson } from "../utils/index.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseQuotedPhrases(text: string): string[] {
  return Array.from(text.matchAll(/'([^']+)'/g), (match) => match[1] ?? "");
}

function replaceNthOccurrence(
  prose: string,
  target: string,
  replacement: string,
  occurrenceNumber: number,
): string | null {
  if (occurrenceNumber < 1) {
    return null;
  }

  const pattern = new RegExp(escapeRegExp(target), "gi");
  let matchCount = 0;
  let replaced = false;
  const next = prose.replace(pattern, (match) => {
    matchCount += 1;
    if (matchCount === occurrenceNumber) {
      replaced = true;
      return replacement;
    }
    return match;
  });
  return replaced ? next : null;
}

function defaultTemporalReplacement(issue: FinalAuditIssue): string | null {
  const quoted = parseQuotedPhrases(issue.fixInstruction);
  if (quoted.length >= 2) {
    return quoted[1] ?? null;
  }

  const fixLower = issue.fixInstruction.toLowerCase();
  if (fixLower.includes("earlier tonight")) {
    return "earlier tonight";
  }
  if (fixLower.includes("minutes earlier")) {
    return "minutes earlier";
  }
  return null;
}

function applyTemporalPatch(prose: string, issue: FinalAuditIssue): string | null {
  const issueText = `${issue.title} ${issue.description} ${issue.fixInstruction}`.toLowerCase();
  if (!issueText.includes("temporal") && !issueText.includes("timeline") && !issueText.includes("chronolog")) {
    return null;
  }

  const quoted = parseQuotedPhrases(issue.fixInstruction);
  const target = quoted[0] ?? (issueText.includes("hours ago") ? "hours ago" : "");
  const replacement = defaultTemporalReplacement(issue);
  if (!target || !replacement) {
    return null;
  }

  return replaceNthOccurrence(prose, target, replacement, 1);
}

function applyIssuePatch(prose: string, issue: FinalAuditIssue): string | null {
  return applyTemporalPatch(prose, issue);
}

export function buildLocalizedAuditPatchResult(
  prose: string,
  audit: FinalAuditReport,
): LocalizedAuditPatchResult | null {
  let nextProse = prose;
  const appliedFixes: string[] = [];

  for (const issue of audit.issues) {
    const patched = applyIssuePatch(nextProse, issue);
    if (patched) {
      nextProse = patched;
      appliedFixes.push(issue.title);
    }
  }

  if (nextProse === prose) {
    return null;
  }

  return {
    prose: nextProse,
    appliedFixes,
    requiresDeltaRefresh: false,
  };
}

export async function applyLocalizedAuditPatch(params: {
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  auditArtifact: ArtifactEnvelope<FinalAuditReport>;
  attemptNumber: number;
}): Promise<ArtifactEnvelope<LocalizedAuditPatchResult> | null> {
  const patch = buildLocalizedAuditPatchResult(
    params.selectedArtifact.data.prose,
    params.auditArtifact.data,
  );
  if (!patch) {
    return null;
  }

  const artifact = createArtifact<LocalizedAuditPatchResult>({
    artifactType: "localized-audit-patch",
    blueprintHash: params.selectedArtifact.blueprintHash,
    blueprintVersion: params.selectedArtifact.blueprintVersion,
    chapterNumber: params.selectedArtifact.chapterNumber,
    data: patch,
  });
  await writeJson(
    chapterArtifactPath(
      params.selectedArtifact.chapterNumber ?? 0,
      `localized-audit-patch-${params.attemptNumber}`,
    ),
    artifact,
  );
  return artifact;
}

export function applyLocalizedAuditPatchResult(
  selectedArtifact: ArtifactEnvelope<SelectedChapter>,
  patchArtifact: ArtifactEnvelope<LocalizedAuditPatchResult>,
): ArtifactEnvelope<SelectedChapter> {
  return {
    ...selectedArtifact,
    createdAt: new Date().toISOString(),
    data: {
      ...selectedArtifact.data,
      prose: patchArtifact.data.prose,
      wordCount: countWords(patchArtifact.data.prose),
    },
  };
}

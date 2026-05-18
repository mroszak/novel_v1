import type {
  ArtifactEnvelope,
  RevisionDiff,
  RevisionPatch,
  RevisionPlan,
  SelectedChapter,
  TrackedIssue,
} from "../types/index.js";
import { countWords } from "./stage-utils.js";

function countOccurrences(prose: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = prose.indexOf(needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

function isLengthIssue(issue: TrackedIssue): boolean {
  const haystack = `${issue.title} ${issue.fixHint ?? ""}`.toLowerCase();
  return ["word count", "word band", "length", "under band"].some((needle) => haystack.includes(needle));
}

function reasonCitesAppliedPatch(reason: string, appliedRefs: Set<string>): boolean {
  for (const appliedRef of appliedRefs) {
    if (reason.includes(`[${appliedRef}]`)) {
      return true;
    }
  }
  return false;
}

function buildCoverage(params: {
  trackedIssues: TrackedIssue[];
  plan: RevisionPlan;
  appliedPatches: RevisionPatch[];
  skippedPatches: Array<RevisionPatch & { skipReason: string }>;
}): RevisionDiff["issueCoverage"] {
  const outcomes = new Map(params.plan.issueOutcomes.map((outcome) => [outcome.id, outcome]));
  const appliedRefs = new Set(params.appliedPatches.map((patch) => patch.errorRef));
  const skippedRefs = new Set(params.skippedPatches.map((patch) => patch.errorRef));

  return params.trackedIssues.map((issue) => {
    if (appliedRefs.has(issue.id)) {
      return { id: issue.id, origin: issue.origin, title: issue.title, status: "patched", reason: null };
    }
    if (skippedRefs.has(issue.id)) {
      const firstSkip = params.skippedPatches.find((patch) => patch.errorRef === issue.id);
      return {
        id: issue.id,
        origin: issue.origin,
        title: issue.title,
        status: "skip-validation",
        reason: firstSkip?.skipReason ?? "patch skipped",
      };
    }

    const outcome = outcomes.get(issue.id);
    if (outcome?.status === "skipped") {
      return {
        id: issue.id,
        origin: issue.origin,
        title: issue.title,
        status: "skip-planner",
        reason: outcome.reason,
      };
    }
    if (outcome?.status === "patched" && reasonCitesAppliedPatch(outcome.reason, appliedRefs)) {
      return {
        id: issue.id,
        origin: issue.origin,
        title: issue.title,
        status: "covered-by-other",
        reason: outcome.reason,
      };
    }

    return {
      id: issue.id,
      origin: issue.origin,
      title: issue.title,
      status: "unaddressed",
      reason: outcome?.reason ?? "no entry",
    };
  });
}

function mandatoryUnresolved(
  coverage: RevisionDiff["issueCoverage"],
  trackedIssues: TrackedIssue[],
): string[] {
  const lengthIds = new Set(trackedIssues.filter(isLengthIssue).map((issue) => issue.id));
  return coverage
    .filter((entry) => {
      const issue = trackedIssues.find((candidate) => candidate.id === entry.id);
      return issue?.mandatory && !lengthIds.has(entry.id)
        && entry.status !== "patched"
        && entry.status !== "covered-by-other";
    })
    .map((entry) => entry.id);
}

export function applyRevisionPatches(params: {
  prose: string;
  plan: RevisionPlan;
  trackedIssues: TrackedIssue[];
  maxPatches: number;
}): RevisionDiff {
  const knownIds = new Set(params.trackedIssues.map((issue) => issue.id));
  const notes = [...params.plan.notes];
  let working = params.prose;
  const appliedPatches: RevisionPatch[] = [];
  const skippedPatches: Array<RevisionPatch & { skipReason: string }> = [];

  for (const patch of params.plan.patches) {
    if (!knownIds.has(patch.errorRef)) {
      skippedPatches.push({ ...patch, skipReason: "unknown-error-ref" });
      continue;
    }
    if (appliedPatches.length >= params.maxPatches) {
      skippedPatches.push({ ...patch, skipReason: "patch-budget-exceeded" });
      continue;
    }
    if (!patch.originalText) {
      skippedPatches.push({ ...patch, skipReason: "zero-match" });
      continue;
    }
    if (patch.originalText.trim() === working.trim()) {
      skippedPatches.push({ ...patch, skipReason: "whole-prose-replacement" });
      continue;
    }

    const matches = countOccurrences(working, patch.originalText);
    if (matches === 0) {
      skippedPatches.push({ ...patch, skipReason: "zero-match" });
      continue;
    }
    if (matches > 1) {
      skippedPatches.push({ ...patch, skipReason: "multi-match" });
      continue;
    }

    working = working.replace(patch.originalText, patch.replacementText);
    appliedPatches.push(patch);
  }

  let issueCoverage = buildCoverage({
    trackedIssues: params.trackedIssues,
    plan: params.plan,
    appliedPatches,
    skippedPatches,
  });

  const lengthIssues = params.trackedIssues.filter(isLengthIssue);
  const extension = params.plan.scopedExtension?.trim();
  let scopedExtensionApplied = false;
  let scopedExtensionSkipReason: string | null = null;

  if (extension) {
    const extensionWords = countWords(extension);
    if (extensionWords < 50 || extensionWords > 500) {
      scopedExtensionSkipReason = "scoped-extension-out-of-bounds";
    } else if (lengthIssues.length === 0) {
      scopedExtensionSkipReason = "scoped-extension-not-justified";
    } else {
      const unresolved = mandatoryUnresolved(issueCoverage, params.trackedIssues);
      if (unresolved.length > 0) {
        scopedExtensionSkipReason = "scoped-extension-mandatory-issues-unresolved";
        notes.push(`scoped-extension-unresolved: ${unresolved.join(", ")}`);
      }
    }

    if (scopedExtensionSkipReason) {
      notes.push(scopedExtensionSkipReason);
      const lengthIds = new Set(lengthIssues.map((issue) => issue.id));
      issueCoverage = issueCoverage.map((entry) =>
        lengthIds.has(entry.id)
          ? {
            ...entry,
            status: "unaddressed",
            reason: `scoped-extension-skipped: ${scopedExtensionSkipReason}`,
          }
          : entry,
      );
    } else {
      working = `${working}\n\n${extension}`;
      scopedExtensionApplied = true;
      const lengthIds = new Set(lengthIssues.map((issue) => issue.id));
      issueCoverage = issueCoverage.map((entry) =>
        lengthIds.has(entry.id)
          ? { ...entry, status: "patched", reason: "scopedExtension applied" }
          : entry,
      );
    }
  }

  const changed = appliedPatches.length > 0 || scopedExtensionApplied;
  const emittedAnyPatchOrExtension = params.plan.patches.length > 0 || Boolean(extension);
  const status: RevisionDiff["status"] = changed
    ? "applied"
    : emittedAnyPatchOrExtension
      ? "skipped"
      : "no-patches";

  return {
    status,
    reason: changed
      ? "Applied revision patches."
      : emittedAnyPatchOrExtension
        ? "All revision patches were skipped."
        : "Planner emitted no patches.",
    appliedPatches,
    skippedPatches,
    issueCoverage,
    notes,
    preProse: params.prose,
    finalProse: working,
  };
}

export function applyRevisionDiffToSelected(
  selectedArtifact: ArtifactEnvelope<SelectedChapter>,
  diffArtifact: ArtifactEnvelope<RevisionDiff>,
): ArtifactEnvelope<SelectedChapter> {
  return {
    ...selectedArtifact,
    createdAt: new Date().toISOString(),
    data: {
      ...selectedArtifact.data,
      prose: diffArtifact.data.finalProse,
      wordCount: countWords(diffArtifact.data.finalProse),
    },
  };
}

import type {
  DraftReview,
  FinalAuditReport,
  IssueOrigin,
  ReviewIssue,
  TrackedIssue,
} from "../types/index.js";

const MANDATORY_ORIGINS = new Set<IssueOrigin>([
  "judge-blocking",
  "judge-weakness",
  "judge-revision-action",
  "judge-issue-error",
  "audit-error-model",
  "audit-error-validator",
]);

function issueId(origin: IssueOrigin, index: number): string {
  return `${origin}#${index + 1}`;
}

function tracked(origin: IssueOrigin, index: number, title: string, fixHint: string | null): TrackedIssue {
  return {
    id: issueId(origin, index),
    origin,
    title,
    fixHint,
    mandatory: MANDATORY_ORIGINS.has(origin),
  };
}

function reviewIssueTitle(issue: ReviewIssue): string {
  const evidence = issue.evidence ? ` Evidence: ${issue.evidence}` : "";
  return `${issue.category}: ${issue.detail}${evidence}`;
}

function appendIssues(
  out: TrackedIssue[],
  origin: IssueOrigin,
  values: Array<{ title: string; fixHint: string | null }>,
): void {
  values.forEach((value, index) => {
    out.push(tracked(origin, index, value.title, value.fixHint));
  });
}

export function buildTrackedIssues(params: {
  review?: DraftReview;
  audit?: FinalAuditReport;
}): TrackedIssue[] {
  const out: TrackedIssue[] = [];
  const { review, audit } = params;

  if (review) {
    appendIssues(
      out,
      "judge-blocking",
      review.blockingIssues.map((issue) => ({ title: issue, fixHint: null })),
    );
    appendIssues(
      out,
      "judge-weakness",
      review.weaknesses.map((issue) => ({ title: issue, fixHint: null })),
    );
    appendIssues(
      out,
      "judge-revision-action",
      review.revisionActions.map((action) => ({ title: action, fixHint: action })),
    );
    appendIssues(
      out,
      "judge-issue-error",
      review.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => ({ title: reviewIssueTitle(issue), fixHint: issue.suggestedFix ?? null })),
    );
    appendIssues(
      out,
      "judge-issue-warning",
      review.issues
        .filter((issue) => issue.severity === "warning")
        .map((issue) => ({ title: reviewIssueTitle(issue), fixHint: issue.suggestedFix ?? null })),
    );
  }

  if (audit) {
    appendIssues(
      out,
      "audit-error-model",
      audit.issues
        .filter((issue) => issue.severity === "error" && (issue.source ?? "model") === "model")
        .map((issue) => ({ title: issue.title, fixHint: issue.fixInstruction || issue.description })),
    );
    appendIssues(
      out,
      "audit-error-validator",
      audit.issues
        .filter((issue) => issue.severity === "error" && issue.source === "validator")
        .map((issue) => ({ title: issue.title, fixHint: issue.fixInstruction || issue.description })),
    );
    appendIssues(
      out,
      "audit-warning-model",
      audit.issues
        .filter((issue) => issue.severity === "warning" && (issue.source ?? "model") === "model")
        .map((issue) => ({ title: issue.title, fixHint: issue.fixInstruction || issue.description })),
    );
    appendIssues(
      out,
      "audit-warning-validator",
      audit.issues
        .filter((issue) => issue.severity === "warning" && issue.source === "validator")
        .map((issue) => ({ title: issue.title, fixHint: issue.fixInstruction || issue.description })),
    );
  }

  return out;
}

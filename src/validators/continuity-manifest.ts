import type {
  ChapterPacket,
  ContinuityManifest,
  ValidatorIssue,
} from "../types/index.js";

function addIssue(
  issues: ValidatorIssue[],
  severity: ValidatorIssue["severity"],
  code: string,
  message: string,
  evidence: string[] = [],
): void {
  issues.push({ severity, code, message, evidence });
}

function lower(s: string): string {
  return s.toLowerCase();
}

function proseMentions(prose: string, name: string): boolean {
  if (!name) return false;
  return lower(prose).includes(lower(name));
}

const TIMELINE_OFFSET_PATTERN = /^([+-])?(\d+):(\d+)$/;

function parseTimelineOffset(raw: string): number | null {
  const trimmed = raw.replace(/^T\+?/i, "").trim();
  if (trimmed === "baseline") return 0;
  const match = trimmed.match(TIMELINE_OFFSET_PATTERN);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return sign * (hours * 60 + minutes);
}

const MOTIF_STAGE_ORDER = ["introduced", "recurring", "inverted", "paid-off"] as const;

export function runContinuityManifestValidators(params: {
  manifest: ContinuityManifest | null;
  packet: ChapterPacket;
  prose: string;
}): ValidatorIssue[] {
  if (!params.manifest) return [];

  const issues: ValidatorIssue[] = [];
  const slice = params.packet.continuityActiveSlice;
  const chapterNumber = params.packet.chapterNumber;
  const proseLower = lower(params.prose);

  for (const obj of params.manifest.persistentObjects) {
    if (obj.lastSeenChapter > chapterNumber) {
      addIssue(
        issues,
        "warning",
        "CONTINUITY_OBJECT_FUTURE_LASTSEEN",
        `Persistent object "${obj.name}" lists lastSeenChapter ${obj.lastSeenChapter} which is ahead of chapter ${chapterNumber}.`,
        [obj.name],
      );
    }
    if (obj.lastSeenChapter > 0 && obj.lastSeenChapter < chapterNumber - 3) {
      if (proseMentions(params.prose, obj.name)) {
        addIssue(
          issues,
          "warning",
          "CONTINUITY_DORMANT_OBJECT_REVIVAL",
          `Persistent object "${obj.name}" reappears after ${chapterNumber - obj.lastSeenChapter} chapters; verify continuity state hasn't sealed it.`,
          [obj.name],
        );
      }
    }
    if (obj.state.toLowerCase().includes("sealed") && proseLower.includes(`${lower(obj.name)} open`)) {
      addIssue(
        issues,
        "error",
        "CONTINUITY_SEALED_REGRESSION",
        `Persistent object "${obj.name}" is recorded as sealed but the chapter shows it open.`,
        [obj.name, obj.state],
      );
    }
  }

  if (params.manifest.timelineAnchors.length >= 2) {
    const offsets = params.manifest.timelineAnchors
      .map((anchor) => ({ anchor, value: parseTimelineOffset(anchor.offset) }))
      .filter((entry): entry is { anchor: typeof entry.anchor; value: number } => entry.value !== null);
    for (let i = 1; i < offsets.length; i += 1) {
      const prev = offsets[i - 1]!;
      const curr = offsets[i]!;
      if (curr.value < prev.value) {
        addIssue(
          issues,
          "error",
          "CONTINUITY_TIMELINE_REVERSAL",
          `Timeline anchor "${curr.anchor.label}" (${curr.anchor.offset}) is earlier than preceding anchor "${prev.anchor.label}" (${prev.anchor.offset}).`,
          [curr.anchor.label, prev.anchor.label],
        );
      }
    }
  }

  for (const reveal of params.manifest.revealSchedule) {
    if (reveal.chapter > chapterNumber) {
      const sliceMissing = !slice?.revealSchedule.some((r) => r.thread === reveal.thread);
      if (proseMentions(params.prose, reveal.thread) && sliceMissing) {
        addIssue(
          issues,
          "error",
          "CONTINUITY_PREMATURE_REVEAL",
          `Reveal "${reveal.thread}" scheduled for chapter ${reveal.chapter} appears in chapter ${chapterNumber}.`,
          [reveal.thread, String(reveal.chapter)],
        );
      }
    }
  }

  for (const motif of params.manifest.motifStates) {
    const stageIndex = MOTIF_STAGE_ORDER.indexOf(motif.stage);
    if (stageIndex > 0 && motif.lastChapter === 0) {
      addIssue(
        issues,
        "warning",
        "CONTINUITY_MOTIF_STAGE_SKIP",
        `Motif "${motif.motif}" is at stage "${motif.stage}" but has never been seen in a chapter (lastChapter=0).`,
        [motif.motif, motif.stage],
      );
    }
  }

  return issues;
}

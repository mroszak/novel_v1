import path from "node:path";

import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  ChapterDelta,
  ContinuityManifest,
  ContinuityRevealStatus,
  ContinuityState,
  PersistentObject,
  RevealEntry,
} from "../types/index.js";
import { fileExists, readJson, writeJson } from "../utils/index.js";
import { createArtifact } from "./stage-utils.js";

function statePath(chapterNumber: number): string {
  return path.join(config.paths.blueprintArtifacts, `continuity-state-after-${chapterNumber}.json`);
}

function initialStateFromManifest(manifest: ContinuityManifest): ContinuityState {
  return {
    chapterNumber: 0,
    persistentObjects: manifest.persistentObjects.map((obj) => ({ ...obj })),
    spatialRegistry: manifest.spatialRegistry.map((sn) => ({ ...sn })),
    timelineAnchors: manifest.timelineAnchors.map((ta) => ({ ...ta })),
    revealSchedule: manifest.revealSchedule.map((reveal) => ({ ...reveal, delivered: false })),
    relationshipStates: manifest.relationshipStates.map((rs) => ({ ...rs })),
    motifStates: manifest.motifStates.map((ms) => ({ ...ms })),
    notes: [],
  };
}

function emptyState(chapterNumber: number): ContinuityState {
  return {
    chapterNumber,
    persistentObjects: [],
    spatialRegistry: [],
    timelineAnchors: [],
    revealSchedule: [],
    relationshipStates: [],
    motifStates: [],
    notes: ["No continuity manifest defined; engine carries no structured state."],
  };
}

function mentionedInProse(prose: string, name: string): boolean {
  if (!name) return false;
  const lowerProse = prose.toLowerCase();
  return lowerProse.includes(name.toLowerCase());
}

function bumpObjects(
  prose: string,
  objects: PersistentObject[],
  chapterNumber: number,
): PersistentObject[] {
  return objects.map((obj) => {
    if (mentionedInProse(prose, obj.name)) {
      return { ...obj, lastSeenChapter: chapterNumber };
    }
    return obj;
  });
}

function deliverReveals(
  reveals: ContinuityRevealStatus[],
  chapterNumber: number,
  delivered: ReadonlySet<string>,
): ContinuityRevealStatus[] {
  return reveals.map((reveal) => {
    if (reveal.delivered) return reveal;
    if (reveal.chapter <= chapterNumber && delivered.has(reveal.thread.toLowerCase())) {
      return { ...reveal, delivered: true };
    }
    return reveal;
  });
}

function bumpMotifs(
  prose: string,
  motifs: ContinuityState["motifStates"],
  chapterNumber: number,
): ContinuityState["motifStates"] {
  return motifs.map((motif) => {
    if (mentionedInProse(prose, motif.motif)) {
      const stage = motif.stage === "introduced" ? "recurring" : motif.stage;
      return { ...motif, lastChapter: chapterNumber, stage };
    }
    return motif;
  });
}

function applyDeltaToObjects(
  objects: PersistentObject[],
  delta: ChapterDelta | undefined,
  chapterNumber: number,
): PersistentObject[] {
  if (!delta || delta.entityMentions.length === 0) return objects;
  const byKey = new Map(objects.map((obj) => [obj.name.toLowerCase(), obj]));
  for (const mention of delta.entityMentions) {
    const target = byKey.get(mention.name.toLowerCase());
    if (!target) continue;
    const lastChange = mention.stateChanges[mention.stateChanges.length - 1];
    if (lastChange && lastChange.trim().length > 0) {
      byKey.set(mention.name.toLowerCase(), {
        ...target,
        state: lastChange.trim(),
        lastSeenChapter: chapterNumber,
      });
    }
  }
  return objects.map((obj) => byKey.get(obj.name.toLowerCase()) ?? obj);
}

function applyDeltaToReveals(
  reveals: ContinuityRevealStatus[],
  delta: ChapterDelta | undefined,
  chapterNumber: number,
): ContinuityRevealStatus[] {
  if (!delta || delta.revealPayoffMovement.length === 0) return reveals;
  const deliveredKeys = new Set(
    delta.revealPayoffMovement
      .filter((m) => m.movementType === "reveal" || m.movementType === "payoff")
      .map((m) => m.thread.toLowerCase()),
  );
  if (deliveredKeys.size === 0) return reveals;
  return reveals.map((reveal) => {
    if (reveal.delivered) return reveal;
    if (reveal.chapter <= chapterNumber && deliveredKeys.has(reveal.thread.toLowerCase())) {
      return { ...reveal, delivered: true };
    }
    return reveal;
  });
}

// Builds declared reveals from an approved spec's revealControl. `withhold`
// is excluded by design: a withheld thread is explicitly NOT delivered this
// chapter, so it must NOT enter the deliveredKeys set inside
// updateContinuityState.
export function buildDeclaredRevealsFromSpec(params: {
  revealControl: { show?: string[]; hint?: string[]; reveal?: string[]; withhold?: string[] } | null | undefined;
  chapterNumber: number;
}): RevealEntry[] {
  if (!params.revealControl) return [];
  const out: RevealEntry[] = [];
  for (const mode of ["show", "hint", "reveal"] as const) {
    const threads = params.revealControl[mode] ?? [];
    for (const thread of threads) {
      out.push({ thread, learner: "reader", chapter: params.chapterNumber, mode });
    }
  }
  return out;
}

export async function updateContinuityState(params: {
  chapterNumber: number;
  manifest: ContinuityManifest | null;
  publishedProse: string;
  declaredReveals?: RevealEntry[];
  chapterDelta?: ChapterDelta;
  blueprintHash: string;
  blueprintVersion: string;
}): Promise<ArtifactEnvelope<ContinuityState> | null> {
  if (!params.manifest) {
    return null;
  }

  // Use the same soft-validating loader as the next chapter's packet
  // builder so an out-of-blueprint state file does not silently corrupt
  // mid-run state. On mismatch we seed from the static manifest.
  const previousArtifact = params.chapterNumber > 1
    ? await loadPersistedContinuityState({
        chapterNumber: params.chapterNumber - 1,
        blueprintHash: params.blueprintHash,
        blueprintVersion: params.blueprintVersion,
      })
    : null;
  const previous = previousArtifact?.data ?? initialStateFromManifest(params.manifest);

  const deliveredKeys = new Set(
    (params.declaredReveals ?? []).map((reveal) => reveal.thread.toLowerCase()),
  );

  const objectsAfterProse = bumpObjects(params.publishedProse, previous.persistentObjects, params.chapterNumber);
  const objectsAfterDelta = applyDeltaToObjects(objectsAfterProse, params.chapterDelta, params.chapterNumber);

  const revealsAfterDeclared = deliverReveals(previous.revealSchedule, params.chapterNumber, deliveredKeys);
  const revealsAfterDelta = applyDeltaToReveals(revealsAfterDeclared, params.chapterDelta, params.chapterNumber);

  const irreversibleNotes = (params.chapterDelta?.irreversibleChanges ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => `ch${params.chapterNumber}: ${entry}`);

  const next: ContinuityState = {
    chapterNumber: params.chapterNumber,
    persistentObjects: objectsAfterDelta,
    spatialRegistry: previous.spatialRegistry,
    timelineAnchors: previous.timelineAnchors,
    revealSchedule: revealsAfterDelta,
    relationshipStates: previous.relationshipStates,
    motifStates: bumpMotifs(params.publishedProse, previous.motifStates, params.chapterNumber),
    notes: [...previous.notes, ...irreversibleNotes],
  };

  const artifact = createArtifact<ContinuityState>({
    artifactType: "continuity-state",
    blueprintHash: params.blueprintHash,
    blueprintVersion: params.blueprintVersion,
    chapterNumber: params.chapterNumber,
    data: next,
  });

  await writeJson(statePath(params.chapterNumber), artifact);
  return artifact;
}

// Soft-fail loader: returns null on metadata mismatch so the next chapter's
// packet silently falls back to the static manifest rather than throwing.
export async function loadPersistedContinuityState(params: {
  chapterNumber: number;
  blueprintHash?: string;
  blueprintVersion?: string;
}): Promise<ArtifactEnvelope<ContinuityState> | null> {
  const target = statePath(params.chapterNumber);
  if (!(await fileExists(target))) return null;
  let artifact: ArtifactEnvelope<ContinuityState>;
  try {
    artifact = await readJson<ArtifactEnvelope<ContinuityState>>(target);
  } catch {
    return null;
  }
  if (artifact.schemaVersion !== config.artifactSchemaVersion) return null;
  if (artifact.artifactType !== "continuity-state") return null;
  if (params.blueprintHash && artifact.blueprintHash !== params.blueprintHash) return null;
  if (params.blueprintVersion && artifact.blueprintVersion !== params.blueprintVersion) return null;
  return artifact;
}

export function projectStateToManifest(state: ContinuityState): ContinuityManifest {
  return {
    persistentObjects: state.persistentObjects.map((obj) => ({ ...obj })),
    spatialRegistry: state.spatialRegistry.map((sn) => ({ ...sn })),
    timelineAnchors: state.timelineAnchors.map((ta) => ({ ...ta })),
    revealSchedule: state.revealSchedule.map(({ delivered: _delivered, ...rest }) => ({ ...rest })),
    relationshipStates: state.relationshipStates.map((rs) => ({ ...rs })),
    motifStates: state.motifStates.map((ms) => ({ ...ms })),
  };
}

export const _internals = {
  initialStateFromManifest,
  emptyState,
  bumpObjects,
  deliverReveals,
  bumpMotifs,
  applyDeltaToObjects,
  applyDeltaToReveals,
};

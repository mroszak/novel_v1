import path from "node:path";

import { config } from "../config.js";
import type {
  ArtifactEnvelope,
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

async function loadPreviousState(chapterNumber: number): Promise<ContinuityState | null> {
  if (chapterNumber <= 1) return null;
  const target = statePath(chapterNumber - 1);
  if (!(await fileExists(target))) return null;
  try {
    const artifact = await readJson<ArtifactEnvelope<ContinuityState>>(target);
    return artifact.data;
  } catch {
    return null;
  }
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

export async function updateContinuityState(params: {
  chapterNumber: number;
  manifest: ContinuityManifest | null;
  publishedProse: string;
  declaredReveals?: RevealEntry[];
  blueprintHash: string;
  blueprintVersion: string;
}): Promise<ArtifactEnvelope<ContinuityState> | null> {
  if (!params.manifest) {
    return null;
  }

  const previous = (await loadPreviousState(params.chapterNumber))
    ?? initialStateFromManifest(params.manifest);

  const deliveredKeys = new Set(
    (params.declaredReveals ?? []).map((reveal) => reveal.thread.toLowerCase()),
  );

  const next: ContinuityState = {
    chapterNumber: params.chapterNumber,
    persistentObjects: bumpObjects(params.publishedProse, previous.persistentObjects, params.chapterNumber),
    spatialRegistry: previous.spatialRegistry,
    timelineAnchors: previous.timelineAnchors,
    revealSchedule: deliverReveals(previous.revealSchedule, params.chapterNumber, deliveredKeys),
    relationshipStates: previous.relationshipStates,
    motifStates: bumpMotifs(params.publishedProse, previous.motifStates, params.chapterNumber),
    notes: [...previous.notes],
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

export const _internals = {
  initialStateFromManifest,
  emptyState,
  loadPreviousState,
  bumpObjects,
  deliverReveals,
  bumpMotifs,
};

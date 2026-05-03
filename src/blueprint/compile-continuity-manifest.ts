import type { ContinuityManifest, ParsedStoryBlueprint } from "../types/index.js";

export function compileContinuityManifest(blueprint: ParsedStoryBlueprint): ContinuityManifest | null {
  return blueprint.continuityManifest;
}

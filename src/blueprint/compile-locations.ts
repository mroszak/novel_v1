import type { Locations, ParsedStoryBlueprint } from "../types/index.js";

export function compileLocations(blueprint: ParsedStoryBlueprint): Locations | null {
  return blueprint.locations;
}

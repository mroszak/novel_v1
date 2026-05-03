import type { MarketPromise, ParsedStoryBlueprint } from "../types/index.js";

export function compileMarketPromise(blueprint: ParsedStoryBlueprint): MarketPromise | null {
  return blueprint.marketPromise;
}

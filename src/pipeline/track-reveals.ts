import type { ChapterDelta, RevealLedgerEntry, RollingMemory } from "../types/index.js";
import { normalizeLookupKey } from "../utils/index.js";

export function trackReveals(
  previousMemory: RollingMemory | null,
  delta: ChapterDelta,
): RevealLedgerEntry[] {
  const ledger = new Map<string, RevealLedgerEntry>();

  for (const entry of previousMemory?.revealPayoffLedger ?? []) {
    ledger.set(normalizeLookupKey(entry.thread), entry);
  }

  for (const movement of delta.revealPayoffMovement) {
    ledger.set(normalizeLookupKey(movement.thread), {
      thread: movement.thread,
      latestMovement: movement.movementType,
      description: movement.description,
      status: movement.status,
      chapterNumber: movement.chapterNumber,
    });
  }

  return Array.from(ledger.values()).sort((left, right) => left.thread.localeCompare(right.thread));
}

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "then",
  "there",
  "this",
  "to",
  "with",
]);

export function nowIso(): string {
  return new Date().toISOString();
}

export async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
}

export async function readText(targetPath: string): Promise<string> {
  return readFile(targetPath, "utf8");
}

export async function writeText(targetPath: string, contents: string): Promise<void> {
  await ensureDirectory(path.dirname(targetPath));
  await writeFile(targetPath, contents.endsWith("\n") ? contents : `${contents}\n`, "utf8");
}

export async function readJson<T>(targetPath: string): Promise<T> {
  return JSON.parse(await readText(targetPath)) as T;
}

export async function readJsonIfExists<T>(targetPath: string): Promise<T | null> {
  if (!(await fileExists(targetPath))) {
    return null;
  }

  return readJson<T>(targetPath);
}

export async function writeJson(targetPath: string, value: unknown): Promise<void> {
  await writeText(targetPath, JSON.stringify(value, null, 2));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stripFrontmatter(markdown: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!markdown.startsWith("---")) {
    return { frontmatter: {}, body: markdown };
  }

  const lines = markdown.split(/\r?\n/);
  if (lines.length < 3 || lines[0] !== "---") {
    return { frontmatter: {}, body: markdown };
  }

  const frontmatter: Record<string, string> = {};
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === "---") {
      index += 1;
      break;
    }

    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      const key = match[1] ?? "";
      const value = match[2] ?? "";
      frontmatter[key.trim()] = value.trim().replace(/^"|"$/g, "");
    }
  }

  return {
    frontmatter,
    body: lines.slice(index).join("\n"),
  };
}

export function splitSections(markdown: string, level: number): Map<string, string> {
  const marker = "#".repeat(level);
  const headingPattern = new RegExp(`^${marker}\\s+(.+?)\\s*$`);
  const sections = new Map<string, string>();
  const lines = markdown.split(/\r?\n/);

  let currentTitle: string | null = null;
  let currentLines: string[] = [];

  const commit = (): void => {
    if (!currentTitle) {
      return;
    }
    sections.set(currentTitle, currentLines.join("\n").trim());
  };

  for (const line of lines) {
    const headingMatch = line.match(headingPattern);
    if (headingMatch) {
      commit();
      currentTitle = (headingMatch[1] ?? "").trim();
      currentLines = [];
      continue;
    }

    if (currentTitle) {
      currentLines.push(line);
    }
  }

  commit();
  return sections;
}

export function parseStructuredFields(block: string): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {};
  const lines = block.split(/\r?\n/);
  let currentKey: string | null = null;

  for (const line of lines) {
    const topLevelMatch = line.match(/^- ([^:]+):\s*(.*)$/);
    if (topLevelMatch) {
      const key = (topLevelMatch[1] ?? "").trim();
      const value = (topLevelMatch[2] ?? "").trim();
      fields[key] = value ? value : [];
      currentKey = key;
      continue;
    }

    const nestedBulletMatch = line.match(/^  - (.+)$/);
    if (nestedBulletMatch && currentKey) {
      const nextValue = (nestedBulletMatch[1] ?? "").trim();
      const currentValue = fields[currentKey];
      if (Array.isArray(currentValue)) {
        currentValue.push(nextValue);
      } else if (typeof currentValue === "string" && currentValue.length > 0) {
        fields[currentKey] = [currentValue, nextValue];
      } else {
        fields[currentKey] = [nextValue];
      }
      continue;
    }

    const continuationMatch = line.match(/^  (.+)$/);
    if (continuationMatch && currentKey && typeof fields[currentKey] === "string") {
      const currentValue = fields[currentKey] as string;
      const continuation = (continuationMatch[1] ?? "").trim();
      fields[currentKey] = currentValue.length > 0
        ? `${currentValue}\n${continuation}`
        : continuation;
    }
  }

  return fields;
}

export function asString(
  value: string | string[] | undefined,
  fallback = "",
): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.join("\n").trim();
  }

  return fallback;
}

export function asList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return [];
}

export function parseInteger(value: string | string[] | undefined, fallback: number): number {
  const text = asString(value);
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseKeyValueList(items: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of items) {
    const separatorIndex = item.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = item.slice(0, separatorIndex).trim();
    const value = item.slice(separatorIndex + 1).trim();
    if (key && value && !value.toLowerCase().startsWith("replace ")) {
      result[key] = value;
    }
  }
  return result;
}

export function normalizeLookupKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function summarizeText(value: string, maxLength = 320): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}...` : collapsed;
}

export function slugify(value: string): string {
  return normalizeLookupKey(value).replace(/\s+/g, "-");
}

export function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

export function clipList<T>(items: T[], maxItems: number): T[] {
  return items.slice(0, Math.max(0, maxItems));
}

export function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const normalized = normalizeLookupKey(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(item.trim());
  }

  return result;
}

export function truncateWords(value: string, maxWords: number): string {
  const words = value.trim().split(/\s+/);
  if (words.length <= maxWords) {
    return value.trim();
  }
  return `${words.slice(0, maxWords).join(" ")}...`;
}

export function extractKeywords(value: string, maxKeywords = 6): string[] {
  const parts = normalizeLookupKey(value)
    .split(" ")
    .filter((part) => part.length >= 4 && !STOPWORDS.has(part));

  return dedupeStrings(parts).slice(0, maxKeywords);
}

export function containsKeywordSet(haystack: string, keywords: string[]): boolean {
  const normalized = normalizeLookupKey(haystack);
  return keywords.some((keyword) => normalized.includes(keyword));
}

export function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function roundTo(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

export function tailExcerpt(text: string, maxWords: number): string {
  const paragraphs = text.split(/\n\n+/).filter(Boolean);
  const result: string[] = [];
  let total = 0;
  for (let i = paragraphs.length - 1; i >= 0 && total < maxWords; i -= 1) {
    const p = paragraphs[i] ?? "";
    result.unshift(p);
    total += countWords(p);
  }
  return result.join("\n\n");
}

#!/usr/bin/env node
import "dotenv/config";

import { config } from "./config.js";
import { runChapter } from "./pipeline/run-chapter.js";
import { runSmokeTest } from "./pipeline/run-smoke-test.js";
import {
  QUALITY_PROFILES,
  RERUN_STAGES,
  type QualityProfile,
  type RerunStage,
  type RunChapterOptions,
} from "./types/index.js";

function printHelp(): void {
  console.log(`Novel Creator GPT

Usage:
  npm run chapter -- --chapter 1
  npm run chapter -- --compile-blueprint
  npm run chapter -- --smoke

Options:
  --chapter <N>            Chapter number to generate
  --quality <profile>      ${QUALITY_PROFILES.join(", ")} (default: ${config.defaultQualityProfile})
  --packet-only            Stop after writing the chapter packet artifact
  --spec-only              Stop after writing the approved spec artifact
  --draft-only             Draft from existing packet + approved spec checkpoints
  --judge-only             Run judge + revision + selection (+ literary retries) from an existing draft checkpoint
  --audit-only             Run memory + audit + fix loop from existing selected artifacts
  --rerun-from <stage>     ${RERUN_STAGES.join(", ")}
  --estimate-cost          Write a per-stage token/cost estimate without running live generation
  --compile-blueprint      Compile and cache blueprint artifacts only
  --smoke                  Run the full pipeline against the built-in smoke fixture
  --blueprint <path>       Alternate blueprint path
  --skip-spec-critique     Skip the optional Opus spec-critique pass (required critique for high-risk/escalated chapters still runs)
  --no-genre-ai            Skip GPT genre refinement and use deterministic controls only
  --help                   Show help
`);
}

function expectNext(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgs(): RunChapterOptions {
  const args = process.argv.slice(2);
  const options: RunChapterOptions = {
    blueprintPath: config.paths.blueprint,
    chapterNumber: 1,
    qualityProfile: config.defaultQualityProfile,
    packetOnly: false,
    specOnly: false,
    draftOnly: false,
    judgeOnly: false,
    auditOnly: false,
    rerunFrom: null,
    compileBlueprintOnly: false,
    estimateCost: false,
    smoke: false,
    noGenreAi: false,
    skipSpecCritique: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--chapter":
      case "-c": {
        const value = expectNext(args, index, arg);
        options.chapterNumber = Number.parseInt(value, 10);
        index += 1;
        break;
      }
      case "--quality": {
        const value = expectNext(args, index, arg).toLowerCase() as QualityProfile;
        if (!QUALITY_PROFILES.includes(value)) {
          throw new Error(`--quality must be one of ${QUALITY_PROFILES.join(", ")}.`);
        }
        options.qualityProfile = value;
        index += 1;
        break;
      }
      case "--packet-only":
        options.packetOnly = true;
        break;
      case "--spec-only":
        options.specOnly = true;
        break;
      case "--draft-only":
        options.draftOnly = true;
        break;
      case "--judge-only":
        options.judgeOnly = true;
        break;
      case "--audit-only":
        options.auditOnly = true;
        break;
      case "--rerun-from": {
        const value = expectNext(args, index, arg).toLowerCase() as RerunStage;
        if (!RERUN_STAGES.includes(value)) {
          throw new Error(`--rerun-from must be one of ${RERUN_STAGES.join(", ")}.`);
        }
        options.rerunFrom = value;
        index += 1;
        break;
      }
      case "--compile-blueprint":
        options.compileBlueprintOnly = true;
        break;
      case "--estimate-cost":
        options.estimateCost = true;
        break;
      case "--smoke":
        options.smoke = true;
        break;
      case "--blueprint":
        options.blueprintPath = expectNext(args, index, arg);
        index += 1;
        break;
      case "--skip-spec-critique":
        options.skipSpecCritique = true;
        break;
      case "--no-genre-ai":
        options.noGenreAi = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.chapterNumber) || options.chapterNumber < 1) {
    throw new Error("--chapter must be a positive integer.");
  }

  if (options.packetOnly && options.specOnly) {
    throw new Error("--packet-only and --spec-only cannot be combined.");
  }

  if (options.packetOnly && options.draftOnly) {
    throw new Error("--packet-only and --draft-only cannot be combined.");
  }

  if (options.compileBlueprintOnly && options.smoke) {
    throw new Error("--compile-blueprint and --smoke cannot be combined.");
  }

  return options;
}

async function main(): Promise<void> {
  try {
    const options = parseArgs();
    const result = options.smoke
      ? await runSmokeTest(options)
      : await runChapter(options);

    console.log(`Status: ${result.status}`);
    console.log(`Blueprint hash: ${result.blueprintHash}`);
    if (result.packetArtifactPath) {
      console.log(`Packet: ${result.packetArtifactPath}`);
    }
    if (result.approvedSpecArtifactPath) {
      console.log(`Approved spec: ${result.approvedSpecArtifactPath}`);
    }
    if (result.draftArtifactPath) {
      console.log(`Draft artifact: ${result.draftArtifactPath}`);
    }
    if (result.selectedArtifactPath) {
      console.log(`Selected chapter: ${result.selectedArtifactPath}`);
    }
    if (result.memoryArtifactPath) {
      console.log(`Memory: ${result.memoryArtifactPath}`);
    }
    if (result.auditArtifactPath) {
      console.log(`Audit: ${result.auditArtifactPath}`);
    }
    if (result.publishedChapterPath) {
      console.log(`Published chapter: ${result.publishedChapterPath}`);
    }
    if (result.costEstimateArtifactPath) {
      console.log(`Cost estimate: ${result.costEstimateArtifactPath}`);
    }
    if (result.costSummaryArtifactPath) {
      console.log(`Cost summary: ${result.costSummaryArtifactPath}`);
    }
    if (result.statusArtifactPath) {
      console.log(`Status artifact: ${result.statusArtifactPath}`);
    }
    if (result.reusedArtifacts.length > 0) {
      console.log(`Reused artifacts: ${result.reusedArtifacts.join(", ")}`);
    }
    if (result.status !== "SUCCESS") {
      process.exit(2);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();

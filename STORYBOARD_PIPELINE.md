# Storyboard Pipeline

Generate rough visual storyboards from published chapters using GPT for scene decomposition and gpt-image-1 for panel generation.

## Overview

The storyboard pipeline is a post-publish stage that reads a completed chapter and its approved spec, decomposes the prose into visual beats, generates a rough pencil-sketch storyboard panel for each beat, and assembles the results into a browsable HTML storyboard.

It follows the same architectural patterns as the existing chapter pipeline: typed async stages, artifact envelopes, JSON checkpointing, CLI flags, smoke mode, and the shared OpenAI client.

## Pipeline Flow

```
published chapter + approved spec + genre contract
    ↓
[1] decompose-scenes (GPT structured output)
    → extracts 8-12 visual beats from the prose
    ↓
[2] generate-panels (gpt-image-1 via Image API)
    → generates one PNG per beat, first panel used as style reference for the rest
    ↓
[3] assemble-storyboard
    → writes an HTML viewer with panels, captions, and scene metadata
```

## Requirements

- A published chapter at `chapters/chapter-N.md`
- An approved spec artifact at `artifacts/chapters/chapter-N-approved-spec.json`
- A compiled genre contract at `artifacts/blueprint/genre-contract.json`
- `OPENAI_API_KEY` in `.env` (already required by the main pipeline)

No new API keys or dependencies are needed.

## New Files

```
src/
  pipeline/
    decompose-scenes.ts        # Stage 1: GPT scene decomposition
    generate-panels.ts         # Stage 2: gpt-image-1 panel generation
    assemble-storyboard.ts     # Stage 3: HTML assembly
    run-storyboard.ts          # Storyboard pipeline orchestrator
  api/
    openai.ts                  # Add: generateImage() function
  config.ts                    # Add: storyboard stage profile + image settings
  types/
    index.ts                   # Add: storyboard-related types

artifacts/
  storyboards/
    chapter-N-scenes.json      # Scene decomposition artifact
    chapter-N-panels.json      # Panel generation manifest artifact

storyboards/
  chapter-N/
    panel-01.png               # Generated panel images
    panel-02.png
    ...
    index.html                 # Assembled storyboard viewer
```

## Stage 1: Scene Decomposition

### Input

- Published chapter prose (markdown string)
- Approved spec `scenePlan` (structured scene objectives and summaries)
- Genre contract tone keywords and sensory density

### Process

Call `generateStructuredOutput` with the existing OpenAI client using a new `sceneDecomposition` stage profile. The prompt instructs GPT to read the chapter prose and extract 8-12 visual beats, each representing a single storyboard panel.

The approved spec's `scenePlan` is included as context so GPT can align its beats with the intended narrative structure rather than inventing its own interpretation.

### Output Schema

```typescript
interface StoryboardScene {
  panelNumber: number;
  sceneRef: number;                // links to scenePlan.sceneNumber
  shotType: string;                // "wide", "medium", "close-up", "extreme close-up", "overhead"
  description: string;             // 1-2 sentence visual description of the moment
  characters: string[];            // names of characters visible in the panel
  location: string;                // setting for this panel
  mood: string;                    // emotional/atmospheric tone
  captionExcerpt: string;          // short prose excerpt from the chapter for display
  imagePrompt: string;             // full image generation prompt (without style suffix)
}

interface SceneDecomposition {
  chapterNumber: number;
  chapterTitle: string;
  panelCount: number;
  panels: StoryboardScene[];
}
```

### Stage Profile

```typescript
sceneDecomposition: {
  stageName: "scene-decomposition",
  provider: "openai",
  model: openAiPrimaryModel,
  reasoningEffort: "medium",
  verbosity: "low",
  inputTokenBudget: 20000,
  maxOutputTokens: 6000,
  contextWindowTokens: 40000,
}
```

### Artifact

Written to `artifacts/storyboards/chapter-N-scenes.json` as an `ArtifactEnvelope<SceneDecomposition>`.

## Stage 2: Panel Generation

### Input

- Scene decomposition artifact (the panels array)
- Style configuration (locked style suffix + image settings)

### Process

1. Build the full prompt for each panel by concatenating the panel's `imagePrompt` with the locked style suffix.
2. Generate panel 1 using the Image API `generations` endpoint.
3. For panels 2-N, use the Image API `edits` endpoint, passing panel 1 as a style reference image. This anchors the aesthetic across the chapter.
4. Save each panel as `storyboards/chapter-N/panel-NN.png`.
5. Panels are generated sequentially (not in parallel) to allow reference chaining and to stay within rate limits.

### Style Suffix

A fixed string appended to every image prompt:

```
Rough pencil storyboard sketch on white paper. Loose crosshatched ink linework,
heavy blacks, high contrast, no color, cinematic widescreen 16:9 composition.
Graphic novel thumbnail style. Atmospheric and moody.
```

This can be overridden in config or via an env var for experimentation.

### OpenAI Image API Integration

Add a new function to `src/api/openai.ts`:

```typescript
export async function generateImage(params: {
  prompt: string;
  size?: "1536x1024" | "1024x1024" | "1024x1536";
  quality?: "low" | "medium" | "high";
  referenceImages?: Buffer[];
}): Promise<{ imageBase64: string }> {
  const client = getClient();

  if (params.referenceImages?.length) {
    // Use edits endpoint with reference images for style consistency
    const result = await withRetry(() => client.images.edit({
      model: "gpt-image-1",
      prompt: params.prompt,
      image: params.referenceImages,
      size: params.size ?? "1536x1024",
      quality: params.quality ?? "medium",
    }));
    return { imageBase64: result.data[0].b64_json };
  }

  // Generations endpoint for standalone images
  const result = await withRetry(() => client.images.generate({
    model: "gpt-image-1",
    prompt: params.prompt,
    n: 1,
    size: params.size ?? "1536x1024",
    quality: params.quality ?? "medium",
  }));
  return { imageBase64: result.data[0].b64_json };
}
```

### Image Settings (config additions)

```typescript
storyboard: {
  panelSize: "1536x1024",         // widescreen landscape
  panelQuality: "medium",          // low | medium | high
  maxPanels: 12,
  useReferenceAnchoring: true,     // pass panel 1 as style ref for 2-N
  styleSuffix: "Rough pencil storyboard sketch on white paper. ...",
}
```

Optional env overrides:

```env
STORYBOARD_PANEL_QUALITY=medium
STORYBOARD_MAX_PANELS=12
STORYBOARD_STYLE_SUFFIX="..."
```

### Panel Manifest Artifact

Written to `artifacts/storyboards/chapter-N-panels.json` as an `ArtifactEnvelope<PanelManifest>`:

```typescript
interface PanelEntry {
  panelNumber: number;
  imagePath: string;               // relative path to PNG
  prompt: string;                  // full prompt used (including style suffix)
  usedReference: boolean;          // whether panel 1 was used as style anchor
  generatedAt: string;             // ISO timestamp
}

interface PanelManifest {
  chapterNumber: number;
  chapterTitle: string;
  panelCount: number;
  panels: PanelEntry[];
}
```

## Stage 3: Storyboard Assembly

### Input

- Scene decomposition artifact
- Panel manifest artifact
- Panel image files

### Process

Generate a self-contained HTML file that presents the storyboard as a vertical scroll of panels with metadata overlays.

### HTML Structure

```
┌─────────────────────────────────┐
│  Chapter 1: Opening Night Below │
│  12 panels                      │
├─────────────────────────────────┤
│  ┌──────────────────────────┐   │
│  │   [panel-01.png]         │   │
│  └──────────────────────────┘   │
│  Panel 1 · Wide shot            │
│  Location: Transfer lift        │
│  "The Atlantic pressed against  │
│   the glass like a hand..."     │
├─────────────────────────────────┤
│  ┌──────────────────────────┐   │
│  │   [panel-02.png]         │   │
│  └──────────────────────────┘   │
│  Panel 2 · Medium shot          │
│  Location: Arrival rotunda      │
│  "The doors opened onto a       │
│   rotunda carved from light."   │
├─────────────────────────────────┤
│  ...                            │
└─────────────────────────────────┘
```

### Output

Written to `storyboards/chapter-N/index.html`. Images are referenced as relative paths (`panel-01.png`, etc.) so the folder is self-contained and can be opened directly in a browser or shared as a zip.

## CLI Integration

### New Flag

```
--storyboard    Generate storyboard from a published chapter
```

Usage:

```bash
npm run chapter -- --chapter 1 --storyboard
```

This runs only the storyboard pipeline (stages 1-3). It requires the chapter to already be published and the approved spec to exist. It does not re-run any part of the chapter generation pipeline.

### Standalone Script (optional convenience)

```json
"storyboard": "tsx src/index.ts --storyboard"
```

Usage:

```bash
npm run storyboard -- --chapter 1
```

### Flag Validation

- `--storyboard` requires `--chapter N`.
- `--storyboard` is mutually exclusive with `--packet-only`, `--spec-only`, `--draft-only`, `--judge-only`, `--audit-only`, `--rerun-from`, `--estimate-cost`, and `--smoke`.
- If the published chapter or approved spec artifact is missing, fail fast with a clear message.

## Orchestrator: run-storyboard.ts

```typescript
export async function runStoryboard(params: {
  chapterNumber: number;
  blueprintHash: string;
  blueprintVersion: string;
  qualityProfile: QualityProfile;
  blueprintArtifacts: BlueprintCompilationArtifacts;
}): Promise<StoryboardResult> {
  // 1. Load published chapter prose
  // 2. Load approved spec artifact
  // 3. Load genre contract

  // Stage 1: decompose scenes
  const scenesArtifact = await decomposeScenes({ ... });

  // Stage 2: generate panels
  const panelManifest = await generatePanels({
    scenes: scenesArtifact,
    ...
  });

  // Stage 3: assemble HTML storyboard
  const outputPath = await assembleStoryboard({
    scenes: scenesArtifact,
    panels: panelManifest,
    ...
  });

  return { status: "SUCCESS", outputPath, panelCount: panelManifest.data.panelCount };
}
```

## Smoke Mode

In smoke mode (`--smoke` or `--storyboard` during a smoke run):

- Scene decomposition returns a fixture with 3 hard-coded panels.
- Panel generation writes solid gray placeholder PNGs (no API call).
- Assembly still runs normally, producing a valid HTML file with placeholders.

This follows the same pattern as `createSmokeDraft`, `createSmokeReview`, etc.

## Cost Estimate

Per chapter storyboard (10 panels, medium quality):

| Stage | Model | Input | Output | Estimated |
|---|---|---|---|---|
| Scene decomposition | gpt-5.5 | ~8K tokens | ~3K tokens | ~$0.10 |
| Panel generation (x10) | gpt-image-1 | 10 prompts | 10 × 1568 image tokens | ~$0.95 |
| **Total** | | | | **~$1.05** |

At low quality: ~$0.35 per chapter. At high quality: ~$3.80 per chapter.

These are rough estimates based on current gpt-image-1 token pricing for 1536x1024 images.

## Rerun Behavior

The storyboard pipeline supports partial reruns:

- If `chapter-N-scenes.json` exists, skip decomposition and reuse it.
- If `chapter-N-panels.json` exists and all panel PNGs exist, skip generation.
- Assembly always re-runs (it is instant and deterministic).

To force a full regeneration, delete the storyboard artifacts:

```bash
rm artifacts/storyboards/chapter-1-*
rm -rf storyboards/chapter-1/
npm run storyboard -- --chapter 1
```

## Implementation Order

1. Add storyboard types to `src/types/index.ts`.
2. Add `generateImage` to `src/api/openai.ts`.
3. Add storyboard config (stage profile, image settings, paths) to `src/config.ts`.
4. Add `storyboardArtifactPath` and `storyboardOutputDir` to `src/pipeline/stage-utils.ts`.
5. Implement `decompose-scenes.ts`.
6. Implement `generate-panels.ts`.
7. Implement `assemble-storyboard.ts`.
8. Implement `run-storyboard.ts` orchestrator.
9. Wire `--storyboard` flag into `src/index.ts` CLI.
10. Add smoke fixtures.
11. Add tests.
12. Update `README.md` with storyboard section.

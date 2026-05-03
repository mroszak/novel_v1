export const RERUN_STAGES = ["packet", "spec", "draft", "judge", "memory", "audit"] as const;
export type RerunStage = (typeof RERUN_STAGES)[number];

export const CHAPTER_FUNCTIONS = [
  "opening",
  "escalation",
  "reveal",
  "aftermath",
  "midpoint",
  "reversal",
  "climax",
  "resolution",
] as const;
export type ChapterFunction = (typeof CHAPTER_FUNCTIONS)[number];

export type RiskLevel = "low" | "medium" | "high";
export type ProviderName = "openai" | "anthropic";
export type ReviewSeverity = "info" | "warning" | "error";
export type ValidatorSeverity = "warning" | "error";

export const PIPELINE_STATUS_CODES = [
  "SUCCESS",
  "BLOCKED_BLUEPRINT_UNDERSPECIFIED",
  "BLOCKED_BUDGET",
  "BLOCKED_QUALITY",
  "BLOCKED_RUNTIME_CONFIGURATION",
  "BLOCKED_PROVIDER_FAILURE",
  "BLOCKED_AUDIT_FIX_LOOP_EXHAUSTED",
] as const;
export type PipelineStatusCode = (typeof PIPELINE_STATUS_CODES)[number];

export interface BlueprintMetadata {
  title: string;
  author: string;
  blueprintVersion: string;
  totalChapters: number;
  defaultChapterWordCount: number;
}

export interface StoryPromiseSection {
  corePremise: string;
  storyPromise: string;
  readerPromise: string;
  endingPromise: string;
}

export interface MarketPositioningSection {
  marketCategory: string;
  audience: string;
  shelfPositioning: string;
  comparables: string[];
}

export interface GenreRuntimeControls {
  pacingCurve: string;
  sceneDensity: string;
  dialogueRatioTarget: string;
  interiorityRatioTarget: string;
  revealCadence: string;
  hookStyle: string;
  endingMode: string;
  povDistance: string;
  ambiguityTolerance: string;
  sensoryDensity: string;
  proseCompression: string;
  emotionalDwellExpectation: string;
  violenceExplicitness: string;
  romanceProminence: string;
  validatorThresholdOverrides: string[];
}

export interface GenreBlueprintSection {
  primaryGenre: string;
  subgenres: string[];
  toneKeywords: string[];
  readerExperience: string;
  runtimeOverrides: Partial<GenreRuntimeControls>;
}

export interface CharacterCard {
  name: string;
  role: string;
  desire: string;
  fear: string;
  contradiction: string;
  publicFace: string;
  privateTruth: string;
  voiceNotes: string[];
  knowledgeBoundary: string;
  rawBody: string;
}

export interface ChapterOutline {
  chapterNumber: number;
  title: string;
  function: ChapterFunction;
  pov: string;
  summary: string;
  chapterGoal: string;
  targetWordCount: number;
  endingHook: string;
  activeCast: string[];
  mandatoryBeats: string[];
  callbackObligations: string[];
  show: string[];
  hint: string[];
  reveal: string[];
  withhold: string[];
  riskFlags: string[];
  notes: string[];
}

export type ChapterRetentionFunction =
  | "opening"
  | "early-escalation"
  | "midpoint"
  | "late-escalation"
  | "climax"
  | "aftermath";

export interface MarketPromise {
  readerAvatar: string;
  shelfComps: string[];
  coreCommercialHook: string;
  tropeStack: string[];
  freshnessAngle: string;
  pacingContract: string;
  emotionalPromise: string;
  coverBlurbKeywords: string[];
  seriesPotential: string;
  chapterRetentionStrategy: Array<{
    chapterFunction: ChapterRetentionFunction;
    readerJob: string;
  }>;
}

export interface PersistentObject {
  name: string;
  state: string;
  possessor: string;
  lastSeenChapter: number;
}

export interface SpatialNode {
  name: string;
  description: string;
  access: string;
  condition: string;
}

export interface TimelineAnchor {
  label: string;
  description: string;
  offset: string;
}

export type RevealMode = "show" | "hint" | "reveal" | "payoff";

export interface RevealEntry {
  thread: string;
  learner: string;
  chapter: number;
  mode: RevealMode;
}

export interface RelationshipState {
  pair: string;
  trust: string;
  distance: string;
  dependency: string;
  rivalry: string;
}

export type MotifStage = "introduced" | "recurring" | "inverted" | "paid-off";

export interface MotifState {
  motif: string;
  intensity: string;
  lastChapter: number;
  stage: MotifStage;
}

export interface ContinuityManifest {
  persistentObjects: PersistentObject[];
  spatialRegistry: SpatialNode[];
  timelineAnchors: TimelineAnchor[];
  revealSchedule: RevealEntry[];
  relationshipStates: RelationshipState[];
  motifStates: MotifState[];
}

export interface ContinuityActiveSlice {
  persistentObjects: PersistentObject[];
  spatialRegistry: SpatialNode[];
  timelineAnchors: TimelineAnchor[];
  revealSchedule: RevealEntry[];
  relationshipStates: RelationshipState[];
  motifStates: MotifState[];
  scopeNotes: string[];
}

export interface ParsedStoryBlueprint {
  schemaVersion: string;
  blueprintHash: string;
  rawMarkdown: string;
  frontmatter: Record<string, string>;
  metadata: BlueprintMetadata;
  storyPromise: StoryPromiseSection;
  marketPositioning: MarketPositioningSection;
  marketPromise: MarketPromise | null;
  genre: GenreBlueprintSection;
  continuityManifest: ContinuityManifest | null;
  canonLaw: string[];
  antiPatterns: string[];
  styleRules: string[];
  motifBank: string[];
  characters: CharacterCard[];
  chapterOutline: ChapterOutline[];
  rawSections: Record<string, string>;
}

export interface CompiledStoryBlueprint {
  metadata: BlueprintMetadata;
  storyPromise: StoryPromiseSection;
  marketPositioning: MarketPositioningSection;
  marketPromise: MarketPromise | null;
  genre: GenreBlueprintSection;
  continuityManifest: ContinuityManifest | null;
  canonLaw: string[];
  antiPatterns: string[];
  styleRules: string[];
  motifBank: string[];
  characters: CharacterCard[];
  chapterOutline: ChapterOutline[];
  sectionDigests: Record<string, string>;
}

export interface GenreContract {
  primaryGenre: string;
  contributingGenres: string[];
  toneKeywords: string[];
  readerExperience: string;
  controls: GenreRuntimeControls;
  aiRefinementUsed: boolean;
  aiRefinementNotes: string[];
}

export interface ChapterFunctionProfile {
  function: ChapterFunction;
  riskLevel: RiskLevel;
  pacingDirective: string;
  judgeWeights: Partial<Record<keyof ReviewScoreBreakdown, number>>;
}

export interface ChapterFunctionMap {
  chapterProfiles: Array<{
    chapterNumber: number;
    title: string;
    function: ChapterFunction;
    profile: ChapterFunctionProfile;
  }>;
}

export interface KnowledgeMatrixEntry {
  character: string;
  knows: string[];
  suspects: string[];
  hides: string[];
  mustNotKnowYet: string[];
}

export type RevealMovementType = "setup" | "hint" | "reveal" | "payoff" | "withhold";

export interface RevealLedgerEntry {
  thread: string;
  latestMovement: RevealMovementType;
  description: string;
  status: string;
  chapterNumber: number;
}

export interface VoiceCard {
  character: string;
  activeTraits: string[];
  stressPattern: string;
  dialogueHabits: string[];
  tabooNotes: string[];
  updatedFromChapter: number;
}

export interface CharacterHandoffState {
  character: string;
  physicalState: string;
  emotionalState: string;
}

export interface CharacterEmotionalState {
  character: string;
  currentBelief: string;
  currentDoubt: string;
  emotionalRegister: string;
  arcDistance: string;
}

export interface HandoffMemory {
  openingSituation: string;
  physicalState: string[];
  emotionalState: string[];
  causalState: string[];
  mandatoryCallbacks: string[];
  characterStates: CharacterHandoffState[];
}

export interface RollingMemory {
  storySpine: string;
  unresolvedThreads: string[];
  activePressures: string[];
  knowledgeMatrix: KnowledgeMatrixEntry[];
  activeCharacterVoiceCards: VoiceCard[];
  revealPayoffLedger: RevealLedgerEntry[];
  nextChapterOpeningHandoff: HandoffMemory;
  compressedHistory: string[];
  lastChapterSummary: string;
  emotionalStates: CharacterEmotionalState[];
}

export interface ChapterPacket {
  chapterNumber: number;
  title: string;
  riskLevel: RiskLevel;
  purpose: string;
  chapterFunction: ChapterFunctionProfile;
  openingHandoff: string;
  previousChapterExcerpt: string | null;
  activeCast: CharacterCard[];
  mandatoryBeats: string[];
  revealBudget: {
    show: string[];
    hint: string[];
    reveal: string[];
    withhold: string[];
  };
  callbackObligations: string[];
  targetWordBand: {
    min: number;
    target: number;
    max: number;
  };
  endingHookTarget: string;
  voiceGuidance: string[];
  pacingGuidance: string[];
  continuityNotes: string[];
  chapterNotes: string[];
  rollingMemory: RollingMemory | null;
  handoffMemory: HandoffMemory | null;
  compactContext: {
    previousChapterFull: string | null;
    olderHistory: string[];
    revealLedger: string[];
    knowledgeWarnings: string[];
  };
  voiceTarget: VoiceTarget | null;
  marketPromise: MarketPromise | null;
  continuityActiveSlice: ContinuityActiveSlice | null;
}

export interface ChapterSpec {
  title: string;
  purpose: string;
  openingImage: string;
  scenePlan: Array<{
    sceneNumber: number;
    location: string;
    objective: string;
    summary: string;
    turn: string;
    revealHandling: string;
    exitCondition: string;
    emotionalArc: string;
    sensoryAnchor: string;
    dialogueStrategy: string;
  }>;
  mandatoryBeatCoverage: Array<{
    beat: string;
    deliveryPlan: string;
  }>;
  callbackPlan: string[];
  revealControl: {
    show: string[];
    hint: string[];
    reveal: string[];
    withhold: string[];
  };
  continuityWatchouts: string[];
  proseGuidance: string[];
  endingBeat: string;
}

export interface SelfRedTeamReport {
  criticalIssues: string[];
  weaknesses: string[];
  missingBeats: string[];
  confidenceScore: number;
  needsOpusEscalation: boolean;
  revisionActions: string[];
}

export interface OpusSpecCritique {
  majorRisks: string[];
  continuityThreats: string[];
  proseThreats: string[];
  suggestedFixes: string[];
}

export interface ChapterDraft {
  prose: string;
  wordCount: number;
}

export interface ReviewScoreBreakdown {
  beatCoverage: number;
  tension: number;
  forwardMotion: number;
  characterTruth: number;
  voiceConsistency: number;
  specificity: number;
  thematicEmbodiment: number;
  openingPower: number;
  endingHookStrength: number;
  revealControl: number;
  freshness: number;
  repetitionPenalty: number;
  proseQuality: number;
  dialogueAuthenticity: number;
  sensoryImmersion: number;
}

export interface ReviewIssue {
  severity: ReviewSeverity;
  category: string;
  detail: string;
  evidence?: string;
  suggestedFix?: string;
}

export interface DraftReview {
  candidateId: "draft" | "revision";
  overallScore: number;
  passesThreshold: boolean;
  scoreBreakdown: ReviewScoreBreakdown;
  strengths: string[];
  weaknesses: string[];
  blockingIssues: string[];
  revisionActions: string[];
  issues: ReviewIssue[];
  summary: string;
}

export interface PairwiseSelection {
  presentedOrder: ["draft", "revision"] | ["revision", "draft"];
  rawWinner: "draft" | "revision";
  finalWinner: "draft" | "revision";
  scoreDelta: number;
  withinTolerance: boolean;
  rationale: string;
  preservedOriginal: boolean;
}

export interface SelectedChapter {
  winner: "draft" | "revision";
  prose: string;
  wordCount: number;
  review: DraftReview;
  selection: PairwiseSelection;
}

export interface DeltaEntityMention {
  name: string;
  role: string;
  introducedThisChapter: boolean;
  stateChanges: string[];
}

export interface SceneLedgerEntry {
  sceneNumber: number;
  location: string;
  summary: string;
  causalTurn: string;
}

export interface KnowledgeChange {
  holder: string;
  gainedKnowledge: string;
  suspects: string[];
  hides: string[];
  source: string;
}

export interface PlotThreadProgression {
  thread: string;
  previousStatus: string;
  newStatus: string;
  update: string;
  resolved: boolean;
}

export interface RevealPayoffMovement {
  thread: string;
  movementType: RevealMovementType;
  description: string;
  status: string;
  chapterNumber: number;
}

export interface ChapterDelta {
  entityMentions: DeltaEntityMention[];
  sceneLedgerDelta: SceneLedgerEntry[];
  knowledgeChanges: KnowledgeChange[];
  irreversibleChanges: string[];
  plotThreadProgression: PlotThreadProgression[];
  revealPayoffMovement: RevealPayoffMovement[];
  activePressures: string[];
  unresolvedThreads: string[];
  nextChapterOpeningHandoff: string;
  activeVoiceSignals: Array<{
    character: string;
    voiceNotes: string[];
  }>;
  storySpineUpdate: string;
  characterEmotionalStates: CharacterEmotionalState[];
}

export interface MemoryUpdateProposal {
  storySpine: string;
  unresolvedThreads: string[];
  activePressures: string[];
  knowledgeMatrix: KnowledgeMatrixEntry[];
  activeCharacterVoiceCards: VoiceCard[];
  nextChapterOpeningHandoff: HandoffMemory;
  compressedHistory: string[];
  lastChapterSummary: string;
  emotionalStates: CharacterEmotionalState[];
}

export interface ValidatorIssue {
  code: string;
  severity: ValidatorSeverity;
  message: string;
  evidence: string[];
}

export interface ValidatorReport {
  passed: boolean;
  issues: ValidatorIssue[];
  errorCount: number;
  warningCount: number;
}

export interface FinalAuditIssue {
  severity: ReviewSeverity;
  title: string;
  description: string;
  fixInstruction: string;
}

export interface FinalAuditReport {
  status: "clean" | "issues_found";
  summary: string;
  factualConfidence: number;
  requiresFix: boolean;
  issues: FinalAuditIssue[];
}

export interface ContinuityFixResult {
  prose: string;
  appliedFixes: string[];
}

export interface VoiceFingerprint {
  sentenceLength: {
    mean: number;
    stdDev: number;
    median: number;
    p90: number;
    histogram: Array<{ bucket: string; count: number }>;
  };
  paragraphRhythm: {
    meanWords: number;
    medianWords: number;
    shortParagraphRatio: number;
    longParagraphRatio: number;
  };
  signatureLexicon: string[];
  recurringMetaphorFamilies: string[];
  dialogueTagConventions: {
    tagsPer1000Words: number;
    saidShare: number;
    variedTagShare: number;
    sampleTags: string[];
  };
  povInteriorityDensity: {
    interiorMarkersPer1000Words: number;
    sampleMarkers: string[];
  };
}

export interface VoiceTarget {
  source: "derived" | "style-sample" | "blueprint-fallback";
  derivedFromChapters: number[];
  fingerprint: VoiceFingerprint;
  guidanceLines: string[];
}

export interface TournamentCandidate {
  id: string;
  text: string;
  rationale: string;
}

export interface TournamentPairResult {
  pair: [string, string];
  winner: string;
  rationale: string;
}

export type TournamentZone = "opening" | "ending";

export interface TournamentResult {
  zone: TournamentZone;
  candidates: TournamentCandidate[];
  rounds: TournamentPairResult[];
  winnerId: string;
  winnerText: string;
  applied: boolean;
  skipReason: string | null;
}

export interface TournamentMerged {
  status: "applied" | "skipped" | "validators-failed";
  reason: string;
  zones: Record<TournamentZone, TournamentResult | null>;
  preReviewScore: number | null;
  postReviewScore: number | null;
  preProse: string;
  finalProse: string;
}

export interface LocalizedAuditPatchResult {
  prose: string;
  appliedFixes: string[];
  requiresDeltaRefresh: boolean;
}

export interface TokenPreflight {
  stageId: string;
  provider: ProviderName;
  model: string;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  estimatedTotalTokens: number;
  contextWindowTokens: number;
  withinBudget: boolean;
  notes: string[];
}

export interface StageTelemetry {
  stageId: string;
  preflight: TokenPreflight;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
}

export interface StageUsage {
  provider: ProviderName;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  responseId: string | null;
  estimatedCostUsd?: number | null;
}

export interface ModelResult<T> {
  value: T;
  usage: StageUsage;
}

export interface ArtifactEnvelope<T> {
  schemaVersion: string;
  artifactType: string;
  createdAt: string;
  blueprintHash: string;
  blueprintVersion: string;
  chapterNumber?: number;
  usage?: StageUsage;
  telemetry?: StageTelemetry;
  data: T;
}

export interface PipelineStatusArtifact {
  status: PipelineStatusCode;
  stage: string;
  message: string;
  details: Record<string, unknown>;
}

export interface BlueprintCompilationArtifacts {
  compiledBlueprint: ArtifactEnvelope<CompiledStoryBlueprint>;
  genreContract: ArtifactEnvelope<GenreContract>;
  chapterFunctions: ArtifactEnvelope<ChapterFunctionMap>;
  marketPromise: ArtifactEnvelope<MarketPromise | null>;
  continuityManifest: ArtifactEnvelope<ContinuityManifest | null>;
}

export interface StageTokenEstimate {
  stage: string;
  provider: ProviderName;
  model: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  contextWindowTokens: number;
  withinBudget: boolean;
  estimatedCostUsd: number | null;
  pricingConfigured: boolean;
  notes: string[];
}

export interface ChapterCostEstimate {
  chapterNumber: number;
  pricingConfigured: boolean;
  totalEstimatedInputTokens: number;
  totalEstimatedOutputTokens: number;
  estimatedCostUsd: number | null;
  stages: StageTokenEstimate[];
}

export interface ChapterCostSummary {
  chapterNumber: number;
  pricingConfigured: boolean;
  estimatedFromUsage: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number | null;
  stages: Array<{
    stage: string;
    usage: StageUsage;
  }>;
}

export interface RunChapterResult {
  status: PipelineStatusCode;
  blueprintHash: string;
  packetArtifactPath: string | null;
  approvedSpecArtifactPath: string | null;
  draftArtifactPath: string | null;
  selectedArtifactPath: string | null;
  memoryArtifactPath: string | null;
  auditArtifactPath: string | null;
  publishedChapterPath: string | null;
  statusArtifactPath: string | null;
  costEstimateArtifactPath: string | null;
  costSummaryArtifactPath: string | null;
  reusedArtifacts: string[];
}

export interface RunChapterOptions {
  blueprintPath: string;
  chapterNumber: number;
  packetOnly: boolean;
  specOnly: boolean;
  draftOnly: boolean;
  judgeOnly: boolean;
  auditOnly: boolean;
  rerunFrom: RerunStage | null;
  compileBlueprintOnly: boolean;
  estimateCost: boolean;
  smoke: boolean;
  noGenreAi: boolean;
  skipSpecCritique: boolean;
}

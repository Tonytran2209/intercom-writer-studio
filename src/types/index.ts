export type AIProvider = "anthropic" | "openai" | "google" | "mistral" | "together" | "groq" | "deepseek"

export interface AIModel {
  id: string
  name: string
  provider: AIProvider
  description: string
  enabled: boolean
  contextWindow: string
  speed: "fast" | "medium" | "slow"
  pricing?: {
    inputUsdPerMillion: number
    outputUsdPerMillion: number
    cachedInputUsdPerMillion?: number
    longContextThresholdTokens?: number
    longContextInputMultiplier?: number
    longContextOutputMultiplier?: number
  }
}

export type AppLanguage = "vi" | "en"

export interface AICallUsage {
  id: string
  articleId?: string
  step: 1 | 2 | 3 | 4
  provider: AIProvider
  model: string
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
  totalTokens: number
  costUsd: number | null
  cacheHit: boolean
  calledAt: string
}

export type FileCategory = "kb" | "rules"
export type LegacyFileCategory = "action" | "action-plan"
export type FileType = "pdf" | "docx" | "csv" | "xlsx" | "txt" | "md" | "json"

export interface StructuredDocumentSection {
  id: string
  heading: string
  content: string
  contentHash: string
  wave?: string
  timeframe?: string
  typeGroups: ContentTypeGroup[]
}

export interface DocumentFile {
  id: string
  name: string
  size: string
  uploadedAt: string
  category: FileCategory | LegacyFileCategory
  fileType: FileType
  content?: string
  contentUpdatedAt?: string
  contentLength?: number
  contentHash?: string
  scanStatus?: "ready" | "error"
  structuredSections?: StructuredDocumentSection[]
  storagePath?: string
  originalMimeType?: string
  sourceType?: ActionSourceType
  addedAt?: string
  preview?: string
  rowCount?: number
  url?: string
  query?: string
  columns?: string[]
  rows?: ManualRow[]
  airtableBase?: string
  airtableTable?: string
  knowledgeMetadata?: KnowledgeMetadata
}

export interface KnowledgeMetadata {
  type: "usp" | "positioning" | "client_insight" | "case_study" | "framework" | "approved_claim" | "production_insight" | "reference"
  topics: string[]
  service?: string
  audience?: string
  visibility: "internal" | "public"
  approvedForExternalUse: boolean
  lastUpdated?: string
}

export interface WebsiteContentRecord {
  id: string
  url: string
  canonicalUrl?: string
  title: string
  contentType: "blog" | "service" | "portfolio" | "landing" | "about" | "commercial"
  topics: string[]
  services?: string[]
  audience?: string
  status: "active" | "redirected" | "broken" | "unchecked" | "queued" | "checking"
  redirectTarget?: string
  eligibleForInternalLink: boolean
  lastChecked?: string
  description?: string
  httpStatus?: number
  crawlStatus?: "queued" | "checking" | "summarizing" | "complete" | "failed"
  lastError?: string
  classificationConfidence?: number
  contentFingerprint?: string
  summary?: string
  primaryTopic?: string
  searchIntent?: SearchIntent
  internalLinkAnchors?: string[]
  keyClaims?: string[]
  language?: string
  aiModel?: string
  aiSummaryVersion?: string
  summarizedAt?: string
  summaryCacheHit?: boolean
  aiSummarySkippedReason?: "daily-limit"
}

export interface StepFileAccess {
  kb: string[]
  rules: string[]
}

export type StepDocumentPromptRules = Partial<Record<FileCategory, Record<string, string>>>
export type StepCategoryPromptRules = Partial<Record<FileCategory, string>>

export interface StepConfig {
  modelId: string
  fileAccess: StepFileAccess
  /** Target English-word count for the final draft stage (legacy field name). */
  maxDraftWords?: number
  /** Legacy character setting, read once as a numeric migration fallback. */
  maxDraftCharacters?: number
  categoryPromptRules?: StepCategoryPromptRules
  /** Legacy per-document rules, retained only for automatic migration. */
  documentPromptRules?: StepDocumentPromptRules
  systemPrompt?: string
}

export type WorkflowRuleId = "source-grounding" | "core-idea" | "outline" | "draft" | "quality-persistence"
export type WorkflowRuleEnforcement = "strict" | "guided"
export type WorkflowExecutionMode = "manual" | "batch"

export interface WorkflowStageOverride {
  instruction?: string
  parameters?: Record<string, number | string | boolean>
}

export interface WorkflowRuleSetting {
  enforcement: WorkflowRuleEnforcement
  customInstruction: string
  appliesTo: { manual: boolean; batch: boolean }
  stageOverrides: Record<string, WorkflowStageOverride>
  version: number
}

export type WorkflowRuleSettings = Partial<Record<WorkflowRuleId, WorkflowRuleSetting>>

export interface AppConfig {
  railwayUrl: string
  stepConfigs: Record<number, StepConfig>
  models: AIModel[]
  workflowRules?: WorkflowRuleSettings
  websiteInventory?: WebsiteContentRecord[]
}

export type SearchIntent = "informational" | "commercial" | "transactional" | "navigational"

export interface EvidenceRef {
  source: string
  note?: string
  quote?: string
  role?: "kb" | "content_plan" | "rules"
}

export interface OutlineSection {
  id: string
  heading: string
  notes: string
  rationale?: string
  level: "h2" | "h3"
  keywords?: string[]
  searchIntent?: SearchIntent
  evidence?: EvidenceRef[]
  ruleRefs?: string[]
}

export type ArticleStatus = "planning" | "in_progress" | "review" | "done"

export type ContentTypeGroup = "A" | "B" | "C"

export interface ContentTypeSuggestion {
  id: string
  label: string
  description: string
  keywords?: string[]
  // Classification snapshot created from the current Content Plan input.
  typeGroup?: ContentTypeGroup
  wave?: string
  timeframe?: string
  audience?: string
  format?: string
  matchedDocs?: string[]
  kbRefs?: string[]
  ruleRefs?: string[]
  kbEvidence?: string
  ruleEvidence?: string
  contentPlanEvidence?: string
  scheduleEvidence?: string
  sourceYear?: number
  icon?: string
}

export interface CoreIdeaRating {
  overall: number
  seoPotential: number
  audienceFit: number
  docSupport: number
  uniqueness: number
}

export interface SeoKeywordMetric {
  keyword: string
  searchVolume: number | null
  keywordDifficulty: number | null
  competition: number | null
  cpc: number | null
  intent: string | null
  source: "dataforseo" | "openai_web_search"
  sources?: string[]
  marketEvidence?: string
  updatedAt: string | null
}

export interface SeoResearchResult {
  keywords: SeoKeywordMetric[]
  seedKeywords: string[]
  location: string
  language: string
  researchedAt: string
  cacheHit?: boolean
  budget?: { used: number; limit: number }
}

export interface KeywordAuditItem {
  keyword: string
  decision: "accepted" | "rejected"
  reason: string
  ruleReason: string
  kbReason: string
}

export interface AIProcessTraceEvent {
  id: string
  stage: string
  status: "completed" | "warning" | "failed"
  title: string
  detail: string
  facts?: Record<string, string | number | boolean | null>
  sources?: string[]
}

export interface CoreIdeaSuggestion {
  id: string
  title: string
  angleLabel: string
  angleDescription: string
  mainArgument: string
  primaryKeyword: string
  secondaryKeywords: string[]
  targetAudience: string
  recommendedTone: string
  recommendedWordCount: number
  rating: CoreIdeaRating
  ratingRationale: string
  ratingRationales?: Partial<Record<keyof CoreIdeaRating, string>>
  keywordAudit?: KeywordAuditItem[]
  matchedDocs: string[]
  ruleRefs: string[]
  evidence?: EvidenceRef[]
}

export interface ArticleSpec {
  version: number
  topic: string
  primaryQuery: string
  secondaryQueries: string[]
  audience: string
  market: string
  language: string
  primaryIntent: SearchIntent
  secondaryIntent?: SearchIntent
  expectedReaderOutcome: string
  winningFormat: string
  mustCover: string[]
  optionalCoverage: string[]
  thesis: string
  brandPov: string
  evidence: EvidenceRef[]
  ctaObjective: string
  internalLinkRequirements: string[]
  createdAt: string
}

export interface QualityGateCheck {
  id: string
  label: string
  kind: "deterministic" | "semantic"
  status: "pass" | "warning" | "fail"
  reason: string
  evidence?: string
  location?: string
  recommendedAction?: string
  autoFixAllowed: boolean
}

export interface UniversalQualityReport {
  version: number
  status: "pass" | "warning" | "fail"
  checkedAt: string
  articleSpecFingerprint: string
  checks: QualityGateCheck[]
}

export interface EditorialApproval {
  status: "pending" | "approved" | "rejected"
  approvedAt?: string
  note?: string
  outlineFingerprint?: string
}

export interface Article {
  id: string
  title: string
  currentStep: number
  status: ArticleStatus
  createdAt: string
  updatedAt: string
  completedAt?: string | null
  // Step 1 data
  contentType?: string | null
  selectedContentTypeSuggestionId?: string | null
  selectedContentTypeSnapshot?: ContentTypeSuggestion | null
  contentTypeSuggestions?: ContentTypeSuggestion[]
  contentTypeSourceFingerprint?: string | null
  contentTypeScannedAt?: string | null
  contentTypeCacheHit?: boolean
  // Step 2 data
  topic?: string
  keywords?: string
  targetAudience?: string
  angle?: string
  wordCount?: number
  tone?: string
  coreIdeaSuggestions?: CoreIdeaSuggestion[]
  selectedCoreIdeaId?: string
  coreIdeaSourceFingerprint?: string | null
  coreIdeaScannedAt?: string | null
  seoResearch?: SeoResearchResult | null
  articleSpec?: ArticleSpec | null
  articleSpecFingerprint?: string | null
  step2ProcessTrace?: AIProcessTraceEvent[]
  // Step 3 data
  outline?: OutlineSection[]
  outlineSourceFingerprint?: string | null
  outlineScannedAt?: string | null
  step3ProcessTrace?: AIProcessTraceEvent[]
  step3SuggestedKeywords?: string[]
  // Step 4 data
  draft?: string
  draftSourceFingerprint?: string | null
  draftScannedAt?: string | null
  step4ProcessTrace?: AIProcessTraceEvent[]
  step4RawResponseExcerpt?: string | null
  draftEvidenceUsage?: Record<string, string[]>
  qualityReport?: UniversalQualityReport | null
  editorialApproval?: EditorialApproval | null
  workflowRuleSnapshots?: Partial<Record<2 | 3 | 4, WorkflowRuleSnapshot>>
  aiUsageByStep?: Partial<Record<1 | 2 | 3 | 4, AICallUsage[]>>
  // Activity workspace / per-run content plan
  activityType?: "comparison-seo" | "editorial-originality"
  activityKind?: "single" | "batch"
  activityId?: string
  contentPlanInput?: string
  contentPlanItemId?: string
  batchSize?: 5 | 10 | 15 | 20
  batchArticleIds?: string[]
  batchStatus?: "queued" | "running" | "paused" | "completed" | "failed"
  batchError?: string | null
  batchStartedAt?: string | null
  contentPlanId?: string
  contentPlanVersion?: number
  contentPlanSourceItemId?: string
  /** Runtime compatibility marker. Legacy records remain read-only until copied. */
  legacyReadOnly?: boolean
  legacyReason?: string
  migratedFromArticleId?: string
}

export interface WorkflowRuleSnapshot {
  version: number
  executionMode: WorkflowExecutionMode
  stepNumber: number
  fingerprint: string
  capturedAt: string
  rules: Array<{
    id: WorkflowRuleId
    enforcement: WorkflowRuleEnforcement
    stages: Array<{
      id: string
      instruction: string
      parameters: Record<string, number | string | boolean>
    }>
    customInstruction: string
  }>
}

export interface ContentPlanItem {
  id: string
  title: string
  keywords: string[]
  type: "comparison-seo" | "editorial-originality" | "needs-review"
  sourceLine: string
  confidence?: number
  classificationReason?: string
  sourceId?: string
  sourceSectionId?: string
  sourceQuote?: string
  status?: "not_started" | "queued" | "generating" | "in_progress" | "completed" | "failed" | "archived"
}

export type ContentPlanSourceType = "file" | "google_doc" | "google_sheet" | "paste"

export interface ContentPlanSource {
  id: string
  contentPlanId: string
  sourceType: ContentPlanSourceType
  name: string
  originalUrl?: string
  storagePath?: string
  mimeType?: string
  extractedContent: string
  contentHash: string
  contentLength: number
  scanStatus: "processing" | "ready" | "failed"
  scanError?: string
  createdAt: string
}

export interface ContentPlan {
  id: string
  seriesId?: string
  name: string
  description?: string
  status: "draft" | "processing" | "ready" | "active" | "archived" | "failed"
  version: number
  previousVersionId?: string | null
  sourceFingerprint: string
  totalArticles: number
  comparisonCount: number
  editorialCount: number
  reviewCount: number
  createdAt: string
  updatedAt: string
  classifiedAt?: string
  sources?: ContentPlanSource[]
  items?: ContentPlanItem[]
  changeSummary?: { added: string[]; removed: string[]; unchanged: string[] }
}

export interface ContentType {
  id: string
  label: string
  description: string
  icon: string
  color: string
}

export type ActiveTab = "step-setup" | "models" | "knowledge-base"
export type KbSubTab = "kb" | "rules" | "website" | "legacy-action"

// ── Knowledge/Skill source import ────────────────────────────────────────────

export type ActionSourceType = "file" | "paste" | "url" | "gsheet" | "manual" | "supabase" | "airtable" // upload CSV/XLSX/JSON/PDF // paste raw CSV, JSON, plain text // REST API endpoint hoặc RSS feed // Google Sheets public URL // nhập bảng thủ công // SQL query trên Supabase đã kết nối // Airtable API

export interface ManualRow {
  id: string
  cells: string[]
}

export interface ActionDataSource {
  id: string
  name: string
  sourceType: ActionSourceType
  addedAt: string
  // Chung
  preview?: string // vài dòng đầu để hiển thị
  rowCount?: number
  // File
  fileType?: string
  size?: string
  // Paste / Manual
  content?: string // raw text hoặc CSV string
  contentUpdatedAt?: string
  contentLength?: number
  contentHash?: string
  scanStatus?: "ready" | "error"
  structuredSections?: StructuredDocumentSection[]
  storagePath?: string
  originalMimeType?: string
  // URL / GSheet
  url?: string
  headers?: Record<string, string> // custom request headers cho API
  // Manual table
  columns?: string[]
  rows?: ManualRow[]
  // Supabase
  query?: string
  // Airtable
  airtableKey?: string
  airtableBase?: string
  airtableTable?: string
}

import { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Ellipsis, LoaderCircle, Search, Sparkles } from "lucide-react";
import type {
  Article,
  AIModel,
  AppConfig,
  DocumentFile,
  CoreIdeaSuggestion,
  ContentTypeSuggestion,
  EvidenceRef,
  SeoResearchResult,
  KeywordAuditItem,
  AIProcessTraceEvent,
  ArticleSpec,
} from "../../types";
import { callAI, researchSeoKeywords } from "../../lib/aiService";
import { useI18n } from "../../lib/i18n";
import { notifyWorkspace } from "./WorkspaceNotification";
import {
  collectStepDocs,
  buildRoleSystemPrompt,
  buildStepDocumentPromptRules,
  buildWorkflowSourceFingerprint,
  describeBundle,
} from "../../lib/docContext";
import { hasEvidenceForAuthorizedCategories, verifiedRuleRefs, verifyEvidence } from "../../lib/evidenceValidation";
import { ProcessTraceModal } from './ProcessTrace';
import { parseAIJson } from '../../lib/aiJson';
import { compileWorkflowRules, getWorkflowParameter } from '../../lib/workflowRules';
import { gateArticleStep, gateStepCompletion } from '../../lib/workflowGuards';
import { articleSpecFingerprint, normalizeArticleSpec } from '../../lib/articleSpec';
import { StepUsage } from './StepUsage';

interface Props {
  embedded?: boolean;
  article: Article;
  config: AppConfig;
  files: DocumentFile[];
  model: AIModel;
  railwayUrl: string;
  onUpdate: (updates: Partial<Article>) => Promise<boolean>;
  onNext: () => void;
  onPrev: () => void;
}

function toNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function toStringArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  return [];
}

function snapshotEvidence(
  snapshot: ContentTypeSuggestion | null | undefined,
  bundle: ReturnType<typeof collectStepDocs>,
): EvidenceRef[] {
  if (!snapshot) return [];
  const candidates: EvidenceRef[] = [];
  const researchSource = snapshot.matchedDocs?.[0];
  const kbSource = snapshot.kbRefs?.[0];
  const ruleSource = snapshot.ruleRefs?.[0];
  if (researchSource && snapshot.contentPlanEvidence) {
    candidates.push({ source: researchSource, role: "content_plan", quote: snapshot.contentPlanEvidence, note: "Content Plan classification evidence" });
  }
  if (kbSource && snapshot.kbEvidence) {
    candidates.push({ source: kbSource, role: "kb", quote: snapshot.kbEvidence, note: "Snapshot Step 1 đã kiểm chứng" });
  }
  if (ruleSource && snapshot.ruleEvidence) {
    candidates.push({ source: ruleSource, role: "rules", quote: snapshot.ruleEvidence, note: "Snapshot Step 1 đã kiểm chứng" });
  }
  return verifyEvidence(candidates, bundle);
}

function deterministicBundleEvidence(
  bundle: ReturnType<typeof collectStepDocs>,
  query: string,
): EvidenceRef[] {
  const terms = [...new Set(query.normalize("NFKC").toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(term => term.length >= 3))].slice(0, 30);
  const bestExcerpt = (docs: Array<{ name: string; content?: string }>, role: EvidenceRef["role"]): EvidenceRef | null => {
    const ranked = docs.flatMap(doc => (doc.content ?? "").split(/\n\s*\n|\r?\n/)
      .map(text => text.replace(/\s+/g, " ").trim())
      .filter(text => text.length >= 40)
      .map(text => ({
        source: doc.name,
        quote: text.slice(0, 800),
        score: terms.reduce((sum, term) => sum + (text.toLocaleLowerCase().includes(term) ? 1 : 0), 0),
      }))
    ).sort((a, b) => b.score - a.score || b.quote.length - a.quote.length);
    const best = ranked[0];
    return best ? { source: best.source, role, quote: best.quote, note: "Deterministically selected and verified source excerpt." } : null;
  };
  const research = bestExcerpt([...bundle.knowledgeBase, ...bundle.contentPlan], "kb");
  const rules = bestExcerpt(bundle.rules, "rules");
  return verifyEvidence([research, rules].filter((item): item is EvidenceRef => Boolean(item)), bundle);
}

function normalizeIdeas(
  parsed: unknown,
  bundle: ReturnType<typeof collectStepDocs>,
  seoResearch: SeoResearchResult,
  trustedSnapshotEvidence: EvidenceRef[] = [],
): CoreIdeaSuggestion[] {
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  const rawIdeas = root?.ideas ?? parsed;
  if (!Array.isArray(rawIdeas)) throw new Error("Phản hồi AI không có mảng ideas.");
  const registryValue = root?.evidenceRegistry;
  const evidenceRegistry: Record<string, unknown> = registryValue && typeof registryValue === "object" && !Array.isArray(registryValue)
    ? registryValue as Record<string, unknown>
    : Object.fromEntries((Array.isArray(registryValue) ? registryValue : []).flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const id = String(record.id ?? record.key ?? record.ref ?? `ev-${index + 1}`).trim();
      return id ? [[id, record]] : [];
    }));
  const resolveEvidenceRefs = (value: unknown): unknown[] => (Array.isArray(value) ? value : []).flatMap(ref => {
    if (ref && typeof ref === "object") {
      const record = ref as Record<string, unknown>;
      const id = String(record.id ?? record.ref ?? record.evidenceId ?? "").trim();
      return id && evidenceRegistry[id] ? [evidenceRegistry[id]] : [record];
    }
    const id = String(ref ?? "").trim();
    return evidenceRegistry[id] ? [evidenceRegistry[id]] : [];
  });
  const sharedEvidence = verifyEvidence([
    ...(Array.isArray(root?.sharedEvidence) ? root.sharedEvidence : []),
    ...resolveEvidenceRefs(root?.sharedEvidenceRefs),
  ], bundle);
  const researchedKeywords = new Map(seoResearch.keywords.map(item => [item.keyword.toLocaleLowerCase(), item.keyword]));
  const normalizeAudit = (value: unknown): KeywordAuditItem[] => (Array.isArray(value) ? value : []).flatMap((raw): KeywordAuditItem[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const keyword = researchedKeywords.get(String(item.keyword ?? "").trim().toLocaleLowerCase());
    const decision = item.decision === "accepted" ? "accepted" : item.decision === "rejected" ? "rejected" : null;
    if (!keyword || !decision) return [];
    const normalized: KeywordAuditItem = { keyword, decision, reason: String(item.reason ?? "").trim(), ruleReason: String(item.ruleReason ?? "").trim(), kbReason: String(item.kbReason ?? "").trim() };
    const hasResearchDocs = Boolean(bundle.knowledgeBase.length || bundle.contentPlan.length);
    return normalized.reason
      && (!bundle.rules.length || normalized.ruleReason)
      && (!hasResearchDocs || normalized.kbReason)
      ? [normalized]
      : [];
  });
  const sharedKeywordAudit = normalizeAudit(root?.keywordAudit);
  const hasCompleteSharedAudit = new Set(sharedKeywordAudit.map(item => item.keyword.toLocaleLowerCase())).size === seoResearch.keywords.length;
  return rawIdeas
    .map((raw, idx) => {
      if (!raw || typeof raw !== "object") return null;
      const obj = raw as Record<string, unknown>;
      const title = String(obj.title ?? obj.name ?? "").trim();
      const mainArgument = String(obj.mainArgument ?? obj.thesis ?? "").trim();
      if (!title || !mainArgument) return null;
      const ratingObj = (obj.rating && typeof obj.rating === "object" ? obj.rating : {}) as Record<string, unknown>;
      const seo = (obj.seoKeywords && typeof obj.seoKeywords === "object" ? obj.seoKeywords : {}) as Record<string, unknown>;
      const evidence = [
        ...verifyEvidence([
          ...(Array.isArray(obj.evidence) ? obj.evidence : []),
          ...resolveEvidenceRefs(obj.evidenceRefs),
        ], bundle),
        ...sharedEvidence,
        ...trustedSnapshotEvidence,
      ].filter((item, index, all) => all.findIndex(candidate =>
        candidate.role === item.role && candidate.source === item.source && candidate.quote === item.quote
      ) === index);
      const ruleRefs = [...new Set([
        ...verifiedRuleRefs(obj.ruleRefs, bundle),
        ...evidence.filter(item => item.role === "rules").map(item => item.source),
      ])];
      const keywordAudit = hasCompleteSharedAudit ? sharedKeywordAudit : normalizeAudit(obj.keywordAudit);
      if (new Set(keywordAudit.map(item => item.keyword.toLocaleLowerCase())).size !== seoResearch.keywords.length) return null;
      const accepted = new Set(keywordAudit.filter(item => item.decision === "accepted").map(item => item.keyword.toLocaleLowerCase()));
      const primaryKeyword = researchedKeywords.get(String(seo.primary ?? obj.primaryKeyword ?? "").trim().toLocaleLowerCase()) ?? "";
      const secondaryKeywords = toStringArr(seo.secondary ?? obj.secondaryKeywords)
        .map(keyword => researchedKeywords.get(keyword.toLocaleLowerCase()))
        .filter((keyword): keyword is string => Boolean(keyword))
        .filter(keyword => accepted.has(keyword.toLocaleLowerCase()));
      if (!primaryKeyword || !accepted.has(primaryKeyword.toLocaleLowerCase())) return null;
      if (!hasEvidenceForAuthorizedCategories(evidence, bundle)) return null;
      return {
        id: `idea-${idx}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}`,
        title,
        angleLabel: String(obj.angleLabel ?? obj.angle ?? "").trim(),
        angleDescription: String(obj.angleDescription ?? "").trim(),
        mainArgument,
        primaryKeyword,
        secondaryKeywords,
        targetAudience: String(obj.targetAudience ?? "").trim(),
        recommendedTone: String(obj.recommendedTone ?? obj.tone ?? "").trim(),
        recommendedWordCount: toNumber(obj.recommendedWordCount ?? obj.wordCount, 1500),
        rating: {
          overall: toNumber(ratingObj.overall, 0),
          seoPotential: toNumber(ratingObj.seoPotential, 0),
          audienceFit: toNumber(ratingObj.audienceFit, 0),
          docSupport: toNumber(ratingObj.docSupport, 0),
          uniqueness: toNumber(ratingObj.uniqueness, 0),
        },
        ratingRationale: String(obj.ratingRationale ?? "").trim(),
        ratingRationales: Object.fromEntries(
          Object.entries((obj.ratingRationales && typeof obj.ratingRationales === "object" ? obj.ratingRationales : {}) as Record<string, unknown>)
            .map(([key, value]) => [key, String(value ?? "").trim()])
            .filter(([, value]) => Boolean(value)),
        ),
        keywordAudit,
        matchedDocs: [...new Set(evidence.filter(item => item.role === "kb" || item.role === "content_plan").map(item => item.source))],
        ruleRefs,
        evidence,
      } as CoreIdeaSuggestion;
    })
    .filter((v): v is CoreIdeaSuggestion => v !== null);
}

function ratingColor(score: number): string {
  if (score >= 8.5) return "text-emerald-600";
  if (score >= 7) return "text-blue-600";
  if (score >= 5.5) return "text-amber-600";
  return "text-rose-600";
}

function ratingTag(score: number): { label: string; className: string } {
  if (score >= 9)   return { label: "Đề xuất mạnh", className: "bg-emerald-600 text-white" };
  if (score >= 8)   return { label: "Đề xuất",      className: "bg-emerald-100 text-emerald-800 border border-emerald-200" };
  if (score >= 7)   return { label: "Cân nhắc",     className: "bg-blue-100 text-blue-800 border border-blue-200" };
  if (score >= 5.5) return { label: "Tùy chọn",     className: "bg-amber-100 text-amber-800 border border-amber-200" };
  return { label: "Yếu", className: "bg-rose-100 text-rose-800 border border-rose-200" };
}

function RatingCircle({ label, score }: { label: string; score: number }) {
  const normalizedScore = Math.min(10, Math.max(0, score));
  const radius = 25;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - normalizedScore / 10);

  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <div
        className={`relative h-16 w-16 ${ratingColor(normalizedScore)}`}
        role="img"
        aria-label={`${label}: ${normalizedScore.toFixed(1)} out of 10`}
      >
        <svg className="h-full w-full -rotate-90" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="4" />
          <circle
            cx="32"
            cy="32"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-mono text-sm font-semibold text-slate-800">
          {normalizedScore.toFixed(1)}
        </span>
      </div>
      <span className="text-[10px] font-semibold leading-tight text-slate-700">{label}</span>
    </div>
  );
}

export default function Step2CoreIdea({
  embedded = false,
  article,
  config,
  files,
  model,
  railwayUrl,
  onUpdate,
  onNext,
  onPrev,
}: Props) {
  const storedIdeas = article.coreIdeaSuggestions ?? [];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(article.selectedCoreIdeaId ?? null);
  const [detailIdeaId, setDetailIdeaId] = useState<string | null>(null);
  const [auditIdeaId, setAuditIdeaId] = useState<string | null>(null);
  const generationInFlight = useRef(false);
  const { tr, canonicalAIOutputInstruction } = useI18n();
  const prerequisite = gateArticleStep(article, 2);

  useEffect(() => { if (error) notifyWorkspace(error, 'error'); }, [error]);
  useEffect(() => { if (warning) notifyWorkspace(warning, 'warning'); }, [warning]);

  useEffect(() => {
    if (!detailIdeaId) return;
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && setDetailIdeaId(null);
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [detailIdeaId]);

  const bundle = useMemo(() => collectStepDocs(2, config, files, article.contentPlanInput), [article.contentPlanInput, config, files]);
  const documentPromptRules = useMemo(() => buildStepDocumentPromptRules(2, config, files), [config, files]);
  const compiledWorkflowRules = useMemo(() => compileWorkflowRules(config, 2, 'manual'), [config]);
  const configuredIdeaCount = Math.min(6, Math.max(1, Number(getWorkflowParameter(config, 'core-idea', 'idea-generation', 'ideaCount') ?? 3)));
  // Interactive single-article workspaces always present the configured set
  // of directions for an explicit user choice. Batch automation selects its
  // top-ranked idea in the backend and does not use this component.
  const requestedIdeaCount = configuredIdeaCount;
  const requestedKeywordCount = Math.min(20, Math.max(5, Number(getWorkflowParameter(config, 'core-idea', 'market-research', 'keywordCount') ?? 10)));
  const selectedSnapshot = useMemo(
    () => article.selectedContentTypeSnapshot
      ?? article.contentTypeSuggestions?.find(item => item.id === article.selectedContentTypeSuggestionId)
      ?? article.contentTypeSuggestions?.find(item => item.label === article.contentType)
      ?? null,
    [article.contentType, article.contentTypeSuggestions, article.selectedContentTypeSnapshot, article.selectedContentTypeSuggestionId],
  );
  const trustedSnapshotEvidence = useMemo(
    () => snapshotEvidence(selectedSnapshot, bundle),
    [bundle, selectedSnapshot],
  );
  const trustedEvidence = useMemo(() => [
    ...trustedSnapshotEvidence,
    ...deterministicBundleEvidence(bundle, [
      article.contentType,
      selectedSnapshot?.label,
      ...(selectedSnapshot?.keywords ?? []),
    ].filter(Boolean).join(" ")),
  ].filter((item, index, all) => all.findIndex(candidate =>
    candidate.role === item.role && candidate.source === item.source && candidate.quote === item.quote
  ) === index), [article.contentType, bundle, selectedSnapshot, trustedSnapshotEvidence]);
  const selectedSnapshotSignature = useMemo(
    () => selectedSnapshot ? JSON.stringify({
      id: selectedSnapshot.id,
      label: selectedSnapshot.label,
      typeGroup: selectedSnapshot.typeGroup,
      wave: selectedSnapshot.wave,
      timeframe: selectedSnapshot.timeframe,
      keywords: selectedSnapshot.keywords,
      matchedDocs: selectedSnapshot.matchedDocs,
      kbRefs: selectedSnapshot.kbRefs,
      ruleRefs: selectedSnapshot.ruleRefs,
      contentPlanEvidence: selectedSnapshot.contentPlanEvidence,
      kbEvidence: selectedSnapshot.kbEvidence,
      ruleEvidence: selectedSnapshot.ruleEvidence,
    }) : article.contentType ?? "",
    [article.contentType, selectedSnapshot],
  );
  const sourceFingerprint = useMemo(
    () => `${buildWorkflowSourceFingerprint(bundle)}:${model.provider}:${model.id}:step2-seo-pipeline-v12-rules:${selectedSnapshotSignature}:${compiledWorkflowRules.fingerprint}`,
    [bundle, compiledWorkflowRules.fingerprint, model.id, model.provider, selectedSnapshotSignature],
  );
  const scanIsStale = Boolean(storedIdeas.length) && article.coreIdeaSourceFingerprint !== sourceFingerprint;
  useEffect(() => {
    if (scanIsStale) notifyWorkspace(tr('Nguồn hoặc model đã thay đổi. Kết quả Article Spec đã lưu vẫn được giữ nguyên cho đến khi tạo lại.', 'Sources or model changed. The saved Article Spec remains active until regenerated.'), 'warning');
  }, [scanIsStale, tr]);
  // Saved Supabase results remain authoritative until the Step 1 selection
  // changes (which clears them) or the user explicitly regenerates.
  const ideas = storedIdeas;

  const fetchIdeas = async (manual = false) => {
    if (generationInFlight.current) return;
    if (!prerequisite.allowed) {
      setError(tr(prerequisite.reasonVi, prerequisite.reason));
      return;
    }
    if (!article.contentPlanInput?.trim() || !article.topic?.trim()) {
      setError("Bài viết chưa có topic được tổng hợp từ Content Plan. Vui lòng mở bài từ danh sách phân loại của Content Plan hiện tại.");
      return;
    }
    if (!article.contentType) {
      setError("Bài viết chưa có nhóm nội dung từ Content Plan đã phân loại.");
      return;
    }
    if (!bundle.totalCount) {
      setError("Chưa có tài liệu nào được phân quyền cho Bước 1. Vui lòng mở Cấu hình → AI access by Step.");
      return;
    }
    generationInFlight.current = true;
    setLoading(true);
    setError(null);
    setWarning(null);
    try {
      const seeds = [
        ...(selectedSnapshot?.keywords ?? []),
        selectedSnapshot?.label ?? "",
        article.contentType ?? "",
      ].map(seed => seed.trim()).filter(Boolean);
      const seoResearch = await researchSeoKeywords(seeds, article.id, railwayUrl, requestedKeywordCount);
      const contextQuery = [
        ...seeds,
        ...seoResearch.keywords.map(item => item.keyword),
      ].join(" ");
      const systemPrompt = buildRoleSystemPrompt(
        [
          canonicalAIOutputInstruction,
          `Build one canonical Article Spec, then propose EXACTLY ${requestedIdeaCount} content direction(s) for "${article.contentType}".`,
          selectedSnapshot
            ? `- Dùng lựa chọn Step 1 đã khóa làm định hướng bắt buộc: ${selectedSnapshot.label}; Type ${selectedSnapshot.typeGroup ?? "không xác định"}; ${selectedSnapshot.wave ?? ""}; ${selectedSnapshot.timeframe ?? ""}; keywords: ${(selectedSnapshot.keywords ?? []).join(", ")}.`
            : "- Không có snapshot cấu trúc từ Step 1; chỉ dùng content type đã chọn.",
          "- Mọi ý tưởng phải suy ra từ các phân vùng tài liệu thực sự được cấp quyền; không yêu cầu hoặc suy đoán dữ liệu từ phân vùng đang trống.",
          "- Dữ liệu SEO thị trường duy nhất được phép dùng là SEO_RESEARCH_TOP_10 do OpenAI Web Search thu thập kèm URL nguồn.",
          `- Đánh giá đủ cả ${requestedKeywordCount} keyword đúng MỘT LẦN ở keywordAudit cấp cao nhất: đối chiếu với từng phân vùng tài liệu đang được cấp quyền, rồi ghi accepted/rejected cùng lý do cụ thể.`,
          "- primary/secondary keywords chỉ được lấy từ các keyword accepted trong SEO_RESEARCH_TOP_10; không tự tạo keyword mới.",
          "- Mỗi idea phải có tiêu đề rõ ràng, main argument (luận điểm cốt lõi), Top SEO keywords, và rating chi tiết.",
          "- Rating cho theo thang 0-10 với 5 tiêu chí (overall, seoPotential, audienceFit, docSupport, uniqueness). Ghi rõ căn cứ chấm điểm.",
          "- ratingRationales phải giải thích riêng từng điểm: overall, seoPotential, audienceFit, docSupport và uniqueness; nêu rõ điểm mạnh, điểm yếu hoặc dữ liệu còn thiếu.",
          "- Ứng dụng tự gắn các excerpt đã kiểm chứng sau khi model trả kết quả. KHÔNG trả evidence, matchedDocs hoặc ruleRefs để tránh lặp token.",
          `- Trả CHÍNH XÁC ${requestedIdeaCount} ideas khác nhau; mỗi idea phải chọn một primary keyword accepted.`,
          "- Giữ JSON ngắn và ổn định: mỗi reason/ruleReason/kbReason tối đa 18 từ; angleDescription tối đa 30 từ; mainArgument tối đa 55 từ; mỗi rating rationale tối đa 16 từ.",
          "",
          "Trả về DUY NHẤT một JSON object hợp lệ, không kèm markdown fences hay text giải thích.",
          "Schema:",
          `{
  "articleSpec": {
    "topic": string, "primaryQuery": string, "secondaryQueries": string[],
    "audience": string, "market": string, "language": "English",
    "primaryIntent": "informational" | "commercial" | "transactional" | "navigational",
    "secondaryIntent": "informational" | "commercial" | "transactional" | "navigational" | null,
    "expectedReaderOutcome": string, "winningFormat": string,
    "mustCover": string[] (4-10 required coverage areas), "optionalCoverage": string[],
    "thesis": string, "brandPov": string, "ctaObjective": string,
    "internalLinkRequirements": string[]
  },
  "keywordAudit": [{ "keyword": string (chép đúng từ SEO_RESEARCH_TOP_10), "decision": "accepted" | "rejected", "reason": string, "ruleReason": string, "kbReason": string }],
  "ideas": [{
  "title": string (tiêu đề bài viết đề xuất, sẵn sàng dùng),
  "angleLabel": string (tên góc tiếp cận ngắn gọn, ví dụ "So sánh benchmark", "Hướng dẫn thực chiến"),
  "angleDescription": string (1-2 câu giải thích góc tiếp cận),
  "mainArgument": string (2-3 câu nêu luận điểm cốt lõi bài sẽ chứng minh),
  "seoKeywords": { "primary": string, "secondary": string[] (5-8 từ khóa phụ) },
  "targetAudience": string (mô tả cụ thể độc giả mục tiêu),
  "recommendedTone": string (ví dụ "Chuyên nghiệp", "Thân thiện" — phải khớp Rules),
  "recommendedWordCount": number (600-3000),
  "rating": {
    "overall": number (0-10),
    "seoPotential": number (0-10),
    "audienceFit": number (0-10),
    "docSupport": number (0-10, mức độ tài liệu hỗ trợ),
    "uniqueness": number (0-10, độ độc đáo so với thị trường)
  },
  "ratingRationale": string (1-2 câu giải thích điểm),
  "ratingRationales": { "overall": string, "seoPotential": string, "audienceFit": string, "docSupport": string, "uniqueness": string },
  "ideaSupport": string (1 câu giải thích idea phù hợp với tài liệu nội bộ như thế nào)
  }]
}`,
        ].join("\n"),
        documentPromptRules,
      );

      const userPrompt = [
        `TÀI LIỆU STEP 2 (${describeBundle(bundle)}):`,
        "Railway sẽ nạp trực tiếp nội dung các tài liệu đã được cấp quyền cho Bước 1 từ Supabase.",
        "",
        "LOẠI NỘI DUNG ĐÃ CHỌN Ở STEP 1:",
        `- ${article.contentType}`,
        ...(selectedSnapshot ? [
          "",
          "SNAPSHOT STEP 1 ĐÃ LƯU TRÊN SUPABASE (nguồn lựa chọn cố định):",
          JSON.stringify(selectedSnapshot),
        ] : []),
        "",
        `SEO_RESEARCH_TOP_10 — dữ liệu thị trường ${seoResearch.location}/${seoResearch.language}, research lúc ${seoResearch.researchedAt}:`,
        JSON.stringify(seoResearch.keywords),
        "",
        `Yêu cầu: Đề xuất ${requestedIdeaCount} core ideas theo schema.`,
        "Chỉ trả về JSON object theo schema — không markdown, không giải thích, không text thừa.",
        compiledWorkflowRules.taskGuidance,
      ].join("\n");

      let modelCalls = 0;
      const jsonRepairCalls = 0;
      let evidenceCorrectionCalls = 0;
      const aiResponses: Awaited<ReturnType<typeof callAI>>[] = [];
      const requestIdeas = async (bypassCache = false) => {
        modelCalls += 1;
        const res = await callAI({
          articleId: article.id,
          model,
          railwayUrl,
          prompt: userPrompt,
          systemPrompt,
          // The schema deliberately excludes evidence; a bounded completion
          // avoids paying for verbose rationales while preserving the user's
          // configured number of ideas.
          maxTokens: Math.min(3200, 1200 + requestedIdeaCount * 600),
          temperature: 0.1,
          stepNumber: 2,
          bypassCache,
          jsonMode: true,
          contextQuery,
        });
        aiResponses.push(res);
        const parsed = parseAIJson(res.content);
        return { res, parsed, ideas: normalizeIdeas(parsed, bundle, seoResearch, trustedEvidence) };
      };
      let result = await requestIdeas(manual);
      const resultRoot = result.parsed && typeof result.parsed === 'object' && !Array.isArray(result.parsed)
        ? result.parsed as Record<string, unknown>
        : {};
      const articleSpec: ArticleSpec = normalizeArticleSpec(resultRoot.articleSpec, {
        topic: selectedSnapshot?.label ?? article.topic ?? article.contentType,
        audience: selectedSnapshot?.audience,
        market: seoResearch.location,
        language: seoResearch.language,
        evidence: trustedEvidence,
        research: seoResearch,
      });
      if (!articleSpec.expectedReaderOutcome || articleSpec.mustCover.length < 3 || !articleSpec.thesis) {
        throw new Error('Article Spec thiếu expected outcome, thesis hoặc must-cover topics. Kết quả chưa được lưu.');
      }
      if (result.ideas.length < requestedIdeaCount) {
        evidenceCorrectionCalls += 1;
        const acceptedIdeas = result.ideas;
        const root = result.parsed && typeof result.parsed === "object" && !Array.isArray(result.parsed)
          ? result.parsed as Record<string, unknown>
          : {};
        const baseAudit = Array.isArray(root.keywordAudit) ? root.keywordAudit : [];
        const acceptedKeywords = baseAudit.flatMap(item => item && typeof item === "object" && (item as Record<string, unknown>).decision === "accepted"
          ? [String((item as Record<string, unknown>).keyword ?? "").trim()]
          : []).filter(Boolean);
        modelCalls += 1;
        const correctionResponse = await callAI({
          articleId: article.id,
          model,
          railwayUrl,
          prompt: [
            `Create exactly ${requestedIdeaCount - acceptedIdeas.length} additional distinct English core ideas for: ${article.contentType}.`,
            `Existing titles that must not be repeated: ${acceptedIdeas.map(item => JSON.stringify(item.title)).join(", ") || "none"}.`,
            `Allowed accepted SEO keywords only: ${JSON.stringify(acceptedKeywords)}.`,
            "Return only a JSON object with an ideas array. Do not return keywordAudit, evidence, documents, or explanations outside JSON.",
            "Each idea must include: title, angleLabel, angleDescription, mainArgument, seoKeywords {primary, secondary}, targetAudience, recommendedTone, recommendedWordCount, rating, ratingRationale, ratingRationales.",
          ].join("\n"),
          systemPrompt: canonicalAIOutputInstruction,
          maxTokens: Math.min(4200, 1000 + (requestedIdeaCount - acceptedIdeas.length) * 700),
          temperature: 0.2,
          stepNumber: 2,
          bypassCache: true,
          jsonMode: true,
          skipDocumentContext: true,
        });
        aiResponses.push(correctionResponse);
        const correctionParsed = parseAIJson(correctionResponse.content);
        const correctionRoot = correctionParsed && typeof correctionParsed === "object" && !Array.isArray(correctionParsed)
          ? correctionParsed as Record<string, unknown>
          : { ideas: correctionParsed };
        const correctionIdeas = normalizeIdeas({ keywordAudit: baseAudit, ideas: correctionRoot.ideas }, bundle, seoResearch, trustedEvidence);
        const mergedIdeas = [...acceptedIdeas, ...correctionIdeas]
          .filter((idea, index, all) => all.findIndex(candidate => candidate.title.toLocaleLowerCase() === idea.title.toLocaleLowerCase()) === index)
          .slice(0, Math.max(requestedIdeaCount, acceptedIdeas.length));
        result = { ...result, res: correctionResponse, ideas: mergedIdeas };
      }
      if (!result.ideas.length) {
        throw new Error(
          `Không có core idea nào vượt qua kiểm chứng sau một lần bổ sung có mục tiêu. Đã đối chiếu ${bundle.knowledgeBase.length} KB, ${bundle.contentPlan.length} Content Plan và ${bundle.rules.length} Skills.`,
        );
      }
      const partialResult = result.ideas.length < requestedIdeaCount;
      const allAudits = result.ideas.flatMap(idea => idea.keywordAudit ?? []);
      const acceptedKeywords = new Set(allAudits.filter(item => item.decision === 'accepted').map(item => item.keyword.toLocaleLowerCase())).size;
      const rejectedKeywords = new Set(allAudits.filter(item => item.decision === 'rejected').map(item => item.keyword.toLocaleLowerCase())).size;
      const trace: AIProcessTraceEvent[] = [
        { id: 'step2-seeds', stage: 'input', status: 'completed', title: '1. Thu thập seed keyword', detail: 'Lấy seed từ Content Type và snapshot Step 1 đã chọn.', facts: { seeds: seeds.length, contentType: article.contentType } },
        { id: 'step2-web-search', stage: 'tool', status: 'completed', title: '2. OpenAI Web Search thị trường USA', detail: 'Tìm tín hiệu SERP, related-query patterns và search intent. Hệ thống chỉ giữ keyword có URL nguồn hợp lệ.', facts: { keywords: seoResearch.keywords.length, cacheHit: Boolean(seoResearch.cacheHit), market: seoResearch.location }, sources: [...new Set(seoResearch.keywords.flatMap(keyword => keyword.sources ?? []))] },
        { id: 'step2-docs', stage: 'retrieval', status: 'completed', title: '3. Nạp nguồn của activity', detail: `Railway dùng topic đã phân loại cùng Content Plan hiện tại, Knowledge Base và Skills; quote vẫn được kiểm chứng với nội dung đầy đủ.\nPrompting rules theo phân vùng:\n${documentPromptRules || '(không có rule tùy chỉnh)'}`, facts: { kb: bundle.knowledgeBase.length, contentPlan: bundle.contentPlan.length, rules: bundle.rules.length } },
        { id: 'step2-model', stage: 'generation', status: 'completed', title: '4. Model tạo và chấm Core Idea', detail: `Model ${result.res.model} audit Top 10 và tạo đúng ba Core Idea. Evidence không được model sinh lại; ứng dụng gắn excerpt đã kiểm chứng để giảm token và lỗi quote.`, facts: { modelCalls, inputTokens: aiResponses.reduce((sum, response) => sum + (response.usage?.inputTokens ?? 0), 0), outputTokens: aiResponses.reduce((sum, response) => sum + (response.usage?.outputTokens ?? 0), 0), cacheHits: aiResponses.filter(response => response.cacheHit).length, durationMs: aiResponses.reduce((sum, response) => sum + (response.timing?.totalMs ?? 0), 0) } },
        { id: 'step2-validation', stage: 'validation', status: jsonRepairCalls || evidenceCorrectionCalls || partialResult ? 'warning' : 'completed', title: '5. Đối chứng tài liệu và kiểm tra output', detail: 'Cả bộ Core Idea phải audit đủ Top 10 và chỉ dùng keyword accepted. Evidence từ Knowledge Base, Content Plan và Skills được chọn, xác minh trong ứng dụng; lượt bổ sung idea không nạp lại tài liệu.', facts: { acceptedKeywords, rejectedKeywords, ideasAccepted: result.ideas.length, verifiedEvidence: trustedEvidence.length, jsonRepairCalls, evidenceCorrectionCalls } },
        { id: 'step2-persist', stage: 'persistence', status: 'completed', title: '6. Lưu kết quả có thể audit', detail: 'Lưu Top 10, quyết định chọn/loại, evidence, điểm số, lý do và nhật ký này cùng bài viết trong Supabase.' },
      ];
      const specFingerprint = articleSpecFingerprint(articleSpec);
      const saved = await onUpdate({
        coreIdeaSuggestions: result.ideas,
        selectedCoreIdeaId: undefined,
        articleSpec,
        articleSpecFingerprint: specFingerprint,
        currentStep: 2,
        coreIdeaSourceFingerprint: sourceFingerprint,
        coreIdeaScannedAt: result.res.servedAt ?? result.res.generatedAt ?? new Date().toISOString(),
        seoResearch,
        step2ProcessTrace: trace,
        workflowRuleSnapshots: { ...article.workflowRuleSnapshots, 2: compiledWorkflowRules.snapshot },
      });
      if (!saved) throw new Error('Kết quả Bước 1 chưa được lưu vào Supabase.');
      if (partialResult) {
        setWarning(`Đã lưu ${result.ideas.length}/${requestedIdeaCount} core idea vượt qua đầy đủ kiểm chứng. Bạn có thể tiếp tục với kết quả hợp lệ hoặc nhấn “Đề xuất lại” để thử bổ sung.`);
      } else {
        notifyWorkspace('Đã tạo, kiểm tra và lưu Article Spec cùng các Core Idea.', 'success');
      }
      setSelectedId(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Không lấy được đề xuất từ AI: ${message}`);
    } finally {
      generationInFlight.current = false;
      setLoading(false);
    }
  };

  const handleSelect = (idea: CoreIdeaSuggestion) => {
    const selectionChanged = article.selectedCoreIdeaId !== idea.id;
    const selectedSpec = article.articleSpec ? { ...article.articleSpec, thesis: idea.mainArgument, audience: idea.targetAudience || article.articleSpec.audience } : null;
    setSelectedId(idea.id);
    onUpdate({
      selectedCoreIdeaId: idea.id,
      title: idea.title,
      topic: idea.title,
      angle: idea.angleLabel,
      keywords: [idea.primaryKeyword, ...idea.secondaryKeywords].filter(Boolean).join(", "),
      targetAudience: idea.targetAudience,
      tone: idea.recommendedTone,
      wordCount: idea.recommendedWordCount,
      articleSpec: selectedSpec,
      articleSpecFingerprint: selectedSpec ? articleSpecFingerprint(selectedSpec) : article.articleSpecFingerprint,
      ...(selectionChanged ? {
        outline: [],
        outlineSourceFingerprint: null,
        outlineScannedAt: null,
        step3ProcessTrace: [],
        draft: "",
        draftSourceFingerprint: null,
        draftScannedAt: null,
      } : {}),
    });
  };

  const isCurrentStep = (article.currentStep ?? 2) <= 2;
  const canContinueToOutline = isCurrentStep && gateStepCompletion({ ...article, selectedCoreIdeaId: selectedId ?? undefined }, 2).allowed && !scanIsStale;
  const stepActionDisabled = loading || (!canContinueToOutline && (!prerequisite.allowed || !bundle.totalCount));

  return (
    <div className={`minimal-step flex flex-col gap-4 animate-fade-in-up ${embedded ? 'continuous-step' : 'h-full'}`}>
      <div className={`minimal-step-shell bg-white rounded-2xl border border-slate-200 flex flex-col overflow-hidden ${embedded ? '' : 'flex-1 min-h-0'}`}>
        <div className={`p-3.5 sm:p-5 md:p-6 ${embedded ? '' : 'flex-1 overflow-y-auto'}`}>
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
              <div>
                <h2 className="text-base font-bold text-slate-800 mb-1">{tr('Bước 1 — Article Spec & Hướng nội dung', 'Step 1 — Article Spec & Direction')}</h2>
                <p className="text-xs text-slate-500 leading-relaxed">
                  {tr(`AI đề xuất ${requestedIdeaCount} ý tưởng cho loại nội dung `, `AI proposes ${requestedIdeaCount} core ideas for `)}<b>"{article.contentType || tr('(chưa chọn)', '(not selected)')}"</b>. {tr('Chọn một để sang Bước 2.', 'Select one to continue to Step 2.')}
                </p>
              </div>
            </div>
            <StepUsage step={1} usage={article.aiUsageByStep?.[2]} />

            {!loading && article.articleSpec && (
              <section className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-slate-800">Article Spec</h3>
                  <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[9px] text-slate-500">{article.articleSpec.market} · {article.articleSpec.primaryIntent}</span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-600"><b className="text-slate-800">{tr('Kết quả người đọc:', 'Reader outcome:')}</b> {article.articleSpec.expectedReaderOutcome}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">{article.articleSpec.mustCover.map(item => <span key={item} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[9px] text-slate-600">{item}</span>)}</div>
              </section>
            )}

            {loading && (
              <div className="space-y-3">
                {[0, 1, 2].map(i => (
                  <div key={i} className="border border-slate-200 rounded-xl p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <div className="ai-loading h-3 w-20" />
                      <div className="ai-loading h-6 w-10" />
                    </div>
                    <div className="ai-loading h-5 w-full" />
                    <div className="ai-loading h-3 w-full" />
                    <div className="ai-loading h-3 w-5/6" />
                    <div className="flex gap-1 pt-1">
                      <div className="ai-loading h-5 w-16 rounded-full" />
                      <div className="ai-loading h-5 w-20 rounded-full" />
                      <div className="ai-loading h-5 w-14 rounded-full" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!loading && ideas.length > 0 && (
              <div className="core-idea-suggestions border-t pt-4">
                <h3 className="core-idea-suggestions-title mb-2 px-2 text-sm font-medium text-slate-600">{tr('Các đề xuất', 'Suggestions')}</h3>
                <div className="space-y-1">
                  {ideas.map(idea => {
                    const isSelected = selectedId === idea.id;
                    return (
                      <div key={idea.id} className={`core-idea-card group flex min-w-0 items-start rounded-lg ${isSelected ? "is-selected" : ""}`}>
                        <button type="button" onClick={() => handleSelect(idea)} className="core-idea-select-area min-w-0 flex-1 px-3 py-3 text-left" aria-pressed={isSelected}>
                          <div className="core-idea-score flex items-baseline gap-1.5">
                            <span className="core-idea-score-label text-[9px] font-medium uppercase tracking-wide">{tr('Điểm', 'Score')}</span>
                            <span className={`core-idea-score-value text-[11px] font-semibold leading-none tabular-nums ${ratingColor(idea.rating.overall)}`}>{idea.rating.overall.toFixed(1)}</span>
                          </div>
                          <div className="mt-1 min-w-0">
                            <h3 className="text-[13px] font-medium leading-snug text-slate-900">{idea.title}</h3>
                            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{idea.mainArgument}</p>
                          </div>
                        </button>
                        <button type="button" onClick={() => setDetailIdeaId(idea.id)} className="core-idea-details-button mr-2 mt-2.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" title={tr('Xem chi tiết', 'View details')} aria-label={`${tr('Xem chi tiết', 'View details')}: ${idea.title}`}><Ellipsis className="app-icon" aria-hidden="true" /></button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {!loading && ideas.length === 0 && !error && article.contentType && bundle.totalCount > 0 && (
              <div className="border-2 border-dashed border-slate-200 rounded-2xl p-6 text-center text-xs text-slate-500">
                {tr('Nhấn', 'Click')} <span className="font-semibold">"{tr('Lấy đề xuất', 'Generate ideas')}"</span> {tr('để AI phân tích tài liệu và gợi ý core ideas.', 'to let AI analyze documents and suggest core ideas.')}
              </div>
            )}
          </div>
        </div>
      </div>

      {detailIdeaId && (() => {
        const idea = ideas.find(item => item.id === detailIdeaId);
        if (!idea) return null;
        const isSelected = selectedId === idea.id;
        const tag = ratingTag(idea.rating.overall);
        const ratings = [
          { key: "seoPotential" as const, label: "SEO Potential", value: idea.rating.seoPotential },
          { key: "audienceFit" as const, label: "Audience Fit", value: idea.rating.audienceFit },
          { key: "docSupport" as const, label: "Doc Support", value: idea.rating.docSupport },
          { key: "uniqueness" as const, label: "Uniqueness", value: idea.rating.uniqueness },
        ];
        return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm sm:p-6" onMouseDown={event => event.target === event.currentTarget && setDetailIdeaId(null)} role="dialog" aria-modal="true" aria-labelledby="core-idea-detail-title">
          <div className="writer-light contents">
          <div className="flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {idea.angleLabel && <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{idea.angleLabel}</span>}
                  <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold leading-none ${tag.className}`}>{tag.label}</span>
                  <span className="inline-flex items-baseline gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
                    <b className={`font-mono text-xs ${ratingColor(idea.rating.overall)}`}>{idea.rating.overall.toFixed(1)}</b><span className="text-[9px] text-slate-400">/10</span>
                  </span>
                </div>
                <h3 id="core-idea-detail-title" className="mt-2 text-base font-semibold leading-snug text-slate-900">{idea.title}</h3>
              </div>
              <button type="button" onClick={() => setDetailIdeaId(null)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-lg text-slate-500 hover:bg-slate-200" aria-label={tr('Đóng', 'Close')}>×</button>
            </header>
            <div className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
              <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">Main argument</p>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-800">{idea.mainArgument}</p>
              </section>
              {idea.angleDescription && <section><h4 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{tr('Lý do chọn góc tiếp cận', 'Angle rationale')}</h4><p className="mt-1.5 text-xs leading-relaxed text-slate-600">{idea.angleDescription}</p></section>}
              <section className="grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-3">
                <div className="rounded-lg border border-slate-200 p-3"><b className="block text-[10px] text-slate-500">{tr('Độc giả', 'Audience')}</b><span className="mt-1 block leading-relaxed text-slate-800">{idea.targetAudience || '—'}</span></div>
                <div className="rounded-lg border border-slate-200 p-3"><b className="block text-[10px] text-slate-500">Tone</b><span className="mt-1 block leading-relaxed text-slate-800">{idea.recommendedTone || '—'}</span></div>
                <div className="rounded-lg border border-slate-200 p-3"><b className="block text-[10px] text-slate-500">{tr('Độ dài', 'Length')}</b><span className="mt-1 block text-slate-800">{idea.recommendedWordCount.toLocaleString()} {tr('từ', 'words')}</span></div>
              </section>
              <section><h4 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Top SEO keywords</h4><div className="mt-2 flex flex-wrap gap-1.5">{idea.primaryKeyword && <span className="core-keyword-chip is-primary rounded-full border px-2.5 py-1 text-[10px] font-medium">{idea.primaryKeyword}</span>}{idea.secondaryKeywords.map(keyword => <span key={keyword} className="core-keyword-chip rounded-full border px-2.5 py-1 text-[10px] font-medium">{keyword}</span>)}</div></section>
              <section><h4 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Rating breakdown</h4><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">{ratings.map(rating => <div key={rating.key} className="rounded-xl border border-slate-200 bg-slate-50 p-3"><RatingCircle label={rating.label} score={rating.value}/><p className="mt-2 text-[9px] leading-relaxed text-slate-500">{idea.ratingRationales?.[rating.key] || idea.ratingRationale}</p></div>)}</div>{idea.ratingRationale && <div className="mt-3 rounded-lg border border-slate-200 px-3 py-2.5 text-[10px] leading-relaxed text-slate-600"><b className="font-semibold text-slate-800">{tr('Đánh giá tổng quan:', 'Overall assessment:')}</b> {idea.ratingRationales?.overall || idea.ratingRationale}</div>}</section>
              <section><h4 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{tr('Toàn bộ dẫn chứng đã kiểm chứng', 'All verified evidence')}</h4><div className="mt-2 grid gap-2">{(idea.evidence ?? []).map((evidence, index) => <div key={`${evidence.source}-${index}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="flex flex-wrap gap-1.5"><span className="text-[9px] font-semibold uppercase text-slate-500">{evidence.role}</span><span className="text-[10px] font-semibold text-slate-700">{evidence.source}</span></div>{evidence.quote && <blockquote className="mt-1.5 border-l-2 border-slate-300 pl-2 text-[10px] leading-relaxed text-slate-700">“{evidence.quote}”</blockquote>}{evidence.note && <p className="mt-1.5 text-[10px] text-slate-500"><b>{tr('Lý do sử dụng:', 'Why it matters:')}</b> {evidence.note}</p>}</div>)}</div></section>
            </div>
            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 sm:px-6">
              <button type="button" onClick={() => { setDetailIdeaId(null); setAuditIdeaId(idea.id); }} className="ai-log-button inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[10px] font-medium"><Search className="app-icon"/>{tr('Xem nhật ký AI', 'View AI log')}</button>
              <button type="button" onClick={() => { handleSelect(idea); setDetailIdeaId(null); }} className={`rounded-lg px-4 py-2 text-[10px] font-semibold ${isSelected ? "border border-slate-200 bg-white text-slate-700" : "bg-slate-900 text-white hover:bg-slate-800"}`}>{isSelected ? tr('Đã chọn ý tưởng này', 'This idea is selected') : tr('Chọn ý tưởng này', 'Select this idea')}</button>
            </footer>
          </div>
          </div>
        </div>, document.body);
      })()}

      {auditIdeaId && (() => { const idea = ideas.find(item => item.id === auditIdeaId); if (!idea) return null; return <ProcessTraceModal title={idea.title} events={article.step2ProcessTrace} onClose={() => setAuditIdeaId(null)}><div className="space-y-4"><div><h4 className="text-xs font-bold text-slate-800">SEO Research Top 10</h4><div className="space-y-2 mt-2">{article.seoResearch?.keywords.map((keyword, index) => <div key={keyword.keyword} className="rounded-lg border border-cyan-100 bg-cyan-50/50 p-3 text-[10px]"><div className="flex flex-wrap gap-2"><span className="font-mono text-cyan-700">#{index + 1}</span><b>{keyword.keyword}</b><span>{keyword.intent ?? 'intent n/a'}</span></div>{keyword.marketEvidence && <p className="mt-1 text-slate-600">{keyword.marketEvidence}</p>}<div className="flex gap-2 mt-1">{keyword.sources?.map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer" className="text-cyan-700 underline">Source {i + 1}</a>)}</div></div>)}</div></div><div><h4 className="text-xs font-bold text-slate-800">{tr('Đối chứng keyword của lựa chọn', 'Keyword validation for this idea')}</h4><div className="divide-y divide-slate-100 rounded-lg border border-slate-200 mt-2">{idea.keywordAudit?.map(item => <div key={item.keyword} className="p-3 text-[10px]"><div className="flex gap-2"><span className={`font-bold ${item.decision === 'accepted' ? 'text-emerald-700' : 'text-rose-700'}`}>{item.decision}</span><b>{item.keyword}</b></div><p className="mt-1">{item.reason}</p><p className="mt-1 text-amber-700"><b>Rules:</b> {item.ruleReason}</p><p className="mt-1 text-indigo-700"><b>KB/Action:</b> {item.kbReason}</p></div>)}</div></div></div></ProcessTraceModal>; })()}

      <div className={`flex gap-2 shrink-0 ${embedded ? 'continuous-step-action justify-start' : 'justify-between'}`}>
        {!embedded && (
        <button
          onClick={onPrev}
          className="bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 font-semibold text-xs py-2.5 px-3 sm:px-5 rounded-2xl shadow-sm transition-all"
        >
          {tr('Quay lại', 'Back')}
        </button>
        )}
        <button
          onClick={canContinueToOutline ? onNext : () => void fetchIdeas(Boolean(ideas.length))}
          disabled={stepActionDisabled}
          className="workflow-endpoint-button"
        >
          {loading ? <><LoaderCircle className="app-icon animate-spin" aria-hidden="true" /><span>{tr('Đang phân tích...', 'Analyzing...')}</span></>
            : canContinueToOutline ? <><span>{tr('Tiếp tục — Draft Outline', 'Continue — Draft Outline')}</span><ArrowRight className="app-icon" aria-hidden="true" /></>
            : <><Sparkles className="app-icon" aria-hidden="true" /><span>{ideas.length ? tr('Đề xuất lại', 'Regenerate ideas') : tr('Lấy đề xuất', 'Generate ideas')}</span></>}
        </button>
      </div>
    </div>
  );
}

import { interactionStart, measureAfterPaint, postPerformanceSample, sendPerformanceSample } from "../../lib/performanceTelemetry";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, ChevronUp, Ellipsis, Eye, LoaderCircle, Plus, Sparkles, Trash2 } from "lucide-react";
import type {
  Article,
  AIModel,
  AppConfig,
  DocumentFile,
  OutlineSection,
  SearchIntent,
  AIProcessTraceEvent,
} from "../../types";
import { callAI } from "../../lib/aiService";
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
import { StepUsage } from './StepUsage';

function generateId() {
  return Math.random().toString(36).slice(2, 9);
}

const SEARCH_INTENT_META: Record<SearchIntent, { label: string; color: string }> = {
  informational: { label: "Informational", color: "bg-blue-50 text-blue-700 border-blue-200" },
  commercial:    { label: "Commercial",    color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  transactional: { label: "Transactional", color: "bg-amber-50 text-amber-700 border-amber-200" },
  navigational:  { label: "Navigational",  color: "bg-slate-100 text-slate-700 border-slate-200" },
};

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const objectStart = body.indexOf("{");
  const arrayStart = body.indexOf("[");
  const start = objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart) ? objectStart : arrayStart;
  const end = start === objectStart ? body.lastIndexOf("}") : body.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("Không tìm thấy JSON.");
  const json = body.slice(start, end + 1);
  try {
    return JSON.parse(json);
  } catch (firstError) {
    // Repair common model-output mistakes without changing any text values:
    // trailing commas, adjacent objects and missing commas between properties.
    const repaired = json
      .replace(/\u00a0/g, " ")
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/}\s*{/g, "},{")
      .replace(
        /("(?:\\.|[^"\\])*"|\d+(?:\.\d+)?|true|false|null|\]|})\s*\n\s*(?="[^"\n]+"\s*:)/g,
        "$1,\n",
      );
    try {
      return JSON.parse(repaired);
    } catch {
      throw firstError;
    }
  }
}

function toStringArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  return [];
}

function normalizeIntent(v: unknown): SearchIntent | undefined {
  const s = String(v ?? "").toLowerCase();
  if (s === "informational" || s === "commercial" || s === "transactional" || s === "navigational") return s;
  return undefined;
}

function normalizeSections(
  parsed: unknown,
  bundle: ReturnType<typeof collectStepDocs>,
  trustedEvidence: ReturnType<typeof verifyEvidence> = [],
): { sections: OutlineSection[]; rejectedHeadings: string[]; rawSectionCount: number; registryCount: number } {
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  const rawSections = root?.sections ?? parsed;
  if (!Array.isArray(rawSections)) throw new Error("Phản hồi AI không có mảng sections.");
  const registryValue = root?.evidenceRegistry;
  const registry: Record<string, unknown> = registryValue && typeof registryValue === "object" && !Array.isArray(registryValue)
    ? registryValue as Record<string, unknown>
    : Object.fromEntries((Array.isArray(registryValue) ? registryValue : []).flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const id = String(record.id ?? record.key ?? record.ref ?? `ev-${index + 1}`).trim();
      return id ? [[id, record]] : [];
    }));
  const rejectedHeadings: string[] = [];
  const sections = rawSections
    .map(raw => {
      if (!raw || typeof raw !== "object") return null;
      const obj = raw as Record<string, unknown>;
      const heading = String(obj.heading ?? obj.title ?? "").trim();
      if (!heading) return null;
      const lvl = String(obj.level ?? "h2").toLowerCase();
      const rawRefs = Array.isArray(obj.evidenceRefs) ? obj.evidenceRefs : toStringArr(obj.evidenceRefs);
      const registryEvidence = rawRefs.flatMap(ref => {
        if (ref && typeof ref === "object") {
          const record = ref as Record<string, unknown>;
          const id = String(record.id ?? record.ref ?? record.evidenceId ?? "").trim();
          return id && registry[id] ? [registry[id]] : [record];
        }
        const id = String(ref).trim();
        return registry[id] ? [registry[id]] : [];
      });
      const evidence = verifyEvidence([
        ...(Array.isArray(obj.evidence) ? obj.evidence : []),
        ...registryEvidence,
        ...trustedEvidence,
      ], bundle).filter((item, index, all) => all.findIndex(candidate =>
        candidate.source === item.source && candidate.role === item.role && candidate.quote === item.quote
      ) === index);
      if (!hasEvidenceForAuthorizedCategories(evidence, bundle)) {
        rejectedHeadings.push(heading);
        return null;
      }
      return {
        id: generateId(),
        heading,
        notes: String(obj.notes ?? obj.description ?? "").trim(),
        rationale: String(obj.rationale ?? obj.reasoning ?? "").trim(),
        level: lvl === "h3" ? "h3" : "h2",
        keywords: toStringArr(obj.keywords),
        searchIntent: normalizeIntent(obj.searchIntent),
        evidence,
        ruleRefs: verifiedRuleRefs(obj.ruleRefs, bundle),
      } as OutlineSection;
    })
    .filter((v): v is OutlineSection => v !== null);
  return { sections, rejectedHeadings, rawSectionCount: rawSections.length, registryCount: Object.keys(registry).length };
}

function targetSectionCount(wordCount: number): number {
  if (wordCount <= 1000) return 6;
  if (wordCount <= 1800) return 8;
  return 10;
}

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

export default function Step3Outline({
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
  const { tr, canonicalAIOutputInstruction } = useI18n();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [suggestingKeywords, setSuggestingKeywords] = useState(false);
  const suggestedKeywords = article.step3SuggestedKeywords ?? [];
  const [newSectionHeading, setNewSectionHeading] = useState("");
  const [newSectionLevel, setNewSectionLevel] = useState<"h2" | "h3">("h2");
  const generationInFlight = useRef(false);
  // ui-kpi-v2: the server acknowledged the outline request (before the AI call).
  const [accepted, setAccepted] = useState(false);
  const generationTiming = useRef<{ start: number; clickSent: boolean; accepted: Promise<number | null> | null; saved: boolean } | null>(null);
  useLayoutEffect(() => {
    const timing = generationTiming.current;
    if (!timing) return;
    if (generating && !timing.clickSent) {
      timing.clickSent = true;
      sendPerformanceSample("clickLatency", timing.start);
    }
    if (generating && accepted && !timing.accepted) timing.accepted = measureAfterPaint(timing.start);
    if (!generating) {
      generationTiming.current = null;
      // Measured when "accepted" was painted; sent only for saved outlines, as before.
      if (timing.saved && timing.accepted) void timing.accepted.then((ms) => postPerformanceSample("responseTime", ms));
    }
  }, [generating, accepted]);
  const outline = article.outline || [];
  const prerequisite = gateArticleStep(article, 3);

  useEffect(() => { if (error) notifyWorkspace(error, 'error'); }, [error]);
  useEffect(() => { if (warning) notifyWorkspace(warning, 'warning'); }, [warning]);

  const bundle = useMemo(() => collectStepDocs(3, config, files, article.contentPlanInput), [article.contentPlanInput, config, files]);
  const documentPromptRules = useMemo(() => buildStepDocumentPromptRules(3, config, files), [config, files]);
  const compiledWorkflowRules = useMemo(() => compileWorkflowRules(config, 3, 'manual'), [config]);
  const selectedCoreIdea = useMemo(
    () => article.coreIdeaSuggestions?.find(idea => idea.id === article.selectedCoreIdeaId) ?? null,
    [article.coreIdeaSuggestions, article.selectedCoreIdeaId],
  );
  const trustedCoreIdeaEvidence = useMemo(
    // The registry can reuse a small verified evidence set by ID. Sending an
    // unbounded history here duplicates prompt context without improving the
    // outline's grounding.
    () => verifyEvidence(selectedCoreIdea?.evidence, bundle).slice(0, 8),
    [bundle, selectedCoreIdea],
  );
  const sourceFingerprint = useMemo(
    () => [
      buildWorkflowSourceFingerprint(bundle), model.provider, model.id, "step3-audit-v6-content-plan",
      article.contentType, article.topic, article.angle, article.keywords,
      article.targetAudience, article.tone, article.wordCount, article.selectedCoreIdeaId, compiledWorkflowRules.fingerprint,
      article.articleSpecFingerprint,
    ].join(":"),
    [article.angle, article.articleSpecFingerprint, article.contentType, article.keywords, article.selectedCoreIdeaId, article.targetAudience, article.tone, article.topic, article.wordCount, bundle, compiledWorkflowRules.fingerprint, model.id, model.provider],
  );
  const outlineIsStale = Boolean(outline.length) && article.outlineSourceFingerprint !== sourceFingerprint;
  useEffect(() => {
    if (outlineIsStale) notifyWorkspace('Nguồn hoặc model đã thay đổi. Outline đã lưu vẫn được giữ nguyên cho đến khi tạo lại.', 'warning');
  }, [outlineIsStale]);

  const contextBrief = useMemo(() => {
    const kws = (article.keywords || "").split(",").map(k => k.trim()).filter(Boolean);
    return {
      contentType: article.contentType || "",
      topic: article.topic || "",
      angle: article.angle || "",
      tone: article.tone || "",
      audience: article.targetAudience || "",
      wordCount: article.wordCount || 1500,
      primaryKeyword: kws[0] || "",
      secondaryKeywords: kws.slice(1),
    };
  }, [article]);
  const compactArticleSpec = useMemo(() => ({
    primaryQuery: article.articleSpec?.primaryQuery,
    secondaryQueries: article.articleSpec?.secondaryQueries?.slice(0, 6),
    audience: article.articleSpec?.audience,
    primaryIntent: article.articleSpec?.primaryIntent,
    expectedReaderOutcome: article.articleSpec?.expectedReaderOutcome,
    winningFormat: article.articleSpec?.winningFormat,
    mustCover: article.articleSpec?.mustCover?.slice(0, 8),
    thesis: article.articleSpec?.thesis,
    brandPov: article.articleSpec?.brandPov,
    ctaObjective: article.articleSpec?.ctaObjective,
  }), [article.articleSpec]);
  const desiredSections = targetSectionCount(contextBrief.wordCount);
  const configuredMinimumSections = Math.min(12, Math.max(4, Number(getWorkflowParameter(config, 'outline', 'outline-mapping', 'minimumSections') ?? 4)));
  const minimumSections = Math.max(configuredMinimumSections, desiredSections - 2);
  const contextQuery = [
    contextBrief.contentType,
    contextBrief.topic,
    contextBrief.angle,
    contextBrief.primaryKeyword,
    ...contextBrief.secondaryKeywords,
  ].filter(Boolean).join(" ");

  const handleGenerate = async (manual: boolean, eventTime: number) => {
    const startedAt = interactionStart({ timeStamp: eventTime });
    if (generationInFlight.current) return;
    if (!prerequisite.allowed) {
      setError(tr(prerequisite.reasonVi, prerequisite.reason));
      return;
    }
    if (!article.contentPlanInput?.trim() || !article.topic?.trim()) {
      setError("Bài viết chưa có topic được tổng hợp từ Content Plan hiện tại.");
      return;
    }
    if (!article.topic) {
      setError("Chưa có Core Idea từ Bước 1.");
      return;
    }
    if (!bundle.totalCount) {
      setError("Chưa có tài liệu nào được phân quyền cho Bước 2. Chỉ cần ít nhất một tài liệu từ Knowledge Base hoặc Skills.");
      return;
    }
    generationInFlight.current = true;
    generationTiming.current = { start: startedAt, clickSent: false, accepted: null, saved: false };
    setAccepted(false);
    setGenerating(true);
    setError(null);
    setWarning(null);
    try {
      const systemPrompt = buildRoleSystemPrompt(
        [
          canonicalAIOutputInstruction,
          "Tạo dàn bài (outline) chi tiết với keyword mapping và search intent cho từng section.",
          "- Knowledge Base cung cấp luận điểm và evidence cho từng mục.",
          "- Content Plan hiện tại cung cấp topic, nhóm nội dung và keyword đã được phân loại cho article; không dùng kế hoạch legacy.",
          "- Rules & Guidelines quyết định định dạng heading, độ sâu H2/H3, cách đặt tiêu đề, quy tắc SEO.",
          "- Mỗi section PHẢI ghi rõ: keywords được nhắm tới, searchIntent và evidenceRefs trỏ tới evidenceRegistry dùng chung.",
          "- Mỗi section phải có rationale giải thích vì sao section này cần thiết, vì sao đặt ở vị trí đó và evidence hỗ trợ quyết định như thế nào.",
          "- Nếu có KB/Content Plan, mỗi section cần ít nhất 1 quote từ một trong hai nguồn. Nếu có Skills, cần thêm ít nhất 1 quote từ Skills. Bỏ qua nhóm đang trống.",
          "- source phải đúng chính xác tên file được cấp; quote phải chép nguyên văn, không diễn giải.",
          "",
          "Mỗi quote chỉ khai báo MỘT LẦN trong evidenceRegistry; nhiều section dùng chung quote phải tham chiếu cùng ID để tiết kiệm output.",
          "Trả về DUY NHẤT một JSON object hợp lệ, không markdown fences, không giải thích.",
          "- JSON phải parse được bằng JSON.parse: dùng dấu phẩy giữa mọi field/phần tử và escape dấu ngoặc kép nằm trong chuỗi bằng \\\".",
          "Schema:",
          `{
  "evidenceRegistry": {
    "ev-1": { "source": string, "note": string, "quote": string, "role": "kb" | "content_plan" | "rules" }
  },
  "sections": [{
  "heading": string (tiêu đề section, sẵn sàng dùng),
  "level": "h2" | "h3",
  "notes": string (1 câu ngắn mô tả nội dung, tối đa 120 ký tự),
  "rationale": string (2-3 câu giải thích lý do chọn section, vị trí và căn cứ tài liệu),
  "keywords": string[] (2-5 từ khóa nhắm tới),
  "searchIntent": "informational" | "commercial" | "transactional" | "navigational",
  "evidenceRefs": string[] (ID tồn tại trong evidenceRegistry),
  "ruleRefs": string[]
  }]
}`,
        ].join("\n"),
        documentPromptRules,
      );

      const userPrompt = [
        `TÀI LIỆU STEP 3 (${describeBundle(bundle)}):`,
        "Railway sẽ nạp trực tiếp nội dung các tài liệu đã được cấp quyền cho Bước 2 từ Supabase.",
        "",
        "DỮ LIỆU TỪ 2 BƯỚC TRƯỚC:",
        `- ARTICLE SPEC CONTRACT (compact): ${JSON.stringify(compactArticleSpec)}`,
        `- Loại nội dung (Step 1): ${contextBrief.contentType}`,
        `- Tiêu đề bài viết (Step 2): "${contextBrief.topic}"`,
        `- Angle: ${contextBrief.angle}`,
        `- Độc giả: ${contextBrief.audience}`,
        `- Tone: ${contextBrief.tone}`,
        `- Số từ mục tiêu: ${contextBrief.wordCount}`,
        `- Primary keyword: ${contextBrief.primaryKeyword}`,
        `- Secondary keywords: ${contextBrief.secondaryKeywords.join(", ")}`,
        ...(trustedCoreIdeaEvidence.length ? [
          "",
          "EVIDENCE STEP 2 ĐÃ ĐƯỢC XÁC MINH (có thể tái sử dụng bằng quote/source tương ứng):",
          JSON.stringify(trustedCoreIdeaEvidence),
        ] : []),
        "",
        `Yêu cầu: Trả về khoảng ${desiredSections} section trong JSON object với keyword mapping, search intent và evidence chi tiết.`,
        compiledWorkflowRules.taskGuidance,
      ].join("\n");

      let modelCalls = 1;
      const jsonRepairCalls = 0;
      let evidenceCorrectionCalls = 0;
      const aiResponses: Awaited<ReturnType<typeof callAI>>[] = [];
      const res = await callAI({
        articleId: article.id,
        model,
        railwayUrl,
        prompt: userPrompt,
        systemPrompt,
        maxTokens: Math.min(4800, 1400 + desiredSections * 320),
        temperature: 0.1,
        stepNumber: 3,
        bypassCache: manual,
        jsonMode: true,
        contextQuery,
        onAccepted: () => setAccepted(true),
      });
      aiResponses.push(res);
      let lastResponse = res;
      const parsed = parseAIJson(res.content);
      const normalized = normalizeSections(parsed, bundle, trustedCoreIdeaEvidence);
      let sections = normalized.sections;
      let generatedAt = res.servedAt ?? res.generatedAt ?? new Date().toISOString();
      if (sections.length < minimumSections) {
        evidenceCorrectionCalls += 1;
        modelCalls += 1;
        const missingCount = desiredSections - sections.length;
        const corrected = await callAI({
          articleId: article.id,
          model,
          railwayUrl,
          prompt: [
            userPrompt,
            "",
            `CHỈ BỔ SUNG ${missingCount} SECTION CÒN THIẾU; không tạo lại section đã hợp lệ.`,
            `Heading đã hợp lệ, không được lặp: ${sections.map(section => JSON.stringify(section.heading)).join(", ") || "(chưa có)"}.`,
            `Heading bị loại do evidence không hợp lệ: ${normalized.rejectedHeadings.map(heading => JSON.stringify(heading)).join(", ") || "(không xác định)"}.`,
            "Nếu KB hoặc Content Plan có nguồn, mỗi section mới cần ít nhất 1 evidenceRef tới quote từ nguồn đó. Nếu Skills có nguồn, cần thêm evidenceRef tới quote Skills. Bỏ qua nhóm trống.",
            "Chỉ trả về JSON object { evidenceRegistry, sections } chứa các section bổ sung.",
          ].join("\n"),
          systemPrompt,
          maxTokens: Math.min(4000, 1200 + missingCount * 400),
          temperature: 0.1,
          stepNumber: 3,
          bypassCache: true,
          jsonMode: true,
          contextQuery,
        });
        aiResponses.push(corrected);
        lastResponse = corrected;
        const correctedNormalized = normalizeSections(parseAIJson(corrected.content), bundle, trustedCoreIdeaEvidence);
        const additions = correctedNormalized.sections;
        sections = [...sections, ...additions]
          .filter((section, index, all) => all.findIndex(candidate => candidate.heading.toLocaleLowerCase() === section.heading.toLocaleLowerCase()) === index)
          .slice(0, desiredSections);
        generatedAt = corrected.servedAt ?? corrected.generatedAt ?? new Date().toISOString();
      }
      if (!sections.length) throw new Error(
        `Không có section nào vượt qua kiểm chứng sau một lần bổ sung có mục tiêu. `
        + `Đã đọc ${normalized.rawSectionCount} section, ${normalized.registryCount} evidence registry và ${trustedCoreIdeaEvidence.length} evidence kế thừa từ Step 2.`,
      );
      const partialResult = sections.length < minimumSections;
      const trace: AIProcessTraceEvent[] = [
        { id: 'step3-handoff', stage: 'input', status: 'completed', title: '1. Nhận Content Plan và kết quả Bước 1', detail: 'Khóa nhóm nội dung, Core Idea, angle, audience, tone, word count và bộ keyword đã chọn để làm đầu vào outline.', facts: { contentType: contextBrief.contentType, topic: contextBrief.topic, primaryKeyword: contextBrief.primaryKeyword, secondaryKeywords: contextBrief.secondaryKeywords.length } },
        { id: 'step3-docs', stage: 'retrieval', status: 'completed', title: '2. Nạp nguồn của activity', detail: `Railway chọn các đoạn Knowledge Base, Content Plan hiện tại và Skills liên quan nhất theo topic, angle và keyword.\nPrompting rules theo phân vùng:\n${documentPromptRules || '(không có rule tùy chỉnh)'}`, facts: { kb: bundle.knowledgeBase.length, contentPlan: bundle.contentPlan.length, rules: bundle.rules.length } },
        { id: 'step3-generation', stage: 'generation', status: 'completed', title: '3. Model dựng outline', detail: `Model ${lastResponse.model} tạo heading, notes, rationale, keyword mapping và search intent; evidence dùng registry chung để không lặp quote.`, facts: { modelCalls, inputTokens: aiResponses.reduce((sum, response) => sum + (response.usage?.inputTokens ?? 0), 0), outputTokens: aiResponses.reduce((sum, response) => sum + (response.usage?.outputTokens ?? 0), 0), cacheHits: aiResponses.filter(response => response.cacheHit).length, durationMs: aiResponses.reduce((sum, response) => sum + (response.timing?.totalMs ?? 0), 0) } },
        { id: 'step3-validation', stage: 'validation', status: evidenceCorrectionCalls ? 'warning' : 'completed', title: '4. Kiểm tra cấu trúc và dẫn chứng', detail: 'Loại section thiếu quote nguyên văn ở bất kỳ phân vùng nào đang được cấp quyền. Nếu dưới ngưỡng tối thiểu, chỉ yêu cầu bổ sung phần còn thiếu.', facts: { sectionsAccepted: sections.length, evidenceVerified: sections.reduce((sum, section) => sum + (section.evidence?.length ?? 0), 0), jsonRepairCalls, evidenceCorrectionCalls } },
        { id: 'step3-persist', stage: 'persistence', status: 'completed', title: '5. Lưu outline và audit trail', detail: 'Lưu section, rationale, evidence, nguồn Rules và nhật ký hành động này cùng bài viết trong Supabase.' },
      ];
      const saved = await onUpdate({
        outline: sections,
        outlineSourceFingerprint: sourceFingerprint,
        outlineScannedAt: generatedAt,
        step3ProcessTrace: trace,
        workflowRuleSnapshots: { ...article.workflowRuleSnapshots, 3: compiledWorkflowRules.snapshot },
        editorialApproval: article.activityType === 'editorial-originality' ? { status: 'pending' } : null,
        draft: "",
        draftSourceFingerprint: null,
        draftScannedAt: null,
        currentStep: 3,
      });
      if (!saved) throw new Error('Outline Bước 2 chưa được lưu vào Supabase.');
      if (generationTiming.current) generationTiming.current.saved = true;
      if (partialResult) {
        setWarning(`Đã lưu ${sections.length}/${minimumSections} section tối thiểu vượt qua kiểm chứng. Bạn có thể chỉnh sửa thủ công hoặc nhấn “Tạo lại” để thử bổ sung.`);
      } else {
        notifyWorkspace('Đã tạo, kiểm tra và lưu outline.', 'success');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Không tạo được outline: ${message}`);
    } finally {
      generationInFlight.current = false;
      setGenerating(false);
      setAccepted(false);
    }
  };

  const handleSuggestKeywords = async () => {
    if (!contextBrief.angle && !contextBrief.topic) return;
    setSuggestingKeywords(true);
    try {
      const selectedIdea = article.coreIdeaSuggestions?.find(idea => idea.id === article.selectedCoreIdeaId);
      const existing = new Set([
        contextBrief.primaryKeyword,
        ...contextBrief.secondaryKeywords,
      ].map(keyword => keyword.toLocaleLowerCase()));
      const candidates = [
        ...(selectedIdea?.keywordAudit ?? []).filter(item => item.decision === "accepted").map(item => item.keyword),
        ...(article.seoResearch?.keywords ?? []).map(item => item.keyword),
      ].map(keyword => keyword.trim()).filter(Boolean)
        .filter(keyword => !existing.has(keyword.toLocaleLowerCase()))
        .filter((keyword, index, all) => all.findIndex(candidate => candidate.toLocaleLowerCase() === keyword.toLocaleLowerCase()) === index)
        .slice(0, 10);
      if (!candidates.length) throw new Error("Bước 1 chưa có keyword đã kiểm chứng chưa được sử dụng.");
      const saved = await onUpdate({ step3SuggestedKeywords: candidates });
      if (!saved) throw new Error('Keyword gợi ý chưa được lưu vào Supabase.');
    } catch (error) {
      setError(`Không gợi ý được keyword: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSuggestingKeywords(false);
    }
  };

  const updateSection = (id: string, patch: Partial<OutlineSection>) => {
    onUpdate({
      outline: outline.map(s => (s.id === id ? { ...s, ...patch } : s)),
      ...(article.activityType === 'editorial-originality' ? { editorialApproval: { status: 'pending' as const } } : {}),
    });
  };

  const removeSection = (id: string) => {
    onUpdate({ outline: outline.filter(s => s.id !== id), ...(article.activityType === 'editorial-originality' ? { editorialApproval: { status: 'pending' as const } } : {}) });
  };

  const moveSection = (id: string, dir: -1 | 1) => {
    const idx = outline.findIndex(s => s.id === id);
    if (idx + dir < 0 || idx + dir >= outline.length) return;
    const next = [...outline];
    [next[idx], next[idx + dir]] = [next[idx + dir], next[idx]];
    onUpdate({ outline: next, ...(article.activityType === 'editorial-originality' ? { editorialApproval: { status: 'pending' as const } } : {}) });
  };

  const addSection = (extraKeyword?: string, headingOverride?: string) => {
    const heading = (headingOverride ?? newSectionHeading).trim();
    if (!heading) return;
    const kws = extraKeyword ? [extraKeyword] : [];
    onUpdate({
      outline: [
        ...outline,
        { id: generateId(), heading, notes: "", level: newSectionLevel, keywords: kws, evidence: [] },
      ],
      ...(article.activityType === 'editorial-originality' ? { editorialApproval: { status: 'pending' as const } } : {}),
    });
    setNewSectionHeading("");
  };

  const addKeywordToSection = (sectionId: string, kw: string) => {
    const section = outline.find(s => s.id === sectionId);
    if (!section) return;
    const existing = section.keywords || [];
    if (existing.includes(kw)) return;
    updateSection(sectionId, { keywords: [...existing, kw] });
  };

  const h2Count = outline.filter(s => s.level === "h2").length;
  const h3Count = outline.filter(s => s.level === "h3").length;
  const isCurrentStep = (article.currentStep ?? 2) <= 3;
  const needsOutlineApproval = isCurrentStep && article.activityType === 'editorial-originality' && article.editorialApproval?.status !== 'approved';
  const canContinueToDraft = isCurrentStep && gateStepCompletion(article, 3).allowed && !needsOutlineApproval;
  const stepActionDisabled = generating || (needsOutlineApproval ? !outline.length : !canContinueToDraft && !prerequisite.allowed);

  return (
    <div className={`minimal-step flex flex-col gap-4 animate-fade-in-up ${embedded ? 'continuous-step' : 'h-full'}`}>
      <div className={`outline-workspace-shell minimal-step-shell flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white ${embedded ? '' : 'min-h-0 flex-1'}`}>
        <div className={`${embedded ? '' : 'flex-1 overflow-y-auto'} p-3.5 sm:p-5 md:p-6`}>
          <div className="mx-auto max-w-4xl space-y-5">

            {/* Header */}
            <div className="outline-toolbar flex flex-col justify-between gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-start sm:gap-4">
              <div className="min-w-0">
                <h2 className="mb-1 text-base font-semibold text-slate-800">{tr('Bước 2 — Dàn bài nháp', 'Step 2 — Draft Outline')}</h2>
                <p className="text-xs text-slate-500 leading-relaxed">
                  {tr('Đọc và chỉnh dàn ý theo đúng thứ tự bài viết. Mở chi tiết khi cần xem keyword, intent hoặc nguồn tham khảo.', 'Review and edit the outline in article order. Open details to inspect keywords, intent, or sources.')}
                </p>
              </div>
            </div>
            <StepUsage step={2} usage={article.aiUsageByStep?.[3]} />

            {generating && (
              <div className="space-y-2">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="border border-slate-200 rounded-xl p-4 space-y-2">
                    <div className="ai-loading h-4 w-2/3" />
                    <div className="ai-loading h-3 w-full" />
                  </div>
                ))}
              </div>
            )}

            {!generating && outline.length === 0 && (
              <div className="outline-empty-state rounded-xl border border-dashed border-slate-200 p-8 text-center">
                <p className="text-sm font-semibold text-slate-600">{tr('Chưa có outline', 'No outline yet')}</p>
                <p className="text-xs text-slate-400 mt-1">{tr('Nhấn “Tạo outline” để dựng dàn bài từ dữ liệu Bước 1–2', 'Click “Generate outline” to build it from Step 1–2 data')}</p>
              </div>
            )}

            {/* Outline */}
            {!generating && outline.length > 0 && (
              <div className="space-y-2">
                <div className="outline-summary flex items-center justify-between px-1 text-[11px] text-slate-500">
                  <span>
                    <span className="font-mono text-slate-700 font-bold">{outline.length}</span> section — {h2Count} H2 · {h3Count} H3
                  </span>
                </div>

                <div className="space-y-2.5">
                  {outline.map((section, index) => (
                    <SectionRow
                      key={section.id}
                      index={index}
                      isFirst={index === 0}
                      isLast={index === outline.length - 1}
                      section={section}
                      onChange={patch => updateSection(section.id, patch)}
                      onRemove={() => removeSection(section.id)}
                      onMove={dir => moveSection(section.id, dir)}
                      keywordSuggestions={suggestedKeywords}
                      onAddKeyword={kw => addKeywordToSection(section.id, kw)}
                      processTrace={article.step3ProcessTrace}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Add section */}
            <div className="outline-add-panel space-y-3 rounded-xl border border-slate-200 p-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="text-xs font-bold text-slate-700">{tr('Thêm section hoặc luận điểm nhánh', 'Add a section or supporting point')}</div>
                <button
                  onClick={handleSuggestKeywords}
                  disabled={suggestingKeywords || (!contextBrief.angle && !contextBrief.topic)}
                  className="outline-secondary-button rounded-md border border-slate-200 px-2.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-40"
                >
                  {suggestingKeywords ? tr('Đang lấy...', 'Loading...') : tr('Lấy keyword đã kiểm chứng', 'Use verified keywords')}
                </button>
              </div>

              <div className="grid grid-cols-[auto_1fr] sm:flex gap-2">
                <select
                  value={newSectionLevel}
                  onChange={e => setNewSectionLevel(e.target.value as "h2" | "h3")}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-slate-800"
                >
                  <option value="h2">H2</option>
                  <option value="h3">H3</option>
                </select>
                <input
                  value={newSectionHeading}
                  onChange={e => setNewSectionHeading(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addSection()}
                  placeholder={tr('Tiêu đề section mới...', 'New section heading...')}
                  className="min-w-0 flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 outline-none focus:ring-2 focus:ring-slate-800 placeholder:text-slate-400"
                />
                <button
                  onClick={() => addSection()}
                  disabled={!newSectionHeading.trim()}
                  className="outline-add-button col-span-2 flex items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 sm:col-span-1"
                >
                  <Plus className="app-icon" aria-hidden="true" />
                  <span>{tr('Thêm', 'Add')}</span>
                </button>
              </div>

              {suggestedKeywords.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                    Keyword theo angle — click để tạo section mới
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {suggestedKeywords.map(kw => (
                      <button
                        key={kw}
                        onClick={() => addSection(kw, kw)}
                        className="outline-keyword-chip rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors"
                      >
                        {kw}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className={`flex gap-2 shrink-0 ${embedded ? 'continuous-step-action justify-start' : 'justify-between'}`}>
        {!embedded && (
        <button onClick={onPrev} className="bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 font-semibold text-xs py-2.5 px-3 sm:px-5 rounded-2xl shadow-sm transition-all">
          {tr('Quay lại', 'Back')}
        </button>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={needsOutlineApproval
              ? () => void onUpdate({ editorialApproval: { status: 'approved', approvedAt: new Date().toISOString(), outlineFingerprint: article.outlineSourceFingerprint ?? undefined } })
              : canContinueToDraft ? onNext : (event) => void handleGenerate(Boolean(outline.length), event.timeStamp)}
            disabled={stepActionDisabled}
            className="workflow-endpoint-button"
          >
            {generating ? <><LoaderCircle className="app-icon animate-spin" aria-hidden="true" /><span>{accepted ? tr('Đã tiếp nhận · đang dựng...', 'Accepted · generating...') : tr('Đang dựng...', 'Generating...')}</span></>
              : needsOutlineApproval ? <><Check className="app-icon" aria-hidden="true" /><span>{tr('Phê duyệt outline', 'Approve outline')}</span></>
              : canContinueToDraft ? <><span>{tr('Tiếp tục — First Draft', 'Continue — First Draft')}</span><ArrowRight className="app-icon" aria-hidden="true" /></>
              : <><Sparkles className="app-icon" aria-hidden="true" /><span>{outline.length ? tr('Tạo lại outline', 'Regenerate outline') : tr('Tạo outline', 'Generate outline')}</span></>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

function SectionRow({
  index,
  isFirst,
  isLast,
  section,
  onChange,
  onRemove,
  onMove,
  keywordSuggestions,
  onAddKeyword,
  processTrace,
}: {
  index: number;
  isFirst: boolean;
  isLast: boolean;
  section: OutlineSection;
  onChange: (patch: Partial<OutlineSection>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  keywordSuggestions: string[];
  onAddKeyword: (kw: string) => void;
  processTrace?: AIProcessTraceEvent[];
}) {
  const { tr } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [headingDraft, setHeadingDraft] = useState(section.heading);
  const [notesDraft, setNotesDraft] = useState(section.notes ?? '');
  const [rationaleDraft, setRationaleDraft] = useState(section.rationale ?? '');
  const menuRef = useRef<HTMLDivElement>(null);
  const isH3 = section.level === "h3";

  useEffect(() => setHeadingDraft(section.heading), [section.heading]);
  useEffect(() => setNotesDraft(section.notes ?? ''), [section.notes]);
  useEffect(() => setRationaleDraft(section.rationale ?? ''), [section.rationale]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', closeMenu);
    return () => document.removeEventListener('mousedown', closeMenu);
  }, [menuOpen]);

  return (
    <div className={`outline-card group overflow-hidden rounded-xl border transition-colors ${
      isH3 ? "ml-2 sm:ml-6 border-slate-200 bg-slate-50/60" : "border-slate-200 bg-white"
    }`}>
      <div className="flex flex-wrap sm:flex-nowrap items-start gap-2 sm:gap-3 p-3 sm:p-4">
        <div className={`outline-section-index flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
          isH3 ? "is-h3 border border-slate-200" : "is-h2"
        }`}>
          {index + 1}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
              {section.level.toUpperCase()}
            </span>
            {section.searchIntent && (
              <span className="text-[9px] text-slate-400">· {SEARCH_INTENT_META[section.searchIntent].label}</span>
            )}
          </div>
          <textarea
            value={headingDraft}
            onChange={e => setHeadingDraft(e.target.value)}
            onBlur={() => headingDraft !== section.heading && onChange({ heading: headingDraft })}
            rows={isH3 ? 1 : 2}
            placeholder={tr('Tiêu đề section...', 'Section heading...')}
            className={`outline-heading-input w-full resize-none overflow-hidden bg-transparent text-slate-800 outline-none placeholder:text-slate-300 ${
              isH3 ? "text-sm font-semibold" : "text-sm font-bold"
            }`}
          />
          {section.notes && !expanded && (
            <p className="text-[11px] text-slate-500 leading-relaxed mt-1.5">{section.notes}</p>
          )}

          {!expanded && (
            <div className="flex flex-wrap items-center gap-1.5 mt-3">
              {section.keywords?.slice(0, 3).map((kw, i) => (
                <span key={i} className="outline-keyword-chip rounded-md border px-2 py-0.5 text-[10px]">
                  {kw}
                </span>
              ))}
              {(section.keywords?.length ?? 0) > 3 && (
                <span className="text-[10px] text-slate-400">+{section.keywords!.length - 3} keyword</span>
              )}
              {(section.evidence?.length ?? 0) > 0 && (
                <span className="text-[10px] text-slate-400 ml-1">· {section.evidence!.length} nguồn</span>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded(value => !value)}
            className={`outline-details-button flex h-8 w-8 items-center justify-center rounded-lg border ${expanded ? 'is-active' : ''}`}
            title={expanded ? tr('Thu gọn chi tiết', 'Collapse details') : tr('Mở chi tiết', 'Open details')}
            aria-label={expanded ? tr('Thu gọn chi tiết', 'Collapse details') : tr('Mở chi tiết', 'Open details')}
            aria-expanded={expanded}
          >
            <Eye className="app-icon" aria-hidden="true" />
          </button>
        <div ref={menuRef} className="outline-action-menu relative">
          <button
            type="button"
            onClick={() => setMenuOpen(open => !open)}
            className="outline-menu-trigger flex h-8 w-8 items-center justify-center rounded-lg border"
            aria-label={tr('Mở thao tác section', 'Open section actions')}
            aria-expanded={menuOpen}
          >
            <Ellipsis className="app-icon" aria-hidden="true" />
          </button>
          {menuOpen && (
            <div className="outline-menu-popover absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-lg border p-1 shadow-lg" role="menu">
              <button type="button" role="menuitem" onClick={() => { setShowAudit(true); setMenuOpen(false); }}><Eye className="app-icon" aria-hidden="true" /><span>{tr('Xem AI log', 'View AI log')}</span></button>
              <button type="button" role="menuitem" disabled={isFirst} onClick={() => { onMove(-1); setMenuOpen(false); }}><ChevronUp className="app-icon" aria-hidden="true" /><span>{tr('Di chuyển lên', 'Move up')}</span></button>
              <button type="button" role="menuitem" disabled={isLast} onClick={() => { onMove(1); setMenuOpen(false); }}><ChevronDown className="app-icon" aria-hidden="true" /><span>{tr('Di chuyển xuống', 'Move down')}</span></button>
              <div className="outline-menu-divider my-1 border-t" />
              <button type="button" role="menuitem" className="is-danger" onClick={() => { onRemove(); setMenuOpen(false); }}><Trash2 className="app-icon" aria-hidden="true" /><span>{tr('Xóa section', 'Delete section')}</span></button>
            </div>
          )}
        </div>
        </div>
      </div>

      {/* Expanded editor */}
      {expanded && (
        <div className="outline-expanded space-y-4 border-t px-3 py-3 sm:px-4 sm:py-4">
          <div className="outline-field">
            <label>Notes</label>
            <textarea
              value={notesDraft}
              onChange={e => setNotesDraft(e.target.value)}
              onBlur={() => notesDraft !== (section.notes ?? '') && onChange({ notes: notesDraft })}
              rows={2}
              placeholder={tr('Nội dung sẽ trình bày trong section...', 'Content to cover in this section...')}
              className="outline-editor-control mt-1 w-full resize-none rounded-lg border px-2.5 py-2 text-xs outline-none"
            />
          </div>
          <div className="outline-field">
            <label>{tr('Lý do & điểm cần đánh giá', 'Rationale & review points')}</label>
            <textarea value={rationaleDraft} onChange={e => setRationaleDraft(e.target.value)} onBlur={() => rationaleDraft !== (section.rationale ?? '') && onChange({ rationale: rationaleDraft })} rows={3} placeholder={tr('Vì sao section này cần thiết, vị trí và dẫn chứng hỗ trợ...', 'Why this section, its position, and supporting evidence...')} className="outline-editor-control mt-1 w-full resize-y rounded-lg border px-2.5 py-2 text-xs outline-none" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Search Intent</label>
              <select
                value={section.searchIntent || ""}
                onChange={e => onChange({ searchIntent: (e.target.value || undefined) as SearchIntent | undefined })}
                className="outline-editor-control mt-1 w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
              >
                <option value="">— {tr('chưa xác định', 'not set')} —</option>
                {Object.entries(SEARCH_INTENT_META).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Level</label>
              <select
                value={section.level}
                onChange={e => onChange({ level: e.target.value as "h2" | "h3" })}
                className="outline-editor-control mt-1 w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
              >
                <option value="h2">H2</option>
                <option value="h3">H3</option>
              </select>
            </div>
          </div>
          {(section.keywords?.length ?? 0) > 0 && (
            <div>
              <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Keywords</label>
              <div className="flex flex-wrap gap-1 mt-1">
                {section.keywords?.map((kw, i) => (
                  <span key={i} className="text-[10px] text-slate-600 bg-white border border-slate-200 rounded-md px-2 py-0.5">
                    {kw}
                  </span>
                ))}
              </div>
            </div>
          )}
          {(section.evidence?.length ?? 0) > 0 && (
            <div>
              <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">{tr('Toàn bộ dẫn chứng đã kiểm chứng', 'All verified evidence')}</label>
              <div className="space-y-2 mt-1">
                {section.evidence?.map((e, i) => (
                  <div key={i} className="outline-evidence-card rounded-lg border px-3 py-2 text-[10px]">
                    <div className="font-bold mb-1">{e.role?.toUpperCase()} · {e.source}</div>
                    {e.quote && <blockquote className="border-l-2 border-current/30 pl-2 leading-relaxed whitespace-pre-wrap">“{e.quote}”</blockquote>}
                    {e.note && <p className="mt-1.5"><b>{tr('Lý do sử dụng:', 'Why it matters:')}</b> {e.note}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {(section.ruleRefs?.length ?? 0) > 0 && <div><label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Rules áp dụng</label><div className="flex flex-wrap gap-1 mt-1">{section.ruleRefs?.map(rule => <span key={rule} className="outline-rule-chip text-[10px] rounded-md border px-2 py-0.5">{rule}</span>)}</div></div>}
          {keywordSuggestions.length > 0 && (
            <div>
              <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                Thêm keyword từ gợi ý
              </label>
              <div className="flex flex-wrap gap-1 mt-1">
                {keywordSuggestions
                  .filter(k => !section.keywords?.includes(k))
                  .map(k => (
                    <button
                      key={k}
                      onClick={() => onAddKeyword(k)}
                      className="text-[10px] font-medium bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 rounded px-1.5 py-0.5 transition-all"
                    >
                      {k}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
      {showAudit && <ProcessTraceModal title={section.heading} events={processTrace} onClose={() => setShowAudit(false)}><div className="outline-audit-content space-y-4"><div className="outline-audit-summary rounded-lg border p-4"><div className="outline-audit-label">{tr('Lý do tạo section', 'Section rationale')}</div><p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed">{section.rationale || tr('Chưa có rationale trong kết quả đã lưu.', 'No rationale in the saved result.')}</p></div><div><div className="outline-audit-label mb-2">{tr('Dẫn chứng của section', 'Section evidence')}</div><div className="space-y-2">{section.evidence?.map((e, i) => <div key={`${e.source}-${i}`} className="outline-audit-evidence rounded-lg border p-3 text-[10px]"><b>{e.role?.toUpperCase()} · {e.source}</b>{e.quote && <blockquote className="mt-1.5 whitespace-pre-wrap border-l-2 pl-2">“{e.quote}”</blockquote>}{e.note && <p className="mt-1.5"><b>{tr('Lý do sử dụng:', 'Why it matters:')}</b> {e.note}</p>}</div>)}</div></div></div></ProcessTraceModal>}
    </div>
  );
}

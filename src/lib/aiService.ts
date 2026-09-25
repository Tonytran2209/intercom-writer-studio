import type { AICallUsage, AIModel, SeoResearchResult } from '../types';
import { isShellMode } from './appMode';

export interface AIRequest {
  model: AIModel;
  prompt: string;
  systemPrompt?: string;
  railwayUrl?: string;
  maxTokens?: number;
  temperature?: number;
  stepNumber: 1 | 2 | 3 | 4;
  splitByWave?: boolean;
  bypassCache?: boolean;
  requestPurpose?: 'generation' | 'recheck';
  jsonMode?: boolean;
  jsonSchema?: Record<string, unknown>;
  contextQuery?: string;
  skipDocumentContext?: boolean;
  articleId: string;
}

export interface AIResponse {
  content: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  generatedAt?: string;
  servedAt?: string;
  cacheHit?: boolean;
  timing?: { contextMs: number; providerMs: number; totalMs: number };
  context?: { stepNumber: number; kb: string[]; action: string[]; rules: string[]; totalChars: number; waves?: number };
  budget?: { used: number; limit: number };
  costUsd?: number | null;
}

interface AIErrorPayload {
  error?: string;
  code?: 'AI_CREDITS_EXHAUSTED' | 'AI_PROVIDER_QUOTA_EXCEEDED' | 'AI_PROVIDER_NOT_CONFIGURED' | 'ARTICLE_DAILY_AI_LIMIT' | 'AI_PROVIDER_ERROR';
  provider?: string;
  modelId?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  mistral: 'Mistral',
  groq: 'Groq',
  together: 'Together AI',
  deepseek: 'DeepSeek',
};

function formatAIError(payload: AIErrorPayload, fallbackProvider: string, fallbackModel: string): string {
  const provider = PROVIDER_LABELS[payload.provider ?? fallbackProvider] ?? payload.provider ?? fallbackProvider;
  const model = payload.modelId ?? fallbackModel;
  if (payload.code === 'AI_CREDITS_EXHAUSTED') {
    return `⚠️ ${provider} API đã hết credits. Model ${model} không thể tiếp tục. Vui lòng nạp credits trong tài khoản ${provider} hoặc chọn model thuộc provider khác trong Model & Rules DB.`;
  }
  if (payload.code === 'AI_PROVIDER_QUOTA_EXCEEDED') {
    return `⚠️ ${provider} đang vượt quota hoặc rate limit cho model ${model}. Vui lòng thử lại sau hoặc chọn provider khác.`;
  }
  if (payload.code === 'AI_PROVIDER_NOT_CONFIGURED') {
    return `⚠️ ${provider} chưa được cấu hình API key cho model ${model}. Vui lòng kiểm tra Railway Variables hoặc chọn provider khác.`;
  }
  return payload.error || `Lỗi AI provider ${provider} với model ${model}.`;
}

const DEMO_RESPONSES: Record<string, string> = {
  outline: `## Proposed outline

**I. Introduction**
- Market context and purpose of the comparison
- Primary evaluation criteria

**II. Product overview**
- Specifications and notable features
- Target users

**III. Detailed analysis**
- Performance and processing speed
- Quality, durability, and design
- Value relative to cost

**IV. Pros and cons**
- Clear comparison table
- Recommended use cases by audience

**V. Conclusion and recommendation**
- Advice for specific needs
- Overall score out of 10`,

  draft: `# Article title

Open with a clear, engaging introduction that explains why the subject matters to the reader.

## Section 1: Overview

Provide the background readers need to understand the subject.

## Section 2: Detailed analysis

Present the main arguments in a logical order with specific supporting evidence.

## Conclusion

Summarize the key points and provide a clear recommendation or call to action.`,

  angle: `**Proposed angle:** *"What most users overlook when making this decision"*

Focus on an underexplored factor that has a meaningful impact on the reader's decision.

**Additional keyword ideas:** detailed review, complete comparison, practical experience, objective assessment 2026`,
};

function getDemoKey(prompt: string): string {
  const p = prompt.toLowerCase();
  if (p.includes('dàn bài') || p.includes('outline')) return 'outline';
  if (p.includes('bài viết') || p.includes('draft') || p.includes('viết')) return 'draft';
  return 'angle';
}

export async function callAI(req: AIRequest): Promise<AIResponse> {
  const { model, prompt, systemPrompt, maxTokens, temperature, stepNumber, splitByWave, bypassCache, requestPurpose, jsonMode, jsonSchema, contextQuery, skipDocumentContext, articleId } = req;

  if (isShellMode) {
    const content = DEMO_RESPONSES[getDemoKey(prompt)];
    return { content, model: `${model.name} (simulated)`, generatedAt: new Date().toISOString(), cacheHit: false };
  }

  // Resolve railway URL — prop → localStorage → hardcoded production URL
  const railwayUrl = req.railwayUrl
    || localStorage.getItem('writer:railwayUrl')
    || 'https://rebuildwriterstudiotool-production.up.railway.app';

  if (railwayUrl) {
    try {
      const res = await fetch(`${railwayUrl.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: model.id,
          provider: model.provider,
          prompt,
          systemPrompt,
          stepNumber,
          maxTokens,
          temperature,
          splitByWave,
          bypassCache,
          requestPurpose,
          jsonMode,
          jsonSchema,
          contextQuery,
          skipDocumentContext,
          pricing: model.pricing,
          articleId,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as AIErrorPayload;
        throw new Error(formatAIError(err, model.provider, model.id));
      }

      const response = await res.json() as AIResponse;
      const billedInput = response.cacheHit ? 0 : response.usage?.inputTokens ?? 0;
      const billedOutput = response.cacheHit ? 0 : response.usage?.outputTokens ?? 0;
      const billedCachedInput = response.cacheHit ? 0 : response.usage?.cachedInputTokens ?? 0;
      const usage: AICallUsage = {
        id: `usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        articleId,
        step: stepNumber,
        provider: model.provider,
        model: response.model || model.id,
        inputTokens: billedInput,
        cachedInputTokens: billedCachedInput,
        outputTokens: billedOutput,
        totalTokens: billedInput + billedOutput,
        costUsd: response.cacheHit ? 0 : response.costUsd ?? null,
        cacheHit: Boolean(response.cacheHit),
        calledAt: new Date().toISOString(),
      };
      window.dispatchEvent(new CustomEvent<AICallUsage>('writer:ai-usage', { detail: usage }));
      return response;
    } catch (err: any) {
      // Preserve actionable provider/billing messages instead of hiding them
      // behind a generic Railway prefix in every workflow step.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(message.startsWith('⚠️') ? message : `Railway: ${message}`);
    }
  }

  // Demo mode — simulate delay + return placeholder
  await new Promise(r => setTimeout(r, 1200 + Math.random() * 600));
  return {
    content: DEMO_RESPONSES[getDemoKey(prompt)],
    model: model.id,
    usage: { inputTokens: 450, outputTokens: 280 },
  };
}

export async function researchSeoKeywords(seeds: string[], articleId: string, railwayUrl?: string, keywordCount = 10): Promise<SeoResearchResult> {
  if (isShellMode) return {
    keywords: seeds.slice(0, keywordCount).map((keyword, index) => ({ keyword, searchVolume: null, keywordDifficulty: null, competition: null, cpc: null, intent: index % 2 ? 'informational' : 'commercial', source: 'openai_web_search' as const, updatedAt: null })),
    seedKeywords: seeds, location: 'simulated', language: 'en', researchedAt: new Date().toISOString(),
  };
  const baseUrl = railwayUrl || localStorage.getItem('writer:railwayUrl') || 'https://rebuildwriterstudiotool-production.up.railway.app';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/seo/research`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seeds, articleId, keywordCount }),
  });
  const payload = await response.json().catch(() => ({ error: response.statusText })) as SeoResearchResult & AIErrorPayload;
  if (!response.ok) throw new Error(formatAIError(payload, 'openai', payload.modelId ?? 'gpt-5.4-mini'));
  return payload;
}

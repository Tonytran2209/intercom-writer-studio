import type { AIModel, AppConfig } from '../types';

export const DEFAULT_MODELS: AIModel[] = [
  // Anthropic
  { id: 'claude-fable-5', name: 'Claude Fable 5', provider: 'anthropic', description: 'Năng lực cao nhất cho tác vụ dài, tổng hợp sâu và agent phức tạp.', enabled: false, contextWindow: '1M', speed: 'slow' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'anthropic', description: 'Model cao cấp cho phân tích, chiến lược và nội dung chuyên sâu.', enabled: false, contextWindow: '1M', speed: 'medium' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic', description: 'Cân bằng tốt giữa chất lượng, tốc độ và chi phí.', enabled: false, contextWindow: '1M', speed: 'fast' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', description: 'Phản hồi nhanh cho tác vụ sản lượng lớn.', enabled: false, contextWindow: '200K', speed: 'fast' },
  // OpenAI
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai', description: 'Flagship cho công việc chuyên môn và suy luận phức tạp.', enabled: false, contextWindow: '1.05M', speed: 'slow', pricing: { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30 } },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'openai', description: 'Cân bằng năng lực và chi phí cho workflow sản xuất.', enabled: false, contextWindow: '1.05M', speed: 'medium', pricing: { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 } },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai', description: 'Tối ưu chi phí cho tác vụ thường xuyên và sản lượng lớn.', enabled: false, contextWindow: '1.05M', speed: 'fast', pricing: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 6 } },
  { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai', description: 'Tier 1 · Chất lượng cao cho nội dung chuyên môn và suy luận phức tạp.', enabled: false, contextWindow: '1.05M', speed: 'slow', pricing: { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30, longContextThresholdTokens: 272000, longContextInputMultiplier: 2, longContextOutputMultiplier: 1.5 } },
  { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai', description: 'Tier 1 · Cân bằng chất lượng và chi phí cho bài viết chuyên sâu.', enabled: false, contextWindow: '1.05M', speed: 'medium', pricing: { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15, longContextThresholdTokens: 272000, longContextInputMultiplier: 2, longContextOutputMultiplier: 1.5 } },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', provider: 'openai', description: 'Tier 1 · Nhanh, hiệu quả cho workflow nội dung sản lượng lớn.', enabled: false, contextWindow: '400K', speed: 'fast', pricing: { inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 } },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 nano', provider: 'openai', description: 'Tier 1 · Tiết kiệm cho phân loại, trích xuất và tác vụ đơn giản.', enabled: false, contextWindow: '400K', speed: 'fast', pricing: { inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.25 } },
  // Google
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', provider: 'google', description: 'Model stable mới nhất, mạnh cho tài liệu dài và tác vụ đa bước.', enabled: false, contextWindow: '1M', speed: 'fast' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', provider: 'google', description: 'Model stable nhanh và tiết kiệm cho xử lý khối lượng lớn.', enabled: false, contextWindow: '1M', speed: 'fast' },
  // Mistral
  { id: 'mistral-medium-3-5', name: 'Mistral Medium 3.5', provider: 'mistral', description: 'Frontier multimodal cho agent, coding và tổng hợp chuyên sâu.', enabled: false, contextWindow: '256K', speed: 'medium', pricing: { inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5 } },
  { id: 'mistral-small-2603', name: 'Mistral Small 4', provider: 'mistral', description: 'Model hybrid nhanh, hiệu quả cho instruct và reasoning.', enabled: false, contextWindow: '256K', speed: 'fast', pricing: { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 } },
  // DeepSeek official API
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', description: 'Model V4 mạnh nhất cho suy luận sâu, nội dung dài và tác vụ agent phức tạp.', enabled: false, contextWindow: '1M', speed: 'medium', pricing: { inputUsdPerMillion: 1.74, cachedInputUsdPerMillion: 0.145, outputUsdPerMillion: 3.48 } },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', description: 'Model V4 mới nhất, nhanh và tiết kiệm cho workflow nội dung sản lượng lớn.', enabled: false, contextWindow: '1M', speed: 'fast', pricing: { inputUsdPerMillion: 0.14, cachedInputUsdPerMillion: 0.028, outputUsdPerMillion: 0.28 } },
  // Together AI
  { id: 'moonshotai/Kimi-K3', name: 'Kimi K3', provider: 'together', description: 'Model context dài chất lượng cao qua Together Serverless.', enabled: false, contextWindow: '1M', speed: 'medium' },
  { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', provider: 'together', description: 'Model open-weight ổn định, hỗ trợ structured output.', enabled: false, contextWindow: '128K', speed: 'fast' },
  // Groq
  { id: 'groq-gpt-oss-120b', name: 'GPT-OSS 120B (Groq)', provider: 'groq', description: 'Model open-weight reasoning cao với inference rất nhanh.', enabled: false, contextWindow: '131K', speed: 'fast', pricing: { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.60 } },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', provider: 'groq', description: 'Model production đa năng cho tạo và tổng hợp nội dung.', enabled: false, contextWindow: '131K', speed: 'fast', pricing: { inputUsdPerMillion: 0.59, outputUsdPerMillion: 0.79 } },
  { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant', provider: 'groq', description: 'Độ trễ thấp cho tác vụ đơn giản và khối lượng lớn.', enabled: false, contextWindow: '131K', speed: 'fast', pricing: { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.08 } },
];

export function mergeWithLatestModelCatalog(config: AppConfig): AppConfig {
  const savedModels = new Map(config.models.map(model => [`${model.provider}:${model.id}`, model]));
  const modelIds = new Set(DEFAULT_MODELS.map(model => model.id));
  const stepConfigs = Object.fromEntries(
    Object.entries(config.stepConfigs).map(([step, stepConfig]) => [
      step,
      {
        ...stepConfig,
        modelId: modelIds.has(stepConfig.modelId) ? stepConfig.modelId : '',
        fileAccess: {
          kb: stepConfig.fileAccess?.kb ?? [],
          rules: stepConfig.fileAccess?.rules ?? [],
        },
      },
    ]),
  );

  return {
    ...config,
    stepConfigs,
    models: DEFAULT_MODELS.map(model => ({
      ...model,
      enabled: savedModels.get(`${model.provider}:${model.id}`)?.enabled ?? model.enabled,
      pricing: savedModels.get(`${model.provider}:${model.id}`)?.pricing ?? model.pricing,
    })),
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  railwayUrl: '',
  stepConfigs: {
    1: { modelId: '', fileAccess: { kb: [], rules: [] } },
    2: { modelId: '', fileAccess: { kb: [], rules: [] } },
    3: { modelId: '', fileAccess: { kb: [], rules: [] } },
    4: { modelId: '', fileAccess: { kb: [], rules: [] }, maxDraftWords: 1500 },
  },
  models: DEFAULT_MODELS,
};

export const STEP_LABELS: Record<number, string> = {
  1: 'Content Type',
  2: 'Article Spec & Direction',
  3: 'Draft Outline',
  4: 'First Draft & Audit',
};

export const PROVIDER_LABELS: Record<string, { label: string; color: string; icon: string }> = {
  anthropic: { label: 'Anthropic', color: 'text-violet-600', icon: '◆' },
  openai:    { label: 'OpenAI',    color: 'text-emerald-600', icon: '⬡' },
  google:    { label: 'Google',    color: 'text-blue-600',    icon: '◉' },
  mistral:   { label: 'Mistral AI',color: 'text-orange-600',  icon: '▲' },
  together:  { label: 'Together AI',color: 'text-pink-600',   icon: '◈' },
  groq:      { label: 'Groq',      color: 'text-amber-600',   icon: '⚡' },
  deepseek:  { label: 'DeepSeek',  color: 'text-cyan-700',    icon: '✦' },
};

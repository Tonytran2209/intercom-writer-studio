import { useState } from 'react';
import type { AppConfig, AIModel, AIProvider } from '../../types';
import { PROVIDER_LABELS } from '../../lib/defaultData';
import { useI18n } from '../../lib/i18n';

interface Props {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
}

const SPEED_LABELS = { fast: 'Nhanh', medium: 'Trung bình', slow: 'Chậm' };
const SPEED_COLORS = { fast: 'text-emerald-600', medium: 'text-amber-600', slow: 'text-slate-500' };

const API_KEY_NAMES: Record<AIProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  together: 'TOGETHER_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export default function TabModels({ config, onChange }: Props) {
  const { language, tr } = useI18n();
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [showKeyFor, setShowKeyFor] = useState<string | null>(null);

  const toggleModel = (modelId: string) => {
    onChange({
      ...config,
      models: config.models.map(m => m.id === modelId ? { ...m, enabled: !m.enabled } : m),
    });
  };

  const updatePricing = (modelId: string, field: 'inputUsdPerMillion' | 'cachedInputUsdPerMillion' | 'outputUsdPerMillion', value: string) => {
    const numberValue = Number(value);
    onChange({
      ...config,
      models: config.models.map(model => model.id === modelId ? {
        ...model,
        pricing: {
          ...model.pricing,
          inputUsdPerMillion: model.pricing?.inputUsdPerMillion ?? 0,
          outputUsdPerMillion: model.pricing?.outputUsdPerMillion ?? 0,
          [field]: Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0,
        },
      } : model),
    });
  };

  // Group by provider
  const byProvider: Record<string, AIModel[]> = {};
  config.models.forEach(m => {
    if (!byProvider[m.provider]) byProvider[m.provider] = [];
    byProvider[m.provider].push(m);
  });

  return (
    <div className="space-y-7">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="ui-type-title font-medium text-slate-900">{tr('Models', 'Models')}</h3>
          <p className="mt-1 ui-type-meta leading-5 text-slate-400">{tr('Bật model để sử dụng trong workflow và quản lý giá token.', 'Enable models for workflow use and manage token pricing.')}</p>
        </div>
      </div>

      {Object.entries(byProvider).map(([provider, models]) => {
        const provMeta = PROVIDER_LABELS[provider];
        const anyEnabled = models.some(m => m.enabled);
        return (
          <section key={provider} className="model-provider-group overflow-hidden rounded-xl border border-slate-200 bg-white">
            {/* Provider header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="ui-type-body font-medium text-slate-900">{provMeta?.label || provider}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-md px-2 py-1 ui-type-meta font-medium ${anyEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                  {anyEnabled ? 'Active' : 'Inactive'}
                </span>
                <button
                  onClick={() => setShowKeyFor(showKeyFor === provider ? null : provider)}
                  className="settings-secondary-action rounded-lg border border-slate-200 px-2.5 py-1.5 ui-type-body font-medium text-slate-600 transition-colors"
                >
                  {showKeyFor === provider ? tr('Ẩn', 'Hide') : 'API Key'}
                </button>
              </div>
            </div>

            {/* API key input */}
            {showKeyFor === provider && (
              <div className="space-y-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
                <label className="ui-type-meta font-medium text-slate-600">
                  {API_KEY_NAMES[provider as AIProvider]} (lưu trong Railway env)
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="password"
                    value={apiKeys[provider] || ''}
                    onChange={e => setApiKeys(k => ({ ...k, [provider]: e.target.value }))}
                    placeholder="sk-••••••••••••••••••••••••"
                    className="h-10 flex-1 rounded-lg border border-slate-200 bg-white px-3 font-mono ui-type-body text-slate-700 outline-none"
                  />
                  <button className="rounded-lg bg-slate-900 px-3 py-2 ui-type-body font-medium text-white transition-colors hover:bg-slate-800">
                    {tr('Lưu vào Railway', 'Save to Railway')}
                  </button>
                </div>
                <p className="ui-type-meta text-slate-400">{tr('API Key được lưu trong biến môi trường Railway.', 'API keys are stored in Railway environment variables.')}</p>
              </div>
            )}

            {/* Models grid */}
            <div className="divide-y divide-slate-200">
              {models.map(model => (
                <div key={model.id} className="model-setting-row flex items-start gap-4 px-4 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <h4 className="truncate ui-type-title font-medium text-slate-900">{model.name}</h4>
                      {model.enabled && (
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                      )}
                    </div>
                    <p className="ui-type-meta leading-5 text-slate-400">{language === 'vi' ? model.description : `${model.name} for step-based content workflows.`}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono ui-type-meta text-slate-500">{model.contextWindow}</span>
                      <span className={`ui-type-meta font-medium ${SPEED_COLORS[model.speed]}`}>{language === 'vi' ? SPEED_LABELS[model.speed] : ({ fast: 'Fast', medium: 'Medium', slow: 'Slow' } as const)[model.speed]}</span>
                    </div>
                    <div className="mt-3 grid max-w-lg grid-cols-3 gap-2">
                      <label className="ui-type-meta text-slate-500">
                        Input $/1M
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={model.pricing?.inputUsdPerMillion ?? ''}
                          onChange={event => updatePricing(model.id, 'inputUsdPerMillion', event.target.value)}
                          placeholder="N/A"
                          className="mt-1 h-8 w-full rounded-md border border-slate-200 bg-white px-2 font-mono ui-type-body outline-none"
                        />
                      </label>
                      <label className="ui-type-meta text-slate-500">
                        Cache $/1M
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={model.pricing?.cachedInputUsdPerMillion ?? ''}
                          onChange={event => updatePricing(model.id, 'cachedInputUsdPerMillion', event.target.value)}
                          placeholder="= input"
                          className="mt-1 h-8 w-full rounded-md border border-slate-200 bg-white px-2 font-mono ui-type-body outline-none"
                        />
                      </label>
                      <label className="ui-type-meta text-slate-500">
                        Output $/1M
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={model.pricing?.outputUsdPerMillion ?? ''}
                          onChange={event => updatePricing(model.id, 'outputUsdPerMillion', event.target.value)}
                          placeholder="N/A"
                          className="mt-1 h-8 w-full rounded-md border border-slate-200 bg-white px-2 font-mono ui-type-body outline-none"
                        />
                      </label>
                    </div>
                  </div>
                  <label className="relative mt-0.5 inline-flex shrink-0 cursor-pointer items-center">
                    <input
                      type="checkbox"
                      checked={model.enabled}
                      onChange={() => toggleModel(model.id)}
                      className="settings-model-toggle-input sr-only"
                    />
                    <div className="settings-model-toggle" />
                  </label>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

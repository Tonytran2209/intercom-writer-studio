import { useMemo, useState } from 'react';
import { ArrowLeft, Bot, Cpu, Library, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AppConfig, Article, DocumentFile, ActiveTab } from '../../types';
import TabStepSetup from './TabStepSetup';
import TabModels from './TabModels';
import TabKnowledgeBase from './TabKnowledgeBase';
import { sanitizeConfigFileAccess } from '../../lib/documentStatus';
import { useI18n } from '../../lib/i18n';

interface Props {
  config: AppConfig;
  files: DocumentFile[];
  articles: Article[];
  onSave: (config: AppConfig, files: DocumentFile[]) => void;
  onClose: () => void;
}

const TABS: Array<{ id: ActiveTab; labelVi: string; labelEn: string; descriptionVi: string; descriptionEn: string; icon: LucideIcon }> = [
  { id: 'step-setup', labelVi: 'Workflow AI', labelEn: 'AI workflow', descriptionVi: 'Model theo bước, nguồn context và usage', descriptionEn: 'Step models, context sources, and usage', icon: Bot },
  { id: 'models', labelVi: 'AI Models', labelEn: 'AI models', descriptionVi: 'Provider, model và chi phí token', descriptionEn: 'Providers, models, and token pricing', icon: Cpu },
  { id: 'knowledge-base', labelVi: 'EB Knowledge & Rules', labelEn: 'EB knowledge & rules', descriptionVi: 'Thư viện EB, repetition log và quy tắc workflow', descriptionEn: 'EB library, repetition log, and workflow rules', icon: Library },
];

export default function ConfigModal({ config, files, articles, onSave, onClose }: Props) {
  const { language, tr } = useI18n();
  const [activeTab, setActiveTab] = useState<ActiveTab>('knowledge-base');
  const [query, setQuery] = useState('');
  const [localConfig, setLocalConfig] = useState<AppConfig>({ ...config });
  const [localFiles, setLocalFiles] = useState<DocumentFile[]>([...files]);

  const active = TABS.find(tab => tab.id === activeTab) ?? TABS[0];
  const visibleTabs = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return TABS;
    return TABS.filter(tab => [tab.labelVi, tab.labelEn, tab.descriptionVi, tab.descriptionEn].some(value => value.toLocaleLowerCase().includes(normalized)));
  }, [query]);

  const handleSave = () => {
    const sanitized = sanitizeConfigFileAccess(localConfig, localFiles);
    setLocalConfig(sanitized);
    onSave(sanitized, localFiles);
    onClose();
  };
  const persistRuleConfig = async (nextConfig: AppConfig) => {
    const sanitized = sanitizeConfigFileAccess(nextConfig, localFiles);
    setLocalConfig(sanitized);
    await onSave(sanitized, localFiles);
  };

  return (
    <div className="minimal-settings fixed inset-0 z-50 bg-[#e9ecef] p-3">
      <div className="settings-shell grid h-full w-full grid-cols-1 overflow-hidden rounded-2xl border border-slate-200/80 bg-white md:grid-cols-[256px_minmax(0,1fr)]">
        <aside className="settings-sidebar flex min-h-0 flex-col border-b border-slate-200 bg-slate-50 md:border-b-0 md:border-r">
          <div className="p-3">
            <button onClick={onClose} className="settings-back-button inline-flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100">
              <ArrowLeft className="app-icon" aria-hidden="true" />
              {tr('Quay lại ứng dụng', 'Back to app')}
            </button>
            <label className="settings-search relative mt-2 block">
              <Search className="app-icon pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder={tr('Tìm cài đặt...', 'Search settings...')} className="h-8 w-full rounded-lg border border-slate-200 bg-white pl-8 pr-3 text-xs text-slate-700 outline-none" />
            </label>
          </div>

          <nav className="settings-nav min-h-0 space-y-0.5 overflow-y-auto px-2 pb-3 pt-2" aria-label={tr('Danh mục cài đặt', 'Settings categories')}>
            {visibleTabs.map(tab => {
              const Icon = tab.icon;
              return <div key={tab.id}>
                <button onClick={() => setActiveTab(tab.id)} className={`settings-nav-item flex h-8 w-full items-center gap-3 rounded-lg px-3 text-left text-xs transition-colors ${activeTab === tab.id ? 'is-active bg-slate-200 text-slate-900' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
                  <Icon className="h-4 w-4 shrink-0 stroke-[1.75]" aria-hidden="true" />
                  <span className="truncate">{language === 'vi' ? tab.labelVi : tab.labelEn}</span>
                </button>
              </div>;
            })}
            {!visibleTabs.length && <p className="px-2.5 py-4 text-xs leading-5 text-slate-400">{tr('Không tìm thấy mục cài đặt phù hợp.', 'No matching settings found.')}</p>}
          </nav>

          <div className="settings-connection mt-auto hidden border-t border-slate-200 px-4 py-3 text-xs text-slate-400 md:block">
            <span className={`mr-2 inline-block h-2 w-2 rounded-full ${localConfig.railwayUrl ? 'bg-emerald-500' : 'bg-slate-300'}`} />
            Railway {localConfig.railwayUrl ? tr('đã kết nối', 'connected') : tr('chưa cấu hình', 'not configured')}
          </div>
        </aside>

        <main className="settings-main flex min-h-0 min-w-0 flex-col bg-white">
          <header className="settings-page-header shrink-0 border-b border-slate-200/80 px-5 py-4 md:px-8">
            <div className="mx-auto max-w-[760px]">
              <h1 className="text-sm font-bold text-slate-900">{language === 'vi' ? active.labelVi : active.labelEn}</h1>
              <p className="mt-1 text-xs leading-5 text-slate-500">{language === 'vi' ? active.descriptionVi : active.descriptionEn}</p>
            </div>
          </header>

          <div className="settings-content min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-7">
            <div className="mx-auto max-w-[760px]">
              {activeTab === 'step-setup' && <TabStepSetup config={localConfig} files={localFiles} articles={articles} onChange={setLocalConfig} />}
              {activeTab === 'models' && <TabModels config={localConfig} onChange={setLocalConfig} />}
              {activeTab === 'knowledge-base' && <TabKnowledgeBase files={localFiles} onChange={setLocalFiles} railwayUrl={localConfig.railwayUrl} config={localConfig} onConfigChange={setLocalConfig} onConfigPersist={persistRuleConfig} />}
            </div>
          </div>

          <footer className="settings-footer flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 bg-white px-5 py-3 md:px-8">
            <button onClick={onClose} className="rounded-lg px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900">{tr('Huỷ', 'Cancel')}</button>
            <button onClick={handleSave} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-indigo-700">{tr('Lưu thay đổi', 'Save changes')}</button>
          </footer>
        </main>
      </div>
    </div>
  );
}

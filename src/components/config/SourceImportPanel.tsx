import { useState, useRef } from 'react';
import { ChevronDown, ClipboardPaste, Database, Download, FilePenLine, FolderUp, Link2, Plus, Plug, Sheet, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ActionDataSource, ActionSourceType, FileCategory, KnowledgeMetadata, ManualRow } from '../../types';
import { isImportSourceReady } from '../../lib/documentStatus';
import { uploadDocumentToRailway } from '../../lib/railwayUpload';
import { downloadDocumentFromRailway } from '../../lib/railwayDownload';
import { importSourceThroughRailway } from '../../lib/railwayImport';
import { useI18n } from '../../lib/i18n';

// ── helpers ──────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }

function csvPreview(text: string, maxRows = 4): string {
  return text.split('\n').slice(0, maxRows).join('\n');
}

function countRows(text: string) { return text.split('\n').filter(Boolean).length; }

function toCSV(columns: string[], rows: ManualRow[]): string {
  return [columns.join(','), ...rows.map(r => r.cells.join(','))].join('\n');
}

function extractSheetId(url: string): string | null {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m?.[1] ?? null;
}

// ── mode definitions ──────────────────────────────────────────────────────────

const MODES: { id: ActionSourceType; icon: LucideIcon; label: string; hint: string }[] = [
  { id: 'file', icon: FolderUp, label: 'File Upload', hint: 'CSV, XLSX, JSON, PDF' },
  { id: 'paste', icon: ClipboardPaste, label: 'Paste Data', hint: 'CSV, JSON, văn bản thuần' },
  { id: 'url', icon: Link2, label: 'URL / API', hint: 'REST API, RSS feed' },
  { id: 'gsheet', icon: Sheet, label: 'Google Sheets', hint: 'Link public spreadsheet' },
  { id: 'manual', icon: FilePenLine, label: 'Nhập thủ công', hint: 'Bảng dữ liệu tự tạo' },
  { id: 'supabase', icon: Database, label: 'Supabase Query', hint: 'SQL SELECT từ DB' },
  { id: 'airtable', icon: Plug, label: 'Airtable', hint: 'API Key + Base ID' },
];

// ── sub-forms ─────────────────────────────────────────────────────────────────

function FileForm({ onAdd, railwayUrl, category }: { onAdd: (sources: ActionDataSource[]) => void; railwayUrl: string; category: FileCategory }) {
  const { tr } = useI18n();
  const ref = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');

  const handle = async (list: FileList | null) => {
    if (!list) return;
    setReading(true);
    setError('');
    try {
      const extracted: ActionDataSource[] = [];
      for (const f of Array.from(list)) {
        const result = await uploadDocumentToRailway(f, category, railwayUrl);
        const record = result.record as ActionDataSource & { uploadedAt?: string };
        extracted.push({
          ...record,
          sourceType: 'file',
          addedAt: record.addedAt ?? record.uploadedAt ?? new Date().toISOString(),
        });
      }
      onAdd(extracted);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
      if (ref.current) ref.current.value = '';
    }
  };

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); handle(e.dataTransfer.files); }}
      onClick={() => !reading && ref.current?.click()}
      className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all
        bg-emerald-50/30 border-emerald-200 hover:border-emerald-500 ${dragging ? 'scale-[0.99] opacity-75' : ''}`}
    >
      <FolderUp className="mx-auto mb-2 h-8 w-8" aria-hidden="true" />
      <p className="text-xs font-bold text-slate-700">{reading ? tr('Railway đang scan và lưu Supabase...', 'Railway is scanning and saving to Supabase...') : tr('Kéo thả hoặc nhấp để chọn file', 'Drop files here or click to browse')}</p>
      <p className="text-[11px] text-slate-400 mt-1">MD · DOCX · PDF · CSV · XLSX · JSON · TXT</p>
      <input ref={ref} type="file" multiple accept=".md,.docx,.csv,.xlsx,.json,.pdf,.txt,.xml,.tsv" className="hidden" onChange={e => handle(e.target.files)} />
      {error && <p className="text-[11px] text-red-600 mt-2">{error}</p>}
    </div>
  );
}

function PasteForm({ onAdd }: { onAdd: (s: ActionDataSource) => void }) {
  const { tr } = useI18n();
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [fmt, setFmt] = useState<'csv' | 'json' | 'text'>('csv');

  const save = () => {
    if (!content.trim()) return;
    onAdd({
      id: uid(), name: name || `Paste ${fmt.toUpperCase()} ${shortDate()}`,
      sourceType: 'paste', addedAt: now(), contentUpdatedAt: now(), content,
      preview: csvPreview(content), rowCount: countRows(content),
    });
    setName(''); setContent('');
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder={tr('Tên nguồn dữ liệu...', 'Data source name...')} className={input} />
        <div className="flex gap-1 bg-slate-100 p-1 rounded-xl shrink-0">
          {(['csv','json','text'] as const).map(f => (
            <button key={f} onClick={() => setFmt(f)}
              className={`px-3 py-1 text-[11px] font-bold rounded-lg transition-all ${fmt === f ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <textarea
        value={content} onChange={e => setContent(e.target.value)}
        placeholder={fmt === 'csv' ? 'keyword,volume,difficulty\ncontent marketing,8100,45\n...'
          : fmt === 'json' ? '[{"keyword":"content marketing","volume":8100}]'
          : tr('Nhập dữ liệu văn bản thuần...', 'Enter plain text data...')}
        rows={7}
        className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-mono text-slate-800 outline-none focus:ring-2 focus:ring-slate-800 resize-none placeholder:text-slate-300"
      />
      <div className="flex justify-between items-center">
        <span className="text-[11px] text-slate-400">{countRows(content)} {tr('dòng', 'rows')} · {content.length} {tr('ký tự', 'characters')}</span>
        <button onClick={save} disabled={!content.trim()} className={btn}>{tr('Lưu nguồn dữ liệu', 'Save data source')}</button>
      </div>
    </div>
  );
}

function UrlForm({ onAdd }: { onAdd: (s: ActionDataSource) => void }) {
  const { tr } = useI18n();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headerKey, setHeaderKey] = useState('');
  const [headerVal, setHeaderVal] = useState('');
  const [headers, setHeaders] = useState<Record<string, string>>({});

  const addHeader = () => {
    if (!headerKey) return;
    setHeaders(h => ({ ...h, [headerKey]: headerVal }));
    setHeaderKey(''); setHeaderVal('');
  };

  const save = () => {
    if (!url) return;
    onAdd({
      id: uid(), name: name || url, sourceType: 'url', addedAt: now(),
      url, headers: Object.keys(headers).length ? headers : undefined,
      contentUpdatedAt: now(), preview: url,
    });
    setName(''); setUrl(''); setHeaders({});
  };

  return (
    <div className="space-y-3">
      <input value={name} onChange={e => setName(e.target.value)} placeholder={tr('Tên nguồn dữ liệu (tuỳ chọn)', 'Data source name (optional)')} className={input} />
      <div className="flex gap-2">
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://api.example.com/keywords" className={`${input} flex-1 font-mono text-[11px]`} />
      </div>

      {/* Custom headers */}
      <div className="space-y-1.5">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Headers (Authorization, API-Key...)</p>
        <div className="flex gap-2">
          <input value={headerKey} onChange={e => setHeaderKey(e.target.value)} placeholder="Key" className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-slate-800" />
          <input value={headerVal} onChange={e => setHeaderVal(e.target.value)} placeholder="Value" className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-slate-800" />
          <button onClick={addHeader} className="px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-xl">+</button>
        </div>
        {Object.entries(headers).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 text-[11px] font-mono bg-slate-100 rounded-lg px-3 py-1">
            <span className="text-slate-600 font-bold">{k}:</span>
            <span className="text-slate-500 flex-1 truncate">{v}</span>
            <button onClick={() => setHeaders(h => { const n={...h}; delete n[k]; return n; })} className="text-slate-400 hover:text-red-500">×</button>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-slate-400">Railway sẽ gọi URL, kiểm tra HTTP và chỉ lưu khi nhận được nội dung hợp lệ.</p>
      <div className="flex justify-end">
        <button onClick={save} disabled={!url} className={btn}>Import URL qua Railway</button>
      </div>
    </div>
  );
}

function GSheetForm({ onAdd }: { onAdd: (s: ActionDataSource) => void }) {
  const { tr } = useI18n();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');

  const sheetId = extractSheetId(url);
  const csvUrl = sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv` : null;

  const save = () => {
    if (!sheetId) return;
    onAdd({
      id: uid(), name: name || `Google Sheets — ${sheetId.slice(0, 8)}`,
      sourceType: 'gsheet', addedAt: now(),
      url: csvUrl!, contentUpdatedAt: now(), preview: 'Google Sheets public CSV',
    });
    setName(''); setUrl('');
  };

  return (
    <div className="space-y-3">
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-[11px] text-blue-800">
        Sheet phải được <strong>chia sẻ công khai</strong> (Anyone with the link → Viewer). <br />
        Paste link dạng: <code className="font-mono">docs.google.com/spreadsheets/d/...</code>
      </div>
      <input value={name} onChange={e => setName(e.target.value)} placeholder={tr('Tên nguồn dữ liệu...', 'Data source name...')} className={input} />
      <div className="flex gap-2">
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/..." className={`${input} flex-1 font-mono text-[11px]`} />
      </div>
      {sheetId && <p className="text-[10px] text-slate-400 font-mono">Sheet ID: {sheetId}</p>}
      <div className="flex justify-end">
        <button onClick={save} disabled={!sheetId} className={btn}>Import Google Sheets qua Railway</button>
      </div>
    </div>
  );
}

function ManualForm({ onAdd }: { onAdd: (s: ActionDataSource) => void }) {
  const { tr } = useI18n();
  const [name, setName] = useState('');
  const [columns, setColumns] = useState<string[]>(['Từ khóa', 'Volume', 'Độ khó']);
  const [rows, setRows] = useState<ManualRow[]>([{ id: uid(), cells: ['', '', ''] }]);

  const addRow = () => setRows(r => [...r, { id: uid(), cells: columns.map(() => '') }]);
  const removeRow = (id: string) => setRows(r => r.filter(x => x.id !== id));
  const updateCell = (rowId: string, ci: number, val: string) =>
    setRows(r => r.map(x => x.id === rowId ? { ...x, cells: x.cells.map((c, i) => i === ci ? val : c) } : x));
  const updateCol = (ci: number, val: string) =>
    setColumns(c => c.map((v, i) => i === ci ? val : v));
  const addCol = () => { setColumns(c => [...c, `Cột ${c.length + 1}`]); setRows(r => r.map(x => ({ ...x, cells: [...x.cells, ''] }))); };
  const removeCol = (ci: number) => { setColumns(c => c.filter((_, i) => i !== ci)); setRows(r => r.map(x => ({ ...x, cells: x.cells.filter((_, i) => i !== ci) }))); };

  const save = () => {
    const content = toCSV(columns, rows);
    onAdd({
      id: uid(), name: name || `Bảng thủ công ${shortDate()}`,
      sourceType: 'manual', addedAt: now(),
      columns, rows, content, contentUpdatedAt: now(), preview: csvPreview(content, 4),
      rowCount: rows.length,
    });
    setName(''); setRows([{ id: uid(), cells: columns.map(() => '') }]);
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <input value={name} onChange={e => setName(e.target.value)} placeholder={tr('Tên bảng...', 'Table name...')} className={`${input} flex-1`} />
        <button onClick={addCol} className="px-3 py-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 rounded-xl shrink-0">+ {tr('Cột', 'Column')}</button>
        <button onClick={addRow} className="px-3 py-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 rounded-xl shrink-0">+ {tr('Hàng', 'Row')}</button>
      </div>

      <div className="overflow-x-auto border border-slate-200 rounded-xl">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {columns.map((col, ci) => (
                <th key={ci} className="p-0 min-w-[100px]">
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    <input value={col} onChange={e => updateCol(ci, e.target.value)}
                      className="flex-1 font-bold text-slate-700 bg-transparent outline-none min-w-0" />
                    {columns.length > 1 && (
                      <button onClick={() => removeCol(ci)} className="text-slate-300 hover:text-red-400 shrink-0">×</button>
                    )}
                  </div>
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(row => (
              <tr key={row.id} className="group">
                {row.cells.map((cell, ci) => (
                  <td key={ci} className="p-0">
                    <input value={cell} onChange={e => updateCell(row.id, ci, e.target.value)}
                      className="w-full px-2 py-1.5 text-slate-700 bg-transparent outline-none focus:bg-blue-50/50"
                      placeholder="—" />
                  </td>
                ))}
                <td className="w-8 text-center">
                  <button onClick={() => removeRow(row.id)} className="text-slate-200 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between items-center">
        <span className="text-[11px] text-slate-400">{rows.length} hàng · {columns.length} cột</span>
        <button onClick={save} className={btn}>{tr('Lưu bảng dữ liệu', 'Save data table')}</button>
      </div>
    </div>
  );
}

function SupabaseForm({ onAdd }: { onAdd: (s: ActionDataSource) => void }) {
  const { tr } = useI18n();
  const [name, setName] = useState('');
  const [query, setQuery] = useState('SELECT * FROM keywords LIMIT 100;');

  const save = () => {
    if (!query.trim()) return;
    onAdd({
      id: uid(), name: name || `Supabase Query ${shortDate()}`,
      sourceType: 'supabase', addedAt: now(),
      query, preview: query,
    });
    setName(''); setQuery('SELECT * FROM keywords LIMIT 100;');
  };

  return (
    <div className="space-y-3">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-3 text-[11px] text-slate-300">
        Query sẽ được Railway backend thực thi trên Supabase project đã kết nối. Chỉ dùng <code className="text-emerald-400">SELECT</code>.
      </div>
      <input value={name} onChange={e => setName(e.target.value)} placeholder={tr('Tên query...', 'Query name...')} className={input} />
      <textarea
        value={query} onChange={e => setQuery(e.target.value)} rows={6}
        className="w-full bg-slate-900 text-emerald-400 border border-slate-700 rounded-xl px-4 py-3 text-xs font-mono outline-none focus:ring-2 focus:ring-emerald-600 resize-none"
      />
      <div className="flex justify-end">
        <button onClick={save} disabled={!query.trim()} className={btn}>{tr('Lưu Supabase Query', 'Save Supabase Query')}</button>
      </div>
    </div>
  );
}

function AirtableForm({ onAdd }: { onAdd: (s: ActionDataSource) => void }) {
  const { tr } = useI18n();
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [base, setBase] = useState('');
  const [table, setTable] = useState('');

  const save = () => {
    if (!apiKey || !base || !table) return;
    onAdd({
      id: uid(), name: name || `Airtable — ${table}`,
      sourceType: 'airtable', addedAt: now(),
      airtableKey: apiKey, airtableBase: base, airtableTable: table,
      preview: `Airtable: ${base} / ${table}`,
    });
    setName(''); setApiKey(''); setBase(''); setTable('');
  };

  return (
    <div className="space-y-3">
      <div className="bg-yellow-50 border border-yellow-100 rounded-xl p-3 text-[11px] text-yellow-800">
        Token chỉ được gửi một lần cho Railway để import dữ liệu và không được lưu vào Supabase.
      </div>
      <input value={name} onChange={e => setName(e.target.value)} placeholder={tr('Tên nguồn dữ liệu...', 'Data source name...')} className={input} />
      <input value={apiKey} onChange={e => setApiKey(e.target.value)} type="password" placeholder="Airtable Personal Access Token (pat...)" className={`${input} font-mono text-[11px]`} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input value={base} onChange={e => setBase(e.target.value)} placeholder="Base ID (app...)" className={`${input} font-mono text-[11px]`} />
        <input value={table} onChange={e => setTable(e.target.value)} placeholder={tr('Tên table', 'Table name')} className={input} />
      </div>
      <div className="flex justify-end">
        <button onClick={save} disabled={!apiKey || !base || !table} className={btn}>{tr('Lưu nguồn Airtable', 'Save Airtable source')}</button>
      </div>
    </div>
  );
}

// ── shared styles ─────────────────────────────────────────────────────────────

const input = 'bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 outline-none focus:ring-2 focus:ring-slate-800 transition-all w-full placeholder:text-slate-400';
const btn = 'px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white text-xs font-semibold rounded-xl transition-all';
const now = () => new Date().toISOString();
const shortDate = () => new Date().toLocaleDateString('vi-VN');

// ── main component ────────────────────────────────────────────────────────────

interface Props {
  sources: ActionDataSource[];
  onChange: (sources: ActionDataSource[]) => void;
  railwayUrl: string;
  category?: FileCategory;
  knowledgeGovernance?: boolean;
}

type GovernedSource = ActionDataSource & { knowledgeMetadata?: KnowledgeMetadata };

const DEFAULT_KNOWLEDGE_METADATA: KnowledgeMetadata = {
  type: 'reference', topics: [], visibility: 'internal', approvedForExternalUse: false,
};

const CATEGORY_LABEL: Record<FileCategory, string> = {
  kb: 'Knowledge Base',
  rules: 'Skills & Rules',
};

export default function SourceImportPanel({ sources = [], onChange, railwayUrl, category = 'kb', knowledgeGovernance = false }: Props) {
  const { language, tr } = useI18n();
  const [mode, setMode] = useState<ActionSourceType>('file');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [showImporter, setShowImporter] = useState(sources.length === 0);
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);

  const addSource = async (source: ActionDataSource) => {
    setImporting(true);
    setImportError('');
    try {
      const result = await importSourceThroughRailway(source, category, railwayUrl);
      onChange([result.record as ActionDataSource, ...sources]);
      setShowImporter(false);
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };
  const addSources = (newSources: ActionDataSource[]) => {
    onChange([...newSources, ...sources]);
    if (newSources.length) setShowImporter(false);
  };
  const removeSource = (id: string) => onChange(sources.filter(s => s.id !== id));
  const updateKnowledgeMetadata = (id: string, patch: Partial<KnowledgeMetadata>) => onChange(sources.map(source => {
    if (source.id !== id) return source;
    const current = (source as GovernedSource).knowledgeMetadata ?? DEFAULT_KNOWLEDGE_METADATA;
    return { ...source, knowledgeMetadata: { ...current, ...patch } } as GovernedSource;
  }));
  const readySourceCount = sources.filter(isImportSourceReady).length;
  const downloadSource = async (source: ActionDataSource) => {
    setDownloadingId(source.id);
    setDownloadError('');
    try {
      await downloadDocumentFromRailway(source.id, source.name, railwayUrl);
    } catch (error: unknown) {
      setDownloadError(error instanceof Error ? error.message : String(error));
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="knowledge-source-manager space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-slate-800">{tr('Tài liệu Knowledge Base', 'Knowledge Base sources')}</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">{tr('Quản lý nội dung AI có thể đọc và quyền sử dụng của từng nguồn.', 'Manage what AI can read and how each source may be used.')}</p>
        </div>
        <button onClick={() => setShowImporter(value => !value)} className="settings-secondary-action inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors">
          <Plus className="app-icon" aria-hidden="true" />
          {showImporter ? tr('Đóng', 'Close') : tr('Thêm nguồn', 'Add source')}
        </button>
      </div>

      {showImporter && <div className="knowledge-importer rounded-xl border border-slate-200 bg-slate-50 p-3">
      {/* Mode selector */}
      <div>
        <p className="mb-2 text-xs font-medium text-slate-600">{tr('Phương thức nhập', 'Import method')}</p>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {MODES.map(m => { const ModeIcon = m.icon; return (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`flex min-w-max items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                mode === m.id
                  ? 'bg-slate-900 border-slate-900 text-white shadow-md'
                  : 'bg-white border-slate-200 text-slate-600 hover:border-slate-400'
              }`}
            >
              <ModeIcon className="app-icon" aria-hidden="true" />
              <span className={`text-xs font-medium leading-tight ${mode === m.id ? 'text-white' : 'text-slate-700'}`}>{language === 'vi' ? m.label : ({ paste: 'Paste Data', manual: 'Manual Entry', file: 'File Upload', url: 'URL / API', gsheet: 'Google Sheets', supabase: 'Supabase Query', airtable: 'Airtable' } as Record<ActionSourceType, string>)[m.id]}</span>
            </button>
          ); })}
        </div>
      </div>

      {/* Active form */}
      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
        {mode === 'file'     && <FileForm     onAdd={addSources} railwayUrl={railwayUrl} category={category} />}
        {mode === 'paste'    && <PasteForm    onAdd={addSource} />}
        {mode === 'url'      && <UrlForm      onAdd={addSource} />}
        {mode === 'gsheet'   && <GSheetForm   onAdd={addSource} />}
        {mode === 'manual'   && <ManualForm   onAdd={addSource} />}
        {mode === 'supabase' && <SupabaseForm onAdd={addSource} />}
        {mode === 'airtable' && <AirtableForm onAdd={addSource} />}
        {importing && <p className="mt-3 text-[11px] font-semibold text-blue-600">{tr('Railway đang lấy dữ liệu và lưu Supabase...', 'Railway is importing and saving data to Supabase...')}</p>}
        {importError && <p className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-600">{importError}</p>}
      </div>
      </div>}

      {/* Saved sources list */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h4 className="text-sm font-medium text-slate-800">
            {CATEGORY_LABEL[category]}
            <span className="ml-1.5 font-normal text-slate-400">{sources.length}</span>
          </h4>
          {sources.length > 0 && (
            <span className={`rounded-md border px-2 py-1 text-xs font-medium ${
              readySourceCount === sources.length
                ? 'text-emerald-600 bg-emerald-50 border-emerald-100'
                : 'text-red-600 bg-red-50 border-red-100'
            }`}>
              {tr('AI có thể đọc', 'AI can read')} {readySourceCount}/{sources.length} {tr('nguồn', 'sources')}
            </span>
          )}
        </div>

        {downloadError && (
          <p className="mb-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-600">
            {downloadError}
          </p>
        )}

        {sources.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-sm text-slate-500">{tr('Chưa có nguồn dữ liệu nào.', 'No data sources yet.')}</p>
            <p className="mt-1 text-xs text-slate-400">{tr('Chọn “Thêm nguồn” để bắt đầu.', 'Choose “Add source” to begin.')}</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {sources.map(s => {
              const ready = isImportSourceReady(s);
              const knowledgeMetadata = (s as GovernedSource).knowledgeMetadata ?? DEFAULT_KNOWLEDGE_METADATA;
              const expanded = expandedSourceId === s.id;
              return (
              <div key={s.id} className={`knowledge-source-row group bg-white transition-colors ${ready ? '' : 'bg-red-50/40'}`}>
                <div className="flex min-h-16 items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-800">{s.name}</span>
                    <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                      ready ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                    }`}>
                      {ready ? tr('Sẵn sàng', 'Ready') : tr('Cần tải lại', 'Needs re-upload')}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                    <span>{s.sourceType.toUpperCase()}</span>
                    {s.rowCount && <span>{s.rowCount} dòng</span>}
                    {s.size && <span>{s.size}</span>}
                    <span>{new Date(s.addedAt).toLocaleDateString('vi-VN')}</span>
                    {knowledgeGovernance && <><span className="text-slate-500">{knowledgeMetadata.type.replace('_', ' ')}</span><span>{knowledgeMetadata.approvedForExternalUse ? tr('Được dùng công khai', 'External use allowed') : tr('Chỉ dùng nội bộ', 'Internal only')}</span></>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => downloadSource(s)}
                    disabled={!ready || downloadingId === s.id}
                    title={s.storagePath ? 'Tải file gốc từ Supabase' : 'Tải dữ liệu đã lưu'}
                    aria-label={tr('Tải tài liệu', 'Download source')}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40"
                  >
                    <Download className="app-icon" aria-hidden="true" />
                  </button>
                  <button
                    onClick={() => removeSource(s.id)}
                    title="Xóa nguồn dữ liệu"
                    aria-label={tr('Xóa tài liệu', 'Delete source')}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 opacity-0 transition-colors hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
                  >
                    <Trash2 className="app-icon" aria-hidden="true" />
                  </button>
                  {knowledgeGovernance && <button onClick={() => setExpandedSourceId(expanded ? null : s.id)} aria-expanded={expanded} aria-label={tr('Chỉnh quyền sử dụng', 'Edit source governance')} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"><ChevronDown className={`app-icon transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" /></button>}
                </div>
                </div>
                {knowledgeGovernance && expanded && <div className="knowledge-governance-editor border-t border-slate-200 bg-slate-50 px-4 py-4"><div className="grid gap-4 md:grid-cols-[180px_1fr_auto] md:items-end"><label className="block"><span className="mb-1.5 block text-xs font-medium text-slate-600">{tr('Loại kiến thức', 'Knowledge type')}</span><select value={knowledgeMetadata.type} onChange={event => updateKnowledgeMetadata(s.id, { type: event.target.value as KnowledgeMetadata['type'] })} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"><option value="reference">Reference</option><option value="usp">USP</option><option value="positioning">Positioning</option><option value="client_insight">Client insight</option><option value="case_study">Case study</option><option value="framework">Framework</option><option value="approved_claim">Approved claim</option><option value="production_insight">Production insight</option></select></label><label className="block"><span className="mb-1.5 block text-xs font-medium text-slate-600">Topics</span><input value={knowledgeMetadata.topics.join(', ')} onChange={event => updateKnowledgeMetadata(s.id, { topics: event.target.value.split(',').map(value => value.trim()).filter(Boolean) })} placeholder={tr('Ví dụ: healthcare, animation, training', 'For example: healthcare, animation, training')} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm" /></label><label className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600"><input type="checkbox" checked={knowledgeMetadata.approvedForExternalUse} onChange={event => updateKnowledgeMetadata(s.id, { approvedForExternalUse: event.target.checked, visibility: event.target.checked ? 'public' : 'internal' })} className="h-4 w-4"/><span>{tr('Cho phép xuất hiện trong nội dung công khai', 'Allow use in public content')}</span></label></div><p className="mt-3 text-xs leading-5 text-slate-400">{knowledgeMetadata.approvedForExternalUse ? tr('AI có thể nhắc tên nguồn này trong nội dung xuất bản.', 'AI may identify this source in published content.') : tr('AI được dùng kiến thức nhưng tên file sẽ được ẩn khỏi output.', 'AI may use the knowledge, but the filename stays hidden from output.')}</p></div>}
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

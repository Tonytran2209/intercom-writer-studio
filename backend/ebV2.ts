import type express from 'express';
import multer from 'multer';
import { generate } from './providers.ts';
import { tableAvailable, tableDeleteWhere, tableInsert, tableSelect, tableUpdate, tableUpsert } from './supabase.ts';
import { extractDocumentText } from './documentParser.ts';

type AuthRequest = express.Request & { auth?: { userId: string; email: string; role: 'user' | 'admin' } };
type ModelInput = { provider?: string; modelId?: string };
const stages = { brief: 'extract_mapping', article: ['article_spec', 'outline', 'draft'], adapt: 'channel_adaptation', review: 'repetition_check' } as const;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

function text(value: unknown) { return String(value ?? '').trim(); }
function librarySlug(filename: string) {
  const normalized = filename.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const slug = normalized.replace(/-md$/, '');
  return ['pillar-library', 'persona-library', 'article-library', 'channel-rules'].includes(slug) ? slug : null;
}
function modelFrom(body: any, key = 'model'): Required<ModelInput> | null {
  const input = body?.[key] ?? body?.model ?? {};
  const provider = text(input.provider); const modelId = text(input.id ?? input.modelId);
  return provider && modelId ? { provider, modelId } : null;
}
async function one<T>(table: string, id: string): Promise<T | null> { return (await tableSelect<T>(table, query => query.eq('id', id).limit(1)))[0] ?? null; }
async function libraryContext() { const documents = await tableSelect<any>('eb_v2_library_documents', query => query.eq('status', 'ready')); return documents.map(item => `${item.name}\n${String(item.content).slice(0, 12000)}`); }
async function runGate(packageId: string, gate: 'brief' | 'article' | 'adapt' | 'review', stage: string, prompt: string, model: Required<ModelInput>, contextDocs: string[], ruleSnapshot: Record<string, unknown> = {}) {
  const startedAt = new Date().toISOString();
  const run = await tableInsert<any>('eb_v2_gate_runs', { package_id: packageId, gate, stage, status: 'running', input_snapshot: { prompt }, rule_snapshot: ruleSnapshot, model_provider: model.provider, model_id: model.modelId, started_at: startedAt });
  try {
    const response = await generate({ provider: model.provider, modelId: model.modelId, prompt, contextDocs, maxTokens: gate === 'article' && stage === 'draft' ? 2600 : 1400, temperature: 0.65 });
    const usage = response.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    await tableUpdate('eb_v2_gate_runs', run.id, { status: 'completed', output_snapshot: { content: response.content }, input_tokens: usage.inputTokens ?? 0, cached_input_tokens: usage.cachedInputTokens ?? 0, output_tokens: usage.outputTokens ?? 0, total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), completed_at: new Date().toISOString() });
    return { content: response.content, model: response.model, usage };
  } catch (error) {
    await tableUpdate('eb_v2_gate_runs', run.id, { status: 'failed', error_message: error instanceof Error ? error.message : String(error), completed_at: new Date().toISOString() });
    throw error;
  }
}
async function workspace() {
  const [packages, articles, channels, discovery] = await Promise.all([
    tableSelect<any>('eb_v2_packages', query => query.order('updated_at', { ascending: false })),
    tableSelect<any>('eb_v2_articles', query => query.order('revision', { ascending: false })),
    tableSelect<any>('eb_v2_channel_outputs', query => query.order('updated_at', { ascending: false })),
    tableSelect<any>('eb_v2_discovery_items', query => query.order('updated_at', { ascending: false })),
  ]);
  return { packages, articles, channels, discovery };
}

export function registerEbV2Routes(app: express.Express) {
  app.get('/api/eb-v2/health', async (_req, res) => {
    const tables = ['eb_v2_library_documents', 'eb_v2_packages', 'eb_v2_package_inputs', 'eb_v2_discovery_items', 'eb_v2_gate_runs', 'eb_v2_articles', 'eb_v2_channel_outputs', 'eb_v2_review_actions', 'eb_v2_app_settings'];
    try { const availability = Object.fromEntries(await Promise.all(tables.map(async table => [table, await tableAvailable(table)]))); const ok = Object.values(availability).every(Boolean); res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', tables: availability }); } catch (error) { res.status(503).json({ status: 'degraded', error: error instanceof Error ? error.message : 'Unable to inspect EB V2 tables.' }); }
  });
  app.get('/api/eb-v2/settings', async (_req, res) => {
    try {
      const row = (await tableSelect<any>('eb_v2_app_settings', query => query.limit(1)))[0] ?? null;
      res.json({ settings: row?.settings ?? null });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to load EB V2 settings.' }); }
  });
  app.get('/api/eb-v2/library-documents', async (_req, res) => {
    try { res.json({ documents: await tableSelect<any>('eb_v2_library_documents', query => query.order('updated_at', { ascending: false })) }); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to load EB Library.' }); }
  });
  app.post('/api/eb-v2/library-documents/upload', upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'A file is required.' });
    const slug = librarySlug(file.originalname);
    if (!slug) return res.status(400).json({ error: 'EB Library accepts only pillar-library.md, persona-library.md, article-library.md, or channel-rules.md.' });
    try {
      const content = (await extractDocumentText(file.buffer, file.originalname)).trim();
      if (!content) return res.status(422).json({ error: 'The uploaded file did not contain readable text.' });
      await tableUpsert('eb_v2_library_documents', { slug, name: file.originalname, content, source_path: `settings-upload/${file.originalname}`, status: 'ready', metadata: { mimeType: file.mimetype, byteSize: file.size, uploadedAt: new Date().toISOString() }, updated_at: new Date().toISOString() }, 'slug');
      const document = (await tableSelect<any>('eb_v2_library_documents', query => query.eq('slug', slug).limit(1)))[0];
      res.status(201).json({ target: 'eb_v2_library_documents', record: document });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to save the EB Library document.' }); }
  });
  app.post('/api/eb-v2/settings', async (req: AuthRequest, res) => {
    try {
      const settings = req.body?.settings;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return res.status(400).json({ error: 'Settings must be an object.' });
      await tableUpsert('eb_v2_app_settings', { id: true, settings, updated_by: req.auth?.userId ?? null, updated_at: new Date().toISOString() }, 'id');
      res.json({ settings });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to save EB V2 settings.' }); }
  });
  app.get('/api/eb-v2/workspace', async (_req, res) => { try { res.json(await workspace()); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to load EB workspace.' }); } });

  app.post('/api/eb-v2/packages', async (req: AuthRequest, res) => {
    const inputText = text(req.body?.inputText); const title = text(req.body?.title) || inputText.slice(0, 120) || 'Untitled EB package'; const model = modelFrom(req.body);
    if (!inputText) return res.status(400).json({ error: 'Input text is required.' });
    if (!model) return res.status(400).json({ error: 'Choose a configured Brief AI model before analysing input.' });
    try {
      const item = await tableInsert<any>('eb_v2_packages', { title, state: 'brief', source_type: text(req.body?.sourceType) || 'input', created_by: req.auth?.userId ?? null });
      await tableInsert('eb_v2_package_inputs', { package_id: item.id, input_text: inputText, raw_snapshot: { sourceType: req.body?.sourceType ?? 'input' } });
      const result = await runGate(item.id, 'brief', stages.brief, `Extract and validate this employer-brand writing input. Return a concise brief with evidence, missing facts, suggested EVP pillar, persona, and article angle.\n\nINPUT:\n${inputText}`, model, await libraryContext());
      await tableUpdate('eb_v2_packages', item.id, { title, updated_at: new Date().toISOString() });
      res.status(201).json({ package: { ...item, brief: result.content } });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to create Brief.' }); }
  });
  app.post('/api/eb-v2/packages/upload', upload.single('file'), async (req: AuthRequest, res) => {
    const file = req.file; const model = { provider: text(req.body?.provider), modelId: text(req.body?.modelId) };
    if (!file) return res.status(400).json({ error: 'A file is required.' }); if (!model.provider || !model.modelId) return res.status(400).json({ error: 'Choose a Brief AI model before analysing a file.' });
    try {
      const inputText = await extractDocumentText(file.buffer, file.originalname); if (!inputText.trim()) return res.status(400).json({ error: 'The uploaded file did not contain readable text.' });
      const item = await tableInsert<any>('eb_v2_packages', { title: file.originalname, state: 'brief', source_type: 'upload', created_by: req.auth?.userId ?? null });
      await tableInsert('eb_v2_package_inputs', { package_id: item.id, input_text: inputText, upload_name: file.originalname, raw_snapshot: { mimeType: file.mimetype, byteSize: file.size } });
      await runGate(item.id, 'brief', stages.brief, `Extract and validate this employer-brand input from ${file.originalname}. Return a concise brief with evidence, missing facts, suggested EVP pillar, persona, and article angle.\n\nINPUT:\n${inputText.slice(0, 60000)}`, model, await libraryContext());
      res.status(201).json({ package: item });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to analyse uploaded file.' }); }
  });
  app.post('/api/eb-v2/discovery', async (req, res) => {
    const model = modelFrom(req.body); if (!model) return res.status(400).json({ error: 'Choose a Brief AI model before running Discovery.' });
    try {
      const docs = await libraryContext(); if (!docs.length) return res.status(409).json({ error: 'Load EB Library documents before running Discovery.' });
      const result = await generate({ provider: model.provider, modelId: model.modelId, contextDocs: docs, maxTokens: 900, temperature: 0.7, prompt: 'Propose exactly 3 distinct employer-brand article ideas grounded in the supplied library. Return one title per line, with no numbering or commentary.' });
      const titles = result.content.split(/\n+/).map(line => line.replace(/^\s*[-*\d.)]+\s*/, '').trim()).filter(Boolean).slice(0, 3);
      const items = await Promise.all(titles.map(title => tableInsert<any>('eb_v2_discovery_items', { title, source_summary: 'EB Library discovery', status: 'suggested', evidence: [] })));
      res.status(201).json({ items });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to run Discovery.' }); }
  });

  app.post('/api/eb-v2/packages/:id/approve-brief', async (req, res) => {
    const model = modelFrom(req.body); if (!model) return res.status(400).json({ error: 'Choose a Gate 2 AI model.' });
    try {
      const item = await one<any>('eb_v2_packages', req.params.id); if (!item) return res.status(404).json({ error: 'Package not found.' });
      const input = (await tableSelect<any>('eb_v2_package_inputs', query => query.eq('package_id', item.id).order('created_at', { ascending: false }).limit(1)))[0];
      const briefRuns = await tableSelect<any>('eb_v2_gate_runs', query => query.eq('package_id', item.id).eq('gate', 'brief').eq('status', 'completed').order('created_at', { ascending: false }).limit(1));
      const brief = briefRuns[0]?.output_snapshot?.content ?? ''; const source = input?.input_text ?? item.title; const docs = await libraryContext();
      const spec = await runGate(item.id, 'article', stages.article[0], `Create an Article Spec for fab.careers from this approved brief.\nBRIEF:\n${brief}\nSOURCE:\n${source}`, model, docs);
      const outline = await runGate(item.id, 'article', stages.article[1], `Create a structured, evidence-led outline using this Article Spec.\n${spec.content}`, model, docs);
      const draft = await runGate(item.id, 'article', stages.article[2], `Write the fab.careers article in Markdown from this outline. Do not invent facts.\nOUTLINE:\n${outline.content}`, model, docs);
      const article = await tableInsert<any>('eb_v2_articles', { package_id: item.id, revision: 1, status: 'draft', article_spec: { content: spec.content }, outline: [{ content: outline.content }], body_markdown: draft.content, quality_report: {} });
      await tableUpdate('eb_v2_packages', item.id, { state: 'article', brief_approved_at: new Date().toISOString() });
      res.json({ article, workspace: await workspace() });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to generate website article.' }); }
  });

  app.post('/api/eb-v2/packages/:id/approve-article', async (req, res) => {
    const model = modelFrom(req.body, 'adaptModel'); if (!model) return res.status(400).json({ error: 'Choose an Adapt AI model.' });
    try {
      const item = await one<any>('eb_v2_packages', req.params.id); if (!item) return res.status(404).json({ error: 'Package not found.' });
      const article = (await tableSelect<any>('eb_v2_articles', query => query.eq('package_id', item.id).eq('status', 'draft').order('revision', { ascending: false }).limit(1)))[0]; if (!article) return res.status(409).json({ error: 'No draft article available.' });
      await tableUpdate('eb_v2_articles', article.id, { status: 'approved', approved_at: new Date().toISOString() });
      const docs = await libraryContext();
      for (const channel of ['threads', 'facebook', 'linkedin']) {
        const output = await runGate(item.id, 'adapt', `${stages.adapt}:${channel}`, `Adapt this approved fab.careers article for ${channel}. Follow the relevant Channel Rules. Return only the channel-ready copy.\n\n${article.body_markdown}`, model, docs);
        await tableInsert('eb_v2_channel_outputs', { package_id: item.id, article_id: article.id, channel, revision: 1, status: 'ready_for_review', content: { text: output.content }, model_provider: model.provider, model_id: model.modelId, generated_at: new Date().toISOString() });
      }
      await tableUpdate('eb_v2_packages', item.id, { state: 'review', article_approved_at: new Date().toISOString() });
      res.json(await workspace());
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to adapt channels.' }); }
  });

  app.post('/api/eb-v2/channel-outputs/:id/review', async (req: AuthRequest, res) => {
    const action = text(req.body?.action); if (!['done', 'reject', 'recheck'].includes(action)) return res.status(400).json({ error: 'Invalid review action.' });
    try {
      const output = await one<any>('eb_v2_channel_outputs', text(req.params.id)); if (!output) return res.status(404).json({ error: 'Channel output not found.' });
      await tableInsert('eb_v2_review_actions', { channel_output_id: output.id, action, note: text(req.body?.note) || null, created_by: req.auth?.userId ?? null });
      await tableUpdate('eb_v2_channel_outputs', output.id, { status: action === 'done' ? 'done' : action === 'reject' ? 'rejected' : 'recheck', completed_at: action === 'done' ? new Date().toISOString() : null });
      res.json(await workspace());
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to save review action.' }); }
  });

  // Deleting a package is scoped to V2 only; foreign-key cascades remove its
  // inputs, runs, article revisions, channel outputs and review actions.
  app.delete('/api/eb-v2/packages/:id', async (req, res) => {
    try { await tableDeleteWhere('eb_v2_packages', 'id', text(req.params.id)); res.json(await workspace()); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to delete EB package.' }); }
  });
  // A reviewer may remove one channel output without deleting its package.
  app.delete('/api/eb-v2/channel-outputs/:id', async (req, res) => {
    try { await tableDeleteWhere('eb_v2_channel_outputs', 'id', text(req.params.id)); res.json(await workspace()); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to delete channel output.' }); }
  });
}

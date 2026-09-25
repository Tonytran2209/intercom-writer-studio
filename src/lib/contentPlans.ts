import type { ContentPlan, ContentPlanSourceType } from '../types';
import { isShellMode } from './appMode';

// This store exists only for the browser lifetime. It makes the Activity UI
// usable during design without preserving or requesting any production data.
let shellPlans: ContentPlan[] = [];
const shellId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function shellPlan(input: { name: string; sourceType: ContentPlanSourceType; content?: string; url?: string; previousVersionId?: string }): ContentPlan {
  const id = shellId('shell-plan');
  const text = input.content?.trim() || input.url || 'Sample topic for UI prototyping';
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean).slice(0, 5);
  const items = (lines.length ? lines : [text]).map((title, index) => ({
    id: shellId(`item-${index}`), title: title.slice(0, 120), keywords: title.split(/\s+/).slice(0, 4),
    type: index % 2 ? 'editorial-originality' as const : 'comparison-seo' as const,
    sourceLine: title, confidence: 0.8, classificationReason: 'Simulated shell classification', status: 'not_started' as const,
  }));
  const now = new Date().toISOString();
  return { id, name: input.name || 'Untitled prototype plan', status: 'ready', version: 1,
    previousVersionId: input.previousVersionId ?? null, sourceFingerprint: `shell-${id}`,
    totalArticles: items.length, comparisonCount: items.filter(item => item.type === 'comparison-seo').length,
    editorialCount: items.filter(item => item.type === 'editorial-originality').length, reviewCount: 0,
    createdAt: now, updatedAt: now, classifiedAt: now, items,
    sources: [{ id: shellId('source'), contentPlanId: id, sourceType: input.sourceType, name: input.name || 'Prototype source', originalUrl: input.url,
      extractedContent: text, contentHash: `shell-${id}`, contentLength: text.length, scanStatus: 'ready', createdAt: now }],
  };
}

function baseUrl(railwayUrl: string) { return railwayUrl.trim().replace(/\/$/, '') || window.location.origin; }
async function parse(response: Response) { const payload = await response.json().catch(() => ({ error: response.statusText })); if (!response.ok) throw new Error(payload.error || `Content Plan error ${response.status}`); return payload; }

export async function importContentPlan(input: { name: string; sourceType: ContentPlanSourceType; content?: string; url?: string; file?: File; previousVersionId?: string }, railwayUrl: string): Promise<ContentPlan> {
  if (isShellMode) {
    const content = input.file ? await input.file.text() : input.content;
    const plan = shellPlan({ ...input, content });
    shellPlans = [plan, ...shellPlans];
    return plan;
  }
  if (input.file) {
    const body = new FormData(); body.append('file', input.file); body.append('name', input.name); body.append('sourceType', 'file'); if (input.previousVersionId) body.append('previousVersionId', input.previousVersionId);
    return (await parse(await fetch(`${baseUrl(railwayUrl)}/api/content-plans/import`, { method: 'POST', body }))).plan;
  }
  return (await parse(await fetch(`${baseUrl(railwayUrl)}/api/content-plans/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }))).plan;
}

export async function classifyContentPlan(id: string, railwayUrl: string, force = false): Promise<ContentPlan> {
  if (isShellMode) {
    const plan = shellPlans.find(item => item.id === id);
    if (!plan) throw new Error('Prototype plan not found.');
    return plan;
  }
  return (await parse(await fetch(`${baseUrl(railwayUrl)}/api/content-plans/${encodeURIComponent(id)}/${force ? 'reclassify' : 'classify'}`, { method: 'POST' }))).plan;
}

export async function fetchContentPlans(railwayUrl: string): Promise<ContentPlan[]> {
  if (isShellMode) return shellPlans;
  return parse(await fetch(`${baseUrl(railwayUrl)}/api/content-plans`));
}

export async function deleteContentPlan(id: string, railwayUrl: string): Promise<void> {
  if (isShellMode) { shellPlans = shellPlans.filter(item => item.id !== id); return; }
  await parse(await fetch(`${baseUrl(railwayUrl)}/api/content-plans/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function updateContentPlanItem(planId: string, itemId: string, type: 'comparison-seo' | 'editorial-originality' | 'needs-review', railwayUrl: string): Promise<ContentPlan> {
  if (isShellMode) {
    const plan = shellPlans.find(item => item.id === planId);
    if (!plan) throw new Error('Prototype plan not found.');
    const next = { ...plan, items: plan.items?.map(item => item.id === itemId ? { ...item, type } : item) };
    shellPlans = shellPlans.map(item => item.id === planId ? next : item);
    return next;
  }
  return (await parse(await fetch(`${baseUrl(railwayUrl)}/api/content-plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) }))).plan;
}

export async function updateContentPlanStatus(planId: string, status: 'active' | 'archived', railwayUrl: string): Promise<ContentPlan> {
  return (await parse(await fetch(`${baseUrl(railwayUrl)}/api/content-plans/${encodeURIComponent(planId)}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }))).plan;
}

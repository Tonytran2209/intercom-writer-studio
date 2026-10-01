export type DiscoverySourceDraft = {
  sourceType: 'brandsvietnam' | 'vietcetera' | 'google_news' | 'reddit' | 'user_link';
  sourceName: string;
  url: string;
  title: string;
  excerpt?: string;
  language: 'vi' | 'en' | 'unknown';
  publishedAt?: string;
  engagement?: Record<string, number>;
  eligibility: 'eligible' | 'undated' | 'outdated' | 'low_engagement' | 'irrelevant';
};
export type Coverage = { source: string; status: 'scanned' | 'empty' | 'failed'; note?: string };

const WORK_TERMS = /(work|workplace|career|employee|office|culture|talent|gen\s*z|lao động|đi làm|công sở|nhân sự|việc làm|nghề nghiệp|văn hoá)/i;
export type DiscoveryResearchOptions = { windowMonths?: number; redditMinUpvotes?: number; redditMinReplies?: number; timeoutMs?: number; googleQueries?: string[]; redditQueries?: string[]; fitIncludeTerms?: string[]; fitExcludeTerms?: string[]; sources?: Partial<{ brandsVietnam: boolean; vietcetera: boolean; googleNews: boolean; reddit: boolean; threads: boolean }> };
let options: Required<DiscoveryResearchOptions> = { windowMonths: 4, redditMinUpvotes: 20, redditMinReplies: 5, timeoutMs: 9000, googleQueries: ['tin tức lao động genz', 'genz tìm việc', 'genz đi làm'], redditQueries: ['gen z work', 'gen z workplace', 'career advice gen z'], fitIncludeTerms: [], fitExcludeTerms: [], sources: { brandsVietnam: true, vietcetera: true, googleNews: true, reddit: true, threads: true } };

function clean(value: string) { return value.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); }
function decode(value: string) { return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"); }
function date(value?: string | null) { const parsed = value ? new Date(value) : null; return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined; }
function eligibility(publishedAt?: string, engagement?: Record<string, number>, sourceType?: string): DiscoverySourceDraft['eligibility'] {
  if (sourceType === 'reddit' && (Number(engagement?.upvotes ?? 0) < options.redditMinUpvotes && Number(engagement?.replies ?? 0) < options.redditMinReplies)) return 'low_engagement';
  if (!publishedAt) return 'undated';
  return Date.now() - new Date(publishedAt).getTime() <= options.windowMonths * 31 * 24 * 60 * 60 * 1000 ? 'eligible' : 'outdated';
}
async function fetchText(url: string) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try { const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'F-Learning-EB-Research/1.0 (+https://fab.careers)' } }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return await response.text(); }
  finally { clearTimeout(timer); }
}
function htmlDate(html: string) { return date(html.match(/(?:article:published_time|datePublished)["'\s:=]+([^"'<\s]+)/i)?.[1] ?? html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1]); }
function linksFromHtml(html: string, base: string) { const links: Array<{ title: string; url: string }> = []; for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) { try { const url = new URL(match[1], base).toString(); const title = clean(match[2]); if (title.length > 18 && WORK_TERMS.test(title)) links.push({ title, url }); } catch {} } return [...new Map(links.map(item => [item.url, item])).values()].slice(0, 8); }

async function listingSource(sourceName: string, sourceType: 'brandsvietnam' | 'vietcetera', url: string, language: 'vi' | 'en') {
  const html = await fetchText(url); const links = linksFromHtml(html, url); const collected: Array<DiscoverySourceDraft | null> = await Promise.all(links.map(async (link): Promise<DiscoverySourceDraft | null> => { try { const article = await fetchText(link.url); const publishedAt = htmlDate(article); return { sourceType, sourceName, url: link.url, title: link.title, excerpt: clean(article).slice(0, 500), language, publishedAt, eligibility: eligibility(publishedAt, undefined, sourceType) }; } catch { return null; } }));
  return collected.filter((item): item is DiscoverySourceDraft => item !== null);
}
function rssItems(xml: string, sourceName: string): DiscoverySourceDraft[] { const items: DiscoverySourceDraft[] = []; for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) { const body = item[1]; const title = clean(decode(body.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '')); const url = clean(decode(body.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? '')); const publishedAt = date(body.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]); if (!title || !url || !WORK_TERMS.test(title)) continue; items.push({ sourceType: 'google_news', sourceName, url, title, excerpt: clean(decode(body.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? '')).slice(0, 500), language: 'vi', publishedAt, eligibility: eligibility(publishedAt) }); } return items; }
function fits(title: string, excerpt = '') { const value = `${title} ${excerpt}`.toLowerCase(); const include = options.fitIncludeTerms.length ? options.fitIncludeTerms.some(term => value.includes(term.toLowerCase())) : WORK_TERMS.test(value); const excluded = options.fitExcludeTerms.some(term => value.includes(term.toLowerCase())); return include && !excluded; }
async function redditSources() { const responses = await Promise.all(options.redditQueries.slice(0, 8).map(async query => { const raw = await fetchText(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=year&limit=12`); const json = JSON.parse(raw); return (json.data?.children ?? []).map((item: any) => item.data); })); return responses.flat().map((item: any) => { const publishedAt = date(item.created_utc ? new Date(item.created_utc * 1000).toISOString() : undefined); const engagement = { upvotes: Number(item.ups ?? 0), replies: Number(item.num_comments ?? 0) }; return { sourceType: 'reddit', sourceName: 'Reddit', url: `https://www.reddit.com${item.permalink}`, title: String(item.title ?? ''), excerpt: String(item.selftext ?? '').slice(0, 500), language: 'en', publishedAt, engagement, eligibility: eligibility(publishedAt, engagement, 'reddit') } satisfies DiscoverySourceDraft; }).filter(item => item.title && fits(item.title, item.excerpt)); }
async function userLink(url: string) { const html = await fetchText(url); const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? url); const publishedAt = htmlDate(html); return { sourceType: 'user_link', sourceName: new URL(url).hostname, url, title, excerpt: clean(html).slice(0, 500), language: /[à-ỹđ]/i.test(`${title} ${html.slice(0, 1000)}`) ? 'vi' : 'unknown', publishedAt, eligibility: eligibility(publishedAt) } satisfies DiscoverySourceDraft; }

export async function collectDiscoveryResearch(extraUrls: string[] = [], nextOptions: DiscoveryResearchOptions = {}) {
  options = { ...options, ...nextOptions, sources: { ...options.sources, ...nextOptions.sources } };
  const coverage: Coverage[] = []; const sources: DiscoverySourceDraft[] = [];
  const tasks: Array<[string, () => Promise<DiscoverySourceDraft[]>]> = [
    ...(options.sources.brandsVietnam ? [['Brands Vietnam', () => listingSource('Brands Vietnam', 'brandsvietnam', 'https://www.brandsvietnam.com/featured/', 'vi')] as [string, () => Promise<DiscoverySourceDraft[]>]] : []),
    ...(options.sources.vietcetera ? [['Vietcetera', () => listingSource('Vietcetera', 'vietcetera', 'https://vietcetera.com/en', 'en')] as [string, () => Promise<DiscoverySourceDraft[]>]] : []),
    ...(options.sources.googleNews ? [['Google News VN', async () => rssItems(await fetchText('https://news.google.com/rss/search?q=' + encodeURIComponent(options.googleQueries.join(' OR ')) + '&hl=vi&gl=VN&ceid=VN:vi'), 'Google News VN').filter(item => fits(item.title, item.excerpt))] as [string, () => Promise<DiscoverySourceDraft[]>]] : []),
    ...(options.sources.threads ? [['Threads signals', async () => rssItems(await fetchText('https://news.google.com/rss/search?q=' + encodeURIComponent(`site:threads.com ${options.googleQueries.join(' OR ')}`) + '&hl=vi&gl=VN&ceid=VN:vi'), 'Threads signals').filter(item => fits(item.title, item.excerpt))] as [string, () => Promise<DiscoverySourceDraft[]>]] : []),
    ...(options.sources.reddit ? [['Reddit', redditSources] as [string, () => Promise<DiscoverySourceDraft[]>]] : []),
  ];
  for (const [name, task] of tasks) { try { const result = await task(); sources.push(...result); coverage.push({ source: name, status: result.length ? 'scanned' : 'empty', note: result.length ? `${result.length} relevant candidates` : 'No usable candidates' }); } catch (error) { coverage.push({ source: name, status: 'failed', note: error instanceof Error ? error.message : 'Fetch failed' }); } }
  for (const url of extraUrls) { try { sources.push(await userLink(url)); coverage.push({ source: url, status: 'scanned' }); } catch (error) { coverage.push({ source: url, status: 'failed', note: error instanceof Error ? error.message : 'Fetch failed' }); } }
  return { sources: sources.slice(0, 70), coverage };
}

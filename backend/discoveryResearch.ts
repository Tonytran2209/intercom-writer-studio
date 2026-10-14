export type DiscoverySourceDraft = {
  sourceType: 'brandsvietnam' | 'vietcetera' | 'google_news' | 'reddit' | 'hacker_news' | 'user_link';
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
export type DiscoveryResearchOptions = { windowMonths?: number; freshDays?: number; redditMinUpvotes?: number; redditMinReplies?: number; timeoutMs?: number; googleQueries?: string[]; redditQueries?: string[]; fitIncludeTerms?: string[]; fitExcludeTerms?: string[]; sources?: Partial<{ brandsVietnam: boolean; vietcetera: boolean; googleNews: boolean; googleNewsGlobal: boolean; reddit: boolean; hackerNews: boolean; threads: boolean }> };
const DEFAULT_OPTIONS: Required<DiscoveryResearchOptions> = { windowMonths: 4, freshDays: 30, redditMinUpvotes: 20, redditMinReplies: 5, timeoutMs: 9000, googleQueries: ['tin tức lao động gen z', 'xu hướng đi làm gen z', 'văn hoá công sở', 'thị trường lao động việt nam', 'employer branding việt nam'], redditQueries: ['gen z work', 'gen z workplace', 'career advice gen z', 'workplace culture', 'employee experience'], fitIncludeTerms: [], fitExcludeTerms: [], sources: { brandsVietnam: true, vietcetera: true, googleNews: true, googleNewsGlobal: true, reddit: true, hackerNews: true, threads: true } };

function clean(value: string) { return value.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); }
function decode(value: string) { return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"); }
function date(value?: string | null) { const parsed = value ? new Date(value) : null; return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined; }
function eligibility(options: Required<DiscoveryResearchOptions>, publishedAt?: string, engagement?: Record<string, number>, sourceType?: string): DiscoverySourceDraft['eligibility'] {
  if (sourceType === 'reddit' && (Number(engagement?.upvotes ?? 0) < options.redditMinUpvotes && Number(engagement?.replies ?? 0) < options.redditMinReplies)) return 'low_engagement';
  if (!publishedAt) return 'undated';
  return Date.now() - new Date(publishedAt).getTime() <= options.windowMonths * 31 * 24 * 60 * 60 * 1000 ? 'eligible' : 'outdated';
}
async function fetchText(url: string, options: Required<DiscoveryResearchOptions>) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try { const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'F-Learning-EB-Research/1.0 (+https://fab.careers)' } }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return await response.text(); }
  finally { clearTimeout(timer); }
}
function htmlDate(html: string) { return date(html.match(/(?:article:published_time|datePublished)["'\s:=]+([^"'<\s]+)/i)?.[1] ?? html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1]); }
function linksFromHtml(html: string, base: string) { const links: Array<{ title: string; url: string }> = []; for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) { try { const url = new URL(match[1], base).toString(); const title = clean(match[2]); if (title.length > 18 && WORK_TERMS.test(title)) links.push({ title, url }); } catch {} } return [...new Map(links.map(item => [item.url, item])).values()].slice(0, 8); }

async function listingSource(options: Required<DiscoveryResearchOptions>, sourceName: string, sourceType: 'brandsvietnam' | 'vietcetera', url: string, language: 'vi' | 'en') {
  const html = await fetchText(url, options); const links = linksFromHtml(html, url); const collected: Array<DiscoverySourceDraft | null> = await Promise.all(links.map(async (link): Promise<DiscoverySourceDraft | null> => { try { const article = await fetchText(link.url, options); const publishedAt = htmlDate(article); return { sourceType, sourceName, url: link.url, title: link.title, excerpt: clean(article).slice(0, 500), language, publishedAt, eligibility: eligibility(options, publishedAt, undefined, sourceType) }; } catch { return null; } }));
  return collected.filter((item): item is DiscoverySourceDraft => item !== null);
}
function rssItems(options: Required<DiscoveryResearchOptions>, xml: string, fallbackSourceName: string, language: 'vi' | 'en'): DiscoverySourceDraft[] { const items: DiscoverySourceDraft[] = []; for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) { const body = item[1]; const title = clean(decode(body.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '')); const url = clean(decode(body.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? '')); const publishedAt = date(body.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]); const sourceName = clean(decode(body.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1] ?? '')) || fallbackSourceName; if (!title || !url || !WORK_TERMS.test(title)) continue; items.push({ sourceType: 'google_news', sourceName, url, title, excerpt: clean(decode(body.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? '')).slice(0, 500), language, publishedAt, eligibility: eligibility(options, publishedAt) }); } return items; }
function fits(options: Required<DiscoveryResearchOptions>, title: string, excerpt = '') { const value = `${title} ${excerpt}`.toLowerCase(); const include = options.fitIncludeTerms.length ? options.fitIncludeTerms.some(term => value.includes(term.toLowerCase())) : WORK_TERMS.test(value); const excluded = options.fitExcludeTerms.some(term => value.includes(term.toLowerCase())); return include && !excluded; }
async function redditSources(options: Required<DiscoveryResearchOptions>) { const responses = await Promise.all(options.redditQueries.slice(0, 8).map(async query => { const raw = await fetchText(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=year&limit=12`, options); const json = JSON.parse(raw); return (json.data?.children ?? []).map((item: any) => item.data); })); return responses.flat().map((item: any) => { const publishedAt = date(item.created_utc ? new Date(item.created_utc * 1000).toISOString() : undefined); const engagement = { upvotes: Number(item.ups ?? 0), replies: Number(item.num_comments ?? 0) }; return { sourceType: 'reddit', sourceName: 'Reddit', url: `https://www.reddit.com${item.permalink}`, title: String(item.title ?? ''), excerpt: String(item.selftext ?? '').slice(0, 500), language: 'en', publishedAt, engagement, eligibility: eligibility(options, publishedAt, engagement, 'reddit') } satisfies DiscoverySourceDraft; }).filter(item => item.title && fits(options, item.title, item.excerpt)); }
async function hackerNewsSources(options: Required<DiscoveryResearchOptions>) { const responses = await Promise.all(options.redditQueries.slice(0, 8).map(async query => JSON.parse(await fetchText(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`, options)))); return responses.flatMap((response: any) => response.hits ?? []).map((item: any) => { const publishedAt = date(item.created_at); return { sourceType: 'hacker_news', sourceName: 'Hacker News', url: item.url || `https://news.ycombinator.com/item?id=${item.objectID}`, title: String(item.title ?? ''), excerpt: String(item.story_text ?? '').slice(0, 500), language: 'en', publishedAt, eligibility: eligibility(options, publishedAt) } satisfies DiscoverySourceDraft; }).filter(item => item.title && fits(options, item.title, item.excerpt)); }
async function userLink(options: Required<DiscoveryResearchOptions>, url: string) { const html = await fetchText(url, options); const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? url); const publishedAt = htmlDate(html); return { sourceType: 'user_link', sourceName: new URL(url).hostname, url, title, excerpt: clean(html).slice(0, 500), language: /[à-ỹđ]/i.test(`${title} ${html.slice(0, 1000)}`) ? 'vi' : 'unknown', publishedAt, eligibility: eligibility(options, publishedAt) } satisfies DiscoverySourceDraft; }

export async function collectDiscoveryResearch(extraUrls: string[] = [], nextOptions: DiscoveryResearchOptions = {}) {
  const options: Required<DiscoveryResearchOptions> = { ...DEFAULT_OPTIONS, ...nextOptions, sources: { ...DEFAULT_OPTIONS.sources, ...nextOptions.sources } };
  const coverage: Coverage[] = []; const sources: DiscoverySourceDraft[] = [];
  const tasks: Array<[string, () => Promise<DiscoverySourceDraft[]>]> = [
    ...(options.sources.brandsVietnam ? [['Brands Vietnam', () => listingSource(options, 'Brands Vietnam', 'brandsvietnam', 'https://www.brandsvietnam.com/featured/', 'vi')] as [string, () => Promise<DiscoverySourceDraft[]>]] : []),
    ...(options.sources.vietcetera ? [['Vietcetera', () => listingSource(options, 'Vietcetera', 'vietcetera', 'https://vietcetera.com/en', 'en')] as [string, () => Promise<DiscoverySourceDraft[]>]] : []),
    ...(options.sources.googleNews ? [['Google News VN', async () => rssItems(options, await fetchText('https://news.google.com/rss/search?q=' + encodeURIComponent(options.googleQueries.join(' OR ')) + '&hl=vi&gl=VN&ceid=VN:vi', options), 'Google News VN', 'vi').filter(item => fits(options, item.title, item.excerpt))] as [string, () => Promise<DiscoverySourceDraft[]>]] : []),
    ...(options.sources.googleNewsGlobal ? [['Google News global', async () => rssItems(options, await fetchText('https://news.google.com/rss/search?q=' + encodeURIComponent('workplace trends OR gen z work OR employee experience') + '&hl=en-US&gl=US&ceid=US:en', options), 'Google News global', 'en').filter(item => fits(options, item.title, item.excerpt))] as [string, () => Promise<DiscoverySourceDraft[]>]] : []),
    ...(options.sources.threads ? [['Threads signals', async () => rssItems(options, await fetchText('https://news.google.com/rss/search?q=' + encodeURIComponent(`site:threads.com ${options.googleQueries.join(' OR ')}`) + '&hl=vi&gl=VN&ceid=VN:vi', options), 'Threads signals', 'vi').filter(item => fits(options, item.title, item.excerpt))] as [string, () => Promise<DiscoverySourceDraft[]>]] : []),
    ...(options.sources.reddit ? [['Reddit', () => redditSources(options)] as [string, () => Promise<DiscoverySourceDraft[]>]] : []),
    ...(options.sources.hackerNews ? [['Hacker News', () => hackerNewsSources(options)] as [string, () => Promise<DiscoverySourceDraft[]>]] : []),
  ];
  for (const [name, task] of tasks) { try { const result = await task(); sources.push(...result); coverage.push({ source: name, status: result.length ? 'scanned' : 'empty', note: result.length ? `${result.length} relevant candidates` : 'No usable candidates' }); } catch (error) { coverage.push({ source: name, status: 'failed', note: error instanceof Error ? error.message : 'Fetch failed' }); } }
  for (const url of extraUrls) { try { sources.push(await userLink(options, url)); coverage.push({ source: url, status: 'scanned' }); } catch (error) { coverage.push({ source: url, status: 'failed', note: error instanceof Error ? error.message : 'Fetch failed' }); } }
  return { sources: sources.slice(0, 120), coverage };
}

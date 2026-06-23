/**
 * Web search for the agent. Parley has no search endpoint, so the extension queries
 * a search engine directly. DuckDuckGo works with no API key (HTML endpoint); Google
 * (Programmable Search JSON API) and Tavily are opt-in keyed providers.
 */
export type WebSearchProvider = 'off' | 'duckduckgo' | 'google' | 'tavily';

export interface WebSearchConfig {
  readonly provider: WebSearchProvider;
  readonly apiKey?: string;
  readonly googleCx?: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const MAX_RESULTS = 6;
const TIMEOUT_MS = 15000;

/** Decode a DuckDuckGo HTML redirect link (`/l/?uddg=<encoded>`) into the real URL (pure). */
export function decodeDdgUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

function format(results: SearchResult[]): string {
  if (results.length === 0) {
    return '[no results]';
  }
  return results
    .slice(0, MAX_RESULTS)
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n\n');
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

async function ddgSearch(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } });
  if (!resp.ok) {
    return `Error: DuckDuckGo returned HTTP ${resp.status}.`;
  }
  const html = await resp.text();
  const results: SearchResult[] = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < MAX_RESULTS) {
    results.push({ url: decodeDdgUrl(m[1]), title: stripTags(m[2]), snippet: '' });
  }
  // Attach snippets if present, by order.
  const snippets = [...html.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map((s) => stripTags(s[1]));
  results.forEach((r, i) => {
    if (snippets[i]) {
      r.snippet = snippets[i];
    }
  });
  return format(results);
}

async function googleSearch(query: string, config: WebSearchConfig): Promise<string> {
  if (!config.apiKey || !config.googleCx) {
    return 'Error: Google search needs both "parley.webSearch.apiKey" and "parley.webSearch.googleCx" (Programmable Search Engine id).';
  }
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(config.apiKey)}&cx=${encodeURIComponent(config.googleCx)}&q=${encodeURIComponent(query)}&num=${MAX_RESULTS}`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    return `Error: Google search returned HTTP ${resp.status}.`;
  }
  const json = (await resp.json()) as { items?: Array<{ title?: string; link?: string; snippet?: string }> };
  const results = (json.items ?? []).map((it) => ({ title: it.title ?? '', url: it.link ?? '', snippet: it.snippet ?? '' }));
  return format(results);
}

async function tavilySearch(query: string, config: WebSearchConfig): Promise<string> {
  if (!config.apiKey) {
    return 'Error: Tavily search needs "parley.webSearch.apiKey".';
  }
  const resp = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: config.apiKey, query, max_results: MAX_RESULTS })
  });
  if (!resp.ok) {
    return `Error: Tavily returned HTTP ${resp.status}.`;
  }
  const json = (await resp.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  const results = (json.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
  return format(results);
}

export async function webSearch(query: string, config: WebSearchConfig): Promise<string> {
  const q = query.trim();
  if (!q) {
    return 'Error: query is required.';
  }
  try {
    switch (config.provider) {
      case 'off':
        return 'Web search is disabled. Set "parley.webSearch.provider" to duckduckgo, google, or tavily.';
      case 'google':
        return await googleSearch(q, config);
      case 'tavily':
        return await tavilySearch(q, config);
      case 'duckduckgo':
      default:
        return await ddgSearch(q);
    }
  } catch (error) {
    return `Error: web search failed (${error instanceof Error ? error.message : 'unknown'}).`;
  }
}

import type {
  SourceConnector,
  SourceSearchInput,
  SourceSearchResult,
} from './types'
import { callTool } from './mcp'
import {
  MAX_RESULT_TEXT_CHARS,
  clampLimit,
  isRecord,
  pickString,
  truncate,
} from './util'

/**
 * Web search connector.
 *
 * Provider is selected via `WEB_SEARCH_PROVIDER` and the API key via
 * `WEB_SEARCH_API_KEY`. Perplexity can also use `PERPLEXITY_API_KEY`. The
 * DEFAULT provider is **Tavily** — it returns a clean snippet/`content` field
 * per result which maps well to our normalized shape.
 *
 * Parallel uses anonymous MCP and requires no API key. Additional providers
 * (Brave, Serper, Perplexity, Parallel) are included so the provider
 * can be swapped via env without code changes. To add another provider,
 * implement a function with the {@link ProviderFn} signature and register it in
 * `PROVIDERS`.
 */

type ProviderFn = (
  apiKey: string,
  input: SourceSearchInput,
) => Promise<SourceSearchResult[]>

const DEFAULT_PROVIDER = 'tavily'

function provider(): string {
  return (
    process.env.WEB_SEARCH_PROVIDER ||
    (process.env.PERPLEXITY_API_KEY ? 'perplexity' : DEFAULT_PROVIDER)
  ).toLowerCase()
}

function apiKeyForProvider(selected: string): string | undefined {
  if (selected === 'perplexity') {
    return process.env.PERPLEXITY_API_KEY || process.env.WEB_SEARCH_API_KEY
  }
  return process.env.WEB_SEARCH_API_KEY
}

/**
 * Resolve a provider endpoint, allowing `WEB_SEARCH_BASE_URL` to override the
 * default host (useful for a proxy, a self-hosted gateway, or testing).
 */
function endpoint(defaultUrl: string): string {
  const base = process.env.WEB_SEARCH_BASE_URL?.trim()
  if (!base) return defaultUrl
  const path = new URL(defaultUrl).pathname
  return new URL(path, base).toString()
}

function nowIso(): string {
  return new Date().toISOString()
}

// --- Tavily (default) -------------------------------------------------------
const tavily: ProviderFn = async (apiKey, input) => {
  const res = await fetch(endpoint('https://api.tavily.com/search'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: input.query,
      max_results: clampLimit(input.limit),
      search_depth: 'basic',
    }),
  })
  if (!res.ok) {
    throw new Error(`Tavily request failed (${res.status}).`)
  }
  const data: unknown = await res.json()
  const results =
    isRecord(data) && Array.isArray(data.results) ? data.results : []
  const captured = nowIso()
  return results.filter(isRecord).map((r) => ({
    sourceType: 'web' as const,
    sourceName: 'tavily',
    title: pickString(r, 'title'),
    url: pickString(r, 'url'),
    publishedAt: pickString(r, 'published_date'),
    capturedAt: captured,
    text: truncate(
      pickString(r, 'content', 'snippet', 'raw_content') ?? '',
      MAX_RESULT_TEXT_CHARS,
    ),
    metadata: { score: r.score, query: input.query },
  }))
}

// --- Brave Search -----------------------------------------------------------
const brave: ProviderFn = async (apiKey, input) => {
  const url = new URL(endpoint('https://api.search.brave.com/res/v1/web/search'))
  url.searchParams.set('q', input.query)
  url.searchParams.set('count', String(clampLimit(input.limit)))
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  })
  if (!res.ok) {
    throw new Error(`Brave Search request failed (${res.status}).`)
  }
  const data: unknown = await res.json()
  const results =
    isRecord(data) && isRecord(data.web) && Array.isArray(data.web.results)
      ? data.web.results
      : []
  const captured = nowIso()
  return results.filter(isRecord).map((r) => ({
    sourceType: 'web' as const,
    sourceName: 'brave',
    title: pickString(r, 'title'),
    url: pickString(r, 'url'),
    publishedAt: pickString(r, 'page_age', 'age'),
    capturedAt: captured,
    text: truncate(
      pickString(r, 'description', 'snippet') ?? '',
      MAX_RESULT_TEXT_CHARS,
    ),
    metadata: { query: input.query },
  }))
}

// --- Serper (google) --------------------------------------------------------
const serper: ProviderFn = async (apiKey, input) => {
  const res = await fetch(endpoint('https://google.serper.dev/search'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: input.query, num: clampLimit(input.limit) }),
  })
  if (!res.ok) {
    throw new Error(`Serper request failed (${res.status}).`)
  }
  const data: unknown = await res.json()
  const results =
    isRecord(data) && Array.isArray(data.organic) ? data.organic : []
  const captured = nowIso()
  return results.filter(isRecord).map((r) => ({
    sourceType: 'web' as const,
    sourceName: 'serper',
    title: pickString(r, 'title'),
    url: pickString(r, 'link'),
    publishedAt: pickString(r, 'date'),
    capturedAt: captured,
    text: truncate(pickString(r, 'snippet') ?? '', MAX_RESULT_TEXT_CHARS),
    metadata: { position: r.position, query: input.query },
  }))
}

// --- Perplexity Search API --------------------------------------------------
const perplexity: ProviderFn = async (apiKey, input) => {
  const res = await fetch(endpoint('https://api.perplexity.ai/search'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: input.query,
      max_results: Math.min(20, clampLimit(input.limit)),
      search_context_size: 'low',
      ...(input.since ? { search_after_date_filter: toUsDate(input.since) } : {}),
      ...(input.until ? { search_before_date_filter: toUsDate(input.until) } : {}),
    }),
  })
  if (!res.ok) {
    throw new Error(`Perplexity Search request failed (${res.status}).`)
  }
  const data: unknown = await res.json()
  const results =
    isRecord(data) && Array.isArray(data.results) ? data.results : []
  const captured = nowIso()
  return results.filter(isRecord).map((r) => ({
    sourceType: 'web' as const,
    sourceName: 'perplexity',
    title: pickString(r, 'title'),
    url: pickString(r, 'url'),
    publishedAt: pickString(r, 'date', 'last_updated'),
    capturedAt: captured,
    text: truncate(pickString(r, 'snippet') ?? '', MAX_RESULT_TEXT_CHARS),
    metadata: {
      query: input.query,
      lastUpdated: pickString(r, 'last_updated'),
      requestId: isRecord(data) ? data.id : undefined,
    },
  }))
}

function toUsDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`
}

// --- Parallel Search MCP (anonymous, opt-in) ---------------------------------
const parallel: ProviderFn = async (_apiKey, input) => {
  const since = input.since ? toUtcDay(input.since) : undefined
  const until = input.until ? toUtcDay(input.until) : undefined
  const objective = [
    input.query,
    since ? `Find pages published on or after ${since}.` : '',
    until ? `Find pages published on or before ${until}.` : '',
  ].filter(Boolean).join('\n')
  const response = await callTool(
    {
      serverUrl: endpoint('https://search.parallel.ai/mcp'),
      userAgent: 'tiger-field-brief/0.1.0',
      timeoutMs: 30_000,
    },
    'web_search',
    { objective, search_queries: [input.query] },
  )
  // MCP returns structured content, with JSON text for clients using older
  // protocol versions. Do not turn an unexpected response into an empty run.
  const data: unknown = response.structured ?? JSON.parse(response.text)
  if (!isRecord(data) || !Array.isArray(data.results)) {
    throw new Error('Parallel search returned an invalid results payload.')
  }
  const captured = nowIso()
  return data.results.filter(isRecord).map((r) => {
    const published = pickString(r, 'publish_date')
    const publishedAt = published && !Number.isNaN(Date.parse(published))
      ? toUtcDay(published)
      : undefined
    return {
      sourceType: 'web' as const,
      sourceName: 'parallel',
      title: pickString(r, 'title'),
      url: pickString(r, 'url'),
      publishedAt,
      capturedAt: captured,
      text: truncate(
        Array.isArray(r.excerpts)
          ? r.excerpts.filter((e): e is string => typeof e === 'string').join('\n\n')
          : '',
        MAX_RESULT_TEXT_CHARS,
      ),
      metadata: { query: input.query, searchId: pickString(data, 'search_id') },
    }
  }).filter((r) =>
    // Unknown dates cannot establish that a result is inside a watchlist's
    // lookback window. Bounds are inclusive UTC calendar dates.
    (!since && !until) || (!!r.publishedAt &&
      (!since || r.publishedAt >= since) && (!until || r.publishedAt <= until)),
  ).slice(0, clampLimit(input.limit))
}

function toUtcDay(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error('Parallel search date bounds must be valid dates.')
  }
  return date.toISOString().slice(0, 10)
}

const PROVIDERS: Record<string, ProviderFn> = {
  tavily,
  brave,
  serper,
  perplexity,
  parallel,
}

export const webConnector: SourceConnector = {
  type: 'web',
  name: 'Web Search',
  requiredEnv: [
    'WEB_SEARCH_PROVIDER=parallel, or WEB_SEARCH_API_KEY / PERPLEXITY_API_KEY',
  ],
  configHint:
    'Set WEB_SEARCH_PROVIDER=parallel for keyless web search. Other providers use WEB_SEARCH_API_KEY (tavily | brave | serper | perplexity; default tavily). Perplexity also supports PERPLEXITY_API_KEY.',
  isConfigured() {
    const selected = provider()
    return selected in PROVIDERS && (selected === 'parallel' || !!apiKeyForProvider(selected))
  },
  async search(input) {
    const selected = provider()
    // Never forward another provider's stored credentials to anonymous MCP.
    const apiKey = selected === 'parallel' ? '' : apiKeyForProvider(selected)
    if (selected !== 'parallel' && !apiKey) throw new Error('Web search is not configured.')
    const fn = PROVIDERS[selected]
    if (!fn) {
      throw new Error(
        `Unsupported WEB_SEARCH_PROVIDER "${selected}". Use tavily, brave, serper, perplexity, or parallel.`,
      )
    }
    return fn(apiKey ?? '', input)
  },
}

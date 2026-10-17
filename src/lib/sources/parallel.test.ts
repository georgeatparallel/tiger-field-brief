import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  process.env = { ...originalEnv, WEB_SEARCH_PROVIDER: 'parallel' }
  delete process.env.WEB_SEARCH_API_KEY
  delete process.env.PERPLEXITY_API_KEY
  delete process.env.WEB_SEARCH_BASE_URL
})

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

type RpcRequest = {
  id?: number
  method: string
  params: Record<string, unknown>
}

function mockMcp(
  result: unknown,
  options: { textOnly?: boolean; sse?: boolean; host?: string } = {},
) {
  const requests: RpcRequest[] = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`${options.host ?? 'https://search.parallel.ai'}/mcp`)
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('User-Agent')).toBe('tiger-field-brief/0.1.0')
    expect(headers.get('Authorization')).toBeNull()
    expect(headers.get('MCP-Protocol-Version')).toBe('2025-03-26')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(String(init?.body)) as RpcRequest
    requests.push(body)
    if (body.method === 'initialize') {
      expect(body.params).toMatchObject({
        clientInfo: { name: 'tiger-field-brief', version: '0.1.0' },
      })
      return Response.json({ jsonrpc: '2.0', id: body.id, result: {
        protocolVersion: '2025-03-26', capabilities: { tools: {} },
      } }, { headers: { 'Mcp-Session-Id': 'parallel-test-session' } })
    }
    expect(headers.get('Mcp-Session-Id')).toBe('parallel-test-session')
    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 })
    }
    expect(body.method).toBe('tools/call')
    expect(body.params.name).toBe('web_search')
    const payload = {
      jsonrpc: '2.0', id: body.id,
      result: {
        ...(options.textOnly ? {} : { structuredContent: result }),
        content: [{ type: 'text', text: JSON.stringify(result) }],
      },
    }
    return options.sse
      ? new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      : Response.json(payload)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { requests, fetchMock }
}

const page = {
  title: 'Postgres analytics', url: 'https://www.tigerdata.com/',
  publish_date: '2026-06-30', excerpts: ['Columnstore analytics', 'TimescaleDB'],
}

describe('Parallel web provider through the connector registry', () => {
  it('is explicitly configured without credentials and produces normalized brief inputs', async () => {
    const { requests } = mockMcp({ search_id: 'search-123', results: [page] })
    const { getConnector, listSourceStatuses } = await import('./index')
    expect(listSourceStatuses().find((s) => s.type === 'web')).toMatchObject({
      configured: true, configHint: expect.stringContaining('WEB_SEARCH_PROVIDER=parallel'),
    })
    const results = await getConnector('web').search({ query: 'postgres analytics', limit: 2 })
    expect(requests.map((r) => r.method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/call',
    ])
    expect(requests.at(-1)?.params.arguments).toEqual({
      objective: 'postgres analytics', search_queries: ['postgres analytics'],
    })
    expect(results).toEqual([{
      sourceType: 'web', sourceName: 'parallel', title: page.title, url: page.url,
      publishedAt: page.publish_date, capturedAt: expect.any(String),
      text: 'Columnstore analytics\n\nTimescaleDB',
      metadata: { query: 'postgres analytics', searchId: 'search-123' },
    }])
    // These are the fields consumed by result persistence and brief assembly.
    expect(Number.isNaN(new Date(results[0].capturedAt).getTime())).toBe(false)
    expect(Number.isNaN(new Date(results[0].publishedAt!).getTime())).toBe(false)
  })

  it('never forwards stored keys, and honors the existing host override', async () => {
    process.env.WEB_SEARCH_API_KEY = 'other-provider-key'
    process.env.PERPLEXITY_API_KEY = 'saved-perplexity-key'
    process.env.WEB_SEARCH_BASE_URL = 'https://gateway.example.test/ignored'
    mockMcp({ results: [page] }, { host: 'https://gateway.example.test' })
    const { getConnector } = await import('./index')
    expect(await getConnector('web').search({ query: 'postgres' })).toHaveLength(1)
  })

  it('accepts JSON text over SSE for the older MCP protocol', async () => {
    mockMcp({ results: [page] }, { textOnly: true, sse: true })
    const { getConnector } = await import('./index')
    expect(await getConnector('web').search({ query: 'postgres' })).toMatchObject([
      { url: page.url, text: 'Columnstore analytics\n\nTimescaleDB' },
    ])
  })

  it('filters known dates before limiting, and caps text sent downstream', async () => {
    const { requests } = mockMcp({ results: [
      { ...page, publish_date: '2026-06-29' },
      { ...page, publish_date: null },
      { ...page, publish_date: 'invalid' },
      { ...page, excerpts: ['x'.repeat(2100), 123] },
      { ...page, publish_date: '2026-07-01' },
      { ...page, publish_date: '2026-07-02' },
    ] })
    const { getConnector } = await import('./index')
    const results = await getConnector('web').search({
      query: 'postgres', since: '2026-06-30T17:00:00Z', until: '2026-07-01', limit: 2,
    })
    expect(results.map((r) => r.publishedAt)).toEqual(['2026-06-30', '2026-07-01'])
    expect(results[0].text).toBe(`${'x'.repeat(2000)}\n…[truncated 100 chars]`)
    expect(requests.at(-1)?.params.arguments).toEqual({
      objective: 'postgres\nFind pages published on or after 2026-06-30.\nFind pages published on or before 2026-07-01.',
      search_queries: ['postgres'],
    })
  })

  it('keeps undated results for unbounded searches and applies the requested limit', async () => {
    mockMcp({ results: Array.from({ length: 12 }, () => ({ ...page, publish_date: null })) })
    const { getConnector } = await import('./index')
    const connector = getConnector('web')
    expect(await connector.search({ query: 'postgres' })).toHaveLength(10)
    expect(await connector.search({ query: 'postgres', limit: 1 })).toHaveLength(1)
  })

  it.each([{}, { results: null }])('rejects malformed structured results: %j', async (result) => {
    mockMcp(result)
    const { getConnector } = await import('./index')
    await expect(getConnector('web').search({ query: 'postgres' }))
      .rejects.toThrow('Parallel search returned an invalid results payload.')
  })

  it('rejects invalid date bounds before making a network request', async () => {
    const { fetchMock } = mockMcp({ results: [] })
    const { getConnector } = await import('./index')
    await expect(getConnector('web').search({ query: 'postgres', since: 'invalid' }))
      .rejects.toThrow('date bounds must be valid dates')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['initialize', 'tools/call'])('surfaces HTTP errors from %s', async (method) => {
    const { fetchMock } = mockMcp({ results: [] })
    const normal = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as RpcRequest
      return body.method === method ? new Response('unavailable', { status: 503 }) : normal(url, init)
    })
    const { getConnector } = await import('./index')
    await expect(getConnector('web').search({ query: 'postgres' }))
      .rejects.toThrow(`MCP ${method} failed (503).`)
  })

  it('surfaces MCP tool errors instead of silently returning an empty search', async () => {
    const { fetchMock } = mockMcp({ results: [] })
    const normal = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as RpcRequest
      return body.method === 'tools/call'
        ? Response.json({ id: body.id, result: {
            isError: true, content: [{ type: 'text', text: 'Search unavailable' }],
          } })
        : normal(url, init)
    })
    const { getConnector } = await import('./index')
    await expect(getConnector('web').search({ query: 'postgres' }))
      .rejects.toThrow('MCP tool web_search error: Search unavailable')
  })

  it('aborts a pending request using the configured 30-second timeout', async () => {
    const { fetchMock } = mockMcp({ results: [] })
    const normal = fetchMock.getMockImplementation()!
    const controller = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      expect(ms).toBe(30_000)
      return controller.signal
    })
    let pending!: () => void
    const started = new Promise<void>((resolve) => { pending = resolve })
    fetchMock.mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as RpcRequest
      if (body.method !== 'tools/call') return normal(url, init)
      expect(String(url)).toBe('https://search.parallel.ai/mcp')
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
        pending()
      })
    })
    const { getConnector } = await import('./index')
    const search = getConnector('web').search({ query: 'postgres' })
    const rejected = expect(search).rejects.toMatchObject({ name: 'TimeoutError' })
    await started
    controller.abort(new DOMException('Request timed out', 'TimeoutError'))
    await rejected
  })

  it('propagates transport cancellation without returning partial results', async () => {
    const { fetchMock } = mockMcp({ results: [] })
    const normal = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as RpcRequest
      if (body.method === 'tools/call') throw new DOMException('Cancelled', 'AbortError')
      return normal(url, init)
    })
    const { getConnector } = await import('./index')
    await expect(getConnector('web').search({ query: 'postgres' }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not configure web search unless a provider is explicitly enabled or has credentials', async () => {
    delete process.env.WEB_SEARCH_PROVIDER
    const { getConnector } = await import('./index')
    expect(getConnector('web').isConfigured()).toBe(false)
    await expect(getConnector('web').search({ query: 'postgres' }))
      .rejects.toThrow('Web search is not configured.')
  })

  it('preserves Tavily as default and honors explicit selection despite Perplexity credentials', async () => {
    delete process.env.WEB_SEARCH_PROVIDER
    process.env.WEB_SEARCH_API_KEY = 'tavily-key'
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.tavily.com/search')
      expect(JSON.parse(String(init?.body))).toMatchObject({ api_key: 'tavily-key' })
      expect(new Headers(init?.headers).get('User-Agent')).toBeNull()
      expect(init?.signal).toBeUndefined()
      return Response.json({ results: [{ title: 'Existing result', content: 'Existing text' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { getConnector } = await import('./index')
    expect(await getConnector('web').search({ query: 'postgres' }))
      .toMatchObject([{ sourceName: 'tavily', text: 'Existing text' }])
    process.env.PERPLEXITY_API_KEY = 'saved-key'
    process.env.WEB_SEARCH_PROVIDER = 'TAVILY'
    expect(await getConnector('web').search({ query: 'postgres' }))
      .toMatchObject([{ sourceName: 'tavily', text: 'Existing text' }])
  })
})

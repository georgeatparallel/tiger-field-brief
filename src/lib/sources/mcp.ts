import { isRecord } from './util'

/**
 * Minimal, dependency-free MCP (Model Context Protocol) client over the
 * Streamable HTTP transport (JSON-RPC 2.0 POST). It supports just what we need
 * for READ-ONLY source search: `initialize`, `tools/list`, and `tools/call`.
 *
 * This is intentionally a thin v0 wrapper. Different MCP servers expose
 * different tool names and argument/return shapes, so callers pass the tool
 * name (or a list of candidates) and defensively map the result. If you need a
 * fuller client later, swap this for the official `@modelcontextprotocol/sdk`.
 *
 * NOTE: never log auth tokens or full payloads from here.
 */

export type McpClientOptions = {
  serverUrl: string
  authToken?: string
  /** MCP protocol version advertised to the server. */
  protocolVersion?: string
  /** Identify the calling project on servers that accept a User-Agent. */
  userAgent?: string
  /** Optional per-request timeout, including reading the response body. */
  timeoutMs?: number
}

export type McpContent = {
  /** Best-effort text extracted from the tool result content blocks. */
  text: string
  /** Structured content, if the server returned `structuredContent`. */
  structured?: unknown
  /** Raw content blocks for callers that want to map them. */
  blocks: unknown[]
}

let requestId = 0
const DEFAULT_PROTOCOL_VERSION = '2025-03-26'

type McpSession = {
  initialized: boolean
  initPromise?: Promise<void>
  sessionId?: string
}

const sessions = new Map<string, McpSession>()

function protocolVersion(opts: McpClientOptions): string {
  return opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
}

function sessionKey(opts: McpClientOptions): string {
  // Token is intentionally not part of the key so it never appears in
  // diagnostics. Env changes require a process restart anyway.
  return `${opts.serverUrl}|${protocolVersion(opts)}`
}

async function rpc(
  opts: McpClientOptions,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const result = await postJsonRpc(opts, method, params, true)
  if (isRecord(result) && isRecord(result.error)) {
    const msg =
      typeof result.error.message === 'string' ? result.error.message : 'error'
    throw new Error(`MCP ${method} error: ${msg}`)
  }
  return isRecord(result) ? result.result : undefined
}

async function postJsonRpc(
  opts: McpClientOptions,
  method: string,
  params: Record<string, unknown>,
  expectResponse: boolean,
): Promise<unknown> {
  const session = sessions.get(sessionKey(opts))
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // MCP Streamable HTTP servers may stream via SSE; accept both.
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion(opts),
  }
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent
  if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`
  if (session?.sessionId && method !== 'initialize') {
    headers['Mcp-Session-Id'] = session.sessionId
  }

  const res = await fetch(opts.serverUrl, {
    method: 'POST',
    headers,
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(expectResponse ? { id: ++requestId } : {}),
      method,
      params,
    }),
  })
  if (!res.ok) {
    throw new Error(`MCP ${method} failed (${res.status}).`)
  }

  const sessionId = res.headers.get('mcp-session-id')
  if (session && sessionId) session.sessionId = sessionId

  if (!expectResponse || res.status === 202) return undefined

  const raw = await res.text()
  return parseMaybeSse(raw)
}

async function notify(
  opts: McpClientOptions,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  await postJsonRpc(opts, method, params, false)
}

/** Parse either a plain JSON body or an SSE stream containing JSON data lines. */
function parseMaybeSse(body: string): unknown {
  const trimmed = body.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed)
  }
  // SSE: take the last event whose `data:` payload parses as JSON. Multiple
  // data lines in one event are joined per the SSE framing rules.
  const events = trimmed.split(/\n\n+/)
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice('data:'.length).trim())
      .join('\n')
      .trim()
    if (!payload || payload === '[DONE]') continue
    try {
      return JSON.parse(payload)
    } catch {
      // keep looking
    }
  }
  throw new Error('MCP response was not valid JSON.')
}

async function ensureInitialized(opts: McpClientOptions): Promise<void> {
  const key = sessionKey(opts)
  let session = sessions.get(key)
  if (!session) {
    session = { initialized: false }
    sessions.set(key, session)
  }
  if (session.initialized) return
  if (session.initPromise) return session.initPromise

  session.initPromise = (async () => {
    await rpc(opts, 'initialize', {
      protocolVersion: protocolVersion(opts),
      capabilities: {},
      clientInfo: { name: 'tiger-field-brief', version: '0.1.0' },
    })
    await notify(opts, 'notifications/initialized', {}).catch(() => undefined)
    session.initialized = true
  })().finally(() => {
    if (session) session.initPromise = undefined
  })

  return session.initPromise
}

/** List available tool names from the server. */
export async function listTools(opts: McpClientOptions): Promise<string[]> {
  await ensureInitialized(opts)
  const result = await rpc(opts, 'tools/list', {})
  if (isRecord(result) && Array.isArray(result.tools)) {
    return result.tools
      .filter(isRecord)
      .map((t) => (typeof t.name === 'string' ? t.name : ''))
      .filter((n) => n.length > 0)
  }
  return []
}

/** Call a tool by name with arguments and return normalized content. */
export async function callTool(
  opts: McpClientOptions,
  name: string,
  args: Record<string, unknown>,
): Promise<McpContent> {
  await ensureInitialized(opts)
  const result = await rpc(opts, 'tools/call', { name, arguments: args })
  const blocks =
    isRecord(result) && Array.isArray(result.content) ? result.content : []
  const text = blocks
    .filter(isRecord)
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
  if (isRecord(result) && result.isError === true) {
    throw new Error(`MCP tool ${name} error: ${text || 'tool returned error'}`)
  }
  const structured = isRecord(result) ? result.structuredContent : undefined
  return { text, structured, blocks }
}

/**
 * Pick the first tool name that matches one of the preferred candidates
 * (case-insensitive substring match), so connectors work across servers that
 * name their search tool slightly differently.
 */
export function pickTool(
  available: string[],
  candidates: string[],
): string | undefined {
  for (const c of candidates) {
    const exact = available.find((t) => t.toLowerCase() === c.toLowerCase())
    if (exact) return exact
  }
  for (const c of candidates) {
    const partial = available.find((t) =>
      t.toLowerCase().includes(c.toLowerCase()),
    )
    if (partial) return partial
  }
  return undefined
}

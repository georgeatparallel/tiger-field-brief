# Tiger Field Brief 🐅

A lightweight internal tool that collects raw GTM signal for TigerData's
time-series business and turns it into a **field intelligence loop** — scheduled
watchlists, daily/source briefs, weekly synthesis reports, and recommended PMM
actions.

Use it manually by pasting notes, or let watchlists pull read-only source signal
from web, X, and Slack. The app extracts structured GTM signals, generates
briefs, and rolls the week into action items for PMM, Sales, Docs, Product, and
DevRel.

## Stack

- **TanStack Start** (React + TypeScript) — file-based routing + server functions
- **Tailwind CSS v4** — styling
- **Postgres** + **Prisma** — database & ORM
- **Zod** — strict validation of LLM output before anything is saved
- **Anthropic (Claude)** by default, or **OpenAI** — LLM provider (configurable)

## Pages

| Route               | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `/`                 | Landing page                                                   |
| `/intelligence`     | Scheduled watchlists, latest reports, and action queue         |
| `/intelligence/reports/:id` | Weekly synthesis report + generated actions            |
| `/new`              | Form to paste raw notes + metadata and generate a brief        |
| `/sources`          | Configuration status of each source (manual / web / X / Slack) |
| `/sources/search`   | Search external sources, select results, generate a brief      |
| `/sources/runs`     | History of past source searches                                |
| `/sources/runs/:id` | A single search run, its results, and any generated brief      |
| `/briefs`           | Saved briefs, reverse-chronological                            |
| `/briefs/:id`       | Full brief, the raw notes used, and extracted signals          |
| `/signals`          | Table of all extracted signals with filters + search           |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start Postgres

Any Postgres 14+ works. The quickest local option is Docker:

```bash
docker run -d --name tfb-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=tiger_field_brief \
  -p 5432:5432 postgres:16
```

### 3. Configure environment

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

> **Note:** this is a Vite/TanStack app, so it uses `.env` (the Vite/Prisma
> convention) rather than Next.js's `.env.local`. Both `.env` and `*.local`
> files are git-ignored.

```dotenv
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/tiger_field_brief?schema=public"

# "anthropic" (default) or "openai"
LLM_PROVIDER="anthropic"

# Anthropic (Claude)
ANTHROPIC_API_KEY="sk-ant-..."
# ANTHROPIC_MODEL="claude-3-5-sonnet-latest"

# OpenAI (only needed if LLM_PROVIDER=openai)
# OPENAI_API_KEY="sk-..."
# OPENAI_MODEL="gpt-4o-mini"
```

The API key is only ever read in server functions (`src/server/*`) and is never
exposed to the client.

### 4. Run migrations

```bash
npx prisma migrate dev
```

### 5. Start the dev server

```bash
npm run dev
```

Open http://localhost:3000.

## How it works

1. `/new` posts the raw notes + metadata to the `generateBrief` server function.
2. `generateFieldBrief(rawNote, metadata)` (`src/server/llm.ts`) calls the LLM
   with a fixed TigerData GTM prompt.
3. The response is parsed and validated with **Zod** (`src/server/schema.ts`).
   If the LLM returns invalid JSON or the wrong shape, a clear error is shown
   and **nothing is saved**.
4. On success the raw note, brief, and signals are written to Postgres in a
   single transaction, and you're redirected to the brief.

## External sources

Beyond manual paste, the app can pull **read-only** GTM signal from external
sources and feed it into the same brief pipeline. Every integration is optional
and environment-variable driven; if a source is not configured it shows as
**Not configured** on `/sources` and is skipped (the app never breaks).

> **Read-only safety.** No connector ever writes to a remote system. X is
> search/read only — never post, like, reply, repost, follow, or DM. Slack is
> search/read only — never send/update messages, create canvases, or modify
> users/channels. Credentials are read only in server code (`src/server/*`,
> `src/lib/sources/*`) and are never exposed to the client.

### 1. Web search

For Tavily, Brave, Serper, or Perplexity, set an API key and optionally pick a
provider. **Tavily is the default.**
If `PERPLEXITY_API_KEY` is set and `WEB_SEARCH_PROVIDER` is unset, the app uses
Perplexity automatically.

```dotenv
WEB_SEARCH_PROVIDER="tavily"   # tavily (default) | brave | serper | perplexity | parallel
WEB_SEARCH_API_KEY="..."
PERPLEXITY_API_KEY="..."       # optional; preferred for WEB_SEARCH_PROVIDER=perplexity
WEB_SEARCH_BASE_URL=""         # optional: override host (proxy / self-hosted / testing)
```

Returns page title, URL, snippet/extracted text, published date (when
available), and a captured timestamp. To add a provider, implement a function in
`src/lib/sources/web.ts` and register it in `PROVIDERS`.

For free web search without an account or search API key, select
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp):

```dotenv
WEB_SEARCH_PROVIDER="parallel"
```

Restart the app, confirm Web Search is configured at `/sources`, then choose
**Web Search** at `/sources/search` or **web** in a watchlist. Parallel uses Fast mode over
Streamable HTTP at `https://search.parallel.ai/mcp` and returns page excerpts
for the existing search-to-brief flow. No search API key is sent, even if other
provider keys are set. Anonymous access has lower rate limits and is intended
for light use; source errors appear on the search page or in watchlist status.

The result limit is applied locally to the returned batch, so fewer results may
be available. Since/until bounds use inclusive UTC calendar dates and exclude
results with unknown publication dates. Requests time out after 30 seconds.
`WEB_SEARCH_BASE_URL` also applies to Parallel, replacing the host while keeping
the `/mcp` path. Leave it unset to use the public service. Existing provider
defaults and Perplexity auto-selection remain unchanged unless you explicitly
select Parallel.

### 2. X (Twitter) via MCP

X search runs through an MCP server. The hosted X server supports a simple
read-only app-only Bearer route, which is the recommended v0 setup here:

```dotenv
X_MCP_SERVER_URL="https://api.x.com/mcp"
X_MCP_AUTH_TOKEN="..."          # app-only Bearer token; keep server-side only
X_MCP_SEARCH_TOOL=""            # optional: explicit search tool name
X_MCP_PROTOCOL_VERSION="2025-06-18"
```

The connector auto-detects a search tool (`search_posts_all`, `search_posts`,
`search_tweets`, `search`, …). If your server names it differently, set
`X_MCP_SEARCH_TOOL`. The MCP client (`src/lib/sources/mcp.ts`) is a thin
JSON-RPC-over-HTTP wrapper that performs the Streamable HTTP initialize
handshake and carries the `Mcp-Session-Id` header between requests.

### 3. Slack (MCP or Web API)

Two modes, MCP preferred:

```dotenv
# Mode A — Slack MCP (preferred)
SLACK_MCP_SERVER_URL="https://your-slack-mcp-server/mcp"
SLACK_MCP_AUTH_TOKEN="..."
SLACK_MCP_SEARCH_TOOL=""        # optional: explicit search tool name

# Mode B — Slack Web API (search.messages)
SLACK_BOT_TOKEN="xoxp-..."
```

> `search.messages` requires a **user** token (`xoxp-…`) with the `search:read`
> scope. A bot token (`xoxb-…`) cannot call search — use MCP mode in that case.

Slack is **read-only**: search messages, and read text, channel, author,
timestamp, and permalink when available.

### Running a source search

1. Open `/sources` to confirm which integrations are configured.
2. Go to `/sources/search`, pick a source (or **All configured**), type a query
   (or click a **default search** chip), optionally set since/until/limit, and
   click **Search Sources**. The run + results are saved.
3. Tick the results you want and click **Generate Brief From Selected
   Results**. Selected results are combined into one raw note (with source
   metadata preserved), run through `generateFieldBrief()`, saved as a normal
   `RawNote` + `Signal`s + `Brief`, linked back to the source results, and you
   are redirected to the brief.
4. Review past searches at `/sources/runs`.

## GTM intelligence loop

The main product surface is `/intelligence`. It reframes the app from “search
when I remember” into a passive GTM radar:

1. **Watchlists** store recurring searches with a source (`web`, `x`, `slack`,
   or `all`), cadence (`daily` or `weekly`), lookback window, limit, next run,
   and last run status.
2. **Run Due** executes due watchlists against configured sources, persists
   `SourceSearchRun` / `SourceResult` rows, then feeds the results through the
   normal `generateFieldBrief()` pipeline so watchlist output becomes ordinary
   `RawNote` + `Signal` + `Brief` data.
3. **Generate Weekly Report** looks across recent source runs, extracted
   signals, and briefs, then creates an `IntelligenceReport`.
4. Each report creates an **Action Queue** with owner/use-case tags such as
   `PMM`, `Sales`, `Docs`, `Product`, `sales_enablement`, `positioning`,
   `docs`, or `product_feedback`.

Default watchlists are seeded the first time `/intelligence` loads:

- ClickHouse and InfluxDB pressure
- Migration and retention pain
- Product confusion
- Market narrative

This is intentionally a pragmatic v0. The database already tracks cadence and
`nextRunAt`, so an external scheduler can later call the same server-side runner.
For now, `/intelligence` exposes a safe in-app **Run Due** control rather than a
public cron endpoint.

### Source quality

External results are **raw market signals, not verified facts**. The prompt asks
the model to distinguish customer/prospect, internal, public-market, competitor,
and weak/noisy evidence, and not to overstate weak signal. Each extracted signal
carries `sourceQuality` (`high|medium|low`) and `signalType`
(`customer|prospect|internal|public_market|competitor|unknown`).

### Sensitive data

- **Slack results may contain confidential internal information.** Be deliberate
  about what you convert into a brief.
- Result text is truncated per result (`MAX_RESULT_TEXT_CHARS`) and the combined
  raw note is capped (`MAX_COMBINED_BRIEF_CHARS`) so no more than necessary is
  sent to the LLM. Original metadata is preserved in the database.
- Tokens, API keys, auth headers, and full source payloads are never logged.

## Project layout

```
prisma/schema.prisma           # RawNote, Signal, Brief, SourceSearchRun, SourceResult, Watchlist, IntelligenceReport, ActionItem
src/server/db.ts               # Prisma client singleton
src/server/schema.ts           # Zod schemas (input + LLM output + source search + reports)
src/server/llm.ts              # generateFieldBrief() / generateIntelligenceReport()
src/server/briefs.ts           # server fns: generate / list / get / filter + persist helper
src/server/sources.ts          # server fns: source search / runs / generate-from-results
src/server/intelligence.ts     # watchlists, scheduled runs, weekly reports, action queue
src/lib/sources/               # read-only source connector layer
  types.ts                     #   shared SourceConnector / SourceSearchResult types
  web.ts                       #   web search (tavily | brave | serper | perplexity | parallel)
  x.ts                         #   X via MCP (read-only)
  slack.ts                     #   Slack via MCP or Web API (read-only)
  mcp.ts                       #   minimal MCP JSON-RPC client
  index.ts                     #   connector registry + status helpers
src/config/default-searches.ts # default saved search groups
src/routes/intelligence/       # /intelligence and /intelligence/reports/$id
src/routes/sources/            # /sources, /sources/search, /sources/runs[, /$id]
src/routes/new.tsx             # /new
src/routes/briefs/             # /briefs and /briefs/$id
src/routes/signals.tsx         # /signals
```

## Useful commands

```bash
npm run dev          # start dev server on :3000
npm run build        # production build
npx tsc --noEmit     # typecheck
npx prisma studio    # browse the database
```

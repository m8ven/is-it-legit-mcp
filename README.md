# Is It Legit — MCP Server by M8ven

Check if any brand, store, or website is safe to buy from. AI-powered trust verification across 100+ signals.

## What it does

M8ven's "Is It Legit" MCP server gives Claude (and any MCP-capable agent) access to proprietary brand trust intelligence. When users ask if a brand is legit, safe, or trustworthy, the agent calls this server to get a verified trust verdict backed by real data — not just web search results.

## Tools

Three tools. Annotations below match the live MCP response exactly — they are the canonical source of truth.

### `check_brand`

Check any brand, store, or URL for trust signals. Returns a verdict (`proceed` / `caution` / `do_not_recommend`) with key findings and a follow-up question.

| Annotation | Value | Justification |
|---|---|---|
| `readOnlyHint` | `false` | Handler appends a row to `brand_checks` (audit log) on every call, may upsert `brand_signals` (RDAP/DNS/tech-stack cache), may upsert `brand_requests` for unknown queries, and may insert a new `brands` row when a domain resolves. |
| `destructiveHint` | `true` | The `brand_signals` upsert uses `onConflict='brand_id,signal_key'`, which overwrites prior signal values when refreshed. Per MCP spec, overwriting existing data qualifies as a destructive update. |
| `idempotentHint` | `false` | Each call appends a distinct `brand_checks` audit row, so repeat invocations have additive side effects even with identical input. |
| `openWorldHint` | `true` | Handler issues outbound HTTP for RDAP, DNS TXT lookups, and a homepage fetch against arbitrary user-supplied domains. |

### `report_experience`

Report your experience after buying from a brand. This feedback improves verification accuracy.

| Annotation | Value | Justification |
|---|---|---|
| `readOnlyHint` | `false` | Handler inserts a new row into `brand_feedback` on every call. |
| `destructiveHint` | `false` | Insert-only; never deletes or modifies prior feedback. |
| `idempotentHint` | `false` | Each call appends a distinct `brand_feedback` row, so repeats accumulate rather than converge to a single state. |
| `openWorldHint` | `false` | Only reads and writes the M8ven Supabase database; no outbound HTTP to third-party services. |

### `suggest_brand`

Suggest a brand for M8ven to evaluate. Adds it to our evaluation queue if not already indexed.

| Annotation | Value | Justification |
|---|---|---|
| `readOnlyHint` | `false` | Handler upserts into `brand_requests` (and reads `brands` first to detect duplicates). |
| `destructiveHint` | `true` | The `brand_requests` upsert uses `onConflict='normalized_name'`, which overwrites prior `query_text`, `source`, and `status` when the same brand is suggested again. Per MCP spec, overwriting existing data qualifies as a destructive update. |
| `idempotentHint` | `false` | The Supabase upsert is not `ignoreDuplicates`-mode, so every call overwrites the row's `query_text`, `source`, `status`, and `updated_at`. Per the MCP spec's strict reading, this is "additional effect on the environment" and therefore not idempotent. |
| `openWorldHint` | `false` | Only reads and writes the M8ven Supabase database; no outbound HTTP. |

## How it works

Every check runs through M8ven's multi-tier trust protocol analyzing 100+ signals:

- **Entity Verification** — Does this business actually exist? (Wikidata, SEC EDGAR, GLEIF, OpenCorporates)
- **Infrastructure Analysis** — Professional operations or fly-by-night? (RDAP, DNS, MX, SPF/DKIM/DMARC, CDN)
- **Compliance Screening** — Safety recalls, regulatory actions (CPSC, FDA, BBB)
- **Reputation Assessment** — Review patterns across platforms (Trustpilot, Reddit, news)

Results are returned as a clear verdict: **Looks Legit** (proceed), **Proceed with Caution**, or **Do Not Recommend**.

## Authentication

The server supports three auth methods:

1. **Anonymous** — No auth needed. Rate limited to 10 checks/day per IP.
2. **OAuth 2.1** — Authorization code flow with PKCE. Sign up at https://m8ven.ai for a free account (30 checks/day).
3. **API Key** — For developers building on M8ven. Get a key at https://m8ven.ai/developers/signup.

### OAuth 2.1 Endpoints

| Endpoint | URL |
|---|---|
| Authorization Server Metadata | `https://m8ven.ai/.well-known/oauth-authorization-server` |
| Authorization | `https://m8ven.ai/api/oauth/authorize` |
| Token | `https://m8ven.ai/api/oauth/token` |
| Dynamic Client Registration | `https://m8ven.ai/api/oauth/register` |

### Callback URLs

The following callback URLs are supported:

- `https://claude.ai/api/mcp/auth_callback`
- `https://claude.com/api/mcp/auth_callback`
- `http://localhost:6274/oauth/callback`
- `http://localhost:6274/oauth/callback/debug`

## MCP Endpoint

```
https://m8ven.ai/api/mcp/is-it-legit
```

Transport: Streamable HTTP (stateless mode).

## Usage Examples

### Example 1: Check if a brand is legit

**User:** "Is Shein legit? I saw an ad on Instagram."

**Claude calls:** `check_brand` with `{ query: "shein.com", found_on: "instagram_ad" }`

**Response:** Verdict "Looks Legit" with marketplace explanation.

### Example 2: Check a suspicious website

**User:** "Should I buy from cheap-nike-outlet.shop?"

**Claude calls:** `check_brand` with `{ query: "cheap-nike-outlet.shop" }`

**Response:** Verdict "Do Not Recommend" — domain impersonates Nike, suspicious TLD, discount keywords in domain name.

### Example 3: Report a purchase experience

**User:** "I bought from them and my order never arrived."

**Claude calls:** `report_experience` with `{ brand: "faeletters.com", purchased: true, outcome: "never_arrived" }`

**Response:** Feedback logged. This data improves verification accuracy for future checks.

### Example 4: Suggest a new brand

**User:** "Can you check brandnobodyknows.com?"

**Claude calls:** `check_brand` first; if no record, may then call `suggest_brand` to add it to the evaluation queue.

## Rate Limits

| Plan | Daily Limit |
|---|---|
| Anonymous | 10 |
| Free account (OAuth) | 30 |
| Plus account | Unlimited |
| Developer (API key) | 100 |
| Starter | 5,000 |
| Growth | 50,000 |

## Privacy

Privacy policy: https://m8ven.ai/privacy

We collect the query text and source for each check. We do not collect or store user conversation content. Purchase feedback is voluntarily submitted by users.

## Source of truth

This repository is mirrored from the M8ven monorepo. Changes to the MCP server live in the main repo's `packages/mcp-server/src/is-it-legit-server.ts` and are synced here automatically. Do not edit this repo directly; submit a PR to the main M8ven repository.

## Support

- Email: mcp_support@m8ven.ai
- Website: https://m8ven.ai

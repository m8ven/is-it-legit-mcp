import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

/**
 * Unit tests for the Is It Legit MCP server.
 *
 * The Supabase client module is mocked so no test ever needs network access
 * or credentials. Each supabase.from(table) call returns a chainable builder
 * that records the query and resolves whatever the per-test `db.handler`
 * decides. Tools are exercised end-to-end through the real McpServer over an
 * in-memory transport, so tool registration, input validation, handler logic,
 * and error wrapping are all covered.
 */

type RecordedCall = { method: string; args: any[] }
type QueryResult = { data?: any; error?: any; count?: number | null }

const db = vi.hoisted(() => ({
  // Per-test resolver: (table, recorded query chain) => QueryResult.
  // Throwing simulates a backend outage.
  handler: null as null | ((table: string, calls: RecordedCall[]) => QueryResult),
  // Every completed query chain, for asserting on writes.
  log: [] as Array<{ table: string; calls: RecordedCall[] }>,
}))

vi.mock('./lib/supabase.js', () => {
  const CHAIN_METHODS = ['select', 'eq', 'ilike', 'limit', 'single', 'insert', 'upsert', 'update', 'order']
  function builder(table: string) {
    const calls: RecordedCall[] = []
    const b: any = {}
    for (const method of CHAIN_METHODS) {
      b[method] = (...args: any[]) => {
        calls.push({ method, args })
        return b
      }
    }
    // Awaiting (or .then-ing) the chain resolves it via the test's handler.
    b.then = (onFulfilled: any, onRejected: any) => {
      db.log.push({ table, calls })
      let result: QueryResult
      try {
        result = db.handler ? db.handler(table, calls) : { data: null, error: null, count: null }
      } catch (err) {
        return Promise.reject(err).then(onFulfilled, onRejected)
      }
      return Promise.resolve({ data: null, error: null, count: null, ...result }).then(onFulfilled, onRejected)
    }
    return b
  }
  return {
    supabase: { from: (table: string) => builder(table) },
    APP_BASE_URL: 'https://m8ven.ai',
  }
})

// Import after the mock so the server module binds to the mocked client.
const { createIsItLegitServer } = await import('./is-it-legit-server.js')

const TOOL_NAMES = ['check_brand', 'report_experience', 'suggest_brand']

function called(table: string, method: string): RecordedCall[] {
  return db.log
    .filter((entry) => entry.table === table)
    .flatMap((entry) => entry.calls)
    .filter((call) => call.method === method)
}

async function setup() {
  const server = createIsItLegitServer('test')
  const client = new Client({ name: 'is-it-legit-tests', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

let client: Client

beforeEach(async () => {
  db.handler = null
  db.log = []
  // No test may touch the network.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network disabled in tests')
  }))
  ;({ client } = await setup())
})

afterEach(async () => {
  await client.close()
  vi.unstubAllGlobals()
})

async function call(name: string, args: Record<string, unknown>) {
  const result: any = await client.callTool({ name, arguments: args })
  return result
}

// ============================================================
// Tool registration
// ============================================================
describe('tool registration', () => {
  it('declares exactly check_brand, report_experience, and suggest_brand', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const tool of tools) {
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeTruthy()
    }
  })
})

// ============================================================
// Tool: check_brand
// ============================================================
describe('check_brand', () => {
  it('rejects a query that is too short', async () => {
    const result = await call('check_brand', { query: 'a' })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent.error).toBe('Query too short')
  })

  it('rejects a call missing the required query argument', async () => {
    const result = await call('check_brand', {})
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Input validation error')
  })

  it('returns a proceed verdict for a curated known brand', async () => {
    const patagonia = {
      id: 'brand-1',
      name: 'Patagonia',
      slug: 'patagonia',
      url: 'https://patagonia.com',
      domain_name: 'patagonia.com',
      source_platform: 'curated_known',
      brand_type: 'brand',
    }
    db.handler = (table, calls) => {
      if (table === 'brands') return { data: [patagonia] }
      if (table === 'brand_signals') return { data: [] }
      if (table === 'brand_checks') {
        const isCount = calls.some((c) => c.method === 'select' && c.args[1]?.count === 'exact')
        return isCount ? { count: 12 } : {}
      }
      return {}
    }

    const result = await call('check_brand', { query: 'Patagonia' })
    expect(result.isError).toBeFalsy()
    const out = result.structuredContent
    expect(out.brand).toBe('Patagonia')
    expect(out.verdict).toBe('proceed')
    expect(out.verdict_label).toBe('Looks Legit')
    expect(out.findings).toContain('This is a verified, established entity in our trust database')
    expect(out.community_data).toMatchObject({ times_checked: 12, in_database: true })
    expect(out.trust_tiers['Entity verification']).toBe('Passed')
    expect(out.next_question?.type).toBe('concern')
    expect(out.more_info_url).toContain(encodeURIComponent('Patagonia'))
    // The check is recorded for community stats.
    expect(called('brand_checks', 'insert').length).toBeGreaterThan(0)
    // The text content mirrors the structured content.
    expect(JSON.parse(result.content[0].text).verdict).toBe('proceed')
  })

  it('returns do_not_recommend for a domain with multiple red flags, without any enrichment', async () => {
    // Unknown to the database: every lookup misses.
    db.handler = () => ({ data: null })

    const result = await call('check_brand', { query: 'nike-outlet-discount.shop' })
    expect(result.isError).toBeFalsy()
    const out = result.structuredContent
    expect(out.verdict).toBe('do_not_recommend')
    expect(out.findings.length).toBeGreaterThanOrEqual(2)
    expect(out.findings.join(' ')).toContain('nike')
    expect(out.community_data.in_database).toBe(false)
    // Fast path: verdict from domain analysis alone, no outbound HTTP.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    // The suspicious query is still tracked.
    expect(called('brand_checks', 'insert').length).toBeGreaterThan(0)
  })

  it('asks a found_on follow-up once a concern is provided', async () => {
    const brand = {
      id: 'brand-2',
      name: 'Acme Goods',
      slug: 'acme-goods',
      url: 'https://acmegoods.com',
      domain_name: 'acmegoods.com',
      source_platform: 'curated_known',
      brand_type: 'brand',
    }
    db.handler = (table) => {
      if (table === 'brands') return { data: [brand] }
      if (table === 'brand_signals') return { data: [] }
      return { count: 0 }
    }

    const result = await call('check_brand', { query: 'Acme Goods', concern: 'returns' })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent.next_question?.type).toBe('found_on')
  })

  it('degrades to a caution verdict when the backend fails, instead of crashing', async () => {
    db.handler = () => {
      throw new Error('supabase unreachable')
    }

    const result = await call('check_brand', { query: 'Patagonia' })
    expect(result.isError).toBeFalsy()
    const out = result.structuredContent
    expect(out.verdict).toBe('caution')
    expect(out.recommendation).toContain('temporary issue')
    expect(out.note).toContain('encountered an error')
  })
})

// ============================================================
// Tool: report_experience
// ============================================================
describe('report_experience', () => {
  it('records feedback for a known brand', async () => {
    db.handler = (table, calls) => {
      if (table === 'brands' && calls.some((c) => c.method === 'eq' && c.args[0] === 'slug')) {
        return { data: { id: 'brand-1', name: 'Acme' } }
      }
      return { data: null }
    }

    const result = await call('report_experience', {
      brand: 'Acme',
      purchased: true,
      outcome: 'great',
      details: 'Arrived on time',
    })
    expect(result.isError).toBeFalsy()
    const out = result.structuredContent
    expect(out.success).toBe(true)
    expect(out.message).toContain('Acme')

    const inserts = called('brand_feedback', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].args[0]).toMatchObject({
      brand_id: 'brand-1',
      did_purchase: true,
      issue_type: 'great',
      comment: 'Arrived on time',
    })
  })

  it('directs the caller to check_brand when the brand is unknown', async () => {
    db.handler = () => ({ data: null })

    const result = await call('report_experience', { brand: 'Ghost Brand Co', purchased: false })
    expect(result.isError).toBeFalsy()
    const out = result.structuredContent
    expect(out.success).toBe(false)
    expect(out.message).toContain('check_brand')
    // Nothing is written when the brand cannot be resolved.
    expect(called('brand_feedback', 'insert')).toHaveLength(0)
  })

  it('rejects a call missing the required purchased argument', async () => {
    const result = await call('report_experience', { brand: 'Acme' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Input validation error')
  })

  it('returns an isError result when the backend fails', async () => {
    db.handler = () => {
      throw new Error('supabase unreachable')
    }

    const result = await call('report_experience', { brand: 'Acme', purchased: true })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toBe('supabase unreachable')
  })
})

// ============================================================
// Tool: suggest_brand
// ============================================================
describe('suggest_brand', () => {
  it('reports when a brand is already indexed', async () => {
    db.handler = (table, calls) => {
      if (table === 'brands' && calls.some((c) => c.method === 'eq' && c.args[0] === 'slug')) {
        return { data: { name: 'Acme', slug: 'acme' } }
      }
      return { data: null }
    }

    const result = await call('suggest_brand', { brand: 'Acme' })
    expect(result.isError).toBeFalsy()
    const out = result.structuredContent
    expect(out.already_indexed).toBe(true)
    expect(out.message).toContain('Acme')
    // No new request is queued for an indexed brand.
    expect(called('brand_requests', 'upsert')).toHaveLength(0)
  })

  it('queues an evaluation request for a new brand', async () => {
    db.handler = () => ({ data: null })

    const result = await call('suggest_brand', { brand: 'Fresh New Brand' })
    expect(result.isError).toBeFalsy()
    const out = result.structuredContent
    expect(out.already_indexed).toBe(false)
    expect(out.message).toContain('evaluation queue')

    const upserts = called('brand_requests', 'upsert')
    expect(upserts).toHaveLength(1)
    expect(upserts[0].args[0]).toMatchObject({
      query_text: 'Fresh New Brand',
      normalized_name: 'fresh-new-brand',
      status: 'pending',
    })
  })

  it('rejects a call missing the required brand argument', async () => {
    const result = await call('suggest_brand', {})
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Input validation error')
  })

  it('returns an isError result when the backend fails', async () => {
    db.handler = () => {
      throw new Error('supabase unreachable')
    }

    const result = await call('suggest_brand', { brand: 'Acme' })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toBe('supabase unreachable')
  })
})

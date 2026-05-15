#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createIsItLegitServer } from './is-it-legit-server.js'

async function main() {
  const server = createIsItLegitServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Is It Legit MCP server running on stdio')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

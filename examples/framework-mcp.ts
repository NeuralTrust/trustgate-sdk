/**
 * The same consumer, handed to a framework that brings its own MCP client.
 *
 * There is no tool list and no execution loop here: the framework lists and
 * calls for itself. All the SDK contributes is a checked URL and its headers.
 */
import { Agent, run } from '@openai/agents'
import { MCPServerStreamableHttp } from '@openai/agents-mcp'
import { TrustGate } from '@neuraltrust/trustgate'

const tg = new TrustGate()
const handle = await tg.connect({ requires: ['notion_search'] })

const server = new MCPServerStreamableHttp({
	url: handle.mcp.url,
	requestInit: { headers: handle.mcp.headers },
})

const agent = new Agent({
	name: 'Support',
	instructions: 'Answer from the runbooks.',
	mcpServers: [server],
})

console.log((await run(agent, 'what do I do when the ingest queue backs up?')).finalOutput)

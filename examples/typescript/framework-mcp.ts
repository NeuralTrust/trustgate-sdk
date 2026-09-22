/**
 * The same application, handed to a framework that brings its own MCP client.
 *
 * There is no tool list and no execution loop here: the framework lists and
 * calls for itself. All the SDK contributes is a checked URL and its headers —
 * and the model endpoint, so this file holds no OpenAI key either.
 *
 *     npm run framework
 */
import { Agent, MCPServerStreamableHttp, run, setDefaultOpenAIKey } from '@openai/agents'
import { TrustGate } from '@neuraltrust/trustgate'

import { fail, gatewayEnv } from './config.ts'

const REQUIRES = ['list_issues']
const MODEL = 'gpt-5.2'
const QUESTION = 'what do I do when the ingest queue backs up?'

gatewayEnv()

const tg = new TrustGate()
const application = await tg.connect({ requires: REQUIRES }).catch(fail)

// The gateway speaks the OpenAI API, so the framework's own client points at it.
// Set through the key and the base-URL variable rather than by handing over a
// client: the agents SDK bundles its own copy of `openai`, and two copies of a
// class are two types.
const llm = await tg.llm().catch(fail)
process.env.OPENAI_BASE_URL = llm.baseUrl
setDefaultOpenAIKey(llm.apiKey)

const server = new MCPServerStreamableHttp({
	url: application.mcp.url,
	requestInit: { headers: application.mcp.headers },
})
await server.connect()

try {
	const agent = new Agent({
		name: 'Support',
		instructions: 'Answer from the runbooks.',
		model: MODEL,
		mcpServers: [server],
	})
	console.log((await run(agent, QUESTION)).finalOutput)
} finally {
	await server.close()
}

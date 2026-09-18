/**
 * An agent that acts as itself, calling the Responses API directly.
 *
 * Nothing here knows an MCP client exists: the SDK lists the consumer's tools,
 * translates them for OpenAI, and runs the calls back through the gateway.
 */
import OpenAI from 'openai'
import { ToolFormat, TrustGate, MissingToolsError, UpstreamNotConnectedError } from '@neuraltrust/trustgate'

// One secret: the gateway resolves which consumers this key reaches.
const tg = new TrustGate()

const agent = await tg.connect({ requires: ['notion_search'] }).catch((error) => {
	if (error instanceof MissingToolsError) {
		console.error(`ask your admin to add ${error.missing.join(', ')} to this application`)
	}
	if (error instanceof UpstreamNotConnectedError) {
		console.error(`sign in to ${error.providers.join(', ')} at ${error.connectUrl}`)
	}
	throw error
})

// Models through the gateway too, so the whole agent is governed by one key.
const llm = await tg.llm()
const openai = new OpenAI({ baseURL: llm.baseUrl, apiKey: llm.apiKey })

const { tools, execute, warnings } = agent.toolkit(ToolFormat.OpenAIResponses, { strict: true })
for (const warning of warnings) {
	console.warn(`${warning.tool} is not under strict mode: ${warning.reason}`)
}

let response = await openai.responses.create({
	model: 'gpt-5.2',
	tools,
	input: [{ role: 'user', content: 'find the incident runbook and summarise it' }],
})

while (response.output.some((item) => item.type === 'function_call')) {
	response = await openai.responses.create({
		model: 'gpt-5.2',
		tools,
		previous_response_id: response.id,
		input: await execute(response.output),
	})
}

console.log(response.output_text)

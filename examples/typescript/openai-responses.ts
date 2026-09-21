/**
 * An agent that acts as itself, calling the Responses API directly.
 *
 * Nothing here knows an MCP client exists: the SDK lists the consumer's tools,
 * translates them for OpenAI, and runs the calls back through the gateway.
 *
 *     npm run openai
 */
import OpenAI from 'openai'
import {
	MissingToolsError,
	ToolFormat,
	TrustGate,
	UpstreamNotConnectedError,
} from '@neuraltrust/trustgate'

import { fail, gatewayEnv } from './config.ts'

// Replace with a tool your application actually carries. The names are the
// server's own, as its Routing tab lists them.
const REQUIRES = ['notion_search']
const MODEL = 'gpt-5.2'
const QUESTION = 'find the incident runbook and summarise it'

gatewayEnv()

// One secret: the gateway resolves which consumers this key reaches.
const tg = new TrustGate()

const agent = await tg.connect({ requires: REQUIRES }).catch((error: unknown) => {
	if (error instanceof MissingToolsError) {
		fail(`ask your admin to add ${error.missing.join(', ')} to this application`)
	}
	if (error instanceof UpstreamNotConnectedError) {
		fail(`sign in to ${error.providers.join(', ')} at ${error.connectUrl}`)
	}
	return fail(error)
})

if (!('toolkit' in agent)) {
	fail(
		'this application acts for end users, so it has no toolkit of its own — ' +
			'see end_user_agent.py for that shape.'
	)
}

// Models through the gateway too, so the whole agent is governed by one key —
// there is no OpenAI key in this file.
const llm = await tg.llm().catch(fail)
const openai = new OpenAI({ baseURL: llm.baseUrl, apiKey: llm.apiKey })

// The provider's types are named here, in the caller's project: the SDK carries
// no dependency on any of them, so `tools` and the executor's output come back
// as whatever this line says they are.
const { tools, execute, warnings } = agent.toolkit<
	OpenAI.Responses.Tool,
	OpenAI.Responses.ResponseInputItem
>(ToolFormat.OpenAIResponses, { strict: true })
for (const warning of warnings) {
	console.warn(`${warning.tool} is not under strict mode: ${warning.reason}`)
}

let response = await openai.responses.create({
	model: MODEL,
	tools,
	input: [{ role: 'user', content: QUESTION }],
})

while (response.output.some((item) => item.type === 'function_call')) {
	response = await openai.responses.create({
		model: MODEL,
		tools,
		previous_response_id: response.id,
		input: await execute(response.output),
	})
}

console.log(response.output_text)

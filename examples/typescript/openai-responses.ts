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

// The tools your application carries, by the names their own servers gave them:
// the gateway serves Linear's `list_issues` as `linear_list_issues`, and that
// prefix is its doing, so it is not written here. Replace these with yours — the
// Routing tab lists them, and so does the error this raises.
const REQUIRES = ['list_issues']
const MODEL = 'gpt-5.2'
const QUESTION = 'find the incident runbook and summarise it'
// A turn is one model call and the tools it asks for. A handful is enough for
// an answer, and a bound means a model that keeps calling stops on its own.
const MAX_TURNS = 6

gatewayEnv()

// One secret: the gateway resolves which consumers this key reaches.
const tg = new TrustGate()

const agent = await tg.connect({ requires: REQUIRES }).catch((error: unknown) => {
	if (error instanceof MissingToolsError) {
		// The error names what the toolkit does carry, which is what turns this
		// from a dead end into the list to put in REQUIRES.
		fail(error.message)
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

for (let turn = 1; response.output.some((item) => item.type === 'function_call'); turn++) {
	if (turn >= MAX_TURNS) {
		fail(`stopped after ${MAX_TURNS} turns without a final answer`)
	}
	response = await openai.responses.create({
		model: MODEL,
		tools,
		previous_response_id: response.id,
		input: await execute(response.output),
	})
}

console.log(response.output_text)

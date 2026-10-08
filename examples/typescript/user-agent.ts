/**
 * An assistant for yourself, on your own Store.
 *
 * No application: you run as yourself, and the tools are the servers you
 * installed from the Store, narrowed to what Access grants you. With your
 * personal key (TRUSTGATE_PERSONAL_KEY) your models go through the gateway too;
 * without it, the first run opens your browser to sign in.
 *
 *     npm run user
 *     npm run user -- "what changed in the runbook this week?"
 */
import OpenAI from 'openai'
import { ConsentRequiredError, ToolFormat, TrustGate, TrustGateUser } from '@neuraltrust/trustgate'

import { fail, require } from './config.ts'

const MODEL = 'gpt-5.2'
const DEFAULT_QUESTION = 'find my last issues in Linear'
// A turn is one model call and the tools it asks for. A handful is enough for
// an answer, and a bound means a model that keeps calling stops on its own.
const MAX_TURNS = 6

const [question = DEFAULT_QUESTION] = process.argv.slice(2)

// Your personal key (the Portal's Personal key) says which gateway and which
// Store, and reaches your models too. Without it, the browser signs you in to
// TRUSTGATE_STORE_URL on the first run (the session is kept in ~/.trustgate),
// and the models take your own OpenAI key.
const personal = !!process.env.TRUSTGATE_PERSONAL_KEY?.trim()
const user = personal
	? new TrustGateUser()
	: await TrustGate.login({
			url: require(
				'TRUSTGATE_STORE_URL',
				"Set TRUSTGATE_PERSONAL_KEY to your personal key (the Portal's Personal key), or this to your Store's MCP URL, https://<gateway>.<mcp host>/store/mcp, to sign in through the browser."
			),
		}).catch(fail)
const me = await user.connect().catch(fail)

// A server whose account you have not connected is not on the surface yet.
// Each has its own page; once connected, the next run picks it up.
if (me.needsConnect.length > 0) {
	console.log(`Not connected yet: ${me.needsConnect.join(', ')}. Connect them, then run this again:`)
	for (const server of me.needsConnect) {
		const link = await me.connectLink(server).catch(fail)
		if (link) console.log(`  ${server}: ${link.connectUrl}`)
	}
	console.log()
}

const openai = personal
	? await user
			.llm()
			.then((llm) => new OpenAI({ baseURL: llm.baseUrl, apiKey: llm.apiKey }))
			.catch(fail)
	: new OpenAI({ apiKey: require('OPENAI_API_KEY', 'Signed in, this example calls OpenAI directly; the key is yours, not the gateway’s.') })
const { tools, execute } = me.toolkit<OpenAI.Responses.Tool, OpenAI.Responses.ResponseInputItem>(
	ToolFormat.OpenAIResponses
)

let response = await openai.responses.create({
	model: MODEL,
	tools,
	input: [{ role: 'user', content: question }],
})

for (let turn = 1; response.output.some((item) => item.type === 'function_call'); turn++) {
	if (turn >= MAX_TURNS) fail(`stopped after ${MAX_TURNS} turns without a final answer`)
	const input = await execute(response.output).catch((error: unknown) => {
		if (error instanceof ConsentRequiredError) {
			console.log(`Connect ${error.provider} first: ${error.connectUrl}`)
			process.exit(0)
		}
		return fail(error)
	})
	response = await openai.responses.create({
		model: MODEL,
		tools,
		previous_response_id: response.id,
		input,
	})
}

console.log(response.output_text)

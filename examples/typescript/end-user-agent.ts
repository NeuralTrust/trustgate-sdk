/**
 * An assistant that acts for its own end users.
 *
 * The consumer identifies them, so every call names one, and the moment a user
 * has not connected an account is a link to show them rather than a failure.
 *
 *     npm run end-user
 *     npm run end-user -- user_123 "what changed in the runbook this week?"
 */
import OpenAI from 'openai'
import { ConsentRequiredError, ToolFormat, TrustGate } from '@neuraltrust/trustgate'

import { fail, gatewayEnv } from './config.ts'

const MODEL = 'gpt-5.2'
const DEFAULT_USER = 'user_123'
const DEFAULT_QUESTION = 'find the incident runbook and summarise it'
// A turn is one model call and the tools it asks for. A handful is enough for
// an answer, and a bound means a model that keeps calling stops on its own.
const MAX_TURNS = 6

const [endUser = DEFAULT_USER, question = DEFAULT_QUESTION] = process.argv.slice(2)

gatewayEnv()

const tg = new TrustGate()

// Naming the person is the whole difference from openai-responses.ts, and it is
// a per-call decision rather than something set on the consumer: the same key
// and the same application serve both. The name is yours to choose — the
// gateway namespaces it, so it never collides with another application's.
const user = await tg.forEndUser(endUser).catch(fail)

// A user who has connected nothing is not an error here, it is a link to show
// them. The gateway does offer each unconnected server as a trustgate_connect_*
// tool, but a model with nothing else it can call tends to announce the links
// rather than fetch them — and the program can see the same thing for itself.
const accounts = await user.connections().catch(fail)
const pending = accounts.filter((account) => account.status !== 'connected')
if (accounts.length > 0 && pending.length === accounts.length) {
	console.log('No account is connected for this user, so nothing can run yet. Open these:')
	for (const account of pending) {
		const link = await user.connectLink(account.provider).catch(fail)
		console.log(`  ${account.provider}: ${link.connectUrl}`)
	}
	process.exit(0)
}

const llm = await tg.llm().catch(fail)
const openai = new OpenAI({ baseURL: llm.baseUrl, apiKey: llm.apiKey })
const { tools, execute } = user.toolkit<
	OpenAI.Responses.Tool,
	OpenAI.Responses.ResponseInputItem
>(ToolFormat.OpenAIResponses)

let response = await openai.responses.create({
	model: MODEL,
	tools,
	input: [{ role: 'user', content: question }],
})

for (let turn = 1; response.output.some((item) => item.type === 'function_call'); turn++) {
	if (turn >= MAX_TURNS) fail(`stopped after ${MAX_TURNS} turns without a final answer`)
	// The gateway minted this link for this user; it expires, so it is shown now
	// rather than stored.
	const input = await execute(response.output).catch((error: unknown) => {
		if (error instanceof ConsentRequiredError) {
			console.log(`I need access to ${error.provider} first: ${error.connectUrl}`)
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

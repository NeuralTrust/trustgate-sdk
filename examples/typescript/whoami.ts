/**
 * What this key reaches — the first thing to run when something is off.
 *
 * Almost every confusion here is the same one: the key in .env is not the key of
 * the application you think you are running. This asks the gateway and prints
 * its answer, so there is nothing left to assume.
 *
 *     npm run whoami
 */
import { TrustGate } from '@neuraltrust/trustgate'

import { fail, gatewayEnv } from './config.ts'

gatewayEnv()

const identity = await new TrustGate().identity().catch(fail)

console.log(`gateway: ${identity.gateway}`)
if (identity.consumers.length === 0) {
	fail('this key reaches no consumer. It may be disabled, or belong to another gateway.')
}

for (const consumer of identity.consumers) {
	// Which actor a consumer is decides which example fits it: an application
	// acting as itself is openai-responses.ts, one naming its own users is
	// end-user-agent.ts.
	const actor = !consumer.actsForUsers
		? 'acts as itself → openai-responses.ts'
		: consumer.identitySource === 'app'
			? 'names its own users → end-user-agent.ts'
			: 'its users sign in for themselves — an API key cannot act for them'

	console.log(`\n  ${consumer.slug}  (${consumer.type}${consumer.active ? '' : ', disabled'})`)
	if (consumer.name) console.log(`    name:  ${consumer.name}`)
	if (consumer.type === 'MCP') console.log(`    actor: ${actor}`)
	console.log(`    url:   ${consumer.url || '(no public host for this plane)'}`)
}

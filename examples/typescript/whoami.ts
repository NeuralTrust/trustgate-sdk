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
console.log(
	`key:     ${identity.key.name ?? '(unnamed)'} — ` +
		(identity.key.expiresAt ? `expires ${identity.key.expiresAt.toISOString()}` : 'never expires')
)
if (identity.consumers.length === 0) {
	fail('this key reaches no application. It may be disabled, or belong to another gateway.')
}

for (const consumer of identity.consumers) {
	console.log(`\n  ${consumer.slug}  (${consumer.type}${consumer.active ? '' : ', disabled'})`)
	if (consumer.name) console.log(`    name:  ${consumer.name}`)
	console.log(`    url:   ${consumer.url || '(no public host for this plane)'}`)

	// Both actors belong to every MCP application — openai-responses.ts runs as the
	// application, end-user-agent.ts names a person — so what is worth printing
	// is not which one it is, but what each is still waiting for.
	for (const upstream of consumer.upstreams ?? []) {
		const state = upstream.blocked
			? upstream.blocked === 'administrator'
				? 'an administrator has to connect it on the server'
				: 'name the person it acts for → end-user-agent.ts'
			: 'ready'
		console.log(`    server ${upstream.server} (${upstream.account} account): ${state}`)
	}
}

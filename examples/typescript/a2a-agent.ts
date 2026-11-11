/**
 * One of the application's A2A agents, handed to the A2A SDK.
 *
 * The SDK does not speak A2A: it finds the agent behind the key and hands over
 * its card and the headers that authenticate it. @a2a-js/sdk fetches the card
 * and sends the message, both through the gateway.
 *
 *     npm run a2a -- "Travel planner" "plan a weekend in Lisbon"
 *     npm run a2a -- "Travel planner" "plan a weekend in Lisbon" user_123
 */
import { SendMessageRequest } from '@a2a-js/sdk'
import {
	ClientFactory,
	ClientFactoryOptions,
	DefaultAgentCardResolver,
	JsonRpcTransportFactory,
	createAuthenticatingFetchWithRetry,
} from '@a2a-js/sdk/client'
import { TrustGate } from '@neuraltrust/trustgate'

import { fail, gatewayEnv } from './config.ts'

gatewayEnv()
const [name, text, endUser] = process.argv.slice(2)
if (!name || !text) fail('usage: npm run a2a -- <agent name or id> <message> [end user]')

const agent = await new TrustGate().agent(name, { endUser }).catch(fail)

const fetchImpl = createAuthenticatingFetchWithRetry(fetch, {
	headers: async () => agent.headers,
	shouldRetryWithHeaders: async () => undefined,
})
const factory = new ClientFactory(
	ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
		transports: [new JsonRpcTransportFactory({ fetchImpl })],
		cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
	})
)
// The whole card URL and an empty path: given the agent's URL, the resolver
// would replace its last segment instead of appending to it.
const client = await factory.createFromUrl(agent.cardUrl, '')

const reply = await client.sendMessage(
	SendMessageRequest.fromJSON({
		message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text }] },
	})
)
const parts = 'parts' in reply ? reply.parts : (reply.status?.message?.parts ?? [])
console.log(parts.map((part) => (part.content?.$case === 'text' ? part.content.value : '')).join('\n'))

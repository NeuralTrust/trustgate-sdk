import { inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import { TrustGate, TrustGateUser } from '../src/client.js'
import { ConsentRequiredError } from '../src/errors.js'
import { MemoryTokenCache } from '../src/user.js'
import { fakeGateway } from './fake-gateway.js'

const KEY = 'ag_do_not_print_me'

// A client ends up in a log line, an error report or a debugger sooner or
// later; none of those may carry the key.
function printed(value: unknown): string {
	return `${JSON.stringify(value)}\n${inspect(value, { depth: 10, showHidden: false })}`
}

describe('printing', () => {
	it('leaves the key out of the client', () => {
		const tg = new TrustGate({ baseUrl: 'https://gw.test', apiKey: KEY })

		expect(printed(tg)).not.toContain(KEY)
	})

	it('leaves it out of an agent and its handles', async () => {
		const gateway = fakeGateway()
		const tg = new TrustGate({ baseUrl: 'https://gw.test', apiKey: KEY, mcpConsumer: 'acme', fetch: gateway.fetch })
		const agent = await tg.connect()

		expect(printed(agent)).not.toContain(KEY)
		expect(printed(agent.forEndUser('user_123'))).not.toContain(KEY)
		expect(printed(agent.mcp)).not.toContain(KEY)
	})

	// Still a plain object for the provider's client: only how it prints changes.
	it('masks the endpoints without taking the key out of them', async () => {
		const gateway = fakeGateway()
		const tg = new TrustGate({ baseUrl: 'https://gw.test', apiKey: KEY, fetch: gateway.fetch })
		const agent = await tg.connect()

		expect(agent.mcp.headers['X-AG-API-Key']).toBe(KEY)
		expect({ ...agent.mcp }.headers['X-AG-API-Key']).toBe(KEY)
		expect(printed(agent.mcp)).toContain('[redacted]')
	})

	it('masks the LLM endpoint the same way', async () => {
		const gateway = fakeGateway({
			whoami: {
				gateway: 'acme',
				consumers: [{ slug: 'acme-llm', type: 'LLM', active: true, url: 'https://llm.gw.test/acme-llm/v1' }],
			},
		})
		const tg = new TrustGate({ baseUrl: 'https://gw.test', apiKey: KEY, fetch: gateway.fetch })

		const llm = await tg.llm()

		expect(llm.apiKey).toBe(KEY)
		expect(printed(llm)).not.toContain(KEY)
	})

	// Errors are usually logged whole; the link's ticket works for whoever holds it.
	it('leaves the connect link out of a consent error', () => {
		const error = new ConsentRequiredError('com.notion/mcp', 'https://gw.test/acme/mcp/connect?ticket=t-9', '')

		expect(error.connectUrl).toContain('t-9')
		expect(printed(error)).not.toContain('t-9')
		expect(String(error)).not.toContain('t-9')
	})

	it('leaves the session out of a signed-in user', () => {
		const user = new TrustGateUser({
			url: 'https://acme.mcp.test',
			token: { accessToken: 'tok_access_secret', refreshToken: 'tok_refresh_secret', expiresAt: 0 },
			cache: new MemoryTokenCache(),
		})

		expect(printed(user)).not.toContain('tok_access_secret')
		expect(printed(user)).not.toContain('tok_refresh_secret')
	})
})

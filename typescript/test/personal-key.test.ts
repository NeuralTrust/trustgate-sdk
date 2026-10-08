import { afterEach, describe, expect, it, vi } from 'vitest'

import { UserAgent } from '../src/agent.js'
import { TrustGate, TrustGateUser } from '../src/client.js'
import { PlaneUnavailableError, TrustGateError } from '../src/errors.js'
import { fakeGateway } from './fake-gateway.js'

const KEY = 'ag_personal'

function personalWhoami(llm = true) {
	return {
		gateway: 'acme',
		key: { name: 'personal', personal: true },
		consumers: [
			{ slug: 'store', name: 'MCP Store', type: 'MCP', active: true, url: 'https://acme.mcp.test/store/mcp' },
			...(llm ? [{ slug: 'store', name: 'LLM Store', type: 'LLM', active: true, url: 'https://acme.llm.test/store/v1' }] : []),
		],
	}
}

afterEach(() => vi.unstubAllEnvs())

describe('personal key', () => {
	it("opens its owner's Store without a browser", async () => {
		const gateway = fakeGateway({ whoami: personalWhoami() })

		const user = new TrustGateUser({ apiKey: KEY, fetch: gateway.fetch })
		const me = await user.connect({ requires: ['notion_search'] })

		expect(me).toBeInstanceOf(UserAgent)
		expect(me.tools.map((t) => t.name)).toEqual(['notion_search'])
		expect(me.mcp.url).toBe('https://acme.mcp.test/store/mcp')
		expect(me.mcp.headers['X-AG-API-Key']).toBe(KEY)
		expect(user.url).toBe('https://acme.mcp.test/store/mcp')
		expect(gateway.requests.map((r) => r.url)).toEqual(['https://agentgateway-mcp.neuraltrust.ai/whoami', 'https://acme.mcp.test/store/mcp'])
		expect(gateway.requests[1].headers['X-AG-API-Key']).toBe(KEY)
	})

	it("reaches its owner's models", async () => {
		const gateway = fakeGateway({ whoami: personalWhoami() })

		const llm = await new TrustGateUser({ apiKey: KEY, fetch: gateway.fetch }).llm()

		expect(llm.baseUrl).toBe('https://acme.llm.test/store/v1')
		expect(llm.apiKey).toBe(KEY)
		expect(llm.headers).toEqual({ 'X-AG-API-Key': KEY })
	})

	it('says so when the gateway offers the key no models', async () => {
		const gateway = fakeGateway({ whoami: personalWhoami(false) })

		await expect(new TrustGateUser({ apiKey: KEY, fetch: gateway.fetch }).llm()).rejects.toThrow(PlaneUnavailableError)
	})

	it('goes straight to the Store when given its URL', async () => {
		const gateway = fakeGateway({ whoami: personalWhoami() })

		await new TrustGateUser({ url: 'https://acme.mcp.test/store/mcp', apiKey: KEY, fetch: gateway.fetch }).connect()

		expect(gateway.requests.map((r) => r.url)).toEqual(['https://acme.mcp.test/store/mcp'])
	})

	it('reads the key from the environment', async () => {
		vi.stubEnv('TRUSTGATE_PERSONAL_KEY', KEY)
		const gateway = fakeGateway({ whoami: personalWhoami() })

		const me = await new TrustGateUser({ fetch: gateway.fetch }).connect()

		expect(me.mcp.headers['X-AG-API-Key']).toBe(KEY)
	})

	it('points an application key at TrustGate', async () => {
		const gateway = fakeGateway()

		await expect(new TrustGateUser({ apiKey: 'ag_application', fetch: gateway.fetch }).connect()).rejects.toThrow('new TrustGate({ apiKey })')
	})

	it('is pointed at TrustGateUser by TrustGate', async () => {
		const gateway = fakeGateway({ whoami: personalWhoami() })
		const tg = new TrustGate({ apiKey: KEY, fetch: gateway.fetch })

		await expect(tg.connect()).rejects.toThrow('new TrustGateUser({ apiKey })')
		await expect(tg.forEndUser('user_123')).rejects.toThrow('new TrustGateUser({ apiKey })')
	})

	it('has no models with a sign-in', async () => {
		const user = new TrustGateUser({ url: 'https://acme.mcp.test/store/mcp', accessToken: 'at-1' })

		await expect(user.llm()).rejects.toThrow(TrustGateError)
		await expect(user.llm()).rejects.toThrow('personal key')
	})

	it('refuses a key and a token together', () => {
		expect(() => new TrustGateUser({ url: 'https://acme.mcp.test/store/mcp', accessToken: 'at-1', apiKey: KEY })).toThrow('not both')
	})
})

import { describe, expect, it } from 'vitest'

import { TrustGate, EndUserAgentFactory } from '../src/client.js'
import { Agent } from '../src/agent.js'
import { MissingToolsError, UpstreamNotConnectedError } from '../src/errors.js'
import { END_USER_HEADER } from '../src/config.js'
import { fakeGateway } from './fake-gateway.js'

const base = { baseUrl: 'https://gw.test', apiKey: 'ag_secret', mcpConsumer: 'acme' }

describe('connect', () => {
	it('gives an application acting as itself its tools', async () => {
		const gateway = fakeGateway()
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const agent = (await tg.connect({ requires: ['notion_search'] })) as Agent

		expect(agent).toBeInstanceOf(Agent)
		expect(agent.actor).toBe('application')
		expect(agent.tools.map((t) => t.name)).toEqual(['notion_search'])
		expect(agent.mcp.url).toBe('https://gw.test/acme/mcp')
		expect(agent.mcp.headers['X-AG-API-Key']).toBe('ag_secret')
		expect(agent.mcp.headers[END_USER_HEADER]).toBeUndefined()
	})

	// The toolkit belongs to an admin, so an agent written around a tool can
	// lose it without a line of its own code changing. Startup is the last
	// moment that failure is cheap.
	it('refuses at startup when the toolkit lost a tool the agent needs', async () => {
		const gateway = fakeGateway()
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		await expect(tg.connect({ requires: ['notion_search', 'linear_create_issue'] })).rejects.toThrow(
			MissingToolsError
		)
		await expect(tg.connect({ requires: ['linear_create_issue'] })).rejects.toThrow(
			/linear_create_issue/
		)
	})

	// Nobody is present to open a connect link once a batch is running, so an
	// unconnected upstream has to stop it before it starts.
	it('refuses an application whose own accounts are not connected', async () => {
		const gateway = fakeGateway({
			connections: [
				{ provider: 'com.notion/mcp', status: 'connected' },
				{ provider: 'app.linear/mcp', status: 'not_connected' },
			],
		})
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const error = await tg.connect().catch((e) => e)
		expect(error).toBeInstanceOf(UpstreamNotConnectedError)
		expect(error.providers).toEqual(['app.linear/mcp'])
		expect(error.connectUrl).toBe('https://gw.test/acme/connect')
	})

	it('counts an expired account as not connected', async () => {
		const gateway = fakeGateway({
			connections: [{ provider: 'com.notion/mcp', status: 'needs_reconnect' }],
		})
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		await expect(tg.connect()).rejects.toThrow(UpstreamNotConnectedError)
	})

	// The consumer decides which actor it is; the SDK reads that off the one
	// question only one of the two can answer.
	it('discovers an application that acts for its own users', async () => {
		const gateway = fakeGateway({ actor: 'end_user' })
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const handle = await tg.connect()

		expect(handle).toBeInstanceOf(EndUserAgentFactory)
		expect(handle.actor).toBe('end_user')
	})

	it('names the user on every call once one is chosen', async () => {
		const gateway = fakeGateway({ actor: 'end_user' })
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })
		const handle = (await tg.connect()) as EndUserAgentFactory

		const alice = handle.forEndUser('user_123')
		await alice.callTool('notion_search', { query: 'runbook' })

		expect(alice.mcp.headers[END_USER_HEADER]).toBe('user_123')
		const call = gateway.requests.at(-1)
		expect(call?.headers[END_USER_HEADER]).toBe('user_123')
	})

	// An application that acts as itself has no users to speak for, and a
	// handle that pretended otherwise would pool everyone into one account.
	it('refuses to name a user on an application that acts as itself', async () => {
		const gateway = fakeGateway()
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })
		const agent = (await tg.connect()) as Agent

		expect(() => agent.forEndUser('user_123')).toThrow(/no end users/)
	})

	it('hands the LLM plane to a provider client without wrapping it', () => {
		const tg = new TrustGate({ ...base, llmConsumer: 'acme-llm', fetch: fakeGateway().fetch })

		expect(tg.llm.baseUrl).toBe('https://gw.test/acme-llm/v1')
		expect(tg.llm.apiKey).toBe('ag_secret')
	})

	it('says so when the key was never pointed at an LLM consumer', () => {
		const tg = new TrustGate({ ...base, fetch: fakeGateway().fetch })

		expect(() => tg.llm).toThrow(/TRUSTGATE_LLM_CONSUMER/)
	})
})

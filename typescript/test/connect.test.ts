import { describe, expect, it } from 'vitest'

import { TrustGate, EndUserAgentFactory } from '../src/client.js'
import { Agent } from '../src/agent.js'
import { MissingToolsError, UpstreamNotConnectedError } from '../src/errors.js'
import { END_USER_HEADER } from '../src/config.js'
import { fakeGateway } from './fake-gateway.js'

const base = { baseUrl: 'https://gw.test', apiKey: 'ag_secret' }

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

})

describe('resolving a key', () => {
	const bothPlanes = {
		gateway: 'acme',
		consumers: [
			{ slug: 'acme', type: 'MCP', active: true, url: 'https://gw.test/acme/mcp', acts_for_users: false },
			{ slug: 'acme-llm', type: 'LLM', active: true, url: 'https://llm.test/acme-llm/v1' },
		],
	}

	// The whole point: one secret in, both planes out. The LLM address is on
	// another host, which no client could have composed from the MCP one.
	it('finds both planes behind one key, with no slug configured', async () => {
		const gateway = fakeGateway({ whoami: bothPlanes })
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const agent = (await tg.connect()) as Agent
		const llm = await tg.llm()

		expect(agent.mcp.url).toBe('https://gw.test/acme/mcp')
		expect(llm.baseUrl).toBe('https://llm.test/acme-llm/v1')
		expect(llm.consumer).toBe('acme-llm')
		expect(llm.apiKey).toBe('ag_secret')
	})

	it('asks the key once, however many planes are read', async () => {
		const gateway = fakeGateway({ whoami: bothPlanes })
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		await tg.connect()
		await tg.llm()
		await tg.identity()

		expect(gateway.requests.filter((r) => r.url.endsWith('/whoami'))).toHaveLength(1)
	})

	it('says so when the key reaches no consumer of that plane', async () => {
		const gateway = fakeGateway({ whoami: { gateway: 'acme', consumers: [] } })
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		await expect(tg.connect()).rejects.toThrow(/reaches no MCP consumer/)
	})

	// Two consumers of a plane is a legitimate setup this SDK cannot resolve
	// on its own; guessing would run the agent against the wrong surface.
	it('asks which one when a key reaches two of a plane', async () => {
		const gateway = fakeGateway({
			whoami: {
				gateway: 'acme',
				consumers: [
					{ slug: 'support', type: 'MCP', active: true, url: 'https://gw.test/support/mcp' },
					{ slug: 'billing', type: 'MCP', active: true, url: 'https://gw.test/billing/mcp' },
				],
			},
		})
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		await expect(tg.connect()).rejects.toThrow(/several MCP consumers \(support, billing\)/)

		const named = new TrustGate({ ...base, mcpConsumer: 'billing', fetch: gateway.fetch })
		expect(((await named.connect()) as Agent).mcp.url).toBe('https://gw.test/billing/mcp')
	})

	it('shows the address it asked when /whoami is not there', async () => {
		const gateway = fakeGateway({ whoamiStatus: 404 })
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		// A 404 is far more often the wrong base URL than a gateway too old, so
		// the message leads with that and quotes the URL it actually tried —
		// which is usually enough to see the mistake without reading further.
		const error = await tg.connect().catch((e: unknown) => e)
		expect(String(error)).toContain(`${base.baseUrl}/whoami answered 404`)
		expect(String(error)).toMatch(/no consumer path after it/)
	})
})

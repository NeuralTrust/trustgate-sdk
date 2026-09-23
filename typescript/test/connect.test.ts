import { describe, expect, it } from 'vitest'

import { TrustGate } from '../src/client.js'
import { Agent, EndUserAgent } from '../src/agent.js'
import { MissingToolsError, UpstreamNotConnectedError } from '../src/errors.js'
import { END_USER_HEADER } from '../src/config.js'
import { fakeGateway } from './fake-gateway.js'

const base = { baseUrl: 'https://gw.test', apiKey: 'ag_secret' }

describe('connect', () => {
	it('gives an application acting as itself its tools', async () => {
		const gateway = fakeGateway()
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const agent = await tg.connect({ requires: ['notion_search'] })

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
	// unconnected upstream has to stop it before it starts — and the refusal
	// names who can fix it, because the caller never can.
	it('refuses an application whose servers have no account behind them', async () => {
		const gateway = fakeGateway({
			upstreams: [
				{ server: 'Notion', account: 'shared', connected: true },
				{ server: 'Linear', account: 'shared', connected: false, blocked: 'administrator' },
			],
		})
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const error = await tg.connect().catch((e) => e)
		expect(error).toBeInstanceOf(UpstreamNotConnectedError)
		expect(error.servers).toEqual(['Linear'])
		expect(String(error)).toMatch(/An administrator connects it/)
	})

	// A server that keeps an account per person has nothing for an application,
	// and the remedy is a different handle rather than a different admin.
	it('sends the caller to forEndUser when the account is per person', async () => {
		const gateway = fakeGateway({
			upstreams: [{ server: 'GitHub', account: 'user', connected: false, blocked: 'end_user' }],
		})
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const error = await tg.connect().catch((e) => e)
		expect(error).toBeInstanceOf(UpstreamNotConnectedError)
		// The fix is one call the developer has not met yet, so it is in the message.
		expect(String(error)).toContain("const agent = await tg.forEndUser('user_123')")
	})

	// The gateway can refuse the whole listing over a server the application has
	// no account on. That refusal says nothing about who fixes it, so the account
	// check has to come first — otherwise the typed error never gets its turn.
	it('names the account before the listing can fail over it', async () => {
		const gateway = fakeGateway({
			upstreams: [{ server: 'Linear', account: 'user', connected: false, blocked: 'end_user' }],
			listError: {
				code: -32003,
				message: 'mcp: "Linear" uses a per-user account and this request runs as the application itself',
			},
		})
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const error = await tg.connect().catch((e) => e)
		expect(error).toBeInstanceOf(UpstreamNotConnectedError)
		expect(error.servers).toEqual(['Linear'])
		expect(gateway.requests.some((r) => (r.body as { method?: string } | undefined)?.method === 'tools/list')).toBe(false)
	})

	it('counts an account that has gone stale as still blocking', async () => {
		const gateway = fakeGateway({
			upstreams: [
				{
					server: 'Notion',
					account: 'shared',
					connected: true,
					needs_reconnect: true,
					blocked: 'administrator',
				},
			],
		})
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		await expect(tg.connect()).rejects.toThrow(UpstreamNotConnectedError)
	})

	// A server carrying its own credential is not listed, so an empty list is
	// "nothing to connect" and the run starts.
	it('starts when nothing is waiting to be connected', async () => {
		const gateway = fakeGateway({ upstreams: [] })
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		await expect(tg.connect()).resolves.toBeInstanceOf(Agent)
	})

	// A gateway too old to send `upstreams` sends nothing, and nothing is not an
	// empty list. Reading it as "nothing to connect" is how a batch gets past its
	// own startup check and fails on the first row instead — the exact failure
	// the check exists to prevent — so the connections list answers instead.
	it('falls back to the connections list when the gateway sends no upstreams', async () => {
		const gateway = fakeGateway({
			connections: [
				{ provider: 'com.notion/mcp', status: 'connected' },
				{ provider: 'app.linear/mcp', registry: 'Linear', status: 'not_connected' },
			],
		})
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const error = await tg.connect().catch((e) => e)
		expect(error).toBeInstanceOf(UpstreamNotConnectedError)
		expect(error.servers).toEqual(['Linear'])
	})

	it('starts on an older gateway when every account is connected', async () => {
		const gateway = fakeGateway({ connections: [{ provider: 'com.notion/mcp', status: 'connected' }] })
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		await expect(tg.connect()).resolves.toBeInstanceOf(Agent)
	})

	// The same consumer, the same key: which actor a call is comes from the
	// call, so both handles are always available and neither is configured.
	it('acts for a named person on the same consumer', async () => {
		const gateway = fakeGateway()
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const alice = await tg.forEndUser('user_123')
		await alice.callTool('notion_search', { query: 'runbook' })

		expect(alice).toBeInstanceOf(EndUserAgent)
		expect(alice.actor).toBe('end_user')
		expect(alice.mcp.headers[END_USER_HEADER]).toBe('user_123')
		expect(gateway.requests.at(-1)?.headers[END_USER_HEADER]).toBe('user_123')
	})

	// The toolkit is the application's and identical for everyone it acts for,
	// so naming a person from an agent already holding it costs no round trip.
	it('names a person from the application handle without asking again', async () => {
		const gateway = fakeGateway()
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })
		const agent = await tg.connect()
		const listedBefore = gateway.requests.filter((r) => r.url.endsWith('/mcp')).length

		const alice = agent.forEndUser('user_123')

		expect(alice.tools.map((tool) => tool.name)).toEqual(['notion_search'])
		expect(gateway.requests.filter((r) => r.url.endsWith('/mcp'))).toHaveLength(listedBefore)
		expect(alice.mcp.headers[END_USER_HEADER]).toBe('user_123')
	})

	it('checks required tools for a named person too', async () => {
		const gateway = fakeGateway()
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		await expect(tg.forEndUser('user_123', { requires: ['linear_create_issue'] })).rejects.toThrow(
			/linear_create_issue/
		)
	})

	// A server that refuses a request naming nobody is a per-user server, not a
	// misconfigured consumer: the named handle reaches it and the application
	// handle does not, which is the same distinction stated at the other end.
	it('reaches a per-user surface once a person is named', async () => {
		const gateway = fakeGateway({ requireEndUser: true })
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const alice = await tg.forEndUser('user_123')

		expect(alice.tools.map((tool) => tool.name)).toEqual(['notion_search'])
	})

	// A key that retires itself is a 401 nobody saw coming; a long run can ask
	// first and refuse to start.
	it('says when the calling key expires', async () => {
		const gateway = fakeGateway({ keyExpiresAt: '2027-03-01T09:30:00Z' })
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const identity = await tg.identity()

		expect(identity.key.name).toBe('prod')
		expect(identity.key.expiresAt?.toISOString()).toBe('2027-03-01T09:30:00.000Z')
	})

	it('leaves the expiry undefined for a key that never expires', async () => {
		const gateway = fakeGateway()
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		expect((await tg.identity()).key.expiresAt).toBeUndefined()
	})
})

describe('resolving a key', () => {
	const bothPlanes = {
		gateway: 'acme',
		consumers: [
			{ slug: 'acme', type: 'MCP', active: true, url: 'https://gw.test/acme/mcp' },
			{ slug: 'acme-llm', type: 'LLM', active: true, url: 'https://llm.test/acme-llm/v1' },
		],
	}

	// The whole point: one secret in, both planes out. The LLM address is on
	// another host, which no client could have composed from the MCP one.
	it('finds both planes behind one key, with no slug configured', async () => {
		const gateway = fakeGateway({ whoami: bothPlanes })
		const tg = new TrustGate({ ...base, fetch: gateway.fetch })

		const agent = await tg.connect()
		const llm = await tg.llm()

		expect(agent.mcp.url).toBe('https://gw.test/acme/mcp')
		expect(llm.baseUrl).toBe('https://llm.test/acme-llm/v1')
		expect(llm.consumer).toBe('acme-llm')
		expect(llm.apiKey).toBe('ag_secret')
	})

	// The Anthropic client appends /v1/messages to what it is given, so the base
	// it needs stops at the application; the OpenAI one keeps the /v1 it expects.
	it('hands each provider client the base it extends', async () => {
		const gateway = fakeGateway({ whoami: bothPlanes })
		const llm = await new TrustGate({ ...base, fetch: gateway.fetch }).llm()

		expect(llm.baseUrl).toBe('https://llm.test/acme-llm/v1')
		expect(llm.anthropicBaseUrl).toBe('https://llm.test/acme-llm')
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
		expect((await named.connect()).mcp.url).toBe('https://gw.test/billing/mcp')
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

// A key is enough: with no address given, the SDK asks the shared entry point,
// which finds the gateway from the key and answers with that gateway's own
// planes. Nothing else is ever sent to the entry point.
describe('starting from the key alone', () => {
	const planes = {
		gateway: 'acme',
		key: { name: 'prod' },
		consumers: [{ slug: 'acme', name: 'Acme Agent', type: 'MCP', active: true, url: 'https://acme.mcp.test/acme/mcp' }],
	}

	it('asks the shared entry point, then talks only to the planes it named', async () => {
		// Read the way the SDK reads it, so the test needs no Node typings.
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
		const saved = env.TRUSTGATE_URL
		delete env.TRUSTGATE_URL
		try {
			const gateway = fakeGateway({ whoami: planes })
			const tg = new TrustGate({ apiKey: 'ag_secret', fetch: gateway.fetch })

			const agent = await tg.connect()

			expect(gateway.requests[0].url).toBe('https://gateway.neuraltrust.ai/whoami')
			expect(agent.mcp.url).toBe('https://acme.mcp.test/acme/mcp')
			const rest = gateway.requests.slice(1).map((r) => r.url)
			expect(rest.length).toBeGreaterThan(0)
			expect(rest.every((url) => url.startsWith('https://acme.mcp.test/'))).toBe(true)
			expect(rest).toContain('https://acme.mcp.test/acme/connections')
		} finally {
			if (saved !== undefined) env.TRUSTGATE_URL = saved
		}
	})

	it('sends an end user’s connections to the plane too', async () => {
		const gateway = fakeGateway({ whoami: planes })
		const tg = new TrustGate({ apiKey: 'ag_secret', baseUrl: 'https://gateway.neuraltrust.ai', fetch: gateway.fetch })

		const agent = await tg.forEndUser('user_1')
		await agent.connections()

		expect(gateway.requests.at(-1)?.url).toBe('https://acme.mcp.test/acme/connections?end_user=user_1')
	})
})

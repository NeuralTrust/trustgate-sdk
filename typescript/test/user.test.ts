import { createHash } from 'node:crypto'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { UserAgent } from '../src/agent.js'
import { TrustGate, TrustGateUser } from '../src/client.js'
import { AuthenticationError, LoginRequiredError, MissingToolsError } from '../src/errors.js'
import { FileTokenCache, MemoryTokenCache, resolveStoreUrl, type UserToken } from '../src/user.js'

const STORE = 'https://acme.mcp.test/store/mcp'

type StoreOptions = {
	tools?: { name: string; title?: string; inputSchema: Record<string, unknown> }[]
	/** Tokens the Store accepts. */
	valid?: string[]
	/** Refresh tokens the token endpoint renews, and what each one becomes. */
	refreshable?: Record<string, string>
	/** Overrides what the browser comes back with; `state` is filled in when left out. */
	callback?: Record<string, string>
	/** Overrides the token endpoint the metadata names. */
	tokenEndpoint?: string
	/** Overrides the link the connect tool answers with. */
	connectUrl?: string
	/** Answers the metadata request with a redirect instead. */
	metadataMoved?: boolean
}

/** The gateway's sign-in endpoints and its Store, as a fetch. */
function fakeStore(options: StoreOptions = {}) {
	const tools = options.tools ?? [{ name: 'linear_list_issues', inputSchema: { type: 'object' } }]
	const valid = new Set(options.valid ?? ['at-1'])
	const refreshable = options.refreshable ?? {}
	const registered: Record<string, unknown>[] = []
	const authorized: Record<string, string>[] = []
	const tokenRequests: Record<string, string>[] = []
	const mcpAuth: string[] = []
	let challenge = ''

	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input))
		const headers = (init?.headers ?? {}) as Record<string, string>
		switch (url.pathname) {
			case '/.well-known/oauth-authorization-server':
				if (options.metadataMoved) {
					return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test/meta' } })
				}
				return json(200, {
					issuer: 'https://acme.mcp.test',
					authorization_endpoint: 'https://acme.mcp.test/oauth/authorize',
					token_endpoint: options.tokenEndpoint ?? 'https://acme.mcp.test/oauth/token',
					registration_endpoint: 'https://acme.mcp.test/oauth/register',
				})
			case '/oauth/register': {
				const payload = JSON.parse(String(init?.body))
				registered.push(payload)
				return json(201, { client_id: 'agw-1', redirect_uris: payload.redirect_uris })
			}
			case '/oauth/token': {
				const form = Object.fromEntries(new URLSearchParams(String(init?.body)))
				tokenRequests.push(form)
				if (form.grant_type === 'authorization_code') {
					const digest = createHash('sha256').update(form.code_verifier).digest('base64url')
					if (digest !== challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' })
					valid.add('at-1')
					return json(200, { access_token: 'at-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'gwrt_1' })
				}
				const renewed = refreshable[form.refresh_token]
				if (!renewed) {
					return json(400, { error: 'invalid_grant', error_description: 'session expired; sign in again' })
				}
				valid.add(renewed)
				return json(200, { access_token: renewed, token_type: 'Bearer', expires_in: 3600, refresh_token: 'gwrt_2' })
			}
			case '/store/mcp': {
				const bearer = (headers.Authorization ?? '').replace(/^Bearer /, '')
				mcpAuth.push(bearer)
				if (!valid.has(bearer)) return json(401, { error: 'invalid_token' })
				const rpc = JSON.parse(String(init?.body))
				if (rpc.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: rpc.id, result: { tools } })
				const name = rpc.params.name as string
				const result = name.startsWith('trustgate_connect_')
					? {
							content: [{ type: 'text', text: 'open it' }],
							structuredContent: {
								connect_url: options.connectUrl ?? 'https://acme.mcp.test/store/mcp/connect?ticket=tk-9',
								action: 'user_confirmation_required',
							},
						}
					: { content: [{ type: 'text', text: `called ${name}` }] }
				return json(200, { jsonrpc: '2.0', id: rpc.id, result })
			}
		}
		return json(404, { error: 'not_found' })
	}) as typeof globalThis.fetch

	/** What the person's browser does: sign in, and come back to the loopback port. */
	const browser = async (authorizeUrl: string) => {
		const query = Object.fromEntries(new URL(authorizeUrl).searchParams)
		authorized.push(query)
		challenge = query.code_challenge
		const back = { state: query.state, ...(options.callback ?? { code: 'c-1' }) }
		const page = await globalThis.fetch(`${query.redirect_uri}?${new URLSearchParams(back)}`)
		expect(page.status).toBe(200)
	}

	return { fetch: fetchImpl, browser, registered, authorized, tokenRequests, mcpAuth }
}

function login(store: ReturnType<typeof fakeStore>, cache = new MemoryTokenCache()) {
	return TrustGate.login({
		url: STORE,
		cache,
		openBrowser: false,
		fetch: store.fetch,
		onUrl: (url) => void store.browser(url),
	})
}

describe('signed-in user', () => {
	it('signs a person in through the browser and opens their Store', async () => {
		const store = fakeStore()
		const cache = new MemoryTokenCache()

		const agent = await (await login(store, cache)).connect({ requires: ['list_issues'] })

		expect(agent).toBeInstanceOf(UserAgent)
		expect(agent.actor).toBe('user')
		expect(agent.tools.map((t) => t.name)).toEqual(['linear_list_issues'])
		expect(agent.mcp.url).toBe(STORE)
		expect(agent.mcp.headers.Authorization).toBe('Bearer at-1')
		expect(agent.mcp.headers['X-AG-API-Key']).toBeUndefined()
		const redirect = (store.registered[0].redirect_uris as string[])[0]
		expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
		expect(store.authorized[0].resource).toBe(STORE)
		expect(store.authorized[0].code_challenge_method).toBe('S256')
		expect(store.tokenRequests[0].redirect_uri).toBe(redirect)
		expect(await cache.load(STORE)).toMatchObject({ accessToken: 'at-1', refreshToken: 'gwrt_1', clientId: 'agw-1' })
	})

	it('runs calls as the signed-in person', async () => {
		const store = fakeStore()

		const agent = await (await login(store)).connect()
		const result = await agent.callTool('list_issues')

		expect((result.content as { text: string }[])[0].text).toBe('called linear_list_issues')
		expect(store.mcpAuth).toEqual(['at-1', 'at-1'])
	})

	it('reuses the session from last time without a browser', async () => {
		const store = fakeStore()
		const cache = new MemoryTokenCache()
		await cache.save(STORE, { accessToken: 'at-1', expiresAt: Date.now() + 3_600_000, refreshToken: 'gwrt_1', clientId: 'agw-1' })

		await (await login(store, cache)).connect()

		expect(store.authorized).toEqual([])
	})

	it('renews a session that is about to end', async () => {
		const store = fakeStore({ refreshable: { gwrt_1: 'at-2' } })
		const cache = new MemoryTokenCache()
		await cache.save(STORE, { accessToken: 'at-old', expiresAt: 1, refreshToken: 'gwrt_1', clientId: 'agw-1' })

		const agent = await (await login(store, cache)).connect()

		expect(store.authorized).toEqual([])
		expect(agent.mcp.headers.Authorization).toBe('Bearer at-2')
		expect(store.tokenRequests[0]).toMatchObject({ client_id: 'agw-1', resource: STORE })
		expect((await cache.load(STORE))?.refreshToken).toBe('gwrt_2')
	})

	it('signs in again when the session cannot be renewed', async () => {
		const store = fakeStore()
		const cache = new MemoryTokenCache()
		await cache.save(STORE, { accessToken: 'at-old', expiresAt: 1, refreshToken: 'gwrt_dead', clientId: 'agw-1' })

		await (await login(store, cache)).connect()

		expect(store.authorized).toHaveLength(1)
		expect((await cache.load(STORE))?.accessToken).toBe('at-1')
	})

	it('renews once when the Store refuses a token mid-run', async () => {
		const store = fakeStore({ valid: [], refreshable: { gwrt_1: 'at-2' } })
		const token: UserToken = { accessToken: 'at-revoked', expiresAt: Date.now() + 3_600_000, refreshToken: 'gwrt_1', clientId: 'agw-1' }

		const agent = await new TrustGateUser({ url: STORE, token, fetch: store.fetch }).connect()

		expect(store.mcpAuth).toEqual(['at-revoked', 'at-2'])
		expect(agent.tools).not.toHaveLength(0)
	})

	it('says to sign in again when the sign-in has ended', async () => {
		const store = fakeStore({ valid: [] })
		const token: UserToken = { accessToken: 'at-revoked', expiresAt: Date.now() + 3_600_000, refreshToken: 'gwrt_dead', clientId: 'agw-1' }

		const failure = new TrustGateUser({ url: STORE, token, fetch: store.fetch }).connect()

		await expect(failure).rejects.toBeInstanceOf(LoginRequiredError)
		await expect(failure).rejects.toThrow('TrustGate.login')
	})

	it('takes a token a backend already holds', async () => {
		const store = fakeStore({ valid: ['at-mine'] })

		const agent = await new TrustGateUser({ url: STORE, accessToken: 'at-mine', fetch: store.fetch }).connect()

		expect(agent.mcp.headers.Authorization).toBe('Bearer at-mine')
	})

	it('treats a refused token with nothing to renew it as an authentication error', async () => {
		const store = fakeStore({ valid: [] })

		const failure = new TrustGateUser({ url: STORE, accessToken: 'at-bad', fetch: store.fetch }).connect()

		await expect(failure).rejects.toBeInstanceOf(AuthenticationError)
		await expect(failure).rejects.toThrow('refused this sign-in')
		await expect(failure).rejects.not.toBeInstanceOf(LoginRequiredError)
	})

	it('names the servers waiting on an account and the page to connect them', async () => {
		const store = fakeStore({
			tools: [
				{ name: 'notion_search', inputSchema: { type: 'object' } },
				{ name: 'trustgate_connect_linear', title: 'Connect Linear', inputSchema: { type: 'object' } },
			],
		})

		const agent = await (await login(store)).connect()
		const link = await agent.connectLink()

		expect(agent.needsConnect).toEqual(['Linear'])
		expect(link?.connectUrl).toBe('https://acme.mcp.test/store/mcp/connect?ticket=tk-9')
		expect(link?.ticket).toBe('tk-9')
	})

	it('has no link when everything is connected', async () => {
		const agent = await (await login(fakeStore())).connect()

		expect(agent.needsConnect).toEqual([])
		expect(await agent.connectLink()).toBeUndefined()
	})

	it('points a missing tool at the Store and Access', async () => {
		const user = await login(fakeStore())

		await expect(user.connect({ requires: ['github_create_issue'] })).rejects.toThrow(MissingToolsError)
		await expect(user.connect({ requires: ['github_create_issue'] })).rejects.toThrow('Install them from the Store')
	})

	it('refuses a browser that comes back for another sign-in', async () => {
		const store = fakeStore({ callback: { code: 'c-1', state: 'someone-elses' } })

		await expect(login(store)).rejects.toThrow('another sign-in')
		expect(store.tokenRequests).toEqual([])
	})

	it('says why a sign-in was refused', async () => {
		const store = fakeStore({ callback: { error: 'access_denied', error_description: 'not a member' } })

		await expect(login(store)).rejects.toThrow('not a member')
	})

	it('accepts the Store host on its own', () => {
		expect(resolveStoreUrl('https://acme.mcp.test')).toBe(STORE)
		expect(resolveStoreUrl('https://acme.mcp.test/')).toBe(STORE)
		expect(resolveStoreUrl(`${STORE}/`)).toBe(STORE)
	})

	it('refuses a Store on another host over plain http', () => {
		expect(() => resolveStoreUrl('http://acme.mcp.test')).toThrow(/plain http/)
		expect(resolveStoreUrl('http://127.0.0.1:8082')).toBe('http://127.0.0.1:8082/store/mcp')
		expect(resolveStoreUrl('http://acme.mcp.test', true)).toBe('http://acme.mcp.test/store/mcp')
	})

	// The metadata decides where the code, the PKCE verifier and later the
	// refresh token are sent.
	it('refuses metadata that would send the sign-in over plain http', async () => {
		const store = fakeStore({ tokenEndpoint: 'http://acme.mcp.test/oauth/token' })

		await expect(login(store)).rejects.toThrow(/token endpoint is plain http/)
		expect(store.tokenRequests).toEqual([])
	})

	it('signs in at the conventional paths when the metadata has moved', async () => {
		const store = fakeStore({ metadataMoved: true })

		const agent = await (await login(store)).connect()

		expect(agent.tools.map((t) => t.name)).toEqual(['linear_list_issues'])
		expect(store.tokenRequests[0].grant_type).toBe('authorization_code')
	})

	it('does not pass on a connect link that is not the gateway\'s', async () => {
		const store = fakeStore({
			tools: [{ name: 'trustgate_connect_linear', title: 'Connect Linear', inputSchema: { type: 'object' } }],
			connectUrl: 'https://login.example/connect?ticket=tk-9',
		})
		const agent = await (await login(store)).connect()

		await expect(agent.connectLink()).rejects.toMatchObject({ code: 'untrusted_connect_url' })
	})

	it('keeps sessions in a file only its owner reads, in the shape Python reads', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'trustgate-'))
		const cache = new FileTokenCache(join(dir, 'nested', 'sessions.json'))

		await cache.save(STORE, { accessToken: 'at-1', expiresAt: 10_000, refreshToken: 'gwrt_1', clientId: 'agw-1' })

		expect((await stat(join(dir, 'nested', 'sessions.json'))).mode & 0o777).toBe(0o600)
		expect(await new FileTokenCache(join(dir, 'nested', 'sessions.json')).load(STORE)).toEqual({
			accessToken: 'at-1',
			expiresAt: 10_000,
			refreshToken: 'gwrt_1',
			clientId: 'agw-1',
		})
		await cache.clear(STORE)
		expect(await cache.load(STORE)).toBeUndefined()
	})
})

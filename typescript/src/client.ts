import { Agent, EndUserAgent, UserAgent, endUserAgent } from './agent.js'
import {
	API_KEY_HEADER,
	insecureHttpFromEnv,
	maskedWhenPrinted,
	requireSafeUrl,
	resolveConfig,
	type ResolvedConfig,
	type TrustGateConfig,
} from './config.js'
import { listConnections } from './connections.js'
import {
	ConsentRequiredError,
	LoginRequiredError,
	MissingToolsError,
	TrustGateError,
	UpstreamNotConnectedError,
	type BlockedUpstream,
} from './errors.js'
import { MCPTransport } from './mcp.js'
import { resolveToolName, type Connection, type GatewayTool } from './types.js'
import {
	FileTokenCache,
	UserSession,
	expiresSoon,
	loginFlow,
	resolveStoreUrl,
	type LoginFlowOptions,
	type TokenCache,
	type UserToken,
} from './user.js'
import { selectConsumer, whoAmI, type KeyIdentity, type KeyUpstream } from './whoami.js'

export type ConnectOptions = {
	/**
	 * Tool names this agent is written around.
	 *
	 * The toolkit belongs to an admin, not to the code that uses it, so it can
	 * be narrowed without warning. Declaring what you need turns that into a
	 * refusal at startup instead of a failure mid-conversation.
	 */
	requires?: string[]
	signal?: AbortSignal
}

/** What the LLM plane needs to be handed to a provider's own client. */
export type LLMEndpoint = {
	/** Pass as `baseURL` to the OpenAI client. It ends in `/v1`. */
	baseUrl: string
	/**
	 * Pass as `baseURL` to the Anthropic client.
	 *
	 * The two clients disagree on where the version goes. OpenAI's is handed a
	 * base that already ends in `/v1` and appends `/chat/completions`;
	 * Anthropic's appends `/v1/messages` to what it is given, so handing it
	 * `baseUrl` asks the gateway for `/v1/v1/messages`. This is the
	 * application's root, the one every dialect but OpenAI's hangs from.
	 */
	anthropicBaseUrl: string
	apiKey: string
	headers: Record<string, string>
	/** The consumer behind it, for logs and for error messages. */
	consumer: string
}

/**
 * The entry point: a gateway and a key, and everything else is asked for.
 *
 * The key is attached to consumers, and a consumer has one type — so the tools
 * live behind an MCP consumer and the models behind an LLM one. Their slugs
 * were chosen by whoever created them, and the two planes do not share a host,
 * so neither is something a caller should have to carry: the gateway is asked
 * once, at `connect()`, and answers both.
 */
export class TrustGate {
	// Runtime-private: it holds the key, and a logged client must not.
	readonly #config: ResolvedConfig
	private identityPromise?: Promise<KeyIdentity>

	constructor(config: TrustGateConfig = {}) {
		this.#config = resolveConfig(config)
	}

	/**
	 * What this key reaches. Read once and remembered: it is a property of the
	 * key, and a long-lived process should not re-ask on every call.
	 */
	async identity(signal?: AbortSignal): Promise<KeyIdentity> {
		this.identityPromise ??= whoAmI(this.#config, signal).catch((error: unknown) => {
			this.identityPromise = undefined
			throw asIdentityError(error, this.#config.baseUrl)
		})
		return this.identityPromise
	}

	/**
	 * The LLM plane, ready for a provider's own SDK.
	 *
	 * The gateway speaks the providers' own APIs, so nothing here wraps their
	 * clients — it points them somewhere else. Wrapping would mean chasing
	 * every change they make and breaking streaming on the way.
	 */
	async llm(signal?: AbortSignal): Promise<LLMEndpoint> {
		const identity = await this.identity(signal)
		const consumer = onSafePlane(selectConsumer(identity, 'LLM', this.#config.llmConsumer, 'llmConsumer'), this.#config)
		return maskedWhenPrinted<LLMEndpoint>(
			{
				baseUrl: consumer.url,
				anthropicBaseUrl: withoutVersion(consumer.url),
				apiKey: this.#config.apiKey,
				headers: { [API_KEY_HEADER]: this.#config.apiKey },
				consumer: consumer.slug,
			},
			['apiKey', 'headers']
		)
	}

	/**
	 * Opens the application's own surface and proves it is usable before
	 * anything runs.
	 *
	 * Two things happen here, and both are the kind that are cheap now and
	 * expensive later: whether the tools the agent needs are actually on its
	 * toolkit, and whether the servers behind it have an account to call with.
	 * The second has no runtime remedy for this handle — nobody is present to
	 * open a connect link once a batch is going — which is the whole reason it
	 * is checked at startup.
	 *
	 * This is the application actor: the key and nothing else, so the gateway
	 * runs the calls as `app:<consumer_id>`. For a call on behalf of a person,
	 * use {@link forEndUser}; both work on the same consumer, because who a
	 * request runs as is read from the request rather than declared anywhere.
	 */
	async connect(options: ConnectOptions = {}): Promise<Agent> {
		const identity = await this.identity(options.signal)
		const consumer = onSafePlane(selectConsumer(identity, 'MCP', this.#config.mcpConsumer, 'mcpConsumer'), this.#config)

		// Accounts before tools: a server with no account for the application can
		// fail the listing itself, which would surface as a bare gateway error
		// before this check — the one that says who fixes it — ever ran.
		const plane = onMCPPlane(this.#config, consumer)
		const connections = await listConnections(plane, consumer.slug, undefined, options.signal)
		const blocked = blockedUpstreams(consumer.upstreams, connections)
		const required = options.requires ?? []
		// Without requires, every server is one the agent may need, so any of
		// them blocked fails the start. With them, only the agent's own: the
		// gateway lists the servers that can answer and leaves the rest out, so a
		// required tool on the listing is a tool whose server has an account.
		if (blocked.length > 0 && required.length === 0) {
			throw new UpstreamNotConnectedError(blocked)
		}

		const transport = new MCPTransport(plane, consumer.url)
		let tools: GatewayTool[]
		try {
			tools = await transport.listTools(options.signal)
		} catch (error) {
			const accountMissing = error instanceof UpstreamNotConnectedError || error instanceof ConsentRequiredError
			if (accountMissing && blocked.length > 0) throw new UpstreamNotConnectedError(blocked)
			throw error
		}
		const missing = missingTools(tools, required)
		if (missing.length > 0 && blocked.length > 0) {
			throw new UpstreamNotConnectedError(blocked)
		}
		if (missing.length > 0) {
			throw new MissingToolsError(missing, tools.map((tool) => tool.name))
		}
		return new Agent(plane, consumer.slug, transport, tools, missing, connections)
	}

	/** Signs a person in to their own Store. See {@link TrustGateUser.login}. */
	static login(options: LoginOptions = {}): Promise<TrustGateUser> {
		return TrustGateUser.login(options)
	}

	/**
	 * The handle for one named person, on the same consumer and the same key.
	 *
	 * The name is asserted by this application and not verified, so the gateway
	 * namespaces it: two applications naming `user_123` never share an account.
	 * What that person still has to connect is theirs to connect — the handle's
	 * own `connections` mint the link to put in front of them — which is why
	 * there is no startup preflight here and one in {@link connect}.
	 */
	async forEndUser(endUser: string, options: ConnectOptions = {}): Promise<EndUserAgent> {
		const identity = await this.identity(options.signal)
		const consumer = onSafePlane(selectConsumer(identity, 'MCP', this.#config.mcpConsumer, 'mcpConsumer'), this.#config)
		const agent = endUserAgent(onMCPPlane(this.#config, consumer), consumer.slug, endUser, consumer.url, [])
		const tools = await agent.refresh(options.signal)
		const missing = missingTools(tools, options.requires ?? [])
		if (missing.length > 0) {
			throw new MissingToolsError(missing, tools.map((tool) => tool.name))
		}
		return agent
	}
}

export type TrustGateUserConfig = {
	/**
	 * The Store's MCP endpoint, `https://<gateway>.<mcp host>/store/mcp`, or
	 * its host. Defaults to `TRUSTGATE_STORE_URL`.
	 */
	url?: string
	/**
	 * A session token your own sign-in already holds — a backend that ran the
	 * OAuth flow for its user. Defaults to `TRUSTGATE_ACCESS_TOKEN`.
	 */
	accessToken?: string
	/** A session with its refresh token, as {@link TrustGateUser.login} keeps it. */
	token?: UserToken
	/** Where a renewed session is written back. */
	cache?: TokenCache
	/** Overrides the fetch implementation. Tests and proxies use this. */
	fetch?: typeof globalThis.fetch
	/** Per-request timeout in milliseconds. Default 30000. */
	timeoutMs?: number
	/** As in {@link TrustGateConfig.allowInsecureHttp}, for the session token. */
	allowInsecureHttp?: boolean
}

export type LoginOptions = LoginFlowOptions & {
	/** The Store URL, as in {@link TrustGateUserConfig.url}. */
	url?: string
	/**
	 * Where the session is kept between runs. Default: a file in `~/.trustgate`
	 * only this user can read. Pass a `MemoryTokenCache` to keep nothing on disk.
	 */
	cache?: TokenCache
	/** Signs in through the browser even when a session is kept. */
	force?: boolean
	fetch?: typeof globalThis.fetch
	timeoutMs?: number
	allowInsecureHttp?: boolean
}

/**
 * A person, signed in, on their own Store.
 *
 * The other side of {@link TrustGate}: no API key and no application, but a
 * person with what Access grants them — the servers they installed from the
 * Store, narrowed to what their user and groups may reach, called with their
 * own accounts. Use {@link login} to sign in through the browser, or pass an
 * `accessToken` your own sign-in already holds.
 */
export class TrustGateUser {
	/** The Store's MCP endpoint, `https://<gateway>.<mcp host>/store/mcp`. */
	readonly url: string
	readonly session: UserSession
	private readonly fetchImpl: typeof globalThis.fetch
	private readonly timeoutMs: number
	private readonly allowInsecureHttp: boolean
	private readonly cache?: TokenCache

	constructor(config: TrustGateUserConfig = {}) {
		this.allowInsecureHttp = config.allowInsecureHttp ?? insecureHttpFromEnv()
		this.url = resolveStoreUrl(config.url, this.allowInsecureHttp)
		this.fetchImpl = config.fetch ?? globalThis.fetch
		this.timeoutMs = config.timeoutMs ?? 30_000
		this.cache = config.cache
		let token = config.token
		if (!token) {
			const raw = (config.accessToken ?? fromEnv('TRUSTGATE_ACCESS_TOKEN') ?? '').trim()
			if (!raw) {
				throw new TrustGateError(
					'accessToken is required (or set TRUSTGATE_ACCESS_TOKEN); to sign in through ' +
						`the browser use TrustGate.login({ url: "${this.url}" })`
				)
			}
			token = { accessToken: raw, expiresAt: 0 }
		}
		this.session = new UserSession(this.url, token, this.http, this.cache)
	}

	/**
	 * Signs in through the browser, or reuses the session from last time.
	 *
	 * The session is kept in `cache` — by default a file in `~/.trustgate` only
	 * this user can read — so a script signs in once and runs again without a
	 * browser until the sign-in ends (a day, on NeuralTrust's cloud).
	 *
	 * The browser comes back to a port on this machine, so this is for the
	 * person's own computer, on Node. A server acting for many people is an
	 * application, with an API key: see {@link TrustGate}.
	 */
	static async login(options: LoginOptions = {}): Promise<TrustGateUser> {
		const allowInsecureHttp = options.allowInsecureHttp ?? insecureHttpFromEnv()
		const url = resolveStoreUrl(options.url, allowInsecureHttp)
		const http = { fetch: options.fetch ?? globalThis.fetch, timeoutMs: options.timeoutMs ?? 30_000, allowInsecureHttp }
		const cache = options.cache ?? new FileTokenCache()
		const make = (token: UserToken) =>
			new TrustGateUser({ url, token, cache, fetch: http.fetch, timeoutMs: http.timeoutMs, allowInsecureHttp })
		if (!options.force) {
			const cached = await cache.load(url)
			if (cached) {
				const session = new UserSession(url, cached, http, cache)
				try {
					if (expiresSoon(cached, Date.now()) && !(await session.renew())) {
						throw new LoginRequiredError(url)
					}
					return make(session.token)
				} catch (error) {
					if (!(error instanceof LoginRequiredError)) throw error
				}
			}
		}
		const token = await loginFlow(url, http, options)
		await cache.save(url, token)
		return make(token)
	}

	private get http(): { fetch: typeof globalThis.fetch; timeoutMs: number; allowInsecureHttp: boolean } {
		return { fetch: this.fetchImpl, timeoutMs: this.timeoutMs, allowInsecureHttp: this.allowInsecureHttp }
	}

	/** Forgets the session kept for this Store. The browser's sign-in stays. */
	async logout(): Promise<void> {
		await this.cache?.clear(this.url)
	}

	/**
	 * Opens this person's Store and checks the tools the agent needs are on it.
	 *
	 * A server whose account the person has not connected yet is not on the
	 * surface; {@link UserAgent.needsConnect} names those and
	 * {@link UserAgent.connectLink} is the page to connect them.
	 */
	async connect(options: ConnectOptions = {}): Promise<UserAgent> {
		const config: ResolvedConfig = {
			baseUrl: new URL(this.url).origin,
			apiKey: '',
			fetch: this.fetchImpl,
			timeoutMs: this.timeoutMs,
			allowInsecureHttp: this.allowInsecureHttp,
		}
		const transport = new MCPTransport(config, this.url, {}, this.session)
		const tools = await transport.listTools(options.signal)
		const missing = missingTools(tools, options.requires ?? [])
		if (missing.length > 0) {
			throw new MissingToolsError(
				missing,
				tools.map((tool) => tool.name),
				'Install them from the Store, or ask an admin to grant them in Access.'
			)
		}
		return new UserAgent(transport, tools)
	}
}

function fromEnv(name: string): string | undefined {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
	return env?.[name]
}

/**
 * The required tools this toolkit does not carry.
 *
 * Each name is resolved the way callTool resolves it, so an agent may require
 * the name its server gave the tool and leave the gateway's server prefix to
 * the gateway.
 */
function missingTools(tools: GatewayTool[], required: string[]): string[] {
	const names = new Set(tools.map((tool) => tool.name))
	return required.filter((name) => !names.has(resolveToolName(name, tools)))
}

/**
 * The config for calls on the MCP plane, addressed where /whoami said the
 * consumer is served.
 *
 * The consumer's own endpoints (`/<slug>/connections`) sit next to its MCP
 * endpoint, on that plane's host. That is `baseUrl` when the caller gave their
 * gateway's address, but not when they started from the shared entry point,
 * which serves /whoami and nothing else — so they are always sent to the
 * plane the answer named.
 */
function onMCPPlane(config: ResolvedConfig, consumer: { slug: string; url: string }): ResolvedConfig {
	const suffix = `/${consumer.slug}/mcp`
	const url = consumer.url.replace(/\/+$/, '')
	if (!url.endsWith(suffix)) return config
	return { ...config, baseUrl: url.slice(0, -suffix.length) }
}

/**
 * The consumer, once its address is one the key may be sent to.
 *
 * The key already went to the base URL to ask, so this is not about trusting
 * the answer's host — the LLM plane lives on another one by design. It is about
 * the scheme: an https gateway must not be able to point the key at plain http.
 */
function onSafePlane<T extends { slug: string; url: string }>(consumer: T, config: ResolvedConfig): T {
	requireSafeUrl(consumer.url, config.allowInsecureHttp, `the address the gateway gave for "${consumer.slug}"`)
	return consumer
}

function withoutVersion(url: string): string {
	const trimmed = url.replace(/\/+$/, '')
	return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed
}

/**
 * The code a plane answers with for a gateway it does not serve: a Hybrid one,
 * which only its own data plane does.
 */
const SERVED_ELSEWHERE = 'gateway_served_by_external_data_plane'

/** A gateway that cannot answer for a key cannot be used with one secret. */
function asIdentityError(error: unknown, baseUrl: string): unknown {
	if (error instanceof TrustGateError && error.code === SERVED_ELSEWHERE) {
		return new TrustGateError(
			`this key's gateway runs on its own (Hybrid) data plane, which ${baseUrl} does ` +
				'not serve. Set baseUrl (or TRUSTGATE_URL) to the MCP host that data plane ' +
				'is published on.',
			{ status: error.status, code: error.code, cause: error }
		)
	}
	if (error instanceof TrustGateError && error.status === 404) {
		return new TrustGateError(
			`${baseUrl}/whoami answered 404, so the SDK cannot resolve which consumers ` +
				'this key reaches. Usually the base URL is the wrong address: it is the MCP ' +
				"plane's host on its own, with no consumer path after it — not the " +
				'/<application>/mcp endpoint, and not the LLM plane. Otherwise the gateway ' +
				'predates /whoami and needs upgrading.',
			{ status: 404, cause: error }
		)
	}
	return error
}

/**
 * What this application still has to have connected before it can run.
 *
 * `whoami` answers it best, because it also names who has to act. But the field
 * is absent on a gateway too old to send it, and an absent list is not an empty
 * one: taking it for "nothing to connect" is how a batch gets past its own
 * startup check and fails on the first row instead, which is the failure the
 * check exists to prevent. So when it is missing the connections list answers,
 * as it did before `whoami` carried this at all.
 */
function blockedUpstreams(upstreams: KeyUpstream[] | undefined, connections: Connection[]): BlockedUpstream[] {
	if (upstreams) {
		return upstreams.filter((upstream) => upstream.blocked)
	}
	return connections
		.filter((connection) => connection.status !== 'connected')
		.map((connection) => ({
			server: connection.registry || connection.provider,
			blocked: connection.shared ? 'administrator' : 'end_user',
		}))
}

import { Agent, EndUserAgent, endUserAgent } from './agent.js'
import { API_KEY_HEADER, resolveConfig, type ResolvedConfig, type TrustGateConfig } from './config.js'
import { listConnections } from './connections.js'
import {
	MissingToolsError,
	TrustGateError,
	UpstreamNotConnectedError,
	type BlockedUpstream,
} from './errors.js'
import { MCPTransport } from './mcp.js'
import { resolveToolName, type Connection, type GatewayTool } from './types.js'
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
	private readonly config: ResolvedConfig
	private identityPromise?: Promise<KeyIdentity>

	constructor(config: TrustGateConfig = {}) {
		this.config = resolveConfig(config)
	}

	/**
	 * What this key reaches. Read once and remembered: it is a property of the
	 * key, and a long-lived process should not re-ask on every call.
	 */
	async identity(signal?: AbortSignal): Promise<KeyIdentity> {
		this.identityPromise ??= whoAmI(this.config, signal).catch((error: unknown) => {
			this.identityPromise = undefined
			throw asIdentityError(error, this.config.baseUrl)
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
		const consumer = selectConsumer(identity, 'LLM', this.config.llmConsumer, 'llmConsumer')
		return {
			baseUrl: consumer.url,
			anthropicBaseUrl: withoutVersion(consumer.url),
			apiKey: this.config.apiKey,
			headers: { [API_KEY_HEADER]: this.config.apiKey },
			consumer: consumer.slug,
		}
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
		const consumer = selectConsumer(identity, 'MCP', this.config.mcpConsumer, 'mcpConsumer')

		// Accounts before tools: a server with no account for the application can
		// fail the listing itself, which would surface as a bare gateway error
		// before this check — the one that says who fixes it — ever ran.
		const connections = await listConnections(this.config, consumer.slug, undefined, options.signal)
		const blocked = blockedUpstreams(consumer.upstreams, connections)
		if (blocked.length > 0) {
			throw new UpstreamNotConnectedError(blocked)
		}

		const transport = new MCPTransport(this.config, consumer.url)
		const tools = await transport.listTools(options.signal)
		const missing = missingTools(tools, options.requires ?? [])
		if (missing.length > 0) {
			throw new MissingToolsError(missing, tools.map((tool) => tool.name))
		}
		return new Agent(this.config, consumer.slug, transport, tools, missing, connections)
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
		const consumer = selectConsumer(identity, 'MCP', this.config.mcpConsumer, 'mcpConsumer')
		const agent = endUserAgent(this.config, consumer.slug, endUser, consumer.url, [])
		const tools = await agent.refresh(options.signal)
		const missing = missingTools(tools, options.requires ?? [])
		if (missing.length > 0) {
			throw new MissingToolsError(missing, tools.map((tool) => tool.name))
		}
		return agent
	}
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

function withoutVersion(url: string): string {
	const trimmed = url.replace(/\/+$/, '')
	return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed
}

/** A gateway that cannot answer for a key cannot be used with one secret. */
function asIdentityError(error: unknown, baseUrl: string): unknown {
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
		.map((connection) => ({ server: connection.registry || connection.provider }))
}

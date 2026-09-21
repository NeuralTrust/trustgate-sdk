import { Agent, EndUserAgent, endUserAgent } from './agent.js'
import { API_KEY_HEADER, resolveConfig, type ResolvedConfig, type TrustGateConfig } from './config.js'
import { listConnections } from './connections.js'
import {
	EndUserActorUnavailableError,
	MissingToolsError,
	TrustGateError,
	UpstreamNotConnectedError,
} from './errors.js'
import { MCPTransport } from './mcp.js'
import { Actor, type GatewayTool } from './types.js'
import { selectConsumer, whoAmI, type KeyConsumer, type KeyIdentity } from './whoami.js'

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
	/** Pass as `baseURL` to the OpenAI or Anthropic client. */
	baseUrl: string
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
			apiKey: this.config.apiKey,
			headers: { [API_KEY_HEADER]: this.config.apiKey },
			consumer: consumer.slug,
		}
	}

	/**
	 * Opens the agent's surface and proves it is usable before anything runs.
	 *
	 * Three things happen here, and all three are the kind that are cheap now
	 * and expensive later: which actor this consumer is (it decides, not the
	 * caller), whether the tools the agent needs are actually on its toolkit,
	 * and — for an application acting as itself — whether its upstream
	 * accounts are signed in. That last one has no runtime remedy: nobody is
	 * present to open a connect link once a batch is going.
	 */
	async connect(options: ConnectOptions = {}): Promise<Agent | EndUserAgentFactory> {
		const identity = await this.identity(options.signal)
		const consumer = selectConsumer(identity, 'MCP', this.config.mcpConsumer, 'mcpConsumer')

		// An application that names its own users has no surface of its own to
		// ask on: every request to it must say which user it is for, and one
		// that does not is refused. So there is nothing to list here, and the
		// preflight moves to the first named user.
		if (consumer.identitySource === 'app') {
			return new EndUserAgentFactory(this.config, consumer, undefined, options.requires ?? [])
		}

		const transport = new MCPTransport(this.config, consumer.url)
		const tools = await transport.listTools(options.signal)
		const missing = missingTools(tools, options.requires ?? [])
		if (missing.length > 0) {
			throw new MissingToolsError(missing, tools.map((tool) => tool.name))
		}

		// The consumer says which actor it is, so there is nothing to infer and
		// nothing for the caller to configure wrongly. What is left here acting
		// for users signs them in itself, and this key is not one of them: the
		// end-user header means nothing on such a consumer, so a handle minted
		// from it would quietly run every user as the application.
		if (consumer.actsForUsers) {
			throw new EndUserActorUnavailableError(
				`"${consumer.slug}" signs its users in itself, so an API key cannot act for ` +
					'one of them. A key reaches this consumer as the application, which is ' +
					'not who its calls are supposed to be for.'
			)
		}

		const connections = await listConnections(this.config, consumer.slug, undefined, options.signal)
		const pending = connections.filter((connection) => connection.status !== 'connected')
		if (pending.length > 0) {
			throw new UpstreamNotConnectedError(
				pending.map((connection) => connection.provider),
				connectPageFor(consumer)
			)
		}
		return new Agent(this.config, consumer.slug, transport, tools, missing, connections)
	}
}

/**
 * What `connect()` returns for a consumer whose users sign in for themselves.
 *
 * It has no tools of its own to offer, because there is no "itself" to offer
 * them to: every call belongs to one named user. Asking for the surface
 * without naming one is the mistake this type exists to prevent.
 */
export class EndUserAgentFactory {
	readonly actor = Actor.EndUser

	constructor(
		private readonly config: ResolvedConfig,
		private readonly consumer: KeyConsumer,
		private listed: GatewayTool[] | undefined,
		private readonly requires: string[] = []
	) {}

	get slug(): string {
		return this.consumer.slug
	}

	/** The toolkit, which is the same for every user of this application. */
	get tools(): GatewayTool[] {
		if (!this.listed) {
			throw new TrustGateError(
				'this application names its own users, so its toolkit cannot be read without ' +
					'being one of them: await forEndUser(…) and read it from the handle.'
			)
		}
		return this.listed
	}

	/**
	 * The handle for one named user.
	 *
	 * It awaits because the toolkit is read here: it is the same for every user,
	 * but the endpoint refuses a request that names none, so the first handle
	 * reads it and the rest share it. The `requires` check `connect()` could not
	 * run lands here for the same reason.
	 */
	async forEndUser(endUser: string, signal?: AbortSignal): Promise<EndUserAgent> {
		const agent = endUserAgent(
			this.config,
			this.consumer.slug,
			endUser,
			this.consumer.url,
			this.listed ?? []
		)
		if (!this.listed) {
			const tools = await agent.refresh(signal)
			const missing = missingTools(tools, this.requires)
			if (missing.length > 0) {
				throw new MissingToolsError(missing, tools.map((tool) => tool.name))
			}
			this.listed = tools
		}
		return agent
	}
}

/** The page an operator opens to sign the application in to its own accounts. */
function connectPageFor(consumer: KeyConsumer): string {
	return consumer.url.replace(/\/mcp$/, '/connect')
}

function missingTools(tools: GatewayTool[], required: string[]): string[] {
	const names = new Set(tools.map((tool) => tool.name))
	return required.filter((name) => !names.has(name))
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

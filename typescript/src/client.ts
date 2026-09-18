import { Agent, EndUserAgent, endUserAgent } from './agent.js'
import { API_KEY_HEADER, resolveConfig, type ResolvedConfig, type TrustGateConfig } from './config.js'
import { listConnections } from './connections.js'
import {
	AppActorUnavailableError,
	InvalidRequestError,
	MissingToolsError,
	PlaneUnavailableError,
	TrustGateError,
	UpstreamNotConnectedError,
} from './errors.js'
import { MCPTransport } from './mcp.js'
import { Actor, type Connection, type GatewayTool } from './types.js'

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
}

/**
 * The entry point: one gateway, one API key, two planes.
 *
 * The key is attached to consumers, and a consumer has one type — so the
 * tools live behind an MCP consumer and the models behind an LLM one. The
 * same key may be attached to both, which is what lets a single client hand
 * out both halves of an agent.
 */
export class TrustGate {
	private readonly config: ResolvedConfig

	constructor(config: TrustGateConfig = {}) {
		this.config = resolveConfig(config)
	}

	/**
	 * The LLM plane, ready for a provider's own SDK.
	 *
	 * The gateway speaks the providers' own APIs, so nothing here wraps their
	 * clients — it points them somewhere else. Wrapping would mean chasing
	 * every change they make and breaking streaming on the way.
	 */
	get llm(): LLMEndpoint {
		const slug = this.config.llmConsumer
		if (!slug) {
			throw new PlaneUnavailableError(
				'no LLM consumer configured; pass llmConsumer or set TRUSTGATE_LLM_CONSUMER'
			)
		}
		return {
			baseUrl: `${this.config.baseUrl}/${encodeURIComponent(slug)}/v1`,
			apiKey: this.config.apiKey,
			headers: { [API_KEY_HEADER]: this.config.apiKey },
		}
	}

	/** The MCP endpoint, for a framework that brings its own client. */
	get mcpUrl(): string {
		return `${this.config.baseUrl}/${encodeURIComponent(this.mcpSlug())}/mcp`
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
		const slug = this.mcpSlug()
		const actor = await this.probeActor(slug, options.signal)
		const transport = new MCPTransport(this.config, this.mcpUrl)
		const tools = await transport.listTools(options.signal)
		const missing = missingTools(tools, options.requires ?? [])
		if (missing.length > 0) {
			throw new MissingToolsError(missing, tools.map((tool) => tool.name))
		}

		if (actor.actor === Actor.EndUser) {
			return new EndUserAgentFactory(this.config, slug, this.mcpUrl, tools)
		}

		const pending = actor.connections.filter((connection) => connection.status !== 'connected')
		if (pending.length > 0) {
			throw new UpstreamNotConnectedError(
				pending.map((connection) => connection.provider),
				`${this.config.baseUrl}/${encodeURIComponent(slug)}/connect`
			)
		}
		return new Agent(this.config, slug, transport, tools, missing, actor.connections)
	}

	/**
	 * Asks the gateway which actor this consumer is, by asking it something
	 * only one of the two can answer.
	 *
	 * An application that acts as itself has upstream accounts and lists them;
	 * one that acts for its users has none of its own and says so, with a
	 * conflict rather than an empty list. So the refusal is the answer.
	 */
	private async probeActor(
		slug: string,
		signal?: AbortSignal
	): Promise<{ actor: Actor; connections: Connection[] }> {
		try {
			const connections = await listConnections(this.config, slug, undefined, signal)
			return { actor: Actor.Application, connections }
		} catch (error) {
			if (error instanceof AppActorUnavailableError) {
				return { actor: Actor.EndUser, connections: [] }
			}
			if (error instanceof InvalidRequestError) {
				throw new TrustGateError(
					'this gateway cannot report an application actor’s own connections, so the SDK ' +
						'cannot tell which actor the consumer is. Upgrade the gateway, or use the ' +
						'MCP endpoint directly with trustgate.mcpUrl.',
					{ cause: error }
				)
			}
			throw error
		}
	}

	private mcpSlug(): string {
		const slug = this.config.mcpConsumer
		if (!slug) {
			throw new PlaneUnavailableError(
				'no MCP consumer configured; pass mcpConsumer or set TRUSTGATE_MCP_CONSUMER'
			)
		}
		return slug
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
		readonly slug: string,
		private readonly url: string,
		/** The toolkit, which is the same for every user of this application. */
		readonly tools: GatewayTool[]
	) {}

	forEndUser(endUser: string): EndUserAgent {
		return endUserAgent(this.config, this.slug, endUser, this.url, this.tools)
	}
}

function missingTools(tools: GatewayTool[], required: string[]): string[] {
	const names = new Set(tools.map((tool) => tool.name))
	return required.filter((name) => !names.has(name))
}

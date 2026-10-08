import { END_USER_HEADER, maskedWhenPrinted, type ResolvedConfig } from './config.js'
import { createConnectLink, listConnections, requireEndUser } from './connections.js'
import { ToolNotFoundError, TrustGateError } from './errors.js'
import { adapterFor, restoreArguments, type ConversionWarning, type ToolResult } from './formats.js'
import { MCPTransport, gatewayConnectUrl } from './mcp.js'
import {
	Actor,
	ToolFormat,
	resolveToolName,
	type ConnectLink,
	type ConnectTarget,
	type Connection,
	type Endpoint,
	type GatewayTool,
	type JSONSchema,
	type ToolCall,
} from './types.js'

export type ToolkitOptions = {
	/**
	 * Ask the provider to hold the model to the schema. Off by default: it is
	 * a stricter promise bought with a lossy rewrite, and some tools cannot be
	 * expressed under it at all (see `warnings`).
	 */
	strict?: boolean
}

/**
 * A tool surface in one provider's dialect, with the executor that belongs to
 * it.
 *
 * They travel together because they are two halves of one translation: what
 * `tools` added on the way out, `execute` has to undo on the way back.
 *
 * `Tool` and `Output` are the provider's own types, named by the caller:
 *
 * ```ts
 * const { tools, execute } = agent.toolkit<
 *   OpenAI.Responses.Tool,
 *   OpenAI.Responses.ResponseInputItem
 * >(ToolFormat.OpenAIResponses)
 * ```
 *
 * They default to `unknown`, so nothing breaks by leaving them out — but then
 * "pass this straight to the provider's API" is a promise the type does not
 * keep, and the caller casts at the boundary. The SDK cannot name them itself:
 * it carries no dependency on any provider's package, which is what lets one
 * install serve all of them.
 */
export class Toolkit<Tool = unknown, Output = unknown> {
	constructor(
		/** Pass this straight to the provider's API. */
		readonly tools: Tool[],
		/** Tools whose schema could not be expressed in the requested dialect. */
		readonly warnings: ConversionWarning[],
		private readonly format: ToolFormat,
		private readonly originals: Map<string, JSONSchema>,
		private readonly transport: MCPTransport
	) {
		// Bound, because the documented way to use this is to destructure it —
		// `const { tools, execute } = agent.toolkit(…)` — and an unbound method
		// loses the format it needs the moment it is called that way.
		this.calls = this.calls.bind(this)
		this.execute = this.execute.bind(this)
	}

	/** The calls the model asked for, read out of the provider's response. */
	calls(output: unknown): ToolCall[] {
		return adapterFor(this.format).extractCalls(output)
	}

	/**
	 * Runs the calls the model asked for and returns what to send back.
	 *
	 * Every call goes to the gateway, so the policy, the audit trail and the
	 * upstream credentials stay where they were. The caller's process only
	 * decides whether to make the call at all — and it makes none for a tool
	 * this toolkit was not built with: a model can name a tool it was never
	 * offered, and a toolkit narrowed by hand only means something if this
	 * holds to it. Narrow `agent.tools` before calling `toolkit()`: this checks
	 * against the tools it was built with. The gateway still applies its own
	 * policy to every call.
	 */
	async execute(output: unknown, signal?: AbortSignal): Promise<Output[]> {
		const adapter = adapterFor(this.format)
		const calls = adapter.extractCalls(output)
		for (const call of calls) {
			if (!this.originals.has(call.name)) {
				throw new ToolNotFoundError(call.name, `the model asked for "${call.name}", which is not in this toolkit`)
			}
		}
		const results: ToolResult[] = []
		for (const call of calls) {
			const args = restoreArguments(call.arguments, this.originals.get(call.name))
			const result = await this.transport.callTool(call.name, args, signal)
			results.push({ call, result })
		}
		return adapter.toOutputs(results) as Output[]
	}
}

/**
 * An application's handle on its gateway.
 *
 * It speaks as the application itself: one principal, its own upstream
 * accounts, nothing per-user. Which handle you get is not a choice made here —
 * it follows from how the consumer was configured, which is why `connect()`
 * returns one of these or refuses.
 */
export class Agent {
	readonly actor = Actor.Application
	// Runtime-private: it holds the key, and a logged agent must not.
	readonly #config: ResolvedConfig

	constructor(
		config: ResolvedConfig,
		readonly slug: string,
		private readonly transport: MCPTransport,
		/** The tools this consumer serves, as the gateway named them. */
		public tools: GatewayTool[],
		/** Tools asked for in `requires` that the toolkit does not carry. */
		readonly missing: string[],
		/** The application's own upstream accounts, as of `connect()`. */
		readonly connections: Connection[]
	) {
		this.#config = config
	}

	/** URL and headers for a framework that brings its own MCP client. */
	get mcp(): Endpoint {
		return maskedWhenPrinted<Endpoint>({ url: this.transport.url, headers: this.transport.headers }, ['headers'])
	}

	/**
	 * The same surface, translated for a provider you call directly.
	 *
	 * Name the provider's types to have them travel with it:
	 * `toolkit<OpenAI.Responses.Tool, OpenAI.Responses.ResponseInputItem>(…)`.
	 */
	toolkit<Tool = unknown, Output = unknown>(
		format: ToolFormat,
		options: ToolkitOptions = {}
	): Toolkit<Tool, Output> {
		const { tools, warnings, originals } = adapterFor(format).convert(this.tools, {
			strict: options.strict ?? false,
		})
		return new Toolkit<Tool, Output>(
			tools as Tool[],
			warnings,
			format,
			originals,
			this.transport
		)
	}

	/**
	 * One tool, called directly. The escape hatch under the toolkits.
	 *
	 * The server prefix is optional here: "list_issues" reaches
	 * "linear_list_issues" while Linear is the only server of this application
	 * that serves it. The gateway put that prefix there, so a caller writing the
	 * name by hand should not have to.
	 */
	async callTool(
		name: string,
		args: Record<string, unknown> = {},
		signal?: AbortSignal
	): Promise<Record<string, unknown>> {
		return this.transport.callTool(resolveToolName(name, this.tools), args, signal)
	}

	/**
	 * Re-reads the surface.
	 *
	 * An admin owns this toolkit and can change it under a running agent, so a
	 * long-lived process re-reads rather than trusting the list it took at
	 * startup.
	 */
	async refresh(signal?: AbortSignal): Promise<GatewayTool[]> {
		this.tools = await this.transport.listTools(signal)
		return this.tools
	}

	/** What the application still owes before it can call every server. */
	async refreshConnections(signal?: AbortSignal): Promise<Connection[]> {
		return listConnections(this.#config, this.slug, undefined, signal)
	}

	/**
	 * The same application, acting for one named person.
	 *
	 * No round trip and no second surface to read: the toolkit an admin bound
	 * is the application's, identical for everyone it acts for. What changes is
	 * one header, and with it whose upstream account the gateway reaches for.
	 */
	forEndUser(endUser: string): EndUserAgent {
		return endUserAgent(this.#config, this.slug, endUser, this.transport.url, this.tools)
	}
}

/**
 * An application's handle for one of its own end users.
 *
 * The user travels in a header, so a handle is a header and nothing more —
 * but the MCP endpoint's headers are fixed when a client connects, which is
 * why each user needs their own transport rather than a shared one.
 */
export class EndUserAgent {
	readonly actor = Actor.EndUser
	readonly #config: ResolvedConfig

	constructor(
		config: ResolvedConfig,
		readonly slug: string,
		readonly endUser: string,
		private readonly transport: MCPTransport,
		public tools: GatewayTool[]
	) {
		this.#config = config
	}

	get mcp(): Endpoint {
		return maskedWhenPrinted<Endpoint>({ url: this.transport.url, headers: this.transport.headers }, ['headers'])
	}

	toolkit<Tool = unknown, Output = unknown>(
		format: ToolFormat,
		options: ToolkitOptions = {}
	): Toolkit<Tool, Output> {
		const { tools, warnings, originals } = adapterFor(format).convert(this.tools, {
			strict: options.strict ?? false,
		})
		return new Toolkit<Tool, Output>(
			tools as Tool[],
			warnings,
			format,
			originals,
			this.transport
		)
	}

	async callTool(
		name: string,
		args: Record<string, unknown> = {},
		signal?: AbortSignal
	): Promise<Record<string, unknown>> {
		return this.transport.callTool(name, args, signal)
	}

	async refresh(signal?: AbortSignal): Promise<GatewayTool[]> {
		this.tools = await this.transport.listTools(signal)
		return this.tools
	}

	/** Which servers this user has connected, and which they have not. */
	async connections(signal?: AbortSignal): Promise<Connection[]> {
		return listConnections(this.#config, this.slug, this.endUser, signal)
	}

	/**
	 * The page to put in front of this user so they can connect an account.
	 *
	 * Naming a provider narrows it to that one server, and an instance (a
	 * connection's `instance`) to one of two instances of it; omitting both
	 * covers every server of the application that forwards a credential. A
	 * shared account is refused: it is not this user's to connect, which a
	 * connection's `shared` says beforehand. The link expires, so it is minted
	 * when it is about to be shown, not cached.
	 */
	async connectLink(target?: string | ConnectTarget, signal?: AbortSignal): Promise<ConnectLink> {
		const resolved = typeof target === 'string' ? { provider: target } : (target ?? {})
		return createConnectLink(this.#config, this.slug, this.endUser, resolved, signal)
	}
}

/** The Store's inventory: every server the person has, with the ones still waiting on their account. */
const INVENTORY_TOOL = 'trustgate_list_tools'

/**
 * The Store's install. Called again for a server that is installed but not
 * connected, it returns the link to connect it: the Store's one way in.
 */
const INSTALL_TOOL = 'trustgate_store_install'

/** How long the link install mints stays valid, as the gateway sets it. */
const CONNECT_TICKET_TTL_MS = 15 * 60_000

interface PendingServer {
	name: string
	code: string
}

/**
 * A person's handle on their own Store.
 *
 * The servers are the ones they installed, narrowed to what Access grants
 * them, and every call runs as them — their own upstream accounts, their own
 * audit trail. A server whose account they have not connected yet is not on
 * the surface: the Store's inventory reports it, and installing it again
 * returns the page to connect it, which is what {@link needsConnect} and
 * {@link connectLink} read.
 */
export class UserAgent {
	readonly actor = Actor.User

	constructor(
		private readonly transport: MCPTransport,
		/** The tools on this person's Store, as the gateway named them. */
		public tools: GatewayTool[],
		private pending: PendingServer[] = []
	) {}

	/** @internal Opens the handle with what the Store says is still waiting. */
	static async open(transport: MCPTransport, tools: GatewayTool[], signal?: AbortSignal): Promise<UserAgent> {
		return new UserAgent(transport, tools, await readPending(transport, tools, signal))
	}

	/**
	 * URL and headers for a framework that brings its own MCP client.
	 *
	 * The bearer in it is a session token, valid for an hour: a framework that
	 * keeps headers longer than that has to read this again.
	 */
	get mcp(): Endpoint {
		return maskedWhenPrinted<Endpoint>({ url: this.transport.url, headers: this.transport.headers }, ['headers'])
	}

	toolkit<Tool = unknown, Output = unknown>(
		format: ToolFormat,
		options: ToolkitOptions = {}
	): Toolkit<Tool, Output> {
		const { tools, warnings, originals } = adapterFor(format).convert(this.tools, {
			strict: options.strict ?? false,
		})
		return new Toolkit<Tool, Output>(tools as Tool[], warnings, format, originals, this.transport)
	}

	/** One tool, called directly. The server prefix is optional, as on {@link Agent.callTool}. */
	async callTool(
		name: string,
		args: Record<string, unknown> = {},
		signal?: AbortSignal
	): Promise<Record<string, unknown>> {
		return this.transport.callTool(resolveToolName(name, this.tools), args, signal)
	}

	/** Re-reads the surface: after the person installs a server, or connects one. */
	async refresh(signal?: AbortSignal): Promise<GatewayTool[]> {
		this.tools = await this.transport.listTools(signal)
		this.pending = await readPending(this.transport, this.tools, signal)
		return this.tools
	}

	/** The servers waiting for this person to connect (or reconnect) an account. */
	get needsConnect(): string[] {
		return this.pending.map((server) => server.name)
	}

	/**
	 * The page where this person connects a server still missing.
	 *
	 * `server` is one of {@link needsConnect} (its code works too); without it,
	 * the first. Undefined when nothing is waiting. Each server has its own
	 * page. The link expires, so it is minted when it is about to be shown;
	 * after the person connects, {@link refresh} brings the server's tools onto
	 * the surface.
	 */
	async connectLink(server?: string | AbortSignal, signal?: AbortSignal): Promise<ConnectLink | undefined> {
		if (server instanceof AbortSignal) {
			signal = server
			server = undefined
		}
		let pending = this.pending
		if (server !== undefined) {
			const named = server
			pending = pending.filter((p) => p.name === named || p.code === named)
			if (pending.length === 0) {
				throw new TrustGateError(
					`${named} is not waiting to be connected; these are: ${this.needsConnect.join(', ') || 'none'}`,
					{ code: 'nothing_to_connect' }
				)
			}
		}
		const target = pending[0]
		if (!target) return undefined
		const result = await this.transport.callTool(INSTALL_TOOL, { code: target.code }, signal)
		const structured = result.structuredContent as Record<string, unknown> | undefined
		const offered = typeof structured?.connect_url === 'string' ? structured.connect_url : ''
		if (!offered) return undefined
		const connectUrl = gatewayConnectUrl(offered, this.transport.url)
		if (!connectUrl) {
			throw new TrustGateError(`${INSTALL_TOOL} answered with a link that is not this gateway's, so it was not passed on`, {
				code: 'untrusted_connect_url',
			})
		}
		return {
			connectUrl,
			ticket: new URL(connectUrl).searchParams.get('ticket') ?? '',
			expiresAt: new Date(Date.now() + CONNECT_TICKET_TTL_MS),
		}
	}
}

/**
 * The servers the Store says are waiting on this person, and connectable.
 *
 * Read from the inventory, which names install as the way to connect each one.
 * A server the person cannot connect themselves (an account an admin holds for
 * everyone) carries no such pointer and is left out. A Store without the
 * inventory has nothing to say, and neither does this.
 */
async function readPending(
	transport: MCPTransport,
	tools: GatewayTool[],
	signal?: AbortSignal
): Promise<PendingServer[]> {
	if (!tools.some((tool) => tool.name === INVENTORY_TOOL)) return []
	const result = await transport.callTool(INVENTORY_TOOL, {}, signal)
	const structured = result.structuredContent as Record<string, unknown> | undefined
	const servers = Array.isArray(structured?.servers) ? structured.servers : []
	const pending: PendingServer[] = []
	for (const entry of servers) {
		if (typeof entry !== 'object' || entry === null) continue
		const server = entry as Record<string, unknown>
		const code = typeof server.code === 'string' ? server.code : ''
		if (server.state !== 'needs_connect' || server.connect_tool !== INSTALL_TOOL || !code) continue
		pending.push({ name: typeof server.name === 'string' && server.name ? server.name : code, code })
	}
	return pending
}

/** Builds the per-user handle, with the header that names them. */
export function endUserAgent(
	config: ResolvedConfig,
	slug: string,
	rawEndUser: string,
	url: string,
	tools: GatewayTool[]
): EndUserAgent {
	const endUser = requireEndUser(rawEndUser)
	const transport = new MCPTransport(config, url, { [END_USER_HEADER]: endUser })
	return new EndUserAgent(config, slug, endUser, transport, tools)
}

export { ToolNotFoundError }

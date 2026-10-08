import { API_KEY_HEADER, type ResolvedConfig } from './config.js'
import {
	AuthenticationError,
	type BlockedUpstream,
	ConsentRequiredError,
	InvalidRequestError,
	PolicyBlockedError,
	RateLimitedError,
	ServiceUnavailableError,
	ToolNotFoundError,
	TrustGateError,
	TrustGateServerError,
	UpstreamNotConnectedError,
} from './errors.js'
import { retryAfterMs, send, type Sent } from './http.js'
import type { GatewayTool, JSONSchema } from './types.js'

/** JSON-RPC codes the gateway answers with, beyond the standard four. */
const CODE_CONSENT_REQUIRED = -32003
const CODE_RATE_LIMITED = -32004
const CODE_UNAVAILABLE = -32005
const CODE_RESOURCE_NOT_FOUND = -32002
const CODE_POLICY_BLOCKED = -32001
const CODE_INVALID_REQUEST = -32600
const CODE_INVALID_PARAMS = -32602
const CODE_INTERNAL = -32603

/**
 * How a caller other than an API key authenticates: a signed-in person.
 *
 * `headers` is awaited on every call so a token can be renewed under a running
 * agent; `renew` is asked once after the gateway refuses one, and says whether
 * there is anything to retry with.
 */
export interface Credentials {
	headers(): Promise<Record<string, string>>
	headersNow(): Record<string, string>
	renew(): Promise<boolean>
}

type RPCError = { code: number; message: string; data?: unknown }
type RPCResponse = { id?: unknown; result?: Record<string, unknown>; error?: RPCError }

/**
 * The gateway's MCP endpoint, spoken directly.
 *
 * Only two methods are needed to put a consumer's tools in front of a model —
 * list them and call them — so this is a JSON-RPC client rather than a whole
 * MCP implementation. The gateway is stateless: there is no handshake to do
 * and no session to carry, so every call stands on its own.
 */
export class MCPTransport {
	private nextId = 1
	// Runtime-private, not just TypeScript-private: these hold the key or the
	// session, and a logged or serialised transport must not carry either.
	readonly #config: ResolvedConfig
	readonly #credentials?: Credentials

	constructor(
		config: ResolvedConfig,
		readonly url: string,
		private readonly extraHeaders: Record<string, string> = {},
		credentials?: Credentials
	) {
		this.#config = config
		this.#credentials = credentials
	}

	get headers(): Record<string, string> {
		if (this.#credentials) return { ...this.#credentials.headersNow(), ...this.extraHeaders }
		return { [API_KEY_HEADER]: this.#config.apiKey, ...this.extraHeaders }
	}

	async listTools(signal?: AbortSignal): Promise<GatewayTool[]> {
		const result = await this.call('tools/list', {}, signal)
		const tools = Array.isArray(result.tools) ? result.tools : []
		return tools.map((tool) => {
			const raw = tool as Record<string, unknown>
			return {
				name: String(raw.name ?? ''),
				title: typeof raw.title === 'string' ? raw.title : undefined,
				description: typeof raw.description === 'string' ? raw.description : undefined,
				inputSchema: (raw.inputSchema as JSONSchema) ?? { type: 'object', properties: {} },
				outputSchema: raw.outputSchema as JSONSchema | undefined,
			}
		})
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal
	): Promise<Record<string, unknown>> {
		try {
			return await this.call('tools/call', { name, arguments: args }, signal)
		} catch (error) {
			// The gateway reports an unknown tool as invalid params, which is
			// true of the request and useless to the caller: what they need to
			// know is which tool, because a toolkit can lose one under them.
			if (error instanceof InvalidRequestError && error.code === String(CODE_INVALID_PARAMS)) {
				throw new ToolNotFoundError(name, error.message)
			}
			throw error
		}
	}

	async call(
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal
	): Promise<Record<string, unknown>> {
		const id = this.nextId++
		const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
		let sent = await this.post(method, body, signal)
		// A session token can be refused before its own expiry says so (the
		// clock here is not the gateway's); one renewal, one retry.
		if (sent.response.status === 401 && this.#credentials && (await this.#credentials.renew())) {
			sent = await this.post(method, body, signal)
		}

		const { response, text } = sent
		if (response.status === 401 || response.status === 403) {
			const refused = this.#credentials ? 'this sign-in' : 'this API key'
			throw new AuthenticationError(`the gateway refused ${refused} for ${this.url}${whatItSaid(text)}`, {
				status: response.status,
			})
		}
		const rpc = parseRPCResponse(text, id)
		if (!rpc) {
			throw new TrustGateError(
				`MCP ${method} returned no JSON-RPC response (HTTP ${response.status})` + whatItSaid(text),
				{ status: response.status }
			)
		}
		if (rpc.error) throw errorForRPC(rpc.error, this.url, response)
		return rpc.result ?? {}
	}

	private async post(method: string, body: string, signal?: AbortSignal): Promise<Sent> {
		const auth = this.#credentials
			? { ...(await this.#credentials.headers()), ...this.extraHeaders }
			: this.headers
		return send(
			this.#config.fetch,
			this.url,
			{
				method: 'POST',
				headers: {
					...auth,
					'Content-Type': 'application/json',
					// A plain JSON answer is enough: the SDK re-lists on demand
					// rather than listening for a change on the response.
					Accept: 'application/json',
				},
				body,
			},
			{ timeoutMs: this.#config.timeoutMs, signal, failure: `MCP ${method} failed to reach ${this.url}` }
		)
	}
}

/**
 * Reads the response body, which is not always JSON.
 *
 * When a change to the surface has to be announced, the gateway answers the
 * same request as an event stream and puts the response in a frame after the
 * notification. Both shapes carry the same JSON-RPC object, so both are read
 * here; a frame that is not this request's answer is skipped rather than
 * mistaken for it.
 */
export function parseRPCResponse(text: string, id: number): RPCResponse | undefined {
	const trimmed = text.trim()
	if (!trimmed) return undefined
	if (trimmed.startsWith('{')) {
		try {
			return JSON.parse(trimmed) as RPCResponse
		} catch {
			return undefined
		}
	}
	for (const line of trimmed.split('\n')) {
		if (!line.startsWith('data:')) continue
		try {
			const frame = JSON.parse(line.slice('data:'.length).trim()) as RPCResponse
			if (frame.id === id) return frame
		} catch {
			continue
		}
	}
	return undefined
}

/** The reason a -32003 carries when nobody on this call can connect the account. */
const REASON_APPLICATION_NOT_CONNECTED = 'application_not_connected'

function errorForRPC(error: RPCError, endpoint: string, response?: Response): TrustGateError {
	const data = (error.data && typeof error.data === 'object' ? error.data : {}) as Record<string, unknown>
	switch (error.code) {
		case CODE_CONSENT_REQUIRED: {
			if (notConnectableHere(data)) {
				return new UpstreamNotConnectedError([upstreamFrom(data, error.message)])
			}
			const provider = String(data.provider ?? 'this provider')
			const connectUrl = gatewayConnectUrl(String(data.connect_url ?? ''), endpoint)
			if (!connectUrl) {
				return new TrustGateError(
					`a consent prompt for ${provider} came back with a link that is not this gateway's ` +
						`(${new URL(endpoint).origin}), so it was not passed on`,
					{ code: 'untrusted_connect_url' }
				)
			}
			// The gateway's own message quotes the link, ticket included; the
			// SDK writes its own so the ticket does not end up in a log.
			return new ConsentRequiredError(provider, connectUrl, String(data.cause ?? ''))
		}
		case CODE_POLICY_BLOCKED:
			return new PolicyBlockedError(error.message, { code: String(error.code) })
		case CODE_RATE_LIMITED:
			return new RateLimitedError(error.message, response ? retryAfterMs(response) : undefined)
		case CODE_UNAVAILABLE:
			return new ServiceUnavailableError(error.message, { code: String(error.code) })
		case CODE_INTERNAL:
			return new TrustGateServerError(error.message, { code: String(error.code) })
		case CODE_INVALID_PARAMS:
		case CODE_INVALID_REQUEST:
		case CODE_RESOURCE_NOT_FOUND:
			return new InvalidRequestError(error.message, { code: String(error.code) })
		default:
			return new TrustGateError(error.message, { code: String(error.code) })
	}
}

/**
 * Whether a -32003 names an account this call cannot connect.
 *
 * The gateway uses the code for both: a consent prompt, which carries the page
 * to open, and a server whose account belongs to its instance or to a person
 * the call did not name, which carries none. A gateway too old to send the
 * reason still leaves the link out, and an empty link is never something to
 * put in front of anyone.
 */
function notConnectableHere(data: Record<string, unknown>): boolean {
	if (data.reason === REASON_APPLICATION_NOT_CONNECTED) return true
	return !String(data.connect_url ?? '').trim()
}

/**
 * The connect link, when it is one this gateway minted; undefined otherwise.
 *
 * The gateway relays errors from the servers behind it, so the code alone does
 * not say who wrote the link, and it is a page the SDK tells the caller to put
 * in front of a person. The gateway builds it from the endpoint the call went
 * to, `<endpoint origin>/<consumer>/mcp/connect?ticket=…`, so a link on any
 * other host or port, to another page, or with credentials in it, is not
 * passed on.
 *
 * A gateway behind a proxy that does not forward the scheme writes `http://`
 * for its own https host. The SDK just reached that host over https, so the
 * link is upgraded rather than refused — the ticket never goes out in clear.
 */
export function gatewayConnectUrl(link: string, endpoint: string): string | undefined {
	let parsed: URL
	let base: URL
	try {
		parsed = new URL(link)
		base = new URL(endpoint)
	} catch {
		return undefined
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
	if (parsed.username || parsed.password) return undefined
	if (parsed.hostname !== base.hostname || parsed.port !== base.port) return undefined
	if (!parsed.pathname.replace(/\/+$/, '').endsWith('/mcp/connect')) return undefined
	if (!parsed.searchParams.get('ticket')) return undefined
	if (base.protocol === 'https:') parsed.protocol = 'https:'
	return parsed.toString()
}

/** The blocked server, as much of it as the error names. */
function upstreamFrom(data: Record<string, unknown>, message: string): BlockedUpstream {
	const provider = typeof data.provider === 'string' && data.provider ? data.provider : undefined
	const registry = typeof data.registry === 'string' && data.registry ? data.registry : undefined
	const quoted = /"([^"]+)"/.exec(message)?.[1]
	return {
		server: registry ?? provider ?? quoted ?? 'this server',
		blocked: data.shared === true ? 'administrator' : 'end_user',
	}
}

/**
 * The reason the endpoint gave, when it did not give it in JSON-RPC.
 *
 * A plain HTTP error — a missing header, a path that is no virtual MCP — says
 * why in its body, and dropping that leaves a status code to guess from.
 */
function whatItSaid(text: string): string {
	let said = (text ?? '').split(/\s+/).filter(Boolean).join(' ')
	try {
		const body: unknown = JSON.parse(text)
		if (body && typeof body === 'object') {
			for (const key of ['error', 'message', 'detail']) {
				const value = (body as Record<string, unknown>)[key]
				if (typeof value === 'string' && value.trim()) {
					said = value.trim()
					break
				}
			}
		}
	} catch {
		// Not JSON. The whitespace-collapsed body is the best there is.
	}
	return said ? `: ${said.slice(0, 200)}` : ''
}

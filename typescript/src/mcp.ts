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
import { retryAfterMs } from './http.js'
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

	constructor(
		private readonly config: ResolvedConfig,
		readonly url: string,
		private readonly extraHeaders: Record<string, string> = {},
		private readonly credentials?: Credentials
	) {}

	get headers(): Record<string, string> {
		if (this.credentials) return { ...this.credentials.headersNow(), ...this.extraHeaders }
		return { [API_KEY_HEADER]: this.config.apiKey, ...this.extraHeaders }
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
		let response = await this.post(method, body, signal)
		// A session token can be refused before its own expiry says so (the
		// clock here is not the gateway's); one renewal, one retry.
		if (response.status === 401 && this.credentials && (await this.credentials.renew())) {
			response = await this.post(method, body, signal)
		}

		if (response.status === 401 || response.status === 403) {
			const refused = this.credentials ? 'this sign-in' : 'this API key'
			throw new AuthenticationError(
				`the gateway refused ${refused} for ${this.url}${whatItSaid(await response.text())}`,
				{ status: response.status }
			)
		}
		const text = await response.text()
		const rpc = parseRPCResponse(text, id)
		if (!rpc) {
			throw new TrustGateError(
				`MCP ${method} returned no JSON-RPC response (HTTP ${response.status})` +
					whatItSaid(text),
				{ status: response.status }
			)
		}
		if (rpc.error) throw errorForRPC(rpc.error, response)
		return rpc.result ?? {}
	}

	private async post(method: string, body: string, signal?: AbortSignal): Promise<Response> {
		const auth = this.credentials
			? { ...(await this.credentials.headers()), ...this.extraHeaders }
			: this.headers
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
		try {
			return await this.config.fetch(this.url, {
				method: 'POST',
				headers: {
					...auth,
					'Content-Type': 'application/json',
					// A plain JSON answer is enough: the SDK re-lists on demand
					// rather than listening for a change on the response.
					Accept: 'application/json',
				},
				body,
				signal: signal ?? controller.signal,
			})
		} catch (cause) {
			throw new TrustGateError(`MCP ${method} failed to reach ${this.url}`, { cause })
		} finally {
			clearTimeout(timeout)
		}
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

function errorForRPC(error: RPCError, response?: Response): TrustGateError {
	const data = (error.data && typeof error.data === 'object' ? error.data : {}) as Record<string, unknown>
	switch (error.code) {
		case CODE_CONSENT_REQUIRED:
			if (notConnectableHere(data)) {
				return new UpstreamNotConnectedError([upstreamFrom(data, error.message)])
			}
			return new ConsentRequiredError(
				String(data.provider ?? 'this provider'),
				String(data.connect_url ?? ''),
				String(data.cause ?? ''),
				error.message
			)
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

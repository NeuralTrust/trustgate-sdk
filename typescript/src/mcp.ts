import { API_KEY_HEADER, type ResolvedConfig } from './config.js'
import {
	AuthenticationError,
	ConsentRequiredError,
	InvalidRequestError,
	PolicyBlockedError,
	ToolNotFoundError,
	TrustGateError,
	TrustGateServerError,
} from './errors.js'
import type { GatewayTool, JSONSchema } from './types.js'

/** JSON-RPC codes the gateway answers with, beyond the standard four. */
const CODE_CONSENT_REQUIRED = -32003
const CODE_RESOURCE_NOT_FOUND = -32002
const CODE_POLICY_BLOCKED = -32001
const CODE_INVALID_REQUEST = -32600
const CODE_INVALID_PARAMS = -32602
const CODE_INTERNAL = -32603

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
		private readonly extraHeaders: Record<string, string> = {}
	) {}

	get headers(): Record<string, string> {
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
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
		let response: Response
		try {
			response = await this.config.fetch(this.url, {
				method: 'POST',
				headers: {
					...this.headers,
					'Content-Type': 'application/json',
					// A plain JSON answer is enough: the SDK re-lists on demand
					// rather than listening for a change on the response.
					Accept: 'application/json',
				},
				body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
				signal: signal ?? controller.signal,
			})
		} catch (cause) {
			throw new TrustGateError(`MCP ${method} failed to reach ${this.url}`, { cause })
		} finally {
			clearTimeout(timeout)
		}

		if (response.status === 401 || response.status === 403) {
			throw new AuthenticationError(
				`the gateway refused this API key for ${this.url}`,
				{ status: response.status }
			)
		}
		const text = await response.text()
		const rpc = parseRPCResponse(text, id)
		if (!rpc) {
			throw new TrustGateError(
				`MCP ${method} returned no JSON-RPC response (HTTP ${response.status})`,
				{ status: response.status }
			)
		}
		if (rpc.error) throw errorForRPC(rpc.error)
		return rpc.result ?? {}
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

function errorForRPC(error: RPCError): TrustGateError {
	const data = (error.data ?? {}) as Record<string, unknown>
	switch (error.code) {
		case CODE_CONSENT_REQUIRED:
			return new ConsentRequiredError(
				String(data.provider ?? 'this provider'),
				String(data.connect_url ?? ''),
				String(data.cause ?? ''),
				error.message
			)
		case CODE_POLICY_BLOCKED:
			return new PolicyBlockedError(error.message, { code: String(error.code) })
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

/**
 * The gateway's own A2A errors, as the SDK's error types.
 *
 * The SDK does not speak A2A: an A2A client (`@a2a-js/sdk`) sends the
 * messages, through the gateway, to the address `TrustGate.agent()` hands
 * over. The gateway forwards the agent's JSON-RPC as it is, and answers with
 * codes of its own only when it stops a call itself:
 *
 * - `-32090` a policy blocked the call or its answer
 * - `-32091` a rate limit was reached, with the seconds to wait
 * - `-32092` the gateway could not complete the call (the agent was
 *   unreachable, timed out, answered something that was not A2A…)
 * - `-32093` the agent's identity mode needs a signed-in user
 * - `-32094` the call was refused before it was read: no valid key, a key or
 *   caller the application does not take, no application at that path
 *
 * An A2A client knows none of them, so they reach the caller as a generic
 * JSON-RPC error (`JsonRpcTransportError`, or the cause of a stream's error).
 * `gatewayError` turns one into the type an MCP call throws for the same
 * refusal (`PolicyBlockedError`, `RateLimitedError`, …):
 *
 * ```ts
 * const reply = await a2a.withGatewayErrors(() => client.sendMessage(request))
 * for await (const event of a2a.streamWithGatewayErrors(client.sendMessageStream(request))) { … }
 * ```
 *
 * An error the agent itself answers, in the same range of codes, is relayed by
 * the gateway as it came: one is only taken for the gateway's when it carries
 * what the gateway writes (its reasons, its messages), and is otherwise left
 * to the A2A client.
 */
import {
	AuthenticationError,
	InvalidRequestError,
	PolicyBlockedError,
	RateLimitedError,
	ServiceUnavailableError,
	TrustGateError,
	TrustGateServerError,
} from './errors.js'

export const CODE_POLICY_BLOCKED = -32090
export const CODE_RATE_LIMITED = -32091
export const CODE_GATEWAY_FAILURE = -32092
export const CODE_IDENTITY_REQUIRED = -32093
export const CODE_ACCESS_REFUSED = -32094

/**
 * The message the gateway writes with each code. A client that drops the
 * error's data keeps the code and the message, and the message tells the
 * gateway's error from an agent's.
 */
const MESSAGES: Record<number, string> = {
	[CODE_POLICY_BLOCKED]: 'Blocked by gateway policy',
	[CODE_RATE_LIMITED]: 'Rate limit exceeded',
	[CODE_GATEWAY_FAILURE]: 'Gateway could not complete the call',
	[CODE_IDENTITY_REQUIRED]: 'An authenticated user is required',
}

const POLICY_REASONS = new Set(['policy_blocked', 'mask_unsupported'])

/**
 * The -32092 reasons that a later call may not meet: the agent or the
 * gateway's own store was slow or away. The others need a fix (the agent's
 * answer, a credential, an id that belongs to another caller).
 */
const TRANSIENT = new Set([
	'upstream_unreachable',
	'upstream_timeout',
	'stream_idle',
	'stream_max_duration',
	'ownership_unavailable',
	'signing_key_unavailable',
	'plan_unavailable',
])

type RpcError = { code: number; message: string; data?: Record<string, unknown> }

/**
 * The SDK's error for an A2A error the gateway answered; undefined for any
 * other.
 *
 * `error` is what an A2A client threw: a `@a2a-js/sdk` error (it keeps the
 * code and the data, on the error or on its `cause`), a JSON-RPC error object
 * (`{code, message, data}`) or a whole JSON-RPC response. `status` is the HTTP
 * status it came with, when known. The result keeps `error` as its `cause`.
 */
export function gatewayError(error: unknown, options: { status?: number } = {}): TrustGateError | undefined {
	if (error instanceof TrustGateError) return error
	const rpc = rpcError(error)
	if (!rpc || !fromGateway(rpc)) return undefined
	const { status } = options
	const data = rpc.data
	const reason = typeof data?.reason === 'string' ? data.reason : ''
	const cause = error
	switch (rpc.code) {
		case CODE_POLICY_BLOCKED: {
			const plugin = typeof data?.plugin === 'string' && data.plugin ? data.plugin : undefined
			const detail =
				reason === 'mask_unsupported'
					? 'a policy asked to mask part of it and the gateway could not write the mask'
					: 'a policy blocked it'
			return new PolicyBlockedError(
				`the gateway refused the A2A call: ${detail}${plugin ? ` (${plugin})` : ''}`,
				{ code: reason || 'policy_blocked', plugin, cause }
			)
		}
		case CODE_RATE_LIMITED: {
			const retry = data?.retry_after
			const retryMs = typeof retry === 'number' && retry >= 0 ? Math.round(retry * 1000) : undefined
			return new RateLimitedError(
				`the gateway rate-limited the A2A call${retryMs !== undefined ? `; retry in ${retry}s` : ''}`,
				retryMs,
				{ cause }
			)
		}
		case CODE_GATEWAY_FAILURE: {
			const upstream = data?.upstream_status
			const said = reason
				? ` (${reason}${upstream ? `, agent answered HTTP ${upstream}` : ''})`
				: ''
			const Kind = TRANSIENT.has(reason) ? ServiceUnavailableError : TrustGateServerError
			return new Kind(`the gateway could not complete the A2A call${said}`, {
				status,
				code: reason || 'gateway_failure',
				cause,
			})
		}
		case CODE_IDENTITY_REQUIRED:
			return new AuthenticationError(
				'this agent acts as a signed-in person, and the call names none: call it as a ' +
					"signed-in user (TrustGate.login) rather than with the application's key alone",
				{ status, code: 'identity_required', cause }
			)
		default: {
			// CODE_ACCESS_REFUSED
			const text = `the gateway refused the A2A call before reading it: ${rpc.message} (${reason})`
			if (reason === 'invalid_end_user') return new InvalidRequestError(text, { status, code: reason, cause })
			if (reason === 'gateway_data_unavailable')
				return new ServiceUnavailableError(text, { status, code: reason, cause })
			return new AuthenticationError(text, { status, code: reason, cause })
		}
	}
}

/**
 * Awaits `call`, throwing the gateway's A2A errors as the SDK's error types.
 * Any other error, an agent's own included, is thrown as it was.
 */
export async function withGatewayErrors<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call()
	} catch (error) {
		throw gatewayError(error) ?? error
	}
}

/**
 * Yields what `stream` yields, throwing the gateway's A2A errors (the one that
 * opened the stream or one that ended it) as the SDK's error types.
 */
export async function* streamWithGatewayErrors<T>(stream: AsyncIterable<T>): AsyncGenerator<T, void, undefined> {
	try {
		yield* stream
	} catch (error) {
		throw gatewayError(error) ?? error
	}
}

/** The code, message and data of a JSON-RPC error, however it is held. */
function rpcError(error: unknown, depth = 0): RpcError | undefined {
	if (depth > 3 || error === null || typeof error !== 'object') return undefined
	const value = error as Record<string, unknown>
	// @a2a-js/sdk: JsonRpcTransportError and its typed kin keep envelopeCode
	// and data; a stream's error is a plain Error whose cause is one of them.
	if (typeof value.envelopeCode === 'number') {
		return {
			code: value.envelopeCode,
			message: typeof value.message === 'string' ? value.message : '',
			data: asRecord(value.data),
		}
	}
	if (value.error && typeof value.error === 'object') {
		const found = rpcError(value.error, depth + 1)
		if (found) return found
	}
	if (typeof value.code === 'number' && !(error instanceof Error)) {
		return {
			code: value.code,
			message: typeof value.message === 'string' ? value.message : '',
			data: asRecord(value.data),
		}
	}
	if (error instanceof Error && error.cause !== undefined) return rpcError(error.cause, depth + 1)
	return undefined
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Whether an error with this code is the gateway's rather than an agent's. */
function fromGateway({ code, message, data }: RpcError): boolean {
	if (!(code in MESSAGES) && code !== CODE_ACCESS_REFUSED) return false
	const reason = data?.reason
	if (!data || Object.keys(data).length === 0) {
		// No data left: the gateway's message is its mark.
		return MESSAGES[code] === message
	}
	switch (code) {
		case CODE_POLICY_BLOCKED:
			return typeof reason === 'string' && POLICY_REASONS.has(reason)
		case CODE_RATE_LIMITED:
			return 'retry_after' in data
		case CODE_IDENTITY_REQUIRED:
			return reason === 'identity_required'
		default:
			return typeof reason === 'string' && reason !== ''
	}
}

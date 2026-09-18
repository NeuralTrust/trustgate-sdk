import { API_KEY_HEADER, type ResolvedConfig } from './config.js'
import {
	AppActorUnavailableError,
	AuthenticationError,
	EndUserActorUnavailableError,
	InvalidRequestError,
	RateLimitedError,
	ServiceUnavailableError,
	TrustGateError,
	TrustGateServerError,
} from './errors.js'

export type ErrorBody = { error?: string; message?: string }

/**
 * A JSON request against the gateway's REST surface (the connections API).
 *
 * The gateway answers `{error, message}` on failure; this turns each `error`
 * code into the type that says whose problem it is. `expect` names statuses
 * the caller handles itself — the actor probe uses it to read a 409 as an
 * answer rather than a failure.
 */
export async function requestJSON<T>(
	config: ResolvedConfig,
	method: string,
	path: string,
	options: { body?: unknown; headers?: Record<string, string>; expect?: number[]; signal?: AbortSignal } = {}
): Promise<{ status: number; body: T }> {
	const url = `${config.baseUrl}${path}`
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
	const signal = options.signal ? anySignal([options.signal, controller.signal]) : controller.signal
	let response: Response
	try {
		response = await config.fetch(url, {
			method,
			headers: {
				[API_KEY_HEADER]: config.apiKey,
				Accept: 'application/json',
				...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
				...options.headers,
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal,
		})
	} catch (cause) {
		throw new TrustGateError(`${method} ${path} failed to reach the gateway`, { cause })
	} finally {
		clearTimeout(timeout)
	}

	const text = await response.text()
	const body = text ? safeParse(text) : undefined
	if (response.ok || options.expect?.includes(response.status)) {
		return { status: response.status, body: body as T }
	}
	throw errorForResponse(response, body as ErrorBody | undefined, text)
}

function errorForResponse(response: Response, body: ErrorBody | undefined, raw: string): TrustGateError {
	const code = body?.error
	const message = body?.message ?? raw ?? response.statusText
	const status = response.status
	switch (code) {
		case 'unauthenticated':
			return new AuthenticationError(message, { status, code })
		case 'invalid_request':
			return new InvalidRequestError(message, { status, code })
		case 'end_users_not_identified':
			return new EndUserActorUnavailableError(message, { status, code })
		case 'consumer_acts_for_users':
			return new AppActorUnavailableError(message, { status, code })
		case 'unavailable':
			return new ServiceUnavailableError(message, { status, code })
	}
	if (status === 401 || status === 403) return new AuthenticationError(message, { status, code })
	if (status === 429) {
		return new RateLimitedError(message, retryAfterMs(response))
	}
	if (status >= 500) return new TrustGateServerError(message, { status, code })
	return new TrustGateError(message, { status, code })
}

function retryAfterMs(response: Response): number | undefined {
	const header = response.headers.get('Retry-After')
	if (!header) return undefined
	const seconds = Number(header)
	return Number.isFinite(seconds) ? seconds * 1000 : undefined
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/** AbortSignal.any is not on every runtime the SDK supports yet. */
function anySignal(signals: AbortSignal[]): AbortSignal {
	const anyOf = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
	if (typeof anyOf === 'function') return anyOf(signals)
	const controller = new AbortController()
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason)
			break
		}
		signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
	}
	return controller.signal
}

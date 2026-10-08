import { API_KEY_HEADER, type ResolvedConfig } from './config.js'
import {
	AuthenticationError,
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
	const { response, text } = await send(
		config.fetch,
		url,
		{
			method,
			headers: {
				[API_KEY_HEADER]: config.apiKey,
				Accept: 'application/json',
				...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
				...options.headers,
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		},
		{ timeoutMs: config.timeoutMs, signal: options.signal, failure: `${method} ${path} failed to reach the gateway` }
	)
	const body = text ? safeParse(text) : undefined
	if (response.ok || options.expect?.includes(response.status)) {
		return { status: response.status, body: body as T }
	}
	throw errorForResponse(response, body as ErrorBody | undefined, text)
}

/** A response with its body already read, inside the same deadline. */
export type Sent = { response: Response; text: string }

/**
 * One request, its body read, within one deadline.
 *
 * The deadline covers the body as well as the headers: a server that answers
 * and then trickles would otherwise hold the call open long after `timeoutMs`.
 * A caller's own signal can end it sooner but never later.
 *
 * Redirects are refused rather than followed. The credential is a header, and
 * a fetch that follows a redirect carries it to whatever host the Location
 * names; an address that moved is a configuration to fix, not a hop to take.
 */
export async function send(
	fetchImpl: typeof globalThis.fetch,
	url: string,
	init: RequestInit,
	options: { timeoutMs: number; signal?: AbortSignal; failure: string }
): Promise<Sent> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
	const signal = options.signal ? anySignal([options.signal, controller.signal]) : controller.signal
	const failed = (cause: unknown) =>
		new TrustGateError(
			controller.signal.aborted ? `${options.failure} (no answer within ${options.timeoutMs} ms)` : options.failure,
			{ cause }
		)
	try {
		let response: Response
		try {
			response = await fetchImpl(url, { ...init, redirect: 'manual', signal })
		} catch (cause) {
			throw failed(cause)
		}
		if (isRedirect(response)) {
			// A browser hides the status and the Location of a manual redirect.
			const opaque = response.type === 'opaqueredirect'
			const location = opaque ? null : response.headers.get('Location')
			throw new TrustGateError(
				`${url} answered${opaque ? '' : ` ${response.status}`} with a redirect` +
					`${location ? ` to ${location}` : ''}. The SDK does not follow redirects, because ` +
					'the credential travels in a header: point it at the final address instead.',
				{ status: opaque ? undefined : response.status, code: 'redirect' }
			)
		}
		try {
			return { response, text: await response.text() }
		} catch (cause) {
			throw failed(cause)
		}
	} finally {
		clearTimeout(timeout)
	}
}

/**
 * A browser answers a manual redirect with an opaque response and Node shows
 * the 3xx; a fetch passed in config that follows it regardless says so in
 * `redirected`, though by then the request has already gone.
 */
function isRedirect(response: Response): boolean {
	return (
		response.type === 'opaqueredirect' ||
		response.redirected === true ||
		[301, 302, 303, 307, 308].includes(response.status)
	)
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

export function retryAfterMs(response: Response): number | undefined {
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

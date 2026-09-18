/**
 * Every failure the SDK raises, as a type you can catch.
 *
 * The gateway answers a tool call with a JSON-RPC error and the connections
 * API with `{error, message}`. Both are relayed here as classes rather than
 * status codes, because the useful question is never "what number came back"
 * but "is this mine to fix, my user's, or my admin's".
 */
export class TrustGateError extends Error {
	readonly status?: number
	readonly code?: string

	constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
		super(message, { cause: options.cause })
		this.name = new.target.name
		this.status = options.status
		this.code = options.code
	}
}

/** The API key is wrong, or it does not belong to this consumer. */
export class AuthenticationError extends TrustGateError {}

/** The request was malformed — a bad end-user id, an unknown provider. */
export class InvalidRequestError extends TrustGateError {}

/**
 * The consumer's toolkit does not carry every tool the agent declared.
 *
 * An admin owns that toolkit, so this is not something the caller can fix in
 * code: it is raised at startup, by name, so the agent never reaches a user
 * only to find the tool it was written around is not there.
 */
export class MissingToolsError extends TrustGateError {
	constructor(readonly missing: string[], readonly available: string[]) {
		super(
			`the consumer's toolkit is missing ${missing.map((t) => `"${t}"`).join(', ')}. ` +
				`It offers: ${available.length ? available.join(', ') : '(nothing)'}. ` +
				'Ask the admin who owns this application to add them.'
		)
	}
}

/**
 * The application itself has upstream accounts left to authorize.
 *
 * Raised only for an application that acts as itself, and only at startup:
 * nobody is present to follow a connect link once a batch is running, so the
 * run either knows beforehand or fails halfway through.
 */
export class UpstreamNotConnectedError extends TrustGateError {
	constructor(readonly providers: string[], readonly connectUrl: string) {
		super(
			`this application has not signed in to ${providers.join(', ')}. ` +
				`Open ${connectUrl} with its API key to connect them.`
		)
	}
}

/**
 * An end user has not connected the account this call needs.
 *
 * The link comes with the error because the gateway mints it there: it is the
 * page to put in front of that user, and it expires.
 */
export class ConsentRequiredError extends TrustGateError {
	constructor(
		readonly provider: string,
		readonly connectUrl: string,
		readonly cause_: string,
		message?: string
	) {
		super(message ?? `user consent required for ${provider}: open ${connectUrl}`, { code: 'consent_required' })
	}
}

/** A policy on the gateway refused the call. Not retryable. */
export class PolicyBlockedError extends TrustGateError {}

/** The tool is not on this consumer's surface — usually because it just left it. */
export class ToolNotFoundError extends TrustGateError {
	constructor(readonly tool: string, message?: string) {
		super(message ?? `the gateway does not serve a tool named "${tool}"`)
	}
}

/**
 * The application acts for its users, so it holds no accounts of its own.
 *
 * Reading them would be asking the wrong actor, and an empty answer would read
 * as "connected to nothing" rather than "ask about a user instead".
 */
export class AppActorUnavailableError extends TrustGateError {}

/** The application acts as itself, so it has no end users to ask about. */
export class EndUserActorUnavailableError extends TrustGateError {}

/** The connect-attempt limiter refused this call. */
export class RateLimitedError extends TrustGateError {
	constructor(message: string, readonly retryAfterMs?: number) {
		super(message, { status: 429, code: 'rate_limited' })
	}
}

/** The gateway could not serve the request and says so. Retryable. */
export class ServiceUnavailableError extends TrustGateError {}

/** The gateway failed on its own account. */
export class TrustGateServerError extends TrustGateError {}

/** The SDK was pointed at a plane this API key does not reach. */
export class PlaneUnavailableError extends TrustGateError {}

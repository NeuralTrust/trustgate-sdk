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
 * Servers the application cannot call yet, and who has to fix that.
 *
 * Raised at startup only, for the application handle: nobody is present to
 * follow a connect link once a batch is running, so the run either knows
 * beforehand or fails halfway through. The remedy is never the caller's — an
 * account a whole team rides on is an administrator's to connect, and a
 * per-caller account wants the person this call is for, which is what
 * `forEndUser` is.
 */
export class UpstreamNotConnectedError extends TrustGateError {
	constructor(readonly upstreams: BlockedUpstream[]) {
		super(describeBlocked(upstreams))
	}

	/** The server names, for a caller that wants to log or list them. */
	get servers(): string[] {
		return this.upstreams.map((upstream) => upstream.server)
	}
}

/** One server from {@link UpstreamNotConnectedError}. */
export type BlockedUpstream = {
	server: string
	blocked?: 'administrator' | 'end_user'
}

/**
 * Says who fixes each server, with the line of code when it is the caller.
 *
 * Read on a terminal at startup, so it is written to be acted on there: the
 * per-user case is the one a developer hits first, and the fix is one call
 * they have not seen yet, so the call is in the message.
 */
function describeBlocked(upstreams: BlockedUpstream[]): string {
	const byAdmin = upstreams.filter((upstream) => upstream.blocked === 'administrator')
	const byUser = upstreams.filter((upstream) => upstream.blocked === 'end_user')
	const parts: string[] = []
	if (byUser.length > 0) {
		parts.push(
			`${names(byUser)} ${verb(byUser, 'keeps', 'keep')} one account per user, and ` +
				'connect() runs as the application, which has none there.\n' +
				'\n' +
				'Run as the person the work is for:\n' +
				'\n' +
				"    const agent = await tg.forEndUser('user_123')\n" +
				'\n' +
				`or have an administrator set ${names(byUser)} to a shared account in the ` +
				"console (Registry, on the server's instance), and connect() works as it is."
		)
	}
	if (byAdmin.length > 0) {
		parts.push(
			`${names(byAdmin)} ${verb(byAdmin, 'uses', 'use')} one shared account for every ` +
				'caller, and nobody has connected it yet. An administrator connects it in the ' +
				"console: Registry, on the server's instance, Connect."
		)
	}
	return parts.length > 0 ? parts.join('\n\n') : `${names(upstreams)} ${verb(upstreams, 'is', 'are')} not connected.`
}

function names(upstreams: BlockedUpstream[]): string {
	return upstreams.map((upstream) => `"${upstream.server}"`).join(', ')
}

function verb(upstreams: BlockedUpstream[], one: string, many: string): string {
	return upstreams.length === 1 ? one : many
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

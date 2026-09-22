import type { ResolvedConfig } from './config.js'
import { PlaneUnavailableError, TrustGateError } from './errors.js'
import { requestJSON } from './http.js'

/** Whose account an MCP server reads: the one its instance holds, or one per caller. */
export type UpstreamAccount = 'shared' | 'user'

/**
 * Who has to act before a server answers a call that runs as the application.
 *
 * `administrator` is an instance whose shared account nobody has connected —
 * no caller can connect it, because it is the account every other caller rides
 * on. `end_user` is an instance that keeps an account per caller, which an
 * application is not: it names the person it acts for, and the account becomes
 * theirs to connect.
 */
export type UpstreamBlockedBy = 'administrator' | 'end_user'

/** One MCP server the application is bound to, and what it is waiting for. */
export type KeyUpstream = {
	server: string
	provider?: string
	account: UpstreamAccount
	connected: boolean
	needsReconnect: boolean
	blocked?: UpstreamBlockedBy
}

/** One consumer the key reaches, with the address it is served on. */
export type KeyConsumer = {
	slug: string
	name?: string
	/** The plane this consumer belongs to: MCP, LLM or A2A. */
	type: string
	active: boolean
	/** Where it answers. Empty when the gateway publishes no host for its plane. */
	url: string
	/**
	 * The servers behind it that read a stored account, answered for this key —
	 * which is the application itself.
	 *
	 * `undefined` is not "nothing to connect": it is also what a gateway that
	 * could not read the accounts answers, and a server carrying its own
	 * credential is never listed. Read `blocked`, never a length.
	 */
	upstreams?: KeyUpstream[]
}

/** The calling key itself. The secret is never echoed. */
export type KeyInfo = {
	name?: string
	/** When it retires itself. `undefined` means never. */
	expiresAt?: Date
}

/** Everything the key can say about itself. */
export type KeyIdentity = {
	gateway: string
	key: KeyInfo
	consumers: KeyConsumer[]
}

type Payload = {
	gateway?: string
	key?: { name?: string; expires_at?: string }
	consumers?: {
		slug: string
		name?: string
		type: string
		active: boolean
		url?: string
		upstreams?: {
			server?: string
			provider?: string
			account?: string
			connected?: boolean
			needs_reconnect?: boolean
			blocked?: string
		}[]
	}[]
}

/**
 * Asks the key what it reaches, when it dies, and what is not connected yet.
 *
 * It is what lets a client be configured with one secret: the slugs were
 * chosen by whoever created the consumers, and the LLM plane is on a host the
 * MCP URL says nothing about, so both have to come from the gateway. The other
 * two answers are the failures a client would otherwise meet at runtime — an
 * expired key as a 401 mid-run, an unconnected server as a refusal on the
 * first tool call — moved to where something can still be done about them.
 */
export async function whoAmI(config: ResolvedConfig, signal?: AbortSignal): Promise<KeyIdentity> {
	const { body } = await requestJSON<Payload>(config, 'GET', '/whoami', { signal })
	return {
		gateway: body?.gateway ?? '',
		key: {
			name: body?.key?.name || undefined,
			expiresAt: parseDate(body?.key?.expires_at),
		},
		consumers: (body?.consumers ?? []).map((consumer) => ({
			slug: consumer.slug,
			name: consumer.name || undefined,
			type: String(consumer.type ?? '').toUpperCase(),
			active: consumer.active !== false,
			url: consumer.url ?? '',
			upstreams: consumer.upstreams?.map((upstream) => ({
				server: upstream.server ?? '',
				provider: upstream.provider || undefined,
				account: upstream.account === 'shared' ? 'shared' : 'user',
				connected: upstream.connected === true,
				needsReconnect: upstream.needs_reconnect === true,
				blocked: blockedBy(upstream.blocked),
			})),
		})),
	}
}

function blockedBy(raw: string | undefined): UpstreamBlockedBy | undefined {
	return raw === 'administrator' || raw === 'end_user' ? raw : undefined
}

function parseDate(raw: string | undefined): Date | undefined {
	if (!raw) return undefined
	const at = new Date(raw)
	return Number.isNaN(at.getTime()) ? undefined : at
}

/**
 * Picks the one consumer of a plane, or explains why it cannot.
 *
 * A key attached to two consumers of the same type is a legitimate setup that
 * this SDK cannot resolve on its own, so it names them and asks — rather than
 * guessing and running an agent against the wrong surface.
 */
export function selectConsumer(
	identity: KeyIdentity,
	plane: 'MCP' | 'LLM',
	configured: string | undefined,
	envName: string
): KeyConsumer {
	const candidates = identity.consumers.filter((consumer) => consumer.type === plane)
	if (configured) {
		const named = candidates.find((consumer) => consumer.slug === configured)
		if (named) return named
		throw new PlaneUnavailableError(
			`this API key does not reach a ${plane} consumer called "${configured}"` +
				(candidates.length ? `; it reaches ${candidates.map((c) => c.slug).join(', ')}` : '')
		)
	}
	if (candidates.length === 0) {
		throw new PlaneUnavailableError(
			`this API key reaches no ${plane} consumer. ` +
				'Ask the admin who owns this application to attach one, or name it explicitly.'
		)
	}
	if (candidates.length > 1) {
		throw new TrustGateError(
			`this API key reaches several ${plane} consumers (${candidates
				.map((consumer) => consumer.slug)
				.join(', ')}); name the one this agent uses.`
		)
	}
	const only = candidates[0]
	if (!only.url) {
		throw new PlaneUnavailableError(
			`the gateway publishes no host for its ${plane} plane, so "${only.slug}" has no address. ` +
				`Set ${envName} and a base URL for it, or ask an operator to configure that plane's domain.`
		)
	}
	return only
}

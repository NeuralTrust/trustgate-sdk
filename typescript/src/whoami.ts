import type { ResolvedConfig } from './config.js'
import { PlaneUnavailableError, TrustGateError } from './errors.js'
import { requestJSON } from './http.js'

/** One consumer the key reaches, with the address it is served on. */
export type KeyConsumer = {
	slug: string
	name?: string
	/** The plane this consumer belongs to: MCP, LLM or A2A. */
	type: string
	active: boolean
	/** Where it answers. Empty when the gateway publishes no host for its plane. */
	url: string
	actsForUsers: boolean
	identitySource?: string
}

/** Everything the key can say about itself. */
export type KeyIdentity = {
	gateway: string
	consumers: KeyConsumer[]
}

type Payload = {
	gateway?: string
	consumers?: {
		slug: string
		name?: string
		type: string
		active: boolean
		url?: string
		acts_for_users?: boolean
		identity_source?: string
	}[]
}

/**
 * Asks the key which consumers it reaches.
 *
 * It is what lets a client be configured with one secret: the slugs were
 * chosen by whoever created the consumers, and the LLM plane is on a host the
 * MCP URL says nothing about, so both have to come from the gateway.
 */
export async function whoAmI(config: ResolvedConfig, signal?: AbortSignal): Promise<KeyIdentity> {
	const { body } = await requestJSON<Payload>(config, 'GET', '/whoami', { signal })
	return {
		gateway: body?.gateway ?? '',
		consumers: (body?.consumers ?? []).map((consumer) => ({
			slug: consumer.slug,
			name: consumer.name || undefined,
			type: String(consumer.type ?? '').toUpperCase(),
			active: consumer.active !== false,
			url: consumer.url ?? '',
			actsForUsers: consumer.acts_for_users === true,
			identitySource: consumer.identity_source || undefined,
		})),
	}
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

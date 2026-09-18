import type { ResolvedConfig } from './config.js'
import { END_USER_HEADER } from './config.js'
import { requestJSON } from './http.js'
import { InvalidRequestError } from './errors.js'
import type { ConnectLink, Connection } from './types.js'

type ConnectionPayload = {
	provider: string
	registry?: string
	code?: string
	status: Connection['status']
	account_ref?: string
	expires_at?: string
}

type ConnectionsPayload = {
	end_user?: string
	actor?: string
	connections?: ConnectionPayload[]
}

type LinkPayload = {
	connect_url: string
	ticket: string
	provider?: string
	expires_at: string
}

export function connectionsPath(slug: string, endUser?: string): string {
	const query = endUser ? `?end_user=${encodeURIComponent(endUser)}` : ''
	return `/${encodeURIComponent(slug)}/connections${query}`
}

export async function listConnections(
	config: ResolvedConfig,
	slug: string,
	endUser?: string,
	signal?: AbortSignal
): Promise<Connection[]> {
	const { body } = await requestJSON<ConnectionsPayload>(config, 'GET', connectionsPath(slug, endUser), {
		signal,
	})
	return (body?.connections ?? []).map(toConnection)
}

export async function createConnectLink(
	config: ResolvedConfig,
	slug: string,
	endUser: string,
	provider: string | undefined,
	signal?: AbortSignal
): Promise<ConnectLink> {
	const { body } = await requestJSON<LinkPayload>(
		config,
		'POST',
		`/${encodeURIComponent(slug)}/connections/links`,
		{ body: { end_user: endUser, ...(provider ? { provider } : {}) }, headers: { [END_USER_HEADER]: endUser }, signal }
	)
	return {
		connectUrl: body.connect_url,
		ticket: body.ticket,
		provider: body.provider || undefined,
		expiresAt: new Date(body.expires_at),
	}
}

function toConnection(payload: ConnectionPayload): Connection {
	return {
		provider: payload.provider,
		registry: payload.registry || undefined,
		code: payload.code || undefined,
		status: payload.status,
		accountRef: payload.account_ref || undefined,
		expiresAt: payload.expires_at ? new Date(payload.expires_at) : undefined,
	}
}

/**
 * The gateway is the authority on what an end-user id may be; this only
 * catches the mistake worth catching locally, which is the empty one — it
 * would otherwise be sent as a header the gateway reads as "no user named"
 * and answer for the wrong actor.
 */
export function requireEndUser(endUser: string): string {
	const trimmed = endUser?.trim() ?? ''
	if (!trimmed) {
		throw new InvalidRequestError('an end-user id is required to act for a user')
	}
	return trimmed
}

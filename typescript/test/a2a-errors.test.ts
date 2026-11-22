import { describe, expect, it } from 'vitest'

import {
	AuthenticationError,
	InvalidRequestError,
	PolicyBlockedError,
	RateLimitedError,
	ServiceUnavailableError,
	TrustGateServerError,
	a2a,
} from '../src/index.js'

const rpc = (code: number, message: string, data?: Record<string, unknown>) =>
	data === undefined ? { code, message } : { code, message, data }

/** What @a2a-js/sdk throws for a JSON-RPC error whose code it does not know. */
class JsonRpcTransportError extends Error {
	readonly envelopeCode: number
	readonly data?: unknown
	constructor(envelope: { error: { code: number; message: string; data?: unknown } }) {
		super(envelope.error.message)
		this.envelopeCode = envelope.error.code
		this.data = envelope.error.data
	}
}

describe('the gateway A2A errors', () => {
	it('names the blocking plugin and reason', () => {
		for (const reason of ['policy_blocked', 'mask_unsupported']) {
			const err = a2a.gatewayError(rpc(-32090, 'Blocked by gateway policy', { reason, plugin: 'trustguard' }))
			expect(err).toBeInstanceOf(PolicyBlockedError)
			expect(err?.code).toBe(reason)
			expect((err as PolicyBlockedError).plugin).toBe('trustguard')
			expect(err?.message).toContain('trustguard')
		}
	})

	it('carries the wait of a rate limit', () => {
		const err = a2a.gatewayError(rpc(-32091, 'Rate limit exceeded', { retry_after: 30 }))
		expect(err).toBeInstanceOf(RateLimitedError)
		expect((err as RateLimitedError).retryAfterMs).toBe(30_000)
	})

	it('tells a transient gateway failure from one that needs a fix', () => {
		const slow = a2a.gatewayError(rpc(-32092, 'Gateway could not complete the call', { reason: 'upstream_timeout' }))
		expect(slow).toBeInstanceOf(ServiceUnavailableError)
		const broken = a2a.gatewayError(
			rpc(-32092, 'Gateway could not complete the call', {
				reason: 'invalid_upstream_response',
				upstream_status: 404,
			})
		)
		expect(broken).toBeInstanceOf(TrustGateServerError)
		expect(broken?.code).toBe('invalid_upstream_response')
		expect(broken?.message).toContain('HTTP 404')
	})

	it('reads identity required and access refused', () => {
		const who = a2a.gatewayError(rpc(-32093, 'An authenticated user is required', { reason: 'identity_required' }))
		expect(who).toBeInstanceOf(AuthenticationError)
		expect(who?.code).toBe('identity_required')
		const refused = a2a.gatewayError(rpc(-32094, 'Unauthenticated', { reason: 'unauthenticated' }), { status: 401 })
		expect(refused).toBeInstanceOf(AuthenticationError)
		expect([refused?.status, refused?.code]).toEqual([401, 'unauthenticated'])
		expect(a2a.gatewayError(rpc(-32094, 'bad end user', { reason: 'invalid_end_user' }))).toBeInstanceOf(
			InvalidRequestError
		)
		expect(
			a2a.gatewayError(rpc(-32094, 'Failed to load gateway data', { reason: 'gateway_data_unavailable' }))
		).toBeInstanceOf(ServiceUnavailableError)
	})

	it("leaves an agent's own error in the same range alone", () => {
		for (const error of [
			rpc(-32090, "Quota of the agent's own", { reason: 'something_else' }),
			rpc(-32091, 'Rate limit exceeded', { limit: 5 }),
			rpc(-32092, 'agent failed'),
			rpc(-32001, 'Task not found'),
			rpc(-32602, 'Invalid params', { reason: 'agent_rejected' }),
		]) {
			expect(a2a.gatewayError(error), JSON.stringify(error)).toBeUndefined()
		}
	})

	it('reads @a2a-js/sdk errors, a stream error through its cause', () => {
		const transport = new JsonRpcTransportError({
			error: rpc(-32090, 'Blocked by gateway policy', { reason: 'policy_blocked', plugin: 'rate_limiter' }),
		})
		const err = a2a.gatewayError(transport)
		expect(err).toBeInstanceOf(PolicyBlockedError)
		expect((err as PolicyBlockedError).plugin).toBe('rate_limiter')
		expect(err?.cause).toBe(transport)
		const streamed = new Error('SSE event contained an error: Rate limit exceeded (Code: -32091)', {
			cause: new JsonRpcTransportError({ error: rpc(-32091, 'Rate limit exceeded', { retry_after: 2 }) }),
		})
		expect(a2a.gatewayError(streamed)).toBeInstanceOf(RateLimitedError)
		expect(a2a.gatewayError({ jsonrpc: '2.0', id: 1, error: rpc(-32091, 'Rate limit exceeded', { retry_after: 1 }) })).toBeInstanceOf(
			RateLimitedError
		)
		expect(a2a.gatewayError(new Error('boom'))).toBeUndefined()
	})

	it('throws the SDK type from a call and from a stream, and anything else as it was', async () => {
		const blocked = new JsonRpcTransportError({
			error: rpc(-32090, 'Blocked by gateway policy', { reason: 'policy_blocked', plugin: 'trustguard' }),
		})
		await expect(
			a2a.withGatewayErrors(async () => {
				throw blocked
			})
		).rejects.toBeInstanceOf(PolicyBlockedError)
		const other = new Error('not the gateway')
		await expect(
			a2a.withGatewayErrors(async () => {
				throw other
			})
		).rejects.toBe(other)

		async function* events() {
			yield 1
			throw new Error('stream error', { cause: blocked })
		}
		const seen: number[] = []
		await expect(
			(async () => {
				for await (const event of a2a.streamWithGatewayErrors(events())) seen.push(event)
			})()
		).rejects.toBeInstanceOf(PolicyBlockedError)
		expect(seen).toEqual([1])
	})
})

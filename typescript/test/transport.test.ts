import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { TrustGate } from '../src/client.js'
import { resolveConfig } from '../src/config.js'
import { TrustGateError } from '../src/errors.js'
import { requestJSON } from '../src/http.js'
import { MCPTransport } from '../src/mcp.js'
import { fakeGateway } from './fake-gateway.js'

const servers: Server[] = []

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections()
		await new Promise((done) => server.close(done))
	}
})

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
	const server = createServer(handler)
	servers.push(server)
	await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('plain http', () => {
	it('refuses a gateway on another host', () => {
		expect(() => resolveConfig({ baseUrl: 'http://gw.internal', apiKey: 'ag_k' })).toThrow(/plain http/)
	})

	// Some resolvers send *.localhost to the network's DNS.
	it('does not take a name under localhost for this machine', () => {
		expect(() => resolveConfig({ baseUrl: 'http://gw.localhost', apiKey: 'ag_k' })).toThrow(/plain http/)
	})

	it('allows this machine', () => {
		for (const baseUrl of ['http://localhost:8082', 'http://127.0.0.1:8082', 'http://[::1]:8082']) {
			expect(resolveConfig({ baseUrl, apiKey: 'ag_k' }).baseUrl).toBe(baseUrl)
		}
	})

	it('allows another host when the caller opts in', () => {
		const config = resolveConfig({ baseUrl: 'http://gw.internal', apiKey: 'ag_k', allowInsecureHttp: true })

		expect(config.allowInsecureHttp).toBe(true)
	})

	it('reads the opt-in from the environment', () => {
		process.env.TRUSTGATE_ALLOW_INSECURE_HTTP = '1'
		try {
			expect(resolveConfig({ baseUrl: 'http://gw.internal', apiKey: 'ag_k' }).allowInsecureHttp).toBe(true)
		} finally {
			delete process.env.TRUSTGATE_ALLOW_INSECURE_HTTP
		}
	})

	// The key already went to the base URL to ask, so the answer's host is not
	// in question; its scheme is, because it decides how the key travels next.
	it('refuses an https gateway that answers with an http plane', async () => {
		const gateway = fakeGateway({
			whoami: {
				gateway: 'acme',
				consumers: [{ slug: 'acme', type: 'MCP', active: true, url: 'http://gw.test/acme/mcp' }],
			},
		})
		const tg = new TrustGate({ baseUrl: 'https://gw.test', apiKey: 'ag_k', fetch: gateway.fetch })

		await expect(tg.connect()).rejects.toThrow(/plain http/)
		expect(gateway.requests.map((request) => request.url)).toEqual(['https://gw.test/whoami'])
	})
})

describe('redirects', () => {
	it('are not followed, so the key never reaches the other host', async () => {
		const seen: (string | undefined)[] = []
		const other = await serve((req, res) => {
			seen.push(req.headers['x-ag-api-key'] as string | undefined)
			res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
		})
		const gateway = await serve((_req, res) => {
			res.writeHead(307, { Location: `${other.replace('127.0.0.1', 'localhost')}/whoami` }).end()
		})
		const config = resolveConfig({ baseUrl: gateway, apiKey: 'ag_k' })

		const error = await requestJSON(config, 'GET', '/whoami').catch((e: unknown) => e)

		expect(error).toBeInstanceOf(TrustGateError)
		expect((error as TrustGateError).message).toMatch(/does not follow redirects/)
		expect(seen).toEqual([])
	})

	it('are refused when a fetch passed in config followed one anyway', async () => {
		const followed = new Response('{}', { status: 200 })
		Object.defineProperty(followed, 'redirected', { value: true })
		const config = resolveConfig({ baseUrl: 'https://gw.test', apiKey: 'ag_k', fetch: async () => followed })

		await expect(requestJSON(config, 'GET', '/whoami')).rejects.toThrow(/does not follow redirects/)
	})
})

describe('timeouts', () => {
	// Headers first, then nothing: a deadline that stopped at the headers would
	// leave the body read hanging.
	const stalls = () =>
		serve((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.write('{"jsonrpc":"2.0",')
		})

	it('cover the body, not just the headers', async () => {
		const url = await stalls()
		const config = resolveConfig({ baseUrl: url, apiKey: 'ag_k', timeoutMs: 150 })
		const started = Date.now()

		await expect(requestJSON(config, 'GET', '/whoami')).rejects.toThrow(/no answer within 150 ms/)
		expect(Date.now() - started).toBeLessThan(2_000)
	})

	it('still apply when the caller passes a signal of its own', async () => {
		const url = await stalls()
		const config = resolveConfig({ baseUrl: url, apiKey: 'ag_k', timeoutMs: 150 })
		const transport = new MCPTransport(config, `${url}/acme/mcp`)
		const started = Date.now()

		await expect(transport.listTools(new AbortController().signal)).rejects.toThrow(/no answer within 150 ms/)
		expect(Date.now() - started).toBeLessThan(2_000)
	})
})

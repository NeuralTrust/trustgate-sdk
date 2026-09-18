import type { GatewayTool } from '../src/types.js'

export type FakeOptions = {
	/** Which actor /whoami reports for the MCP consumer. */
	actor?: 'application' | 'end_user'
	/** Overrides what /whoami answers, for the cases about resolving a key. */
	whoami?: unknown
	/** Answers /whoami with this status instead of 200. */
	whoamiStatus?: number
	connections?: { provider: string; status: string; account_ref?: string }[]
	tools?: GatewayTool[]
	/** Replies for tools/call, keyed by tool name. */
	callResults?: Record<string, unknown>
	/** JSON-RPC errors for tools/call, keyed by tool name. */
	callErrors?: Record<string, { code: number; message: string; data?: unknown }>
	/** Frames the tools/call response as an event stream, as the gateway does
	 *  when it has a surface change to announce on the same response. */
	frameAsEventStream?: boolean
}

export type Recorded = { url: string; method: string; headers: Record<string, string>; body?: unknown }

export function fakeGateway(options: FakeOptions = {}) {
	const requests: Recorded[] = []
	const tools = options.tools ?? [
		{ name: 'notion_search', description: 'search', inputSchema: { type: 'object', properties: {} } },
	]

	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input)
		const headers = Object.fromEntries(
			Object.entries((init?.headers ?? {}) as Record<string, string>)
		)
		const body = init?.body ? JSON.parse(String(init.body)) : undefined
		requests.push({ url, method: init?.method ?? 'GET', headers, body })

		if (url.endsWith('/whoami')) {
			if (options.whoamiStatus) {
				return json(options.whoamiStatus, { error: 'not_found', message: 'no route' })
			}
			return json(
				200,
				options.whoami ?? {
					gateway: 'acme',
					consumers: [
						{
							slug: 'acme',
							name: 'Acme Agent',
							type: 'MCP',
							active: true,
							url: 'https://gw.test/acme/mcp',
							acts_for_users: options.actor === 'end_user',
							...(options.actor === 'end_user' ? { identity_source: 'app' } : {}),
						},
					],
				}
			)
		}
		if (url.includes('/connections/links')) {
			return json(201, {
				connect_url: 'https://gw.test/acme/mcp/connect?ticket=t-1',
				ticket: 't-1',
				provider: body?.provider,
				expires_at: '2026-01-01T00:15:00Z',
			})
		}
		if (url.includes('/connections')) {
			const named = new URL(url).searchParams.get('end_user')
			return json(200, {
				end_user: named ?? '',
				actor: named ? 'end_user' : 'application',
				connections: options.connections ?? [{ provider: 'com.notion/mcp', status: 'connected' }],
			})
		}
		if (url.endsWith('/mcp')) {
			const rpc = body as { id: number; method: string; params: Record<string, unknown> }
			if (rpc.method === 'tools/list') {
				return rpcOK(rpc.id, { tools }, false)
			}
			if (rpc.method === 'tools/call') {
				const name = String(rpc.params.name)
				const failure = options.callErrors?.[name]
				if (failure) {
					return rpcError(rpc.id, failure, options.frameAsEventStream ?? false)
				}
				const result = options.callResults?.[name] ?? {
					content: [{ type: 'text', text: `called ${name}` }],
					resultType: 'complete',
				}
				return rpcOK(rpc.id, result as Record<string, unknown>, options.frameAsEventStream ?? false)
			}
		}
		return json(404, { error: 'not_found', message: url })
	}) as typeof globalThis.fetch

	return { fetch: fetchImpl, requests }
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function rpcOK(id: number, result: Record<string, unknown>, framed: boolean): Response {
	return envelope({ jsonrpc: '2.0', id, result }, framed)
}

function rpcError(
	id: number,
	error: { code: number; message: string; data?: unknown },
	framed: boolean
): Response {
	return envelope({ jsonrpc: '2.0', id, error }, framed)
}

function envelope(payload: unknown, framed: boolean): Response {
	if (!framed) return json(200, payload)
	const frames =
		'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n' +
		`event: message\ndata: ${JSON.stringify(payload)}\n\n`
	return new Response(frames, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/**
 * A gateway that lists only its own tools, and Code Mode programs.
 *
 * A gateway can be set to list only its search, call and program tools, so a
 * model is not handed every server's schemas up front. The caller's tools still
 * answer by name: what an agent requires, and the short names it calls, have to
 * mean the same on such a gateway as on one that lists everything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TrustGate } from '../src/client.js'
import { MissingToolsError, TrustGateError } from '../src/errors.js'
import { END_USER_HEADER } from '../src/config.js'
import { PROGRAM_TIMEOUT_MS } from '../src/mcp.js'
import type { GatewayTool } from '../src/types.js'
import { fakeGateway, type FakeOptions } from './fake-gateway.js'

const base = { baseUrl: 'https://gw.test', apiKey: 'ag_secret' }

const gatewayTools: GatewayTool[] = ['trustgate_search', 'trustgate_call', 'trustgate_execute'].map((name) => ({
	name,
	inputSchema: { type: 'object', properties: {} },
}))

function gatewayListing(searchable: NonNullable<FakeOptions['searchable']>, options: FakeOptions = {}) {
	return fakeGateway({ tools: gatewayTools, searchable, ...options })
}

function calledNames(gateway: ReturnType<typeof fakeGateway>): string[] {
	return gateway.requests
		.map((r) => r.body as { method?: string; params?: { name?: string } })
		.filter((b) => b?.method === 'tools/call')
		.map((b) => String(b.params?.name))
}

afterEach(() => {
	vi.useRealTimers()
})

describe('a gateway that lists only its own tools', () => {
	it('finds a required tool the gateway does not list', async () => {
		const gateway = gatewayListing([
			{ name: 'linear_list_issues', server: 'Linear', callable: true },
			{ name: 'notion_search', server: 'Notion', callable: true },
		])

		const agent = await new TrustGate({ ...base, fetch: gateway.fetch }).connect({
			requires: ['list_issues', 'notion_search'],
		})

		// The model is still handed what the gateway lists, and nothing more.
		expect(agent.tools.map((t) => t.name)).toEqual(gatewayTools.map((t) => t.name))
		expect(gateway.searches()).toEqual([{ kind: 'tool', brief: true, limit: 50 }])
	})

	// A tool on a server still waiting on an account is not callable, and the
	// listing would leave it out: requiring it fails the start the same way.
	it('still refuses a required tool that cannot be called yet', async () => {
		const gateway = gatewayListing([
			{ name: 'linear_list_issues', server: 'Linear', callable: true },
			{ name: 'github_list_prs', server: 'GitHub', callable: false },
		])

		const failure = await new TrustGate({ ...base, fetch: gateway.fetch })
			.connect({ requires: ['linear_list_issues', 'github_list_prs'] })
			.catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(MissingToolsError)
		const missing = failure as MissingToolsError
		expect(missing.missing).toEqual(['github_list_prs'])
		// What it offers is the whole surface, not the gateway's three tools.
		expect(missing.available).toContain('linear_list_issues')
		expect(missing.available).not.toContain('github_list_prs')
	})

	it('reads every page of the search', async () => {
		const searchable = Array.from({ length: 120 }, (_, i) => ({
			name: `svc_tool_${String(i).padStart(3, '0')}`,
			callable: true,
		}))
		const gateway = gatewayListing(searchable)

		await new TrustGate({ ...base, fetch: gateway.fetch }).connect({ requires: ['svc_tool_119'] })

		expect(gateway.searches().map((s) => s.cursor)).toEqual([undefined, '50', '100'])
	})

	it('does not search when the listing has what is required', async () => {
		const gateway = fakeGateway({
			tools: [{ name: 'notion_search', inputSchema: { type: 'object' } }, ...gatewayTools],
			searchable: [{ name: 'notion_search', callable: true }],
		})

		await new TrustGate({ ...base, fetch: gateway.fetch }).connect({ requires: ['notion_search'] })

		expect(gateway.searches()).toEqual([])
	})

	// An older gateway, or one whose search cannot list tools, leaves the check
	// as it was: the listing is all there is.
	it('changes nothing when the search cannot list tools', async () => {
		const gateway = fakeGateway({
			tools: gatewayTools,
			callResults: {
				trustgate_search: { isError: true, content: [{ type: 'text', text: 'cannot search tool' }] },
			},
		})

		await expect(
			new TrustGate({ ...base, fetch: gateway.fetch }).connect({ requires: ['linear_list_issues'] })
		).rejects.toThrow(MissingToolsError)
	})

	it('calls a tool the gateway does not list by its short name', async () => {
		const gateway = gatewayListing([{ name: 'linear_list_issues', callable: true }])
		const agent = await new TrustGate({ ...base, fetch: gateway.fetch }).connect()

		await agent.callTool('list_issues', { team: 'ENG' })
		await agent.callTool('list_issues', { team: 'OPS' })

		expect(calledNames(gateway)).toEqual(['trustgate_search', 'linear_list_issues', 'linear_list_issues'])

		// A re-read surface is read through the search again when a name needs it.
		await agent.refresh()
		await agent.callTool('list_issues')
		expect(gateway.searches()).toHaveLength(2)
	})

	it('asks which one when two unlisted tools share a short name', async () => {
		const gateway = gatewayListing([
			{ name: 'linear_list_issues', callable: true },
			{ name: 'github_list_issues', callable: true },
		])
		const agent = await new TrustGate({ ...base, fetch: gateway.fetch }).connect()

		await expect(agent.callTool('list_issues')).rejects.toThrow(TrustGateError)
		await expect(agent.callTool('list_issues')).rejects.toThrow(/more than one/)
	})

	it("searches a named person's requirements as that person", async () => {
		const gateway = gatewayListing([{ name: 'linear_list_issues', callable: true }])

		await new TrustGate({ ...base, fetch: gateway.fetch }).forEndUser('user_123', {
			requires: ['linear_list_issues'],
		})

		const searched = gateway.requests.filter(
			(r) => (r.body as { params?: { name?: string } })?.params?.name === 'trustgate_search'
		)
		expect(searched.length).toBeGreaterThan(0)
		expect(searched[0].headers[END_USER_HEADER]).toBe('user_123')
	})
})

// The gateway stops a program at its own limit and answers with the calls it
// made; a client that gives up at the same moment gets none of that.
describe('Code Mode programs', () => {
	async function hangingAgent(timeoutMs?: number) {
		const gateway = gatewayListing([], { hang: ['trustgate_execute', 'trustgate_call', 'linear_list_issues'] })
		const agent = await new TrustGate({ ...base, fetch: gateway.fetch, timeoutMs }).connect()
		vi.useFakeTimers()
		return agent
	}

	async function waitedFor(call: Promise<unknown>): Promise<number> {
		let settled = false
		const outcome = call.catch((error: unknown) => error).finally(() => (settled = true))
		let waited = 0
		while (!settled && waited < 300_000) {
			await vi.advanceTimersByTimeAsync(1_000)
			waited += 1_000
		}
		expect(await outcome).toBeInstanceOf(TrustGateError)
		return waited
	}

	it('waits longer for a program than for one tool', async () => {
		const agent = await hangingAgent()

		expect(await waitedFor(agent.callTool('trustgate_execute', { code: 'return 1' }))).toBe(PROGRAM_TIMEOUT_MS)
		expect(
			await waitedFor(agent.callTool('trustgate_call', { tool: 'trustgate_execute', arguments: { code: '1' } }))
		).toBe(PROGRAM_TIMEOUT_MS)
		expect(await waitedFor(agent.callTool('linear_list_issues'))).toBe(30_000)
	})

	it('keeps a longer configured timeout for programs', async () => {
		const agent = await hangingAgent(120_000)

		expect(await waitedFor(agent.callTool('trustgate_execute', { code: 'return 1' }))).toBe(120_000)
	})
})

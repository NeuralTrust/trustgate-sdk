import { inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import { TrustGate } from '../src/client.js'
import { END_USER_HEADER } from '../src/config.js'
import { PlaneUnavailableError, TrustGateError } from '../src/errors.js'
import { fakeGateway } from './fake-gateway.js'

const base = { baseUrl: 'https://gw.test', apiKey: 'ag_secret' }
const plane = 'https://gw-x.agents.test/research-bot/agents'

function agentsWhoami(agents: { id: string; name: string }[], url = plane) {
	return {
		gateway: 'acme',
		consumers: [
			{ slug: 'acme', type: 'MCP', active: true, url: 'https://gw.test/acme/mcp' },
			{
				slug: 'research-bot',
				type: 'A2A',
				active: true,
				url,
				agents: agents.map((agent) => ({
					...agent,
					card_url: `${url}/${agent.id}/.well-known/agent-card.json`,
					protocol_version: '1.0',
				})),
			},
		],
	}
}

const travel = { id: '0192-a', name: 'Travel planner' }
const research = { id: '0192-b', name: 'Researcher' }

function client(whoami: unknown) {
	return new TrustGate({ ...base, fetch: fakeGateway({ whoami }).fetch })
}

describe('agents', () => {
	it('lists the agents behind the key, with the endpoint and headers a client needs', async () => {
		const agents = await client(agentsWhoami([travel, research])).agents()

		expect(agents).toHaveLength(2)
		expect(agents[0]).toMatchObject({
			id: '0192-a',
			name: 'Travel planner',
			cardUrl: `${plane}/0192-a/.well-known/agent-card.json`,
			protocolVersion: '1.0',
			url: `${plane}/0192-a`,
			consumer: 'research-bot',
		})
		expect(agents[0].headers).toEqual({ 'X-AG-API-Key': 'ag_secret' })
	})

	it('names the end user in the headers when asked to', async () => {
		const agents = await client(agentsWhoami([travel])).agents({ endUser: 'user_123' })

		expect(agents[0].headers[END_USER_HEADER]).toBe('user_123')
		await expect(client(agentsWhoami([travel])).agents({ endUser: '  ' })).rejects.toThrow(/end-user id is required/)
	})

	it('is an empty list for an A2A consumer with no agents', async () => {
		expect(await client(agentsWhoami([])).agents()).toEqual([])
	})

	it('says so when the key reaches no A2A consumer', async () => {
		await expect(client({ gateway: 'acme', consumers: [] }).agents()).rejects.toThrow(PlaneUnavailableError)
	})

	it('says so when the gateway publishes no host for the plane', async () => {
		const whoami = { gateway: 'acme', consumers: [{ slug: 'research-bot', type: 'A2A', active: true, agents: [] }] }

		await expect(client(whoami).agents()).rejects.toThrow(/publishes no host for its A2A plane/)
	})

	it('refuses an agent served over plain http', async () => {
		await expect(client(agentsWhoami([travel], 'http://agents.test/research-bot/agents')).agents()).rejects.toThrow(
			/plain http/
		)
	})

	it('keeps the key out of a printed agent', async () => {
		const [agent] = await client(agentsWhoami([travel])).agents()

		expect(JSON.stringify(agent)).not.toContain('ag_secret')
		expect(inspect(agent)).not.toContain('ag_secret')
	})
})

describe('agent', () => {
	it('finds one by id or by name', async () => {
		const tg = client(agentsWhoami([travel, research]))

		expect((await tg.agent('0192-b')).name).toBe('Researcher')
		expect((await tg.agent('Travel planner')).id).toBe('0192-a')
	})

	it('names what it reaches when nothing matches', async () => {
		const error = await client(agentsWhoami([travel]))
			.agent('Nobody')
			.catch((e: unknown) => e)

		expect(error).toBeInstanceOf(TrustGateError)
		expect((error as TrustGateError).code).toBe('agent_not_found')
		expect(String(error)).toContain('Travel planner (0192-a)')
	})

	it('asks which one when two agents share a name', async () => {
		const error = await client(agentsWhoami([travel, { id: '0192-c', name: 'Travel planner' }]))
			.agent('Travel planner')
			.catch((e: unknown) => e)

		expect((error as TrustGateError).code).toBe('ambiguous_agent')
		expect(String(error)).toContain('0192-a, 0192-c')
	})
})

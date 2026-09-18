import { describe, expect, it } from 'vitest'

import { TrustGate } from '../src/client.js'
import type { Agent } from '../src/agent.js'
import { ConsentRequiredError, PolicyBlockedError, ToolNotFoundError } from '../src/errors.js'
import { ToolFormat, type GatewayTool } from '../src/types.js'
import { fakeGateway } from './fake-gateway.js'

const base = { baseUrl: 'https://gw.test', apiKey: 'ag_secret', mcpConsumer: 'acme' }

const searchTool: GatewayTool = {
	name: 'notion_search',
	description: 'Search Notion',
	inputSchema: {
		type: 'object',
		properties: { query: { type: 'string' }, limit: { type: 'integer' } },
		required: ['query'],
	},
}

async function agentWith(options: Parameters<typeof fakeGateway>[0] = {}) {
	const gateway = fakeGateway({ tools: [searchTool], ...options })
	const tg = new TrustGate({ ...base, fetch: gateway.fetch })
	const agent = (await tg.connect()) as Agent
	return { agent, gateway }
}

describe('toolkit', () => {
	it('shapes a tool for the Responses API', async () => {
		const { agent } = await agentWith()

		const toolkit = agent.toolkit(ToolFormat.OpenAIResponses)

		expect(toolkit.tools).toEqual([
			{
				type: 'function',
				name: 'notion_search',
				description: 'Search Notion',
				parameters: searchTool.inputSchema,
				strict: false,
			},
		])
	})

	it('nests it under `function` for Chat Completions', async () => {
		const { agent } = await agentWith()

		const [tool] = agent.toolkit(ToolFormat.OpenAIChat).tools as [
			{ type: string; function: { name: string } },
		]

		expect(tool.type).toBe('function')
		expect(tool.function.name).toBe('notion_search')
	})

	it('uses input_schema for Anthropic, which wants plain JSON Schema', async () => {
		const { agent } = await agentWith()

		const [tool] = agent.toolkit(ToolFormat.AnthropicMessages).tools as [
			{ name: string; input_schema: unknown },
		]

		expect(tool.name).toBe('notion_search')
		expect(tool.input_schema).toEqual(searchTool.inputSchema)
	})

	it('collects Gemini declarations into one entry and says what it dropped', async () => {
		const { agent } = await agentWith({
			tools: [
				{
					name: 'notion_search',
					description: 'Search Notion',
					inputSchema: {
						type: 'object',
						additionalProperties: false,
						properties: { query: { type: 'string', pattern: '^.+$' } },
					},
				},
			],
		})

		const toolkit = agent.toolkit(ToolFormat.Gemini)
		const [entry] = toolkit.tools as [{ functionDeclarations: { name: string; parameters: unknown }[] }]

		expect(entry.functionDeclarations).toHaveLength(1)
		expect(entry.functionDeclarations[0].parameters).toEqual({
			type: 'object',
			properties: { query: { type: 'string' } },
		})
		expect(toolkit.warnings[0].reason).toMatch(/additionalProperties|pattern/)
	})

	it('warns instead of failing when a tool cannot be strict', async () => {
		const { agent } = await agentWith({
			tools: [
				{ name: 'open_ended', inputSchema: { type: 'object', additionalProperties: true } },
				searchTool,
			],
		})

		const toolkit = agent.toolkit(ToolFormat.OpenAIResponses, { strict: true })
		const tools = toolkit.tools as { name: string; strict: boolean }[]

		expect(toolkit.warnings).toEqual([
			{ tool: 'open_ended', reason: 'it accepts properties that are not in its schema' },
		])
		expect(tools.find((t) => t.name === 'open_ended')?.strict).toBe(false)
		expect(tools.find((t) => t.name === 'notion_search')?.strict).toBe(true)
	})
})

describe('execute', () => {
	it('runs the calls the model asked for and answers in its shape', async () => {
		const { agent, gateway } = await agentWith({
			callResults: { notion_search: { content: [{ type: 'text', text: 'found it' }] } },
		})
		const toolkit = agent.toolkit(ToolFormat.OpenAIResponses)

		const outputs = await toolkit.execute({
			output: [
				{ type: 'function_call', call_id: 'call_1', name: 'notion_search', arguments: '{"query":"runbook"}' },
				{ type: 'message', content: [] },
			],
		})

		expect(outputs).toEqual([
			{ type: 'function_call_output', call_id: 'call_1', output: 'found it' },
		])
		const call = gateway.requests.at(-1)?.body as { params: { name: string; arguments: unknown } }
		expect(call.params).toEqual({ name: 'notion_search', arguments: { query: 'runbook' } })
	})

	// The nulls strict asked for must not reach a server that never agreed to
	// them, so the conversion is undone on the way back.
	it('undoes the strict rewrite before calling the gateway', async () => {
		const { agent, gateway } = await agentWith()
		const toolkit = agent.toolkit(ToolFormat.OpenAIResponses, { strict: true })

		await toolkit.execute([
			{
				type: 'function_call',
				call_id: 'call_1',
				name: 'notion_search',
				arguments: '{"query":"runbook","limit":null}',
			},
		])

		const call = gateway.requests.at(-1)?.body as { params: { arguments: unknown } }
		expect(call.params.arguments).toEqual({ query: 'runbook' })
	})

	it('prefers the structured result, which is what the tool promised', async () => {
		const { agent } = await agentWith({
			callResults: {
				notion_search: {
					content: [{ type: 'text', text: 'ignored' }],
					structuredContent: { pages: 2 },
				},
			},
		})

		const outputs = (await agent
			.toolkit(ToolFormat.OpenAIChat)
			.execute([{ id: 'call_1', function: { name: 'notion_search', arguments: '{}' } }])) as {
			content: string
		}[]

		expect(outputs[0].content).toBe('{"pages":2}')
	})

	it('answers Anthropic with one user message of tool results', async () => {
		const { agent } = await agentWith()

		const outputs = (await agent.toolkit(ToolFormat.AnthropicMessages).execute({
			content: [{ type: 'tool_use', id: 'toolu_1', name: 'notion_search', input: { query: 'x' } }],
		})) as { role: string; content: { type: string; tool_use_id: string }[] }[]

		expect(outputs).toHaveLength(1)
		expect(outputs[0].role).toBe('user')
		expect(outputs[0].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
	})

	it('pairs a Gemini call with its answer even though it carries no id', async () => {
		const { agent } = await agentWith()

		const outputs = (await agent.toolkit(ToolFormat.Gemini).execute({
			candidates: [{ content: { parts: [{ functionCall: { name: 'notion_search', args: {} } }] } }],
		})) as { role: string; parts: { functionResponse: { name: string } }[] }[]

		expect(outputs[0].parts[0].functionResponse.name).toBe('notion_search')
	})
})

describe('errors from a tool call', () => {
	it('hands back the link when the user has not connected an account', async () => {
		const { agent } = await agentWith({
			callErrors: {
				notion_search: {
					code: -32003,
					message: 'user consent required',
					data: {
						provider: 'com.notion/mcp',
						connect_url: 'https://gw.test/acme/mcp/connect?ticket=t-9',
						cause: 'no_credential',
					},
				},
			},
		})

		const error = await agent.callTool('notion_search', {}).catch((e) => e)

		expect(error).toBeInstanceOf(ConsentRequiredError)
		expect(error.provider).toBe('com.notion/mcp')
		expect(error.connectUrl).toContain('ticket=t-9')
	})

	it('separates a policy refusal from a failure', async () => {
		const { agent } = await agentWith({
			callErrors: { notion_search: { code: -32001, message: 'blocked by policy "pii"' } },
		})

		await expect(agent.callTool('notion_search')).rejects.toThrow(PolicyBlockedError)
	})

	// An admin can narrow the toolkit under a running agent; the caller needs
	// to know which tool went, not that params were invalid.
	it('names the tool when it is no longer served', async () => {
		const { agent } = await agentWith({
			callErrors: { notion_search: { code: -32602, message: 'mcp: tool not found: notion_search' } },
		})

		const error = await agent.callTool('notion_search').catch((e) => e)

		expect(error).toBeInstanceOf(ToolNotFoundError)
		expect(error.tool).toBe('notion_search')
	})

	// The gateway frames its answer as an event stream when it has a surface
	// change to announce on the same response.
	it('reads a response framed as an event stream', async () => {
		const { agent } = await agentWith({ frameAsEventStream: true })

		const result = await agent.callTool('notion_search', {})

		expect(result).toMatchObject({ content: [{ type: 'text', text: 'called notion_search' }] })
	})
})

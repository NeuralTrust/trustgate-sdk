import { inlineRefs, stripInjectedNulls, toStrict } from './schema.js'
import { ToolFormat, type GatewayTool, type JSONSchema, type ToolCall } from './types.js'

export type ConversionWarning = { tool: string; reason: string }

export type Conversion = {
	tools: unknown[]
	warnings: ConversionWarning[]
	/** The schema each tool had before translation, for the return trip. */
	originals: Map<string, JSONSchema>
}

export type ToolResult = { call: ToolCall; result: Record<string, unknown> }

/**
 * Each provider's function-calling dialect, in one place.
 *
 * A format knows three things: how to describe a tool, how to recognise the
 * model asking for one, and how to hand the answer back. They are grouped per
 * provider rather than per agent framework on purpose — a framework brings its
 * own MCP client and never sees any of this.
 */
export type FormatAdapter = {
	convert(tools: GatewayTool[], options: { strict: boolean }): Conversion
	extractCalls(output: unknown): ToolCall[]
	toOutputs(results: ToolResult[]): unknown[]
}

export function adapterFor(format: ToolFormat): FormatAdapter {
	const adapter = ADAPTERS[format]
	if (!adapter) throw new Error(`unknown tool format "${format}"`)
	return adapter
}

/** Undoes whatever the outbound conversion added to the arguments. */
export function restoreArguments(
	args: Record<string, unknown>,
	original: JSONSchema | undefined
): Record<string, unknown> {
	return stripInjectedNulls(args, original) as Record<string, unknown>
}

function convertWith(
	tools: GatewayTool[],
	options: { strict: boolean },
	shape: (tool: GatewayTool, schema: JSONSchema, strict: boolean) => unknown
): Conversion {
	const warnings: ConversionWarning[] = []
	const originals = new Map<string, JSONSchema>()
	const converted = tools.map((tool) => {
		originals.set(tool.name, tool.inputSchema)
		if (!options.strict) return shape(tool, inlineRefs(tool.inputSchema), false)
		const result = toStrict(tool.inputSchema)
		if (!result.strict) warnings.push({ tool: tool.name, reason: result.reason ?? 'unknown' })
		return shape(tool, result.schema, result.strict)
	})
	return { tools: converted, warnings, originals }
}

const openAIResponses: FormatAdapter = {
	convert: (tools, options) =>
		convertWith(tools, options, (tool, schema, strict) => ({
			type: 'function',
			name: tool.name,
			description: tool.description ?? '',
			parameters: schema,
			strict,
		})),
	extractCalls(output) {
		// Accepts the whole response or just its output array, because both are
		// what people have in hand at the call site.
		const items = Array.isArray(output)
			? output
			: ((output as { output?: unknown[] } | undefined)?.output ?? [])
		return items.flatMap((item) => {
			const call = item as Record<string, unknown>
			if (call.type !== 'function_call') return []
			return [
				{
					id: String(call.call_id ?? call.id ?? ''),
					name: String(call.name ?? ''),
					arguments: parseArguments(call.arguments),
				},
			]
		})
	},
	toOutputs: (results) =>
		results.map(({ call, result }) => ({
			type: 'function_call_output',
			call_id: call.id,
			output: resultToText(result),
		})),
}

const openAIChat: FormatAdapter = {
	convert: (tools, options) =>
		convertWith(tools, options, (tool, schema, strict) => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description ?? '',
				parameters: schema,
				strict,
			},
		})),
	extractCalls(output) {
		const calls = Array.isArray(output)
			? output
			: (((output as { choices?: { message?: { tool_calls?: unknown[] } }[] })?.choices?.[0]?.message
					?.tool_calls ?? []) as unknown[])
		return calls.flatMap((item) => {
			const call = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
			if (!call.function) return []
			return [
				{
					id: String(call.id ?? ''),
					name: String(call.function.name ?? ''),
					arguments: parseArguments(call.function.arguments),
				},
			]
		})
	},
	toOutputs: (results) =>
		results.map(({ call, result }) => ({
			role: 'tool',
			tool_call_id: call.id,
			content: resultToText(result),
		})),
}

const anthropicMessages: FormatAdapter = {
	convert: (tools, options) =>
		// Anthropic takes plain JSON Schema, so strict has nothing to add here:
		// asking for it would close objects for no gain.
		convertWith(tools, { strict: false }, (tool, schema) => ({
			name: tool.name,
			description: tool.description ?? '',
			input_schema: schema,
		})),
	extractCalls(output) {
		const content = Array.isArray(output)
			? output
			: ((output as { content?: unknown[] } | undefined)?.content ?? [])
		return content.flatMap((item) => {
			const block = item as Record<string, unknown>
			if (block.type !== 'tool_use') return []
			return [
				{
					id: String(block.id ?? ''),
					name: String(block.name ?? ''),
					arguments: (block.input as Record<string, unknown>) ?? {},
				},
			]
		})
	},
	toOutputs: (results) => [
		{
			role: 'user',
			content: results.map(({ call, result }) => ({
				type: 'tool_result',
				tool_use_id: call.id,
				content: resultToText(result),
				...(result.isError === true ? { is_error: true } : {}),
			})),
		},
	],
}

const gemini: FormatAdapter = {
	convert(tools, _options) {
		const warnings: ConversionWarning[] = []
		const originals = new Map<string, JSONSchema>()
		const declarations = tools.map((tool) => {
			originals.set(tool.name, tool.inputSchema)
			const { schema, dropped } = geminiSchema(inlineRefs(tool.inputSchema))
			if (dropped.length > 0) {
				warnings.push({
					tool: tool.name,
					reason: `dropped keywords Gemini does not accept: ${[...new Set(dropped)].join(', ')}`,
				})
			}
			return { name: tool.name, description: tool.description ?? '', parameters: schema }
		})
		return { tools: [{ functionDeclarations: declarations }], warnings, originals }
	},
	extractCalls(output) {
		const parts = Array.isArray(output)
			? output
			: (((output as { candidates?: { content?: { parts?: unknown[] } }[] })?.candidates?.[0]?.content
					?.parts ?? []) as unknown[])
		return parts.flatMap((item, index) => {
			const part = item as { functionCall?: { name?: unknown; args?: unknown } }
			if (!part.functionCall) return []
			const name = String(part.functionCall.name ?? '')
			return [
				{
					// Gemini does not give a call an id, so one is made from its
					// position — enough to pair a result with its call.
					id: `${name}:${index}`,
					name,
					arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
				},
			]
		})
	},
	toOutputs: (results) => [
		{
			role: 'user',
			parts: results.map(({ call, result }) => ({
				functionResponse: { name: call.name, response: resultToResponse(result) },
			})),
		},
	],
}

const ADAPTERS: Record<string, FormatAdapter> = {
	[ToolFormat.OpenAIResponses]: openAIResponses,
	[ToolFormat.OpenAIChat]: openAIChat,
	[ToolFormat.AnthropicMessages]: anthropicMessages,
	[ToolFormat.Gemini]: gemini,
}

/** Keywords Gemini's function declarations accept; everything else is dropped. */
const GEMINI_KEYWORDS = new Set([
	'type',
	'format',
	'description',
	'nullable',
	'enum',
	'properties',
	'required',
	'items',
	'anyOf',
	'minimum',
	'maximum',
])

function geminiSchema(schema: JSONSchema): { schema: JSONSchema; dropped: string[] } {
	const dropped: string[] = []

	// Inside `properties` the keys are the caller's own property names, not
	// schema keywords, so they are carried across untouched — filtering them
	// would delete the arguments rather than the syntax.
	const walkProperties = (node: unknown): unknown => {
		if (typeof node !== 'object' || node === null) return node
		const out: Record<string, unknown> = {}
		for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
			out[name] = walk(value)
		}
		return out
	}

	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk)
		if (typeof node !== 'object' || node === null) return node
		const out: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (!GEMINI_KEYWORDS.has(key)) {
				dropped.push(key)
				continue
			}
			if (key === 'properties') {
				out[key] = walkProperties(value)
				continue
			}
			out[key] = key === 'required' || key === 'enum' ? value : walk(value)
		}
		return out
	}

	return { schema: walk(schema) as JSONSchema, dropped }
}

function parseArguments(raw: unknown): Record<string, unknown> {
	if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>
	if (typeof raw !== 'string' || raw.trim() === '') return {}
	try {
		const parsed = JSON.parse(raw)
		return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

/**
 * What the model gets back from a tool.
 *
 * A structured result is the one worth giving it, since that is what the tool
 * promised in its output schema; the text blocks are the fallback, and the
 * whole result is the last resort. A tool that failed still answers here
 * rather than throwing: MCP puts tool errors in the result precisely so the
 * model can read them and correct itself.
 */
export function resultToText(result: Record<string, unknown>): string {
	if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent)
	const content = result.content
	if (Array.isArray(content)) {
		const text = content
			.filter((block) => (block as { type?: string }).type === 'text')
			.map((block) => String((block as { text?: unknown }).text ?? ''))
			.join('\n')
		if (text) return text
	}
	return JSON.stringify(result)
}

function resultToResponse(result: Record<string, unknown>): Record<string, unknown> {
	if (result.structuredContent !== undefined && typeof result.structuredContent === 'object') {
		return result.structuredContent as Record<string, unknown>
	}
	return { result: resultToText(result) }
}

/** Which actor a handle speaks as. The consumer decides this, not the caller. */
export const Actor = {
	/** The application itself — principal `app:<consumer_id>`. */
	Application: 'application',
	/** One of the application's own end users. */
	EndUser: 'end_user',
} as const
export type Actor = (typeof Actor)[keyof typeof Actor]

/**
 * The tool shapes the SDK can emit.
 *
 * These are model providers, not agent frameworks. A framework brings its own
 * MCP client, so it takes the gateway's URL and lists the tools itself — there
 * is nothing to convert. Conversion only happens when you call a provider's
 * API directly, which is why nothing here is called "langchain".
 */
export const ToolFormat = {
	/** OpenAI Responses API — function tools, flattened. */
	OpenAIResponses: 'openai-responses',
	/** OpenAI Chat Completions — function tools, nested under `function`. */
	OpenAIChat: 'openai-chat',
	/** Anthropic Messages — `input_schema`. */
	AnthropicMessages: 'anthropic-messages',
	/** Google Gemini — a single `functionDeclarations` entry. */
	Gemini: 'gemini',
} as const
export type ToolFormat = (typeof ToolFormat)[keyof typeof ToolFormat]

/** A tool as the gateway serves it, before any provider dialect is applied. */
export type GatewayTool = {
	name: string
	title?: string
	description?: string
	inputSchema: JSONSchema
	outputSchema?: JSONSchema
}

export type JSONSchema = Record<string, unknown>

/** One upstream account of an actor, as the connections API reports it. */
export type Connection = {
	provider: string
	registry?: string
	code?: string
	status: 'connected' | 'needs_reconnect' | 'not_connected'
	accountRef?: string
	expiresAt?: Date
}

/** The link an end user opens to connect their own account. */
export type ConnectLink = {
	connectUrl: string
	ticket: string
	provider?: string
	expiresAt: Date
}

/** Everything a provider's client needs to reach the gateway. */
export type Endpoint = {
	url: string
	headers: Record<string, string>
}

/** A tool call as the SDK understands it, whatever provider asked for it. */
export type ToolCall = {
	/** The provider's own identifier for this call, echoed back in the result. */
	id: string
	name: string
	arguments: Record<string, unknown>
}

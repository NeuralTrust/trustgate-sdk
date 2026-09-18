export { TrustGate, EndUserAgentFactory, type ConnectOptions, type LLMEndpoint } from './client.js'
export { Agent, EndUserAgent, Toolkit, type ToolkitOptions } from './agent.js'
export { type TrustGateConfig, API_KEY_HEADER, END_USER_HEADER } from './config.js'
export { MCPTransport } from './mcp.js'
export { inlineRefs, stripInjectedNulls, toStrict, type StrictResult } from './schema.js'
export { adapterFor, resultToText, type ConversionWarning } from './formats.js'
export {
	Actor,
	ToolFormat,
	type ConnectLink,
	type Connection,
	type Endpoint,
	type GatewayTool,
	type JSONSchema,
	type ToolCall,
} from './types.js'
export {
	AppActorUnavailableError,
	AuthenticationError,
	ConsentRequiredError,
	EndUserActorUnavailableError,
	InvalidRequestError,
	MissingToolsError,
	PlaneUnavailableError,
	PolicyBlockedError,
	RateLimitedError,
	ServiceUnavailableError,
	ToolNotFoundError,
	TrustGateError,
	TrustGateServerError,
	UpstreamNotConnectedError,
} from './errors.js'

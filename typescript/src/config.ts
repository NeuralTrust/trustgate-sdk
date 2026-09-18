import { TrustGateError } from './errors.js'

export type TrustGateConfig = {
	/**
	 * The gateway's base URL, without a consumer path:
	 * `https://gw.acme.ai`. Defaults to `TRUSTGATE_URL`.
	 */
	baseUrl?: string
	/** The consumer's API key. Defaults to `TRUSTGATE_API_KEY`. */
	apiKey?: string
	/**
	 * Slug of the MCP consumer — the one carrying the agent's tools. Defaults
	 * to `TRUSTGATE_MCP_CONSUMER`.
	 */
	mcpConsumer?: string
	/**
	 * Slug of the LLM consumer — the one in front of the models. Defaults to
	 * `TRUSTGATE_LLM_CONSUMER`. It is a different consumer from the MCP one
	 * because a consumer has one type; the same API key may be attached to
	 * both.
	 */
	llmConsumer?: string
	/** Overrides the fetch implementation. Tests and proxies use this. */
	fetch?: typeof globalThis.fetch
	/** Per-request timeout in milliseconds. Default 30000. */
	timeoutMs?: number
}

export type ResolvedConfig = {
	baseUrl: string
	apiKey: string
	mcpConsumer?: string
	llmConsumer?: string
	fetch: typeof globalThis.fetch
	timeoutMs: number
}

function fromEnv(name: string): string | undefined {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
	return env?.[name]
}

export function resolveConfig(config: TrustGateConfig = {}): ResolvedConfig {
	const baseUrl = (config.baseUrl ?? fromEnv('TRUSTGATE_URL') ?? '').trim().replace(/\/+$/, '')
	const apiKey = (config.apiKey ?? fromEnv('TRUSTGATE_API_KEY') ?? '').trim()
	if (!baseUrl) {
		throw new TrustGateError('baseUrl is required (or set TRUSTGATE_URL)')
	}
	if (!/^https?:\/\//.test(baseUrl)) {
		throw new TrustGateError(`baseUrl must be an http(s) URL, got "${baseUrl}"`)
	}
	if (!apiKey) {
		throw new TrustGateError('apiKey is required (or set TRUSTGATE_API_KEY)')
	}
	const fetchImpl = config.fetch ?? globalThis.fetch
	if (typeof fetchImpl !== 'function') {
		throw new TrustGateError('no fetch available; pass one in config.fetch (Node 18+ has a global)')
	}
	return {
		baseUrl,
		apiKey,
		mcpConsumer: config.mcpConsumer?.trim() || fromEnv('TRUSTGATE_MCP_CONSUMER')?.trim(),
		llmConsumer: config.llmConsumer?.trim() || fromEnv('TRUSTGATE_LLM_CONSUMER')?.trim(),
		fetch: fetchImpl,
		timeoutMs: config.timeoutMs ?? 30_000,
	}
}

/**
 * The header the gateway reads the consumer's API key from.
 *
 * It also accepts `x-api-key` and `Authorization: Bearer ag_…`; this one is
 * the unambiguous spelling, so it is the one the SDK sends.
 */
export const API_KEY_HEADER = 'X-AG-API-Key'

/** The header that names which of the application's end users a call is for. */
export const END_USER_HEADER = 'X-NeuralTrust-End-User'

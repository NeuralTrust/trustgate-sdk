import { TrustGateError } from './errors.js'

/**
 * Where a client with nothing but its key starts. The gateway finds which
 * gateway the key belongs to and answers with that gateway's own addresses, so
 * nothing else is called here.
 */
export const DEFAULT_BASE_URL = 'https://agentgateway-mcp.neuraltrust.ai'

export type TrustGateConfig = {
	/**
	 * Where to ask what the key reaches. Defaults to `TRUSTGATE_URL`, then to
	 * {@link DEFAULT_BASE_URL}. Set it only for a Hybrid gateway, to the MCP host
	 * its own data plane is published on: on NeuralTrust's cloud the key is
	 * enough.
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
	/**
	 * Lets the key travel over plain `http://` to a host other than this
	 * machine. Defaults to `TRUSTGATE_ALLOW_INSECURE_HTTP`. Only for a Hybrid
	 * gateway reached over a private network: anyone on the path reads the key.
	 */
	allowInsecureHttp?: boolean
}

export type ResolvedConfig = {
	baseUrl: string
	apiKey: string
	mcpConsumer?: string
	llmConsumer?: string
	fetch: typeof globalThis.fetch
	timeoutMs: number
	allowInsecureHttp: boolean
}

function fromEnv(name: string): string | undefined {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
	return env?.[name]
}

export function resolveConfig(config: TrustGateConfig = {}): ResolvedConfig {
	const baseUrl = (config.baseUrl?.trim() || fromEnv('TRUSTGATE_URL')?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
	const apiKey = (config.apiKey ?? fromEnv('TRUSTGATE_API_KEY') ?? '').trim()
	const allowInsecureHttp = config.allowInsecureHttp ?? insecureHttpFromEnv()
	requireSafeUrl(baseUrl, allowInsecureHttp, 'baseUrl')
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
		allowInsecureHttp,
	}
}

/** Whether `TRUSTGATE_ALLOW_INSECURE_HTTP` opts in to plain HTTP. */
export function insecureHttpFromEnv(): boolean {
	const raw = fromEnv('TRUSTGATE_ALLOW_INSECURE_HTTP')?.trim().toLowerCase()
	return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * Checks that a credential may be sent to `url`, and parses it.
 *
 * The key and the session token travel in headers, so plain HTTP hands them to
 * whoever is on the path. This machine is exempt, because nothing leaves it;
 * any other host needs the caller to opt in. Every address the SDK sends a
 * credential to passes through here — the configured one and the ones the
 * gateway answers with — so an https gateway cannot steer it onto http.
 */
export function requireSafeUrl(url: string, allowInsecureHttp: boolean, what: string): URL {
	let parsed: URL | undefined
	try {
		parsed = new URL(url)
	} catch {
		parsed = undefined
	}
	if (parsed?.protocol === 'https:') return parsed
	if (parsed?.protocol !== 'http:') {
		throw new TrustGateError(`${what} must be an http(s) URL, got "${url}"`)
	}
	if (allowInsecureHttp || isLoopback(parsed.hostname)) return parsed
	throw new TrustGateError(
		`${what} is plain http (${parsed.origin}), which would send credentials unencrypted. ` +
			'Use https, or set allowInsecureHttp (TRUSTGATE_ALLOW_INSECURE_HTTP=1) for a ' +
			'gateway reached over a private network.'
	)
}

/**
 * This machine, named so that no resolver is asked: `*.localhost` is local on
 * some systems and forwarded to the network's DNS on others.
 */
function isLoopback(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
	return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
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

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/**
 * Keeps an object that carries a credential usable, but out of logs.
 *
 * These objects are handed to a provider's or a framework's own client, so
 * their fields stay plain, readable and spreadable; what changes is how they
 * print. `JSON.stringify` and Node's `inspect` both look for a hook, and both
 * get the same object with the named fields masked. That is all it covers: a
 * copy made with `{ ...value }`, a field logged on its own, or a browser's
 * console, which reads neither hook, still show the secret.
 */
export function maskedWhenPrinted<T extends object>(value: T, secrets: (keyof T)[]): T {
	const masked = (): Record<string, unknown> => {
		const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
		for (const key of secrets) out[key as string] = mask(value[key])
		return out
	}
	Object.defineProperty(value, 'toJSON', { value: masked, enumerable: false })
	Object.defineProperty(value, INSPECT, { value: masked, enumerable: false })
	return value
}

function mask(secret: unknown): unknown {
	if (secret && typeof secret === 'object') {
		return Object.fromEntries(Object.keys(secret).map((name) => [name, '[redacted]']))
	}
	return secret ? '[redacted]' : secret
}

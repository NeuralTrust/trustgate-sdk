/**
 * A person on their own Store: signed in, with what Access lets them reach.
 *
 * An application reaches the gateway with an API key. A person has no key:
 * they sign in, the way their MCP client does, and get the Store — the servers
 * they installed, narrowed to what Access grants them. Signing in is OAuth
 * against the gateway itself (authorization code with PKCE, a client
 * registered on the fly, a redirect to a port on this machine), so nothing here
 * is new on the gateway's side: it is the flow Claude Code or Cursor run when
 * they add the Store.
 *
 * Signing in through the browser, and keeping the session in a file, need
 * Node; a token you already hold works anywhere `fetch` does.
 */
import { insecureHttpFromEnv, requireSafeUrl } from './config.js'
import { AuthenticationError, LoginRequiredError, TrustGateError } from './errors.js'
import { send as sendWithin } from './http.js'

/** Where a gateway serves the Store, under the host of its MCP plane. */
export const STORE_PATH = '/store/mcp'

/** How long before its expiry a session token is renewed rather than sent. */
const RENEW_MARGIN_MS = 60_000

/** The name the gateway shows for a client this SDK registers. */
const CLIENT_NAME = 'TrustGate SDK'

/** A signed-in session: the token the Store reads, and how to renew it. */
export type UserToken = {
	accessToken: string
	/** Epoch milliseconds the access token stops being accepted. 0 when unknown. */
	expiresAt: number
	refreshToken?: string
	/** The client the session was issued to, which a refresh has to name. */
	clientId?: string
}

/** Where a session outlives the process that signed in. */
export interface TokenCache {
	load(url: string): Promise<UserToken | undefined>
	save(url: string, token: UserToken): Promise<void>
	clear(url: string): Promise<void>
}

/** A cache for one process: sign in once, never on disk. */
export class MemoryTokenCache implements TokenCache {
	private readonly tokens = new Map<string, UserToken>()

	async load(url: string): Promise<UserToken | undefined> {
		return this.tokens.get(url)
	}

	async save(url: string, token: UserToken): Promise<void> {
		this.tokens.set(url, token)
	}

	async clear(url: string): Promise<void> {
		this.tokens.delete(url)
	}
}

/**
 * Sessions in one file, readable only by the user who signed in.
 *
 * The default is `~/.trustgate/sessions.json` (`TRUSTGATE_HOME` moves the
 * directory), keyed by Store URL so a person on two gateways keeps both. The
 * Python SDK reads and writes the same file, with the same fields.
 */
export class FileTokenCache implements TokenCache {
	constructor(readonly path?: string) {}

	async load(url: string): Promise<UserToken | undefined> {
		const entry = (await this.read())[url] as Record<string, unknown> | undefined
		if (!entry || typeof entry.access_token !== 'string' || !entry.access_token) return undefined
		return {
			accessToken: entry.access_token,
			// The file keeps seconds, as Python's time.time() does.
			expiresAt: Number(entry.expires_at ?? 0) * 1000,
			refreshToken: typeof entry.refresh_token === 'string' ? entry.refresh_token : undefined,
			clientId: typeof entry.client_id === 'string' ? entry.client_id : undefined,
		}
	}

	async save(url: string, token: UserToken): Promise<void> {
		const sessions = await this.read()
		sessions[url] = {
			access_token: token.accessToken,
			expires_at: token.expiresAt / 1000,
			refresh_token: token.refreshToken ?? null,
			client_id: token.clientId ?? null,
		}
		await this.write(sessions)
	}

	async clear(url: string): Promise<void> {
		const sessions = await this.read()
		if (!(url in sessions)) return
		delete sessions[url]
		await this.write(sessions)
	}

	private async file(): Promise<string> {
		if (this.path) return this.path
		const [{ homedir }, { join }] = await Promise.all([import('node:os'), import('node:path')])
		const home = fromEnv('TRUSTGATE_HOME')?.trim()
		return join(home || join(homedir(), '.trustgate'), 'sessions.json')
	}

	private async read(): Promise<Record<string, unknown>> {
		const { readFile } = await import('node:fs/promises')
		try {
			const data: unknown = JSON.parse(await readFile(await this.file(), 'utf8'))
			return data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
		} catch {
			return {}
		}
	}

	private async write(sessions: Record<string, unknown>): Promise<void> {
		const [{ mkdir, writeFile, rename }, { dirname }] = await Promise.all([
			import('node:fs/promises'),
			import('node:path'),
		])
		const file = await this.file()
		await mkdir(dirname(file), { recursive: true, mode: 0o700 })
		// Written owner-only before it holds anything: a refresh token is a
		// sign-in, and a umask is not a guarantee.
		const tmp = `${file}.tmp`
		await writeFile(tmp, JSON.stringify(sessions, null, 2), { mode: 0o600 })
		await rename(tmp, file)
	}
}

/**
 * The Store's MCP endpoint, from the URL the console shows or its host.
 *
 * The console's Store settings show `https://<gateway>.<mcp host>/store/mcp`.
 * The host alone is accepted too, because it is the part people copy.
 */
export function resolveStoreUrl(url?: string, allowInsecureHttp = insecureHttpFromEnv()): string {
	const raw = url?.trim() || fromEnv('TRUSTGATE_STORE_URL')?.trim()
	if (!raw) {
		throw new TrustGateError(
			'url is required (or set TRUSTGATE_STORE_URL): the Store URL the console shows, ' +
				'https://<gateway>.<mcp host>/store/mcp'
		)
	}
	const parsed = requireSafeUrl(raw, allowInsecureHttp, 'url')
	const path = parsed.pathname.replace(/\/+$/, '')
	return `${parsed.origin}${path || STORE_PATH}`
}

type AuthServer = { authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string }

type Http = { fetch: typeof globalThis.fetch; timeoutMs: number; allowInsecureHttp?: boolean }

/**
 * The bearer the Store reads, renewed before it runs out.
 *
 * A session token lasts an hour and its refresh token keeps it going, but only
 * so far: a NeuralTrust sign-in ends after a day, by design, so a change an
 * admin makes in Access reaches the person by then. Past that the session
 * cannot be renewed and {@link LoginRequiredError} says to sign in again.
 */
export class UserSession {
	private renewing?: Promise<void>
	// Runtime-private: the session token and its refresh token are a sign-in,
	// and a logged session must not carry them.
	#current: UserToken

	constructor(
		readonly url: string,
		current: UserToken,
		private readonly http: Http,
		private readonly cache?: TokenCache,
		private readonly now: () => number = Date.now
	) {
		this.#current = current
	}

	get token(): UserToken {
		return this.#current
	}

	/** The header as it stands, for a framework that takes headers once. */
	headersNow(): Record<string, string> {
		return { Authorization: `Bearer ${this.#current.accessToken}` }
	}

	/** The header for the next call, renewing the token first when it is about to end. */
	async headers(): Promise<Record<string, string>> {
		if (expiresSoon(this.#current, this.now()) && this.#current.refreshToken) await this.renewOnce()
		return this.headersNow()
	}

	/** Renews after the Store refused the token. False when it cannot be. */
	async renew(): Promise<boolean> {
		if (!this.#current.refreshToken) return false
		await this.renewOnce()
		return true
	}

	/** Concurrent calls share one refresh: the gateway rotates the refresh token. */
	private renewOnce(): Promise<void> {
		this.renewing ??= this.refresh().finally(() => {
			this.renewing = undefined
		})
		return this.renewing
	}

	private async refresh(): Promise<void> {
		const server = await discoverAuthServer(this.url, this.http)
		const form: Record<string, string> = {
			grant_type: 'refresh_token',
			refresh_token: this.#current.refreshToken ?? '',
			resource: this.url,
		}
		if (this.#current.clientId) form.client_id = this.#current.clientId
		const { status, body } = await postForm(server.tokenEndpoint, form, this.http)
		if (status >= 400 || typeof body.access_token !== 'string') {
			await this.cache?.clear(this.url)
			throw new LoginRequiredError(this.url, oauthReason(body, status))
		}
		this.#current = tokenFrom(body, this.#current.clientId, this.now(), this.#current)
		await this.cache?.save(this.url, this.#current)
	}
}

export function expiresSoon(token: UserToken, now: number): boolean {
	return token.expiresAt > 0 && now >= token.expiresAt - RENEW_MARGIN_MS
}

/**
 * Where the gateway that serves `url` signs people in.
 *
 * Its metadata names the endpoints; a gateway that does not publish it still
 * serves them at the conventional paths, so those are the fallback.
 */
async function discoverAuthServer(url: string, http: Http): Promise<AuthServer> {
	const origin = new URL(url).origin
	let meta: Record<string, unknown> = {}
	try {
		const { response, text } = await send(http, `${origin}/.well-known/oauth-authorization-server`, {
			headers: { Accept: 'application/json' },
		})
		if (response.ok) meta = asObject(safeParse(text))
	} catch (error) {
		// Metadata that moved is metadata this gateway does not publish here;
		// the conventional paths below are where it serves the endpoints.
		if (!(error instanceof TrustGateError && error.code === 'redirect')) throw error
	}
	// The metadata names where the refresh token, the PKCE verifier and the
	// browser go, so each address it gives has to be one they may be sent to.
	const endpoint = (value: unknown, fallback: string, what: string): string => {
		const chosen = stringOr(value, fallback)
		requireSafeUrl(chosen, http.allowInsecureHttp ?? false, `the gateway's ${what}`)
		return chosen
	}
	return {
		authorizationEndpoint: endpoint(meta.authorization_endpoint, `${origin}/oauth/authorize`, 'authorization endpoint'),
		tokenEndpoint: endpoint(meta.token_endpoint, `${origin}/oauth/token`, 'token endpoint'),
		registrationEndpoint: endpoint(meta.registration_endpoint, `${origin}/oauth/register`, 'registration endpoint'),
	}
}

export type LoginFlowOptions = {
	/** Opens the sign-in page in the default browser. Default true. */
	openBrowser?: boolean
	/** Receives the sign-in URL. Default: printed to stderr, for a browser that did not open. */
	onUrl?: (url: string) => void
	/** How long to wait for the browser to come back. Default 5 minutes. */
	waitMs?: number
}

/**
 * Signs a person in through their browser and returns the session.
 *
 * A server on a loopback port receives the redirect, so this runs on the
 * person's own machine: on a server or over SSH there is no browser to come
 * back to it. That is what an application's API key is for.
 */
export async function loginFlow(url: string, http: Http, options: LoginFlowOptions = {}): Promise<UserToken> {
	const server = await discoverAuthServer(url, http)
	const callback = await CallbackServer.start()
	let params: Record<string, string>
	let clientId: string
	let verifier: string
	let state: string
	try {
		clientId = await registerClient(server, callback.redirectUri, http)
		verifier = randomToken(48)
		state = randomToken(24)
		const authorize = new URL(server.authorizationEndpoint)
		const query = {
			response_type: 'code',
			client_id: clientId,
			redirect_uri: callback.redirectUri,
			state,
			code_challenge: await s256(verifier),
			code_challenge_method: 'S256',
			resource: url,
		}
		for (const [key, value] of Object.entries(query)) authorize.searchParams.set(key, value)
		;(options.onUrl ?? printUrl)(authorize.toString())
		if (options.openBrowser ?? true) await openInBrowser(authorize.toString())
		params = await callback.wait(options.waitMs ?? 300_000)
	} finally {
		callback.close()
	}

	if (params.state !== state) {
		throw new AuthenticationError('sign-in failed: the browser came back for another sign-in')
	}
	if (params.error) {
		throw new AuthenticationError(`sign-in failed: ${params.error_description || params.error}`, {
			code: params.error,
		})
	}
	if (!params.code) throw new AuthenticationError('sign-in failed: the gateway sent no authorization code')

	const { status, body } = await postForm(
		server.tokenEndpoint,
		{
			grant_type: 'authorization_code',
			code: params.code,
			redirect_uri: callback.redirectUri,
			client_id: clientId,
			code_verifier: verifier,
			resource: url,
		},
		http
	)
	if (status >= 400 || typeof body.access_token !== 'string') {
		throw new AuthenticationError(`sign-in failed: ${oauthReason(body, status)}`, { status })
	}
	return tokenFrom(body, clientId, Date.now())
}

async function registerClient(server: AuthServer, redirectUri: string, http: Http): Promise<string> {
	const { response, text } = await send(http, server.registrationEndpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({
			client_name: CLIENT_NAME,
			redirect_uris: [redirectUri],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		}),
	})
	const body = asObject(safeParse(text))
	if (!response.ok || typeof body.client_id !== 'string' || !body.client_id) {
		throw new AuthenticationError(
			`this gateway does not let a client sign people in: ${oauthReason(body, response.status)}`,
			{ status: response.status }
		)
	}
	return body.client_id
}

async function postForm(
	url: string,
	form: Record<string, string>,
	http: Http
): Promise<{ status: number; body: Record<string, unknown> }> {
	const { response, text } = await send(http, url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
		body: new URLSearchParams(form).toString(),
	})
	return { status: response.status, body: asObject(safeParse(text)) }
}

function send(http: Http, url: string, init: RequestInit): ReturnType<typeof sendWithin> {
	return sendWithin(http.fetch, url, init, {
		timeoutMs: http.timeoutMs,
		failure: `${init.method ?? 'GET'} ${url} failed to reach the gateway`,
	})
}

function tokenFrom(
	body: Record<string, unknown>,
	clientId: string | undefined,
	now: number,
	previous?: UserToken
): UserToken {
	const expiresIn = Number(body.expires_in)
	return {
		accessToken: String(body.access_token),
		expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : 0,
		// The gateway rotates it on every refresh; keep the old one only when an
		// answer leaves it out.
		refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refreshToken,
		clientId,
	}
}

function oauthReason(body: Record<string, unknown>, status: number): string {
	for (const key of ['error_description', 'message', 'error']) {
		if (typeof body[key] === 'string' && body[key]) return body[key] as string
	}
	return `HTTP ${status}`
}

function randomToken(bytes: number): string {
	const buffer = new Uint8Array(bytes)
	globalThis.crypto.getRandomValues(buffer)
	return base64url(buffer)
}

async function s256(verifier: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
	return base64url(new Uint8Array(digest))
}

function base64url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function printUrl(url: string): void {
	process.stderr.write(`Sign in to TrustGate in your browser:\n\n    ${url}\n\n`)
}

/**
 * Best effort: the printed URL is what a person without a browser here follows.
 *
 * The URL goes to the browser as one argument and never through a shell. On
 * Windows `cmd /c start` parses its arguments, so the `&` between query
 * parameters splits the URL; `rundll32 url.dll,FileProtocolHandler` takes it
 * whole, the way Go's and Rust's browser openers do.
 */
export async function openInBrowser(url: string): Promise<void> {
	if (!/^https?:\/\//i.test(url)) return
	try {
		const { spawn } = await import('node:child_process')
		const [command, args] =
			process.platform === 'darwin'
				? ['open', [url]]
				: process.platform === 'win32'
					? ['rundll32', ['url.dll,FileProtocolHandler', url]]
					: ['xdg-open', [url]]
		const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false })
		child.on('error', () => undefined)
		child.unref()
	} catch {
		// No browser to open; the URL was printed.
	}
}

const DONE_PAGE =
	'<!doctype html><meta charset=utf-8><title>TrustGate</title>' +
	"<body style='font-family:system-ui;margin:3rem'>" +
	'<h1>Signed in</h1><p>You can close this tab and go back to your terminal.</p>'

/** A one-shot HTTP server on a loopback port, for the sign-in redirect. */
class CallbackServer {
	private constructor(
		readonly redirectUri: string,
		private readonly received: Promise<Record<string, string>>,
		private readonly server: { close(): void; closeAllConnections?(): void }
	) {}

	static async start(): Promise<CallbackServer> {
		const { createServer } = await import('node:http')
		let resolve!: (params: Record<string, string>) => void
		const received = new Promise<Record<string, string>>((r) => {
			resolve = r
		})
		const server = createServer((req, res) => {
			const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
			if (parsed.pathname !== '/callback') {
				res.writeHead(404).end()
				return
			}
			resolve(Object.fromEntries(parsed.searchParams))
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE)
		})
		await new Promise<void>((ready, fail) => {
			server.once('error', fail)
			server.listen(0, '127.0.0.1', () => ready())
		})
		const address = server.address()
		const port = typeof address === 'object' && address ? address.port : 0
		return new CallbackServer(`http://127.0.0.1:${port}/callback`, received, server)
	}

	async wait(waitMs: number): Promise<Record<string, string>> {
		let timer: ReturnType<typeof setTimeout> | undefined
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(new AuthenticationError(`sign-in timed out after ${Math.round(waitMs / 1000)}s waiting for the browser`)),
				waitMs
			)
		})
		try {
			return await Promise.race([this.received, timeout])
		} finally {
			clearTimeout(timer)
		}
	}

	close(): void {
		this.server.closeAllConnections?.()
		this.server.close()
	}
}

function fromEnv(name: string): string | undefined {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
	return env?.[name]
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === 'string' && value ? value : fallback
}

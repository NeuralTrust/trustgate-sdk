/**
 * Where the examples get their placeholders from.
 *
 * Every one of them needs a key, and the SDK already reads it from
 * TRUSTGATE_API_KEY (and TRUSTGATE_URL, when the gateway is not NeuralTrust's
 * cloud). This only adds the part the SDK cannot: saying which variable is
 * missing, and where to find its value, instead of failing on the first
 * request.
 *
 * `.env` is read by Node itself (`--env-file-if-exists`), so there is no
 * dotenv dependency here.
 */

/** The value, or an exit that says which one and where to get it. */
export function require(name: string, where: string): string {
	const value = (process.env[name] ?? '').trim()
	if (!value || value.startsWith('<')) {
		console.error(
			`${name} is not set. ${where}\n` +
				'Put it in examples/typescript/.env (copy .env.example) or export it before running.'
		)
		process.exit(1)
	}
	return value
}

/** Checks the key the SDK reads, before it is constructed. */
export function gatewayEnv(): void {
	require(
		'TRUSTGATE_API_KEY',
		"It is the application's API key — the Authentication block of its General tab issues one."
	)
}

/** Reports a failed run as a sentence; a traceback is not what a first run needs. */
export function fail(error: unknown): never {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
}

import type { JSONSchema } from './types.js'

/**
 * Turning a tool's JSON Schema into what a provider will accept.
 *
 * The gateway relays an upstream server's schema exactly as that server wrote
 * it — that is the honest thing for a gateway to do, and it means the schema
 * can use anything JSON Schema allows. Every provider's function calling
 * accepts a smaller language than that. Translating is therefore the client's
 * job, done here, once, against the format the caller asked for.
 *
 * Two of these conversions lose information, so both are reversible and the
 * original schema is kept: what goes out closed and nullable has to come back
 * open and absent, or the upstream rejects the call it was asked to make.
 */

export type StrictResult = {
	schema: JSONSchema
	/** False when the schema uses something strict mode cannot express. */
	strict: boolean
	/** Why not, for the warning the caller gets. */
	reason?: string
}

/**
 * Inlines local `$ref`s.
 *
 * Nothing is lost: a reference and its target describe the same thing. It is
 * separated from the strict pass because every provider needs it and none of
 * them object to the result — which is why this is also the part that could
 * one day move into the gateway.
 */
export function inlineRefs(schema: JSONSchema): JSONSchema {
	const defs = {
		...((schema.$defs as Record<string, JSONSchema>) ?? {}),
		...((schema.definitions as Record<string, JSONSchema>) ?? {}),
	}
	const seen = new Set<string>()

	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk)
		if (!isObject(node)) return node
		const ref = node.$ref
		if (typeof ref === 'string') {
			const target = resolveRef(ref, defs)
			// A cycle cannot be inlined; leaving the $ref in place makes the
			// strict pass refuse the tool, which is better than looping.
			if (target && !seen.has(ref)) {
				seen.add(ref)
				const resolved = walk({ ...target, ...omit(node, ['$ref']) })
				seen.delete(ref)
				return resolved
			}
			return node
		}
		const out: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(node)) {
			if (key === '$defs' || key === 'definitions') continue
			out[key] = walk(value)
		}
		return out
	}

	return walk(schema) as JSONSchema
}

function resolveRef(ref: string, defs: Record<string, JSONSchema>): JSONSchema | undefined {
	const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref)
	if (!match) return undefined
	return defs[decodeURIComponent(match[1])]
}

/**
 * Rewrites a schema for OpenAI's strict function calling.
 *
 * Strict buys a guarantee worth having — the model cannot invent an argument —
 * and charges for it in expressiveness: every object closed, every property
 * required, and optionality expressed by accepting null. Schemas that use what
 * strict cannot say are returned untouched with `strict: false`, because a tool
 * the model can still call imperfectly beats a tool it cannot call at all.
 */
export function toStrict(schema: JSONSchema): StrictResult {
	const inlined = inlineRefs(schema)
	let reason: string | undefined

	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk)
		if (!isObject(node)) return node
		if ('$ref' in node) {
			reason ??= 'it carries a $ref that does not resolve inside the schema'
			return node
		}
		if ('allOf' in node) {
			reason ??= 'it composes with allOf'
			return node
		}
		if ('prefixItems' in node) {
			reason ??= 'it uses prefixItems (tuple typing)'
			return node
		}

		const out: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(node)) {
			out[key] = key === 'required' ? value : walk(value)
		}

		if (out.type !== 'object' && !isObject(out.properties)) return out

		if (out.additionalProperties !== undefined && out.additionalProperties !== false) {
			reason ??= 'it accepts properties that are not in its schema'
			return out
		}
		out.additionalProperties = false

		const properties = (out.properties as Record<string, JSONSchema>) ?? {}
		const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : [])
		const rewritten: Record<string, JSONSchema> = {}
		for (const [name, property] of Object.entries(properties)) {
			rewritten[name] = required.has(name) ? property : nullable(property)
		}
		out.properties = rewritten
		// Strict wants every property named as required. What used to be
		// optional stays optional in effect, by accepting null.
		out.required = Object.keys(rewritten)
		return out
	}

	const rewritten = walk(inlined) as JSONSchema
	return reason ? { schema: inlined, strict: false, reason } : { schema: rewritten, strict: true }
}

/** Lets a schema accept null without losing what it already said. */
function nullable(schema: JSONSchema): JSONSchema {
	if (typeof schema.type === 'string') {
		return { ...schema, type: [schema.type, 'null'] }
	}
	if (Array.isArray(schema.type)) {
		return schema.type.includes('null') ? schema : { ...schema, type: [...schema.type, 'null'] }
	}
	// No plain type to widen (an enum, an anyOf): offer null beside it.
	return { anyOf: [schema, { type: 'null' }] }
}

/**
 * Removes the nulls strict mode asked the model to send.
 *
 * `toStrict` made every optional property nullable so it could be named in
 * `required`. The model takes that literally and sends `null` for the ones it
 * has no value for — and the upstream server, which never agreed to any of
 * this, rejects them. So the arguments are compared against the *original*
 * schema on the way back, and a null it never permitted is dropped rather than
 * forwarded.
 */
export function stripInjectedNulls(args: unknown, original: JSONSchema | undefined): unknown {
	if (Array.isArray(args)) {
		const items = original?.items as JSONSchema | undefined
		return args.map((item) => stripInjectedNulls(item, items))
	}
	if (!isObject(args)) return args
	const properties = (original?.properties as Record<string, JSONSchema> | undefined) ?? {}
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(args)) {
		const property = properties[key]
		if (value === null && !permitsNull(property)) continue
		out[key] = stripInjectedNulls(value, property)
	}
	return out
}

function permitsNull(schema: JSONSchema | undefined): boolean {
	// An unknown property is left alone: the upstream may accept keys this
	// schema does not describe, and dropping one would lose a real argument.
	if (!schema) return true
	if (schema.type === 'null') return true
	if (Array.isArray(schema.type) && schema.type.includes('null')) return true
	const anyOf = schema.anyOf ?? schema.oneOf
	if (Array.isArray(anyOf)) {
		return anyOf.some((option) => permitsNull(option as JSONSchema))
	}
	return false
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function omit(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(source)) {
		if (!keys.includes(key)) out[key] = value
	}
	return out
}

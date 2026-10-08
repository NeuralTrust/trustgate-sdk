import { describe, expect, it } from 'vitest'

import { MAX_INLINED_NODES, MAX_SCHEMA_DEPTH, inlineRefs, stripInjectedNulls, toStrict } from '../src/schema.js'

describe('inlineRefs', () => {
	it('replaces a local reference with what it points at', () => {
		const out = inlineRefs({
			type: 'object',
			properties: { filter: { $ref: '#/$defs/Filter' } },
			$defs: { Filter: { type: 'object', properties: { tag: { type: 'string' } } } },
		})

		expect(out).toEqual({
			type: 'object',
			properties: { filter: { type: 'object', properties: { tag: { type: 'string' } } } },
		})
	})

	// A schema that refers to itself has no finite inlining. Leaving the $ref
	// is what makes the strict pass refuse the tool instead of looping.
	it('leaves a cycle alone', () => {
		const out = inlineRefs({
			type: 'object',
			properties: { child: { $ref: '#/$defs/Node' } },
			$defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
		})

		expect(JSON.stringify(out)).toContain('$ref')
	})
})

/** Each level names the one below twice: 2^depth copies once inlined. */
function doubling(depth: number): Record<string, unknown> {
	const defs: Record<string, unknown> = { L0: { type: 'string' } }
	for (let level = 1; level <= depth; level++) {
		defs[`L${level}`] = {
			type: 'object',
			properties: { a: { $ref: `#/$defs/L${level - 1}` }, b: { $ref: `#/$defs/L${level - 1}` } },
		}
	}
	return { type: 'object', properties: { root: { $ref: `#/$defs/L${depth}` } }, $defs: defs }
}

describe('a schema whose references multiply', () => {
	// Thirty levels is a few kilobytes of $defs and a billion nodes inlined.
	it('is left as written instead of inlined', () => {
		const schema = doubling(30)
		const started = Date.now()

		const out = inlineRefs(schema)

		expect(out).toBe(schema)
		expect(Date.now() - started).toBeLessThan(1_000)
	})

	it('is not strict, and says why', () => {
		const result = toStrict(doubling(30))

		expect(result.strict).toBe(false)
		expect(result.reason).toContain(String(MAX_INLINED_NODES))
	})

	// No doubling needed: one long enum, referenced from many properties.
	it('counts every value it would copy, not just the objects', () => {
		const properties: Record<string, unknown> = {}
		for (let i = 0; i < 3_000; i++) properties[`p${i}`] = { $ref: '#/$defs/Code' }
		const schema = {
			type: 'object',
			properties,
			$defs: { Code: { enum: Array.from({ length: 100_000 }, (_, i) => i) } },
		}

		expect(inlineRefs(schema)).toBe(schema)
	})

	it('is left as written when it nests too deep to follow', () => {
		let schema: Record<string, unknown> = { type: 'string' }
		for (let i = 0; i < MAX_SCHEMA_DEPTH * 10; i++) schema = { type: 'object', properties: { x: schema } }

		expect(inlineRefs(schema)).toBe(schema)
		expect(toStrict(schema).strict).toBe(false)
	})

	it('still inlines one that stays under the limit', () => {
		expect(JSON.stringify(inlineRefs(doubling(4)))).not.toContain('$ref')
	})
})

describe('toStrict', () => {
	it('closes every object and names every property as required', () => {
		const { schema, strict } = toStrict({
			type: 'object',
			properties: {
				query: { type: 'string' },
				limit: { type: 'integer' },
			},
			required: ['query'],
		})

		expect(strict).toBe(true)
		expect(schema.additionalProperties).toBe(false)
		expect(schema.required).toEqual(['query', 'limit'])
		// What used to be optional stays optional in effect, by accepting null.
		expect((schema.properties as Record<string, { type: unknown }>).limit.type).toEqual([
			'integer',
			'null',
		])
		expect((schema.properties as Record<string, { type: unknown }>).query.type).toBe('string')
	})

	it('offers null beside a schema with no plain type to widen', () => {
		const { schema } = toStrict({
			type: 'object',
			properties: { mode: { enum: ['fast', 'slow'] } },
			required: [],
		})

		expect((schema.properties as Record<string, { anyOf: unknown }>).mode.anyOf).toEqual([
			{ enum: ['fast', 'slow'] },
			{ type: 'null' },
		])
	})

	// A tool the model can still call imperfectly beats one it cannot call.
	it.each([
		['arbitrary keys', { type: 'object', properties: {}, additionalProperties: true }, /not in its schema/],
		['allOf', { allOf: [{ type: 'object' }] }, /allOf/],
		['prefixItems', { type: 'object', properties: { t: { prefixItems: [{ type: 'string' }] } } }, /prefixItems/],
	])('gives up on %s and says why', (_label, input, expected) => {
		const result = toStrict(input as Record<string, unknown>)

		expect(result.strict).toBe(false)
		expect(result.reason).toMatch(expected as RegExp)
	})
})

describe('stripInjectedNulls', () => {
	const original = {
		type: 'object',
		properties: {
			query: { type: 'string' },
			limit: { type: 'integer' },
			cursor: { type: ['string', 'null'] },
		},
		required: ['query'],
	}

	// Strict asked the model to send null for what it had no value for. The
	// upstream never agreed to that and rejects it.
	it('drops the nulls the conversion asked for', () => {
		const out = stripInjectedNulls({ query: 'runbook', limit: null }, original)

		expect(out).toEqual({ query: 'runbook' })
	})

	it('keeps a null the tool actually accepts', () => {
		const out = stripInjectedNulls({ query: 'runbook', cursor: null }, original)

		expect(out).toEqual({ query: 'runbook', cursor: null })
	})

	it('keeps a null under a key the schema never described', () => {
		const out = stripInjectedNulls({ query: 'x', extra: null }, original)

		expect(out).toEqual({ query: 'x', extra: null })
	})

	it('reaches into nested objects and arrays', () => {
		const nested = {
			type: 'object',
			properties: {
				filter: { type: 'object', properties: { tag: { type: 'string' } } },
				items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
			},
		}

		const out = stripInjectedNulls(
			{ filter: { tag: null }, items: [{ id: 'a' }, { id: null }] },
			nested
		)

		expect(out).toEqual({ filter: {}, items: [{ id: 'a' }, {}] })
	})
})

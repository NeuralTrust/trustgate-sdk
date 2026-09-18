import { describe, expect, it } from 'vitest'

import { inlineRefs, stripInjectedNulls, toStrict } from '../src/schema.js'

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

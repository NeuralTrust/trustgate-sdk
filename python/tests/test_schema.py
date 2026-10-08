from __future__ import annotations

import json

import pytest

from trustgate import inline_refs, strip_injected_nulls, to_strict
from trustgate.schema import MAX_INLINED_NODES, MAX_SCHEMA_DEPTH


def test_inline_refs_replaces_a_local_reference() -> None:
    out = inline_refs(
        {
            "type": "object",
            "properties": {"filter": {"$ref": "#/$defs/Filter"}},
            "$defs": {"Filter": {"type": "object", "properties": {"tag": {"type": "string"}}}},
        }
    )

    assert out == {
        "type": "object",
        "properties": {"filter": {"type": "object", "properties": {"tag": {"type": "string"}}}},
    }


# A schema that refers to itself has no finite inlining. Leaving the $ref is
# what makes the strict pass refuse the tool instead of looping.
def test_inline_refs_leaves_a_cycle_alone() -> None:
    out = inline_refs(
        {
            "type": "object",
            "properties": {"child": {"$ref": "#/$defs/Node"}},
            "$defs": {
                "Node": {"type": "object", "properties": {"child": {"$ref": "#/$defs/Node"}}}
            },
        }
    )

    assert "$ref" in json.dumps(out)


def test_to_strict_closes_objects_and_names_every_property() -> None:
    result = to_strict(
        {
            "type": "object",
            "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}},
            "required": ["query"],
        }
    )

    assert result.strict is True
    assert result.schema["additionalProperties"] is False
    assert result.schema["required"] == ["query", "limit"]
    # What used to be optional stays optional in effect, by accepting null.
    assert result.schema["properties"]["limit"]["type"] == ["integer", "null"]
    assert result.schema["properties"]["query"]["type"] == "string"


def test_to_strict_offers_null_beside_a_schema_with_no_plain_type() -> None:
    result = to_strict(
        {"type": "object", "properties": {"mode": {"enum": ["fast", "slow"]}}, "required": []}
    )

    assert result.schema["properties"]["mode"]["anyOf"] == [
        {"enum": ["fast", "slow"]},
        {"type": "null"},
    ]


# A tool the model can still call imperfectly beats one it cannot call.
@pytest.mark.parametrize(
    "schema,expected",
    [
        ({"type": "object", "properties": {}, "additionalProperties": True}, "not in its schema"),
        ({"allOf": [{"type": "object"}]}, "allOf"),
        (
            {"type": "object", "properties": {"t": {"prefixItems": [{"type": "string"}]}}},
            "prefixItems",
        ),
    ],
)
def test_to_strict_gives_up_and_says_why(schema: dict, expected: str) -> None:
    result = to_strict(schema)

    assert result.strict is False
    assert expected in (result.reason or "")


ORIGINAL = {
    "type": "object",
    "properties": {
        "query": {"type": "string"},
        "limit": {"type": "integer"},
        "cursor": {"type": ["string", "null"]},
    },
    "required": ["query"],
}


# Strict asked the model to send null for what it had no value for. The
# upstream never agreed to that and rejects it.
def test_strip_injected_nulls_drops_what_the_conversion_asked_for() -> None:
    assert strip_injected_nulls({"query": "runbook", "limit": None}, ORIGINAL) == {
        "query": "runbook"
    }


def test_strip_injected_nulls_keeps_a_null_the_tool_accepts() -> None:
    assert strip_injected_nulls({"query": "r", "cursor": None}, ORIGINAL) == {
        "query": "r",
        "cursor": None,
    }


def test_strip_injected_nulls_keeps_an_undescribed_key() -> None:
    assert strip_injected_nulls({"query": "x", "extra": None}, ORIGINAL) == {
        "query": "x",
        "extra": None,
    }


def test_strip_injected_nulls_reaches_into_nested_objects_and_arrays() -> None:
    nested = {
        "type": "object",
        "properties": {
            "filter": {"type": "object", "properties": {"tag": {"type": "string"}}},
            "items": {
                "type": "array",
                "items": {"type": "object", "properties": {"id": {"type": "string"}}},
            },
        },
    }

    out = strip_injected_nulls(
        {"filter": {"tag": None}, "items": [{"id": "a"}, {"id": None}]}, nested
    )

    assert out == {"filter": {}, "items": [{"id": "a"}, {}]}


def _doubling(depth: int) -> dict:
    """Each level names the one below twice: 2**depth copies once inlined."""
    defs: dict = {"L0": {"type": "string"}}
    for level in range(1, depth + 1):
        below = {"$ref": f"#/$defs/L{level - 1}"}
        defs[f"L{level}"] = {"type": "object", "properties": {"a": below, "b": dict(below)}}
    return {"type": "object", "properties": {"root": {"$ref": f"#/$defs/L{depth}"}}, "$defs": defs}


# Thirty levels is a few kilobytes of $defs and a billion nodes inlined.
def test_a_schema_whose_references_multiply_is_left_as_written() -> None:
    schema = _doubling(30)

    assert inline_refs(schema) is schema


def test_a_schema_whose_references_multiply_is_not_strict_and_says_why() -> None:
    result = to_strict(_doubling(30))

    assert result.strict is False
    assert str(MAX_INLINED_NODES) in (result.reason or "")


# No doubling needed: one long enum, referenced from many properties.
def test_every_value_inlining_would_copy_counts_not_just_the_objects() -> None:
    schema = {
        "type": "object",
        "properties": {f"p{i}": {"$ref": "#/$defs/Code"} for i in range(3_000)},
        "$defs": {"Code": {"enum": list(range(100_000))}},
    }

    assert inline_refs(schema) is schema


def test_a_schema_nested_too_deep_to_follow_is_left_as_written() -> None:
    schema: dict = {"type": "string"}
    for _ in range(MAX_SCHEMA_DEPTH * 10):
        schema = {"type": "object", "properties": {"x": schema}}

    assert inline_refs(schema) is schema
    assert to_strict(schema).strict is False


def test_a_schema_under_the_limit_is_still_inlined() -> None:
    assert "$ref" not in json.dumps(inline_refs(_doubling(4)))

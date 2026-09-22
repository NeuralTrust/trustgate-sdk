from __future__ import annotations

import json

import pytest

from trustgate import inline_refs, strip_injected_nulls, to_strict


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

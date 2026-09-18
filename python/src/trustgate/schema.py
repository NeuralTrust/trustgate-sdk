"""Turning a tool's JSON Schema into what a provider will accept.

The gateway relays an upstream server's schema exactly as that server wrote it
- that is the honest thing for a gateway to do, and it means the schema can use
anything JSON Schema allows. Every provider's function calling accepts a
smaller language than that. Translating is therefore the client's job, done
here, once, against the format the caller asked for.

Two of these conversions lose information, so both are reversible and the
original schema is kept: what goes out closed and nullable has to come back
open and absent, or the upstream rejects the call it was asked to make.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

Schema = dict[str, Any]

_REF = re.compile(r"^#/(?:\$defs|definitions)/(.+)$")


@dataclass(frozen=True)
class StrictResult:
    schema: Schema
    #: False when the schema uses something strict mode cannot express.
    strict: bool
    #: Why not, for the warning the caller gets.
    reason: str | None = None


def inline_refs(schema: Schema) -> Schema:
    """Inlines local ``$ref``s.

    Nothing is lost: a reference and its target describe the same thing. It is
    separated from the strict pass because every provider needs it and none of
    them object to the result - which is why this is also the part that could
    one day move into the gateway.
    """
    defs: dict[str, Schema] = {}
    defs.update(schema.get("$defs") or {})
    defs.update(schema.get("definitions") or {})
    seen: set[str] = set()

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(item) for item in node]
        if not isinstance(node, dict):
            return node
        ref = node.get("$ref")
        if isinstance(ref, str):
            target = _resolve(ref, defs)
            # A cycle cannot be inlined; leaving the $ref in place makes the
            # strict pass refuse the tool, which is better than looping.
            if target is not None and ref not in seen:
                seen.add(ref)
                merged = {**target, **{k: v for k, v in node.items() if k != "$ref"}}
                resolved = walk(merged)
                seen.discard(ref)
                return resolved
            return node
        return {
            key: walk(value)
            for key, value in node.items()
            if key not in ("$defs", "definitions")
        }

    return walk(schema)


def _resolve(ref: str, defs: dict[str, Schema]) -> Schema | None:
    match = _REF.match(ref)
    if not match:
        return None
    return defs.get(match.group(1))


def to_strict(schema: Schema) -> StrictResult:
    """Rewrites a schema for OpenAI's strict function calling.

    Strict buys a guarantee worth having - the model cannot invent an argument -
    and charges for it in expressiveness: every object closed, every property
    required, and optionality expressed by accepting null. Schemas that use what
    strict cannot say are returned untouched with ``strict=False``, because a
    tool the model can still call imperfectly beats a tool it cannot call at all.
    """
    inlined = inline_refs(schema)
    reason: str | None = None

    def refuse(why: str) -> None:
        nonlocal reason
        if reason is None:
            reason = why

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(item) for item in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            refuse("it carries a $ref that does not resolve inside the schema")
            return node
        if "allOf" in node:
            refuse("it composes with allOf")
            return node
        if "prefixItems" in node:
            refuse("it uses prefixItems (tuple typing)")
            return node

        out = {
            key: (value if key == "required" else walk(value)) for key, value in node.items()
        }
        if out.get("type") != "object" and not isinstance(out.get("properties"), dict):
            return out

        extra = out.get("additionalProperties")
        if extra is not None and extra is not False:
            refuse("it accepts properties that are not in its schema")
            return out
        out["additionalProperties"] = False

        properties: dict[str, Schema] = out.get("properties") or {}
        required = set(out.get("required") or [])
        out["properties"] = {
            name: (prop if name in required else _nullable(prop))
            for name, prop in properties.items()
        }
        # Strict wants every property named as required. What used to be
        # optional stays optional in effect, by accepting null.
        out["required"] = list(out["properties"].keys())
        return out

    rewritten = walk(inlined)
    if reason is not None:
        return StrictResult(schema=inlined, strict=False, reason=reason)
    return StrictResult(schema=rewritten, strict=True)


def _nullable(schema: Schema) -> Schema:
    kind = schema.get("type")
    if isinstance(kind, str):
        return {**schema, "type": [kind, "null"]}
    if isinstance(kind, list):
        return schema if "null" in kind else {**schema, "type": [*kind, "null"]}
    # No plain type to widen (an enum, an anyOf): offer null beside it.
    return {"anyOf": [schema, {"type": "null"}]}


def strip_injected_nulls(args: Any, original: Schema | None) -> Any:
    """Removes the nulls strict mode asked the model to send.

    ``to_strict`` made every optional property nullable so it could be named in
    ``required``. The model takes that literally and sends ``null`` for the ones
    it has no value for - and the upstream server, which never agreed to any of
    this, rejects them. So the arguments are compared against the *original*
    schema on the way back, and a null it never permitted is dropped rather than
    forwarded.
    """
    if isinstance(args, list):
        items = (original or {}).get("items") if isinstance(original, dict) else None
        return [strip_injected_nulls(item, items) for item in args]
    if not isinstance(args, dict):
        return args
    properties: dict[str, Schema] = (original or {}).get("properties") or {}
    out: dict[str, Any] = {}
    for key, value in args.items():
        prop = properties.get(key)
        if value is None and not _permits_null(prop):
            continue
        out[key] = strip_injected_nulls(value, prop)
    return out


def _permits_null(schema: Schema | None) -> bool:
    # An unknown property is left alone: the upstream may accept keys this
    # schema does not describe, and dropping one would lose a real argument.
    if schema is None:
        return True
    kind = schema.get("type")
    if kind == "null":
        return True
    if isinstance(kind, list) and "null" in kind:
        return True
    options = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(options, list):
        return any(_permits_null(option) for option in options)
    return False

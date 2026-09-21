"""Each provider's function-calling dialect, in one place.

A format knows three things: how to describe a tool, how to recognise the model
asking for one, and how to hand the answer back. They are grouped per provider
rather than per agent framework on purpose - a framework brings its own MCP
client and never sees any of this.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

from .schema import Schema, inline_refs, strip_injected_nulls, to_strict
from .types import GatewayTool, ToolCall, ToolFormat


@dataclass(frozen=True)
class ConversionWarning:
    tool: str
    reason: str


@dataclass
class Conversion:
    tools: list[Any]
    warnings: list[ConversionWarning] = field(default_factory=list)
    #: The schema each tool had before translation, for the return trip.
    originals: dict[str, Schema] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolResult:
    call: ToolCall
    result: dict[str, Any]


class FormatAdapter:
    def convert(self, tools: list[GatewayTool], strict: bool) -> Conversion:
        raise NotImplementedError

    def extract_calls(self, output: Any) -> list[ToolCall]:
        raise NotImplementedError

    def to_outputs(self, results: list[ToolResult]) -> list[Any]:
        raise NotImplementedError


def restore_arguments(arguments: dict[str, Any], original: Schema | None) -> dict[str, Any]:
    """Undoes whatever the outbound conversion added to the arguments."""
    return strip_injected_nulls(arguments, original)


def _convert_with(
    tools: list[GatewayTool],
    strict: bool,
    shape: Callable[[GatewayTool, Schema, bool], Any],
) -> Conversion:
    conversion = Conversion(tools=[])
    for tool in tools:
        conversion.originals[tool.name] = tool.input_schema
        if not strict:
            conversion.tools.append(shape(tool, inline_refs(tool.input_schema), False))
            continue
        result = to_strict(tool.input_schema)
        if not result.strict:
            conversion.warnings.append(
                ConversionWarning(tool=tool.name, reason=result.reason or "unknown")
            )
        conversion.tools.append(shape(tool, result.schema, result.strict))
    return conversion


class OpenAIResponsesAdapter(FormatAdapter):
    def convert(self, tools: list[GatewayTool], strict: bool) -> Conversion:
        return _convert_with(
            tools,
            strict,
            lambda tool, schema, is_strict: {
                "type": "function",
                "name": tool.name,
                "description": tool.description or "",
                "parameters": schema,
                "strict": is_strict,
            },
        )

    def extract_calls(self, output: Any) -> list[ToolCall]:
        # Accepts the whole response or just its output list, because both are
        # what people have in hand at the call site.
        items = output if isinstance(output, list) else _attr(output, "output") or []
        calls: list[ToolCall] = []
        for item in items:
            if _attr(item, "type") != "function_call":
                continue
            calls.append(
                ToolCall(
                    id=str(_attr(item, "call_id") or _attr(item, "id") or ""),
                    name=str(_attr(item, "name") or ""),
                    arguments=_parse_arguments(_attr(item, "arguments")),
                )
            )
        return calls

    def to_outputs(self, results: list[ToolResult]) -> list[Any]:
        return [
            {
                "type": "function_call_output",
                "call_id": item.call.id,
                "output": result_to_text(item.result),
            }
            for item in results
        ]


class OpenAIChatAdapter(FormatAdapter):
    def convert(self, tools: list[GatewayTool], strict: bool) -> Conversion:
        return _convert_with(
            tools,
            strict,
            lambda tool, schema, is_strict: {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description or "",
                    "parameters": schema,
                    "strict": is_strict,
                },
            },
        )

    def extract_calls(self, output: Any) -> list[ToolCall]:
        if isinstance(output, list):
            raw = output
        else:
            choices = _attr(output, "choices") or []
            message = _attr(choices[0], "message") if choices else None
            raw = (_attr(message, "tool_calls") if message is not None else None) or []
        calls: list[ToolCall] = []
        for item in raw:
            function = _attr(item, "function")
            if function is None:
                continue
            calls.append(
                ToolCall(
                    id=str(_attr(item, "id") or ""),
                    name=str(_attr(function, "name") or ""),
                    arguments=_parse_arguments(_attr(function, "arguments")),
                )
            )
        return calls

    def to_outputs(self, results: list[ToolResult]) -> list[Any]:
        return [
            {
                "role": "tool",
                "tool_call_id": item.call.id,
                "content": result_to_text(item.result),
            }
            for item in results
        ]


class AnthropicMessagesAdapter(FormatAdapter):
    def convert(self, tools: list[GatewayTool], strict: bool) -> Conversion:
        # Anthropic takes plain JSON Schema, so strict has nothing to add here:
        # asking for it would close objects for no gain.
        return _convert_with(
            tools,
            False,
            lambda tool, schema, _strict: {
                "name": tool.name,
                "description": tool.description or "",
                "input_schema": schema,
            },
        )

    def extract_calls(self, output: Any) -> list[ToolCall]:
        content = output if isinstance(output, list) else _attr(output, "content") or []
        calls: list[ToolCall] = []
        for block in content:
            if _attr(block, "type") != "tool_use":
                continue
            calls.append(
                ToolCall(
                    id=str(_attr(block, "id") or ""),
                    name=str(_attr(block, "name") or ""),
                    arguments=dict(_attr(block, "input") or {}),
                )
            )
        return calls

    def to_outputs(self, results: list[ToolResult]) -> list[Any]:
        # No results means the model called nothing, and that is what an empty
        # list says. A message wrapped around no blocks says the opposite - and
        # Anthropic refuses a user message with no content, so the turn a caller
        # reads as "keep going" is the one that cannot be sent.
        if not results:
            return []
        blocks = []
        for item in results:
            block: dict[str, Any] = {
                "type": "tool_result",
                "tool_use_id": item.call.id,
                "content": result_to_text(item.result),
            }
            if item.result.get("isError") is True:
                block["is_error"] = True
            blocks.append(block)
        return [{"role": "user", "content": blocks}]


#: Keywords Gemini's function declarations accept; everything else is dropped.
GEMINI_KEYWORDS = {
    "type",
    "format",
    "description",
    "nullable",
    "enum",
    "properties",
    "required",
    "items",
    "anyOf",
    "minimum",
    "maximum",
}


class GeminiAdapter(FormatAdapter):
    def convert(self, tools: list[GatewayTool], strict: bool) -> Conversion:
        conversion = Conversion(tools=[])
        declarations = []
        for tool in tools:
            conversion.originals[tool.name] = tool.input_schema
            schema, dropped = _gemini_schema(inline_refs(tool.input_schema))
            if dropped:
                conversion.warnings.append(
                    ConversionWarning(
                        tool=tool.name,
                        reason=f"dropped keywords Gemini does not accept: {', '.join(sorted(set(dropped)))}",
                    )
                )
            declarations.append(
                {
                    "name": tool.name,
                    "description": tool.description or "",
                    "parameters": schema,
                }
            )
        conversion.tools = [{"functionDeclarations": declarations}]
        return conversion

    def extract_calls(self, output: Any) -> list[ToolCall]:
        if isinstance(output, list):
            parts = output
        else:
            candidates = _attr(output, "candidates") or []
            content = _attr(candidates[0], "content") if candidates else None
            parts = (_attr(content, "parts") if content is not None else None) or []
        calls: list[ToolCall] = []
        for index, part in enumerate(parts):
            function_call = _attr(part, "functionCall") or _attr(part, "function_call")
            if function_call is None:
                continue
            name = str(_attr(function_call, "name") or "")
            calls.append(
                ToolCall(
                    # Gemini does not give a call an id, so one is made from its
                    # position - enough to pair a result with its call.
                    id=f"{name}:{index}",
                    name=name,
                    arguments=dict(_attr(function_call, "args") or {}),
                )
            )
        return calls

    def to_outputs(self, results: list[ToolResult]) -> list[Any]:
        # Empty means the model called nothing; see AnthropicMessagesAdapter.
        if not results:
            return []
        return [
            {
                "role": "user",
                "parts": [
                    {
                        "functionResponse": {
                            "name": item.call.name,
                            "response": _result_to_response(item.result),
                        }
                    }
                    for item in results
                ],
            }
        ]


_ADAPTERS: dict[ToolFormat, FormatAdapter] = {
    ToolFormat.OPENAI_RESPONSES: OpenAIResponsesAdapter(),
    ToolFormat.OPENAI_CHAT: OpenAIChatAdapter(),
    ToolFormat.ANTHROPIC_MESSAGES: AnthropicMessagesAdapter(),
    ToolFormat.GEMINI: GeminiAdapter(),
}


def adapter_for(tool_format: ToolFormat | str) -> FormatAdapter:
    resolved = ToolFormat(tool_format)
    return _ADAPTERS[resolved]


def _gemini_schema(schema: Schema) -> tuple[Schema, list[str]]:
    dropped: list[str] = []

    def walk_properties(node: Any) -> Any:
        # Inside `properties` the keys are the caller's own property names, not
        # schema keywords, so they are carried across untouched - filtering them
        # would delete the arguments rather than the syntax.
        if not isinstance(node, dict):
            return node
        return {name: walk(value) for name, value in node.items()}

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(item) for item in node]
        if not isinstance(node, dict):
            return node
        out: dict[str, Any] = {}
        for key, value in node.items():
            if key not in GEMINI_KEYWORDS:
                dropped.append(key)
                continue
            if key == "properties":
                out[key] = walk_properties(value)
            elif key in ("required", "enum"):
                out[key] = value
            else:
                out[key] = walk(value)
        return out

    return walk(schema), dropped


def _parse_arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def result_to_text(result: dict[str, Any]) -> str:
    """What the model gets back from a tool.

    A structured result is the one worth giving it, since that is what the tool
    promised in its output schema; the text blocks are the fallback, and the
    whole result is the last resort. A tool that failed still answers here
    rather than raising: MCP puts tool errors in the result precisely so the
    model can read them and correct itself.
    """
    if "structuredContent" in result:
        return json.dumps(result["structuredContent"], separators=(",", ":"))
    content = result.get("content")
    if isinstance(content, list):
        text = "\n".join(
            str(block.get("text", ""))
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
        if text:
            return text
    return json.dumps(result, separators=(",", ":"))


def _result_to_response(result: dict[str, Any]) -> dict[str, Any]:
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        return structured
    return {"result": result_to_text(result)}


def _attr(source: Any, name: str) -> Any:
    """Reads a field off a dict or off a provider SDK's model object."""
    if isinstance(source, dict):
        return source.get(name)
    return getattr(source, name, None)

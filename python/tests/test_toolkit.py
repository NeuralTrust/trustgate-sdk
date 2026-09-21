from __future__ import annotations

import pytest

from trustgate import (
    ConsentRequiredError,
    GatewayTool,
    PolicyBlockedError,
    ToolFormat,
    ToolNotFoundError,
    TrustGate,
)

from .fake_gateway import FakeGateway

BASE = dict(base_url="https://gw.test", api_key="ag_secret", mcp_consumer="acme")

SEARCH = GatewayTool(
    name="notion_search",
    description="Search Notion",
    input_schema={
        "type": "object",
        "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}},
        "required": ["query"],
    },
)


def agent_with(**options):
    gateway = FakeGateway(tools=options.pop("tools", [SEARCH]), **options)
    return TrustGate(**BASE, transport=gateway).connect(), gateway


def test_shapes_a_tool_for_the_responses_api() -> None:
    agent, _ = agent_with()

    toolkit = agent.toolkit(ToolFormat.OPENAI_RESPONSES)

    assert toolkit.tools == [
        {
            "type": "function",
            "name": "notion_search",
            "description": "Search Notion",
            "parameters": SEARCH.input_schema,
            "strict": False,
        }
    ]


def test_nests_it_under_function_for_chat_completions() -> None:
    agent, _ = agent_with()

    tool = agent.toolkit(ToolFormat.OPENAI_CHAT).tools[0]

    assert tool["type"] == "function"
    assert tool["function"]["name"] == "notion_search"


def test_uses_input_schema_for_anthropic() -> None:
    agent, _ = agent_with()

    tool = agent.toolkit(ToolFormat.ANTHROPIC_MESSAGES).tools[0]

    assert tool["name"] == "notion_search"
    assert tool["input_schema"] == SEARCH.input_schema


def test_collects_gemini_declarations_and_says_what_it_dropped() -> None:
    agent, _ = agent_with(
        tools=[
            GatewayTool(
                name="notion_search",
                description="Search Notion",
                input_schema={
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"query": {"type": "string", "pattern": "^.+$"}},
                },
            )
        ]
    )

    toolkit = agent.toolkit(ToolFormat.GEMINI)
    entry = toolkit.tools[0]

    assert len(entry["functionDeclarations"]) == 1
    assert entry["functionDeclarations"][0]["parameters"] == {
        "type": "object",
        "properties": {"query": {"type": "string"}},
    }
    assert "additionalProperties" in toolkit.warnings[0].reason


def test_warns_instead_of_failing_when_a_tool_cannot_be_strict() -> None:
    agent, _ = agent_with(
        tools=[
            GatewayTool(name="open_ended", input_schema={"type": "object", "additionalProperties": True}),
            SEARCH,
        ]
    )

    toolkit = agent.toolkit(ToolFormat.OPENAI_RESPONSES, strict=True)
    by_name = {tool["name"]: tool for tool in toolkit.tools}

    assert [w.tool for w in toolkit.warnings] == ["open_ended"]
    assert by_name["open_ended"]["strict"] is False
    assert by_name["notion_search"]["strict"] is True


def test_runs_the_calls_the_model_asked_for() -> None:
    agent, gateway = agent_with(
        call_results={"notion_search": {"content": [{"type": "text", "text": "found it"}]}}
    )

    outputs = agent.toolkit(ToolFormat.OPENAI_RESPONSES).execute(
        {
            "output": [
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "notion_search",
                    "arguments": '{"query":"runbook"}',
                },
                {"type": "message", "content": []},
            ]
        }
    )

    assert outputs == [
        {"type": "function_call_output", "call_id": "call_1", "output": "found it"}
    ]
    assert gateway.requests[-1].body["params"] == {
        "name": "notion_search",
        "arguments": {"query": "runbook"},
    }


# The nulls strict asked for must not reach a server that never agreed to them,
# so the conversion is undone on the way back.
def test_undoes_the_strict_rewrite_before_calling_the_gateway() -> None:
    agent, gateway = agent_with()

    agent.toolkit(ToolFormat.OPENAI_RESPONSES, strict=True).execute(
        [
            {
                "type": "function_call",
                "call_id": "call_1",
                "name": "notion_search",
                "arguments": '{"query":"runbook","limit":null}',
            }
        ]
    )

    assert gateway.requests[-1].body["params"]["arguments"] == {"query": "runbook"}


def test_prefers_the_structured_result() -> None:
    agent, _ = agent_with(
        call_results={
            "notion_search": {
                "content": [{"type": "text", "text": "ignored"}],
                "structuredContent": {"pages": 2},
            }
        }
    )

    outputs = agent.toolkit(ToolFormat.OPENAI_CHAT).execute(
        [{"id": "call_1", "function": {"name": "notion_search", "arguments": "{}"}}]
    )

    assert outputs[0]["content"] == '{"pages":2}'


def test_answers_anthropic_with_one_user_message_of_tool_results() -> None:
    agent, _ = agent_with()

    outputs = agent.toolkit(ToolFormat.ANTHROPIC_MESSAGES).execute(
        {"content": [{"type": "tool_use", "id": "toolu_1", "name": "notion_search", "input": {}}]}
    )

    assert len(outputs) == 1
    assert outputs[0]["role"] == "user"
    assert outputs[0]["content"][0]["tool_use_id"] == "toolu_1"


# "Nothing to send back" is how a caller knows the model is done, and every
# format has to be able to say it. Anthropic refuses a user message with no
# content, so a wrapper around no results is a turn that cannot be sent - the
# loop reads it as more work and the next request is a 400.
@pytest.mark.parametrize(
    "tool_format, answer",
    [
        (ToolFormat.ANTHROPIC_MESSAGES, {"content": [{"type": "text", "text": "here you go"}]}),
        (ToolFormat.GEMINI, {"candidates": [{"content": {"parts": [{"text": "here you go"}]}}]}),
        (ToolFormat.OPENAI_RESPONSES, {"output": [{"type": "message"}]}),
        (ToolFormat.OPENAI_CHAT, {"choices": [{"message": {"content": "here you go"}}]}),
    ],
)
def test_sends_nothing_back_when_the_model_called_nothing(tool_format, answer) -> None:
    agent, _ = agent_with()

    assert agent.toolkit(tool_format).execute(answer) == []


def test_pairs_a_gemini_call_with_its_answer() -> None:
    agent, _ = agent_with()

    outputs = agent.toolkit(ToolFormat.GEMINI).execute(
        {"candidates": [{"content": {"parts": [{"functionCall": {"name": "notion_search", "args": {}}}]}}]}
    )

    assert outputs[0]["parts"][0]["functionResponse"]["name"] == "notion_search"


def test_hands_back_the_link_when_the_user_has_not_connected() -> None:
    agent, _ = agent_with(
        call_errors={
            "notion_search": {
                "code": -32003,
                "message": "user consent required",
                "data": {
                    "provider": "com.notion/mcp",
                    "connect_url": "https://gw.test/acme/mcp/connect?ticket=t-9",
                    "cause": "no_credential",
                },
            }
        }
    )

    with pytest.raises(ConsentRequiredError) as caught:
        agent.call_tool("notion_search")

    assert caught.value.provider == "com.notion/mcp"
    assert "ticket=t-9" in caught.value.connect_url


def test_separates_a_policy_refusal_from_a_failure() -> None:
    agent, _ = agent_with(
        call_errors={"notion_search": {"code": -32001, "message": 'blocked by policy "pii"'}}
    )

    with pytest.raises(PolicyBlockedError):
        agent.call_tool("notion_search")


# An admin can narrow the toolkit under a running agent; the caller needs to
# know which tool went, not that params were invalid.
def test_names_the_tool_when_it_is_no_longer_served() -> None:
    agent, _ = agent_with(
        call_errors={"notion_search": {"code": -32602, "message": "mcp: tool not found"}}
    )

    with pytest.raises(ToolNotFoundError) as caught:
        agent.call_tool("notion_search")

    assert caught.value.tool == "notion_search"


# The gateway frames its answer as an event stream when it has a surface change
# to announce on the same response.
def test_reads_a_response_framed_as_an_event_stream() -> None:
    agent, _ = agent_with(frame_as_event_stream=True)

    result = agent.call_tool("notion_search")

    assert result["content"][0]["text"] == "called notion_search"

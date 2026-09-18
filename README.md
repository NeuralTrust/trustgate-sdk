# TrustGate SDK

Point an agent at a TrustGate gateway, in TypeScript or Python.

An admin creates an MCP consumer for the agent and decides which tools it may
reach. This SDK is the other half of that: it hands those tools to whatever is
driving the model, and it answers the three questions MCP itself does not
carry — **which actor** a call speaks as, **which credential** it travels with,
and **what to do when an upstream account is not connected**.

```bash
npm install @neuraltrust/trustgate     # TypeScript, Node 18+
pip install trustgate                  # Python 3.10+
```

## Two ways in, and which one you want

The gateway is an MCP server, so an agent framework that brings its own MCP
client needs nothing from this package but a URL and two headers:

```ts
const agent = await tg.connect({ requires: ['notion_search'] })
new MCPServerStreamableHttp({ url: agent.mcp.url, headers: agent.mcp.headers })
```

That covers the OpenAI Agents SDK, the Claude Agent SDK, LangChain, Mastra and
anything else with an MCP client — no adapter per framework, because the
framework already is one.

When you call a model provider's API directly there is no MCP client anywhere
in the picture, so the SDK lists the tools, translates them into that
provider's function-calling dialect, and runs the calls:

```ts
const { tools, execute } = agent.toolkit(ToolFormat.OpenAIResponses)

let res = await openai.responses.create({ model: 'gpt-5.2', tools, input })
while (res.output.some((o) => o.type === 'function_call')) {
  res = await openai.responses.create({
    model: 'gpt-5.2',
    tools,
    previous_response_id: res.id,
    input: await execute(res.output),
  })
}
```

Every one of those calls still goes through the gateway, so policy, audit and
per-user credentials stay where they were. Your process only decides *whether*
to make the call.

`ToolFormat` names providers, not frameworks — `OpenAIResponses`, `OpenAIChat`,
`AnthropicMessages`, `Gemini` — because translating is only ever needed on that
path.

## The LLM plane

If the gateway also fronts your models, the same key configures the provider's
own client. Nothing is wrapped: wrapping would mean chasing every change
OpenAI and Anthropic make, and breaking streaming on the way.

```ts
const openai = new OpenAI({ baseURL: tg.llm.baseUrl, apiKey: tg.llm.apiKey })
```

Models and tools, one key, both governed.

## What `connect()` proves before anything runs

1. **Which actor the consumer is.** An application that acts as itself, or one
   that acts for its own end users. The consumer decides this, not your code,
   so the SDK reads it off the gateway and hands back the matching handle.
2. **That the tools you need are there.** The toolkit belongs to an admin and
   can be narrowed without warning. `requires` turns that into a refusal at
   startup instead of a failure mid-conversation.
3. **That the accounts are signed in** — for an application acting as itself
   only. There is no runtime remedy for a missing account in a batch: nobody
   is there to open a connect link once it is running.

```python
try:
    agent = tg.connect(requires=["notion_search", "linear_create_issue"])
except MissingToolsError as e:
    sys.exit(f"the consumer is missing {e.missing}; ask your admin")
except UpstreamNotConnectedError as e:
    sys.exit(f"nobody has signed in to {e.providers}; open {e.connect_url}")
```

## Agents that act for their users

When the consumer identifies its own end users, `connect()` returns a factory
rather than a surface: there is no "itself" to act as, and every call belongs
to one named user.

```ts
const handle = await tg.connect()
const alice = handle.forEndUser('user_123')

try {
  await alice.toolkit(ToolFormat.OpenAIResponses).execute(response.output)
} catch (error) {
  if (error instanceof ConsentRequiredError) {
    reply(`I need access to ${error.provider}: ${error.connectUrl}`)
  }
}
```

The link arrives inside the error, because that is where the gateway mints it.
`alice.connections()` and `alice.connectLink()` do the same thing ahead of
time, when you would rather ask than fail.

## Reading the docs for your language

- [`typescript/`](typescript) — `@neuraltrust/trustgate`
- [`python/`](python) — `trustgate`

Both track the same gateway contract and the same behaviour; the tests in each
are written against the same cases.

## Requirements

A TrustGate gateway that serves the application-actor form of
`GET /{slug}/connections`. The SDK uses it to tell the two actors apart, and
says so plainly if the gateway predates it.

## License

Apache 2.0.

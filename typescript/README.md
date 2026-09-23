# @neuraltrust/trustgate

[![npm](https://img.shields.io/npm/v/%40neuraltrust%2Ftrustgate)](https://www.npmjs.com/package/@neuraltrust/trustgate)
[Documentation](https://docs.neuraltrust.ai/sdks/trustgate/overview) · [Python package](https://pypi.org/project/trustgate-sdk/) · [GitHub](https://github.com/NeuralTrust/trustgate-sdk)

The TrustGate SDK for TypeScript. Node 22+, no runtime dependencies. ESM only:
import it, or `require()` it from Node 22.12.

```bash
npm install @neuraltrust/trustgate
```

## Setup

```ts
import { TrustGate, ToolFormat } from '@neuraltrust/trustgate'

const tg = new TrustGate()   // TRUSTGATE_API_KEY
```

The key is the whole configuration, or nothing if it is in the environment.
The gateway it belongs to, and the applications behind it, are asked for:
`tg.identity()` asks once and remembers it. Set `TRUSTGATE_URL` (or `baseUrl`)
only for a Hybrid gateway, to the MCP host its own data plane is published on:
the NeuralTrust cloud does not serve that gateway.

```ts
const { gateway, key, consumers } = await tg.identity()
// key: { name: 'prod', expiresAt: Date | undefined }   — undefined means never
// consumers:
// [{ slug: 'support-agent', type: 'MCP', url: 'https://…/support-agent/mcp',
//    upstreams: [{ server: 'Notion', account: 'shared', connected: true }] },
//  { slug: 'support-llm',   type: 'LLM', url: 'https://…/support-llm/v1' }]
```

`key.expiresAt` is the 401 you would otherwise meet mid-run, and `upstreams`
is the refusal you would otherwise meet on the first tool call — both answered
before anything starts.

`mcpConsumer` and `llmConsumer` (or `TRUSTGATE_MCP_CONSUMER` /
`TRUSTGATE_LLM_CONSUMER`) are only needed when a key reaches two applications on
the same plane — the SDK names them and refuses rather than guessing.

## An agent that acts as the application

```ts
const agent = await tg.connect({ requires: ['search'] })

agent.mcp                                   // { url, headers } for a framework
await tg.llm()                              // baseUrl for OpenAI, anthropicBaseUrl for Anthropic
agent.toolkit(ToolFormat.OpenAIResponses)   // { tools, execute, warnings }
await agent.callTool('search', { query: 'runbook' })
await agent.refresh()                       // re-read the toolkit
agent.connections                           // its own upstream accounts
```

The gateway serves a tool under the server it came from — Notion's `search` as
`notion_search` — so two servers with a `search` stay apart. That prefix is the
gateway's, so `requires` and `callTool` take the name the server itself gave the
tool and add it; naming a tool two of your servers serve is the one case they
ask instead.

## An agent acting for one of its users

```ts
const alice = await tg.forEndUser('user_123')
// or, from an agent you already have — no round trip, same toolkit:
const bob = agent.forEndUser('user_456')

await alice.connections()
await alice.connectLink('com.notion/mcp')
alice.toolkit(ToolFormat.AnthropicMessages)
```

Both handles work on the same application and the same key: who a call runs as
comes from the call, not from anything configured on the application. Each user
needs their own handle because the MCP endpoint fixes its headers when a client
connects, and the user travels in one.

The name is yours to choose and the gateway namespaces it, so two applications
naming `user_123` never reach the same account.

## The provider's types

```ts
const { tools, execute } = agent.toolkit<
  OpenAI.Responses.Tool,
  OpenAI.Responses.ResponseInputItem
>(ToolFormat.OpenAIResponses)
```

`toolkit<Tool, Output>()` names the two types the provider cares about: what
`tools` is, and what `execute()` hands back to it. Both default to `unknown`,
so naming them is what lets `tools` go straight into `openai.responses.create`
without a cast. The SDK depends on no provider package — the types come from
yours.

`tools` and `execute` are safe to destructure; the executor stays bound to the
format it was made with.

## Strict mode

```ts
const { tools, warnings } = agent.toolkit(ToolFormat.OpenAIResponses, { strict: true })
```

Strict buys a guarantee — the model cannot invent an argument — by closing
every object, naming every property as required, and letting the optional ones
accept `null`. Some schemas cannot be said that way (arbitrary keys, `allOf`,
`prefixItems`, an unresolvable `$ref`); those are emitted unchanged and listed
in `warnings`, because a tool the model calls imperfectly beats one it cannot
call.

`execute()` undoes the rewrite before the call reaches the gateway: the nulls
strict asked for are stripped unless the tool's own schema accepts them.

## Errors

| Class | When |
|---|---|
| `MissingToolsError` | `requires` names a tool the application does not serve |
| `UpstreamNotConnectedError` | a server the application calls has no account behind it; `servers` names them and the message says who connects it |
| `ConsentRequiredError` | an end user has not connected; carries `connectUrl` |
| `PolicyBlockedError` | a gateway policy refused the call |
| `ToolNotFoundError` | the tool left the toolkit under a running agent |
| `PlaneUnavailableError` | the key reaches no application on that plane |
| `AuthenticationError`, `RateLimitedError`, `ServiceUnavailableError`, `TrustGateServerError` | as named |

## Documentation

The full guide lives at [docs.neuraltrust.ai](https://docs.neuraltrust.ai/sdks/trustgate/overview):

| Page | What it covers |
|---|---|
| [Quickstart](https://docs.neuraltrust.ai/sdks/trustgate/overview) | Install, one key, `connect()`'s startup check, `identity()` |
| [Tools](https://docs.neuraltrust.ai/sdks/trustgate/tools) | The MCP endpoint for a framework, or toolkits for a provider's API |
| [Acting for end users](https://docs.neuraltrust.ai/sdks/trustgate/end-users) | Per-user accounts, consent errors, connect links |
| [Models](https://docs.neuraltrust.ai/sdks/trustgate/models) | A provider's own client pointed at the LLM plane |
| [Configuration](https://docs.neuraltrust.ai/sdks/trustgate/configuration) | Every option and environment variable, Hybrid gateways, regions |
| [Errors](https://docs.neuraltrust.ai/sdks/trustgate/errors) | Every failure, and whose it is to fix |

The same SDK for Python: [`trustgate-sdk` on PyPI](https://pypi.org/project/trustgate-sdk/). Source,
examples and issues: [github.com/NeuralTrust/trustgate-sdk](https://github.com/NeuralTrust/trustgate-sdk).

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

[CONTRIBUTING.md](https://github.com/NeuralTrust/trustgate-sdk/blob/main/CONTRIBUTING.md) has every check CI runs.

# @neuraltrust/trustgate

The TrustGate SDK for TypeScript. Node 18+, ESM, no runtime dependencies.

```bash
npm install @neuraltrust/trustgate
```

## Setup

```ts
import { TrustGate, ToolFormat } from '@neuraltrust/trustgate'

const tg = new TrustGate()   // TRUSTGATE_URL + TRUSTGATE_API_KEY
```

Two values, or none if they are in the environment. The consumers behind the
key are asked for: `tg.identity()` reads `GET /whoami` once and remembers it.

```ts
const { gateway, consumers } = await tg.identity()
// [{ slug: 'support-agent', type: 'MCP', url: 'https://…/support-agent/mcp', actsForUsers: false },
//  { slug: 'support-llm',   type: 'LLM', url: 'https://…/support-llm/v1' }]
```

`mcpConsumer` and `llmConsumer` (or `TRUSTGATE_MCP_CONSUMER` /
`TRUSTGATE_LLM_CONSUMER`) are only needed when a key reaches two consumers of
the same plane — the SDK names them and refuses rather than guessing.

## An agent that acts as itself

```ts
const agent = await tg.connect({ requires: ['notion_search'] })

agent.mcp                                   // { url, headers } for a framework
await tg.llm()                              // { baseUrl, apiKey } for OpenAI/Anthropic
agent.toolkit(ToolFormat.OpenAIResponses)   // { tools, execute, warnings }
await agent.callTool('notion_search', { query: 'runbook' })
await agent.refresh()                       // re-read the toolkit
agent.connections                           // its own upstream accounts
```

## An agent that acts for its users

```ts
const handle = await tg.connect()           // EndUserAgentFactory
const alice = await handle.forEndUser('user_123')

await alice.connections()
await alice.connectLink('com.notion/mcp')
alice.toolkit(ToolFormat.AnthropicMessages)
```

Each user needs their own handle: the MCP endpoint fixes its headers when a
client connects, and the user travels in one. `forEndUser` awaits because the
toolkit is read here — such an application has no surface of its own to read it
from, so the first named user reads it and the rest share it.

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
| `MissingToolsError` | `requires` names a tool the consumer does not serve |
| `UpstreamNotConnectedError` | the application's own accounts are not signed in |
| `ConsentRequiredError` | an end user has not connected; carries `connectUrl` |
| `PolicyBlockedError` | a gateway policy refused the call |
| `ToolNotFoundError` | the tool left the toolkit under a running agent |
| `AppActorUnavailableError` / `EndUserActorUnavailableError` | wrong actor for this consumer |
| `PlaneUnavailableError` | the key reaches no consumer of that plane |
| `AuthenticationError`, `RateLimitedError`, `ServiceUnavailableError`, `TrustGateServerError` | as named |

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

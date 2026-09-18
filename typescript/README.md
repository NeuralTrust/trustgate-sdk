# @neuraltrust/trustgate

The TrustGate SDK for TypeScript. Node 18+, ESM, no runtime dependencies.

```bash
npm install @neuraltrust/trustgate
```

## Setup

```ts
import { TrustGate, ToolFormat } from '@neuraltrust/trustgate'

const tg = new TrustGate({
  baseUrl: process.env.TRUSTGATE_URL,        // https://gw.acme.ai
  apiKey: process.env.TRUSTGATE_API_KEY,     // ag_…
  mcpConsumer: process.env.TRUSTGATE_MCP_CONSUMER,
  llmConsumer: process.env.TRUSTGATE_LLM_CONSUMER, // optional
})
```

Every field falls back to the environment variable shown. The MCP consumer
carries the tools; the LLM consumer fronts the models. They are different
consumers because a consumer has one type — the same API key can be attached
to both.

## An agent that acts as itself

```ts
const agent = await tg.connect({ requires: ['notion_search'] })

agent.mcp                                   // { url, headers } for a framework
agent.toolkit(ToolFormat.OpenAIResponses)   // { tools, execute, warnings }
await agent.callTool('notion_search', { query: 'runbook' })
await agent.refresh()                       // re-read the toolkit
agent.connections                           // its own upstream accounts
```

## An agent that acts for its users

```ts
const handle = await tg.connect()           // EndUserAgentFactory
const alice = handle.forEndUser('user_123')

await alice.connections()
await alice.connectLink('com.notion/mcp')
alice.toolkit(ToolFormat.AnthropicMessages)
```

Each user needs their own handle: the MCP endpoint fixes its headers when a
client connects, and the user travels in one.

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
| `AuthenticationError`, `RateLimitedError`, `ServiceUnavailableError`, `TrustGateServerError` | as named |

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

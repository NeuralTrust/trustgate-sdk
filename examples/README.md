# Examples

Runnable programs in both languages. Each one is a shape you actually build,
not a fragment: the application acting as itself, the application acting for
its own end users, and a framework that brings its own MCP client.

Nothing here is checked in with a credential. Every example reads the same two
values — your gateway and one API key — from a `.env` you copy from the
`.env.example` beside it, and says which one is missing if you skip it.

| | What it shows |
|---|---|
| `python/whoami.py`, `typescript/whoami.ts` | What one key reaches, and which of these examples fits it — run this first when something is off |
| `python/batch.py` | A nightly triage run: a model judges each row with the whole toolkit to look things up with, and everything that could stop the job is checked before the first one |
| `python/end_user_agent.py` | An assistant that names one of its users per call, and turns "not connected" into a link to show them |
| `python/framework_mcp.py` | The same application handed to a framework that brings its own MCP client — no tool list, no execution loop |
| `typescript/openai-responses.ts` | Tools translated for the Responses API and run back through the gateway — no MCP client in sight |
| `typescript/end-user-agent.ts` | The same shape as `end_user_agent.py`, against the Responses API |
| `typescript/framework-mcp.ts` | The same application handed to a framework that brings its own MCP client |

There are two ways to use an application's tools, and both are here in both
languages.
**Translate the tools** when you call a model provider's API directly and there
is no MCP client anywhere — the SDK lists them, converts them to that provider's
dialect and runs the calls (`batch.py`, `end_user_agent.py`,
`openai-responses.ts`, `end-user-agent.ts`). **Hand over the endpoint** when your
framework already speaks MCP — then all the SDK contributes is a checked URL and
its headers, and the framework lists and calls for itself (`framework_mcp.py`,
`framework-mcp.ts`). The second is the shorter path when you already have a
framework; the first is the only one when you do not.

The TypeScript examples send their model calls through the gateway too, so
neither file holds an OpenAI key, and so does `batch.py` when the key it runs on
also reaches models — it falls back to `ANTHROPIC_API_KEY` when it does not.
`end_user_agent.py` always calls Anthropic directly, which is the other half of
the picture: a model call the gateway never sees.

## Where the values come from

- `TRUSTGATE_API_KEY` — the application's own key, issued when the application
  is created and shown once; further keys are issued from its Auth tab.
- `TRUSTGATE_URL` — optional. Unset, the SDK asks
  `https://agentgateway-mcp.neuraltrust.ai`, which finds the gateway from the
  key. Set it to `https://agentgateway-mcp.dev.neuraltrust.ai` for NeuralTrust's
  development environment, or, for a Hybrid gateway, to the MCP host its own
  data plane is published on: the NeuralTrust cloud does not serve that gateway.

That is all the SDK needs: it asks the gateway which applications the key
reaches, so no slug and no second URL travel into your configuration.

## Running them

Both projects take the SDK from this repository rather than from a registry,
and both are wired so a change in it reaches the next run: `uv` installs the
Python SDK editable, and the npm scripts rebuild the TypeScript one first. If an
example ever behaves like a version you have already changed, that is what went
wrong — `uv sync --reinstall-package trustgate-sdk` forces it.

```sh
# Python — uv installs the SDK editable from ../../python
cd python
cp .env.example .env      # then fill it in
uv run whoami.py
uv run batch.py
uv run end_user_agent.py user_123 "what changed in the runbook this week?"
uv run framework_mcp.py
```

An application acting as itself is `batch.py`; one naming its own users is
`end_user_agent.py`. Both run on the same kind of key: who a call runs as comes
from the call, not from a setting. If `batch.py` stops because a server keeps an
account per user, its message says so and gives the line that names the person
instead — which is the shape `end_user_agent.py` shows. `whoami.py` prints, per
server, whether an account is connected and who connects it.

```sh
# TypeScript — npm links the SDK from ../../typescript and rebuilds it per run
cd typescript
cp .env.example .env      # then fill it in
npm install
npm run whoami
npm run openai
npm run end-user -- user_123 "what changed in the runbook this week?"
npm run framework
```

Both projects build the SDK from this repository rather than from a registry,
because it is not published yet. The one line to change when it is:
`[tool.uv.sources]` in `python/pyproject.toml`, and the
`@neuraltrust/trustgate` entry in `typescript/package.json`.

The tool names in each example (`notion_search`, `linear_create_issue`) are
placeholders too — replace them with tools your application carries, as its
General tab lists them. An example that asks for a tool the application does
not have refuses at startup and names it, which is the behaviour being shown.

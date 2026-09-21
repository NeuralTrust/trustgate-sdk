# Examples

Four runnable programs, two per language. Each one is a shape you actually
build, not a fragment: the application acting as itself, and the application
acting for its own end users.

Nothing here is checked in with a credential. Every example reads the same two
values — your gateway and one API key — from a `.env` you copy from the
`.env.example` beside it, and says which one is missing if you skip it.

| | What it shows |
|---|---|
| `python/whoami.py` | What one key reaches, and which of these examples fits it — run this first when something is off |
| `python/batch.py` | A nightly triage run: a model judges each row with the whole toolkit to look things up with, and everything that could stop the job is checked before the first one |
| `python/end_user_agent.py` | An assistant that names one of its users per call, and turns "not connected" into a link to show them |
| `typescript/openai-responses.ts` | Tools translated for the Responses API and run back through the gateway — no MCP client in sight |
| `typescript/framework-mcp.ts` | The same consumer handed to a framework that brings its own MCP client |

The TypeScript examples send their model calls through the gateway too, so
neither file holds an OpenAI key, and so does `batch.py` when the key it runs on
reaches an LLM consumer — it falls back to `ANTHROPIC_API_KEY` when it does not.
`end_user_agent.py` always calls Anthropic directly, which is the other half of
the picture: a model call the gateway never sees.

## Where the values come from

- `TRUSTGATE_URL` — your gateway's base URL, with no consumer path. The Connect
  tab of any application shows it.
- `TRUSTGATE_API_KEY` — the application's own key, issued from the
  Authentication block of its General tab and shown once.

That is all the SDK needs: it asks the gateway which consumers the key reaches,
so no slug and no second URL travel into your configuration.

## Running them

```sh
# Python — uv builds the SDK from ../../python
cd python
cp .env.example .env      # then fill it in
uv run whoami.py
uv run batch.py
uv run end_user_agent.py user_123 "what changed in the runbook this week?"
```

An application that acts as itself is `batch.py`; one that names its own users
is `end_user_agent.py`. The consumer decides which, not the caller, and
`whoami.py` prints the answer — so "this application acts for its own end
users" from `batch.py` means the key is that other kind, whatever the console
tab you were last looking at.

```sh
# TypeScript — npm links the SDK from ../../typescript
cd typescript
cp .env.example .env      # then fill it in
npm install
npm run openai
npm run framework
```

Both projects build the SDK from this repository rather than from a registry,
because it is not published yet. The one line to change when it is:
`[tool.uv.sources]` in `python/pyproject.toml`, and the
`@neuraltrust/trustgate` entry in `typescript/package.json`.

The tool names in each example (`notion_search`, `linear_create_issue`) are
placeholders too — replace them with tools your application carries, as its
Routing tab lists them. An example that asks for a tool the application does
not have refuses at startup and names it, which is the behaviour being shown.

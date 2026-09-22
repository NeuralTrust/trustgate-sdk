# Contributing

Two SDKs live here, with the same surface in each language:

| Directory | Package | Toolchain |
|---|---|---|
| `typescript/` | `@neuraltrust/trustgate` on npm | Node 18+, npm |
| `python/` | `trustgate-sdk` on PyPI | Python 3.10+, [uv](https://docs.astral.sh/uv/) |
| `examples/` | not published | one runnable program per use case, in both languages |

A change to one SDK's behaviour belongs in the other in the same pull request,
with a test on each side, so the two never drift.

## Running the checks

These are the commands CI runs.

```bash
# TypeScript
cd typescript
npm ci
npm run typecheck
npm test
npm run build

# Python
cd python
uv sync --locked --extra dev
uv run pytest
uvx ruff check --config pyproject.toml src tests ../examples/python
uvx ruff format --check --config pyproject.toml src tests ../examples/python
```

`uvx ruff format --config pyproject.toml src tests ../examples/python` applies
the formatting.

Neither SDK depends on anything at runtime, and that is deliberate: a new
runtime dependency needs a reason in the pull request.

## Releasing

Maintainers only. Both packages ship together under one version.

1. Set the same version in `typescript/package.json`, `python/pyproject.toml`
   and `__version__` in `python/src/trustgate/__init__.py`. CI fails if they
   disagree.
2. Merge that to `main`.
3. Tag the merge commit `vX.Y.Z` and push the tag. The **Release** workflow
   checks the tag against the three versions, builds and tests both packages,
   publishes them, and creates the GitHub release with the artifacts attached.

The workflow publishes through trusted publishing, so no registry token is
stored in this repository. That needs setting up once:

- **PyPI**: add a trusted publisher for the project `trustgate-sdk` — owner
  `NeuralTrust`, repository `trustgate-sdk`, workflow `release.yml`,
  environment `pypi`. Before the first release this is a *pending* publisher.
- **npm**: on the `@neuraltrust/trustgate` package, add a trusted publisher
  for the same repository and workflow, environment `npm`. The package has to
  exist before a trusted publisher can be added to it, so the very first
  version is published by hand (`npm publish --access public` from
  `typescript/`). Tagging that version afterwards is safe: the workflow skips a
  version that is already on a registry.
- **GitHub**: create the `pypi` and `npm` environments under *Settings →
  Environments*, with required reviewers if a release should wait for an
  approval.

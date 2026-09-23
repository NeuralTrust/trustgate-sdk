# Contributing

Two SDKs live here, with the same surface in each language:

| Directory | Package | Toolchain |
|---|---|---|
| `typescript/` | `@neuraltrust/trustgate` on npm | Node 22+, npm |
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

Maintainers only. Both packages ship together under one version. `scripts/release.sh`
writes the three places CI checks (`typescript/package.json`,
`python/pyproject.toml`, `__version__` in `python/src/trustgate/__init__.py`)
and the lockfiles that follow them.

```bash
scripts/release.sh 0.2.0              # bump the files
scripts/release.sh 0.2.0 --tag        # bump, commit, tag v0.2.0
scripts/release.sh tag --push         # tag whatever is already on the branch, push it
```

1. Bump (a PR is fine). Merge that to `main` if the bump was not already there.
2. On the commit you want to ship: `scripts/release.sh tag --push`. The
   **Release** workflow checks the tag against the three versions, builds and
   tests both packages, publishes them, and creates the GitHub release with the
   artifacts attached.

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

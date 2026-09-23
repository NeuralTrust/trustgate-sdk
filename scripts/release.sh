#!/usr/bin/env bash
# Bump the three package versions, or tag the current one.
#
# Both packages ship together. CI and the Release workflow refuse a tag that
# does not match typescript/package.json, python/pyproject.toml and
# python/src/trustgate/__init__.py — this is the step that keeps them the same.
#
#   scripts/release.sh 0.2.0              # write the files, stop
#   scripts/release.sh 0.2.0 --tag        # write, commit, tag v0.2.0
#   scripts/release.sh 0.2.0 --tag --push # then push the commit and the tag
#   scripts/release.sh tag --push         # tag whatever is already in the files
#

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Bump the three package versions, or tag the current one.

  scripts/release.sh 0.2.0              write the files, stop
  scripts/release.sh 0.2.0 --tag        write, commit, tag v0.2.0
  scripts/release.sh 0.2.0 --tag --push then push the commit and the tag
  scripts/release.sh tag --push         tag whatever is already in the files

CI and the Release workflow refuse a tag that does not match
typescript/package.json, python/pyproject.toml and
python/src/trustgate/__init__.py.
EOF
  exit 2
}

VERSION=""
DO_TAG=0
DO_PUSH=0
TAG_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage ;;
    --tag) DO_TAG=1 ;;
    --push)
      DO_TAG=1
      DO_PUSH=1
      ;;
    tag) TAG_ONLY=1 ;;
    -*)
      echo "unknown flag: $1" >&2
      usage
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        echo "unexpected argument: $1" >&2
        usage
      fi
      VERSION="$1"
      ;;
  esac
  shift
done

if [[ "$TAG_ONLY" -eq 1 && -n "$VERSION" ]]; then
  echo "tag uses the version already in the files; do not pass one" >&2
  exit 2
fi
if [[ "$TAG_ONLY" -eq 0 && -z "$VERSION" ]]; then
  usage
fi
if [[ "$TAG_ONLY" -eq 1 ]]; then
  DO_TAG=1
fi

semver='^[0-9]+\.[0-9]+\.[0-9]+$'

current_versions() {
  npm_version=$(jq -r .version typescript/package.json)
  py_version=$(sed -n 's/^version = "\(.*\)"$/\1/p' python/pyproject.toml)
  py_runtime=$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' python/src/trustgate/__init__.py)
}

require_agreement() {
  current_versions
  if [[ "$npm_version" != "$py_version" || "$py_version" != "$py_runtime" ]]; then
    echo "versions disagree: npm=$npm_version pyproject=$py_version __version__=$py_runtime" >&2
    exit 1
  fi
}

bump() {
  local version="$1"
  if [[ ! "$version" =~ $semver ]]; then
    echo "version must be X.Y.Z, got: $version" >&2
    exit 2
  fi
  require_agreement
  if [[ "$npm_version" == "$version" ]]; then
    echo "already at $version" >&2
    exit 1
  fi

  python3 - "$version" <<'PY'
from pathlib import Path
import re
import sys

version = sys.argv[1]


def replace_one(path: Path, pattern: str, replacement: str) -> None:
    text = path.read_text(encoding="utf-8")
    new, n = re.subn(pattern, replacement, text, count=1)
    if n != 1:
        sys.exit(f"could not bump {path}")
    path.write_text(new, encoding="utf-8")


replace_one(
    Path("python/pyproject.toml"),
    r'(?m)^version = "[^"]+"',
    f'version = "{version}"',
)
replace_one(
    Path("python/src/trustgate/__init__.py"),
    r'(?m)^__version__ = "[^"]+"',
    f'__version__ = "{version}"',
)
PY

  (cd typescript && npm version "$version" --no-git-tag-version --allow-same-version >/dev/null)
  (cd python && uv lock)

  require_agreement
  if [[ "$npm_version" != "$version" ]]; then
    echo "bump left versions at $npm_version, expected $version" >&2
    exit 1
  fi
  echo "bumped $npm_version → $version"
}

create_tag() {
  require_agreement
  if [[ ! "$npm_version" =~ $semver ]]; then
    echo "refusing to tag non-release version $npm_version" >&2
    exit 1
  fi
  local tag="v$npm_version"
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo "tag $tag already exists" >&2
    exit 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    git add \
      typescript/package.json \
      typescript/package-lock.json \
      python/pyproject.toml \
      python/uv.lock \
      python/src/trustgate/__init__.py
    git commit -m "chore: release $npm_version"
  fi

  git tag -a "$tag" -m "v$npm_version"
  echo "tagged $tag"
}

push_tag() {
  require_agreement
  local tag="v$npm_version"
  local branch
  branch="$(git branch --show-current)"
  git push origin "$branch"
  git push origin "$tag"
  echo "pushed $branch and $tag — the Release workflow publishes both packages"
}

# A files-only bump leaves the tree dirty on purpose so you can review it.
# Tagging then commits those five paths. Anything else in the way is a no.
if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "$TAG_ONLY" -eq 0 ]]; then
    echo "working tree is dirty; commit or stash first" >&2
    exit 1
  fi
  unexpected=0
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    case "$path" in
      typescript/package.json | typescript/package-lock.json | python/pyproject.toml | python/uv.lock | python/src/trustgate/__init__.py) ;;
      *)
        echo "unexpected dirty file: $path" >&2
        unexpected=1
        ;;
    esac
  done < <(git status --porcelain | cut -c4-)
  if [[ "$unexpected" -eq 1 ]]; then
    echo "commit or stash unrelated changes before tagging" >&2
    exit 1
  fi
fi

if [[ "$TAG_ONLY" -eq 0 ]]; then
  bump "$VERSION"
fi

if [[ "$DO_TAG" -eq 1 ]]; then
  create_tag
fi

if [[ "$DO_PUSH" -eq 1 ]]; then
  push_tag
elif [[ "$DO_TAG" -eq 0 ]]; then
  echo "files only. commit that, merge to main, then: scripts/release.sh tag --push"
fi

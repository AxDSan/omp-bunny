#!/usr/bin/env bash
# Install /bunny into omp: puts src/bunny.ts where omp auto-loads extensions.
#
#   ./install.sh              symlink  <agent dir>/extensions/bunny.ts -> this checkout (default)
#   ./install.sh --copy       copy the file instead of linking
#   ./install.sh --force      replace a different bunny.ts that is already there (kept as bunny.ts.bak)
#   ./install.sh --uninstall  remove what this script installed; your bunny.json is never touched
#
# <agent dir> is $PI_CODING_AGENT_DIR, or ~/.omp/agent. Safe to re-run.
set -euo pipefail

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; }

mode=link force=0 action=install
for arg in "$@"; do
  case "$arg" in
    --copy) mode=copy ;;
    --force) force=1 ;;
    --uninstall) action=uninstall ;;
    -h | --help) usage; exit 0 ;;
    *) echo "install.sh: unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
src="$repo/src/bunny.ts"
agent_dir=${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}
ext_dir="$agent_dir/extensions"
dest="$ext_dir/bunny.ts"
# First line of src/bunny.ts: how a copy is recognised as ours, even after the source moved on.
signature=$(head -n 1 "$src")

[ -f "$src" ] || { echo "install.sh: $src not found" >&2; exit 1; }

is_our_link() { [ -L "$dest" ] && [ "$(readlink -f "$dest")" = "$src" ]; }
is_our_copy() { [ -f "$dest" ] && [ ! -L "$dest" ] && [ "$(head -n 1 "$dest")" = "$signature" ]; }

if [ "$action" = uninstall ]; then
  if is_our_link || is_our_copy; then
    rm -- "$dest"
    echo "removed $dest"
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "left $dest alone: it was not installed by this checkout"
  else
    echo "nothing to remove: $dest does not exist"
  fi
  echo "your bunny ($agent_dir/bunny.json) was not touched"
  exit 0
fi

mkdir -p "$ext_dir"

if [ -d "$dest" ] && [ ! -L "$dest" ]; then
  echo "install.sh: $dest is a directory; refusing to touch it" >&2
  exit 1
fi

# Already in the requested state?
if [ "$mode" = link ] && is_our_link; then
  echo "already installed: $dest -> $src"
  exit 0
fi
if [ "$mode" = copy ] && [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$src" "$dest"; then
  echo "already installed: $dest is up to date"
  exit 0
fi

# Something else is in the way. Ours (older copy, or a link into this checkout) is replaced silently;
# anything else needs --force and is kept as bunny.ts.bak.
if [ -e "$dest" ] || [ -L "$dest" ]; then
  if is_our_link || is_our_copy || { [ -f "$dest" ] && cmp -s "$src" "$dest"; }; then
    :
  elif [ "$force" = 1 ]; then
    cp -P -- "$dest" "$dest.bak"
    echo "kept the previous file as $dest.bak"
  else
    echo "install.sh: $dest already exists and is not this bunny; re-run with --force to replace it" >&2
    exit 1
  fi
fi

# Build the new entry under a temporary name in the same directory, then rename over the target, so
# omp never sees a missing or half-written extension.
tmp=$(mktemp -u "$ext_dir/.bunny.ts.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
if [ "$mode" = link ]; then
  ln -s -- "$src" "$tmp"
else
  cp -- "$src" "$tmp"
fi
mv -T -- "$tmp" "$dest"
trap - EXIT

if [ "$mode" = link ]; then
  echo "installed: $dest -> $src"
else
  echo "installed: $dest (copy; re-run after pulling to update)"
fi
echo "restart omp, then run /bunny"

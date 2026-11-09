#!/usr/bin/env bash
# Swap a verified build; never build into the directory served by next start.
# Usage: bash deploy/swap-build.sh LIVE_CHECKOUT BUILD_WORKTREE NEW_BACKUP_DIR
set -euo pipefail

if [[ $# != 3 ]]; then
  echo "Usage: $0 LIVE_CHECKOUT BUILD_WORKTREE NEW_BACKUP_DIR" >&2
  exit 2
fi
live=$(realpath "$1")
build=$(realpath "$2")
backup=$(realpath -m "$3")
test "$live" != "$build"
test ! -e "$backup"
test "$(git -C "$live" branch --show-current)" = selfhost
test -z "$(git -C "$live" status --porcelain)"
test -z "$(git -C "$build" status --porcelain)"
test -f "$live/.next/BUILD_ID"
test -f "$build/.next/BUILD_ID"
old=$(git -C "$live" rev-parse HEAD)
rev=$(git -C "$build" rev-parse HEAD)
git -C "$live" merge-base --is-ancestor "$old" "$rev"
deps_changed=0
if ! git -C "$live" diff --quiet "$old" "$rev" -- package.json package-lock.json; then
  deps_changed=1
fi
mkdir -p "$backup"
printf '%s\n' "$old" > "$backup/revision"
printf '%s\n' "$rev" > "$backup/target-revision"
swapping=0
deps_moved=0

cleanup() {
  git -C "$live" worktree remove "$build" || echo "Build worktree retained for inspection: $build" >&2
}

restore() {
  local code=$?
  trap - ERR
  set +e
  if [[ $swapping == 1 ]]; then
    echo "Swap failed; restoring $old from $backup" >&2
    # If restoration itself fails, stop here rather than serve mismatched files.
    systemctl --user stop gloss.service || exit 1
    if [[ -d "$backup/next" ]]; then
      if [[ -e "$live/.next" ]]; then
        mv "$live/.next" "$backup/failed-next" || exit 1
      fi
    fi
    git -C "$live" reset --hard "$(< "$backup/revision")" || exit 1
    if [[ -d "$backup/next" ]]; then
      mv "$backup/next" "$live/.next" || exit 1
    fi
    if [[ $deps_moved == 1 ]]; then
      if [[ -e "$live/node_modules" ]]; then
        mv "$live/node_modules" "$backup/failed-node_modules" || exit 1
      fi
      mv "$backup/node_modules" "$live/node_modules" || exit 1
    fi
    systemctl --user start gloss.service || exit 1
    systemctl --user status gloss.service --no-pager || true
    journalctl --user -u gloss.service -n 30 --no-pager || true
  fi
  cleanup
  echo "Failed swap artifacts retained at $backup" >&2
  exit "$code"
}
trap restore ERR

# All network/build validation belongs before downtime. Stage output first.
cp -a "$build/.next" "$backup/incoming"
swapping=1
systemctl --user stop gloss.service
mv "$live/.next" "$backup/next"
git -C "$live" merge --ff-only "$rev"
if [[ $deps_changed == 1 ]]; then
  # npm ci deletes node_modules before installing. Keep the old dependencies
  # so a failed/networkless install can roll back without another npm request.
  mv "$live/node_modules" "$backup/node_modules"
  deps_moved=1
  (cd "$live" && npm ci)
fi
mv "$backup/incoming" "$live/.next"
systemctl --user start gloss.service
systemctl --user status gloss.service --no-pager || true
journalctl --user -u gloss.service -n 30 --no-pager || true
systemctl --user is-active --quiet gloss.service
# Allow the process to bind its port; an unauthenticated owner API must deny.
code=$(curl --retry 10 --retry-connrefused --retry-delay 1 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/chatgpt)
test "$code" = 403
trap - ERR
cleanup
echo "Deployed $rev. Keep $backup until owner-browser and read-scoped MCP checks pass."

# Library table

The default library view is now **Table**, beside **Topics**. The unused `Shelf.tsx`, shelf arrangement helpers and bookcase-only CSS were removed. Shared book/spine/cover rendering remains for Topics and its book-detail view.

## Reading list

- Six reversible sorts: title, topic, added date, estimated reading length, status/progress, last read. Desktop headers expose `aria-sort`; narrow screens use a sort selector and direction button.
- **Newest added first** is the default: newly saved articles have a predictable home, independent of reading progress. Unknown dates (including unsaved samples) stay last in either direction. Ties are deterministic and sorting never mutates store order.
- Data comes from the existing model: `addedAt`, `words` (the existing 230 words/minute estimate), `topic`, `source`/`sourceUrl`, `finishedAt`, and `progress[id].pct`/`.at`. “Last read” is the last saved reading-position timestamp, not a new tracking event. A completion date keeps a text Finished even if it is subsequently scrolled back up.
- Below 900px, each row becomes a compact reading list: full wrapping title, source, topic glyph, length, status and added date. DOM and visual reading order agree. Sorting by Last read replaces the added date with last read. Phone status chips stay on one line; topic, sort and direction share one grid row. The count sits beside the chips and the header stats are hidden on phones. No sideways table scrolling. Coarse-pointer controls have 44px touch targets; desktop status chips stay 32px.
- Warm theme tokens, the existing serif, pill controls and light/dark settings are reused. Dates are formatted in Pacific Time, with full timestamps in desktop tooltips.

## Small extras

Status chips (All / Unread / In progress / Finished), a topic filter, matching count, clear-filters action and an empty-results state make the library manageable without adding another view. Search matches title, author, source, URL, topic, tags and year; it composes with filters and sorting. Search also filters the Topics grid and survives switching views.

View and sort persist in the existing `gloss:library` preference object, without replacing hidden-sample or painted-cover preferences. Search and filters are intentionally transient. Invalid/legacy view or sort values fall back to Table/newest-added. A removable chip names active tag filters (including From your agent). The arrivals card resets search, tag, status and topic filters while preserving the saved sort.

A real row-wide link opens the reader directly, supports keyboard focus and open-in-new-tab. Small progress bars reinforce the text/percentage rather than replacing it. The phone header is more compact so articles, not controls, fill the screen.

Skipped: bulk/destructive actions, another card view, column configuration, and virtualization. None is needed for the current library size; they would add interaction and maintenance cost. No database migration or server/API change.

## Verification

Verified with synthetic browser-local data only: dev server on `127.0.0.1:3197`, isolated production-mode server on `127.0.0.1:3199`. Both used an explicitly unreachable loopback `DATABASE_URL`, with no production environment file, credentials or database. Chromium/iPhone emulation used a fixture identity and intercepted local sync responses to exercise real arrivals UI; no database integration test or deployment was performed. Real iOS Safari remains untested.

- `npx tsc --noEmit`: passed.
- `npm run lint`: passed, including installed oxlint/type-aware checks. No dependencies added.
- `npm test`: 82/82 passed, including eight sorting/filtering tests and eight deployment-script tests; repeated successfully after build.
- `bash -n deploy/swap-build.sh` and `shellcheck deploy/swap-build.sh`: passed. Disposable tests cover unchanged/changed dependencies and recovery from merge, install, build-swap, service-start and health/gate failures.
- `npm run build`: the original Next.js 16.4.0 build passed only on retry after a security-advisory stop. The security follow-up below replaces that result. Existing Atkinson Hyperlegible Next fallback-font warning remains.
- Browser regression checks: all six header sorts reverse with Enter/Space; both AddPanel segmented controls have selected styling and fit their labels; agent-banner filter chip is visible/removable; arrivals clear all filters without overwriting sort; samples say Sample, not Added Sample. Previous search/persistence/row-opening checks remain documented in `.verify/`.
- First row starts at **y=341px** at both 390×844 and 320×844 in Chromium iPhone touch emulation, with single-line status chips and a single-row topic/sort/direction grid. No horizontal overflow at 320, 390, 900, 1024 or 1440px. Long titles wrap. Dates use proportional numerals; status labels and header icons fit at 900px.
- Impeccable mechanical detector: no findings on changed UI targets.

Screenshots (git-ignored; synthetic `.example` sources, not real saved articles):

- `.verify/fixes-phone-390-dark.png`, `.verify/fixes-phone-390-light.png` — 390×844
- `.verify/fixes-phone-320-dark.png`, `.verify/fixes-phone-320-light.png` — 320×844
- `.verify/fixes-desktop-1440-dark.png`, `.verify/fixes-desktop-1440-light.png` — 1440×1000
- `.verify/fixes-desktop-900-dark.png`, `.verify/fixes-desktop-1024-dark.png` — intermediate widths
- `.verify/fixes-addpanel-390-dark.png`, `.verify/fixes-addpanel-320-dark.png` — restored tabs/picker
- `.verify/fixes-agent-filter-390-dark.png`, `.verify/fixes-samples-390-light.png` — regression states

Sizes are CSS viewports; captures are 2× pixel density, taken against the isolated production-mode build with no visual overrides. Logs, local fixture/browser-check scripts and numeric evidence (`browser-fixes.json`) also live in `.verify/`.

### Next.js security follow-up

Upgraded Next.js and its `@next/env` / `@next/swc-*` packages from **16.4.0 → 16.4.1**, the first patched release for [GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr) (typed-array cache RCE), [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw) (SVG image optimization RCE), and [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r) (Server Actions denial of service). The [release notes](https://github.com/vercel/next.js/releases/tag/v16.4.1) and [tag comparison](https://github.com/vercel/next.js/compare/v16.4.0...v16.4.1) contain security fixes and test changes, with no app-facing breaking change requiring migration here. React / React DOM remain **19.3.0**; all non-Next package versions are unchanged. Next now requires `sharp ^0.35.5`; the lockfile already had **0.35.5**. No ESLint Next config is installed.

- `npx tsc --noEmit` and `npm run lint`: passed.
- `npm test`: **82/82 passed** after build (before build, 81 passed and the generated-home-page test skipped).
- Production build: **passed on the first attempt**, no `SecurityFatalError`, using `AUTH_MODE=single NEXT_PUBLIC_SITE_URL=https://inkling.example FEATURE_COVERS=0 DATABASE_URL=postgres://unused:unused@127.0.0.1:1/unused`. Only the existing fallback-font warning remains.
- `npm audit --omit=dev`: **0 vulnerabilities**.
- Built-app browser smoke: Next bound to `127.0.0.1:3199`, with a temporary loopback-only proxy on `127.0.0.1:3198` adding the synthetic `smoke@example.invalid` identity. `/library` returned 200, rendered the Table with three built-in sample rows, and clicking Title set `aria-sort="ascending"`. Requests without the identity returned 403. The unreachable database produced expected connection-refused errors; no sync response was mocked. Both temporary processes were stopped afterward.
- No production environment file, credentials, database, checkout or service was accessed. No deployment performed. Local evidence is in git-ignored `.verify/`.

## Shipping — operator instructions, not executed

The deployment is `gloss.service` (user systemd), running from `~/repos/inkling` on loopback port 3100 (a systemd drop-in overrides `WorkingDirectory`). Tailscale Serve provides the private HTTPS origin; Postgres is the existing Docker Compose service. Preserve those names, the `.env.local` file, and the database. See `deploy/README.md` for the deployment/recovery guide. The `origin` URL `shuv1337/gloss` now redirects on GitHub to `shuv1337/inkling`.

Ship only after the Next.js security follow-up is reviewed and merged into **selfhost** (not main). Set `SITE_ORIGIN` below to the deployment's actual HTTPS origin; the example is deliberately a placeholder.

Prepare the build without touching the live checkout's `.next`:

```bash
set -euo pipefail
live="$HOME/repos/inkling"
SITE_ORIGIN="https://inkling.example"
test "$SITE_ORIGIN" != "https://inkling.example" # Replace the placeholder first.
test -z "$(git -C "$live" status --porcelain)"
test "$(git -C "$live" branch --show-current)" = selfhost
git -C "$live" fetch origin selfhost
rev=$(git -C "$live" rev-parse origin/selfhost)
build="$HOME/.cache/agent-ws/inkling-ship-$rev"
git -C "$live" worktree add --detach "$build" "$rev"
# Clean up even if dependency installation or validation fails.
(
  trap 'cd "$live"; git -C "$live" worktree remove "$build"' ERR
  cd "$build"
  npm ci
  npm test
  npm run lint
  AUTH_MODE=single NEXT_PUBLIC_SITE_URL="$SITE_ORIGIN" \
    FEATURE_COVERS=0 DATABASE_URL=postgres://unused:unused@127.0.0.1:1/unused \
    npm run build
  npm test
)
```

Run the swap as its own process, **not pasted into an interactive shell**. Supply the same live/build paths from above:

```bash
stamp=$(TZ=America/Los_Angeles date +%Y%m%d-%H%M%S-%Z)
backup="$HOME/.cache/agent-ws/inkling-previous-$stamp"
bash "$build/deploy/swap-build.sh" "$live" "$build" "$backup"
```

The script uses `trap restore ERR`. It stages output before stopping the service, records both revisions, fast-forwards the source, and **skips `npm ci` when package.json/package-lock.json did not change**. If dependencies did change, it saves the old `node_modules` before installing, so rollback does not need the network. Any swap, install, start or local gate-check failure stops the service, preserves failed output, resets to the recorded previous revision, restores the old build/dependencies, and restarts. Diagnostics use `status || true` so logs are still printed. Successful and recovered swaps remove the build worktree; backups remain outside the live checkout. The script is tested with disposable Git repositories and stubbed npm/systemctl/curl, not against production.

After success, open `$SITE_ORIGIN/library` as the actual owner, verify the Inkling title, Table, Topics and an existing article, and check existing read-scoped MCP access. Keep the backup until these pass. The script's local 403 check is not a substitute for owner/browser testing. No migration is required. Do not run database smoke scripts against production, change Tailscale routes or restart Postgres.

### Manual rollback after a failed owner/MCP check

Use the backup path printed by the swap. These commands restore **both source and build**, and the previous dependencies when present. Run only on the unchanged live checkout; `reset --hard` deliberately discards deployment-revision changes. If an automatic rollback already succeeded, `$backup/next` has been consumed and this manual procedure must not be run again.

```bash
set -euo pipefail
live="$HOME/repos/inkling"
backup="/absolute/path/to/inkling-previous-TIMESTAMP"
test -f "$backup/revision"
test -f "$backup/next/BUILD_ID"
systemctl --user stop gloss.service
if [ -e "$live/.next" ]; then
  mv "$live/.next" "$backup/manual-failed-next"
fi
git -C "$live" reset --hard "$(cat "$backup/revision")"
mv "$backup/next" "$live/.next"
if [ -d "$backup/node_modules" ]; then
  if [ -e "$live/node_modules" ]; then
    mv "$live/node_modules" "$backup/manual-failed-node_modules"
  fi
  mv "$backup/node_modules" "$live/node_modules"
fi
systemctl --user start gloss.service
systemctl --user status gloss.service --no-pager || true
journalctl --user -u gloss.service -n 30 --no-pager || true
systemctl --user is-active --quiet gloss.service
```

Recheck the actual owner's browser and existing read-scoped MCP connection. Retain failed artifacts for diagnosis. Never rebuild into a directory served by `next start`.

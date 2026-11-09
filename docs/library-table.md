# Library table

The default library view is now **Table**, beside **Topics**. The unused `Shelf.tsx`, shelf arrangement helpers and bookcase-only CSS were removed. Shared book/spine/cover rendering remains for Topics and its book-detail view.

## Reading list

- Six reversible sorts: title, topic, added date, estimated reading length, status/progress, last read. Desktop headers expose `aria-sort`; narrow screens use a sort selector and direction button.
- **Newest added first** is the default: newly saved articles have a predictable home, independent of reading progress. Unknown dates (including unsaved samples) stay last in either direction. Ties are deterministic and sorting never mutates store order.
- Data comes from the existing model: `addedAt`, `words` (the existing 230 words/minute estimate), `topic`, `source`/`sourceUrl`, `finishedAt`, and `progress[id].pct`/`.at`. “Last read” is the last saved reading-position timestamp, not a new tracking event. A completion date keeps a text Finished even if it is subsequently scrolled back up.
- Below 900px, each row becomes a compact reading list: full wrapping title, source, topic, length, status and added date. Sorting by Last read replaces the added date with last read. No sideways table scrolling. New controls have 44px touch targets.
- Warm theme tokens, the existing serif, pill controls and light/dark settings are reused. Dates are formatted in Pacific Time, with full timestamps in desktop tooltips.

## Small extras

Status chips (All / Unread / In progress / Finished), a topic filter, matching count, clear-filters action and an empty-results state make the library manageable without adding another view. Search matches title, author, source, URL, topic, tags and year; it composes with filters and sorting. Search also filters the Topics grid and survives switching views.

View and sort persist in the existing `gloss:library` preference object, without replacing hidden-sample or painted-cover preferences. Search and filters are intentionally transient. Invalid/legacy view or sort values fall back to Table/newest-added.

A real row-wide link opens the reader directly, supports keyboard focus and open-in-new-tab. Small progress bars reinforce the text/percentage rather than replacing it. The phone header is more compact so articles, not controls, fill the screen.

Skipped: bulk/destructive actions, another card view, column configuration, and virtualization. None is needed for the current library size; they would add interaction and maintenance cost. No database migration or server/API change.

## Verification

Verified with synthetic browser-local data only, on `127.0.0.1:3197`. The dev server had `DATABASE_URL` explicitly pointed at an unreachable loopback port, with no production environment file, credentials or database. Expected `/api/sync` connection failures do not affect local reading; database sync itself was not tested in this change.

- `npx tsc --noEmit`: passed.
- `npm run lint`: passed, including installed oxlint/type-aware checks. No dependencies added.
- `npm test`: 74/74 passed, including eight new sorting/filtering tests; repeated successfully after build.
- `npm run build`: passed on retry. Next.js 16.4.0 emitted a security-advisory stop; address that dependency advisory separately before shipping. Existing Atkinson Hyperlegible Next fallback-font warning remains.
- Browser checks: all six header sorts reverse, status and topic counts match, search composes with filters, no-match recovery works, sort/view survive reload, Topics still renders, mobile direction reverses, Last read replaces Added on mobile, keyboard focus works, row-wide hit target opens the local fixture article.
- No horizontal overflow at 320px, 390px or 1440px. Long titles wrap without truncation.
- Impeccable mechanical detector: no findings on changed UI targets.

Screenshots (git-ignored; synthetic `.example` sources, not real saved articles):

- `.verify/table-phone-dark.png` — 390×844 CSS viewport
- `.verify/table-phone-light.png` — 390×844 CSS viewport
- `.verify/table-desktop-dark.png` — 1440×1000 CSS viewport
- `.verify/table-desktop-light.png` — 1440×1000 CSS viewport

Captures are 2× pixel density. Only the Next.js development badge was hidden for captures. Logs and the local fixture/browser-check scripts also live in `.verify/`.

## Shipping — operator instructions, not executed

The current deployment is `gloss.service` (user systemd), running from `~/repos/gloss` on loopback port 3100. Tailscale Serve provides `https://shuvdev.tail586a6d.ts.net`; Postgres is the existing Docker Compose service. Preserve those names, the `.env.local` file, and the database. See `deploy/README.md` for the authoritative deployment/recovery guide. The `origin` URL `shuv1337/gloss` now redirects on GitHub to `shuv1337/inkling`.

After the draft is reviewed and merged into **selfhost** (not main), and the dependency advisory is resolved, prepare a build without disturbing the live checkout's `.next`:

```bash
set -euo pipefail
live="$HOME/repos/gloss"
test -z "$(git -C "$live" status --porcelain)"
test "$(git -C "$live" branch --show-current)" = selfhost
git -C "$live" fetch origin selfhost
rev=$(git -C "$live" rev-parse origin/selfhost)
build="$HOME/.cache/agent-ws/inkling-ship-$rev"
git -C "$live" worktree add --detach "$build" "$rev"
cd "$build"
npm ci
npm test
npm run lint
# Public origin must match the deployed origin. No production credentials needed.
AUTH_MODE=single NEXT_PUBLIC_SITE_URL=https://shuvdev.tail586a6d.ts.net \
  FEATURE_COVERS=0 DATABASE_URL=postgres://unused:unused@127.0.0.1:1/unused \
  npm run build
npm test
```

Then, in the same shell, stage the verified output and stop only Inkling before swapping it:

```bash
stamp=$(TZ=America/Los_Angeles date +%Y%m%d-%H%M%S-%Z)
old=$(git -C "$live" rev-parse HEAD)
backup="$HOME/.cache/agent-ws/inkling-previous-$stamp"
mkdir "$backup"
printf '%s\n' "$old" > "$backup/revision"
cp -a "$build/.next" "$backup/incoming"
systemctl --user stop gloss.service
mv "$live/.next" "$backup/next"
git -C "$live" merge --ff-only "$rev"
(cd "$live" && npm ci)
mv "$backup/incoming" "$live/.next"
systemctl --user start gloss.service
systemctl --user status gloss.service --no-pager
journalctl --user -u gloss.service -n 30 --no-pager
ss -ltn '( sport = :3100 or sport = :5432 )'
# No identity: expect 403. The actual owner's tailnet browser must still work.
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/api/chatgpt
```

Open the tailnet `/library` as the actual owner, verify the Inkling title, Table, Topics and an existing article, and check existing read-scoped MCP access. Do not run database smoke scripts against production: they write fixture users. No migrations are required for this feature. Do not change Tailscale routes or the Postgres service.

Keep `$backup/next` and `$backup/revision` until checks pass. If a swap or health check fails, stop `gloss.service`, preserve the failed output separately, restore the previous source revision and matching `.next` together, reinstall that revision's dependencies, then restart and recheck. Do not rebuild into a directory served by `next start`.

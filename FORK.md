# Inkling, a fork of Gloss

Inkling is a fork of [Gloss](https://github.com/Nutlope/gloss), by Hassan El Mghari (Nutlope) and contributors. It is run for one reader, on Postgres on the same machine, behind Tailscale.

- Upstream: `https://github.com/Nutlope/gloss`, remote `upstream`
- Fork: `https://github.com/shuv1337/gloss`, remote `origin`
- Forked from upstream `95373eb` (2026-10-15, "Point the clone URL at Nutlope/gloss")
- Fork trunk: `selfhost`. `main` tracks `upstream/main` and carries no fork commits.

## License

Upstream has no LICENSE file as of `95373eb` (see Nutlope/gloss#14). Until it has one, the code is the upstream authors' with all rights reserved. This fork is for private self-hosting. Do not publish releases or packages under the Inkling name until upstream picks a license, and keep this attribution when it does.

## What the fork changes

- Single-user auth (`AUTH_MODE=single`), gated by `ALLOWED_TS_USERS`, with Clerk only for `AUTH_MODE=clerk`
- Local Postgres in Docker instead of Neon
- An OpenAI-compatible model client, and `LLM_PROVIDER=chatgpt` for a ChatGPT plan through the Responses API
- Read aloud through a configurable speech provider (Kokoro-FastAPI or any OpenAI-compatible `/v1/audio/speech`)
- Agent tokens with read and write scopes, and an MCP server that can read the library
- Fetching single posts from X and Twitter
- The Inkling name and ink-drop mark, with no Together AI branding. Together still works as a model provider.
- No Plausible analytics, and no links to upstream's hosted site

## Names

The product is **Inkling**: the package name, page titles, wordmark, social card, copy, MCP instructions, model system prompt, User-Agent (`Inkling/0.1`), and the ChatGPT agent name for new links.

Some old names stay on purpose. Renaming any of them would lose stored data or break something already connected.

| Kept | Where | Why |
| --- | --- | --- |
| `gloss:*` localStorage keys, IndexedDB `gloss` | `lib/store.ts`, `lib/settings.ts`, `lib/sync.ts`, components | The reader's library and settings in the browser |
| `gloss:key`, `gloss:free`, `gloss:text-replaced` events | components, `lib/ask.ts`, `lib/upgrade.ts`, `lib/careful.ts` | Internal namespace shared with the keys above |
| `gloss:` hash salt | `lib/quota.ts`, `app/api/pdf-careful/route.ts` | Changing it resets quotas and caches |
| Database and user `gloss`, compose project `gloss`, volume `gloss-pg` | `deploy/docker-compose.yml`, `.env.example` | The running database |
| Tables such as `glosses` | `db/` | Schema |
| Agent token prefix `gls_` | `lib/agent.ts` | Tokens already handed to agents |
| MCP `serverInfo.name` `gloss` | `lib/mcp.ts` | Identity seen by connected clients |
| Responses tool namespace `gloss` | `lib/responses.ts` | Protocol field in model requests |
| `~/.config/gloss/chatgpt-auth.json` | `scripts/chatgpt-login.ts`, `scripts/chatgpt-import.ts` | Login hand-off path from the laptop |
| `gloss.service`, `gloss-backup.timer`, `~/repos/gloss` | shuvdev, outside the repo | The running service |

"A gloss" is still the word for one answer in the margin, as in `GlossCard`, `useGlosses`, and "Gloss this text". That is product vocabulary, not the old name.

The PDF and image evaluation reports under `scripts/pdf-eval/` and `scripts/image-eval/` are upstream's research and keep the name they were run under. A ChatGPT link made before the rename still shows as Gloss in ChatGPT until `npm run chatgpt:login -- --fresh`.

`tests/fork-boundary.test.ts` checks all of this and runs with `npm test`.

## Merging upstream

Upstream merges are expected. Fetch `upstream`, fast-forward `main`, then merge `main` into `selfhost`. After each merge:

1. Run `npm test` (it includes the boundary test), `npm run lint`, and `npm run build`.
2. Search for `Gloss`, `usegloss`, `together`, and `Together` in new upstream code, and sort each new match by the table above.
3. Regenerate `public/og.png` and `public/og.jpg` from `scripts/og/card.html` if upstream changed the card, and bump the version in `lib/brand.ts`.

## Deployment

See "Self-host" in the README. On shuvdev, after a change: `npm run build`, then `systemctl --user restart gloss.service`.

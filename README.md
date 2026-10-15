<a href="https://usegloss.io">
  <img alt="Gloss" src="./public/og.png">
  <h1 align="center">Gloss</h1>
</a>

<p align="center">
  An open source AI reader for articles and PDFs. Select any line, ask a question, and get a cited answer in the margin. Powered by Together.ai.
</p>

## Tech stack

- [DeepSeek V4.1 Flash](https://togetherai.link/?utm_source=gloss&utm_medium=referral&utm_campaign=example-app) and Kimi K3 for the LLMs
- [Together AI](https://togetherai.link/?utm_source=gloss&utm_medium=referral&utm_campaign=example-app) for LLM inference
- [Exa](https://exa.ai) for web search
- [LiteParse](https://github.com/run-llama/liteparse) for in-browser PDF parsing, with Qwen on Together for scanned pages
- [Clerk](https://clerk.com) for optional auth and [Neon](https://neon.tech) for syncing your library
- Next.js app router with Tailwind

## Cloning & running

1. Clone the repo: `git clone https://github.com/Nutlope/gloss`
2. Create a `.env.local` file (use `.env.example` for reference) and add your API keys:
   - **[Together AI API key](https://togetherai.link/?utm_source=gloss&utm_medium=referral&utm_campaign=example-app)**: `TOGETHER_API_KEY=`
   - **Database URL** from [Neon](https://neon.tech): `DATABASE_URL=`
   - **Clerk keys** from [Clerk](https://clerk.com): `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=` and `CLERK_SECRET_KEY=`
   - **Exa API key** (optional, for web search): `EXA_API_KEY=`
3. Run `npm install` and `npm run db:migrate` to install dependencies and create the tables
4. Run `npm run dev` and open http://localhost:3100

## Read aloud

`TTS_PROVIDER` is `together` (the default), `openai-compatible`, or `off`.

An OpenAI-compatible speech server, including Kokoro-FastAPI, accepts `POST /v1/audio/speech` with `model`, `voice`, `input`, and `response_format` set to `mp3`. Set `TTS_BASE_URL` to that server's `/v1` prefix (Kokoro-FastAPI's own default is `http://127.0.0.1:8880/v1`). `TTS_API_KEY` is optional. For this provider `TTS_MODEL` defaults to `kokoro` and `TTS_VOICE` to `af_heart`. `TTS_VOICES=af_heart:Heart,af_bella:Bella` fills the voice picker in settings.

The reader still splits a long text at sentence ends before each request, and the same player plays the MP3.

## Self-host

This fork runs for one reader, on Postgres on the same machine, behind Tailscale. Copy `.env.example` to `.env.local`. Nothing in `.env.local` is committed.

**Set `ALLOWED_TS_USERS` before serving.** It is the comma-separated list of Tailscale logins allowed to open Gloss. Leave it unset and anyone on the tailnet can use the app.

```bash
npm install
npm run db:up       # Postgres 18, bound to 127.0.0.1:5432, volume gloss-pg
npm run db:migrate  # schema, then db/migrations, safe to repeat
npm run dev         # http://127.0.0.1:3100
```

`AUTH_MODE` defaults to `single`: one user id (`SINGLE_USER_ID`, default `owner`), no Clerk. `AUTH_MODE=clerk` is the hosted accounts path and is the only mode that loads Clerk.

The model client is OpenAI-compatible unless `LLM_PROVIDER=chatgpt`. Leave `LLM_BASE_URL` unset to keep Together, or point it at another `/v1` server and set `LLM_API_KEY`, `LLM_MODEL`, and optionally `LLM_MODELS` (`key:id:label`). `LLM_EXTRA_BODY` is extra JSON on each chat request. With no `LLM_PRICE_IN` / `LLM_PRICE_OUT` on a non-Together host, prices are 0 and the free-budget counter stays out of the way. `LLM_PROVIDER=compat` is that same client. The ChatGPT plan is the next section.

`TTS_PROVIDER=openai-compatible` with `TTS_BASE_URL` pointed at a Kokoro-FastAPI `/v1` (its own default listen address is `http://127.0.0.1:8880/v1`) speaks with `POST /v1/audio/speech`. No host is built in. `TTS_PROVIDER=off` hides Read aloud.

An agent connects with a token from `npm run token -- --label "name" --scope read,write`. The token is printed once. `read` can list, search, and read texts, highlights, notes, and briefs. `write` can save URLs and text, and add a highlight or a note. `npm run mcp:smoke` checks that path against the local database.

A link to one post on X or Twitter (`/status/<id>` on x.com or twitter.com) is fetched as the post. `X_FETCH` defaults to `fx,api`: fxtwitter, then the X API if `X_BEARER_TOKEN` is set. Profiles and other social sites are still refused. `node --env-file-if-exists=.env.local --import tsx scripts/x-smoke.mjs` tries one live post and skips itself if the network is down.

Still to do on the machine that serves Gloss, not in this repo:

- a user systemd unit that runs `npm run start -- -H 127.0.0.1` (port 3100)
- `tailscale serve --https=443 http://127.0.0.1:3100`, and not Tailscale Funnel
- `.env.local` only on that machine
- a nightly `pg_dump` of the `gloss` database

## Sign in with ChatGPT

`LLM_PROVIDER=chatgpt` answers with your ChatGPT plan. Ask (including the web-search tool), brief, shelve, and scanned-page reading go to `POST https://api.openai.com/v1/responses` with the subscription access token, `store: false`, and `stream: true`. There is no API key and no client secret. `LLM_PROVIDER=compat` (or leaving it unset) keeps the OpenAI-compatible client, Together included.

Painted covers do not run on the plan. Image generation is not offered to this flow. Set `FEATURE_COVERS=0`. Gloss does not add an image provider or a Together key for the ChatGPT path. There is no Claude path.

This is the open-source direct flow for one reader on a machine they control. It is not a fit for a public site, and it is not a way to share one ChatGPT plan with other people.

### One-time login

Do this once, from a browser that can reach `http://127.0.0.1`. The redirect is that host, not `localhost`. Only the port may change. The path stays `/auth/callback`.

On the server, in `.env.local`:

- `LLM_PROVIDER=chatgpt`
- `AUTH_ENCRYPTION_KEY`, a 32-byte key as base64 or 64 hex characters. Tokens are encrypted with AES-GCM before they are written. If the key is missing or the wrong length, login and refresh fail with an error that names the variable. They do not start.
- `DATABASE_URL`, the same Postgres Gloss already uses
- `LLM_MODEL`, optional. Unset uses `gpt-6.1-sol`, the slug in OpenAI's example. Set a slug the signed-in account can call (`GET /v1/models`, keep `visibility` of `list`, and use `slug`).
- `FEATURE_COVERS=0`
- `VISION_MODEL`, optional. Unset uses `LLM_MODEL`, then the same example slug.

Then `npm run db:migrate`. That adds `openai_auth`.

**On Cap's laptop**, with the repo and no database:

```bash
npm run chatgpt:login -- --export
```

The command listens on `127.0.0.1:1455` (override with `--port` or `OPENAI_REDIRECT_PORT`), prints an address, and opens it. Approve Gloss and allow it to use the ChatGPT plan. It writes `~/.config/gloss/chatgpt-auth.json` with mode `0600`. The file contains tokens. Copy it over SSH, import it, then delete it on both machines:

```bash
scp ~/.config/gloss/chatgpt-auth.json shuvdev:~/chatgpt-auth.json
ssh shuvdev 'cd ~/repos/gloss && npm run chatgpt:import -- ~/chatgpt-auth.json && rm ~/chatgpt-auth.json'
rm ~/.config/gloss/chatgpt-auth.json
```

Import keeps the server's own host id, or creates one. It does not copy the laptop's host id. OpenAI recommends a JWK thumbprint for that id. A `urn:uuid:` is still accepted, and that is what Gloss generates. `did:key:` is also accepted if you set `OPENAI_HOST_ID`.

**Over an SSH tunnel**, when the login should write straight into Postgres. On the laptop:

```bash
ssh -L 1455:127.0.0.1:1455 shuvdev
```

On shuvdev, in the Gloss repo, with `DATABASE_URL` and `AUTH_ENCRYPTION_KEY` already in `.env.local`:

```bash
npm run chatgpt:login -- --no-browser
```

Open the printed address in the laptop browser. The callback hits the laptop's `127.0.0.1:1455`, and the tunnel delivers it to the listener. Use the same port in `--port` and in `-L` if 1455 is taken. A sign-in hint in that address, on a later login, is not an API token. Do not paste the address into chat.

The command prints the account email and the access-token expiry. It does not print tokens.

### What the server does with the tokens

Access tokens last an hour. Refresh tokens last 30 days and rotate on every refresh. Gloss refreshes when less than five minutes remain, and not before `earliest_refresh_at` while the access token is still valid. The new refresh token is saved inside a Postgres advisory lock, so two requests cannot spend the same one. A dead refresh token clears the local tokens and asks for `npm run chatgpt:login` again.

`GET /api/chatgpt` and the key menu say whether ChatGPT is linked and when the access token expires. They do not return the token.

### Weekly cap

In ChatGPT, open Settings, then Usage, then App limits, then Manage limits. A weekly limit is a share of your plan's weekly usage, not a separate pool. Gloss can hit that cap while the plan still has room. Plus also shares a five-hour limit across apps. Pro does not have that five-hour limit. Reaching either limit stops the answer, including one that has already started, with a message that points at Settings, then Usage. Gloss does not fall back to API billing. Credits are used only if you turn that on yourself in the same Usage screen.

### Revoke

```bash
npm run chatgpt:logout
```

That revokes the refresh token at OpenAI and clears the local tokens. The client id and host id stay, so the next login is a reauthorization. Also disconnect Gloss in ChatGPT: Settings, then Security and login, then Login connections, then Sign in with ChatGPT, then Disconnect. Signing out of Gloss does not, by itself, disconnect the app. A session that was imported from another machine still has no per-host revocation. Disconnect it in ChatGPT settings.

### Caveats

- The redirect is `http://127.0.0.1:<port>/auth/callback`. `localhost` is rejected.
- Requests set `store: false` and `stream: true`. Temperature, `max_output_tokens`, `top_p`, and a `system` role are not sent. The system text goes in `instructions`. Brief and shelve still ask for JSON, collected from the stream, so their old token caps are not sent.
- The web-search tool is a namespaced function (`gloss` / `web_search`). Hosted image generation, file search, and Code Interpreter are not used.
- Plan usage has to be granted (`chatgpt.tokens.use.direct`). Go, Plus, and Pro can grant it. A sign-in that skips the grant is not stored.
- One Gloss user has one linked ChatGPT account. `--fresh` starts a new registration and replaces the row.
- Tokens are not logged. A missing `AUTH_ENCRYPTION_KEY` fails in the open, before a request is sent.
- Do not run two Gloss servers that both refresh the same credential file. The refresh token rotates, and the loser is signed out.

## Future Tasks

- [ ] Ship it as a browser extension that opens the same margin on any page
- [ ] Let a gloss compare two passages you pick at once
- [ ] Move the shared-key rate limit to a store like Upstash so it holds across instances

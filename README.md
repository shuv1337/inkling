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

The model client is OpenAI-compatible. Leave `LLM_BASE_URL` unset to keep Together, or point it at another `/v1` server and set `LLM_API_KEY`, `LLM_MODEL`, and optionally `LLM_MODELS` (`key:id:label`). `LLM_EXTRA_BODY` is extra JSON on each chat request. With no `LLM_PRICE_IN` / `LLM_PRICE_OUT` on a non-Together host, prices are 0 and the free-budget counter stays out of the way.

`TTS_PROVIDER=openai-compatible` with `TTS_BASE_URL` pointed at a Kokoro-FastAPI `/v1` (its own default listen address is `http://127.0.0.1:8880/v1`) speaks with `POST /v1/audio/speech`. No host is built in. `TTS_PROVIDER=off` hides Read aloud.

An agent connects with a token from `npm run token -- --label "name" --scope read,write`. The token is printed once. `read` can list, search, and read texts, highlights, notes, and briefs. `write` can save URLs and text, and add a highlight or a note. `npm run mcp:smoke` checks that path against the local database.

A link to one post on X or Twitter (`/status/<id>` on x.com or twitter.com) is fetched as the post. `X_FETCH` defaults to `fx,api`: fxtwitter, then the X API if `X_BEARER_TOKEN` is set. Profiles and other social sites are still refused. `node --env-file-if-exists=.env.local --import tsx scripts/x-smoke.mjs` tries one live post and skips itself if the network is down.

Still to do on the machine that serves Gloss, not in this repo:

- a user systemd unit that runs `npm run start -- -H 127.0.0.1` (port 3100)
- `tailscale serve --https=443 http://127.0.0.1:3100`, and not Tailscale Funnel
- `.env.local` only on that machine
- a nightly `pg_dump` of the `gloss` database

## Future Tasks

- [ ] Ship it as a browser extension that opens the same margin on any page
- [ ] Let a gloss compare two passages you pick at once
- [ ] Move the shared-key rate limit to a store like Upstash so it holds across instances

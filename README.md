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

## Future Tasks

- [ ] Ship it as a browser extension that opens the same margin on any page
- [ ] Let a gloss compare two passages you pick at once
- [ ] Move the shared-key rate limit to a store like Upstash so it holds across instances

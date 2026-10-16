# Inkling private deployment: acceptance record

Completed October 16, 2026, approximately 12:58 p.m. PDT.

## Result

The approved private-deployment wrap-up is complete. CI was explicitly deferred by the user and was not added or merged. The application revision is `a4ebf9655e318ceaf3341f46f0d681c1ba4d4622`, published on `origin/selfhost` and running on shuvdev. Production build ID: `DGvRcykDy_Ou2xxI4YqYp`.

The deployment manifest at `~/.local/state/inkling/deployment.json` records the app commit, build ID, deployment time, and rollback build. This acceptance document is a subsequent documentation-only commit; it does not change the running application code.

## Changes delivered

- Configured the actual Tailscale owner login in the private host environment. The production allowlist now fails closed when empty; development can still run locally.
- Kept the exact MCP routes independently authenticated by scoped agent tokens, supporting tagged agent hosts without opening owner APIs.
- Fixed a live ChatGPT shelving failure: JSON mode requires JSON guidance in an input message, whereas the original adapter placed it only in the separate instructions field.
- Fixed brief attribution: the server now supplies the resolved model label, which is stored and synced with the brief. Old briefs with no recorded label say “Model not recorded” rather than guessing DeepSeek.
- Rewrote the initial setup path for local Postgres, single-user auth, and selectable ChatGPT/compatible inference. Added deployment, manual validation, backup, restore, and secret recovery instructions in `deploy/README.md`.
- Published the previously local Inkling branding commits. GitHub now defaults to `selfhost`; `main` remains at the upstream baseline `95373eb`.
- Closed PR #1 without merging, with the branch-policy explanation. PR #2 was already merged. Retargeted PR #3 to `selfhost`; it remains open and unmerged for a later CI decision. Its previous checks are not acceptance evidence for the combined fork.
- Updated the private repository description and its local GitHub CLI default to the fork, preventing accidental upstream targeting.

## Verification performed

### Build and automated checks

Built from an isolated copy under `~/.cache/agent-ws`, with no production credentials. Production build passed. All **58 tests passed**, including the built-output naming test and new production access/JSON-mode regressions. TypeScript checking passed. Build warnings remain for a home-directory lockfile and missing Atkinson fallback-font metrics; neither prevented the build.

The running `.next` directory was replaced only while `gloss.service` was stopped. Previous builds were retained for rollback. Service is active/running with zero automatic restarts after deployment. Backend and Postgres remain loopback-bound; the tailnet route is unchanged.

### Access and agent transport

- Actual owner via tailnet HTTPS: 200.
- Missing identity and a deliberately wrong identity on owner APIs: 403.
- MCP without a token or with an invalid token: 401.
- Valid bearer and URL tokens: accepted on MCP only.
- Read tokens cannot save text, add highlights, or add notes.
- Write-capable tokens can save/read a fixture and add/read highlights and notes.
- Agent bearer tokens without an owner identity do not grant access to account-management, sync, or ChatGPT owner APIs.

Transport checks ran against the isolated production build, then both loopback and tailnet URLs of the deployed app. Dedicated test users/tokens were cleaned up.

### Models, import, and browser behavior

- The expired ChatGPT access token refreshed successfully; a real Ask response streamed “60 liters” with paragraph citation 1 from a 120-liter/half-used fixture.
- Real brief requests produced valid cited claims and sections.
- Shelving originally failed with a 400 JSON-mode requirement. After the adapter fix, the same kind of request returned 200 with topic `climate`, tags, and a cover-scene description.
- Deployed article import returned 19 blocks from a public Paul Graham essay. X status import returned 6 blocks from the known live post fixture.
- Speech returned a valid 58,412-byte MP3 (3.648 seconds for the short HTTP fixture). In the browser, reading aloud entered playback, then Pause changed the control to Play.
- Browser PDF upload parsed the generated one-page acceptance file. Ask, highlight selection, and brief generation worked in the actual UI. The brief now displayed ChatGPT.
- A separate browser profile loaded the same PDF text, highlight, answer, and brief from sync. The database confirmed all four records. Reload preserved the result.
- Inspected desktop and 390-pixel phone-layout screenshots. Reader and library document widths matched their viewports. This is responsive desktop-browser evidence, not a physical iPhone/Safari certification.
- Removed the temporary PDF through the library UI and tombstoned its test annotations for sync. The original two server-backed articles remain active. No test agent tokens remain.

### Database and recovery

A disposable Postgres 18 container on loopback port 15432 passed fresh migrations, repeated/idempotent migrations, sync roundtrip, and MCP database smoke tests.

Restored the then-latest nightly dump (`gloss-20261016-033643.sql.gz`) into a separate database with SQL error-stop and a single transaction. It contained two articles, one encrypted auth row, and four migration records; both articles were readable through the library code. Restored migrations were idempotent. The restored ChatGPT credentials were never used or refreshed. The disposable container and its volumes were removed.

A fresh production backup was also taken before deployment. Nightly scheduling remains enabled. Recovery documentation now calls out the separate encryption-key/configuration requirement.

## Deliberate limits and follow-ups

- **No CI yet**, including no merge of hygiene PR #3.
- Public releases/packages remain deferred until upstream licensing is resolved; the repository remains private.
- Web search is not configured (no Exa key). Covers and scanned-page vision remain disabled. Those optional integrations were not enabled for acceptance.
- Backups remain on this host. Off-host encrypted storage and independent secret backup need an owner-selected destination; this run did not invent a destination or export credentials.
- A minor existing presentation issue remains: a brief can duplicate a paragraph citation when both model text and the structured cite contain it. Filed as papercut `pc_0d882d118446`; it does not block reading, citations, or sync.

No further feature work is required for the agreed private-deployment finish line.

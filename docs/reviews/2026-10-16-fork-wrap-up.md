# Inkling fork wrap-up review

Reviewed October 16, 2026, approximately 12:39 p.m. PDT. Scope: fork readiness and remaining work; no application, credentials, deployment, or GitHub state changes were made during this review.

## Accepted scope

The user approved proceeding on October 16, 2026, with one change: **no CI yet**. Item 4 is deferred. Existing hygiene PR #3 is not to be merged as part of this work; branch alignment may retarget it, with CI implementation left for later.

## Recommendation

Finish the private, single-reader deployment in one hardening and acceptance pass. No new feature work is required to call this fork usable. Public distribution remains separately gated by upstream licensing.

## What is already done

- Local `selfhost` at `c2d6ab1` contains local Postgres, compatible model and speech providers, single-user mode, scoped agent tokens, library MCP tools, X/Twitter imports, ChatGPT Responses integration, encrypted credentials and locked refresh, and the Inkling rebrand.
- `FORK.md` documents provenance and compatibility identifiers. The boundary test preserves browser storage, database names, token prefix, MCP identity, and protocol names.
- Fresh verification: all 56 tests pass; `npm run lint` (TypeScript checking) passes. This is not an ESLint check.
- `gloss.service` is running from this checkout. The tailnet home returns HTTP 200 with title Inkling. App port 3100 and Postgres port 5432 bind to 127.0.0.1.
- ChatGPT status reports linked with plan usage granted. Covers and vision are disabled in the current host configuration; speech uses the compatible provider.
- Nightly backup timer is enabled. Logs show a successful 33 KB dump on October 16 at 3:36 a.m. PDT, with a mode-0600 file. The script keeps roughly two weeks of local dumps.
- Repository is private, with separate origin and upstream remotes. GitHub reports no parent relationship, but Git provenance is documented.

## Remaining work, in order

### 1. Enforce the owner-only deployment boundary

**Confirmed gap:** `.env.local` has no nonempty `ALLOWED_TS_USERS`. `lib/auth.ts:37` explicitly allows all callers in that case. Both anonymous and deliberately disallowed-identity requests to local `/api/chatgpt` return 200. Tailscale Serve limits network reachability, but Inkling currently applies no owner allowlist inside that network boundary. Tailnet ACL reachability from other peers was not audited.

Set the actual allowed Tailscale login(s), restart the service, and verify allowed access and denied missing/wrong identities. Keep the backend loopback-only. Also test the intended agent MCP route: the same proxy covers MCP, so allowlisting must preserve the intended agent access design without exempting owner account-management APIs. Consider a production startup guard against an empty allowlist to prevent recurrence.

Done when: allowed browser works; unwanted identities fail; intended MCP read/write permissions still work.

### 2. Settle the fork trunk and outstanding PRs

**Confirmed gap:** remote `selfhost` is `baedd79`; the Together-brand removal and Inkling rename are local-only commits `3a9b386` and `c2d6ab1`. Working tree was clean at review start. GitHub default is `main`, still `95373eb`, so a normal clone does not select Inkling.

The written contract says `main` stays upstream-only and `selfhost` is the fork trunk. Recommend keeping that contract, pushing the two commits, making `selfhost` the GitHub default, and documenting an explicit `--branch selfhost` clone command.

- PR #1 (selfhost → main) remains open. Its merge would contradict the current upstream-only-main policy. If retaining that policy, close it with an explanation after the fork branch is published; otherwise explicitly adopt a new branch policy first.
- PR #2 (ChatGPT → selfhost) is merged.
- PR #3 (fleet-hygiene → main) is open with passing checks, but it targets upstream-only `main`. Retarget to `selfhost` under the recommended policy, then validate its combined result. The workflow currently runs pushes only on `main`.

The PR #3 green result is against upstream-like main, which lacks the fork's documented host paths/tailnet references. Its hygiene checks may need narrowly scoped intentional exceptions after retargeting. Do not assume existing green checks certify the fork.

Done when: chosen default, clone instructions, FORK.md, PR bases, push triggers, and remote revision agree.

### 3. Make the setup documentation describe Inkling

**Confirmed gap:** README lines 12–30 still present Together/Neon/Clerk as the primary stack/setup and include upstream referral links. Later self-host sections describe the actual fork. A fresh reader gets contradictory instructions.

Make local Postgres and single-user deployment the primary path; describe ChatGPT and compatible inference as selectable alternatives. Keep Together and Clerk as supported optional paths. Distinguish scanned PDF support in code from the current `FEATURE_VISION=0` deployment. Replace host-specific example defaults where portability is intended. Add reproducible systemd, routing, backup and restore guidance: those units/scripts currently live outside the repository.

Done when: a clean clone follows one coherent setup path without relying on undocumented host files.

### 4. Put the application gates in CI

There is no `.github` workflow on the current selfhost tree. PR #1 has passing Socket checks, not application tests. PR #3 adds hygiene only.

Add tests, TypeScript checking, and an isolated production build to CI for the chosen fork trunk and PRs. Include the fork-boundary check after the build. Use an isolated Postgres instance for migration, sync-roundtrip, and MCP scope/integration checks; current smoke scripts write and delete fixture users and should not be treated as read-only production probes.

Done when: fresh CI on the final fork revision verifies the application as well as hygiene.

### 5. Run one real acceptance pass and recovery drill

The linked ChatGPT status is not inference proof. It reports an access-token expiry of October 15, 8:25 p.m. PDT; refresh is lazy, so this does not establish failure either. Prove refresh and streaming with a real request, then verify Ask with citations, brief, shelve, and optional web search. Confirm expected behavior with covers/vision disabled; enable and test vision only if wanted for this deployment.

Exercise article and PDF import, X import, highlights/notes, reload and cross-client sync, speech playback, and MCP read/write/denial over the actual deployed transport. Verify desktop and phone layouts for the new identity. Build in isolation rather than overwriting the live service's `.next` directory during review; deploy the final revision deliberately and record its identity.

Restore the latest dump into an isolated database and prove the library is usable. Document secure recovery of `AUTH_ENCRYPTION_KEY` and configuration separately: the SQL dump alone cannot decrypt ChatGPT credentials. Decide whether off-host encrypted backup is needed, since the current script writes only to this host.

Done when: a short evidence record ties these checks and a successful restore to the final revision.

### 6. Keep public release out of the private finish line

Upstream's current root listing has no LICENSE, and its license endpoint returns 404. `FORK.md` explicitly defers public Inkling releases/packages until upstream licensing is resolved. Do not invent an MIT/Apache license. This does not prevent completing the already-established private deployment plan.

Renaming the GitHub repository/path/service units is optional. Current compatibility names are intentional; the product is already Inkling.

## Not required to wrap up

Browser extension, two-passage comparison, distributed rate limiting for multiple instances, printed editions, topic renaming, and broad import integrations are future product work. Upstream issues and PRs are not automatically fork blockers.

## Evidence limits

This was a readiness review, not an exhaustive security/code audit. Fresh tests and TypeScript checks ran. Existing build output and live HTTP identity were checked, but a fresh production build, model calls, browser acceptance, database-writing smoke scripts, and restore were not run. No production allowlist, credentials, service, branch default, PR state, or remote commits were changed.

## Decision for this review

Approve or annotate the recommended finish line: private deployment; keep `main` upstream-only and `selfhost` as the fork default; finish items 1–5; defer public distribution and additional features. Approval is for this proposed follow-up scope, not a claim that the remaining checks have passed.

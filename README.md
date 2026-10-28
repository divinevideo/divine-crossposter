> This checkout is being retired in favor of [Divine Connections](https://github.com/divinevideo/divine-connections). Retirement is not proof of a production cutover: see [Deployment transition](#deployment-transition). This branch supports local development and tests only.

# Divine Crossposter

Cloudflare Worker for opt-in crossposting of original Divine videos to external short-form platforms. A creator connects a platform account, chooses manual or automatic posting, and Crossposter publishes their Divine videos there on their behalf. Nothing posts until the creator opts in.

The service owns publishing consent, OAuth publish grants, per-platform posting preferences, crosspost job state, retries, and external post IDs. It is distribution infrastructure, not identity proof: Divine clients call this Worker after a user connects a platform or asks to publish a video, and platform OAuth and publishing details stay server-side.

The codebase is a TypeScript Worker built on [Hono](https://hono.dev), using D1 for service-owned state, Cloudflare Queues for publish work, and a Cron-triggered reconciler that catches missed automatic-crosspost triggers. License: MPL-2.0.

## Features

- **Opt-in only.** No video leaves Divine until a creator connects an account and picks a posting mode. Automatic mode applies only to Divine videos created after the creator turned it on.
- **Supported platforms.** Instagram Reels, TikTok, X, and YouTube Shorts, each behind its own adapter. A platform reports as enabled only when its `ENABLE_*` flag is `true` and matching OAuth credentials are configured, so an operator can stage a provider before exposing it.
- **Manual and automatic posting.** Manual jobs are created when the creator asks. Automatic jobs are created after a Divine publish, either from a client push or from the scheduled reconciler.
- **Idempotent jobs.** Jobs are keyed by `(pubkey, video_event_id, platform, external_account_id)`, so duplicate requests return the existing job instead of double-posting.
- **Built-in setup UI.** `GET /` serves a self-contained web app where a creator signs in with their Divine/Nostr account, connects platforms, and sets posting switches. `GET /platforms` shows provider readiness (HTML, or JSON with `?format=json`).

## Architecture

Crossposter is a single Worker with four entry points wired together in `src/index.ts`:

- **HTTP API and UI** — Hono routes for the setup UI, health, provider readiness, OAuth connections, preferences, crosspost creation, and job reads.
- **Platform adapters** — one adapter per platform (`src/platforms/instagram.ts`, `tiktok.ts`, `x.ts`, `youtube.ts`) behind a shared adapter interface and a registry that reports which providers are configured.
- **Queue consumer** — consumes `{ "jobId": "..." }` messages from `CROSSPOST_QUEUE`, refreshes tokens when needed, calls the platform adapter, records an attempt, and updates job state. Controlled application retries are fresh delayed messages; the current delivery is acknowledged only after that send succeeds.
- **Scheduled reconciler, watchdog, and token refresh** — a Cron Trigger backs up automatic mode, recovers stale claims, re-enqueues due D1 jobs, checks both the primary queue and dead-letter queue (DLQ), and refreshes provider tokens before they expire (see [Token lifecycle](#token-lifecycle)). Divine web/mobile should still push a newly published event after a successful publish.

D1 is the source of truth for connection state, preferences, idempotent job creation, retry state, and an append-only attempt history. The Worker does not transcode video; if a platform needs media normalization later, that belongs in a separate service.

### How it fits Divine

- **Auth** proves which Nostr pubkey is calling. The preferred credential is a [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) signed HTTP-auth event, verified locally, so any Nostr signer (local key, bunker, Amber, Keycast) works and the Worker never holds a credential that can sign on the user's behalf. Older app builds send a Keycast (`login.divine.video`) OAuth bearer token instead, which the Worker validates by calling Keycast `POST /api/nostr` with `{"method":"get_public_key","params":[]}`; that path stays supported. See [Authentication](#authentication).
- **Video ownership and eligibility** come from Funnelcake (`api.divine.video`). Crosspost creation verifies the Divine video event belongs to the authenticated pubkey and is eligible before queueing work.

## Getting started

Install dependencies:

```bash
npm install
```

Run the Worker locally:

```bash
npm run dev
```

Run with scheduled-trigger testing enabled, then fire the scheduled handler:

```bash
npm run dev:scheduled
curl "http://localhost:8787/cdn-cgi/handler/scheduled?format=json"
```

Typecheck and test:

```bash
npm run typecheck
npm run test:once
```

Apply migrations to the local development database (no Cloudflare resources need creating):

```bash
npx wrangler d1 migrations apply DB --local
```

The initial schema (`migrations/0001_initial.sql`) creates `oauth_states`, `connections`, `preferences`, `auto_cursors`, `jobs`, and `job_attempts`.

## Configuration

The committed `wrangler.toml` is local-only: a placeholder D1 ID, local queue names, no production route, and no scheduled triggers. The historical production Worker name is `divine-crossposter`; its successor configuration belongs in Connections. Do not add production identifiers to this checkout.

### Bindings

| Binding | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 database | Service-owned state (local database). |
| `CROSSPOST_QUEUE` | Queue producer | Enqueues publish jobs onto `divine-crossposter-local-jobs`. |
| `CROSSPOST_DLQ` | Queue producer/metrics binding | Reads aggregate backlog metrics for `divine-crossposter-local-jobs-dlq`. |

The same Worker is the queue consumer, configured with `max_batch_size = 10`, `max_batch_timeout = 30`, five native retries, and `divine-crossposter-local-jobs-dlq` as its dead-letter queue. Scheduled handlers can be invoked locally with `npm run dev:scheduled`; this config registers no cron.

### Variables

Non-secret `[vars]` in `wrangler.toml`:

| Variable | Purpose |
| --- | --- |
| `KEYCAST_URL` | Base URL for Keycast bearer-token validation. Currently `https://login.divine.video`. |
| `FUNNELCAKE_URL` | Base URL for Funnelcake event/video lookups. Currently `https://api.divine.video`. |
| `OAUTH_REDIRECT_BASE` | Public Worker origin used to build OAuth callback URLs. Locally `http://localhost:8787`. |
| `ENABLE_INSTAGRAM` / `ENABLE_TIKTOK` / `ENABLE_X` / `ENABLE_YOUTUBE` | Set to `true` to expose a platform, only after its OAuth credentials are configured. All platforms are disabled in the committed local config. |
| `INSTAGRAM_CLIENT_ID` | Meta app id used for Instagram OAuth. |
| `YOUTUBE_DEFAULT_PRIVACY_STATUS` | Optional. One of `private`, `public`, or `unlisted`; defaults to `private`. |

### Secrets

For local development, put test credentials in a gitignored `.dev.vars` file. Never copy production credentials here. Provider secret names are listed below. Production credential changes belong to the Connections release procedure; Wrangler secret updates can deploy a Worker version.

`TOKEN_ENCRYPTION_KEY` must be at least 32 characters. It encrypts provider access and refresh tokens before they are stored in D1. Do not log OAuth codes, callback URLs containing codes, access tokens, refresh tokens, client secrets, or decrypted token values.

A platform is reported as enabled only when both its `ENABLE_*` flag is `true` and its credential pair is present: Instagram needs `INSTAGRAM_CLIENT_ID` + `INSTAGRAM_CLIENT_SECRET`, TikTok needs `TIKTOK_CLIENT_KEY` + `TIKTOK_CLIENT_SECRET`, X needs `TWITTER_CLIENT_ID` + `TWITTER_CLIENT_SECRET`, and YouTube needs `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`.

### OAuth callbacks

Register one callback URL per platform against the public `OAUTH_REDIRECT_BASE`:

```text
${OAUTH_REDIRECT_BASE}/connections/instagram/callback
${OAUTH_REDIRECT_BASE}/connections/tiktok/callback
${OAUTH_REDIRECT_BASE}/connections/x/callback
${OAUTH_REDIRECT_BASE}/connections/youtube/callback
```

Provider notes:

- Instagram Reels uses Meta content publishing: create a Reels media container from a public video URL, wait for processing, then publish.
- TikTok Direct Post requires publish consent and may require app review before public posting.
- X uses OAuth 2.0 plus chunked media upload before post creation. In the X Developer Portal, configure the production application as an **OAuth 2.0 confidential web application** with **Read and write** permission, callback `https://crossposter.divine.video/connections/x/callback`, and scopes `tweet.read tweet.write users.read media.write offline.access`. The portal client ID and client secret must be the pair installed as the `TWITTER_CLIENT_ID` and `TWITTER_CLIENT_SECRET` Worker secrets.
- YouTube Shorts uses the YouTube Data API upload flow; Shorts classification depends on video format, duration, and metadata conventions.

## Authentication

Every authenticated route accepts either header. Both resolve to the caller's full hex pubkey.

### NIP-98 (preferred)

```
Authorization: Nostr <base64(JSON of a signed kind-27235 event)>
```

The base64 uses the standard alphabet (RFC 4648 §4) over the UTF-8 event JSON. Send it with its `=` padding; a header with the padding removed is also accepted. The URL-safe alphabet (`-` and `_`) is not accepted and answers `401`. The Worker checks, and answers `401 unauthorized` if any check fails:

- `kind` is `27235`, and `id` and the BIP-340 Schnorr `sig` are valid for `pubkey`.
- `created_at` is within 60 seconds of server time, in either direction.
- The `u` tag is the exact absolute request URL: scheme, host, path, and the query string byte-for-byte in the same order, e.g. `https://crossposter.divine.video/videos/<event_id>/crossposts`. Both URLs go through standard URL parsing first, so host letter case and an explicit default port do not matter and a fragment is ignored; otherwise the path and query must match, so a missing, extra, or reordered query parameter fails. Sign the same URL string you send.
- The `method` tag equals the HTTP method (`GET`, `POST`, `PUT`, `DELETE`).
- When the request has a non-empty body, a `payload` tag with the lowercase hex SHA-256 of the exact body bytes is required. A `payload` tag that is present is always checked, so signing `sha256("")` on a bodyless `POST` is fine.

Replay: there is no per-event-id replay store. A header is accepted while its `created_at` is within 60 seconds of server time in either direction, so a signer whose clock runs ahead can produce one that stays valid for up to two minutes, and it is only valid for the identical URL, method, and body. A replay store fits NIP-98 poorly: events carry no nonce and `created_at` has one-second resolution, so identical requests signed in the same second share an event id, and a per-event-id store would reject those legitimate repeats as well as cost a D1 write on every authenticated request. Send requests over HTTPS. Production redirects plain HTTP at the Cloudflare edge, but the Worker itself does not refuse an event signed for an `http://` URL.

### Keycast bearer token

```
Authorization: Bearer <Keycast access token>
```

Validated by calling Keycast `POST /api/nostr` `get_public_key`. The setup page and app builds that predate NIP-98 signing still send it. New clients should send NIP-98 instead, because this token can sign arbitrary events for the user.

## Routes

Public:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Self-contained setup UI: Divine login, connect platforms, set posting switches. |
| `GET` | `/health` | Liveness JSON: `{ "ok": true, "service": "divine-crossposter" }`. |
| `GET` | `/platforms` | Provider readiness. HTML by default; JSON via `?format=json` or `Accept: application/json`. |
| `GET` | `/connections/:platform/callback` | OAuth callback, reached by the provider's redirect, which carries no `Authorization` header; the stored `state` identifies the attempt. Exchanges the provider code, stores encrypted tokens, and redirects to the stored return URL. |

Authenticated routes require one of the credentials described under [Authentication](#authentication):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/connections` | List connected external accounts for the authenticated Divine pubkey. |
| `POST` | `/connections/:platform/start` | Create OAuth state and return an authorization URL. Body: `{ "returnUrl": "https://..." }`. |
| `DELETE` | `/connections/:platform/:connection_id` | Disconnect a platform account and stop future crossposts for it. |
| `GET` | `/preferences` | List per-platform posting preferences. |
| `PUT` | `/preferences/:platform` | Set `manual`, `automatic`, or `disabled` mode for a platform. |
| `POST` | `/videos/:event_id/crossposts` | Create or return idempotent manual crosspost jobs for selected platforms. |
| `POST` | `/videos/:event_id/auto-crosspost` | Client push path after a successful Divine publish; creates jobs for automatic-mode platforms. |
| `GET` | `/videos/:event_id/crossposts` | Read crosspost jobs for a Divine video. |
| `GET` | `/jobs/:job_id` | Read one job and its attempt history. |

Clients see connection summaries, preferences, job summaries, normalized statuses, and external post IDs/URLs after success; platform OAuth and publishing internals stay server-side.

## Job lifecycle

Job statuses: `queued`, `uploading`, `dispatching`, `processing`, `posted`, `failed`, `needs_reauth`, `skipped`.

Normalized error codes: `rate_limited`, `needs_reauth`, `media_rejected`, `platform_review_required`, `processing_timeout`, `expired`, `not_connected`, `not_owner`, `not_eligible`, `unknown_platform_error`, `ambiguous_post_result`.

- Transient provider failures and processing polls use bounded application backoff: Crossposter sends a fresh delayed queue message, then acknowledges the current delivery. `message.retry()` is not used. Only unexpected infrastructure failures or a failed fresh-message send remain unacknowledged; Cloudflare retries those deliveries at most five times before moving them to the DLQ.
- Scheduled reconciliation recovers a stale X `uploading` claim only while the job is unexpired and the incremented retry count remains within the retry budget. An expired claim becomes `skipped`; a claim that exhausts the retry budget remains terminal `failed` with no `nextRetryAt`. A stale X `dispatching` claim has an unknown external outcome, so it becomes terminal `ambiguous_post_result` and requires manual reconciliation; it is never automatically reposted.
- If token refresh or publishing returns an auth failure, the connection and job are marked `needs_reauth`; automatic jobs for that platform stop until the user reconnects. Manual retry after reconnect reuses the existing job where possible and preserves attempt history.
- Disconnecting relies on local D1 state to stop future Divine-initiated crossposts. Provider revocation, where supported, is called best-effort; a failed revocation does not keep local crossposting enabled.

## Token lifecycle

Provider tokens are refreshed before they expire, not after, because some cannot be refreshed once dead. The policy lives in `src/services/token-refresh.ts`.

| Platform | Token | Refreshed when |
| --- | --- | --- |
| Instagram | Long-lived token, 60 days, refreshed with itself (`ig_refresh_token`). Meta only refreshes it while it is still valid and at least 24 hours old; an expired one needs a reconnect. | By the scheduled sweep and at publish time, once it expires within 7 days and was issued at least 24 hours ago. |
| X, TikTok, YouTube | Short-lived access token plus a separate refresh token that stays usable after the access token expires (X rotates its refresh token on every use). | Only at publish time, once it expires within 60 seconds. |

- **Scheduled sweep.** Every cron tick refreshes connected Instagram tokens that are inside the window, soonest expiry first, at most 25 per tick. The short-lived providers are left out on purpose: sweeping them would refresh every idle connection every couple of hours, race publishes for X's single-use refresh tokens, and retry every minute on errors that are not clearly a dead credential. One connection's failure never stops the others; a transient failure is retried on a later tick.
- **At publish time.** The queue consumer applies the same per-platform policy before publishing. If an early refresh fails transiently while the stored token still works, the publish goes ahead with the stored token.
- **Dead credentials.** A provider answer that means the user's credential is dead — HTTP 401/403, a Meta `OAuthException` with code 190 or 102 (Meta sends these with HTTP 400), or an OAuth `invalid_grant`/`invalid_token` — maps to `needs_reauth`. An OAuth `invalid_client`/`unauthorized_client` is the app's own credentials failing, not the user's, so it never does, even on HTTP 401. The connection is flagged `needs_reauth`, `GET /connections` reports it, and the app prompts the user to reconnect instead of every crosspost failing as `unknown_platform_error`.
- **Concurrency.** Refreshed tokens are stored only if the connection still holds the token the refresh started from, and a rejected refresh does not flag a connection whose token was replaced in the meantime by a reconnect or another refresh. When two refreshes race and the loser flags the connection before the winner writes, the winner's freshly issued tokens restore it to `connected`; a disconnect is never undone.

## Deployment transition

This branch removes legacy deployment automation. CI runs typechecking and tests only; it does not deploy or send webhook alerts. `npm run deploy` refuses deployment, including when arguments are supplied. The Wrangler config retains local bindings for tests but no production Worker name, route, database ID, queue names, or cron. These safeguards do not revoke credentials or prevent someone explicitly targeting production with CLI arguments or an older checkout.

**Hold the retirement PR until Connections has deployed successfully.** As verified on 2026-10-28, [Connections PR #48](https://github.com/divinevideo/divine-connections/pull/48) is merged, but the public health endpoint still identifies the legacy `divine-crossposter` service. Merging code alone does not demonstrate the cutover.

The platform operator must complete and record this sequence before merging retirement:

1. Have an organization administrator grant Connections access to the production Cloudflare deployment credential. Check organization-secret selected repositories as well as repository and environment secrets; an empty repository-secret list does not establish absence of credentials.
2. Release Connections using its [deployment documentation](https://github.com/divinevideo/divine-connections#deployment) and [reliability runbook](https://github.com/divinevideo/divine-connections/blob/main/docs/plans/2026-10-24-crossposting-reliability.md). Verify successful migration, deployment, release-SHA smoke tests, readiness, and the live provider endpoint. Record the release and run URLs on the retirement PR. If release fails, keep this PR unmerged and follow Connections rollback guidance.
3. Remove this repository from the Cloudflare deployment credential's selected repositories and remove its obsolete GitHub production environment. Verify credentials cannot be supplied through repository, environment, or organization secrets. This administrator change is the enforcement boundary for old checkouts and explicit CLI overrides.
4. Merge this retirement only after the successful release and access removal are verified.

Production deployments, migrations, provider-secret changes, alert tests, queue operations, and rollback must use the Connections procedures. The previous instructions in this README are retired; there is no supported manual or non-production remote deployment from this repository. Use `npm run dev` for local work.

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)

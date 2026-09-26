# X Crossposter Recovery Design

## Purpose

Restore the production Divine-to-X path from provider authorization through a confirmed video post, and make future failures diagnosable. The first success criterion is one real creator authorizing X and one eligible Divine video reaching X with a durable `posted` job record and external post ID.

This repair is intentionally limited to the standalone Crossposter flow. Divine mobile and web integration will follow only after the service can complete the core path reliably.

## Current Evidence

- Production D1 contains 13 unconsumed OAuth starts, zero connections, zero preferences, zero jobs, and zero attempts.
- PR #10 shipped with Instagram dashboard configuration incomplete and the X callback allowlist unverified.
- X requires an exact callback URL match. Production must allowlist `https://crossposter.divine.video/connections/x/callback`.
- The current X adapter uses `/{mediaId}/append` and `/{mediaId}/finalize` JSON requests. X's current v2 chunked upload API requires `INIT`, `APPEND`, and `FINALIZE` multipart/form requests to the same `/2/media/upload` endpoint.
- The production GitHub Actions deploy fails before deployment because `CLOUDFLARE_API_TOKEN` is invalid or revoked.
- OAuth callback exceptions are currently collapsed into a generic redirect, so exchange and account lookup failures leave no durable operational evidence.
- The queue consumer has no dead-letter queue. Repeated unhandled deliveries can therefore be discarded after Cloudflare's retry limit.

## Scope

### In scope

1. Bring X OAuth configuration and implementation into compliance with the current X OAuth 2.0 Authorization Code with PKCE flow.
2. Correct X chunked video upload and post creation.
3. Persist a sanitized OAuth lifecycle so operators can distinguish abandonment, provider denial, token exchange failure, account lookup failure, and success.
4. Expire abandoned OAuth attempts during the scheduled reconciliation pass.
5. Configure a queue dead-letter queue and document the operational check for it.
6. Restore automated production deployment with a valid, narrowly scoped Cloudflare API token.
7. Configure proactive notification for GitHub deployment failure and Cloudflare Worker/queue failure.
8. Complete one real X authorization and one real Divine-video crosspost.

### Out of scope

- Instagram, TikTok, and YouTube repair.
- Divine mobile or web settings UI and publish callbacks.
- Video transcoding or format conversion.
- Automatic deletion of the end-to-end verification post.
- Storing OAuth authorization codes, access tokens, refresh tokens, client secrets, raw provider bodies, or Nostr private keys in diagnostic records or logs.

## Architecture

The existing Worker, D1 database, queue, and scheduled reconciler remain the service boundary. The repair adds a small OAuth-attempt repository beside `oauth_states`, updates the X adapter to the documented provider protocol, and adds queue/deployment operations without introducing another runtime service. X post creation also gains a durable dispatch fence: before the adapter sends `POST /2/tweets`, it must await a publisher callback that moves the job from `uploading` to `dispatching`. This makes a crash or ambiguous transport result fail closed instead of creating a duplicate tweet on automatic retry.

The user flow remains:

1. A Divine-authenticated creator starts an X connection.
2. Crossposter creates a short-lived OAuth state and a durable sanitized attempt record.
3. The browser visits X with PKCE and the exact production callback URL.
4. X redirects to Crossposter; Crossposter consumes the state, exchanges the code, reads the X account, encrypts tokens, creates the connection and manual preference, and marks the attempt connected.
5. The creator requests a manual crosspost for an eligible Divine video.
6. The queue consumer downloads the source media, performs X's chunked upload protocol, creates the X post, and records the external post ID.

## X Provider Configuration

The X Developer Portal application must be configured as an OAuth 2.0 confidential web application with read and write access. Its exact production callback URL is:

```text
https://crossposter.divine.video/connections/x/callback
```

The requested scopes remain:

```text
tweet.read tweet.write users.read media.write offline.access
```

The portal client ID and client secret must match the `TWITTER_CLIENT_ID` and `TWITTER_CLIENT_SECRET` Worker secrets. Portal configuration is a human checkpoint because provider dashboard credentials are not readable from the Worker.

## OAuth Attempt Lifecycle

Migration `0002_oauth_attempts.sql` adds an internal `oauth_attempts` table. It stores:

- an opaque attempt ID;
- the full creator pubkey, consistent with Divine's rule never to truncate Nostr identifiers;
- platform;
- lifecycle status;
- sanitized failure code;
- provider HTTP status when available;
- creation, expiration, and update timestamps.

The lifecycle statuses are:

```text
started
provider_denied
callback_failed
token_exchange_failed
account_lookup_failed
storage_failed
connected
expired
```

`oauth_states.metadata_json` links the short-lived state to the opaque attempt ID. Unknown callback states are not persisted, preventing attacker-controlled state values from becoming durable data.

Every known callback transition updates the attempt before redirecting. Connection, preference, and `connected`-attempt writes execute as one D1 batch so a storage failure cannot leave a partial active connection; a failed batch is followed by a best-effort `storage_failed` transition. Logs contain only structured fields safe for operations: event name, attempt ID, platform, lifecycle status, sanitized failure code, and provider HTTP status. A failed provider request adds a `providerError` object built from an allowlist: the failing endpoint's origin and path (no query; a path segment that is not a known API path word or a short version segment is replaced), the provider's error type, numeric code and subcode, a trace id, and the error message capped at 300 characters with URLs, `key=value` secrets, and token-like runs redacted. A value of 8 or more characters after a label such as `code`, `token`, or `client secret` is redacted when it has a digit, an uppercase letter, or 20 or more characters, even when it looks like a scope name. An unlabeled run of 20 or more token-alphabet characters is redacted unless it is under 40 characters and is either a scope name (every underscore-separated piece is 2 to 12 lowercase letters) or an error type name such as `GraphMethodException`. No other body field is copied. Logs never contain a state value, pubkey, callback query string, authorization code, access token, refresh token, secret, or raw provider response.

The scheduled reconciler marks overdue `started` attempts `expired` and deletes their expired OAuth states. This turns abandoned flows into measurable outcomes and prevents the stale-state buildup visible in production today.

## X OAuth Behavior

The authorization request retains PKCE S256, a random state, the exact redirect URI, and the required scopes. Token and refresh requests explicitly send `application/x-www-form-urlencoded`; confidential-client authentication uses HTTP Basic authentication.

Provider failures are classified at the boundary:

- an explicit user/provider denial becomes `provider_denied`;
- any other consumed callback that cannot safely proceed (missing code, non-denial provider error, route/state mismatch, or provider disabled after start) becomes `callback_failed` with no provider text retained;
- a non-success token response becomes `token_exchange_failed`; the attempt keeps only the HTTP status, and the transition log adds the allowlisted `providerError` described above;
- a non-success `/2/users/me` response or an empty user ID becomes `account_lookup_failed`;
- an encryption or atomic persistence failure becomes `storage_failed` without leaving a partial active connection;
- a fully stored encrypted connection becomes `connected`.

The browser receives a safe failure reason suitable for retry guidance. Provider internals stay server-side.

## X Video Upload Behavior

The adapter follows X's v2 chunked media upload sequence:

1. `INIT`: multipart/form request to `POST https://api.x.com/2/media/upload` with `command=INIT`, `total_bytes`, `media_type`, and `media_category=tweet_video`.
2. `APPEND`: split the source bytes into bounded chunks. For each chunk, send multipart/form data to the same endpoint with `command=APPEND`, `media_id`, `segment_index`, and a binary `media` part.
3. `FINALIZE`: multipart/form request to the same endpoint with `command=FINALIZE` and `media_id`.
4. `STATUS`: if `processing_info` exists, poll `GET /2/media/upload?command=STATUS&media_id=...` after the provider-supplied delay or the existing bounded service backoff.
5. Dispatch fence: after media processing succeeds, await the publisher's durable `beforeExternalPost` callback, which changes the job status to `dispatching`.
6. Post: only after that fence commits, call `POST /2/tweets` with the caption and media ID.

An X processing state of `failed` is terminal and records a normalized provider failure rather than polling until timeout. `pending` and `in_progress` remain retryable. When `processing_info` is present, only an explicit `succeeded` state permits post creation; a missing or unknown state fails closed through the bounded normalized-error path. A FINALIZE response with no `processing_info` remains the provider's synchronous-success case. A successful post stores the full external post ID and canonical `https://x.com/i/web/status/{id}` URL.

The dispatch fence deliberately favors avoiding duplicate public posts over automatic recovery. A provider or transport failure after the fence, a successful response without a post ID, or a stale `dispatching` job becomes terminal `failed` with `ambiguous_post_result` and no retry timestamp. Operators reconcile that job against the X account before deciding on any manual retry. A stale X `uploading` claim is different: because the dispatch fence has not run, the scheduled reconciler may return it to the normal retry lifecycle after a five-minute lease. Other platforms are not included in this lease recovery change.

Provider responses are treated as untrusted and potentially sensitive. The publisher persists only an allowlisted polling checkpoint for each platform (for X: media ID and caption while processing); it persists no X checkpoint for a posted result and no raw success or error body. Provider HTTP status and normalized error code remain available for diagnosis. The authenticated job API therefore cannot disclose provider internals through `job_attempts`.

## Queue Reliability

Create `divine-crossposter-jobs-dlq` and configure the production consumer with `max_retries = 5` and `dead_letter_queue = "divine-crossposter-jobs-dlq"`. Handled provider delays and retryable failures enqueue a fresh delayed message and acknowledge the current delivery, so they do not consume Cloudflare's native retry budget. Scheduled reconciliation also re-enqueues due `processing` jobs, recovering a failed delayed-send handoff without polling early. The DLQ captures only unhandled deliveries outside that controlled lifecycle.

The deployment runbook checks that the primary queue has one producer and one consumer and that the DLQ exists. A `CROSSPOST_DLQ` binding exposes DLQ metrics to the scheduled handler. The handler reads both queue metrics after reconciliation and sends a sanitized alert to an `OPS_ALERT_WEBHOOK_URL` secret when the DLQ is non-empty. Primary staleness is determined from D1, not the queue's oldest-message timestamp: runnable `queued`, `failed`, or `processing` jobs whose due time is more than 15 minutes overdue are stale, while intentionally delayed future jobs are healthy. Alert payloads contain aggregate counts, timestamps, and service identifiers only.

Migration `0003_operations_alert_tests.sql` adds a one-shot `operations_alert_tests` control table. There is no public test endpoint. An authorized operator inserts an opaque test request with a remote D1 command; on the next cron, the deployed handler must successfully read both queue metrics, emit a sanitized `notification_test` through the real webhook, and mark the request consumed only after the webhook accepts it. This safely proves the deployed Worker, D1, cron, queue-metrics bindings, webhook secret, and destination without injecting or purging production queue messages.

Cloudflare HTTP/Worker error notification covers unhandled invocation failures that the Worker cannot report itself. An authorized operator must query the account's eligible alert types, create or verify an enabled Worker/edge-error policy scoped as narrowly as Cloudflare permits, and verify its destination and receipt without recording destination credentials. A separate GitHub Actions notification job observes both test and deploy job results, so test failure cannot skip notification. The webhook, Cloudflare notification, and GitHub notification destinations are external production settings and must each be verified deliberately.

## Deployment Recovery

GitHub Actions keeps the existing test-then-deploy structure. A repository, production-environment, or selected-organization `CLOUDFLARE_API_TOKEN` must be replaced with a valid token scoped only to the Divine account. Its permission summary must contain Account Settings Read, Workers Scripts Edit, D1 Edit, Queues Edit, and Workers Routes Edit restricted to the `divine.video` zone. Unrelated accounts, zones, and products must not be granted.

Deployment acceptance requires:

1. typecheck and all tests pass;
2. remote D1 migrations apply;
3. Worker deployment succeeds;
4. queue and DLQ bindings are present in the deployed version;
5. production smoke tests pass;
6. the GitHub Actions run is green;
7. the operations webhook test is received;
8. Cloudflare Worker error and GitHub Actions failure notifications are confirmed.

Before replacing X credentials or enabling production traffic, deploy and record an approved safety Worker version containing the repaired code, D1/DLQ bindings, and `ENABLE_X=false`. This is an active deployment, not an upload-only version, so its bindings, cron, and queue policy can be verified before credentials change. Only after that disabled deployment is healthy are the known matching X secrets replaced. Merging the approved commit then lets the normal CI deployment activate `ENABLE_X=true`. An X-path incident pauses primary queue delivery and rolls back to the safety version, preserving operational bindings without allowing authorization or posting. The pre-deploy production version and source commit are also recorded for audit.

Manual Wrangler deployment using a developer OAuth session may be used to validate the repair before CI is restored, but it does not satisfy the deployment acceptance criteria.

## Testing

Tests are written before implementation changes.

### OAuth tests

- starting X OAuth creates both state and `started` attempt records;
- provider denial records `provider_denied` and returns a safe redirect reason;
- non-denial provider errors and missing-code callbacks record `callback_failed` without provider text;
- token exchange failure records only the sanitized class and HTTP status, and logs only the allowlisted, redacted `providerError` fields;
- account lookup failure is distinct from token exchange failure;
- encryption or persistence failure records `storage_failed` and leaves no partial active connection;
- success atomically stores the encrypted connection and manual preference and marks the attempt connected;
- scheduled housekeeping expires abandoned attempts and deletes stale states;
- callback logs contain none of the forbidden sensitive values.

### X adapter tests

- authorization URL contains the exact redirect URI, state, PKCE S256 challenge, and scopes;
- token requests have form encoding and confidential-client authentication;
- a 2xx token response without a nonempty access token is rejected at token exchange;
- upload uses the same `/2/media/upload` endpoint for INIT, every APPEND, and FINALIZE;
- APPEND uses multipart binary chunks with sequential indices;
- a missing INIT media ID or created-post ID is rejected and cannot produce a `posted` job;
- the durable dispatch fence commits before `/2/tweets`; a post-dispatch transport error or missing post ID becomes terminal `ambiguous_post_result` and is never automatically retried;
- pending processing schedules a poll;
- malformed or unknown processing state cannot create a post;
- failed processing becomes terminal;
- successful processing creates a post and returns the external ID and URL.
- processing, failure, and posted attempts contain only allowlisted polling fields and never raw provider bodies.

### Regression and verification

- full unit and route suite;
- queue-handler integration proving controlled processing uses fresh delayed sends/acks and exhausts its bounded job lifecycle without native retries or a stranded processing job;
- recovery tests proving a stale X `uploading` claim is requeued after its lease, a stale `dispatching` claim is terminal ambiguous, and no path invokes `/2/tweets` twice;
- terminal polling errors produce terminal `failed` attempts rather than misleading `processing` attempts;
- future delayed jobs do not trigger backlog alerts, while jobs overdue by more than 15 minutes do;
- a production one-shot operations test is consumed only after both queue metric reads and a successful webhook receipt;
- TypeScript typecheck;
- remote migration dry run or apply through the deployment job;
- live `/health` and `/platforms?format=json` smoke checks;
- real browser authorization using an X test account;
- one manual crosspost using an existing eligible Divine video through the setup page's existing authenticated API helper, without copying its bearer token;
- production D1 verification that the attempt is connected and the job is posted, using aggregate or targeted safe queries without printing pubkeys or tokens.

## Human Checkpoints

Two steps require Rabble or another authorized operator:

1. In the X Developer Portal, verify the application type, write permission, scopes, and exact callback URL, then complete the consent flow with the chosen X test account.
2. Replace or authorize the GitHub Actions Cloudflare token if the current GitHub identity cannot manage the relevant organization secret.

Implementation may proceed through local and manual production validation while those checkpoints are pending. The task is not complete until both checkpoints and the real post succeed.

## Acceptance Criteria

- X authorization completes and leaves one active production connection.
- A real eligible Divine video is posted to X by Crossposter.
- The production job reaches `posted` with an external post ID and URL.
- The active X connection and nonempty canonical external ID/URL are verified with safe boolean/count queries.
- No secret, OAuth code, token, callback query string, raw provider body, or private key appears in logs or diagnostic tables.
- Abandoned and failed OAuth attempts are distinguishable in D1 by sanitized lifecycle state.
- The X upload sequence matches the current official v2 chunked-upload protocol.
- The queue has a DLQ and bounded retry configuration.
- The latest `main` GitHub Actions test and deploy jobs are green.
- The primary queue has one producer and one consumer configured with five retries and the named DLQ.
- Build/deployment, Worker-error, queue-backlog, and DLQ notifications are configured and test-confirmed.
- X post dispatch is fenced durably; ambiguous post results require manual reconciliation and are never automatically retried.

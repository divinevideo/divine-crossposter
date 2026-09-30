# X Crossposter Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make one real Divine-to-X authorization and video crosspost succeed in production, with durable OAuth diagnostics, correct X v2 chunked upload, reliable deployment, and actionable failure signals.

**Architecture:** Keep the existing Cloudflare Worker, D1, Queue, and Cron boundaries. Add an OAuth-attempt repository with atomic connection completion, correct and validate the X adapter at the provider boundary, durably fence X post dispatch to prevent duplicate tweets after ambiguous failures, allowlist persisted polling checkpoints, add a DLQ plus D1-aware scheduled watchdog, and restore the existing GitHub Actions deployment path.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1, Cloudflare Queues, Vitest Workers pool, Wrangler, GitHub Actions, X OAuth 2.0 PKCE, X API v2.

---

## File map

New files:

- migrations/0002_oauth_attempts.sql — durable sanitized OAuth lifecycle schema.
- migrations/0003_operations_alert_tests.sql — one-shot production watchdog-test requests.
- src/db/oauth-attempts.ts — OAuth attempt creation, transition, retrieval, and expiry.
- src/db/oauth-attempts.test.ts — repository tests.
- src/services/operations.ts — queue/DLQ watchdog and sanitized webhook.
- src/services/operations.test.ts — watchdog tests.
- src/index.queue.test.ts — controlled-delay versus native-retry integration.

Modified files:

- src/types.ts — attempt types and operations bindings.
- src/db/connections.ts — atomic connection, preference, and attempt completion.
- src/services/connections.ts and src/routes/connections.test.ts — callback lifecycle and tests.
- src/routes/health.ts and src/index.test.ts — safe classified failure copy and UI assertions.
- src/services/reconciler.ts and its test — abandoned-flow housekeeping.
- src/platforms/x.ts and src/platforms/providers.test.ts — current OAuth and upload protocol.
- src/services/publisher.ts and src/services/publisher.test.ts — allowlisted provider checkpoints.
- src/platforms/adapter.ts — optional durable pre-dispatch callback used by X.
- src/services/crossposts.ts and src/routes/crossposts.test.ts — authenticated job API exposure regression.
- src/index.ts — scheduled watchdog.
- src/db/jobs.ts and src/db/jobs.test.ts — scheduled recovery for due processing jobs.
- src/db/operations.ts and src/db/operations.test.ts — overdue-job counts and one-shot alert-test controls.
- wrangler.toml — DLQ binding and retry policy.
- .github/workflows/ci-deploy.yml — X smoke test and failure notification.
- README.md — provider and operations runbook.

Dependency order:

    WU-1 OAuth repository -> WU-2 callback lifecycle
    WU-3 X OAuth -> WU-4 X media upload
    WU-5 queue operations
    WU-1 through WU-5 -> WU-6 production proof

## WU-1: Persist sanitized OAuth attempts

**Files:**

- Create: migrations/0002_oauth_attempts.sql
- Create: src/db/oauth-attempts.ts
- Create: src/db/oauth-attempts.test.ts
- Modify: src/types.ts:46

- [ ] **Step 1: Write the failing repository tests**

Create src/db/oauth-attempts.test.ts with these complete cases:

    import { beforeEach, describe, expect, it } from 'vitest'
    import { applyMigrations, PUBKEY_A } from './test-helpers'
    import { createOAuthAttempt, expireStartedOAuthAttempts, getOAuthAttempt, updateOAuthAttempt } from './oauth-attempts'

    describe('oauth attempts', () => {
      let db: D1Database

      beforeEach(async () => {
        db = await applyMigrations()
      })

      it('creates and transitions a sanitized attempt', async () => {
        await createOAuthAttempt(db, {
          id: 'attempt_1',
          pubkey: PUBKEY_A,
          platform: 'x',
          status: 'started',
          failureCode: null,
          providerStatus: null,
          createdAt: 1000,
          expiresAt: 1600,
          updatedAt: 1000,
        })
        await updateOAuthAttempt(db, {
          id: 'attempt_1',
          status: 'token_exchange_failed',
          failureCode: 'token_exchange_failed',
          providerStatus: 401,
          updatedAt: 1100,
        })
        await expect(getOAuthAttempt(db, 'attempt_1')).resolves.toMatchObject({
          platform: 'x',
          status: 'token_exchange_failed',
          failureCode: 'token_exchange_failed',
          providerStatus: 401,
        })
      })

      it('expires only overdue started attempts', async () => {
        for (const value of [
          { id: 'expired', status: 'started' as const, expiresAt: 1100 },
          { id: 'active', status: 'started' as const, expiresAt: 2000 },
          { id: 'connected', status: 'connected' as const, expiresAt: 1100 },
        ]) {
          await createOAuthAttempt(db, {
            ...value,
            pubkey: PUBKEY_A,
            platform: 'x',
            failureCode: null,
            providerStatus: null,
            createdAt: 1000,
            updatedAt: 1000,
          })
        }
        await expect(expireStartedOAuthAttempts(db, 1200)).resolves.toBe(1)
        await expect(getOAuthAttempt(db, 'expired')).resolves.toMatchObject({ status: 'expired', updatedAt: 1200 })
        await expect(getOAuthAttempt(db, 'active')).resolves.toMatchObject({ status: 'started' })
        await expect(getOAuthAttempt(db, 'connected')).resolves.toMatchObject({ status: 'connected' })
      })
    })

- [ ] **Step 2: Run RED**

    npx vitest run src/db/oauth-attempts.test.ts

Expected: FAIL because src/db/oauth-attempts.ts does not exist.

- [ ] **Step 3: Add schema and types**

Create migrations/0002_oauth_attempts.sql:

    CREATE TABLE oauth_attempts (
      id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_code TEXT,
      provider_status INTEGER,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX idx_oauth_attempts_status_expires
      ON oauth_attempts(status, expires_at);
    CREATE INDEX idx_oauth_attempts_platform_updated
      ON oauth_attempts(platform, updated_at);

Add to src/types.ts:

    export type OAuthAttemptStatus =
      | 'started'
      | 'provider_denied'
      | 'callback_failed'
      | 'token_exchange_failed'
      | 'account_lookup_failed'
      | 'storage_failed'
      | 'connected'
      | 'expired'

    export type OAuthAttemptFailureCode =
      Exclude<OAuthAttemptStatus, 'started' | 'connected' | 'expired'>

    export type OAuthAttemptRecord = {
      id: string
      pubkey: string
      platform: Platform
      status: OAuthAttemptStatus
      failureCode: OAuthAttemptFailureCode | null
      providerStatus: number | null
      createdAt: number
      expiresAt: number
      updatedAt: number
    }

    export type UpdateOAuthAttemptInput =
      Pick<OAuthAttemptRecord, 'id' | 'status' | 'failureCode' | 'providerStatus' | 'updatedAt'>

- [ ] **Step 4: Implement repository**

Create src/db/oauth-attempts.ts using runPrepared, firstPrepared, and changes from src/db/client.ts. Implement these exact signatures:

    createOAuthAttempt(db: D1Database, input: OAuthAttemptRecord): Promise<void>
    getOAuthAttempt(db: D1Database, id: string): Promise<OAuthAttemptRecord | null>
    updateOAuthAttempt(db: D1Database, input: UpdateOAuthAttemptInput): Promise<void>
    expireStartedOAuthAttempts(db: D1Database, now: number): Promise<number>

The expiry query is:

    UPDATE oauth_attempts
    SET status = 'expired', failure_code = NULL, provider_status = NULL, updated_at = ?
    WHERE status = 'started' AND expires_at < ?

Map every snake_case column to the camelCase record, as existing D1 repositories do.

- [ ] **Step 5: Run GREEN and commit**

    npx vitest run src/db/oauth-attempts.test.ts src/db/oauth-states.test.ts
    npm run typecheck
    git add migrations/0002_oauth_attempts.sql src/types.ts src/db/oauth-attempts.ts src/db/oauth-attempts.test.ts
    git commit -m "feat: persist OAuth attempt lifecycle"

Expected: focused tests PASS and typecheck exits 0.

## WU-2: Classify callbacks and expire abandoned starts

**Files:**

- Modify: src/db/connections.ts:1-136
- Modify: src/services/connections.ts:77-262
- Modify: src/routes/connections.test.ts:45-260
- Modify: src/routes/health.ts:935-944
- Modify: src/index.test.ts:17-51
- Modify: src/services/reconciler.ts:15-107
- Modify: src/services/reconciler.test.ts:1-190

- [ ] **Step 1: Write failing lifecycle tests**

Add TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET, and ENABLE_X to the connection test environment. Import the OAuth-attempt repository. Extend the start test to read metadata_json and assert its attemptId points to a started X attempt.

Add a tracked-state helper that creates an attempt and an OAuth state whose metadata is JSON.stringify({ attemptId }). Add these cases:

1. X denial records provider_denied and never persists error_description.
2. X `error=server_error` with provider text records callback_failed, providerStatus null, and never persists the provider error or description.
3. A consumed tracked callback with neither provider error nor code, a route/state platform mismatch, or a provider disabled between start and callback records callback_failed instead of remaining started.
4. X token endpoint 401 records token_exchange_failed with providerStatus 401.
5. Successful token response followed by /2/users/me 503 records account_lookup_failed with providerStatus 503; a 200 account body with an empty ID records the same class with providerStatus 200.
6. Captured callback logs omit the state, full pubkey, authorization code, access token, refresh token, callback URL/query, code verifier, and raw provider body.
7. A bad encryption key records storage_failed and creates neither connection nor preference.
8. D1 triggers that reject the connection insert, preference write, or connected-attempt update each make the atomic batch fail; after each failure there is no active connection or preference and the attempt is storage_failed. Use test-only BEFORE triggers with SELECT RAISE(FAIL, 'forced') and drop each trigger after its case.

Extend the success case to assert the attempt becomes connected and its connection plus manual preference are both present.

In src/index.test.ts add failing rendered-HTML assertions for all five classified messages listed in Step 4 plus the generic fallback.

The stage assertion shape is:

    await expect(getOAuthAttempt(db, attemptId)).resolves.toMatchObject({
      status: 'token_exchange_failed',
      failureCode: 'token_exchange_failed',
      providerStatus: 401,
    })

- [ ] **Step 2: Run RED**

    npx vitest run src/routes/connections.test.ts src/index.test.ts

Expected: FAIL because starts and callbacks do not write attempt lifecycle.

- [ ] **Step 3: Implement lifecycle transitions**

In startConnection:

- generate oauth_attempt_ plus generateRandomId(16);
- create a started attempt with the same ten-minute expiry as state;
- store only the attempt ID in state metadata.

Add these helpers to connections.ts:

    type ConnectionFailureReason =
      | 'provider_denied'
      | 'callback_failed'
      | 'token_exchange_failed'
      | 'account_lookup_failed'
      | 'storage_failed'

    function attemptIdFromState(state: OAuthStateRecord): string | null {
      try {
        const value = JSON.parse(state.metadataJson) as { attemptId?: unknown }
        return typeof value.attemptId === 'string' ? value.attemptId : null
      } catch {
        return null
      }
    }

    function providerStatus(error: unknown): number | null {
      return error instanceof PlatformAdapterError ? (error.providerStatus ?? null) : null
    }

    async function transitionAttempt(
      env: Env,
      attemptId: string | null,
      platform: Platform,
      status: OAuthAttemptStatus,
      failureCode: OAuthAttemptFailureCode | null,
      error?: unknown,
    ): Promise<void>

transitionAttempt updates D1 and logs only event, attemptId, platform, status, failureCode, providerStatus, and the allowlisted providerError that the design spec describes. It must not log state, pubkey, code, token, callback URL/query, or raw provider body.

Split completeConnectionCallback into explicit denial, unusable callback, token exchange, account lookup, encryption, and storage stages. After consuming a tracked state, classify only access_denied/user_denied as provider_denied; classify every other provider error, missing code, route/state platform mismatch, or now-disabled adapter as callback_failed before redirecting. An empty account ID is account_lookup_failed. Existing untracked states remain backward-compatible because a missing attempt ID is a no-op.

In src/db/connections.ts add `completeConnectionSetup(db, { connection, preference, attemptId, now }): Promise<ConnectionRecord>`. It must call `db.batch()` once with prepared statements that:

1. upsert the connection;
2. insert the manual preference using a `SELECT id FROM connections WHERE pubkey = ? AND platform = ? AND external_account_id = ?` subquery so an existing canonical connection ID is used, while preserving an existing manual or automatic preference exactly as setManualPreferenceAfterConnect does today;
3. update the tracked attempt from started to connected with null failure/provider status.

Cloudflare D1 batch execution is the atomic boundary. Query and return the canonical connection only after the batch succeeds. On encryption or batch failure, make a best-effort transition to storage_failed, log only the sanitized fields, and return the safe failure redirect. Do not retain the old sequential upsertConnection/setPreference path in the callback.

- [ ] **Step 4: Add safe UI messages**

Map only these reasons in health.ts:

    provider_denied -> X authorization was canceled or denied.
    callback_failed -> X did not return a usable authorization response. Try again.
    token_exchange_failed -> X did not complete authorization. Check the callback setting and try again.
    account_lookup_failed -> X authorized, but the account could not be loaded. Try again.
    storage_failed -> X authorized, but Crossposter could not save the connection. Try again.

All other failures keep the generic existing message. Make the rendered setup page satisfy the five classified-message assertions plus generic fallback written in Step 1.

- [ ] **Step 5: Write RED housekeeping test**

Seed an overdue started attempt and expired state. Run reconciliation at now 3000 and assert:

    result.oauthAttemptsExpired === 1
    result.oauthStatesDeleted === 1
    attempt.status === 'expired'
    oauth state row is null

Update the one exact manual-only result assertion with both zero counters.

- [ ] **Step 6: Implement housekeeping**

At the beginning of runAutoCrosspostReconciliation:

    const oauthAttemptsExpired = await expireStartedOAuthAttempts(env.DB, now)
    const oauthStatesDeleted = await deleteExpiredOAuthStates(env.DB, now)

Add both fields to ReconciliationResult and the return value.

- [ ] **Step 7: Verify and commit**

    npx vitest run src/routes/connections.test.ts src/services/reconciler.test.ts src/index.test.ts
    npm run typecheck
    git add src/db/connections.ts src/services/connections.ts src/routes/connections.test.ts src/routes/health.ts src/index.test.ts src/services/reconciler.ts src/services/reconciler.test.ts
    git commit -m "fix: make OAuth failures diagnosable"

Expected: focused tests PASS and typecheck exits 0.

## WU-3: Align X OAuth with current PKCE requirements

**Files:**

- Modify: src/platforms/x.ts:11-108
- Modify: src/platforms/providers.test.ts:1-280

- [ ] **Step 1: Write failing protocol tests**

Assert the authorization URL has exact redirect URI, state, S256 challenge, and the set tweet.read, tweet.write, users.read, media.write, offline.access.

Assert callback and refresh requests use:

    method: POST
    authorization: Basic base64(client:secret)
    content-type: application/x-www-form-urlencoded

Assert callback body includes client_id, redirect_uri, code, and code_verifier. Assert refresh body includes client_id, grant_type=refresh_token, and refresh_token. Add a 200 token response with a missing or empty access_token and assert exchangeCallback rejects with PlatformAdapterError rather than advancing to account lookup.

- [ ] **Step 2: Run RED**

    npx vitest run src/platforms/providers.test.ts -t "X OAuth"

Expected: FAIL because form content type is not explicit and refresh omits client_id.

- [ ] **Step 3: Implement shared token request**

Add:

    async function requestToken(config: XConfig, body: URLSearchParams): Promise<TokenSet> {
      const response = await fetch(API_BASE + '/oauth2/token', {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + btoa(config.clientId + ':' + config.clientSecret),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      })
      return tokenSetFromResponse(asRecord(await expectProviderOk('x', response)))
    }

Use it for callback and refresh. In tokenSetFromResponse require a nonempty string access_token; otherwise throw `PlatformAdapterError('x', 'unknown_platform_error', 'X token response missing access token', 200)` without attaching the provider body. Preserve PKCE S256 and all five scopes.

- [ ] **Step 4: Verify and commit**

    npx vitest run src/platforms/providers.test.ts -t "X OAuth"
    npm run typecheck
    git add src/platforms/x.ts src/platforms/providers.test.ts
    git commit -m "fix: align X OAuth requests with PKCE"

## WU-4: Implement X v2 multipart chunked upload

**Files:**

- Modify: src/platforms/x.ts:9-185
- Modify: src/platforms/adapter.ts:17-40
- Modify: src/platforms/providers.test.ts:280-355
- Modify: src/services/publisher.ts:31-272
- Modify: src/services/publisher.test.ts:65-315
- Modify: src/services/crossposts.ts:1-260
- Modify: src/routes/crossposts.test.ts:100-135

- [ ] **Step 1: Write failing multipart tests**

Add bodyAsForm to provider tests. Replace the old invented endpoint assertions with:

    INIT URL: https://api.x.com/2/media/upload
    INIT body: FormData with command, total_bytes, media_type, media_category=tweet_video
    APPEND URL: same base URL
    APPEND body: FormData with command, media_id, segment_index, binary File
    FINALIZE URL: same base URL
    FINALIZE body: FormData with command and media_id

Assert success returns externalPostUrl equal to https://x.com/i/web/status/tweet-id.

Export X_UPLOAD_CHUNK_BYTES as 5 * 1024 * 1024. Add a 5 MiB plus one-byte case and assert APPEND indices 0 and 1 with exact sizes.

Add a STATUS failed case that rejects with PlatformAdapterError code media_rejected. Add FINALIZE and STATUS cases where processing_info is present but state is missing or unknown; each must reject with normalized PlatformAdapterError and must not call POST /2/tweets. Retain explicit pending, in_progress, succeeded, and the no-processing_info synchronous-success cases. Add 2xx INIT-without-media-ID and tweet-without-post-ID cases; both must reject with PlatformAdapterError.

Add publisher-level X tests for processing, terminal failure, and posted outcomes. Insert unique sentinel fields into mocked INIT, FINALIZE, STATUS, tweet, and error bodies. Assert `job_attempts.provider_response_json` contains only the polling fields required below, never any sentinel, token-like key, post ID, or raw nested body. The posted attempt has a null checkpoint because the external post ID belongs on the job.

Add crash-safety tests around `POST /2/tweets`:

1. the X adapter awaits `beforeExternalPost` immediately before the fetch;
2. the publisher callback durably changes the job from `uploading` to `dispatching` before the fetch begins;
3. a transport exception after that callback records terminal `failed` plus `ambiguous_post_result`, with null `nextRetryAt`;
4. a 2xx tweet response with no nonempty ID has the same terminal ambiguous result;
5. redelivery cannot claim a `dispatching` or terminal ambiguous job, and the fetch mock proves `/2/tweets` was called exactly once.

Seed a legacy attempt containing a raw sentinel in the authenticated GET /jobs/:job_id route test and assert the response omits providerResponseJson entirely and does not contain the sentinel.

- [ ] **Step 2: Run RED**

    npx vitest run src/platforms/providers.test.ts src/services/publisher.test.ts src/routes/crossposts.test.ts

Expected: FAIL on old append/finalize URLs, JSON base64 body, no chunking, no terminal state, missing ID validation, missing URL, and raw provider-response persistence.

- [ ] **Step 3: Implement multipart protocol**

Add:

    export const X_UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024

    function mediaForm(fields: Record<string, string>, media?: Blob): FormData {
      const form = new FormData()
      for (const [key, value] of Object.entries(fields)) form.set(key, value)
      if (media) form.set('media', media, 'video-chunk')
      return form
    }

    async function postMediaForm(accessToken: string, form: FormData): Promise<Record<string, unknown>> {
      return asRecord(await expectProviderOk('x', await fetch(UPLOAD_BASE, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + accessToken },
        body: form,
      })))
    }

Implement appendVideo as a loop over ArrayBuffer.slice with 5 MiB bounds and sequential indices. Use postMediaForm for INIT, APPEND, FINALIZE at the same endpoint. Do not manually set multipart content-type because fetch supplies the boundary. Reject an empty media ID immediately after INIT and an empty post ID immediately after POST /2/tweets; FINALIZE and STATUS continue using the already validated INIT ID and do not require the provider to echo it.

Classify processing_info explicitly. If it is absent after FINALIZE, treat the upload as synchronously ready. If present, only `succeeded` may call createPost; `pending` and `in_progress` return processing; `failed` throws media_rejected; a missing or unknown state throws `PlatformAdapterError('x', 'unknown_platform_error', 'X returned an unknown media processing state', 200)` without attaching the body. Apply the same fail-closed classification during STATUS polling. X PublishResult.providerResponse must be a checkpoint, not a provider body: `{ mediaId, caption }` while processing and `{}` when posted. For a created post return the full ID and https://x.com/i/web/status/ plus that ID.

Extend `PublishInput` and the optional poll input in src/platforms/adapter.ts with `beforeExternalPost?: () => Promise<void>`. The X adapter requires and awaits that callback immediately before every `POST /2/tweets`; other adapters ignore it. The publisher supplies a closure for both initial publishing and polling that atomically updates the job to `dispatching` and flips an in-memory `dispatchFenceRaised` flag only after D1 succeeds. Add `dispatching` to JobStatus and `ambiguous_post_result` to ErrorCode. If any error occurs after the flag is raised, bypass normal provider retry classification: record a failed attempt with the sanitized ambiguous code, set the job to terminal failed with no retry timestamp, and retain no provider body. If D1 cannot commit the fence, the adapter must not call X.

In publisher.ts replace direct safeJson(providerResponse) persistence with `providerCheckpoint(platform, value)`. Allowlist only:

    instagram -> id, creationId, externalAccountId
    tiktok -> publish_id
    x -> mediaId, caption
    youtube -> id

Persist null for posted results and provider error bodies; normalized errorCode, errorMessage, and providerStatus remain diagnostic. Keep pollProviderResponse's job-field fallback and add the Instagram fallback `{ id, creationId, externalAccountId }`, so polling remains executable even when an older attempt lacks a checkpoint.

At the API boundary, change JobWithAttemptsResult to expose `PublicJobAttempt = Omit<JobAttemptRecord, 'providerResponseJson'>` and strip providerResponseJson from every attempt returned by getCrosspostJob. Polling continues to use the internal repository record; clients receive status, normalized error code/message, provider HTTP status, and timestamp only. This protects against any legacy raw rows as well as future persistence mistakes.

- [ ] **Step 4: Verify and commit**

    npx vitest run src/platforms/providers.test.ts src/services/publisher.test.ts src/routes/crossposts.test.ts
    npm run typecheck
    git add src/platforms/x.ts src/platforms/adapter.ts src/platforms/providers.test.ts src/services/publisher.ts src/services/publisher.test.ts src/services/crossposts.ts src/routes/crossposts.test.ts src/types.ts
    git commit -m "fix: use X v2 chunked media upload"

Expected: multipart, multi-chunk, pending, terminal failure, malformed-response, success, durable dispatch fence, no automatic ambiguous retry, checkpoint allowlist, and authenticated API redaction tests PASS.

## WU-5: Add DLQ and scheduled queue watchdog

**Files:**

- Create: src/services/operations.ts
- Create: src/services/operations.test.ts
- Create: src/db/operations.ts
- Create: src/db/operations.test.ts
- Create: migrations/0003_operations_alert_tests.sql
- Create: src/index.queue.test.ts
- Modify: src/types.ts:24-44
- Modify: src/index.ts:20-42
- Modify: src/index.test.ts:1-65
- Modify: src/db/jobs.ts:190-210
- Modify: src/db/jobs.test.ts:1-220
- Modify: wrangler.toml:24-34
- Modify: README.md:77-120,167-200

- [ ] **Step 1: Write failing operations tests**

Use Queue mocks with metrics() and a migrated test D1. Cover:

1. empty primary and DLQ produces no alert;
2. non-empty DLQ alerts;
3. a runnable D1 job whose due time is more than 15 minutes overdue alerts;
4. a queue message whose associated job has `nextRetryAt` 30 or 60 minutes in the future does not alert even when queue metrics report an old enqueue timestamp;
5. missing webhook logs but does not fetch;
6. webhook payload includes only service, observedAt, issue code, counts, bytes, and overdue count.

Assert serialized payload does not match token, pubkey, state, code_verifier, provider_response, or callback.

Add repository tests for `countOverdueRunnableJobs`, `requestOperationsAlertTest`, and `consumeOperationsAlertTest`. The due-time query covers only `queued`, `failed`, and `processing` jobs and uses `COALESCE(next_retry_at, created_at) <= now - 900`. It excludes terminal jobs, `uploading`, `dispatching`, and every future delayed job.

In src/index.test.ts add a scheduled-handler integration case backed by migrated test D1. Mock CROSSPOST_QUEUE.send/metrics, CROSSPOST_DLQ.metrics, and fetch; make the DLQ nonempty; invoke `worker.scheduled(...)`; assert reconciliation completed, both queue metrics methods ran, and the sanitized webhook was dispatched. Add a second case with an unconsumed operations-alert test row: both metrics reads must complete before the handler sends `notification_test`, and the row is marked consumed only after a 2xx webhook response. A failed metrics read or failed webhook leaves it unconsumed for the next cron. This proves the deployed wiring rather than merely running an unrelated HTTP test.

Create src/index.queue.test.ts with a real migrated D1 X job/connection and MessageBatch mocks. Drive the initial upload into processing, then advance fake time through five delayed pending/in_progress polls and a sixth terminal poll. For the initial delivery and first five polls, assert the handler calls CROSSPOST_QUEUE.send({ jobId }, { delaySeconds }), calls message.ack(), and never calls message.retry(). On the sixth poll assert no fresh message is sent and the job is failed with processing_timeout rather than stranded in processing. Add separate retryable-provider-error, delayed-send-failure, and unexpected-throw cases: the normalized retry uses fresh delayed send plus ack; a failed fresh send escapes without ack, and scheduled reconciliation re-enqueues the still-due processing job; only unexpected infrastructure exceptions use Cloudflare native retry/DLQ.

Extend src/db/jobs.test.ts so listRunnableJobs returns due queued, failed, and processing jobs while excluding future and terminal jobs. Add five-minute X claim-lease cases: stale X `uploading` becomes retryable failed with `unknown_platform_error` and a due retry timestamp; stale X `dispatching` becomes terminal failed with `ambiguous_post_result` and null retry timestamp; fresh claims and every non-X claim are untouched. The next runnable query may return only the safely recovered pre-dispatch X job.

Add a publisher regression where a terminal X polling error records the attempt as `failed`, not `processing`, and leaves `nextRetryAt` null.

- [ ] **Step 2: Run RED**

    npx vitest run src/services/operations.test.ts src/index.test.ts src/index.queue.test.ts src/db/jobs.test.ts

Expected: FAIL because operations.ts does not exist.

- [ ] **Step 3: Implement watchdog**

Create migrations/0003_operations_alert_tests.sql:

    CREATE TABLE operations_alert_tests (
      id TEXT PRIMARY KEY,
      requested_at INTEGER NOT NULL,
      consumed_at INTEGER
    );

Add optional Env bindings:

    CROSSPOST_DLQ?: Queue<unknown>
    OPS_ALERT_WEBHOOK_URL?: string

Implement:

    type OperationalIssue = {
      code: 'primary_jobs_overdue' | 'dlq_nonempty' | 'notification_test'
      backlogCount: number
      backlogBytes: number
      overdueJobCount: number
    }

    runOperationalChecks(env: Env, now?: number): Promise<{ issues: OperationalIssue[] }>

Call metrics() on both bindings for binding/topology health and aggregate counts. Any positive DLQ count is unhealthy. Determine primary staleness exclusively with `countOverdueRunnableJobs(env.DB, now, 900)`; never infer staleness from `QueueMetrics.oldestMessageTimestamp`, because Cloudflare counts intentionally delayed messages from their original enqueue time. Log the sanitized aggregate and POST it as JSON when OPS_ALERT_WEBHOOK_URL exists. Throw when either metrics call fails or the configured webhook returns non-2xx. If CROSSPOST_DLQ is absent, return no issues for local backward compatibility.

After both metrics calls, look up the oldest unconsumed operations test request. If present and the webhook is configured, append a sanitized `notification_test` issue containing no request ID. Mark the request consumed only after the webhook returns 2xx. There is no HTTP route for creating test requests; production operators use a remote D1 INSERT and verify only the consumed count/timestamp.

Call runOperationalChecks after reconciliation in the scheduled handler.

In the queue handler, controlled retryDelaySeconds results and PublisherRetryError are application lifecycle events, not delivery failures. For each, first `await env.CROSSPOST_QUEUE.send(message.body, { delaySeconds })`, then `message.ack()`. If the fresh send fails, do not ack; let that error escape for native delivery retry. Successful/terminal results ack normally. Remove all message.retry() calls. Only unexpected exceptions escape to Cloudflare's five native retries and then the DLQ.

Add processing to listRunnableJobs' due-status set. At the start of scheduled reconciliation, call `recoverStaleXClaims(db, now, 300)`. It moves only stale X `uploading` jobs into the normal retry lifecycle and moves stale X `dispatching` jobs to terminal ambiguous failure. The scheduled reconciler then recovers a processing job whose fresh delayed send failed or disappeared; the job's nextRetryAt remains the source of truth, so duplicate early delivery cannot poll before it is due.

In `handleProcessingProviderError`, choose the attempt status after classification: `needs_reauth` for auth loss, `failed` for every non-retryable code, and `processing` only for retryable polling errors. This keeps attempt history consistent with the terminal job row.

- [ ] **Step 4: Configure DLQ**

Add producer:

    [[queues.producers]]
    binding = "CROSSPOST_DLQ"
    queue = "divine-crossposter-jobs-dlq"

Add to consumer:

    max_retries = 5
    dead_letter_queue = "divine-crossposter-jobs-dlq"

Document bindings, OPS_ALERT_WEBHOOK_URL, thresholds, DLQ inspection, and secret-safety rules in README.

- [ ] **Step 5: Verify and commit**

    npx vitest run src/services/operations.test.ts src/index.test.ts src/index.queue.test.ts src/db/jobs.test.ts
    npm run typecheck
    npx wrangler deploy --dry-run
    git diff --check
    git add migrations/0003_operations_alert_tests.sql src/services/operations.ts src/services/operations.test.ts src/db/operations.ts src/db/operations.test.ts src/index.queue.test.ts src/types.ts src/index.ts src/index.test.ts src/db/jobs.ts src/db/jobs.test.ts src/services/publisher.ts src/services/publisher.test.ts wrangler.toml README.md
    git commit -m "feat: alert on crossposter queue failures"

Expected: tests/typecheck/dry-run PASS; controlled processing never uses native retry, budget exhaustion is terminal, pre-dispatch X claims recover after their lease, ambiguous X dispatch is terminal, future delayed jobs do not alert, the one-shot watchdog test is safely consumable, unexpected failures remain DLQ-eligible, and dry-run lists DB plus both queue bindings.

## WU-6: Restore deployment and prove a real X post

**Files:**

- Modify: .github/workflows/ci-deploy.yml:58-93
- Modify: README.md:177-200

- [ ] **Step 1: Harden deployment workflow**

Add this X-enabled smoke assertion beside Instagram:

    check "https://crossposter.divine.video/platforms?format=json" '"platform":"x","enabled":true'

Add this manual test trigger under `on`, then add the separate job below after test and deploy so a failed test cannot skip notification:

    workflow_dispatch:
      inputs:
        test_failure_notification:
          description: Send a safe notification test
          required: false
          type: boolean
          default: false

    notify:
      if: ${{ always() && (inputs.test_failure_notification == true || needs.test.result == 'failure' || needs.deploy.result == 'failure') }}
      needs: [test, deploy]
      runs-on: ubuntu-latest
      steps:
        - name: Notify workflow failure
          env:
            OPS_ALERT_WEBHOOK_URL: ${{ secrets.OPS_ALERT_WEBHOOK_URL }}
            NOTIFICATION_TEST: ${{ inputs.test_failure_notification }}
            RUN_URL: https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}
          run: |
            set -euo pipefail
            if [ -z "${OPS_ALERT_WEBHOOK_URL:-}" ]; then
              exit 0
            fi
            event=workflow_failed
            if [ "$NOTIFICATION_TEST" = true ]; then
              event=notification_test
            fi
            payload="$(jq -cn \
              --arg service divine-crossposter \
              --arg event "$event" \
              --arg run_url "$RUN_URL" \
              '{service: $service, event: $event, runUrl: $run_url}')"
            curl --fail --silent --show-error --retry 3 \
              --header 'content-type: application/json' \
              --data-binary "$payload" \
              "$OPS_ALERT_WEBHOOK_URL"

Document that deployment still requires a valid selected-organization, production-environment, or repository CLOUDFLARE_API_TOKEN. The webhook secret must be a repository or selected-organization secret because the notify job deliberately does not enter the production environment.

- [ ] **Step 2: Verify and commit**

    ruby -e 'require "yaml"; YAML.load_file(".github/workflows/ci-deploy.yml")'
    npm run typecheck
    npm run test:once
    npx wrangler deploy --dry-run
    git diff --check
    git add .github/workflows/ci-deploy.yml README.md
    git commit -m "ci: verify and report crossposter deployment"

Expected: YAML parses; all tests, typecheck, dry-run, and diff check PASS.

- [ ] **Step 3: Push the branch and open the PR**

    git push -u origin fix/x-crossposter-recovery
    gh pr create --base main --head fix/x-crossposter-recovery --title "Fix X crossposting end to end" --body-file docs/superpowers/specs/2026-07-22-x-crossposter-recovery-design.md

Wait for code review approval before changing production bindings or schema.

- [ ] **Step 4: Complete external human checkpoints**

X Developer Portal must show:

    OAuth 2.0 confidential web application
    Read and write permission
    Callback https://crossposter.divine.video/connections/x/callback
    Scopes tweet.read tweet.write users.read media.write offline.access

Generate or select one known X OAuth client credential pair from that exact application. Do not attempt to compare against deployed Worker secret values because Cloudflare does not reveal them; Step 5 replaces both Worker secrets interactively only after the approved X-disabled safety deployment is active and verified.

An authorized GitHub org admin replaces the invalid CLOUDFLARE_API_TOKEN at the selected-organization, repository, or production-environment level used by this workflow. Before saving it, verify the token summary grants only the Divine account and these workflow operations:

    Account / Workers Scripts / Edit
    Account / D1 / Edit
    Account / Queues / Edit
    Account / Account Settings / Read
    Zone / Workers Routes / Edit, restricted to the divine.video zone

Do not grant unrelated accounts, zones, or products. Record a non-secret attestation of the resource scope and permission names; never record the token. Configure OPS_ALERT_WEBHOOK_URL as a repository or selected-organization Actions secret so the non-environment notify job can read it. Compare provider client IDs without printing them.

With an account administrator, query Cloudflare Notifications' available alert types for the Divine account, choose the eligible Worker/edge-error type and narrowest available filter for divine-crossposter or its zone, and create or verify an enabled policy named `divine-crossposter-worker-errors`. Attach the approved destination, use Cloudflare's Save and Test action, confirm receipt and the destination's last-success timestamp, and verify the enabled policy through Notification History/API. Record only policy name/type/scope and receipt timestamp—never destination URL, secret, account ID, or payload body. If the account offers no eligible Worker/edge-error alert type, stop and report that external product limitation rather than claiming this checkpoint complete.

- [ ] **Step 5: After PR approval, create infrastructure and migrate**

Capture the pre-deploy production identifiers first. Record the current Worker version ID and `origin/main` commit SHA in the private deployment checklist/PR comment; both are non-secret, but do not record bindings or secret metadata:

    git fetch origin main
    git rev-parse origin/main
    npx wrangler deployments list --name divine-crossposter
    npx wrangler queues list
    npx wrangler d1 migrations list divine-crossposter --remote

If the named DLQ is absent:

    npx wrangler queues create divine-crossposter-jobs-dlq

Apply infrastructure that is safe while X remains disabled:

    npx wrangler d1 migrations apply divine-crossposter --remote
    npx wrangler secret put OPS_ALERT_WEBHOOK_URL
    npx wrangler queues info divine-crossposter-jobs-dlq

Expected before the safety deployment: migrations 0002 and 0003 are applied, the webhook secret is accepted interactively, and the named DLQ exists. Do not replace X secrets yet. Never place secret values in arguments or logs.

Deploy the approved branch as the rollback-ready safety version with X disabled:

    npx wrangler deploy --var ENABLE_X:false --message "X recovery safety version"
    npx wrangler deployments list --name divine-crossposter
    curl -fsS 'https://crossposter.divine.video/platforms?format=json'
    npx wrangler queues info divine-crossposter-jobs
    npx wrangler queues info divine-crossposter-jobs-dlq

Record the returned safety version ID in the same private deployment checklist. Verify the active version contains DB, primary queue, DLQ, scheduled handler, five retries, the named DLQ, and `ENABLE_X=false`; the live platform response must also show X disabled. This is the rollback target and proves the new bindings are active before credentials change.

Only after that disabled deployment is healthy, replace both X secrets interactively from the known matching portal pair:

    npx wrangler secret put TWITTER_CLIENT_ID
    npx wrangler secret put TWITTER_CLIENT_SECRET
    npx wrangler secret list

Expected: both secret names are present and the live platform response still shows X disabled. Do not test OAuth yet and do not print or compare secret values. The merge in Step 6 is the sole activation of `ENABLE_X=true` through the reviewed CI path.

- [ ] **Step 6: Merge and verify automated deployment**

After the human checkpoints and production infrastructure are ready, merge the approved PR. Then capture and watch the newest main run without invoking gh's interactive selector:

    gh run list --workflow ci-deploy.yml --branch main --limit 3
    run_id="$(gh run list --workflow ci-deploy.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
    gh run watch "$run_id" --exit-status
    npx wrangler queues info divine-crossposter-jobs
    npx wrangler queues info divine-crossposter-jobs-dlq

Expected: main test and deploy jobs PASS, including migration, Worker deploy, and X smoke check. Now run `npx wrangler queues info divine-crossposter-jobs` and `npx wrangler queues info divine-crossposter-jobs-dlq`; require exactly one primary producer/consumer, max_retries 5, the named DLQ target, one DLQ watchdog producer, and no DLQ consumer. These topology assertions intentionally occur after deployment.

- [ ] **Step 7: Verify live bindings**

    npx wrangler deployments list --name divine-crossposter
    npx wrangler queues list
    npx wrangler queues info divine-crossposter-jobs
    npx wrangler queues info divine-crossposter-jobs-dlq
    curl -fsS https://crossposter.divine.video/health
    curl -fsS 'https://crossposter.divine.video/platforms?format=json'

Use npx wrangler versions view with the latest version ID. Expected: fetch, queue, scheduled; DB; primary queue; DLQ; X enabled; one primary producer/consumer; five retries; named DLQ target; no DLQ consumer.

- [ ] **Step 8: Complete real authorization and posting**

Rabble opens the production setup page, signs in with Divine, connects X, and approves consent. In Divine, choose an original, non-archive kind-34236 video owned by that same account and copy its full 64-hex event ID. In the Crossposter page's browser console, use the page's existing `api()` helper so the bearer token never leaves local storage or appears in a terminal/chat:

    await (async () => {
      const fullEventId = String(prompt('Full 64-hex Divine video event ID') || '').trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(fullEventId)) throw new Error('Expected a full 64-hex event ID')
      const source = await fetch('https://api.divine.video/api/videos/' + fullEventId).then((response) => response.json())
      const event = source.event || source
      if (event.id !== fullEventId || event.pubkey !== pubkey || event.kind !== 34236) {
        throw new Error('Video preflight did not match the signed-in owner and kind')
      }
      const created = await api('/videos/' + fullEventId + '/crossposts', {
        method: 'POST',
        body: JSON.stringify({ platforms: ['x'] }),
      })
      const xJob = created.jobs.find((job) => job.platform === 'x')
      if (!xJob) throw new Error('Crossposter did not return an X job')
      for (let poll = 0; poll < 120; poll += 1) {
        const current = await api('/jobs/' + xJob.id)
        if (current.job.status === 'posted') return current
        if (current.job.status === 'failed' && current.job.nextRetryAt === null) {
          throw new Error(current.job.errorCode || current.job.status)
        }
        if (['needs_reauth', 'skipped'].includes(current.job.status)) throw new Error(current.job.errorCode || current.job.status)
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
      throw new Error('X job did not finish within ten minutes')
    })()

Inspect the returned job locally and confirm externalPostUrl resolves to the intended X account and video. Do not paste the console result because it contains the full creator/job identifiers.

Never paste bearer tokens, OAuth codes, pubkeys, provider bodies, or webhook values into chat, committed files, or shared terminal output.

- [ ] **Step 9: Verify sanitized production outcomes**

    npx wrangler d1 execute divine-crossposter --remote --json --command "SELECT status, COUNT(*) AS count FROM oauth_attempts WHERE platform = 'x' GROUP BY status;"
    npx wrangler d1 execute divine-crossposter --remote --json --command "SELECT COUNT(*) AS active_x_connections FROM connections WHERE platform = 'x' AND status = 'connected';"
    npx wrangler d1 execute divine-crossposter --remote --json --command "SELECT COUNT(*) AS complete_posted_x_jobs FROM jobs WHERE platform = 'x' AND status = 'posted' AND length(external_post_id) > 0 AND external_post_url LIKE 'https://x.com/i/web/status/%';"
    npx wrangler d1 execute divine-crossposter --remote --json --command "SELECT COUNT(*) AS unsafe_x_attempts FROM job_attempts a JOIN jobs j ON j.id = a.job_id WHERE j.platform = 'x' AND a.provider_response_json IS NOT NULL AND (a.status = 'posted' OR json_valid(a.provider_response_json) = 0 OR EXISTS (SELECT 1 FROM json_each(a.provider_response_json) WHERE key NOT IN ('mediaId', 'caption')));"

Expected: at least one connected X attempt, at least one active X connection, at least one complete posted X job, and zero unsafe X attempts. These queries return counts only; do not select identifying or sensitive columns.

- [ ] **Step 10: Verify notifications**

Test GitHub notification without breaking a build or deploying:

    gh workflow run ci-deploy.yml -f test_failure_notification=true
    run_id="$(gh run list --workflow ci-deploy.yml --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
    gh run watch "$run_id" --exit-status

Confirm the GitHub `notification_test` receipt. Then request one deployed scheduled-watchdog test without exposing a public endpoint or touching either queue:

    npx wrangler d1 execute divine-crossposter --remote --command "INSERT INTO operations_alert_tests (id, requested_at, consumed_at) VALUES (lower(hex(randomblob(16))), unixepoch(), NULL);"
    npx wrangler d1 execute divine-crossposter --remote --json --command "SELECT COUNT(*) AS pending_operations_tests FROM operations_alert_tests WHERE consumed_at IS NULL;"

After the next cron, confirm the destination received the sanitized `notification_test`, then require the pending count to return to zero and a recent consumed count to be one or greater. Also confirm `wrangler secret list` contains OPS_ALERT_WEBHOOK_URL. This proves the deployed scheduled handler read D1 and both queue metric bindings before using the real webhook. Do not inject or purge messages in the production primary queue or DLQ; queue-level purge cannot safely distinguish a test delivery from a concurrent real failure.

Confirm the Cloudflare destination Save-and-Test receipt, its last-success timestamp, and the enabled `divine-crossposter-worker-errors` policy/history entry configured in Step 4. Confirm primary backlog count/age is healthy in Queue metrics and the DLQ is zero. Record only policy/event classes and receipt timestamps, never destinations, account identifiers, credentials, or message bodies.

## Final verification gate

Run fresh:

    npm run typecheck
    npm run test:once
    npx wrangler deploy --dry-run
    git diff --check
    git status --short

Completion requires all of:

    main CI test PASS
    main deploy PASS
    X callback connected
    active X connection count >= 1
    X job posted with nonempty ID and canonical URL
    external X URL resolves to the intended account/video
    unsafe X attempt count = 0
    primary queue healthy with one producer, one consumer, five retries, named DLQ
    DLQ zero
    operations webhook received
    GitHub notification test received
    Cloudflare error notification test-confirmed

## Rollback

Trigger rollback for repeated invalid posts, missing/incorrect external IDs, secret exposure, an unrecoverable callback regression, or a rising DLQ after deployment. Pause delivery first so no X job runs during the change, then use the X-disabled safety version ID recorded before deployment:

    npx wrangler queues pause-delivery divine-crossposter-jobs
    npx wrangler deployments list --name divine-crossposter
    read -r "safety_version_id?Recorded X-disabled safety Worker version ID: "
    test -n "$safety_version_id"
    npx wrangler versions view "$safety_version_id" --name divine-crossposter
    npx wrangler rollback "$safety_version_id" --name divine-crossposter --message "Disable X after recovery incident" --yes

Then verify:

    curl -fsS https://crossposter.divine.video/health
    curl -fsS 'https://crossposter.divine.video/platforms?format=json'
    npx wrangler queues info divine-crossposter-jobs
    npx wrangler queues info divine-crossposter-jobs-dlq

The platform response must show X disabled before any queue delivery resumes; the safety version must still show DB, primary queue, DLQ, scheduled handler, five native retries, and the named DLQ. Leave oauth_attempts and its migration in place because they are additive. Leave the DLQ and alert policies in place; do not purge real deliveries. Inspect in-flight primary/DLQ messages and preserve them until the faulty path is understood. Resume delivery only after deciding how existing X jobs should be handled with X disabled:

    npx wrangler queues resume-delivery divine-crossposter-jobs

Remove bindings only in a later reviewed change after both queues are empty. Re-enable X only through a reviewed deployment after callback and publishing regressions pass.

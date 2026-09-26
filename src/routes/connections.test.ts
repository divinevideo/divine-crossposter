import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../index'
import { listConnections, upsertConnection } from '../db/connections'
import { createOAuthAttempt, getOAuthAttempt } from '../db/oauth-attempts'
import { createOAuthState } from '../db/oauth-states'
import { getPreferences, setPreference } from '../db/preferences'
import { applyMigrations, connection, PUBKEY_A } from '../db/test-helpers'
import { decryptToken } from '../utils/crypto'
import { transitionAttempt } from '../services/connections'
import type { Env, Platform } from '../types'

function testEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    CROSSPOST_QUEUE: {} as Queue<{ jobId: string }>,
    KEYCAST_URL: 'https://keycast.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video',
    TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
    ENABLE_TIKTOK: 'true',
    TIKTOK_CLIENT_KEY: 'tiktok-client',
    TIKTOK_CLIENT_SECRET: 'tiktok-secret',
    ENABLE_X: 'true',
    TWITTER_CLIENT_ID: 'x-client',
    TWITTER_CLIENT_SECRET: 'x-secret',
    ...overrides,
  }
}

function authResponse(): Response {
  return Response.json({ result: PUBKEY_A })
}

async function createTrackedState(
  db: D1Database,
  input: {
    attemptId: string
    stateId: string
    platform?: Platform
    returnUrl?: string
    codeVerifier?: string
  },
): Promise<void> {
  const platform = input.platform ?? 'x'
  await createOAuthAttempt(db, {
    id: input.attemptId,
    pubkey: PUBKEY_A,
    platform,
    status: 'started',
    failureCode: null,
    providerStatus: null,
    createdAt: 1_000,
    expiresAt: 1_783_383_000,
    updatedAt: 1_000,
  })
  await createOAuthState(db, {
    stateId: input.stateId,
    pubkey: PUBKEY_A,
    platform,
    codeVerifier: input.codeVerifier ?? 'private-code-verifier',
    returnUrl: input.returnUrl ?? 'https://divine.video/settings/crossposting',
    createdAt: 1_000,
    expiresAt: 1_783_383_000,
    metadataJson: JSON.stringify({ attemptId: input.attemptId }),
  })
}

function mockSuccessfulXCallback(fetchMock: ReturnType<typeof vi.fn>): void {
  fetchMock
    .mockResolvedValueOnce(
      Response.json({
        access_token: 'private-access-token',
        refresh_token: 'private-refresh-token',
        expires_in: 3_600,
        scope: 'tweet.read users.read offline.access',
      }),
    )
    .mockResolvedValueOnce(Response.json({ data: { id: 'x-account-1', username: 'divine' } }))
}

function rejectPostBatchConnectionRead(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (query: string) => {
          if (query.startsWith('SELECT * FROM connections WHERE pubkey = ? AND platform = ?')) {
            throw new Error('post-batch connection read rejected')
          }
          return target.prepare(query)
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

describe('connection routes', () => {
  let db: D1Database
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = await applyMigrations()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-07T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts X by storing a tracked OAuth attempt with the full pubkey', async () => {
    fetchMock.mockResolvedValueOnce(authResponse())

    const response = await app.request(
      '/connections/x/start',
      {
        method: 'POST',
        headers: { authorization: 'Bearer keycast-token', 'content-type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://divine.video/settings/crossposting' }),
      },
      testEnv(db),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { authorizationUrl: string; state: string }
    const authorizationUrl = new URL(body.authorizationUrl)
    expect(authorizationUrl.origin).toBe('https://x.com')
    expect(authorizationUrl.searchParams.get('client_id')).toBe('x-client')
    expect(authorizationUrl.searchParams.get('state')).toBe(body.state)
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(
      'https://crossposter.divine.video/connections/x/callback',
    )
    expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy()

    const stored = await db.prepare('SELECT * FROM oauth_states WHERE state_id = ?').bind(body.state).first<{
      pubkey: string
      platform: string
      code_verifier: string
      return_url: string
      created_at: number
      expires_at: number
      metadata_json: string
    }>()
    expect(stored).toMatchObject({
      pubkey: PUBKEY_A,
      platform: 'x',
      return_url: 'https://divine.video/settings/crossposting',
      created_at: 1_783_382_400,
      expires_at: 1_783_383_000,
    })
    expect(stored?.code_verifier).toBeTruthy()
    const metadata = JSON.parse(stored?.metadata_json ?? '{}') as { attemptId?: unknown }
    expect(metadata.attemptId).toEqual(expect.any(String))
    expect(metadata.attemptId).toMatch(/^oauth_attempt_/)
    await expect(getOAuthAttempt(db, String(metadata.attemptId))).resolves.toMatchObject({
      id: metadata.attemptId,
      pubkey: PUBKEY_A,
      platform: 'x',
      status: 'started',
      expiresAt: 1_783_383_000,
    })
  })

  it('marks a started attempt storage_failed when OAuth state storage fails', async () => {
    fetchMock.mockResolvedValueOnce(authResponse())
    await db.prepare(
      "CREATE TRIGGER reject_oauth_state_insert BEFORE INSERT ON oauth_states BEGIN SELECT RAISE(FAIL, 'forced'); END",
    ).run()

    try {
      const response = await app.request(
        '/connections/x/start',
        {
          method: 'POST',
          headers: { authorization: 'Bearer keycast-token', 'content-type': 'application/json' },
          body: JSON.stringify({ returnUrl: 'https://divine.video/settings/crossposting' }),
        },
        testEnv(db),
      )

      expect(response.status).toBe(500)
      const attempt = await db.prepare('SELECT * FROM oauth_attempts').first<{
        pubkey: string
        status: string
        failure_code: string | null
      }>()
      expect(attempt).toMatchObject({
        pubkey: PUBKEY_A,
        status: 'storage_failed',
        failure_code: 'storage_failed',
      })
      await expect(db.prepare('SELECT * FROM oauth_states').first()).resolves.toBeNull()
    } finally {
      await db.prepare('DROP TRIGGER reject_oauth_state_insert').run()
    }
  })

  it('consumes callback state once, stores encrypted tokens, and creates a default manual preference', async () => {
    await createTrackedState(db, {
      attemptId: 'oauth_attempt_success',
      stateId: 'state_once',
      platform: 'tiktok',
      codeVerifier: 'pkce-verifier',
      returnUrl: 'https://divine.video/settings/crossposting?section=sharing',
    })
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3_600,
          scope: 'user.info.basic,video.publish',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: { user: { open_id: 'account-1', display_name: 'Divine TikTok' } },
        }),
      )

    const response = await app.request(
      '/connections/tiktok/callback?code=oauth-code&state=state_once',
      {},
      testEnv(db),
    )
    const retry = await app.request('/connections/tiktok/callback?code=oauth-code&state=state_once', {}, testEnv(db))

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://divine.video/settings/crossposting?section=sharing&connection=connected&platform=tiktok',
    )
    expect(retry.status).toBe(302)
    expect(retry.headers.get('location')).toBe(
      'https://crossposter.divine.video/?connection=failed&platform=tiktok',
    )

    const rows = await listConnections(db, PUBKEY_A)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      platform: 'tiktok',
      externalAccountId: 'account-1',
      externalAccountName: 'Divine TikTok',
      status: 'connected',
      grantedScopes: 'user.info.basic,video.publish',
    })
    expect(rows[0].encryptedAccessToken).not.toBe('access-token')
    await expect(decryptToken(rows[0].encryptedAccessToken, testEnv(db).TOKEN_ENCRYPTION_KEY)).resolves.toBe(
      'access-token',
    )
    await expect(decryptToken(rows[0].encryptedRefreshToken ?? '', testEnv(db).TOKEN_ENCRYPTION_KEY)).resolves.toBe(
      'refresh-token',
    )
    await expect(getPreferences(db, PUBKEY_A)).resolves.toMatchObject([
      { platform: 'tiktok', connectionId: rows[0].id, mode: 'manual', automaticEnabledAt: null },
    ])
    await expect(getOAuthAttempt(db, 'oauth_attempt_success')).resolves.toMatchObject({
      status: 'connected',
      failureCode: null,
      providerStatus: null,
    })
  })

  it('redirects failed callbacks for expired state without storing a connection', async () => {
    await createOAuthState(db, {
      stateId: 'state_expired',
      pubkey: PUBKEY_A,
      platform: 'tiktok',
      codeVerifier: 'pkce-verifier',
      returnUrl: 'https://divine.video/settings/crossposting',
      createdAt: 1_000,
      expiresAt: 1_100,
      metadataJson: '{}',
    })

    const response = await app.request(
      '/connections/tiktok/callback?code=oauth-code&state=state_expired',
      {},
      testEnv(db),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://crossposter.divine.video/?connection=failed&platform=tiktok',
    )
    await expect(listConnections(db, PUBKEY_A)).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['error', 'access_denied'],
    ['error_reason', 'user_denied'],
  ])('classifies X denial from %s without persisting provider text', async (parameter, denial) => {
    const attemptId = `oauth_attempt_denied_${parameter}`
    const stateId = `private-state-denied-${parameter}`
    const providerText = `private-provider-denial-${parameter}`
    await createTrackedState(db, { attemptId, stateId })
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    const response = await app.request(
      `/connections/x/callback?${parameter}=${denial}&error_description=${providerText}&state=${stateId}`,
      {},
      testEnv(db),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://divine.video/settings/crossposting?connection=failed&platform=x&reason=provider_denied',
    )
    await expect(
      db.prepare('SELECT state_id FROM oauth_states WHERE state_id = ?').bind(stateId).first(),
    ).resolves.toBeNull()
    const attempt = await getOAuthAttempt(db, attemptId)
    expect(attempt).toMatchObject({ status: 'provider_denied', failureCode: 'provider_denied', providerStatus: null })
    expect(JSON.stringify(attempt)).not.toContain(providerText)
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(providerText)
    await expect(listConnections(db, PUBKEY_A)).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('classifies a non-denial X provider callback error without retaining provider text', async () => {
    const attemptId = 'oauth_attempt_server_error'
    const stateId = 'private-state-server-error'
    const providerText = 'private-provider-server-error-detail'
    await createTrackedState(db, { attemptId, stateId })
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    const response = await app.request(
      `/connections/x/callback?error=server_error&error_description=${providerText}&state=${stateId}`,
      {},
      testEnv(db),
    )

    expect(response.headers.get('location')).toBe(
      'https://divine.video/settings/crossposting?connection=failed&platform=x&reason=callback_failed',
    )
    const attempt = await getOAuthAttempt(db, attemptId)
    expect(attempt).toMatchObject({ status: 'callback_failed', failureCode: 'callback_failed', providerStatus: null })
    expect(JSON.stringify(attempt)).not.toContain(providerText)
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(providerText)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['missing code', '/connections/x/callback?state=private-state-unusable', {}],
    ['route and state platform mismatch', '/connections/tiktok/callback?code=private-code&state=private-state-unusable', {}],
    ['provider disabled after start', '/connections/x/callback?code=private-code&state=private-state-unusable', { ENABLE_X: 'false' }],
  ])('classifies %s as callback_failed after consuming tracked state', async (_case, path, overrides) => {
    await createTrackedState(db, {
      attemptId: 'oauth_attempt_unusable',
      stateId: 'private-state-unusable',
    })

    const response = await app.request(path, {}, testEnv(db, overrides))

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('connection=failed')
    expect(response.headers.get('location')).toContain('reason=callback_failed')
    await expect(getOAuthAttempt(db, 'oauth_attempt_unusable')).resolves.toMatchObject({
      status: 'callback_failed',
      failureCode: 'callback_failed',
      providerStatus: null,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('classifies an X token endpoint 401 and logs only allowlisted provider error fields', async () => {
    const attemptId = 'oauth_attempt_token_401'
    const stateId = 'private-state-token-401'
    const echoedToken = 'Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZg'
    await createTrackedState(db, { attemptId, stateId })
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: 'invalid_grant',
          error_description: `Value passed for the token ${echoedToken} was invalid.`,
          access_token: 'private-access-token',
        },
        { status: 401 },
      ),
    )

    const response = await app.request(
      `/connections/x/callback?code=private-auth-code&state=${stateId}`,
      {},
      testEnv(db),
    )

    expect(response.headers.get('location')).toContain('reason=token_exchange_failed')
    await expect(getOAuthAttempt(db, attemptId)).resolves.toMatchObject({
      status: 'token_exchange_failed',
      failureCode: 'token_exchange_failed',
      providerStatus: 401,
    })
    const logged = JSON.stringify(logSpy.mock.calls)
    expect(logged).not.toContain(echoedToken)
    for (const forbidden of ['private-access-token', 'private-auth-code', stateId, 'x-secret', 'private-code-verifier']) {
      expect(logged).not.toContain(forbidden)
    }
    const transition = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<string, unknown>
    expect(transition.providerError).toEqual({
      type: 'invalid_grant',
      message: 'Value passed for the token [redacted] was invalid.',
    })
  })

  it('logs Instagram token exchange error details without secrets', async () => {
    const attemptId = 'oauth_attempt_instagram_400'
    const stateId = 'private-state-instagram-400'
    await createTrackedState(db, { attemptId, stateId, platform: 'instagram' })
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const providerResponse = Response.json(
      { error_type: 'OAuthException', code: 400, error_message: 'Invalid platform app' },
      { status: 400 },
    )
    Object.defineProperty(providerResponse, 'url', { value: 'https://api.instagram.com/oauth/access_token' })
    fetchMock.mockResolvedValueOnce(providerResponse)

    const response = await app.request(
      `/connections/instagram/callback?code=private-instagram-code&state=${stateId}`,
      {},
      testEnv(db, {
        ENABLE_INSTAGRAM: 'true',
        INSTAGRAM_CLIENT_ID: 'instagram-client',
        INSTAGRAM_CLIENT_SECRET: 'private-instagram-secret',
      }),
    )

    expect(response.headers.get('location')).toContain('reason=token_exchange_failed')
    await expect(getOAuthAttempt(db, attemptId)).resolves.toMatchObject({
      status: 'token_exchange_failed',
      providerStatus: 400,
    })
    const logged = JSON.stringify(logSpy.mock.calls)
    for (const forbidden of ['private-instagram-code', 'private-instagram-secret', stateId, '/connections/instagram/callback']) {
      expect(logged).not.toContain(forbidden)
    }
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
      event: 'oauth_callback_transition',
      attemptId,
      platform: 'instagram',
      status: 'token_exchange_failed',
      failureCode: 'token_exchange_failed',
      providerStatus: 400,
      providerError: {
        endpoint: 'https://api.instagram.com/oauth/access_token',
        type: 'OAuthException',
        code: 400,
        message: 'Invalid platform app',
      },
    })
  })

  it('classifies an X account lookup 503', async () => {
    await createTrackedState(db, { attemptId: 'oauth_attempt_account_503', stateId: 'private-state-account-503' })
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: 'private-access-token' }))
      .mockResolvedValueOnce(Response.json({ error: 'temporarily unavailable' }, { status: 503 }))

    const response = await app.request(
      '/connections/x/callback?code=private-auth-code&state=private-state-account-503',
      {},
      testEnv(db),
    )

    expect(response.headers.get('location')).toContain('reason=account_lookup_failed')
    await expect(getOAuthAttempt(db, 'oauth_attempt_account_503')).resolves.toMatchObject({
      status: 'account_lookup_failed',
      failureCode: 'account_lookup_failed',
      providerStatus: 503,
    })
  })

  it('classifies a successful X account response with an empty ID', async () => {
    await createTrackedState(db, { attemptId: 'oauth_attempt_empty_account', stateId: 'private-state-empty-account' })
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: 'private-access-token' }))
      .mockResolvedValueOnce(Response.json({ data: { username: 'missing-id' } }))

    const response = await app.request(
      '/connections/x/callback?code=private-auth-code&state=private-state-empty-account',
      {},
      testEnv(db),
    )

    expect(response.headers.get('location')).toContain('reason=account_lookup_failed')
    await expect(getOAuthAttempt(db, 'oauth_attempt_empty_account')).resolves.toMatchObject({
      status: 'account_lookup_failed',
      failureCode: 'account_lookup_failed',
      providerStatus: 200,
    })
  })

  it('logs only sanitized callback transition fields', async () => {
    const attemptId = 'oauth_attempt_private_log_check'
    const stateId = 'private-state-log-check'
    const codeVerifier = 'private-code-verifier-log-check'
    await createTrackedState(db, { attemptId, stateId, codeVerifier })
    mockSuccessfulXCallback(fetchMock)
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    await app.request(
      `/connections/x/callback?code=private-auth-code-log-check&state=${stateId}`,
      {},
      testEnv(db),
    )

    expect(logSpy).toHaveBeenCalled()
    for (const call of logSpy.mock.calls) {
      expect(call).toHaveLength(1)
      const record = JSON.parse(String(call[0])) as Record<string, unknown>
      expect(Object.keys(record).sort()).toEqual(
        ['attemptId', 'event', 'failureCode', 'platform', 'providerError', 'providerStatus', 'status'].sort(),
      )
    }
    const logs = JSON.stringify(logSpy.mock.calls)
    for (const privateValue of [
      stateId,
      PUBKEY_A,
      'private-auth-code-log-check',
      'private-access-token',
      'private-refresh-token',
      '/connections/x/callback',
      '?code=',
      codeVerifier,
    ]) {
      expect(logs).not.toContain(privateValue)
    }
  })

  it('does not log a successful transition when attempt persistence fails', async () => {
    await createTrackedState(db, { attemptId: 'oauth_attempt_transition_failure', stateId: 'private-state-transition' })
    await db.prepare(
      "CREATE TRIGGER reject_attempt_transition BEFORE UPDATE ON oauth_attempts BEGIN SELECT RAISE(FAIL, 'forced'); END",
    ).run()
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    try {
      await expect(
        transitionAttempt(
          testEnv(db),
          'oauth_attempt_transition_failure',
          'x',
          'callback_failed',
          'callback_failed',
        ),
      ).rejects.toThrow()
      expect(logSpy).not.toHaveBeenCalled()
    } finally {
      await db.prepare('DROP TRIGGER reject_attempt_transition').run()
    }
  })

  it('records storage_failed without a connection or preference when token encryption is misconfigured', async () => {
    await createTrackedState(db, { attemptId: 'oauth_attempt_bad_key', stateId: 'private-state-bad-key' })
    mockSuccessfulXCallback(fetchMock)

    const response = await app.request(
      '/connections/x/callback?code=private-auth-code&state=private-state-bad-key',
      {},
      testEnv(db, { TOKEN_ENCRYPTION_KEY: 'too-short' }),
    )

    expect(response.headers.get('location')).toContain('reason=storage_failed')
    await expect(listConnections(db, PUBKEY_A)).resolves.toEqual([])
    await expect(getPreferences(db, PUBKEY_A)).resolves.toEqual([])
    await expect(getOAuthAttempt(db, 'oauth_attempt_bad_key')).resolves.toMatchObject({
      status: 'storage_failed',
      failureCode: 'storage_failed',
      providerStatus: null,
    })
  })

  it('records storage_failed when TOKEN_ENCRYPTION_KEY is absent at callback time', async () => {
    await createTrackedState(db, { attemptId: 'oauth_attempt_missing_key', stateId: 'private-state-missing-key' })
    mockSuccessfulXCallback(fetchMock)

    const response = await app.request(
      '/connections/x/callback?code=private-auth-code&state=private-state-missing-key',
      {},
      testEnv(db, { TOKEN_ENCRYPTION_KEY: undefined as unknown as string }),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('reason=storage_failed')
    await expect(listConnections(db, PUBKEY_A)).resolves.toEqual([])
    await expect(getPreferences(db, PUBKEY_A)).resolves.toEqual([])
    await expect(getOAuthAttempt(db, 'oauth_attempt_missing_key')).resolves.toMatchObject({
      status: 'storage_failed',
      failureCode: 'storage_failed',
      providerStatus: null,
    })
  })

  it('normalizes a trailing slash in the OAuth callback redirect URI', async () => {
    await createTrackedState(db, { attemptId: 'oauth_attempt_trailing_slash', stateId: 'private-state-trailing-slash' })
    fetchMock
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = init.body as URLSearchParams
        expect(body.get('redirect_uri')).toBe('https://crossposter.divine.video/connections/x/callback')
        return Response.json({ access_token: 'private-access-token' })
      })
      .mockResolvedValueOnce(Response.json({ data: { id: 'x-account-trailing', username: 'divine' } }))

    const response = await app.request(
      '/connections/x/callback?code=private-auth-code&state=private-state-trailing-slash',
      {},
      testEnv(db, { OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video/' }),
    )

    expect(response.headers.get('location')).toContain('connection=connected')
  })

  it.each([
    {
      caseName: 'invalid redirect URL',
      platform: 'x' as const,
      stateId: 'private-state-invalid-redirect',
      attemptId: 'oauth_attempt_invalid_redirect',
      overrides: { OAUTH_REDIRECT_BASE: 'not-a-url' },
    },
    {
      caseName: 'invalid requested-provider configuration',
      platform: 'youtube' as const,
      stateId: 'private-state-invalid-youtube',
      attemptId: 'oauth_attempt_invalid_youtube',
      overrides: {
        ENABLE_YOUTUBE: 'true',
        GOOGLE_CLIENT_ID: 'google-client',
        GOOGLE_CLIENT_SECRET: 'google-secret',
        YOUTUBE_DEFAULT_PRIVACY_STATUS: 'friends',
      },
    },
  ])('classifies $caseName as callback_failed after consuming tracked state', async (testCase) => {
    await createTrackedState(db, {
      attemptId: testCase.attemptId,
      stateId: testCase.stateId,
      platform: testCase.platform,
    })

    const response = await app.request(
      `/connections/${testCase.platform}/callback?code=private-auth-code&state=${testCase.stateId}`,
      {},
      testEnv(db, testCase.overrides),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('reason=callback_failed')
    await expect(getOAuthAttempt(db, testCase.attemptId)).resolves.toMatchObject({
      status: 'callback_failed',
      failureCode: 'callback_failed',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      'connection insert',
      "CREATE TRIGGER reject_connection_insert BEFORE INSERT ON connections BEGIN SELECT RAISE(FAIL, 'forced'); END",
      'reject_connection_insert',
    ],
    [
      'preference write',
      "CREATE TRIGGER reject_preference_write BEFORE INSERT ON preferences BEGIN SELECT RAISE(FAIL, 'forced'); END",
      'reject_preference_write',
    ],
    [
      'connected attempt update',
      "CREATE TRIGGER reject_connected_attempt_update BEFORE UPDATE ON oauth_attempts WHEN NEW.status = 'connected' BEGIN SELECT RAISE(FAIL, 'forced'); END",
      'reject_connected_attempt_update',
    ],
  ])('rolls back the whole setup batch when the %s fails', async (_case, triggerSql, triggerName) => {
    const attemptId = `oauth_attempt_batch_${triggerName}`
    const stateId = `private-state-batch-${triggerName}`
    await createTrackedState(db, { attemptId, stateId })
    mockSuccessfulXCallback(fetchMock)
    await db.prepare(triggerSql).run()

    try {
      const response = await app.request(
        `/connections/x/callback?code=private-auth-code&state=${stateId}`,
        {},
        testEnv(db),
      )

      expect(response.headers.get('location')).toContain('reason=storage_failed')
      await expect(listConnections(db, PUBKEY_A)).resolves.toEqual([])
      await expect(getPreferences(db, PUBKEY_A)).resolves.toEqual([])
      await expect(getOAuthAttempt(db, attemptId)).resolves.toMatchObject({
        status: 'storage_failed',
        failureCode: 'storage_failed',
        providerStatus: null,
      })
    } finally {
      await db.prepare(`DROP TRIGGER ${triggerName}`).run()
    }
  })

  it('does not read the canonical connection after the atomic setup batch commits', async () => {
    await createTrackedState(db, { attemptId: 'oauth_attempt_no_post_read', stateId: 'private-state-no-post-read' })
    mockSuccessfulXCallback(fetchMock)
    const guardedDb = rejectPostBatchConnectionRead(db)

    const response = await app.request(
      '/connections/x/callback?code=private-auth-code&state=private-state-no-post-read',
      {},
      testEnv(guardedDb),
    )

    expect(response.headers.get('location')).toContain('connection=connected')
    await expect(getOAuthAttempt(db, 'oauth_attempt_no_post_read')).resolves.toMatchObject({ status: 'connected' })
    await expect(listConnections(db, PUBKEY_A)).resolves.toHaveLength(1)
  })

  it('removes a stale failure reason from a generic callback failure', async () => {
    await createOAuthState(db, {
      stateId: 'state_generic_failure',
      pubkey: PUBKEY_A,
      platform: 'tiktok',
      codeVerifier: 'pkce-verifier',
      returnUrl: 'https://divine.video/settings/crossposting?reason=provider_denied',
      createdAt: 1_000,
      expiresAt: 1_783_383_000,
      metadataJson: '{}',
    })

    const response = await app.request(
      '/connections/tiktok/callback?state=state_generic_failure',
      {},
      testEnv(db),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://divine.video/settings/crossposting?connection=failed&platform=tiktok',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lists connections without encrypted token fields', async () => {
    await upsertConnection(db, connection({ id: 'conn_tiktok' }))
    fetchMock.mockResolvedValueOnce(authResponse())

    const response = await app.request(
      '/connections',
      { headers: { authorization: 'Bearer keycast-token' } },
      testEnv(db),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { connections: Array<Record<string, unknown>> }
    expect(body.connections).toHaveLength(1)
    expect(body.connections[0]).toMatchObject({
      id: 'conn_tiktok',
      platform: 'tiktok',
      externalAccountId: 'external-account-1',
      externalAccountName: '@divine',
      status: 'connected',
    })
    expect(body.connections[0]).not.toHaveProperty('encryptedAccessToken')
    expect(body.connections[0]).not.toHaveProperty('encryptedRefreshToken')
    expect(body.connections[0]).not.toHaveProperty('metadataJson')
  })

  it('reconnect after disconnect restores the default manual preference', async () => {
    await upsertConnection(db, connection({ id: 'conn_old', status: 'disconnected' }))
    await setPreference(db, {
      pubkey: PUBKEY_A,
      platform: 'tiktok',
      connectionId: null,
      mode: 'disabled',
      automaticEnabledAt: null,
      createdAt: 1_000,
      updatedAt: 1_500,
    })
    await createOAuthState(db, {
      stateId: 'state_reconnect',
      pubkey: PUBKEY_A,
      platform: 'tiktok',
      codeVerifier: 'pkce-verifier',
      returnUrl: 'https://divine.video/settings/crossposting',
      createdAt: 1_000,
      expiresAt: 1_783_383_000,
      metadataJson: '{}',
    })
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: 'access-token', refresh_token: 'refresh-token' }))
      .mockResolvedValueOnce(Response.json({ data: { user: { open_id: 'external-account-1', display_name: 'Divine TikTok' } } }))

    const response = await app.request(
      '/connections/tiktok/callback?code=oauth-code&state=state_reconnect',
      {},
      testEnv(db),
    )

    expect(response.status).toBe(302)
    await expect(getPreferences(db, PUBKEY_A)).resolves.toMatchObject([
      { platform: 'tiktok', mode: 'manual', connectionId: 'conn_old', automaticEnabledAt: null },
    ])
  })

  it.each([
    ['manual', null],
    ['automatic', 1_400],
  ] as const)('reconnect preserves an existing %s preference exactly', async (mode, automaticEnabledAt) => {
    await upsertConnection(db, connection({ id: 'conn_preserved', platform: 'x', status: 'disconnected' }))
    await setPreference(db, {
      pubkey: PUBKEY_A,
      platform: 'x',
      connectionId: 'conn_preserved',
      mode,
      automaticEnabledAt,
      createdAt: 1_000,
      updatedAt: 1_500,
    })
    await createTrackedState(db, {
      attemptId: `oauth_attempt_preserve_${mode}`,
      stateId: `private-state-preserve-${mode}`,
    })
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: 'private-access-token' }))
      .mockResolvedValueOnce(
        Response.json({ data: { id: 'external-account-1', username: 'divine' } }),
      )

    const response = await app.request(
      `/connections/x/callback?code=private-auth-code&state=private-state-preserve-${mode}`,
      {},
      testEnv(db),
    )

    expect(response.headers.get('location')).toContain('connection=connected')
    await expect(getPreferences(db, PUBKEY_A)).resolves.toMatchObject([
      {
        platform: 'x',
        mode,
        connectionId: 'conn_preserved',
        automaticEnabledAt,
        createdAt: 1_000,
        updatedAt: 1_500,
      },
    ])
  })

  it('disconnects owned connections and disables the matching preference', async () => {
    await upsertConnection(db, connection({ id: 'conn_tiktok' }))
    await setPreference(db, {
      pubkey: PUBKEY_A,
      platform: 'tiktok',
      connectionId: 'conn_tiktok',
      mode: 'automatic',
      automaticEnabledAt: 1_500,
      createdAt: 1_000,
      updatedAt: 1_500,
    })
    fetchMock.mockResolvedValueOnce(authResponse())

    const response = await app.request(
      '/connections/tiktok/conn_tiktok',
      { method: 'DELETE', headers: { authorization: 'Bearer keycast-token' } },
      testEnv(db),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ disconnected: true })
    await expect(listConnections(db, PUBKEY_A)).resolves.toMatchObject([{ id: 'conn_tiktok', status: 'disconnected' }])
    await expect(getPreferences(db, PUBKEY_A)).resolves.toMatchObject([
      { platform: 'tiktok', connectionId: null, mode: 'disabled', automaticEnabledAt: null },
    ])
  })
})

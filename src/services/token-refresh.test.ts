import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getConnectionById, upsertConnection } from '../db/connections'
import { applyMigrations, connection, PUBKEY_B } from '../db/test-helpers'
import type { ConnectionRecord, Env } from '../types'
import { decryptToken, encryptToken } from '../utils/crypto'
import { refreshPolicy, runTokenRefreshSweep, shouldRefreshToken } from './token-refresh'

const KEY = '0123456789abcdef0123456789abcdef'
const DAY = 24 * 60 * 60
const NOW = 100 * DAY

function env(db: D1Database): Env {
  return {
    DB: db,
    CROSSPOST_QUEUE: {} as Queue<{ jobId: string }>,
    KEYCAST_URL: 'https://keycast.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video',
    TOKEN_ENCRYPTION_KEY: KEY,
    ENABLE_INSTAGRAM: 'true',
    INSTAGRAM_CLIENT_ID: 'instagram-client',
    INSTAGRAM_CLIENT_SECRET: 'instagram-secret',
    ENABLE_X: 'true',
    TWITTER_CLIENT_ID: 'x-client',
    TWITTER_CLIENT_SECRET: 'x-secret',
  }
}

async function seedInstagram(
  db: D1Database,
  overrides: Partial<ConnectionRecord> = {},
): Promise<ConnectionRecord> {
  const token = await encryptToken('ig-old-token', KEY)
  return upsertConnection(
    db,
    connection({
      id: 'conn_ig',
      platform: 'instagram',
      externalAccountId: 'ig-account',
      encryptedAccessToken: token,
      encryptedRefreshToken: token,
      createdAt: NOW - 55 * DAY,
      updatedAt: NOW - 55 * DAY,
      lastRefreshAt: null,
      tokenExpiresAt: NOW + 5 * DAY,
      ...overrides,
    }),
  )
}

async function seedX(db: D1Database, overrides: Partial<ConnectionRecord> = {}): Promise<ConnectionRecord> {
  return upsertConnection(
    db,
    connection({
      id: 'conn_x',
      platform: 'x',
      externalAccountId: 'x-account',
      encryptedAccessToken: await encryptToken('x-old-access', KEY),
      encryptedRefreshToken: await encryptToken('x-old-refresh', KEY),
      createdAt: NOW - 2 * 60 * 60,
      tokenExpiresAt: NOW + 5 * 60,
      ...overrides,
    }),
  )
}

const deadInstagramToken = () =>
  Response.json(
    { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } },
    { status: 400 },
  )

describe('token refresh policy', () => {
  it('refreshes Instagram a week ahead but never a token younger than a day', () => {
    const base = connection({ platform: 'instagram', createdAt: NOW - 30 * DAY, lastRefreshAt: null })
    expect(shouldRefreshToken({ ...base, tokenExpiresAt: NOW + 6 * DAY }, NOW)).toBe(true)
    expect(shouldRefreshToken({ ...base, tokenExpiresAt: NOW + 8 * DAY }, NOW)).toBe(false)
    expect(shouldRefreshToken({ ...base, tokenExpiresAt: NOW + 6 * DAY, lastRefreshAt: NOW - 3_600 }, NOW)).toBe(false)
  })

  it('always tries a token that is about to expire or already expired', () => {
    const young = connection({ platform: 'instagram', createdAt: NOW - 60, tokenExpiresAt: NOW - 10 })
    expect(shouldRefreshToken(young, NOW)).toBe(true)
  })

  it('refreshes short-lived X tokens only shortly before expiry', () => {
    expect(refreshPolicy('x').windowSeconds).toBeLessThan(DAY)
    const base = connection({ platform: 'x', createdAt: NOW - 3_600 })
    expect(shouldRefreshToken({ ...base, tokenExpiresAt: NOW + 5 * 60 }, NOW)).toBe(true)
    expect(shouldRefreshToken({ ...base, tokenExpiresAt: NOW + 60 * 60 }, NOW)).toBe(false)
  })

  it('never refreshes a connection without a refresh token or expiry', () => {
    expect(shouldRefreshToken(connection({ encryptedRefreshToken: null, tokenExpiresAt: NOW }), NOW)).toBe(false)
    expect(shouldRefreshToken(connection({ tokenExpiresAt: null }), NOW)).toBe(false)
  })
})

describe('runTokenRefreshSweep', () => {
  let db: D1Database
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = await applyMigrations()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('refreshes an Instagram token inside the window and stores the new token', async () => {
    const before = await seedInstagram(db)
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: 'ig-new-token', expires_in: 60 * DAY }))

    await expect(runTokenRefreshSweep(env(db), NOW)).resolves.toEqual({ refreshed: 1, needsReauth: 0, failed: 0 })

    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.pathname).toBe('/refresh_access_token')
    expect(url.searchParams.get('grant_type')).toBe('ig_refresh_token')
    expect(url.searchParams.get('access_token')).toBe('ig-old-token')
    const after = await getConnectionById(db, 'conn_ig')
    expect(after).toMatchObject({ status: 'connected', lastRefreshAt: NOW, updatedAt: NOW })
    expect(after?.tokenExpiresAt).toBeGreaterThan(before.tokenExpiresAt ?? 0)
    await expect(decryptToken(after!.encryptedAccessToken, KEY)).resolves.toBe('ig-new-token')
    await expect(decryptToken(after!.encryptedRefreshToken!, KEY)).resolves.toBe('ig-new-token')
    expect(after?.metadataJson).not.toContain('ig-new-token')
  })

  it('skips tokens that are not near expiry or were refreshed within the last day', async () => {
    await seedInstagram(db, { tokenExpiresAt: NOW + 30 * DAY })
    await seedInstagram(db, {
      id: 'conn_ig_young',
      pubkey: PUBKEY_B,
      tokenExpiresAt: NOW + 3 * DAY,
      lastRefreshAt: NOW - 3_600,
    })
    await seedX(db, { tokenExpiresAt: NOW + 60 * 60 })

    await expect(runTokenRefreshSweep(env(db), NOW)).resolves.toEqual({ refreshed: 0, needsReauth: 0, failed: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips connections that are no longer connected', async () => {
    await seedInstagram(db, { status: 'needs_reauth' })
    await seedX(db, { status: 'disconnected' })

    await runTokenRefreshSweep(env(db), NOW)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marks an expired Instagram token needs_reauth when Meta rejects it with code 190', async () => {
    await seedInstagram(db, { tokenExpiresAt: NOW - 19 * DAY })
    fetchMock.mockResolvedValueOnce(deadInstagramToken())

    await expect(runTokenRefreshSweep(env(db), NOW)).resolves.toEqual({ refreshed: 0, needsReauth: 1, failed: 0 })
    await expect(getConnectionById(db, 'conn_ig')).resolves.toMatchObject({ status: 'needs_reauth', updatedAt: NOW })
  })

  it('refreshes an X token near expiry, rotating the refresh token', async () => {
    await seedX(db)
    fetchMock.mockResolvedValueOnce(
      Response.json({ access_token: 'x-new-access', refresh_token: 'x-new-refresh', expires_in: 7_200 }),
    )

    await expect(runTokenRefreshSweep(env(db), NOW)).resolves.toMatchObject({ refreshed: 1 })
    const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams
    expect(body.get('refresh_token')).toBe('x-old-refresh')
    const after = await getConnectionById(db, 'conn_x')
    await expect(decryptToken(after!.encryptedAccessToken, KEY)).resolves.toBe('x-new-access')
    await expect(decryptToken(after!.encryptedRefreshToken!, KEY)).resolves.toBe('x-new-refresh')
  })

  it('marks an X connection needs_reauth when its refresh token is rejected with invalid_grant', async () => {
    await seedX(db)
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }))

    await expect(runTokenRefreshSweep(env(db), NOW)).resolves.toMatchObject({ needsReauth: 1 })
    await expect(getConnectionById(db, 'conn_x')).resolves.toMatchObject({ status: 'needs_reauth' })
  })

  it('isolates a transient failure on one connection from the others', async () => {
    await seedInstagram(db, { tokenExpiresAt: NOW + 1 * DAY })
    await seedX(db)
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: { message: 'temporarily unavailable' } }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'x-new-access', refresh_token: 'x-new-refresh', expires_in: 7_200 }))

    await expect(runTokenRefreshSweep(env(db), NOW)).resolves.toEqual({ refreshed: 1, needsReauth: 0, failed: 1 })
    await expect(getConnectionById(db, 'conn_ig')).resolves.toMatchObject({ status: 'connected', lastRefreshAt: null })
    await expect(getConnectionById(db, 'conn_x')).resolves.toMatchObject({ status: 'connected', lastRefreshAt: NOW })
  })

  it('refreshes at most the batch size per run, soonest expiry first', async () => {
    await seedInstagram(db, { id: 'conn_later', tokenExpiresAt: NOW + 4 * DAY })
    await seedInstagram(db, { id: 'conn_sooner', pubkey: PUBKEY_B, tokenExpiresAt: NOW + 2 * DAY })
    fetchMock.mockImplementation(async () => Response.json({ access_token: 'ig-new-token', expires_in: 60 * DAY }))

    await expect(runTokenRefreshSweep(env(db), NOW, 1)).resolves.toMatchObject({ refreshed: 1 })
    expect(fetchMock).toHaveBeenCalledOnce()
    await expect(getConnectionById(db, 'conn_sooner')).resolves.toMatchObject({ lastRefreshAt: NOW })
    await expect(getConnectionById(db, 'conn_later')).resolves.toMatchObject({ lastRefreshAt: null })
  })

  it('does not flag a connection that was reconnected while its old token was being refreshed', async () => {
    await seedInstagram(db, { tokenExpiresAt: NOW - DAY })
    fetchMock.mockImplementationOnce(async () => {
      const current = await getConnectionById(db, 'conn_ig')
      await upsertConnection(db, {
        ...current!,
        encryptedAccessToken: await encryptToken('ig-reconnected-token', KEY),
        tokenExpiresAt: NOW + 60 * DAY,
      })
      return deadInstagramToken()
    })

    await expect(runTokenRefreshSweep(env(db), NOW)).resolves.toMatchObject({ refreshed: 1, needsReauth: 0 })
    const after = await getConnectionById(db, 'conn_ig')
    expect(after?.status).toBe('connected')
    await expect(decryptToken(after!.encryptedAccessToken, KEY)).resolves.toBe('ig-reconnected-token')
  })

  it('leaves connections of disabled platforms alone', async () => {
    await seedInstagram(db)
    const disabled = { ...env(db), ENABLE_INSTAGRAM: 'false' }

    await runTokenRefreshSweep(disabled, NOW)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

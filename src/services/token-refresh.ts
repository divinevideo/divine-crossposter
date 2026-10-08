import {
  getConnectionById,
  listConnectionsDueForRefresh,
  markConnectionNeedsReauthIfTokenUnchanged,
  storeRefreshedTokens,
} from '../db/connections'
import { asRecord, PlatformAdapterError } from '../platforms/adapter'
import type { PlatformAdapter } from '../platforms/adapter'
import { getEnabledAdapters } from '../platforms/registry'
import type { ConnectionRecord, Env, Platform } from '../types'
import { decryptToken, encryptToken } from '../utils/crypto'
import { sanitizeProviderMetadata } from '../utils/provider-metadata'

const DAY_SECONDS = 24 * 60 * 60

/** A token this close to expiry is refreshed regardless of how recently it was issued. */
export const TOKEN_FORCE_REFRESH_SECONDS = 60

/** Maximum connections the scheduled sweep refreshes per tick, across all platforms. */
export const TOKEN_REFRESH_BATCH_SIZE = 25

export type RefreshPolicy = {
  /** Refresh once the token expires within this many seconds. */
  windowSeconds: number
  /** Do not refresh a token issued less than this many seconds ago. */
  minAgeSeconds: number
  /** Whether the scheduled sweep refreshes this platform ahead of use. */
  proactive: boolean
}

/**
 * Instagram long-lived tokens last 60 days and can only be refreshed while
 * still valid and at least 24 hours old; once expired the user must reconnect.
 * The scheduled sweep refreshes them a week ahead, leaving many chances to
 * land one even for a creator who has stopped posting.
 *
 * The other providers issue short-lived access tokens (X: 2 hours) with a
 * separate refresh token that stays usable, so they refresh only at publish
 * time, just before expiry. Sweeping them would refresh every idle connection
 * every couple of hours, race publishes for X's single-use refresh tokens, and
 * retry every minute forever on an error that is not a clear dead credential.
 */
export function refreshPolicy(platform: Platform): RefreshPolicy {
  if (platform === 'instagram') {
    return { windowSeconds: 7 * DAY_SECONDS, minAgeSeconds: DAY_SECONDS, proactive: true }
  }
  return { windowSeconds: TOKEN_FORCE_REFRESH_SECONDS, minAgeSeconds: 0, proactive: false }
}

export function shouldRefreshToken(connection: ConnectionRecord, now: number): boolean {
  if (!connection.encryptedRefreshToken || !connection.tokenExpiresAt) return false
  const policy = refreshPolicy(connection.platform)
  if (connection.tokenExpiresAt > now + policy.windowSeconds) return false
  if (connection.tokenExpiresAt <= now + TOKEN_FORCE_REFRESH_SECONDS) return true
  const issuedAt = connection.lastRefreshAt ?? connection.createdAt
  return now - issuedAt >= policy.minAgeSeconds
}

export type RefreshOutcome =
  | { status: 'refreshed'; accessToken: string }
  | { status: 'superseded'; accessToken: string }
  | { status: 'needs_reauth'; error: PlatformAdapterError }

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

function parseMetadata(json: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(json || '{}'))
  } catch {
    return {}
  }
}

async function currentAccessToken(env: Env, connection: ConnectionRecord): Promise<string | null> {
  const current = await getConnectionById(env.DB, connection.id)
  if (!current || current.status !== 'connected') return null
  if (current.encryptedAccessToken === connection.encryptedAccessToken) return null
  return decryptToken(current.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY)
}

/**
 * Refreshes one connection's token and stores the result.
 *
 * If the provider says the token is dead, the connection is marked
 * needs_reauth — unless another refresh or a reconnect replaced the token in
 * the meantime, in which case that newer token is returned instead.
 *
 * Throws on any other provider or storage failure.
 */
export async function refreshConnectionToken(
  env: Env,
  adapter: PlatformAdapter,
  connection: ConnectionRecord,
  now: number,
): Promise<RefreshOutcome> {
  if (!connection.encryptedRefreshToken) {
    throw new Error('connection has no refresh token')
  }

  let refreshed
  try {
    refreshed = await adapter.refreshToken({
      refreshToken: await decryptToken(connection.encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY),
    })
  } catch (error) {
    if (!(error instanceof PlatformAdapterError) || error.code !== 'needs_reauth') throw error
    const newer = await currentAccessToken(env, connection)
    if (newer) return { status: 'superseded', accessToken: newer }
    const marked = await markConnectionNeedsReauthIfTokenUnchanged(
      env.DB,
      connection.id,
      connection.encryptedAccessToken,
      now,
    )
    if (!marked) {
      // The token changed between the re-read and the mark: a reconnect or a
      // concurrent refresh won, so the connection is healthy.
      const replaced = await currentAccessToken(env, connection)
      if (replaced) return { status: 'superseded', accessToken: replaced }
    }
    return { status: 'needs_reauth', error }
  }

  const stored = await storeRefreshedTokens(env.DB, {
    id: connection.id,
    expectedEncryptedAccessToken: connection.encryptedAccessToken,
    encryptedAccessToken: await encryptToken(refreshed.accessToken, env.TOKEN_ENCRYPTION_KEY),
    encryptedRefreshToken: refreshed.refreshToken
      ? await encryptToken(refreshed.refreshToken, env.TOKEN_ENCRYPTION_KEY)
      : connection.encryptedRefreshToken,
    tokenExpiresAt: refreshed.expiresAt ?? connection.tokenExpiresAt,
    grantedScopes: refreshed.scopes.length ? refreshed.scopes.join(' ') : connection.grantedScopes,
    metadataJson: safeJson({
      ...parseMetadata(connection.metadataJson),
      token: sanitizeProviderMetadata(refreshed.metadata),
    }),
    now,
  })
  // Losing the write means a reconnect or another refresh stored newer tokens.
  // The token just issued is still valid for this caller either way.
  return { status: stored ? 'refreshed' : 'superseded', accessToken: refreshed.accessToken }
}

export type TokenRefreshSweepResult = {
  refreshed: number
  needsReauth: number
  failed: number
}

/**
 * Scheduled sweep: refreshes connected tokens of proactive platforms (today
 * only Instagram) that are inside their refresh window, at most `batchSize`
 * per run. One connection's failure never
 * stops the others; dead tokens are flagged needs_reauth so the app prompts
 * the user to reconnect instead of silently failing every crosspost.
 */
export async function runTokenRefreshSweep(
  env: Env,
  now: number,
  batchSize = TOKEN_REFRESH_BATCH_SIZE,
): Promise<TokenRefreshSweepResult> {
  const result: TokenRefreshSweepResult = { refreshed: 0, needsReauth: 0, failed: 0 }
  let remaining = batchSize

  for (const adapter of getEnabledAdapters(env)) {
    if (remaining <= 0) break
    const policy = refreshPolicy(adapter.platform)
    if (!policy.proactive) continue
    const due = await listConnectionsDueForRefresh(env.DB, {
      platform: adapter.platform,
      refreshBefore: now + policy.windowSeconds,
      issuedBefore: now - policy.minAgeSeconds,
      forceBefore: now + TOKEN_FORCE_REFRESH_SECONDS,
      limit: remaining,
    })
    remaining -= due.length

    for (const connection of due) {
      try {
        const outcome = await refreshConnectionToken(env, adapter, connection, now)
        if (outcome.status === 'needs_reauth') {
          result.needsReauth += 1
          console.warn(`token refresh rejected; connection ${connection.id} (${connection.platform}) needs reauth`)
        } else {
          result.refreshed += 1
        }
      } catch (error) {
        result.failed += 1
        const status = error instanceof PlatformAdapterError ? ` provider status ${error.providerStatus ?? 'none'}` : ''
        console.warn(`token refresh failed for connection ${connection.id} (${connection.platform})${status}`)
      }
    }
  }

  return result
}

import { authenticateRequest } from '../auth/keycast'
import {
  completeConnectionSetup,
  disconnectConnection,
  getActiveConnectionForPlatform,
  getConnection,
  listConnections,
} from '../db/connections'
import { createOAuthAttempt, updateOAuthAttempt } from '../db/oauth-attempts'
import { consumeOAuthState, createOAuthState } from '../db/oauth-states'
import { getPreferences, setPreference } from '../db/preferences'
import { loadConfig, oauthRedirectBase } from '../config'
import { getAdapter } from '../platforms/registry'
import { PlatformAdapterError } from '../platforms/adapter'
import type { PlatformAccount, PlatformAdapter, TokenSet } from '../platforms/adapter'
import type {
  ConnectionRecord,
  Env,
  OAuthAttemptFailureCode,
  OAuthAttemptStatus,
  OAuthStateRecord,
  Platform,
  PreferenceMode,
  PreferenceRecord,
} from '../types'
import { decryptToken, encryptToken, generatePKCE, generateRandomId } from '../utils/crypto'
import { HttpError } from '../utils/http'
import { providerErrorDiagnostics } from '../utils/provider-error-diagnostics'
import { sanitizeProviderMetadata } from '../utils/provider-metadata'
import { assertAllowedReturnUrl, parsePlatform, parsePreferenceMode } from '../utils/validation'

const OAUTH_STATE_TTL_SECONDS = 10 * 60

type ConnectionSummary = {
  id: string
  platform: Platform
  externalAccountId: string
  externalAccountName: string
  tokenExpiresAt: number | null
  grantedScopes: string
  status: ConnectionRecord['status']
  createdAt: number
  updatedAt: number
  lastRefreshAt: number | null
}

type PreferenceSummary = {
  platform: Platform
  connectionId: string | null
  mode: PreferenceMode
  automaticEnabledAt: number | null
  createdAt: number
  updatedAt: number
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000)
}

function callbackRedirectUri(env: Env, platform: Platform): string {
  return `${oauthRedirectBase(env)}/connections/${platform}/callback`
}

function connectionSummary(connection: ConnectionRecord): ConnectionSummary {
  return {
    id: connection.id,
    platform: connection.platform,
    externalAccountId: connection.externalAccountId,
    externalAccountName: connection.externalAccountName,
    tokenExpiresAt: connection.tokenExpiresAt,
    grantedScopes: connection.grantedScopes,
    status: connection.status,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    lastRefreshAt: connection.lastRefreshAt,
  }
}

function preferenceSummary(preference: PreferenceRecord): PreferenceSummary {
  return {
    platform: preference.platform,
    connectionId: preference.connectionId,
    mode: preference.mode,
    automaticEnabledAt: preference.automaticEnabledAt,
    createdAt: preference.createdAt,
    updatedAt: preference.updatedAt,
  }
}

type ConnectionFailureReason =
  | 'provider_denied'
  | 'callback_failed'
  | 'token_exchange_failed'
  | 'account_lookup_failed'
  | 'storage_failed'

function redirectWithResult(
  returnUrl: string,
  platform: Platform,
  result: 'connected' | 'failed',
  reason?: ConnectionFailureReason,
): string {
  const url = new URL(returnUrl)
  url.searchParams.set('connection', result)
  url.searchParams.set('platform', platform)
  url.searchParams.delete('reason')
  if (reason) {
    url.searchParams.set('reason', reason)
  }
  return url.toString()
}

function redirectBase(env: Env): string {
  return oauthRedirectBase(env)
}

export function attemptIdFromState(state: OAuthStateRecord): string | null {
  try {
    const metadata = JSON.parse(state.metadataJson) as unknown
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null
    }
    const attemptId = (metadata as Record<string, unknown>).attemptId
    return typeof attemptId === 'string' && attemptId.length > 0 ? attemptId : null
  } catch {
    return null
  }
}

export function providerStatus(error: unknown): number | null {
  return error instanceof PlatformAdapterError ? error.providerStatus ?? null : null
}

function logAttemptTransition(
  attemptId: string,
  platform: Platform,
  status: OAuthAttemptStatus,
  failureCode: OAuthAttemptFailureCode | null,
  error?: unknown,
): void {
  console.info(JSON.stringify({
    event: 'oauth_callback_transition',
    attemptId,
    platform,
    status,
    failureCode,
    providerStatus: providerStatus(error),
    providerError: providerErrorDiagnostics(error),
  }))
}

export async function transitionAttempt(
  env: Env,
  attemptId: string | null,
  platform: Platform,
  status: OAuthAttemptStatus,
  failureCode: OAuthAttemptFailureCode | null,
  error?: unknown,
): Promise<void> {
  if (!attemptId) return
  await updateOAuthAttempt(env.DB, {
    id: attemptId,
    status,
    failureCode,
    providerStatus: providerStatus(error),
    updatedAt: nowSeconds(),
  })
  logAttemptTransition(attemptId, platform, status, failureCode, error)
}

async function failureRedirect(
  env: Env,
  state: OAuthStateRecord,
  redirectPlatform: Platform,
  reason: ConnectionFailureReason,
  error?: unknown,
): Promise<string> {
  const attemptId = attemptIdFromState(state)
  await transitionAttempt(env, attemptId, state.platform, reason, reason, error).catch(() => undefined)
  const redirectReason = attemptId || reason === 'provider_denied' ? reason : undefined
  return redirectWithResult(state.returnUrl, redirectPlatform, 'failed', redirectReason)
}

async function disablePreferenceForConnection(
  db: D1Database,
  pubkey: string,
  platform: Platform,
  connectionId: string,
  now: number,
): Promise<void> {
  const preference = (await getPreferences(db, pubkey)).find(
    (candidate) => candidate.platform === platform && candidate.connectionId === connectionId,
  )
  if (!preference) {
    return
  }

  await setPreference(db, {
    pubkey,
    platform,
    connectionId: null,
    mode: 'disabled',
    automaticEnabledAt: null,
    createdAt: preference.createdAt,
    updatedAt: now,
  })
}

export async function startConnection(
  request: Request,
  env: Env,
  platformValue: string,
  returnUrlValue: unknown,
): Promise<{ authorizationUrl: string; state: string }> {
  const platform = parsePlatform(platformValue)
  const adapter = getAdapter(env, platform)
  if (!adapter) {
    throw new HttpError(404, 'platform_not_enabled', 'platform is not enabled')
  }
  if (typeof returnUrlValue !== 'string') {
    throw new HttpError(400, 'invalid_return_url', 'invalid return url')
  }

  const { pubkey } = await authenticateRequest(request, env)
  const config = loadConfig(env)
  const returnUrl = assertAllowedReturnUrl(returnUrlValue, config.oauthRedirectBase)
  const now = nowSeconds()
  const state = generateRandomId(24)
  const attemptId = `oauth_attempt_${generateRandomId(16)}`
  const pkce = await generatePKCE()
  const expiresAt = now + OAUTH_STATE_TTL_SECONDS

  await createOAuthAttempt(env.DB, {
    id: attemptId,
    pubkey,
    platform,
    status: 'started',
    failureCode: null,
    providerStatus: null,
    createdAt: now,
    expiresAt,
    updatedAt: now,
  })

  try {
    await createOAuthState(env.DB, {
      stateId: state,
      pubkey,
      platform,
      codeVerifier: pkce.verifier,
      returnUrl,
      createdAt: now,
      expiresAt,
      metadataJson: JSON.stringify({ attemptId }),
    })
  } catch (error) {
    await transitionAttempt(env, attemptId, platform, 'storage_failed', 'storage_failed', error).catch(() => undefined)
    throw error
  }

  return {
    state,
    authorizationUrl: adapter.buildAuthorizationUrl({
      state,
      redirectUri: callbackRedirectUri(env, platform),
      codeChallenge: pkce.challenge,
    }),
  }
}

export async function completeConnectionCallback(
  env: Env,
  platformValue: string,
  code: string | null,
  stateId: string | null,
  providerError: string | null = null,
  providerErrorReason: string | null = null,
): Promise<string> {
  const platform = parsePlatform(platformValue)
  if (!stateId) {
    return redirectWithResult(redirectBase(env), platform, 'failed')
  }

  const state = await consumeOAuthState(env.DB, stateId, nowSeconds())
  if (!state) {
    return redirectWithResult(redirectBase(env), platform, 'failed')
  }

  if (state.platform !== platform) {
    return failureRedirect(env, state, platform, 'callback_failed')
  }

  if (providerError || providerErrorReason) {
    const denied = [providerError, providerErrorReason].some(
      (value) => value === 'access_denied' || value === 'user_denied',
    )
    return failureRedirect(env, state, platform, denied ? 'provider_denied' : 'callback_failed')
  }

  if (!code) {
    return failureRedirect(env, state, platform, 'callback_failed')
  }

  let adapter: PlatformAdapter | null
  let redirectUri: string
  try {
    adapter = getAdapter(env, platform)
    redirectUri = callbackRedirectUri(env, platform)
  } catch {
    return failureRedirect(env, state, platform, 'callback_failed')
  }
  if (!adapter) {
    return failureRedirect(env, state, platform, 'callback_failed')
  }

  let tokens: TokenSet
  try {
    tokens = await adapter.exchangeCallback({
      code,
      redirectUri,
      codeVerifier: state.codeVerifier ?? undefined,
    })
  } catch (error) {
    return failureRedirect(env, state, platform, 'token_exchange_failed', error)
  }

  let account: PlatformAccount
  try {
    account = await adapter.fetchAccount({ accessToken: tokens.accessToken })
  } catch (error) {
    return failureRedirect(env, state, platform, 'account_lookup_failed', error)
  }

  if (!account.id) {
    return failureRedirect(
      env,
      state,
      platform,
      'account_lookup_failed',
      new PlatformAdapterError(platform, 'unknown_platform_error', 'provider account ID was empty', 200),
    )
  }

  const now = nowSeconds()
  let connectionInput: ConnectionRecord
  try {
    connectionInput = {
      id: `conn_${generateRandomId(16)}`,
      pubkey: state.pubkey,
      platform,
      externalAccountId: account.id,
      externalAccountName: account.name,
      encryptedAccessToken: await encryptToken(tokens.accessToken, env.TOKEN_ENCRYPTION_KEY),
      encryptedRefreshToken: tokens.refreshToken
        ? await encryptToken(tokens.refreshToken, env.TOKEN_ENCRYPTION_KEY)
        : null,
      tokenExpiresAt: tokens.expiresAt ?? null,
      grantedScopes: tokens.scopes.join(','),
      status: 'connected',
      createdAt: now,
      updatedAt: now,
      lastRefreshAt: null,
      metadataJson: JSON.stringify({
        account: sanitizeProviderMetadata(account.metadata),
        token: sanitizeProviderMetadata(tokens.metadata),
      }),
    }
  } catch (error) {
    return failureRedirect(env, state, platform, 'storage_failed', error)
  }

  const attemptId = attemptIdFromState(state)
  try {
    await completeConnectionSetup(env.DB, {
      connection: connectionInput,
      preference: {
        pubkey: state.pubkey,
        platform,
        connectionId: connectionInput.id,
        mode: 'manual',
        automaticEnabledAt: null,
        createdAt: now,
        updatedAt: now,
      },
      attemptId,
      now,
    })
    if (attemptId) {
      logAttemptTransition(attemptId, platform, 'connected', null)
    }
    return redirectWithResult(state.returnUrl, platform, 'connected')
  } catch (error) {
    return failureRedirect(env, state, platform, 'storage_failed', error)
  }
}

export async function listConnectionSummaries(request: Request, env: Env): Promise<ConnectionSummary[]> {
  const { pubkey } = await authenticateRequest(request, env)
  return (await listConnections(env.DB, pubkey)).map(connectionSummary)
}

export async function disconnectOwnedConnection(
  request: Request,
  env: Env,
  platformValue: string,
  connectionId: string,
): Promise<{ disconnected: true }> {
  const platform = parsePlatform(platformValue)
  const { pubkey } = await authenticateRequest(request, env)
  const connection = await getConnection(env.DB, connectionId, pubkey)
  if (!connection || connection.platform !== platform) {
    throw new HttpError(404, 'not_connected', 'connection not found')
  }

  const adapter = getAdapter(env, platform)
  if (adapter?.revoke) {
    try {
      await adapter.revoke({
        accessToken: await decryptToken(connection.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY),
        refreshToken: connection.encryptedRefreshToken
          ? await decryptToken(connection.encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY)
          : undefined,
      })
    } catch {
      // Local disconnect is the source of truth for stopping future crossposts.
    }
  }

  const now = nowSeconds()
  await disconnectConnection(env.DB, connection.id, pubkey, now)
  await disablePreferenceForConnection(env.DB, pubkey, platform, connection.id, now)
  return { disconnected: true }
}

export async function listPreferenceSummaries(request: Request, env: Env): Promise<PreferenceSummary[]> {
  const { pubkey } = await authenticateRequest(request, env)
  return (await getPreferences(env.DB, pubkey)).map(preferenceSummary)
}

export async function updatePreference(
  request: Request,
  env: Env,
  platformValue: string,
  modeValue: unknown,
): Promise<PreferenceSummary> {
  const platform = parsePlatform(platformValue)
  const mode = parsePreferenceMode(String(modeValue))
  const { pubkey } = await authenticateRequest(request, env)
  const now = nowSeconds()
  const existing = (await getPreferences(env.DB, pubkey)).find((preference) => preference.platform === platform)

  let connectionId: string | null = null
  let automaticEnabledAt: number | null = null
  if (mode === 'manual' || mode === 'automatic') {
    const connection = await getActiveConnectionForPlatform(env.DB, pubkey, platform)
    if (!connection) {
      throw new HttpError(400, 'not_connected', 'platform is not connected')
    }
    connectionId = connection.id
    automaticEnabledAt = mode === 'automatic' && existing?.mode === 'automatic' ? existing.automaticEnabledAt : now
  }

  const preference = await setPreference(env.DB, {
    pubkey,
    platform,
    connectionId,
    mode,
    automaticEnabledAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })

  return preferenceSummary(preference)
}

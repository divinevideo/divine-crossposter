import type { ErrorCode, Platform } from '../types'

export type PlatformAccount = {
  id: string
  name: string
  metadata: Record<string, unknown>
}

export type TokenSet = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scopes: string[]
  metadata: Record<string, unknown>
}

export type PublishInput = {
  accessToken: string
  videoUrl: string
  mediaHash: string
  caption: string
  externalAccountId: string
  beforeExternalPost?: () => Promise<void>
}

export type PollPublishInput = {
  accessToken: string
  providerResponse: Record<string, unknown>
  beforeExternalPost?: () => Promise<void>
}

export type PublishResult = {
  status: 'posted' | 'processing'
  externalPostId?: string
  externalPostUrl?: string
  providerResponse: Record<string, unknown>
}

export interface PlatformAdapter {
  platform: Platform
  buildAuthorizationUrl(input: { state: string; redirectUri: string; codeChallenge?: string }): string
  exchangeCallback(input: { code: string; redirectUri: string; codeVerifier?: string }): Promise<TokenSet>
  refreshToken(input: { refreshToken: string }): Promise<TokenSet>
  fetchAccount(input: { accessToken: string }): Promise<PlatformAccount>
  publishVideo(input: PublishInput): Promise<PublishResult>
  pollPublishStatus?(input: PollPublishInput): Promise<PublishResult>
  revoke?(input: { accessToken: string; refreshToken?: string }): Promise<void>
}

export class PlatformAdapterError extends Error {
  constructor(
    public readonly platform: Platform,
    public readonly code: ErrorCode,
    message: string,
    public readonly providerStatus?: number,
    public readonly providerResponse?: unknown,
    // Origin and scrubbed path of the failing request; the query can carry secrets.
    public readonly providerEndpoint?: string,
  ) {
    super(message)
  }
}

const SAFE_PATH_SEGMENTS = new Set([
  'o',
  'i',
  'auth',
  'authorize',
  'oauth',
  'oauth2',
  'token',
  'access_token',
  'refresh_access_token',
  'users',
  'me',
  'user',
  'info',
  'media',
  'upload',
  'tweets',
  'post',
  'publish',
  'creator_info',
  'query',
  'video',
  'init',
  'status',
  'fetch',
  'youtube',
  'channels',
  'media_publish',
])

function isSafePathSegment(segment: string): boolean {
  return (
    segment === '' ||
    /^\d{1,2}$/.test(segment) ||
    /^v\d{1,3}(?:\.\d{1,2})?$/.test(segment) ||
    SAFE_PATH_SEGMENTS.has(segment)
  )
}

export function providerEndpoint(response: Response): string | undefined {
  if (!response.url) return undefined
  try {
    const url = new URL(response.url)
    const pathname = url.pathname
      .split('/')
      .map((segment) => (isSafePathSegment(segment) ? segment : '[redacted]'))
      .join('/')
    return `${url.origin}${pathname}`
  } catch {
    return undefined
  }
}

function includesMediaRejection(value: unknown): boolean {
  const normalized = JSON.stringify(value).toLowerCase()
  return (
    normalized.includes('media_rejected') ||
    normalized.includes('media rejected') ||
    normalized.includes('invalid_media') ||
    normalized.includes('unsupported media') ||
    normalized.includes('video is invalid')
  )
}

export async function readProviderResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

// Meta Graph error codes meaning the access token is expired, revoked, or
// otherwise unusable (190 "Invalid OAuth access token", 102 "API session").
// Meta returns these with HTTP 400, so the status alone never reveals them.
const META_DEAD_TOKEN_CODES = new Set([102, 190])

// RFC 6749 token-endpoint errors meaning the refresh token or grant is dead
// (X, YouTube and TikTok return these with HTTP 400 on refresh).
const OAUTH_DEAD_GRANT_ERRORS = new Set(['invalid_grant', 'invalid_token'])

// RFC 6749 errors about the app's own client credentials. A client that
// authenticates with HTTP Basic (as X does) gets these with HTTP 401, which
// must not flag every user's connection for reconnect.
const OAUTH_CLIENT_ERRORS = new Set(['invalid_client', 'unauthorized_client'])

/**
 * True when a provider error body says the user's credential is dead and only
 * reconnecting can fix it, whatever HTTP status carried it.
 */
export function isDeadCredential(providerResponse: unknown): boolean {
  const body = asRecord(providerResponse)
  if (typeof body.error === 'string' && OAUTH_DEAD_GRANT_ERRORS.has(body.error)) return true

  const metaError = asRecord(body.error)
  const metaCode = Number(metaError.code ?? body.code)
  if (Number.isInteger(metaCode) && META_DEAD_TOKEN_CODES.has(metaCode)) {
    return metaError.type === undefined || metaError.type === 'OAuthException' || body.error_type === 'OAuthException'
  }
  return false
}

export async function normalizeProviderError(platform: Platform, response: Response): Promise<PlatformAdapterError> {
  const providerResponse = await readProviderResponse(response)
  let code: ErrorCode = 'unknown_platform_error'

  const clientError = OAUTH_CLIENT_ERRORS.has(String(asRecord(providerResponse).error))
  if (!clientError && (response.status === 401 || response.status === 403 || isDeadCredential(providerResponse))) {
    code = 'needs_reauth'
  } else if (response.status === 429) {
    code = 'rate_limited'
  } else if (includesMediaRejection(providerResponse)) {
    code = 'media_rejected'
  }

  return new PlatformAdapterError(
    platform,
    code,
    `${platform} provider request failed`,
    response.status,
    providerResponse,
    providerEndpoint(response),
  )
}

function normalizeTikTokErrorCode(providerResponse: unknown): ErrorCode | null {
  const body = asRecord(providerResponse)
  const error = asRecord(body.error)
  const code = typeof error.code === 'string' ? error.code : ''

  if (!code || code === 'ok') return null

  const normalized = code.toLowerCase()
  if (
    normalized.includes('access_token') ||
    normalized.includes('scope') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  ) {
    return 'needs_reauth'
  }
  if (normalized.includes('rate_limit') || normalized.includes('too_many')) {
    return 'rate_limited'
  }
  if (includesMediaRejection(providerResponse)) {
    return 'media_rejected'
  }
  return 'unknown_platform_error'
}

export async function expectProviderOk(platform: Platform, response: Response): Promise<unknown> {
  if (!response.ok) {
    throw await normalizeProviderError(platform, response)
  }
  const providerResponse = await readProviderResponse(response)
  if (platform === 'tiktok') {
    const code = normalizeTikTokErrorCode(providerResponse)
    if (code) {
      throw new PlatformAdapterError(
        platform,
        code,
        `${platform} provider request failed`,
        response.status,
        providerResponse,
        providerEndpoint(response),
      )
    }
  }
  return providerResponse
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export async function fetchVideoBytes(
  platform: Platform,
  videoUrl: string,
  maxBytes?: number,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const response = await fetch(videoUrl)
  if (!response.ok) {
    throw new PlatformAdapterError(platform, 'unknown_platform_error', 'failed to fetch source video', response.status)
  }
  if (maxBytes !== undefined) {
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new PlatformAdapterError(platform, 'media_rejected', 'source video exceeds upload size limit')
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new PlatformAdapterError(platform, 'media_rejected', 'source video is empty')
    }
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new PlatformAdapterError(platform, 'media_rejected', 'source video exceeds upload size limit')
      }
      chunks.push(value)
    }
    if (totalBytes === 0) {
      throw new PlatformAdapterError(platform, 'media_rejected', 'source video is empty')
    }

    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return {
      bytes: bytes.buffer,
      contentType: response.headers.get('content-type') ?? 'video/mp4',
    }
  }
  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get('content-type') ?? 'video/mp4',
  }
}

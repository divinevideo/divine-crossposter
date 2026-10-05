import type { Env } from '../types'
import { loadConfig } from '../config'
import { HttpError } from '../utils/http'
import { normalizePubkey } from '../utils/validation'
import { verifyNip98Request } from './nip98'

/** Who made the request, and which credential proved it. */
export type AuthenticatedCaller =
  | { scheme: 'nip98'; pubkey: string; eventId: string }
  | { scheme: 'keycast'; pubkey: string; token: string }

type KeycastPublicKeyResponse = {
  result?: unknown
  error?: unknown
}

function parseAuthorization(request: Request): { scheme: 'nostr' | 'bearer'; credential: string } {
  const authorization = request.headers.get('authorization')
  const match = authorization?.match(/^(Nostr|Bearer)\s+(.+)$/i)
  if (!match || !match[2].trim()) {
    throw new HttpError(401, 'unauthorized', 'missing bearer token or nostr auth event')
  }
  return { scheme: match[1].toLowerCase() as 'nostr' | 'bearer', credential: match[2].trim() }
}

function upstreamAuthError(status: number): HttpError {
  if (status === 401) {
    return new HttpError(401, 'unauthorized', 'invalid bearer token')
  }
  if (status === 403) {
    return new HttpError(403, 'forbidden', 'bearer token is not allowed')
  }
  return new HttpError(502, 'keycast_unavailable', 'keycast auth failed')
}

/**
 * Authenticates a request and returns the caller's full hex pubkey.
 *
 * Accepts either a NIP-98 signed event (`Authorization: Nostr <base64 event>`),
 * verified locally, or a legacy Keycast OAuth token (`Authorization: Bearer`),
 * validated by asking Keycast for the token's public key.
 *
 * Throws [HttpError] 401/403 for rejected credentials and 502 when Keycast
 * is unreachable or malformed.
 */
export async function authenticateRequest(request: Request, env: Env): Promise<AuthenticatedCaller> {
  const { scheme, credential } = parseAuthorization(request)
  if (scheme === 'nostr') {
    return { scheme: 'nip98', ...(await verifyNip98Request(request, credential)) }
  }
  return authenticateKeycastToken(credential, env)
}

async function authenticateKeycastToken(token: string, env: Env): Promise<AuthenticatedCaller> {
  const config = loadConfig(env)

  let response: Response
  try {
    response = await fetch(`${config.keycastUrl}/api/nostr`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'get_public_key', params: [] }),
    })
  } catch {
    throw new HttpError(502, 'keycast_unavailable', 'keycast auth failed')
  }

  if (!response.ok) {
    throw upstreamAuthError(response.status)
  }

  let body: KeycastPublicKeyResponse
  try {
    body = (await response.json()) as KeycastPublicKeyResponse
  } catch {
    throw new HttpError(502, 'keycast_malformed_response', 'keycast response was malformed')
  }

  if (body.error || typeof body.result !== 'string' || body.result.length === 0) {
    throw new HttpError(502, 'keycast_malformed_response', 'keycast response was malformed')
  }

  try {
    return { scheme: 'keycast', pubkey: normalizePubkey(body.result), token }
  } catch {
    throw new HttpError(502, 'keycast_malformed_response', 'keycast response was malformed')
  }
}

import { schnorr } from '@noble/curves/secp256k1.js'
import { HttpError } from '../utils/http'

/** NIP-98 HTTP Auth event kind. */
export const NIP98_KIND = 27235

/** Maximum allowed distance between the event's created_at and server time. */
export const NIP98_MAX_SKEW_SECONDS = 60

/** Upper bound on the encoded header so a hostile client cannot make us decode megabytes. */
const MAX_ENCODED_EVENT_LENGTH = 16 * 1024

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/

type Nip98Event = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

function unauthorized(message: string): HttpError {
  return new HttpError(401, 'unauthorized', message)
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
}

function decodeEvent(encoded: string): Nip98Event {
  if (encoded.length > MAX_ENCODED_EVENT_LENGTH) {
    throw unauthorized('nostr auth event is too large')
  }

  let parsed: unknown
  try {
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
  } catch {
    throw unauthorized('nostr auth event is not valid base64 JSON')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw unauthorized('nostr auth event is malformed')
  }
  const event = parsed as Record<string, unknown>
  const tagsValid =
    Array.isArray(event.tags) &&
    event.tags.every((tag) => Array.isArray(tag) && tag.every((value) => typeof value === 'string'))

  if (
    typeof event.id !== 'string' ||
    !HEX_64.test(event.id) ||
    typeof event.pubkey !== 'string' ||
    !HEX_64.test(event.pubkey) ||
    typeof event.sig !== 'string' ||
    !HEX_128.test(event.sig) ||
    typeof event.kind !== 'number' ||
    typeof event.created_at !== 'number' ||
    !Number.isInteger(event.created_at) ||
    typeof event.content !== 'string' ||
    !tagsValid
  ) {
    throw unauthorized('nostr auth event is malformed')
  }

  return event as unknown as Nip98Event
}

function tagValue(event: Nip98Event, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1]
}

function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

async function verifyEventSignature(event: Nip98Event): Promise<void> {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
  const computedId = await sha256Hex(new TextEncoder().encode(serialized))
  if (computedId !== event.id) {
    throw unauthorized('nostr auth event id does not match its content')
  }

  let valid = false
  try {
    valid = schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))
  } catch {
    valid = false
  }
  if (!valid) {
    throw unauthorized('nostr auth event signature is invalid')
  }
}

/**
 * Verifies a NIP-98 `Authorization: Nostr <base64 event JSON>` header against
 * the request it arrived on and returns the signer's hex pubkey.
 *
 * The event must be kind 27235, correctly signed, created within
 * [NIP98_MAX_SKEW_SECONDS] of `nowSeconds`, carry a `u` tag equal to the
 * request URL (scheme, host, path and the exact query string; any fragment is
 * ignored) and a `method` tag equal to the request method. When the request
 * has a non-empty body, a `payload` tag equal to the lowercase hex SHA-256 of
 * the raw body is required; a `payload` tag that is present is always checked.
 * The body is read from a clone, so the caller can still consume it.
 *
 * Throws [HttpError] 401 on any failure.
 */
export async function verifyNip98Request(
  request: Request,
  encodedEvent: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ pubkey: string; eventId: string }> {
  const event = decodeEvent(encodedEvent)

  if (event.kind !== NIP98_KIND) {
    throw unauthorized('nostr auth event has the wrong kind')
  }

  if (Math.abs(nowSeconds - event.created_at) > NIP98_MAX_SKEW_SECONDS) {
    throw unauthorized('nostr auth event is expired or from the future')
  }

  const signedUrl = tagValue(event, 'u')
  const requestUrl = normalizeUrl(request.url)
  if (!signedUrl || requestUrl === null || normalizeUrl(signedUrl) !== requestUrl) {
    throw unauthorized('nostr auth event url does not match the request')
  }

  const signedMethod = tagValue(event, 'method')
  if (!signedMethod || signedMethod.toUpperCase() !== request.method.toUpperCase()) {
    throw unauthorized('nostr auth event method does not match the request')
  }

  const signedPayload = tagValue(event, 'payload')?.toLowerCase()
  const body = request.body === null ? new ArrayBuffer(0) : await request.clone().arrayBuffer()
  if (body.byteLength > 0 && !signedPayload) {
    throw unauthorized('nostr auth event is missing the payload hash')
  }
  if (signedPayload !== undefined && signedPayload !== (await sha256Hex(body))) {
    throw unauthorized('nostr auth event payload hash does not match the request body')
  }

  await verifyEventSignature(event)

  return { pubkey: event.pubkey, eventId: event.id }
}

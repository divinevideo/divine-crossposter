import { schnorr } from '@noble/curves/secp256k1.js'
import { describe, expect, it } from 'vitest'
import { VIDEO_EVENT_ID } from '../db/test-helpers'
import { verifyNip98Request } from './nip98'
import { NIP98_TEST_PUBKEY, NIP98_TEST_SECRET_KEY, nip98Header, signNip98Event } from './test-helpers'

const NOW = 1_800_000_000
const OTHER_EVENT_ID = 'd'.repeat(64)
const URL_WITH_QUERY = `https://crossposter.divine.video/videos/${VIDEO_EVENT_ID}/crossposts?platform=x&limit=5`
const POST_URL = `https://crossposter.divine.video/videos/${VIDEO_EVENT_ID}/crossposts`
const BODY = JSON.stringify({ platforms: ['x'] })

function credential(header: string): string {
  return header.replace(/^Nostr /, '')
}

function getRequest(url = URL_WITH_QUERY): Request {
  return new Request(url)
}

function postRequest(body = BODY, url = POST_URL): Request {
  return new Request(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
}

async function verify(request: Request, event: Record<string, unknown>) {
  return verifyNip98Request(request, credential(nip98Header(event)), NOW)
}

/** The error an event is refused with, so a test can say which check refused it. */
async function rejection(request: Request, event: Record<string, unknown>): Promise<{ status: number; message: string }> {
  return verify(request, event).then(
    () => {
      throw new Error('expected the event to be rejected')
    },
    (error: { status: number; message: string }) => error,
  )
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

type RawEvent = { pubkey?: unknown; created_at?: unknown; kind?: unknown; tags?: unknown; content?: unknown }

/**
 * Signs an event with exactly these field values, whatever their types, so the signature is
 * genuine and only the verifier's own checks can be what rejects the event.
 */
async function signRaw(fields: RawEvent = {}, secretKey: Uint8Array = NIP98_TEST_SECRET_KEY) {
  const event = {
    pubkey: NIP98_TEST_PUBKEY,
    created_at: NOW,
    kind: 27235,
    tags: [
      ['u', URL_WITH_QUERY],
      ['method', 'GET'],
    ] as unknown,
    content: '',
    ...fields,
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]),
      ),
    ),
  )
  return { id: toHex(digest), ...event, sig: toHex(schnorr.sign(digest, secretKey)) } as Record<string, unknown>
}

describe('verifyNip98Request', () => {
  describe('accepts', () => {
    it('a signed GET whose u tag is the full URL including the query string', async () => {
      const event = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW })
      await expect(verify(getRequest(), event)).resolves.toEqual({ pubkey: NIP98_TEST_PUBKEY, eventId: event.id })
    })

    it('a signed POST with a matching payload hash and leaves the body readable', async () => {
      const event = await signNip98Event({ url: POST_URL, method: 'POST', createdAt: NOW, body: BODY })
      const request = postRequest()
      await expect(verify(request, event)).resolves.toMatchObject({ pubkey: NIP98_TEST_PUBKEY })
      await expect(request.json()).resolves.toEqual({ platforms: ['x'] })
    })

    it('a bodyless POST that carries the hash of the empty body, as divine-mobile signs it', async () => {
      const event = await signNip98Event({ url: POST_URL, method: 'POST', createdAt: NOW, body: '' })
      const request = new Request(POST_URL, { method: 'POST' })
      await expect(verify(request, event)).resolves.toMatchObject({ pubkey: NIP98_TEST_PUBKEY })
    })

    it('created_at at the edge of the 60 second window', async () => {
      const past = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW - 60 })
      const future = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW + 60 })
      await expect(verify(getRequest(), past)).resolves.toMatchObject({ pubkey: NIP98_TEST_PUBKEY })
      await expect(verify(getRequest(), future)).resolves.toMatchObject({ pubkey: NIP98_TEST_PUBKEY })
    })

    it('a u tag that differs only by host case, an explicit default port, and a fragment', async () => {
      const event = await signNip98Event({
        url: `HTTPS://CrossPoster.Divine.Video:443/videos/${VIDEO_EVENT_ID}/crossposts?platform=x&limit=5#section`,
        method: 'GET',
        createdAt: NOW,
      })
      await expect(verify(getRequest(), event)).resolves.toMatchObject({ pubkey: NIP98_TEST_PUBKEY })
    })

    it('a header with its base64 padding removed, as the NIP-98 example header is', async () => {
      // Events of different lengths need zero, one or two padding characters; cover all three.
      for (const filler of ['', 'a', 'aa']) {
        const event = await signNip98Event({
          url: URL_WITH_QUERY,
          method: 'GET',
          createdAt: NOW,
          extraTags: [['filler', filler]],
        })
        const unpadded = credential(nip98Header(event)).replace(/=+$/, '')
        await expect(verifyNip98Request(getRequest(), unpadded, NOW)).resolves.toMatchObject({
          pubkey: NIP98_TEST_PUBKEY,
        })
      }
    })

    it('an event laid out the way divine-mobile signs it, with a created_at tag before the payload', async () => {
      const get = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW, createdAtTag: true })
      const post = await signNip98Event({
        url: POST_URL,
        method: 'POST',
        createdAt: NOW,
        body: BODY,
        createdAtTag: true,
      })
      await expect(verify(getRequest(), get)).resolves.toMatchObject({ pubkey: NIP98_TEST_PUBKEY })
      await expect(verify(postRequest(), post)).resolves.toMatchObject({ pubkey: NIP98_TEST_PUBKEY })
    })
  })

  describe('rejects with 401', () => {
    it('a tampered signature', async () => {
      const event = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW })
      const sig = event.sig as string
      event.sig = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a pubkey swapped in after signing', async () => {
      const event = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW })
      event.pubkey = 'f'.repeat(64)
      const error = await rejection(getRequest(), event)
      expect(error).toMatchObject({ status: 401 })
      // The id no longer matches the content, so this never reaches the signature check.
      expect(error.message).toContain('does not match its content')
    })

    it('a well-formed event signed by a different key than its pubkey', async () => {
      // The id is computed for the victim's pubkey and the signature is made with another key,
      // which is what a real forgery looks like: only the signature check can refuse it.
      const victim = toHex(schnorr.getPublicKey(new Uint8Array(32).fill(9)))
      const error = await rejection(getRequest(), await signRaw({ pubkey: victim }))
      expect(error).toMatchObject({ status: 401 })
      expect(error.message).toContain('signature is invalid')
    })

    it('an id that does not match the event content', async () => {
      const event = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW })
      event.content = 'changed after signing'
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('the wrong kind', async () => {
      const event = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW, kind: 1 })
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a stale created_at', async () => {
      const event = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW - 61 })
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a future created_at', async () => {
      const event = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW + 61 })
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a u tag for a different path', async () => {
      const event = await signNip98Event({
        url: `https://crossposter.divine.video/videos/${OTHER_EVENT_ID}/crossposts?platform=x&limit=5`,
        method: 'GET',
        createdAt: NOW,
      })
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a u tag without the query string the request carries', async () => {
      const event = await signNip98Event({ url: POST_URL, method: 'GET', createdAt: NOW })
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a u tag for a different host', async () => {
      const event = await signNip98Event({
        url: `https://evil.example/videos/${VIDEO_EVENT_ID}/crossposts?platform=x&limit=5`,
        method: 'GET',
        createdAt: NOW,
      })
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('an empty u tag', async () => {
      const withoutU = await signNip98Event({ url: '', method: 'GET', createdAt: NOW })
      await expect(verify(getRequest(), withoutU)).rejects.toMatchObject({ status: 401 })
    })

    it('the wrong method', async () => {
      const event = await signNip98Event({ url: POST_URL, method: 'GET', createdAt: NOW, body: BODY })
      await expect(verify(postRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a POST with a body but no payload tag', async () => {
      const event = await signNip98Event({ url: POST_URL, method: 'POST', createdAt: NOW, body: BODY, omitPayload: true })
      await expect(verify(postRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a POST whose body differs from the signed payload hash', async () => {
      const event = await signNip98Event({ url: POST_URL, method: 'POST', createdAt: NOW, body: BODY })
      await expect(verify(postRequest(JSON.stringify({ platforms: ['tiktok'] })), event)).rejects.toMatchObject({
        status: 401,
      })
    })

    it('a malformed payload tag', async () => {
      const event = await signNip98Event({
        url: POST_URL,
        method: 'POST',
        createdAt: NOW,
        payloadOverride: 'not-a-hash',
      })
      await expect(verify(postRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a credential that is not base64 JSON', async () => {
      await expect(verifyNip98Request(getRequest(), '%%%not-base64%%%', NOW)).rejects.toMatchObject({ status: 401 })
      await expect(verifyNip98Request(getRequest(), btoa('not json'), NOW)).rejects.toMatchObject({ status: 401 })
    })

    it('an event missing required fields', async () => {
      const event = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW })
      delete event.sig
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a u tag whose query parameters are reordered', async () => {
      const event = await signNip98Event({
        url: `https://crossposter.divine.video/videos/${VIDEO_EVENT_ID}/crossposts?limit=5&platform=x`,
        method: 'GET',
        createdAt: NOW,
      })
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a u tag with a query parameter the request does not carry', async () => {
      const event = await signNip98Event({ url: `${URL_WITH_QUERY}&extra=1`, method: 'GET', createdAt: NOW })
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    // NIP-01 defines a pubkey as lowercase hex, and the string returned here becomes a
    // database key. This event is validly signed, so only the spelling check stops one key
    // from acting as a second, differently keyed account.
    it('a validly signed event whose pubkey is spelled in uppercase hex', async () => {
      const event = await signRaw({ pubkey: NIP98_TEST_PUBKEY.toUpperCase() })
      expect(event.pubkey).not.toBe(NIP98_TEST_PUBKEY)
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a validly signed event whose encoded header is over the size cap', async () => {
      const event = await signNip98Event({
        url: URL_WITH_QUERY,
        method: 'GET',
        createdAt: NOW,
        extraTags: [['padding', 'a'.repeat(16 * 1024)]],
      })
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    // Each of these is genuinely signed, so only the verifier's own shape checks can reject it.
    // Without its guard the event would either be accepted or crash with a 500 instead of a 401.
    const malformedFields: Array<[string, RawEvent]> = [
      ['a created_at that is not a number', { created_at: 'abc' }],
      ['a created_at with a fractional part', { created_at: NOW + 0.5 }],
      ['a content that is not a string', { content: 7 }],
      ['a tag value that is not a string', { tags: [['u', URL_WITH_QUERY], ['method', 1]] }],
      ['tags that are not a list of lists', { tags: 'u' }],
      ['no method tag', { tags: [['u', URL_WITH_QUERY]] }],
    ]
    it.each(malformedFields)('a validly signed event with %s', async (_name, fields) => {
      const event = await signRaw(fields)
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a validly signed event whose sig is spelled in uppercase hex', async () => {
      const event = await signRaw()
      event.sig = String(event.sig).toUpperCase()
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it.each(['null', '5', '"text"'])('a credential whose JSON is not an object: %s', async (json) => {
      await expect(verifyNip98Request(getRequest(), btoa(json), NOW)).rejects.toMatchObject({ status: 401 })
    })

    // Blossom (BUD-11) sends its own `Authorization: Nostr` tokens as base64url. NIP-98 says base64,
    // the README says the URL-safe alphabet is not accepted, and this keeps it that way.
    it('the URL-safe base64 alphabet', async () => {
      // These characters encode to '+' and '/' in standard base64, so the two alphabets really differ.
      const event = await signNip98Event({
        url: URL_WITH_QUERY,
        method: 'GET',
        createdAt: NOW,
        extraTags: [['filler', '??>>~~??>>~~']],
      })
      const standard = credential(nip98Header(event))
      expect(standard).toMatch(/[+/]/)
      const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      await expect(verifyNip98Request(getRequest(), urlSafe, NOW)).rejects.toMatchObject({ status: 401 })
    })
  })

  describe('spends no work on the request body until the signature is proven', () => {
    it('leaves the body unread when the signature is forged', async () => {
      const CHUNKS = 64
      const CHUNK_BYTES = 16 * 1024
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array(CHUNKS * CHUNK_BYTES).fill(97)),
      )
      const payload = toHex(digest)
      const event = await signNip98Event({ url: POST_URL, method: 'POST', createdAt: NOW, payloadOverride: payload })
      const sig = event.sig as string
      event.sig = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`

      let pulled = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= CHUNKS) return controller.close()
          pulled++
          // A fresh buffer per chunk: the runtime detaches buffers it has been handed.
          controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(97))
        },
      })
      const request = new Request(POST_URL, { method: 'POST', body, duplex: 'half' } as RequestInit)

      const error = await rejection(request, event)
      expect(error).toMatchObject({ status: 401 })
      expect(error.message).toContain('signature')
      // The stream may prefetch a chunk on construction; it must not be drained.
      expect(pulled).toBeLessThan(CHUNKS)
    })
  })
})

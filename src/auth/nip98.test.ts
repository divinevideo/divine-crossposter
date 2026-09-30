import { schnorr } from '@noble/curves/secp256k1.js'
import { describe, expect, it } from 'vitest'
import { verifyNip98Request } from './nip98'
import { NIP98_TEST_PUBKEY, NIP98_TEST_SECRET_KEY, nip98Header, signNip98Event } from './test-helpers'

const NOW = 1_800_000_000
const URL_WITH_QUERY = 'https://crossposter.divine.video/videos/abc/crossposts?platform=x&limit=5'
const POST_URL = 'https://crossposter.divine.video/videos/abc/crossposts'
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Signs a well-formed event whose pubkey field is spelled by `spell`, for example in uppercase hex. */
async function signWithPubkeySpelling(spell: (pubkey: string) => string): Promise<Record<string, unknown>> {
  const pubkey = spell(NIP98_TEST_PUBKEY)
  const tags = [
    ['u', URL_WITH_QUERY],
    ['method', 'GET'],
  ]
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([0, pubkey, NOW, 27235, tags, '']))),
  )
  return {
    id: toHex(digest),
    pubkey,
    created_at: NOW,
    kind: 27235,
    tags,
    content: '',
    sig: toHex(schnorr.sign(digest, NIP98_TEST_SECRET_KEY)),
  }
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
        url: 'HTTPS://CrossPoster.Divine.Video:443/videos/abc/crossposts?platform=x&limit=5#section',
        method: 'GET',
        createdAt: NOW,
      })
      await expect(verify(getRequest(), event)).resolves.toMatchObject({ pubkey: NIP98_TEST_PUBKEY })
    })
  })

  describe('rejects with 401', () => {
    it('a tampered signature', async () => {
      const event = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW })
      const sig = event.sig as string
      event.sig = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
    })

    it('a signature from a different key than the claimed pubkey', async () => {
      const event = await signNip98Event({ url: URL_WITH_QUERY, method: 'GET', createdAt: NOW })
      event.pubkey = 'f'.repeat(64)
      await expect(verify(getRequest(), event)).rejects.toMatchObject({ status: 401 })
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
        url: 'https://crossposter.divine.video/videos/other/crossposts?platform=x&limit=5',
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
        url: 'https://evil.example/videos/abc/crossposts?platform=x&limit=5',
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
        url: 'https://crossposter.divine.video/videos/abc/crossposts?limit=5&platform=x',
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
      const event = await signWithPubkeySpelling((pubkey) => pubkey.toUpperCase())
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
  })
})

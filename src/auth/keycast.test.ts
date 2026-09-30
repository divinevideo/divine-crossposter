import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticateRequest } from './keycast'
import type { Env } from '../types'
import { NIP98_TEST_PUBKEY, nip98Header, signNip98Event } from './test-helpers'

const PUBKEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'

function env(): Env {
  return {
    DB: {} as D1Database,
    CROSSPOST_QUEUE: {} as Queue<{ jobId: string }>,
    KEYCAST_URL: 'https://keycast.divine.video/',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video/oauth',
    TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
  }
}

function request(authorization?: string): Request {
  return new Request('https://crossposter.divine.video/connections', {
    headers: authorization ? { authorization } : {},
  })
}

describe('authenticateRequest', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects missing and non-Bearer authorization locally with 401', async () => {
    await expect(authenticateRequest(request(), env())).rejects.toMatchObject({ status: 401 })
    await expect(authenticateRequest(request('Basic token'), env())).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('validates Bearer tokens through Keycast get_public_key and returns the full pubkey', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ result: PUBKEY.toUpperCase() }))

    const result = await authenticateRequest(request('Bearer keycast-token'), env())

    expect(result).toEqual({ scheme: 'keycast', pubkey: PUBKEY, token: 'keycast-token' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://keycast.divine.video/api/nostr',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer keycast-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'get_public_key', params: [] }),
      }),
    )
  })

  it('maps Keycast 401 and 403 statuses through to local auth errors', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'unauthorized' }, { status: 401 }))
    await expect(authenticateRequest(request('Bearer denied'), env())).rejects.toMatchObject({ status: 401 })

    fetchMock.mockResolvedValueOnce(Response.json({ error: 'forbidden' }, { status: 403 }))
    await expect(authenticateRequest(request('Bearer forbidden'), env())).rejects.toMatchObject({ status: 403 })
  })

  it('maps other upstream, malformed, RPC error, and empty-result responses to 502', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }))
    await expect(authenticateRequest(request('Bearer unavailable'), env())).rejects.toMatchObject({ status: 502 })

    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: -32000, message: 'boom' } }))
    await expect(authenticateRequest(request('Bearer rpc-error'), env())).rejects.toMatchObject({ status: 502 })

    fetchMock.mockResolvedValueOnce(Response.json({ result: PUBKEY.slice(0, 63) }))
    await expect(authenticateRequest(request('Bearer malformed'), env())).rejects.toMatchObject({ status: 502 })

    fetchMock.mockResolvedValueOnce(Response.json({ result: '' }))
    await expect(authenticateRequest(request('Bearer empty'), env())).rejects.toMatchObject({ status: 502 })
  })

  it('accepts a NIP-98 Nostr header without calling Keycast', async () => {
    const event = await signNip98Event({
      url: 'https://crossposter.divine.video/connections',
      method: 'GET',
      createdAt: Math.floor(Date.now() / 1000),
    })

    const result = await authenticateRequest(request(nip98Header(event)), env())

    expect(result).toEqual({ scheme: 'nip98', pubkey: NIP98_TEST_PUBKEY, eventId: event.id })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the Nostr scheme in any letter case', async () => {
    const event = await signNip98Event({
      url: 'https://crossposter.divine.video/connections',
      method: 'GET',
      createdAt: Math.floor(Date.now() / 1000),
    })

    for (const scheme of ['nostr', 'NOSTR', 'nOsTr']) {
      const header = nip98Header(event).replace(/^Nostr/, scheme)
      await expect(authenticateRequest(request(header), env())).resolves.toMatchObject({ scheme: 'nip98' })
    }
  })

  it('rejects an invalid NIP-98 Nostr header with 401 without falling back to Keycast', async () => {
    const event = await signNip98Event({
      url: 'https://crossposter.divine.video/other',
      method: 'GET',
      createdAt: Math.floor(Date.now() / 1000),
    })

    await expect(authenticateRequest(request(nip98Header(event)), env())).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import { PlatformAdapterError, normalizeProviderError } from './adapter'

describe('platform adapter errors', () => {
  it('maps auth provider statuses to needs_reauth', async () => {
    const error = await normalizeProviderError(
      'instagram',
      new Response(JSON.stringify({ error: 'denied' }), { status: 401 }),
    )

    expect(error).toBeInstanceOf(PlatformAdapterError)
    expect(error).toMatchObject({ code: 'needs_reauth', providerStatus: 401, platform: 'instagram' })
  })

  it('maps rate limit responses to rate_limited', async () => {
    await expect(
      normalizeProviderError('tiktok', new Response(JSON.stringify({ error: 'too many' }), { status: 429 })),
    ).resolves.toMatchObject({ code: 'rate_limited', providerStatus: 429, platform: 'tiktok' })
  })

  it('maps media rejection responses to media_rejected', async () => {
    await expect(
      normalizeProviderError(
        'youtube',
        new Response(JSON.stringify({ error: { code: 'media_rejected', message: 'media rejected' } }), {
          status: 400,
        }),
      ),
    ).resolves.toMatchObject({ code: 'media_rejected', providerStatus: 400, platform: 'youtube' })
  })

  it('maps unexpected non-2xx responses to unknown_platform_error', async () => {
    await expect(
      normalizeProviderError('x', new Response(JSON.stringify({ error: 'oops' }), { status: 500 })),
    ).resolves.toMatchObject({ code: 'unknown_platform_error', providerStatus: 500, platform: 'x' })
  })

  it('maps a Meta expired-token OAuthException (code 190 on HTTP 400) to needs_reauth', async () => {
    await expect(
      normalizeProviderError(
        'instagram',
        Response.json(
          { error: { message: 'Error validating access token', type: 'OAuthException', code: 190, error_subcode: 463 } },
          { status: 400 },
        ),
      ),
    ).resolves.toMatchObject({ code: 'needs_reauth', providerStatus: 400, platform: 'instagram' })
  })

  it('keeps other Meta OAuthException codes out of needs_reauth', async () => {
    await expect(
      normalizeProviderError(
        'instagram',
        Response.json({ error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 } }, { status: 400 }),
      ),
    ).resolves.toMatchObject({ code: 'unknown_platform_error', providerStatus: 400 })
  })

  it('maps an OAuth invalid_grant refresh rejection to needs_reauth', async () => {
    await expect(
      normalizeProviderError(
        'x',
        Response.json({ error: 'invalid_grant', error_description: 'Value passed for the token was invalid.' }, { status: 400 }),
      ),
    ).resolves.toMatchObject({ code: 'needs_reauth', providerStatus: 400, platform: 'x' })
  })

  it('does not treat an app-side invalid_client as a user reauth', async () => {
    await expect(
      normalizeProviderError('x', Response.json({ error: 'invalid_client' }, { status: 400 })),
    ).resolves.toMatchObject({ code: 'unknown_platform_error', providerStatus: 400 })
  })

  it('does not treat invalid_client on HTTP 401 as a user reauth', async () => {
    await expect(
      normalizeProviderError('x', Response.json({ error: 'invalid_client' }, { status: 401 })),
    ).resolves.toMatchObject({ code: 'unknown_platform_error', providerStatus: 401 })
  })
})

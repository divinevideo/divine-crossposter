import { describe, expect, it } from 'vitest'
import { PlatformAdapterError, normalizeProviderError } from '../platforms/adapter'
import { providerErrorDiagnostics, redactProviderText } from './provider-error-diagnostics'

const ACCESS_TOKEN = 'IGAAVxY3Zk9QaBZAFp0dTRmR2ZAYVU5WVE3OUVPb2pXVkx1'
const AUTH_CODE = 'AQBx7Kd93mZpQ2vLr8sT5uWyN1cEfGhJ#_'

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url })
  return response
}

describe('providerErrorDiagnostics', () => {
  it('extracts the Instagram token endpoint error shape', async () => {
    const error = await normalizeProviderError(
      'instagram',
      withUrl(
        Response.json(
          { error_type: 'OAuthException', code: 400, error_message: 'Invalid platform app' },
          { status: 400 },
        ),
        'https://api.instagram.com/oauth/access_token',
      ),
    )

    expect(providerErrorDiagnostics(error)).toEqual({
      endpoint: 'https://api.instagram.com/oauth/access_token',
      type: 'OAuthException',
      code: 400,
      message: 'Invalid platform app',
    })
  })

  it('extracts the Meta Graph error shape including subcode and trace id', () => {
    const error = new PlatformAdapterError('instagram', 'unknown_platform_error', 'failed', 400, {
      error: {
        message: 'Error validating access token: Session has expired',
        type: 'OAuthException',
        code: 190,
        error_subcode: 463,
        fbtrace_id: 'AbCdEf123_-xyz',
      },
    })

    expect(providerErrorDiagnostics(error)).toEqual({
      type: 'OAuthException',
      code: 190,
      subcode: 463,
      message: 'Error validating access token: Session has expired',
      traceId: 'AbCdEf123_-xyz',
    })
  })

  it('extracts the OAuth 2.0 error shape used by X', () => {
    const error = new PlatformAdapterError('x', 'needs_reauth', 'failed', 400, {
      error: 'invalid_request',
      error_description: 'Value passed for the authorization code was invalid.',
    })

    expect(providerErrorDiagnostics(error)).toEqual({
      type: 'invalid_request',
      message: 'Value passed for the authorization code was invalid.',
    })
  })

  it('extracts the X API v2 errors array shape', () => {
    const error = new PlatformAdapterError('x', 'unknown_platform_error', 'failed', 403, {
      errors: [{ message: 'You are not permitted to perform this action.', code: 453 }],
    })

    expect(providerErrorDiagnostics(error)).toEqual({
      code: 453,
      message: 'You are not permitted to perform this action.',
    })
  })

  it('redacts a credential-like path segment and still drops the query', async () => {
    const error = await normalizeProviderError(
      'instagram',
      withUrl(
        Response.json({ error: { message: 'bad', code: 100 } }, { status: 400 }),
        'https://graph.instagram.com/oauth/ABCDEFGHIJKLMNOPQRST?code=shh',
      ),
    )

    const diagnostics = providerErrorDiagnostics(error)
    expect(diagnostics?.endpoint).toBe('https://graph.instagram.com/oauth/[redacted]')
    expect(JSON.stringify(diagnostics)).not.toContain('ABCDEFGHIJKLMNOPQRST')
    expect(JSON.stringify(diagnostics)).not.toContain('shh')
  })

  it('keeps the X token path, including its version segment', async () => {
    const error = await normalizeProviderError(
      'x',
      withUrl(
        Response.json({ error: 'invalid_request', error_description: 'nope' }, { status: 400 }),
        'https://api.x.com/2/oauth2/token',
      ),
    )

    expect(providerErrorDiagnostics(error)?.endpoint).toBe('https://api.x.com/2/oauth2/token')
  })

  it('keeps only origin and path of the failing endpoint', async () => {
    const error = await normalizeProviderError(
      'instagram',
      withUrl(
        Response.json({ error: { message: 'bad', code: 100 } }, { status: 400 }),
        `https://graph.instagram.com/access_token?client_secret=shh&access_token=${ACCESS_TOKEN}`,
      ),
    )

    const diagnostics = providerErrorDiagnostics(error)
    expect(diagnostics?.endpoint).toBe('https://graph.instagram.com/access_token')
    expect(JSON.stringify(diagnostics)).not.toContain('shh')
    expect(JSON.stringify(diagnostics)).not.toContain(ACCESS_TOKEN)
  })

  it('never copies non-allowlisted body fields', () => {
    const error = new PlatformAdapterError('instagram', 'unknown_platform_error', 'failed', 400, {
      error_type: 'OAuthException',
      code: 400,
      error_message: 'Invalid authorization code',
      access_token: ACCESS_TOKEN,
      refresh_token: 'private-refresh-token',
      client_secret: 'private-client-secret',
      state: 'private-state-value',
      redirect_uri: 'https://crossposter.divine.video/connections/instagram/callback',
      user_id: 'private-user-id',
    })

    const logged = JSON.stringify(providerErrorDiagnostics(error))
    for (const forbidden of [
      ACCESS_TOKEN,
      'private-refresh-token',
      'private-client-secret',
      'private-state-value',
      'crossposter.divine.video',
      'private-user-id',
    ]) {
      expect(logged).not.toContain(forbidden)
    }
    expect(Object.keys(JSON.parse(logged) as object).sort()).toEqual(['code', 'message', 'type'])
  })

  it('logs only the endpoint for a non-JSON provider body', async () => {
    const error = await normalizeProviderError(
      'instagram',
      withUrl(
        new Response(`<html>private-html-body ${AUTH_CODE}</html>`, { status: 400 }),
        'https://api.instagram.com/oauth/access_token',
      ),
    )

    expect(providerErrorDiagnostics(error)).toEqual({ endpoint: 'https://api.instagram.com/oauth/access_token' })
  })

  it('returns null for errors that are not provider errors', () => {
    expect(providerErrorDiagnostics(new Error('boom'))).toBeNull()
    expect(providerErrorDiagnostics(undefined)).toBeNull()
  })

  it('ignores trace ids that are not plain identifiers', () => {
    const error = new PlatformAdapterError('instagram', 'unknown_platform_error', 'failed', 400, {
      error: { code: 1, fbtrace_id: 'has spaces and <html>' },
    })

    expect(providerErrorDiagnostics(error)).toEqual({ code: 1 })
  })

  it('caps the type at 100 characters and the message at 300', () => {
    const error = new PlatformAdapterError('instagram', 'unknown_platform_error', 'failed', 400, {
      error_type: 'word '.repeat(30),
      error_message: 'word '.repeat(100),
    })

    expect(providerErrorDiagnostics(error)).toEqual({
      type: `${'word '.repeat(20)}…`,
      message: `${'word '.repeat(60)}…`,
    })
  })
})

describe('redactProviderText', () => {
  it('redacts a letter-only authorization code echoed in a message', () => {
    expect(redactProviderText('Authorization code ABCDEFGHIJKLMNOPQRST rejected', 300)).toBe(
      'Authorization code [redacted] rejected',
    )
    expect(redactProviderText('rejected ABCDEFGHIJKLMNOPQRST now', 300)).toBe('rejected [redacted] now')
  })

  it('redacts a lowercase underscore-separated authorization code', () => {
    expect(redactProviderText('Authorization code abcdefghijklmnopqrst_uvwxzy rejected', 300)).toBe(
      'Authorization code [redacted] rejected',
    )
  })

  it('redacts a lowercase credential path segment', async () => {
    const error = await normalizeProviderError(
      'instagram',
      withUrl(
        Response.json({ error: { message: 'bad', code: 100 } }, { status: 400 }),
        'https://graph.instagram.com/oauth/abcdefghijklmnopqrst',
      ),
    )

    expect(providerErrorDiagnostics(error)?.endpoint).toBe('https://graph.instagram.com/oauth/[redacted]')
  })

  it('redacts a short labeled authorization code', () => {
    expect(redactProviderText('Authorization code ABCDEFGH rejected', 300)).toBe(
      'Authorization code [redacted] rejected',
    )
  })

  it('redacts token-like runs echoed in a message', () => {
    const redacted = redactProviderText(`Invalid OAuth access token - ${ACCESS_TOKEN} for code ${AUTH_CODE}`, 300)

    expect(redacted).toBe('Invalid OAuth access token - [redacted] for code [redacted]')
  })

  it('redacts query-style secret assignments and URLs', () => {
    const redacted = redactProviderText(
      'bad request code=abc state=xyz see https://crossposter.divine.video/connections/instagram/callback?code=abc',
      300,
    )

    expect(redacted).toBe('bad request code=[redacted] state=[redacted] see [url]')
  })

  it('keeps ordinary long words such as scope names', () => {
    expect(redactProviderText('Missing instagram_business_content_publish permission', 300)).toBe(
      'Missing instagram_business_content_publish permission',
    )
  })

  it.each([
    ['a 20-character lowercase word', 'rejected abcdefghijklmnopqrst now', 'rejected [redacted] now'],
    ['a scope-shaped run with a piece over 12 letters', 'rejected abcdefghijklmnopqrst_uvwxyz now', 'rejected [redacted] now'],
    ['a scope-shaped run of 40 characters', 'rejected abcdefghij_klmnopqrst_uvwxyzabcd_efghijk now', 'rejected [redacted] now'],
    ['a labeled scope-shaped code', 'Authorization code abcdefghij_klmnopqrst rejected', 'Authorization code [redacted] rejected'],
    ['a labeled 8-character code with a digit', 'code abcdefg1 rejected', 'code [redacted] rejected'],
  ])('redacts %s', (_case, input, expected) => {
    expect(redactProviderText(input, 300)).toBe(expected)
  })

  it('keeps an ordinary lowercase word after a label', () => {
    expect(redactProviderText('Missing token parameter', 300)).toBe('Missing token parameter')
  })

  it('caps message length and strips control characters', () => {
    expect(redactProviderText(`line one\nline two ${'word '.repeat(100)}`, 300)).toBe(
      `line one line two ${'word '.repeat(56)}wo…`,
    )
  })
})

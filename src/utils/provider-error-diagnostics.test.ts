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
})

describe('redactProviderText', () => {
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

  it('caps message length and strips control characters', () => {
    const redacted = redactProviderText(`line one\nline two ${'word '.repeat(100)}`, 300)

    expect(redacted).not.toContain('\n')
    expect(redacted.length).toBeLessThanOrEqual(301)
    expect(redacted.endsWith('…')).toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'
import worker, { app } from './index'
import { getConnectionById, upsertConnection } from './db/connections'
import { createOrGetJob, getJob } from './db/jobs'
import { requestOperationsAlertTest } from './db/operations'
import { applyMigrations, connection, job } from './db/test-helpers'
import type { Env } from './types'
import { encryptToken } from './utils/crypto'

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    CROSSPOST_QUEUE: {} as Queue<{ jobId: string }>,
    KEYCAST_URL: 'https://keycast.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video',
    TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
    ...overrides,
  }
}

describe('health route', () => {
  it('returns branded service UI at root', async () => {
    const res = await app.request('/', {}, env())

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('<title>Divine Crossposter</title>')
    expect(html).toContain('https://about.divine.video/wp-content/uploads/2026/01/diVine-3D-512.webp')
    expect(html).toContain('https://about.divine.video/wp-content/uploads/2025/11/Divine-Logo-Green.svg')
    expect(html).toContain('alt="Divine"')
    expect(html).toContain('<span class="service-name">Crossposter</span>')
    expect(html).not.toContain('di<span>V</span>ine Crossposter')
    expect(html).toContain('Send your loops farther.')
    expect(html).toContain('No slop. All human.')
    expect(html).toContain('Login with Divine')
    expect(html).toContain('Sign in with your Divine/Nostr account')
    expect(html).toContain('id="connect-list"')
    expect(html).toContain('id="preference-list"')
    expect(html).toContain("const KEYCAST_CLIENT_ID = 'Divine Crossposter';")
    expect(html).not.toContain("const KEYCAST_CLIENT_ID = 'Divine Identity Verification';")
    expect(html).toContain('function renderAuthControls()')
    expect(html).toContain("toggleAttribute('hidden', signedIn)")
    expect(html).toContain("$('logout-button').toggleAttribute('hidden', !signedIn)")
    expect(html).toContain('function clearRejectedSession(response)')
    expect(html).toContain('clearRejectedSession(resp)')
    expect(html).not.toContain("url.searchParams.set('default_register', 'true')")
    expect(html).toContain("platformName(platform) + ' authorization was canceled or denied.'")
    expect(html).toContain('X did not return a usable authorization response. Try again.')
    expect(html).toContain('X did not complete authorization. Check the callback setting and try again.')
    expect(html).toContain('X authorized, but the account could not be loaded. Try again.')
    expect(html).toContain('X authorized, but Crossposter could not save the connection. Try again.')
    expect(html).toContain('Platform connection failed. Try again when you are ready.')
    expect(html).toContain("if (platform !== 'x') return 'Platform connection failed. Try again when you are ready.';")
    expect(html).toContain("connectionFailureMessage(params.get('platform'), params.get('reason'))")
    expect(html).not.toContain("platformName(params.get('platform')) + ' authorization was canceled or denied.'")
  })

  it('returns service health', async () => {
    const res = await app.request('/health')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, service: 'divine-crossposter' })
  })
})

describe('scheduled handler', () => {
  it('runs reconciliation, reads both queue metrics, and dispatches a DLQ alert', async () => {
    const db = await applyMigrations()
    const now = Math.floor(Date.now() / 1_000)
    const trace: string[] = []
    await upsertConnection(db, connection({ id: 'conn_x', platform: 'x' }))
    await createOrGetJob(
      db,
      job({
        id: 'stale_x_upload',
        platform: 'x',
        connectionId: 'conn_x',
        status: 'uploading',
        updatedAt: now - 1_000,
        expiresAt: now + 10_000,
      }),
    )
    const send = vi.fn().mockImplementation(async () => {
      trace.push('reconciliation-enqueue')
    })
    const primaryMetrics = vi.fn().mockImplementation(async () => {
      trace.push('primary-metrics')
      return { backlogCount: 1, backlogBytes: 10 }
    })
    const dlqMetrics = vi.fn().mockImplementation(async () => {
      trace.push('dlq-metrics')
      return { backlogCount: 2, backlogBytes: 20 }
    })
    const fetchMock = vi.fn().mockImplementation(async () => {
      trace.push('webhook')
      return new Response()
    })
    vi.stubGlobal('fetch', fetchMock)
    const configured = env({
      DB: db,
      CROSSPOST_QUEUE: { send, metrics: primaryMetrics } as unknown as Queue<{ jobId: string }>,
      CROSSPOST_DLQ: { metrics: dlqMetrics } as unknown as Queue<unknown>,
      OPS_ALERT_WEBHOOK_URL: 'https://alerts.example/private-hook',
    })

    await worker.scheduled({} as ScheduledEvent, configured, {} as ExecutionContext)

    expect(send).toHaveBeenCalledWith({ jobId: 'stale_x_upload' })
    await expect(getJob(db, 'stale_x_upload')).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'unknown_platform_error',
    })
    expect(primaryMetrics).toHaveBeenCalledOnce()
    expect(dlqMetrics).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://alerts.example/private-hook',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('dlq_nonempty')
    expect(trace).toEqual(['reconciliation-enqueue', 'primary-metrics', 'dlq-metrics', 'webhook'])
  })

  it('consumes a one-shot notification only after metrics and webhook success', async () => {
    const db = await applyMigrations()
    const now = Math.floor(Date.now() / 1_000)
    await upsertConnection(db, connection({ id: 'conn_x', platform: 'x' }))
    await createOrGetJob(
      db,
      job({
        id: 'stale_x_notification_test',
        platform: 'x',
        connectionId: 'conn_x',
        status: 'uploading',
        updatedAt: now - 1_000,
        expiresAt: now + 10_000,
      }),
    )
    await requestOperationsAlertTest(db, 'private-request-id', 1_000)
    const order: string[] = []
    const send = vi.fn().mockImplementation(async () => {
      order.push('reconciliation-enqueue')
    })
    const primaryMetrics = vi.fn().mockImplementation(async () => {
      order.push('primary-metrics')
      return { backlogCount: 0, backlogBytes: 0 }
    })
    const dlqMetrics = vi.fn().mockImplementation(async () => {
      order.push('dlq-metrics')
      return { backlogCount: 0, backlogBytes: 0 }
    })
    const fetchMock = vi.fn().mockImplementation(async () => {
      order.push('webhook')
      await expect(
        db.prepare('SELECT consumed_at FROM operations_alert_tests WHERE id = ?').bind('private-request-id').first(),
      ).resolves.toEqual({ consumed_at: null })
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await worker.scheduled(
      {} as ScheduledEvent,
      env({
        DB: db,
        CROSSPOST_QUEUE: { send, metrics: primaryMetrics } as unknown as Queue<{ jobId: string }>,
        CROSSPOST_DLQ: { metrics: dlqMetrics } as unknown as Queue<unknown>,
        OPS_ALERT_WEBHOOK_URL: 'https://alerts.example/private-hook',
      }),
      {} as ExecutionContext,
    )

    expect(order).toEqual(['reconciliation-enqueue', 'primary-metrics', 'dlq-metrics', 'webhook'])
    const body = String(fetchMock.mock.calls[0][1]?.body)
    expect(body).not.toContain('private-request-id')
    expect(JSON.parse(body)).toEqual([
      {
        service: 'divine-crossposter',
        observedAt: expect.any(Number),
        issue: 'notification_test',
        backlogCount: 0,
        backlogBytes: 0,
        overdueJobCount: 0,
      },
    ])
    const consumed = await db
      .prepare('SELECT consumed_at FROM operations_alert_tests WHERE id = ?')
      .bind('private-request-id')
      .first<{ consumed_at: number | null }>()
    expect(consumed?.consumed_at).toEqual(expect.any(Number))
  })

  it('runs the watchdog after reconciliation enqueue fails and rethrows the reconciliation failure', async () => {
    const db = await applyMigrations()
    const now = Math.floor(Date.now() / 1_000)
    await upsertConnection(db, connection())
    await createOrGetJob(db, job({ id: 'queued_for_watchdog', expiresAt: now + 10_000 }))
    const reconciliationFailure = new Error('reconciliation queue unavailable')
    const trace: string[] = []
    const send = vi.fn().mockImplementation(async () => {
      trace.push('reconciliation-send')
      throw reconciliationFailure
    })
    const primaryMetrics = vi.fn().mockImplementation(async () => {
      trace.push('primary-metrics')
      return { backlogCount: 1, backlogBytes: 10 }
    })
    const dlqMetrics = vi.fn().mockImplementation(async () => {
      trace.push('dlq-metrics')
      return { backlogCount: 1, backlogBytes: 20 }
    })
    const fetchMock = vi.fn().mockImplementation(async () => {
      trace.push('webhook')
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      worker.scheduled(
        {} as ScheduledEvent,
        env({
          DB: db,
          CROSSPOST_QUEUE: { send, metrics: primaryMetrics } as unknown as Queue<{ jobId: string }>,
          CROSSPOST_DLQ: { metrics: dlqMetrics } as unknown as Queue<unknown>,
          OPS_ALERT_WEBHOOK_URL: 'https://alerts.example/private-hook',
        }),
        {} as ExecutionContext,
      ),
    ).rejects.toBe(reconciliationFailure)
    expect(trace).toEqual(['reconciliation-send', 'primary-metrics', 'dlq-metrics', 'webhook'])
  })

  it('keeps reconciler recovery persisted when the watchdog webhook fails', async () => {
    const db = await applyMigrations()
    const now = Math.floor(Date.now() / 1_000)
    await upsertConnection(db, connection({ id: 'conn_x', platform: 'x' }))
    await createOrGetJob(
      db,
      job({
        id: 'stale_before_watchdog_failure',
        platform: 'x',
        connectionId: 'conn_x',
        status: 'uploading',
        updatedAt: now - 1_000,
        expiresAt: now + 10_000,
      }),
    )
    const send = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))

    await expect(
      worker.scheduled(
        {} as ScheduledEvent,
        env({
          DB: db,
          CROSSPOST_QUEUE: {
            send,
            metrics: vi.fn().mockResolvedValue({ backlogCount: 1, backlogBytes: 10 }),
          } as unknown as Queue<{ jobId: string }>,
          CROSSPOST_DLQ: {
            metrics: vi.fn().mockResolvedValue({ backlogCount: 1, backlogBytes: 20 }),
          } as unknown as Queue<unknown>,
          OPS_ALERT_WEBHOOK_URL: 'https://alerts.example/private-hook',
        }),
        {} as ExecutionContext,
      ),
    ).rejects.toThrow('operations alert webhook failed')
    expect(send).toHaveBeenCalledWith({ jobId: 'stale_before_watchdog_failure' })
    await expect(getJob(db, 'stale_before_watchdog_failure')).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'unknown_platform_error',
      retryCount: 1,
      nextRetryAt: expect.any(Number),
    })
  })

  it('refreshes an Instagram token nearing expiry on the scheduled tick', async () => {
    const db = await applyMigrations()
    const now = Math.floor(Date.now() / 1_000)
    const token = await encryptToken('ig-old-token', '0123456789abcdef0123456789abcdef')
    await upsertConnection(
      db,
      connection({
        id: 'conn_ig',
        platform: 'instagram',
        encryptedAccessToken: token,
        encryptedRefreshToken: token,
        createdAt: now - 50 * 86_400,
        tokenExpiresAt: now + 2 * 86_400,
      }),
    )
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ access_token: 'ig-new-token', expires_in: 5_184_000 }))
    vi.stubGlobal('fetch', fetchMock)

    await worker.scheduled(
      {} as ScheduledEvent,
      env({
        DB: db,
        CROSSPOST_QUEUE: { send: vi.fn() } as unknown as Queue<{ jobId: string }>,
        ENABLE_INSTAGRAM: 'true',
        INSTAGRAM_CLIENT_ID: 'instagram-client',
        INSTAGRAM_CLIENT_SECRET: 'instagram-secret',
      }),
      {} as ExecutionContext,
    )

    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe('/refresh_access_token')
    const refreshed = await getConnectionById(db, 'conn_ig')
    expect(refreshed?.lastRefreshAt).toEqual(expect.any(Number))
    expect(refreshed?.tokenExpiresAt).toBeGreaterThan(now + 50 * 86_400)
  })

  it('surfaces both reconciliation and watchdog failures', async () => {
    const db = await applyMigrations()
    const now = Math.floor(Date.now() / 1_000)
    await upsertConnection(db, connection())
    await createOrGetJob(db, job({ id: 'queued_for_double_failure', expiresAt: now + 10_000 }))
    const reconciliationFailure = new Error('reconciliation failed')
    const watchdogFailure = new Error('watchdog metrics failed')
    const send = vi.fn().mockRejectedValue(reconciliationFailure)
    const primaryMetrics = vi.fn().mockRejectedValue(watchdogFailure)
    const dlqMetrics = vi.fn().mockResolvedValue({ backlogCount: 0, backlogBytes: 0 })

    let caught: unknown
    try {
      await worker.scheduled(
        {} as ScheduledEvent,
        env({
          DB: db,
          CROSSPOST_QUEUE: { send, metrics: primaryMetrics } as unknown as Queue<{ jobId: string }>,
          CROSSPOST_DLQ: { metrics: dlqMetrics } as unknown as Queue<unknown>,
        }),
        {} as ExecutionContext,
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([reconciliationFailure, watchdogFailure])
    expect(primaryMetrics).toHaveBeenCalledOnce()
    expect(dlqMetrics).toHaveBeenCalledOnce()
  })
})

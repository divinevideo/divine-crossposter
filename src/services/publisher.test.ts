import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listAttempts, recordAttempt } from '../db/attempts'
import { getConnection, upsertConnection } from '../db/connections'
import { createOrGetJob, getJob, updateJobStatus } from '../db/jobs'
import { applyMigrations, connection, job, PUBKEY_A } from '../db/test-helpers'
import type { Env, Platform } from '../types'
import { encryptToken } from '../utils/crypto'
import { processCrosspostJob, providerCheckpoint, PublisherRetryError } from './publisher'

const KEY = '0123456789abcdef0123456789abcdef'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function env(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    CROSSPOST_QUEUE: {} as Queue<{ jobId: string }>,
    KEYCAST_URL: 'https://keycast.divine.video',
    FUNNELCAKE_URL: 'https://api.divine.video',
    OAUTH_REDIRECT_BASE: 'https://crossposter.divine.video/oauth',
    TOKEN_ENCRYPTION_KEY: KEY,
    ...overrides,
  }
}

function platformEnv(db: D1Database, platform: Platform): Env {
  const base = env(db)
  switch (platform) {
    case 'instagram':
      return {
        ...base,
        ENABLE_INSTAGRAM: 'true',
        INSTAGRAM_CLIENT_ID: 'instagram-client',
        INSTAGRAM_CLIENT_SECRET: 'instagram-secret',
      }
    case 'tiktok':
      return {
        ...base,
        ENABLE_TIKTOK: 'true',
        TIKTOK_CLIENT_KEY: 'tiktok-client',
        TIKTOK_CLIENT_SECRET: 'tiktok-secret',
      }
    case 'x':
      return {
        ...base,
        ENABLE_X: 'true',
        TWITTER_CLIENT_ID: 'x-client',
        TWITTER_CLIENT_SECRET: 'x-secret',
      }
    case 'youtube':
      return {
        ...base,
        ENABLE_YOUTUBE: 'true',
        GOOGLE_CLIENT_ID: 'google-client',
        GOOGLE_CLIENT_SECRET: 'google-secret',
      }
  }
}

async function seedConnectedJob(db: D1Database, platform: Platform, overrides: Parameters<typeof job>[0] = {}) {
  const encryptedAccessToken = await encryptToken('access-token', KEY)
  await upsertConnection(
    db,
    connection({
      id: 'conn_1',
      platform,
      encryptedAccessToken,
      encryptedRefreshToken: null,
      tokenExpiresAt: null,
      externalAccountId: 'external-account-1',
    }),
  )
  const created = await createOrGetJob(db, job({ id: 'job_1', platform, ...overrides }))
  return created.job
}

function rejectDispatchingWrites(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'prepare') return Reflect.get(target, property, receiver)
      return (query: string) => {
        const statement = target.prepare(query)
        return new Proxy(statement, {
          get(statementTarget, statementProperty, statementReceiver) {
            if (statementProperty !== 'bind') return Reflect.get(statementTarget, statementProperty, statementReceiver)
            return (...bindings: unknown[]) => {
              const bound = statementTarget.bind(...bindings)
              if (
                query.includes("SET status = 'dispatching'") ||
                (query.includes('RETURNING *') && bindings[0] === 'dispatching')
              ) {
                return new Proxy(bound, {
                  get(boundTarget, boundProperty, boundReceiver) {
                    if (boundProperty === 'first') {
                      return async () => {
                        throw new Error('dispatch fence write failed')
                      }
                    }
                    return Reflect.get(boundTarget, boundProperty, boundReceiver)
                  },
                })
              }
              return bound
            }
          },
        })
      }
    },
  }) as D1Database
}

function replaceClaimWithDispatchingOwner(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'prepare') return Reflect.get(target, property, receiver)
      return (query: string) => {
        const statement = target.prepare(query)
        return new Proxy(statement, {
          get(statementTarget, statementProperty, statementReceiver) {
            if (statementProperty !== 'bind') return Reflect.get(statementTarget, statementProperty, statementReceiver)
            return (...bindings: unknown[]) => {
              const bound = statementTarget.bind(...bindings)
              if (!query.includes("status IN ('queued', 'failed')")) return bound
              return new Proxy(bound, {
                get(boundTarget, boundProperty, boundReceiver) {
                  if (boundProperty === 'first') {
                    return async () => {
                      await updateJobStatus(db, { id: 'job_1', status: 'dispatching', updatedAt: 3_000 })
                      return null
                    }
                  }
                  return Reflect.get(boundTarget, boundProperty, boundReceiver)
                },
              })
            }
          },
        })
      }
    },
  }) as D1Database
}

describe('publisher service', () => {
  let db: D1Database
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = await applyMigrations()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('marks a successful publish as posted and records an attempt', async () => {
    await seedConnectedJob(db, 'instagram')
    fetchMock
      .mockResolvedValueOnce(Response.json({ id: 'container-id' }))
      .mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(Response.json({ id: 'ig-post-id' }))
      .mockResolvedValueOnce(Response.json({ permalink: 'https://instagram.example/reel' }))

    await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'posted',
    })

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'posted',
      externalPostId: 'ig-post-id',
      externalPostUrl: 'https://instagram.example/reel',
      errorCode: null,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'posted', errorCode: null, providerResponseJson: null }),
    ])
  })

  it('records processing state and schedules a retry', async () => {
    await seedConnectedJob(db, 'tiktok')
    fetchMock
      .mockResolvedValueOnce(Response.json({ data: { privacy_level_options: ['SELF_ONLY'] } }))
      .mockResolvedValueOnce(
        Response.json({
          data: { publish_id: 'publish-id', nested_secret: 'tiktok-processing-sentinel' },
          error: { code: 'ok', token: 'tiktok-token-sentinel' },
        }),
      )

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'processing',
      retryDelaySeconds: 60,
    })

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'processing',
      externalPostId: 'publish-id',
      nextRetryAt: 2_060,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'processing', providerResponseJson: '{"publish_id":"publish-id"}' }),
    ])
  })

  it('allowlists provider checkpoints and returns null when no allowed field is present', () => {
    const raw = {
      id: 'id',
      creationId: 'creation-id',
      externalAccountId: 'account-id',
      publish_id: 'publish-id',
      mediaId: 'media-id',
      caption: 'caption',
      token: 'checkpoint-token-sentinel',
      nested: { raw: 'checkpoint-nested-sentinel' },
    }

    expect(providerCheckpoint('instagram', raw)).toEqual({
      id: 'id',
      creationId: 'creation-id',
      externalAccountId: 'account-id',
    })
    expect(providerCheckpoint('tiktok', raw)).toEqual({ publish_id: 'publish-id' })
    expect(providerCheckpoint('x', raw)).toEqual({ mediaId: 'media-id', caption: 'caption' })
    expect(providerCheckpoint('youtube', raw)).toEqual({ id: 'id' })
    expect(providerCheckpoint('x', { token: 'only-secret-sentinel' })).toBeNull()
    expect(providerCheckpoint('instagram', { id: '', token: 'empty-id-secret-sentinel' })).toBeNull()

    let inheritedGetterReads = 0
    const inherited = Object.create({
      get mediaId() {
        inheritedGetterReads += 1
        return 'inherited-media-id'
      },
      caption: 'inherited caption',
    }) as Record<string, unknown>
    expect(providerCheckpoint('x', inherited)).toBeNull()
    expect(inheritedGetterReads).toBe(0)
    expect(providerCheckpoint('x', { mediaId: '  trimmed-media-id  ', caption: '  verbatim caption  ' })).toEqual({
      mediaId: 'trimmed-media-id',
      caption: '  verbatim caption  ',
    })
  })

  it('raises the X dispatch fence before tweet fetch and stores only the full posted identifiers', async () => {
    await seedConnectedJob(db, 'x')
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id', init_secret: 'init-sentinel' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id', finalize_secret: 'finalize-sentinel' } }))
      .mockImplementationOnce(async () => {
        await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
          status: 'dispatching',
          updatedAt: 2_500,
        })
        return Response.json({ data: { id: 'full-tweet-id', token: 'tweet-token-sentinel' } })
      })

    await expect(
      processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000, fenceNow: 2_500 }),
    ).resolves.toEqual({ status: 'posted' })

    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === 'https://api.x.com/2/tweets')).toHaveLength(1)
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'posted',
      externalPostId: 'full-tweet-id',
      externalPostUrl: 'https://x.com/i/web/status/full-tweet-id',
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'posted', providerResponseJson: null }),
    ])
  })

  it('stores only the X media checkpoint while processing', async () => {
    await seedConnectedJob(db, 'x')
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id', init_secret: 'init-sentinel' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            id: 'media-id',
            processing_info: { state: 'pending', token: 'finalize-token-sentinel', nested: { raw: 'raw-sentinel' } },
          },
        }),
      )

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'processing',
      retryDelaySeconds: 60,
    })

    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({
        status: 'processing',
        providerResponseJson: '{"mediaId":"media-id","caption":"six seconds of weird human internet"}',
      }),
    ])
  })

  it.each([
    ['provider error', 503],
    ['missing tweet id', 200],
    ['malformed tweet id', 200],
    ['transport error', null],
  ])('turns an X %s after the dispatch fence into a terminal ambiguous result and never retries', async (outcome, providerStatus) => {
    await seedConnectedJob(db, 'x')
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id' } }))
    if (outcome === 'provider error') {
      fetchMock.mockResolvedValueOnce(
        Response.json(
          { error: { message: 'unknown tweet outcome', token: 'tweet-error-token-sentinel' } },
          { status: 503 },
        ),
      )
    } else if (outcome === 'missing tweet id') {
      fetchMock.mockResolvedValueOnce(
        Response.json({ data: { token: 'missing-tweet-id-token-sentinel', nested: { raw: 'tweet-raw-sentinel' } } }),
      )
    } else if (outcome === 'malformed tweet id') {
      fetchMock.mockResolvedValueOnce(
        Response.json({ data: { id: { raw: 'malformed-tweet-id-sentinel' }, token: 'tweet-token-sentinel' } }),
      )
    } else {
      fetchMock.mockRejectedValueOnce(new Error('transport-error-sentinel'))
    }

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'failed',
    })
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'ambiguous_post_result',
      nextRetryAt: null,
      externalPostId: null,
      externalPostUrl: null,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({
        status: 'failed',
        errorCode: 'ambiguous_post_result',
        providerStatus,
        providerResponseJson: null,
      }),
    ])

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_060 })).resolves.toEqual({
      status: 'failed',
    })
    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === 'https://api.x.com/2/tweets')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('never calls X when the dispatch fence update fails and keeps the failure pre-fence retryable', async () => {
    await seedConnectedJob(db, 'x')
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id' } }))

    const failingEnv = { ...platformEnv(db, 'x'), DB: rejectDispatchingWrites(db) }
    await expect(processCrosspostJob(failingEnv, 'job_1', { now: 2_000 })).rejects.toBeInstanceOf(PublisherRetryError)

    expect(fetchMock.mock.calls.some((call) => String(call[0]) === 'https://api.x.com/2/tweets')).toBe(false)
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'unknown_platform_error',
      nextRetryAt: 2_060,
    })
  })

  it('prevents a stale uploading claim from fencing or mutating a newer owner', async () => {
    await seedConnectedJob(db, 'x')
    const staleSourceStarted = deferred<void>()
    const staleSource = deferred<Response>()
    let sourceRequests = 0
    let initRequests = 0
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://cdn.divine.video/video.mp4') {
        sourceRequests += 1
        if (sourceRequests === 1) {
          staleSourceStarted.resolve()
          return staleSource.promise
        }
        return new Response(new Uint8Array([4, 5, 6]))
      }
      if (url === 'https://api.x.com/2/media/upload') {
        const command = (init?.body as FormData).get('command')
        if (command === 'INIT') {
          initRequests += 1
          return Response.json({ data: { id: initRequests === 1 ? 'current-media-id' : 'stale-media-id' } })
        }
        if (command === 'APPEND') return new Response(null, { status: 204 })
        return Response.json({ data: { id: initRequests === 1 ? 'current-media-id' : 'stale-media-id' } })
      }
      if (url === 'https://api.x.com/2/tweets') {
        return Response.json({ data: { id: 'current-tweet-id' } })
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const staleWorker = processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000 })
    await staleSourceStarted.promise
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({ status: 'uploading', updatedAt: 2_000 })

    await updateJobStatus(db, { id: 'job_1', status: 'queued', updatedAt: 3_000, nextRetryAt: null })
    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 3_001 })).resolves.toEqual({
      status: 'posted',
    })

    staleSource.resolve(new Response(new Uint8Array([1, 2, 3])))
    await expect(staleWorker).resolves.toEqual({ status: 'posted' })

    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === 'https://api.x.com/2/tweets')).toHaveLength(1)
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'posted',
      externalPostId: 'current-tweet-id',
      externalPostUrl: 'https://x.com/i/web/status/current-tweet-id',
      errorCode: null,
      retryCount: 0,
      nextRetryAt: null,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'posted', errorCode: null, providerResponseJson: null }),
    ])
  })

  it('prevents a stale pre-fence failure from mutating a newer dispatching owner', async () => {
    await seedConnectedJob(db, 'x')
    const staleSourceStarted = deferred<void>()
    const staleSource = deferred<Response>()
    const currentTweetStarted = deferred<void>()
    const currentTweet = deferred<Response>()
    let sourceRequests = 0
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://cdn.divine.video/video.mp4') {
        sourceRequests += 1
        if (sourceRequests === 1) {
          staleSourceStarted.resolve()
          return staleSource.promise
        }
        return new Response(new Uint8Array([4, 5, 6]))
      }
      if (url === 'https://api.x.com/2/media/upload') {
        const command = (init?.body as FormData).get('command')
        if (command === 'INIT') return Response.json({ data: { id: 'current-media-id' } })
        if (command === 'APPEND') return new Response(null, { status: 204 })
        return Response.json({ data: { id: 'current-media-id' } })
      }
      if (url === 'https://api.x.com/2/tweets') {
        currentTweetStarted.resolve()
        return currentTweet.promise
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const staleWorker = processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000, fenceNow: 2_100 })
    await staleSourceStarted.promise
    await updateJobStatus(db, { id: 'job_1', status: 'queued', updatedAt: 3_000, nextRetryAt: null })

    const currentWorker = processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 3_001, fenceNow: 4_000 })
    await currentTweetStarted.promise
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'dispatching',
      updatedAt: 4_000,
      retryCount: 0,
      nextRetryAt: null,
    })

    staleSource.resolve(Response.json({ error: 'stale source failure sentinel' }, { status: 503 }))
    await expect(staleWorker).resolves.toEqual({ status: 'dispatching' })
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'dispatching',
      updatedAt: 4_000,
      errorCode: null,
      retryCount: 0,
      nextRetryAt: null,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([])
    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === 'https://api.x.com/2/tweets')).toHaveLength(1)

    currentTweet.resolve(Response.json({ data: { id: 'current-tweet-id' } }))
    await expect(currentWorker).resolves.toEqual({ status: 'posted' })
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'posted',
      externalPostId: 'current-tweet-id',
      externalPostUrl: 'https://x.com/i/web/status/current-tweet-id',
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'posted', errorCode: null, providerResponseJson: null }),
    ])
  })

  it('leaves a stale dispatching X job unclaimed for recovery work', async () => {
    await seedConnectedJob(db, 'x', { status: 'dispatching' })

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'dispatching',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('raises the same X dispatch fence when a processing status poll succeeds', async () => {
    await seedConnectedJob(db, 'x', {
      status: 'processing',
      externalPostId: 'media-id',
      nextRetryAt: 2_000,
    })
    fetchMock
      .mockResolvedValueOnce(Response.json({ data: { id: 'media-id', processing_info: { state: 'succeeded' } } }))
      .mockImplementationOnce(async () => {
        await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({ status: 'dispatching' })
        return Response.json({ data: { id: 'poll-tweet-id' } })
      })

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'posted',
    })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.x.com/2/media/upload?command=STATUS&media_id=media-id')
    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === 'https://api.x.com/2/tweets')).toHaveLength(1)
  })

  it('sanitizes a legacy raw provider attempt before TikTok polling', async () => {
    await seedConnectedJob(db, 'tiktok', {
      status: 'processing',
      externalPostId: 'publish-id',
      nextRetryAt: 2_000,
    })
    await recordAttempt(db, {
      id: 'legacy_attempt',
      jobId: 'job_1',
      status: 'processing',
      errorCode: null,
      errorMessage: null,
      providerStatus: null,
      providerResponseJson:
        '{"publish_id":"publish-id","token":"legacy-attempt-token-sentinel","nested":{"raw":"legacy-raw-sentinel"}}',
      createdAt: 1_500,
    })
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { status: 'PUBLISH_COMPLETE', publish_id: 'publish-id' }, error: { code: 'ok' } }),
    )

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'posted',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ publish_id: 'publish-id' })
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain('legacy-attempt-token-sentinel')
  })

  it('builds the Instagram poll fallback from the job identifiers', async () => {
    await seedConnectedJob(db, 'instagram', {
      status: 'processing',
      externalPostId: 'container-id',
      nextRetryAt: 2_000,
    })
    fetchMock
      .mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(Response.json({ id: 'ig-post-id' }))
      .mockResolvedValueOnce(Response.json({ permalink: 'https://instagram.example/reel' }))

    await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'posted',
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('/container-id')
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://graph.instagram.com/v23.0/external-account-1/media_publish',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('merges a partial legacy Instagram checkpoint over the safe job fallback', async () => {
    await seedConnectedJob(db, 'instagram', {
      status: 'processing',
      externalPostId: 'container-id',
      nextRetryAt: 2_000,
    })
    await recordAttempt(db, {
      id: 'legacy_instagram_attempt',
      jobId: 'job_1',
      status: 'processing',
      errorCode: null,
      errorMessage: null,
      providerStatus: null,
      providerResponseJson:
        '{"creationId":"container-id","token":"legacy-instagram-token-sentinel","nested":{"raw":"legacy-instagram-raw-sentinel"}}',
      createdAt: 1_500,
    })
    fetchMock
      .mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(Response.json({ id: 'ig-post-id' }))
      .mockResolvedValueOnce(Response.json({ permalink: 'https://instagram.example/reel' }))

    await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'posted',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://graph.instagram.com/v23.0/external-account-1/media_publish',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('legacy-instagram-token-sentinel')
  })

  it('claims queued jobs atomically so duplicate delivery does not publish twice', async () => {
    await seedConnectedJob(db, 'instagram')
    fetchMock
      .mockResolvedValueOnce(Response.json({ id: 'container-id' }))
      .mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(Response.json({ id: 'ig-post-id' }))
      .mockResolvedValueOnce(Response.json({ permalink: 'https://instagram.example/reel' }))

    const results = await Promise.all([
      processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 }),
      processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 }),
    ])

    expect(results).toContainEqual({ status: 'posted' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await expect(listAttempts(db, 'job_1')).resolves.toHaveLength(1)
  })

  it('returns the current owner status without mutation when its claim loses a race', async () => {
    await seedConnectedJob(db, 'instagram')

    const racingEnv = { ...platformEnv(db, 'instagram'), DB: replaceClaimWithDispatchingOwner(db) }
    await expect(processCrosspostJob(racingEnv, 'job_1', { now: 2_000 })).resolves.toEqual({ status: 'dispatching' })

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'dispatching',
      updatedAt: 3_000,
      retryCount: 0,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('polls a processing job and marks it posted when the platform is complete', async () => {
    await seedConnectedJob(db, 'tiktok', {
      status: 'processing',
      externalPostId: 'publish-id',
      nextRetryAt: 2_000,
    })
    await listAttempts(db, 'job_1')
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { status: 'PUBLISH_COMPLETE', publish_id: 'publish-id' }, error: { code: 'ok' } }),
    )

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'posted',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ publish_id: 'publish-id' })
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({ status: 'posted' })
  })

  it('caps repeated processing polls with processing_timeout', async () => {
    await seedConnectedJob(db, 'tiktok', {
      status: 'processing',
      externalPostId: 'publish-id',
      nextRetryAt: 2_000,
      retryCount: 5,
    })
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { status: 'PROCESSING_UPLOAD', publish_id: 'publish-id' }, error: { code: 'ok' } }),
    )

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'failed',
    })

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'failed',
      retryCount: 6,
      errorCode: 'processing_timeout',
      nextRetryAt: null,
    })
  })

  it('keeps processing jobs in poll mode after transient poll failures', async () => {
    await seedConnectedJob(db, 'tiktok', {
      status: 'processing',
      externalPostId: 'publish-id',
      nextRetryAt: 2_000,
    })
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: 'slow down' } }, { status: 429 }))

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).rejects.toBeInstanceOf(
      PublisherRetryError,
    )
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'processing',
      retryCount: 1,
      errorCode: 'processing_timeout',
      nextRetryAt: 2_060,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'processing', errorCode: 'rate_limited' }),
    ])

    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { status: 'PUBLISH_COMPLETE', publish_id: 'publish-id' }, error: { code: 'ok' } }),
    )
    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_060 })).resolves.toEqual({
      status: 'posted',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://open.tiktokapis.com/v2/post/publish/status/fetch/')
  })

  it('records a terminal polling provider error attempt as failed', async () => {
    await seedConnectedJob(db, 'x', {
      status: 'processing',
      externalPostId: 'media-id',
      nextRetryAt: 2_000,
    })
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { id: 'media-id', processing_info: { state: 'failed' } } }),
    )

    await expect(processCrosspostJob(platformEnv(db, 'x'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'failed',
    })
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'media_rejected',
      nextRetryAt: null,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'media_rejected' }),
    ])
  })

  it('sanitizes refreshed token metadata before storing connection metadata', async () => {
    await upsertConnection(
      db,
      connection({
        id: 'conn_1',
        platform: 'tiktok',
        encryptedAccessToken: await encryptToken('old-access-token', KEY),
        encryptedRefreshToken: await encryptToken('old-refresh-token', KEY),
        tokenExpiresAt: 1_000,
        metadataJson: '{}',
      }),
    )
    await createOrGetJob(db, job({ id: 'job_1', platform: 'tiktok' }))
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
          scope: 'video.publish',
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: { privacy_level_options: ['SELF_ONLY'] } }))
      .mockResolvedValueOnce(Response.json({ data: { publish_id: 'publish-id' }, error: { code: 'ok' } }))

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).resolves.toMatchObject({
      status: 'processing',
    })

    const updated = await getConnection(db, 'conn_1', PUBKEY_A)
    expect(updated?.metadataJson).not.toContain('new-access-token')
    expect(updated?.metadataJson).not.toContain('new-refresh-token')
    expect(updated?.metadataJson).toContain('expires_in')
  })

  describe('Instagram token lifecycle', () => {
    const DAY = 24 * 60 * 60
    const NOW = 100 * DAY

    async function seedInstagram(tokenExpiresAt: number) {
      const token = await encryptToken('ig-old-token', KEY)
      await upsertConnection(
        db,
        connection({
          id: 'conn_1',
          platform: 'instagram',
          externalAccountId: 'external-account-1',
          encryptedAccessToken: token,
          encryptedRefreshToken: token,
          createdAt: NOW - 55 * DAY,
          updatedAt: NOW - 55 * DAY,
          lastRefreshAt: null,
          tokenExpiresAt,
        }),
      )
      await createOrGetJob(db, job({ id: 'job_1', platform: 'instagram', expiresAt: NOW + DAY }))
    }

    function publishResponses() {
      fetchMock
        .mockResolvedValueOnce(Response.json({ id: 'container-id' }))
        .mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
        .mockResolvedValueOnce(Response.json({ id: 'ig-post-id' }))
        .mockResolvedValueOnce(Response.json({ permalink: 'https://instagram.example/reel' }))
    }

    const deadToken = () =>
      Response.json(
        { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } },
        { status: 400 },
      )

    it('refreshes a token expiring within a week before publishing with it', async () => {
      await seedInstagram(NOW + 3 * DAY)
      fetchMock.mockResolvedValueOnce(Response.json({ access_token: 'ig-new-token', expires_in: 60 * DAY }))
      publishResponses()

      await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: NOW })).resolves.toEqual({
        status: 'posted',
      })

      expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe('/refresh_access_token')
      const createBody = fetchMock.mock.calls[1][1]?.body as URLSearchParams
      expect(createBody.get('access_token')).toBe('ig-new-token')
      await expect(getConnection(db, 'conn_1', PUBKEY_A)).resolves.toMatchObject({
        status: 'connected',
        lastRefreshAt: NOW,
      })
    })

    it('still publishes with the current token when an early refresh fails transiently', async () => {
      await seedInstagram(NOW + 3 * DAY)
      fetchMock.mockResolvedValueOnce(Response.json({ error: { message: 'unavailable' } }, { status: 500 }))
      publishResponses()

      await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: NOW })).resolves.toEqual({
        status: 'posted',
      })
      const createBody = fetchMock.mock.calls[1][1]?.body as URLSearchParams
      expect(createBody.get('access_token')).toBe('ig-old-token')
    })

    it('flags the job and connection needs_reauth when an expired token cannot be refreshed', async () => {
      await seedInstagram(NOW - DAY)
      fetchMock.mockResolvedValueOnce(deadToken())

      await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: NOW })).resolves.toEqual({
        status: 'needs_reauth',
      })

      expect(fetchMock).toHaveBeenCalledOnce()
      await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
        status: 'needs_reauth',
        errorCode: 'needs_reauth',
      })
      await expect(getConnection(db, 'conn_1', PUBKEY_A)).resolves.toMatchObject({ status: 'needs_reauth' })
      await expect(listAttempts(db, 'job_1')).resolves.toEqual([
        expect.objectContaining({ status: 'needs_reauth', errorCode: 'needs_reauth', providerStatus: 400 }),
      ])
    })

    it('flags needs_reauth instead of retrying when publishing is rejected with code 190', async () => {
      await seedInstagram(NOW + 30 * DAY)
      fetchMock.mockResolvedValueOnce(deadToken())

      await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: NOW })).resolves.toEqual({
        status: 'needs_reauth',
      })

      await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
        status: 'needs_reauth',
        errorCode: 'needs_reauth',
        retryCount: 0,
        nextRetryAt: null,
      })
      await expect(getConnection(db, 'conn_1', PUBKEY_A)).resolves.toMatchObject({ status: 'needs_reauth' })
    })
  })

  it('marks revoked tokens as needs_reauth on the job and connection', async () => {
    await seedConnectedJob(db, 'tiktok')
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: 'access_token_invalid' } }))

    await expect(processCrosspostJob(platformEnv(db, 'tiktok'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'needs_reauth',
    })

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'needs_reauth',
      errorCode: 'needs_reauth',
    })
    await expect(getConnection(db, 'conn_1', PUBKEY_A)).resolves.toMatchObject({ status: 'needs_reauth' })
  })

  it('schedules retry for rate limited provider failures', async () => {
    await seedConnectedJob(db, 'instagram')
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: 'try later' } }, { status: 429 }))

    await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 })).rejects.toBeInstanceOf(
      PublisherRetryError,
    )

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'rate_limited',
      retryCount: 1,
      nextRetryAt: 2_060,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({
        errorCode: 'rate_limited',
        providerStatus: 429,
        providerResponseJson: null,
      }),
    ])
  })

  it('skips expired jobs before publishing', async () => {
    await seedConnectedJob(db, 'instagram', { expiresAt: 1_999 })

    await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'skipped',
    })

    expect(fetchMock).not.toHaveBeenCalled()
    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({ status: 'skipped', errorCode: 'expired' })
  })

  it('marks terminal media rejection as failed without retrying', async () => {
    await seedConnectedJob(db, 'instagram')
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { code: 'media_rejected', message: 'media rejected' } }, { status: 400 }),
    )

    await expect(processCrosspostJob(platformEnv(db, 'instagram'), 'job_1', { now: 2_000 })).resolves.toEqual({
      status: 'failed',
    })

    await expect(getJob(db, 'job_1', PUBKEY_A)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'media_rejected',
      retryCount: 0,
      nextRetryAt: null,
    })
    await expect(listAttempts(db, 'job_1')).resolves.toEqual([
      expect.objectContaining({ errorCode: 'media_rejected', providerResponseJson: null }),
    ])
  })
})

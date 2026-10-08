import { listAttempts, recordAttempt } from '../db/attempts'
import { getConnection, markConnectionNeedsReauth } from '../db/connections'
import {
  claimJobForPublish,
  claimJobForStatusPoll,
  getJob,
  MAX_RETRY_COUNT,
  transitionClaimToDispatching,
  updateClaimedJobStatus,
  updateJobStatus,
} from '../db/jobs'
import { getAdapter } from '../platforms/registry'
import { PlatformAdapterError, asRecord } from '../platforms/adapter'
import type { Env, ErrorCode, JobAttemptRecord, JobRecord, JobStatus, Platform } from '../types'
import { decryptToken, generateRandomId } from '../utils/crypto'
import { refreshConnectionToken, shouldRefreshToken, TOKEN_FORCE_REFRESH_SECONDS } from './token-refresh'

const BACKOFF_SECONDS = [60, 300, 900, 1800, 3600] as const

export type ProcessCrosspostResult = {
  status: JobStatus | 'not_found'
  retryDelaySeconds?: number
}

export class PublisherRetryError extends Error {
  constructor(public readonly retryDelaySeconds: number) {
    super('crosspost job should be retried')
  }
}

class PublishClaimLostError extends Error {
  constructor() {
    super('crosspost publish claim was lost')
  }
}

type ClaimOwnership = {
  status: JobStatus
  updatedAt: number
}

async function updateOwnedJob(
  env: Env,
  jobId: string,
  ownership: ClaimOwnership,
  input: Omit<Parameters<typeof updateClaimedJobStatus>[1], 'id'>,
): Promise<JobRecord> {
  const updated = await updateClaimedJobStatus(env.DB, { id: jobId, ...input }, ownership)
  if (!updated) throw new PublishClaimLostError()
  return updated
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function backoffSeconds(retryCount: number): number {
  return BACKOFF_SECONDS[Math.min(retryCount, BACKOFF_SECONDS.length - 1)]
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ error: 'unserializable_provider_response' })
  }
}

function retryableCode(code: ErrorCode): boolean {
  return code === 'rate_limited' || code === 'unknown_platform_error' || code === 'processing_timeout'
}

export function providerCheckpoint(platform: Platform, value: unknown): Record<string, unknown> | null {
  const source = asRecord(value)
  const allowedKeys: Record<Platform, readonly string[]> = {
    instagram: ['id', 'creationId', 'externalAccountId'],
    tiktok: ['publish_id'],
    x: ['mediaId', 'caption'],
    youtube: ['id'],
  }
  const checkpoint: Record<string, unknown> = {}
  for (const key of allowedKeys[platform]) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const value = source[key]
    if (typeof value !== 'string') continue
    if (key === 'caption') checkpoint[key] = value
    else if (value.trim().length > 0) checkpoint[key] = value.trim()
  }
  return Object.keys(checkpoint).length > 0 ? checkpoint : null
}

async function addAttempt(
  env: Env,
  input: {
    jobId: string
    platform: Platform
    status: JobStatus
    errorCode?: ErrorCode | null
    errorMessage?: string | null
    providerStatus?: number | null
    providerResponse?: unknown
    now: number
  },
): Promise<void> {
  const checkpoint = providerCheckpoint(input.platform, input.providerResponse)
  const attempt: JobAttemptRecord = {
    id: `attempt_${generateRandomId()}`,
    jobId: input.jobId,
    status: input.status,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    providerStatus: input.providerStatus ?? null,
    providerResponseJson: checkpoint ? safeJson(checkpoint) : null,
    createdAt: input.now,
  }
  await recordAttempt(env.DB, attempt)
}

async function accessTokenForJob(
  env: Env,
  job: JobRecord,
  ownership: ClaimOwnership,
  now: number,
): Promise<string | null> {
  const connection = await getConnection(env.DB, job.connectionId, job.pubkey)
  if (!connection || connection.status !== 'connected') {
    await updateOwnedJob(env, job.id, ownership, {
      status: 'needs_reauth',
      updatedAt: now,
      errorCode: 'needs_reauth',
      errorMessage: 'connection is not active',
    })
    return null
  }

  const adapter = getAdapter(env, job.platform)
  if (!adapter) {
    await updateOwnedJob(env, job.id, ownership, {
      status: 'failed',
      updatedAt: now,
      errorCode: 'not_connected',
      errorMessage: 'platform is not enabled',
    })
    return null
  }

  if (!shouldRefreshToken(connection, now)) {
    return decryptToken(connection.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY)
  }

  let outcome
  try {
    outcome = await refreshConnectionToken(env, adapter, connection, now)
  } catch (error) {
    // A refresh taken early (Instagram refreshes a week ahead) must not fail a
    // publish while the stored token still works; the cron sweep retries it.
    if (connection.tokenExpiresAt && connection.tokenExpiresAt > now + TOKEN_FORCE_REFRESH_SECONDS) {
      return decryptToken(connection.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY)
    }
    throw error
  }

  if (outcome.status !== 'needs_reauth') return outcome.accessToken

  await updateOwnedJob(env, job.id, ownership, {
    status: 'needs_reauth',
    updatedAt: now,
    errorCode: 'needs_reauth',
    errorMessage: outcome.error.message,
  })
  await addAttempt(env, {
    jobId: job.id,
    platform: job.platform,
    status: 'needs_reauth',
    errorCode: 'needs_reauth',
    errorMessage: outcome.error.message,
    providerStatus: outcome.error.providerStatus ?? null,
    now,
  })
  return null
}

function latestProviderResponse(platform: Platform, attempts: JobAttemptRecord[]): Record<string, unknown> {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const json = attempts[index].providerResponseJson
    if (!json) continue
    try {
      const checkpoint = providerCheckpoint(platform, JSON.parse(json))
      if (checkpoint) return checkpoint
    } catch {
      continue
    }
  }
  return {}
}

function pollProviderResponse(job: JobRecord, attempts: JobAttemptRecord[]): Record<string, unknown> {
  const latest = latestProviderResponse(job.platform, attempts)
  if (!job.externalPostId) return latest

  if (job.platform === 'x') {
    return { mediaId: job.externalPostId, caption: job.caption, ...latest }
  }
  if (job.platform === 'tiktok') {
    return { publish_id: job.externalPostId, ...latest }
  }
  if (job.platform === 'instagram') {
    return {
      id: job.externalPostId,
      creationId: job.externalPostId,
      externalAccountId: job.externalAccountId,
      ...latest,
    }
  }
  return { id: job.externalPostId, ...latest }
}

async function scheduleRetry(
  env: Env,
  job: JobRecord,
  ownership: ClaimOwnership,
  code: ErrorCode,
  message: string,
  now: number,
): Promise<number | null> {
  const retryCount = job.retryCount + 1
  if (retryCount > MAX_RETRY_COUNT) {
    await updateOwnedJob(env, job.id, ownership, {
      status: 'failed',
      updatedAt: now,
      retryCount,
      errorCode: code,
      errorMessage: message,
      nextRetryAt: null,
    })
    return null
  }

  const delay = backoffSeconds(job.retryCount)
  await updateOwnedJob(env, job.id, ownership, {
    status: code === 'processing_timeout' ? 'processing' : 'failed',
    updatedAt: now,
    retryCount,
    errorCode: code,
    errorMessage: message,
    nextRetryAt: now + delay,
  })
  return delay
}

async function markResult(
  env: Env,
  job: JobRecord,
  result: {
    status: 'posted' | 'processing'
    externalPostId?: string
    externalPostUrl?: string
    providerResponse: Record<string, unknown>
  },
  now: number,
  ownership: ClaimOwnership,
  countProcessingRetry = false,
): Promise<ProcessCrosspostResult> {
  if (result.status === 'posted') {
    await updateOwnedJob(env, job.id, ownership, {
      status: 'posted',
      updatedAt: now,
      errorCode: null,
      errorMessage: null,
      externalPostId: result.externalPostId ?? null,
      externalPostUrl: result.externalPostUrl ?? null,
      nextRetryAt: null,
    })
    await addAttempt(env, {
      jobId: job.id,
      platform: job.platform,
      status: result.status,
      now,
    })
    return { status: 'posted' }
  }

  if (countProcessingRetry) {
    const delay = await scheduleRetry(
      env,
      job,
      ownership,
      'processing_timeout',
      'platform publish is still processing',
      now,
    )
    await addAttempt(env, {
      jobId: job.id,
      platform: job.platform,
      status: result.status,
      providerResponse: result.providerResponse,
      now,
    })
    if (delay === null) {
      return { status: 'failed' }
    }
    return { status: 'processing', retryDelaySeconds: delay }
  }

  const delay = backoffSeconds(job.retryCount)
  await updateOwnedJob(env, job.id, ownership, {
    status: 'processing',
    updatedAt: now,
    errorCode: null,
    errorMessage: null,
    externalPostId: result.externalPostId ?? null,
    externalPostUrl: result.externalPostUrl ?? null,
    nextRetryAt: now + delay,
  })
  await addAttempt(env, {
    jobId: job.id,
    platform: job.platform,
    status: result.status,
    providerResponse: result.providerResponse,
    now,
  })
  return { status: 'processing', retryDelaySeconds: delay }
}

async function handleProviderError(
  env: Env,
  job: JobRecord,
  ownership: ClaimOwnership,
  error: PlatformAdapterError,
  now: number,
): Promise<ProcessCrosspostResult> {
  if (error.code === 'needs_reauth') {
    await updateOwnedJob(env, job.id, ownership, {
      status: 'needs_reauth',
      updatedAt: now,
      errorCode: 'needs_reauth',
      errorMessage: error.message,
      nextRetryAt: null,
    })
    await markConnectionNeedsReauth(env.DB, job.connectionId, now)
    await addAttempt(env, {
      jobId: job.id,
      platform: job.platform,
      status: 'needs_reauth',
      errorCode: error.code,
      errorMessage: error.message,
      providerStatus: error.providerStatus ?? null,
      now,
    })
    return { status: 'needs_reauth' }
  }

  if (!retryableCode(error.code)) {
    await updateOwnedJob(env, job.id, ownership, {
      status: 'failed',
      updatedAt: now,
      errorCode: error.code,
      errorMessage: error.message,
      nextRetryAt: null,
    })
    await addAttempt(env, {
      jobId: job.id,
      platform: job.platform,
      status: 'failed',
      errorCode: error.code,
      errorMessage: error.message,
      providerStatus: error.providerStatus ?? null,
      now,
    })
    return { status: 'failed' }
  }

  const delay = await scheduleRetry(env, job, ownership, error.code, error.message, now)
  await addAttempt(env, {
    jobId: job.id,
    platform: job.platform,
    status: 'failed',
    errorCode: error.code,
    errorMessage: error.message,
    providerStatus: error.providerStatus ?? null,
    now,
  })
  if (delay === null) return { status: 'failed' }
  throw new PublisherRetryError(delay)
}

async function handleProcessingProviderError(
  env: Env,
  job: JobRecord,
  ownership: ClaimOwnership,
  error: PlatformAdapterError,
  now: number,
): Promise<ProcessCrosspostResult> {
  if (error.code === 'needs_reauth') {
    await updateOwnedJob(env, job.id, ownership, {
      status: 'needs_reauth',
      updatedAt: now,
      errorCode: 'needs_reauth',
      errorMessage: error.message,
      nextRetryAt: null,
    })
    await markConnectionNeedsReauth(env.DB, job.connectionId, now)
    await addAttempt(env, {
      jobId: job.id,
      platform: job.platform,
      status: 'needs_reauth',
      errorCode: error.code,
      errorMessage: error.message,
      providerStatus: error.providerStatus ?? null,
      now,
    })
    return { status: 'needs_reauth' }
  }

  if (!retryableCode(error.code)) {
    await updateOwnedJob(env, job.id, ownership, {
      status: 'failed',
      updatedAt: now,
      errorCode: error.code,
      errorMessage: error.message,
      nextRetryAt: null,
    })
    await addAttempt(env, {
      jobId: job.id,
      platform: job.platform,
      status: 'failed',
      errorCode: error.code,
      errorMessage: error.message,
      providerStatus: error.providerStatus ?? null,
      now,
    })
    return { status: 'failed' }
  }

  const delay = await scheduleRetry(env, job, ownership, 'processing_timeout', error.message, now)
  await addAttempt(env, {
    jobId: job.id,
    platform: job.platform,
    status: 'processing',
    errorCode: error.code,
    errorMessage: error.message,
    providerStatus: error.providerStatus ?? null,
    now,
  })
  if (delay === null) return { status: 'failed' }
  throw new PublisherRetryError(delay)
}

async function handleAmbiguousPostResult(
  env: Env,
  job: JobRecord,
  ownership: ClaimOwnership,
  error: unknown,
  now: number,
): Promise<ProcessCrosspostResult> {
  const providerStatus = error instanceof PlatformAdapterError ? (error.providerStatus ?? null) : null
  const errorMessage = 'X post result is ambiguous after dispatch'
  await updateOwnedJob(env, job.id, ownership, {
    status: 'failed',
    updatedAt: now,
    errorCode: 'ambiguous_post_result',
    errorMessage,
    externalPostId: null,
    externalPostUrl: null,
    nextRetryAt: null,
  })
  await addAttempt(env, {
    jobId: job.id,
    platform: job.platform,
    status: 'failed',
    errorCode: 'ambiguous_post_result',
    errorMessage,
    providerStatus,
    now,
  })
  return { status: 'failed' }
}

export async function processCrosspostJob(
  env: Env,
  jobId: string,
  options: { now?: number; fenceNow?: number } = {},
): Promise<ProcessCrosspostResult> {
  const now = options.now ?? nowSeconds()
  const existing = await getJob(env.DB, jobId)
  if (!existing) return { status: 'not_found' }

  if (existing.status === 'dispatching' || existing.errorCode === 'ambiguous_post_result') {
    return { status: existing.status }
  }

  if (existing.expiresAt <= now) {
    await updateJobStatus(env.DB, {
      id: existing.id,
      status: 'skipped',
      updatedAt: now,
      errorCode: 'expired',
      errorMessage: 'crosspost job expired',
      nextRetryAt: null,
    })
    return { status: 'skipped' }
  }

  const adapter = getAdapter(env, existing.platform)
  if (!adapter) {
    await updateJobStatus(env.DB, {
      id: existing.id,
      status: 'failed',
      updatedAt: now,
      errorCode: 'not_connected',
      errorMessage: 'platform is not enabled',
    })
    return { status: 'failed' }
  }

  const job =
    existing.status === 'processing'
      ? await claimJobForStatusPoll(env.DB, existing.id, now)
      : await claimJobForPublish(env.DB, existing.id, now)
  if (!job) {
    const current = await getJob(env.DB, existing.id)
    return { status: current?.status ?? 'not_found' }
  }

  let ownership: ClaimOwnership = { status: 'uploading', updatedAt: job.updatedAt }
  let dispatchFenceRaised = false
  const beforeExternalPost = async (): Promise<void> => {
    const fenceTimestamp = options.fenceNow ?? nowSeconds()
    const transitioned = await transitionClaimToDispatching(env.DB, job.id, ownership.updatedAt, fenceTimestamp)
    if (!transitioned) throw new PublishClaimLostError()
    ownership = { status: 'dispatching', updatedAt: fenceTimestamp }
    dispatchFenceRaised = true
  }

  try {
    try {
      const accessToken = await accessTokenForJob(env, job, ownership, now)
      if (!accessToken) return { status: 'needs_reauth' }

      const isProcessingPoll = existing.status === 'processing'
      if (isProcessingPoll) {
        if (!adapter.pollPublishStatus) {
          const delay = await scheduleRetry(
            env,
            job,
            ownership,
            'processing_timeout',
            'platform publish is still processing',
            now,
          )
          return delay === null ? { status: 'failed' } : { status: 'processing', retryDelaySeconds: delay }
        }
        const attempts = await listAttempts(env.DB, job.id)
        const result = await adapter.pollPublishStatus({
          accessToken,
          providerResponse: pollProviderResponse(job, attempts),
          beforeExternalPost,
        })
        return markResult(env, job, result, now, ownership, true)
      }

      const result = await adapter.publishVideo({
        accessToken,
        videoUrl: job.sourceMediaUrl,
        mediaHash: job.sourceMediaHash,
        caption: job.caption,
        externalAccountId: job.externalAccountId,
        beforeExternalPost,
      })
      return markResult(env, job, result, now, ownership)
    } catch (error) {
      if (error instanceof PublishClaimLostError) throw error
      if (dispatchFenceRaised) {
        return await handleAmbiguousPostResult(env, job, ownership, error, now)
      }
      if (error instanceof PlatformAdapterError) {
        return existing.status === 'processing'
          ? await handleProcessingProviderError(env, job, ownership, error, now)
          : await handleProviderError(env, job, ownership, error, now)
      }
      const platformError = new PlatformAdapterError(job.platform, 'unknown_platform_error', 'publisher failed')
      return existing.status === 'processing'
        ? await handleProcessingProviderError(env, job, ownership, platformError, now)
        : await handleProviderError(env, job, ownership, platformError, now)
    }
  } catch (error) {
    if (error instanceof PublishClaimLostError) {
      const current = await getJob(env.DB, job.id)
      return { status: current?.status ?? 'not_found' }
    }
    throw error
  }
}

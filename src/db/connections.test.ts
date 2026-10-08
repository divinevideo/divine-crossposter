import { beforeEach, describe, expect, it } from 'vitest'
import {
  disconnectConnection,
  getActiveConnectionForPlatform,
  getConnection,
  listConnections,
  markConnectionNeedsReauth,
  markConnectionNeedsReauthIfTokenUnchanged,
  upsertConnection,
} from './connections'
import { applyMigrations, connection, PUBKEY_A, PUBKEY_B } from './test-helpers'

describe('connection repository', () => {
  let db: D1Database

  beforeEach(async () => {
    db = await applyMigrations()
  })

  it('upserts one active row per pubkey, platform, and external account', async () => {
    await upsertConnection(db, connection({ id: 'conn_original', externalAccountName: '@old' }))
    const upserted = await upsertConnection(
      db,
      connection({ id: 'conn_replacement', externalAccountName: '@new', updatedAt: 2_000 }),
    )

    const rows = await listConnections(db, PUBKEY_A)

    expect(upserted.id).toBe('conn_original')
    expect(upserted.externalAccountName).toBe('@new')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'conn_original', externalAccountName: '@new', status: 'connected' })
  })

  it('filters connection reads by owner and active platform status', async () => {
    await upsertConnection(db, connection({ id: 'conn_tiktok' }))
    await upsertConnection(db, connection({ id: 'conn_other_user', pubkey: PUBKEY_B }))

    await expect(getConnection(db, 'conn_tiktok', PUBKEY_A)).resolves.toMatchObject({ id: 'conn_tiktok' })
    await expect(getConnection(db, 'conn_tiktok', PUBKEY_B)).resolves.toBeNull()
    await expect(getActiveConnectionForPlatform(db, PUBKEY_A, 'tiktok')).resolves.toMatchObject({ id: 'conn_tiktok' })
  })

  it('marks reauth and disconnects owned connections', async () => {
    await upsertConnection(db, connection({ id: 'conn_tiktok' }))

    await markConnectionNeedsReauth(db, 'conn_tiktok', 2_000)
    await expect(getConnection(db, 'conn_tiktok', PUBKEY_A)).resolves.toMatchObject({
      status: 'needs_reauth',
      updatedAt: 2_000,
    })
    await expect(disconnectConnection(db, 'conn_tiktok', PUBKEY_B, 3_000)).resolves.toBe(false)
    await expect(disconnectConnection(db, 'conn_tiktok', PUBKEY_A, 3_000)).resolves.toBe(true)
    await expect(getConnection(db, 'conn_tiktok', PUBKEY_A)).resolves.toMatchObject({
      status: 'disconnected',
      updatedAt: 3_000,
    })
  })

  it('flags needs_reauth only while the connection still holds the rejected token', async () => {
    await upsertConnection(db, connection({ id: 'conn_tiktok', encryptedAccessToken: 'current' }))

    await expect(markConnectionNeedsReauthIfTokenUnchanged(db, 'conn_tiktok', 'replaced', 2_000)).resolves.toBe(false)
    await expect(getConnection(db, 'conn_tiktok', PUBKEY_A)).resolves.toMatchObject({ status: 'connected' })
    await expect(markConnectionNeedsReauthIfTokenUnchanged(db, 'conn_tiktok', 'current', 2_000)).resolves.toBe(true)
    await expect(getConnection(db, 'conn_tiktok', PUBKEY_A)).resolves.toMatchObject({ status: 'needs_reauth' })
  })
})

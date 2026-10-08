import { allPrepared, changes, firstPrepared, runPrepared } from './client'
import type { ConnectionRecord, ConnectionStatus, Platform, PreferenceRecord } from '../types'

type ConnectionRow = {
  id: string
  pubkey: string
  platform: Platform
  external_account_id: string
  external_account_name: string
  encrypted_access_token: string
  encrypted_refresh_token: string | null
  token_expires_at: number | null
  granted_scopes: string
  status: ConnectionStatus
  created_at: number
  updated_at: number
  last_refresh_at: number | null
  metadata_json: string
}

function mapConnection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    pubkey: row.pubkey,
    platform: row.platform,
    externalAccountId: row.external_account_id,
    externalAccountName: row.external_account_name,
    encryptedAccessToken: row.encrypted_access_token,
    encryptedRefreshToken: row.encrypted_refresh_token,
    tokenExpiresAt: row.token_expires_at,
    grantedScopes: row.granted_scopes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRefreshAt: row.last_refresh_at,
    metadataJson: row.metadata_json,
  }
}

export async function getConnectionById(db: D1Database, id: string): Promise<ConnectionRecord | null> {
  const row = await firstPrepared<ConnectionRow>(db, 'SELECT * FROM connections WHERE id = ?', id)
  return row ? mapConnection(row) : null
}

export async function upsertConnection(db: D1Database, input: ConnectionRecord): Promise<ConnectionRecord> {
  await runPrepared(
    db,
    `INSERT INTO connections (
      id, pubkey, platform, external_account_id, external_account_name,
      encrypted_access_token, encrypted_refresh_token, token_expires_at,
      granted_scopes, status, created_at, updated_at, last_refresh_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pubkey, platform, external_account_id) DO UPDATE SET
      external_account_name = excluded.external_account_name,
      encrypted_access_token = excluded.encrypted_access_token,
      encrypted_refresh_token = excluded.encrypted_refresh_token,
      token_expires_at = excluded.token_expires_at,
      granted_scopes = excluded.granted_scopes,
      status = excluded.status,
      updated_at = excluded.updated_at,
      last_refresh_at = excluded.last_refresh_at,
      metadata_json = excluded.metadata_json`,
    input.id,
    input.pubkey,
    input.platform,
    input.externalAccountId,
    input.externalAccountName,
    input.encryptedAccessToken,
    input.encryptedRefreshToken,
    input.tokenExpiresAt,
    input.grantedScopes,
    input.status,
    input.createdAt,
    input.updatedAt,
    input.lastRefreshAt,
    input.metadataJson,
  )

  const row = await firstPrepared<ConnectionRow>(
    db,
    'SELECT * FROM connections WHERE pubkey = ? AND platform = ? AND external_account_id = ?',
    input.pubkey,
    input.platform,
    input.externalAccountId,
  )
  if (!row) {
    throw new Error('failed to upsert connection')
  }
  return mapConnection(row)
}

export async function completeConnectionSetup(
  db: D1Database,
  input: {
    connection: ConnectionRecord
    preference: PreferenceRecord
    attemptId: string | null
    now: number
  },
): Promise<void> {
  const { connection, preference } = input
  await db.batch([
    db
      .prepare(
        `INSERT INTO connections (
          id, pubkey, platform, external_account_id, external_account_name,
          encrypted_access_token, encrypted_refresh_token, token_expires_at,
          granted_scopes, status, created_at, updated_at, last_refresh_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pubkey, platform, external_account_id) DO UPDATE SET
          external_account_name = excluded.external_account_name,
          encrypted_access_token = excluded.encrypted_access_token,
          encrypted_refresh_token = excluded.encrypted_refresh_token,
          token_expires_at = excluded.token_expires_at,
          granted_scopes = excluded.granted_scopes,
          status = excluded.status,
          updated_at = excluded.updated_at,
          last_refresh_at = excluded.last_refresh_at,
          metadata_json = excluded.metadata_json`,
      )
      .bind(
        connection.id,
        connection.pubkey,
        connection.platform,
        connection.externalAccountId,
        connection.externalAccountName,
        connection.encryptedAccessToken,
        connection.encryptedRefreshToken,
        connection.tokenExpiresAt,
        connection.grantedScopes,
        connection.status,
        connection.createdAt,
        connection.updatedAt,
        connection.lastRefreshAt,
        connection.metadataJson,
      ),
    db
      .prepare(
        `INSERT INTO preferences (
          pubkey, platform, connection_id, mode, automatic_enabled_at, created_at, updated_at
        ) SELECT ?, ?, (
          SELECT id FROM connections
          WHERE pubkey = ? AND platform = ? AND external_account_id = ?
        ), ?, ?, ?, ?
        ON CONFLICT(pubkey, platform) DO UPDATE SET
          connection_id = excluded.connection_id,
          mode = excluded.mode,
          automatic_enabled_at = excluded.automatic_enabled_at,
          updated_at = excluded.updated_at
        WHERE preferences.mode NOT IN ('manual', 'automatic')`,
      )
      .bind(
        preference.pubkey,
        preference.platform,
        connection.pubkey,
        connection.platform,
        connection.externalAccountId,
        preference.mode,
        preference.mode === 'automatic' ? preference.automaticEnabledAt ?? preference.updatedAt : null,
        preference.createdAt,
        preference.updatedAt,
      ),
    db
      .prepare(
        `UPDATE oauth_attempts
        SET status = 'connected', failure_code = NULL, provider_status = NULL, updated_at = ?
        WHERE id = ? AND pubkey = ? AND platform = ? AND status = 'started'`,
      )
      .bind(input.now, input.attemptId, connection.pubkey, connection.platform),
  ])

}

export async function listConnections(db: D1Database, pubkey: string): Promise<ConnectionRecord[]> {
  const rows = await allPrepared<ConnectionRow>(
    db,
    'SELECT * FROM connections WHERE pubkey = ? ORDER BY created_at ASC, id ASC',
    pubkey,
  )
  return rows.map(mapConnection)
}

export async function getConnection(
  db: D1Database,
  id: string,
  pubkey: string,
): Promise<ConnectionRecord | null> {
  const row = await firstPrepared<ConnectionRow>(
    db,
    'SELECT * FROM connections WHERE id = ? AND pubkey = ?',
    id,
    pubkey,
  )
  return row ? mapConnection(row) : null
}

export async function getActiveConnectionForPlatform(
  db: D1Database,
  pubkey: string,
  platform: Platform,
): Promise<ConnectionRecord | null> {
  const row = await firstPrepared<ConnectionRow>(
    db,
    `SELECT * FROM connections
    WHERE pubkey = ? AND platform = ? AND status = 'connected'
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1`,
    pubkey,
    platform,
  )
  return row ? mapConnection(row) : null
}

export async function markConnectionNeedsReauth(db: D1Database, id: string, now: number): Promise<void> {
  await runPrepared(db, "UPDATE connections SET status = 'needs_reauth', updated_at = ? WHERE id = ?", now, id)
}

export async function disconnectConnection(
  db: D1Database,
  id: string,
  pubkey: string,
  now: number,
): Promise<boolean> {
  const result = await runPrepared(
    db,
    "UPDATE connections SET status = 'disconnected', updated_at = ? WHERE id = ? AND pubkey = ?",
    now,
    id,
    pubkey,
  )
  return changes(result) > 0 && (await getConnectionById(db, id)) !== null
}

/**
 * Connections whose stored token is close enough to expiry to refresh.
 *
 * A token is due when it expires before `refreshBefore` and was issued (last
 * refreshed, or created) before `issuedBefore`. A token expiring before
 * `forceBefore` is due regardless of age, so a nearly dead token is always
 * tried once more. Soonest expiry first.
 */
export async function listConnectionsDueForRefresh(
  db: D1Database,
  input: {
    platform: Platform
    refreshBefore: number
    issuedBefore: number
    forceBefore: number
    limit: number
  },
): Promise<ConnectionRecord[]> {
  const rows = await allPrepared<ConnectionRow>(
    db,
    `SELECT * FROM connections
    WHERE platform = ?
      AND status = 'connected'
      AND encrypted_refresh_token IS NOT NULL
      AND token_expires_at IS NOT NULL
      AND token_expires_at <= ?
      AND (COALESCE(last_refresh_at, created_at) <= ? OR token_expires_at <= ?)
    ORDER BY token_expires_at ASC, id ASC
    LIMIT ?`,
    input.platform,
    input.refreshBefore,
    input.issuedBefore,
    input.forceBefore,
    input.limit,
  )
  return rows.map(mapConnection)
}

/**
 * Stores refreshed tokens only if the connection still holds the access token
 * the refresh started from, so a concurrent refresh or reconnect is never
 * overwritten. Returns false when another writer got there first.
 */
export async function storeRefreshedTokens(
  db: D1Database,
  input: {
    id: string
    expectedEncryptedAccessToken: string
    encryptedAccessToken: string
    encryptedRefreshToken: string | null
    tokenExpiresAt: number | null
    grantedScopes: string
    metadataJson: string
    now: number
  },
): Promise<boolean> {
  const result = await runPrepared(
    db,
    `UPDATE connections SET
      encrypted_access_token = ?,
      encrypted_refresh_token = ?,
      token_expires_at = ?,
      granted_scopes = ?,
      metadata_json = ?,
      last_refresh_at = ?,
      updated_at = ?
    WHERE id = ? AND encrypted_access_token = ? AND status = 'connected'`,
    input.encryptedAccessToken,
    input.encryptedRefreshToken,
    input.tokenExpiresAt,
    input.grantedScopes,
    input.metadataJson,
    input.now,
    input.now,
    input.id,
    input.expectedEncryptedAccessToken,
  )
  return changes(result) > 0
}

/**
 * Marks a connection needs_reauth only if it still holds the token that the
 * provider rejected; a reconnect or concurrent refresh in between wins.
 */
export async function markConnectionNeedsReauthIfTokenUnchanged(
  db: D1Database,
  id: string,
  expectedEncryptedAccessToken: string,
  now: number,
): Promise<boolean> {
  const result = await runPrepared(
    db,
    `UPDATE connections SET status = 'needs_reauth', updated_at = ?
    WHERE id = ? AND encrypted_access_token = ? AND status = 'connected'`,
    now,
    id,
    expectedEncryptedAccessToken,
  )
  return changes(result) > 0
}

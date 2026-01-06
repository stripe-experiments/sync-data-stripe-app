/**
 * Postgres helpers (central DB).
 *
 * OAuth state + token storage live here.
 */

import { Pool } from 'pg';
import type { OAuthMode } from './types';

// Create a connection pool (reused across requests in serverless)
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    
    pool = new Pool({
      connectionString,
      ssl: {
        rejectUnauthorized: false // Required for Supabase
      },
      max: 10, // Max connections in pool
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  
  return pool;
}

// OAuth state

/**
 * Insert a new OAuth state hash with TTL
 * 
 * @param stateHash - SHA-256 hash of the state value
 * @param mode - 'test' or 'live'
 * @param ttlMinutes - Time to live in minutes (default: 10)
 */
export async function insertOAuthState(
  stateHash: string,
  mode: OAuthMode,
  ttlMinutes: number = 10
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  
  await getPool().query(
    `INSERT INTO oauth_states (state_hash, mode, expires_at)
     VALUES ($1, $2, $3)`,
    [stateHash, mode, expiresAt.toISOString()]
  );
}

/**
 * Consume (validate and delete) an OAuth state
 * Returns the mode if valid, null if not found or expired
 * 
 * @param stateHash - SHA-256 hash of the state value to consume
 * @returns The mode ('test' or 'live') if valid, null otherwise
 */
export async function consumeOAuthState(
  stateHash: string
): Promise<OAuthMode | null> {
  const result = await getPool().query(
    `DELETE FROM oauth_states
     WHERE state_hash = $1 AND expires_at > NOW()
     RETURNING mode`,
    [stateHash]
  );
  
  if (result.rowCount === 0) {
    return null;
  }
  
  return result.rows[0].mode as OAuthMode;
}

/**
 * Clean up expired OAuth states
 * Call this periodically to remove stale entries
 * 
 * @returns Number of deleted rows
 */
export async function cleanupExpiredStates(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM oauth_states WHERE expires_at < NOW()`
  );
  
  return result.rowCount ?? 0;
}

// OAuth connections

/**
 * Parameters for upserting an OAuth connection
 */
export interface UpsertConnectionParams {
  stripeAccountId: string;
  livemode: boolean;
  scope: string | null;
  stripePublishableKey: string | null;
  accessTokenEnc: string;
  accessTokenExpiresAt: Date;
  refreshTokenEnc: string;
}

/**
 * Insert or update an OAuth connection
 * Uses composite key (stripe_account_id, livemode) for upsert
 * 
 * @param params - Connection parameters
 */
export async function upsertOAuthConnection(
  params: UpsertConnectionParams
): Promise<void> {
  const {
    stripeAccountId,
    livemode,
    scope,
    stripePublishableKey,
    accessTokenEnc,
    accessTokenExpiresAt,
    refreshTokenEnc
  } = params;
  
  await getPool().query(
    `INSERT INTO stripe_oauth_connections (
      stripe_account_id,
      livemode,
      scope,
      stripe_publishable_key,
      access_token_enc,
      access_token_expires_at,
      refresh_token_enc,
      refresh_token_rotated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (stripe_account_id, livemode) DO UPDATE SET
      scope = EXCLUDED.scope,
      stripe_publishable_key = EXCLUDED.stripe_publishable_key,
      access_token_enc = EXCLUDED.access_token_enc,
      access_token_expires_at = EXCLUDED.access_token_expires_at,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      refresh_token_rotated_at = NOW(),
      updated_at = NOW()`,
    [
      stripeAccountId,
      livemode,
      scope,
      stripePublishableKey,
      accessTokenEnc,
      accessTokenExpiresAt.toISOString(),
      refreshTokenEnc
    ]
  );
}

/**
 * Stored OAuth connection record
 */
export interface StoredConnection {
  stripe_account_id: string;
  livemode: boolean;
  scope: string | null;
  stripe_publishable_key: string | null;
  access_token_enc: string;
  access_token_expires_at: Date;
  refresh_token_enc: string;
  refresh_token_rotated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Get an OAuth connection by account ID and mode
 * 
 * @param stripeAccountId - Stripe account ID (acct_xxx)
 * @param livemode - Whether to get the live mode connection
 * @returns The connection record or null if not found
 */
export async function getOAuthConnection(
  stripeAccountId: string,
  livemode: boolean
): Promise<StoredConnection | null> {
  const result = await getPool().query(
    `SELECT * FROM stripe_oauth_connections
     WHERE stripe_account_id = $1 AND livemode = $2`,
    [stripeAccountId, livemode]
  );
  
  if (result.rowCount === 0) {
    return null;
  }
  
  const row = result.rows[0];
  return {
    stripe_account_id: row.stripe_account_id,
    livemode: row.livemode,
    scope: row.scope,
    stripe_publishable_key: row.stripe_publishable_key,
    access_token_enc: row.access_token_enc,
    access_token_expires_at: new Date(row.access_token_expires_at),
    refresh_token_enc: row.refresh_token_enc,
    refresh_token_rotated_at: row.refresh_token_rotated_at ? new Date(row.refresh_token_rotated_at) : null,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at)
  };
}

/**
 * Update tokens for an existing connection (used during refresh)
 * 
 * @param stripeAccountId - Stripe account ID
 * @param livemode - Connection mode
 * @param accessTokenEnc - New encrypted access token
 * @param accessTokenExpiresAt - New expiry time
 * @param refreshTokenEnc - New encrypted refresh token (rotated)
 */
export async function updateConnectionTokens(
  stripeAccountId: string,
  livemode: boolean,
  accessTokenEnc: string,
  accessTokenExpiresAt: Date,
  refreshTokenEnc: string
): Promise<void> {
  await getPool().query(
    `UPDATE stripe_oauth_connections SET
      access_token_enc = $1,
      access_token_expires_at = $2,
      refresh_token_enc = $3,
      refresh_token_rotated_at = NOW(),
      updated_at = NOW()
    WHERE stripe_account_id = $4 AND livemode = $5`,
    [
      accessTokenEnc,
      accessTokenExpiresAt.toISOString(),
      refreshTokenEnc,
      stripeAccountId,
      livemode
    ]
  );
}

/**
 * Delete an OAuth connection
 * 
 * @param stripeAccountId - Stripe account ID
 * @param livemode - Connection mode
 * @returns True if a connection was deleted
 */
export async function deleteOAuthConnection(
  stripeAccountId: string,
  livemode: boolean
): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM stripe_oauth_connections
     WHERE stripe_account_id = $1 AND livemode = $2`,
    [stripeAccountId, livemode]
  );
  
  return (result.rowCount ?? 0) > 0;
}

/**
 * List all connections for an account (both test and live)
 * 
 * @param stripeAccountId - Stripe account ID
 * @returns Array of connection records
 */
export async function listAccountConnections(
  stripeAccountId: string
): Promise<StoredConnection[]> {
  const result = await getPool().query(
    `SELECT * FROM stripe_oauth_connections
     WHERE stripe_account_id = $1
     ORDER BY livemode DESC`,
    [stripeAccountId]
  );
  
  return result.rows.map(row => ({
    stripe_account_id: row.stripe_account_id,
    livemode: row.livemode,
    scope: row.scope,
    stripe_publishable_key: row.stripe_publishable_key,
    access_token_enc: row.access_token_enc,
    access_token_expires_at: new Date(row.access_token_expires_at),
    refresh_token_enc: row.refresh_token_enc,
    refresh_token_rotated_at: row.refresh_token_rotated_at ? new Date(row.refresh_token_rotated_at) : null,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at)
  }));
}

/**
 * DB helpers for provisioned Supabase databases.
 *
 * CRUD wrappers around `provisioned_databases`.
 */

import { Pool, type PoolClient } from 'pg';
import type {
  ProvisionedDatabase,
  InstallStatus,
  InstallStep,
  InsertProvisionedDbParams,
} from './provisioning-types';

// Reuse the connection pool pattern from db.ts
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
        rejectUnauthorized: false, // Required for Supabase
      },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }

  return pool;
}

/**
 * Run a function while holding a per-account advisory lock.
 * Keeps concurrent status polls from double-doing provisioning work.
 */
export async function tryWithProvisioningLock<T>(
  stripeAccountId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<{ acquired: boolean; value?: T }> {
  const client = await getPool().connect();
  try {
    const lockResult = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [stripeAccountId]
    );
    const locked = lockResult.rows?.[0]?.locked === true;

    if (!locked) {
      return { acquired: false };
    }

    const value = await fn(client);
    return { acquired: true, value };
  } finally {
    // Unlock is connection/session-scoped; calling unlock when not held is safe (returns false).
    await client
      .query(`SELECT pg_advisory_unlock(hashtext($1))`, [stripeAccountId])
      .catch(() => undefined);
    client.release();
  }
}

// Provisioned DB records

/**
 * Get a provisioned database by Stripe account ID
 *
 * @param stripeAccountId - Stripe account ID (acct_xxx)
 * @returns The provisioned database record or null if not found
 */
export async function getProvisionedDb(
  stripeAccountId: string
): Promise<ProvisionedDatabase | null> {
  // TODO: add live/test mode support
  const result = await getPool().query(
    `SELECT * FROM provisioned_databases WHERE stripe_account_id = $1`,
    [stripeAccountId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    stripe_account_id: row.stripe_account_id,
    project_ref: row.project_ref,
    db_password_enc: row.db_password_enc,
    connection_host: row.connection_host,
    region: row.region,
    install_status: row.install_status as Exclude<InstallStatus, 'not_provisioned'>,
    install_step: row.install_step as InstallStep | null,
    error_message: row.error_message,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

/**
 * Insert a new provisioned database record
 * Initial status is 'pending'
 *
 * @param params - Database parameters
 * @returns The inserted record
 */
export async function insertProvisionedDb(
  params: InsertProvisionedDbParams
): Promise<ProvisionedDatabase> {
  const {
    stripe_account_id,
    project_ref,
    db_password_enc,
    connection_host,
    region,
  } = params;

  // TODO: add live/test mode support
  const result = await getPool().query(
    `INSERT INTO provisioned_databases (
      stripe_account_id,
      project_ref,
      db_password_enc,
      connection_host,
      region,
      install_status,
      install_step
    ) VALUES ($1, $2, $3, $4, $5, 'pending', 'create_project')
    RETURNING *`,
    [stripe_account_id, project_ref, db_password_enc, connection_host, region]
  );

  const row = result.rows[0];
  return {
    stripe_account_id: row.stripe_account_id,
    project_ref: row.project_ref,
    db_password_enc: row.db_password_enc,
    connection_host: row.connection_host,
    region: row.region,
    install_status: row.install_status as Exclude<InstallStatus, 'not_provisioned'>,
    install_step: row.install_step as InstallStep | null,
    error_message: row.error_message,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

/**
 * Update installation progress for a provisioned database
 *
 * @param stripeAccountId - Stripe account ID
 * @param status - New install status
 * @param step - New install step (optional)
 */
export async function updateInstallProgress(
  stripeAccountId: string,
  status: Exclude<InstallStatus, 'not_provisioned'>,
  step?: InstallStep
): Promise<void> {
  await getPool().query(
    `UPDATE provisioned_databases SET
      install_status = $1,
      install_step = $2,
      updated_at = NOW()
    WHERE stripe_account_id = $3`,
    [status, step ?? null, stripeAccountId]
  );
}

/**
 * Set install error for a provisioned database
 *
 * @param stripeAccountId - Stripe account ID
 * @param errorMessage - Error message to store
 */
export async function setInstallError(
  stripeAccountId: string,
  errorMessage: string
): Promise<void> {
  await getPool().query(
    `UPDATE provisioned_databases SET
      install_status = 'error',
      error_message = $1,
      updated_at = NOW()
    WHERE stripe_account_id = $2`,
    [errorMessage, stripeAccountId]
  );
}

/**
 * Delete a provisioned database record
 * Used for retry flow when status = 'error'
 *
 * @param stripeAccountId - Stripe account ID
 * @returns True if a record was deleted
 */
export async function deleteProvisionedDb(
  stripeAccountId: string
): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM provisioned_databases WHERE stripe_account_id = $1`,
    [stripeAccountId]
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Update the project_ref and connection details after project creation
 *
 * @param stripeAccountId - Stripe account ID
 * @param projectRef - Supabase project reference
 * @param connectionHost - Connection host (pooler URL)
 */
export async function updateProjectDetails(
  stripeAccountId: string,
  projectRef: string,
  connectionHost: string
): Promise<void> {
  await getPool().query(
    `UPDATE provisioned_databases SET
      project_ref = $1,
      connection_host = $2,
      updated_at = NOW()
    WHERE stripe_account_id = $3`,
    [projectRef, connectionHost, stripeAccountId]
  );
}

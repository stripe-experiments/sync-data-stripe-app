/**
 * Types for database provisioning feature
 */

/**
 * Installation status for provisioned databases
 * - not_provisioned: No DB record exists (API-only, not stored in DB)
 * - pending: Record created, setup queued
 * - provisioning: Creating Supabase project/database
 * - installing: Applying schema and config
 * - syncing: Starting and verifying sync
 * - ready: Complete, credentials available
 * - error: Failed, retry guidance shown
 */
export type InstallStatus =
  | 'not_provisioned'
  | 'pending'
  | 'provisioning'
  | 'installing'
  | 'syncing'
  | 'ready'
  | 'error';

/**
 * Fine-grained installation step within each status
 */
export type InstallStep =
  | 'create_project'       // provisioning: Creating Supabase project
  | 'create_database'      // provisioning: Setting up Postgres
  | 'wait_database_ready'  // provisioning: Waiting for DB to stabilize
  | 'apply_schema'         // installing: Creating stripe schema/tables
  | 'verify_connection'    // installing: Health check
  | 'start_sync'           // syncing: Enabling data sync
  | 'verify_sync'          // syncing: Waiting for first sync signal
  | 'done'                 // ready: Complete
  | 'unknown';             // Fallback

/**
 * Provisioned database record stored in the database
 */
export interface ProvisionedDatabase {
  stripe_account_id: string;
  project_ref: string;
  db_password_enc: string;
  connection_host: string;
  region: string;
  install_status: Exclude<InstallStatus, 'not_provisioned'>;
  install_step: InstallStep | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * API response for database status
 */
export interface DbStatusResponse {
  status: InstallStatus;
  step: InstallStep | null;
  error_message: string | null;
  /** Connection string - only provided when status=ready */
  connection_string: string | null;
  project_ref: string | null;
  created_at: string | null;
}

/**
 * Parameters for inserting a new provisioned database record
 */
export interface InsertProvisionedDbParams {
  stripe_account_id: string;
  project_ref: string;
  db_password_enc: string;
  connection_host: string;
  region: string;
}

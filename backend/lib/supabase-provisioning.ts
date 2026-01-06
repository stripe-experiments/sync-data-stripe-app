/**
 * Supabase provisioning.
 *
 * Creates a Supabase project per Stripe account and installs the Stripe sync.
 */

import { SupabaseDeployClient } from 'stripe-experiment-sync/supabase';
import crypto from 'crypto';
import { encrypt } from './crypto';
import { getStripeClient } from './stripe-client';
import {
  insertProvisionedDb,
  tryWithProvisioningLock,
} from './provisioned-db';
import type { InstallStatus, InstallStep } from './provisioning-types';

/** Tiny sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTimeoutMs(value: string | undefined, fallbackMs: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

/**
 * Best-effort redaction for secrets that might sneak into error strings.
 * (Extra defense in case something throws a token/key.)
 */
function sanitizeErrorMessage(message: string): string {
  let out = message;
  // Bearer tokens
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
  // Stripe keys/tokens
  out = out.replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+\b/g, '$1_$2_[REDACTED]');
  out = out.replace(/\brt_[A-Za-z0-9]+\b/g, 'rt_[REDACTED]');
  // JWTs (common for Supabase-style tokens)
  out = out.replace(/eyJ[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
  return out;
}

function isFatalSupabaseAuthError(message: string): boolean {
  return (
    message.includes('Supabase API Error (401') ||
    message.includes('Supabase API Error (403')
  );
}

/**
 * Helper for Supabase Management API calls
 */
async function supabaseFetch(params: {
  accessToken: string;
  endpoint: string;
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  body?: unknown;
}): Promise<unknown> {
  const { accessToken, endpoint, method = 'GET', body } = params;
  const url = `https://api.supabase.com/v1${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Supabase API Error (${resp.status} ${method} ${endpoint}): ${text}`);
  }

  return resp.status === 204 ? null : await resp.json();
}

/**
 * Get required Supabase environment variables
 */
function getSupabaseConfig() {
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const organizationId = process.env.SUPABASE_ORGANIZATION_ID;
  const region = process.env.SUPABASE_REGION || 'us-east-1';

  if (!accessToken) {
    throw new Error('SUPABASE_ACCESS_TOKEN environment variable is not set');
  }

  if (!organizationId) {
    throw new Error('SUPABASE_ORGANIZATION_ID environment variable is not set');
  }

  return { accessToken, organizationId, region };
}

/** Generate a random database password that meets Supabase requirements. */
function generateDbPassword(): string {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.randomBytes(24))
    .map((b) => charset[b % charset.length])
    .join('');
}

/**
 * Build the connection string for a Supabase project
 */
function buildConnectionString(
  projectRef: string,
  dbPassword: string,
  region: string
): string {
  const poolerHost = `aws-1-${region}.pooler.supabase.com`;
  return `postgresql://postgres.${projectRef}:${dbPassword}@${poolerHost}:5432/postgres`;
}

/**
 * Single-shot readiness check (no sleeps / no loops).
 * Designed for serverless "tick" execution.
 */
async function checkDatabaseReadyOnce(params: {
  accessToken: string;
  projectRef: string;
  stripeAccountId: string;
}): Promise<{ ready: boolean; fatalError?: string }> {
  const { accessToken, projectRef, stripeAccountId } = params;

  try {
    // Test basic query execution
    await supabaseFetch({
      accessToken,
      endpoint: `/projects/${projectRef}/database/query`,
      method: 'POST',
      body: { query: 'SELECT 1' },
    });

    // Ensure stripe schema exists
    await supabaseFetch({
      accessToken,
      endpoint: `/projects/${projectRef}/database/query`,
      method: 'POST',
      body: { query: 'CREATE SCHEMA IF NOT EXISTS stripe' },
    });

    // Verify schema exists
    const result = (await supabaseFetch({
      accessToken,
      endpoint: `/projects/${projectRef}/database/query`,
      method: 'POST',
      body: {
        query:
          "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'stripe'",
      },
    })) as Array<{ schema_name: string }> | null;

    const ready = Boolean(result && result.length > 0);
    if (ready) {
      console.log(`[provisioning/tick] Database ready for ${stripeAccountId} (${projectRef})`);
    } else {
      console.log(
        `[provisioning/tick] Database not ready yet for ${stripeAccountId} (${projectRef})`
      );
    }
    return { ready };
  } catch (err) {
    const msgRaw = err instanceof Error ? err.message : String(err);
    const msg = sanitizeErrorMessage(msgRaw);
    console.log(
      `[provisioning/tick] Waiting for ${stripeAccountId} (${projectRef}) to stabilize: ${msg}`
    );
    // Auth errors won't resolve on their own; fail fast so we can fix config.
    if (isFatalSupabaseAuthError(msg)) {
      return { ready: false, fatalError: msg };
    }
    return { ready: false };
  }
}

/**
 * Install the Stripe sync into the database
 */
async function installStripeSync(
  supabaseAccessToken: string,
  projectRef: string,
  stripeAccessToken: string,
  region: string,
  stripeAccountId: string
  , options: { maxAttempts?: number } = {}
): Promise<void> {
  let attempts = 0;
  const maxAttempts = options.maxAttempts ?? 3;

  while (attempts < maxAttempts) {
    try {
      const client = new SupabaseDeployClient({
        accessToken: supabaseAccessToken,
        projectRef: projectRef,
      });

      // Monkey-patch to skip the stale registry check
      // @ts-ignore
      client.validateProject = async () => ({
        id: projectRef,
        name: 'provisioning-bypass',
        region: region,
      });

      // Stripe requires `api_version` when creating webhooks on connected accounts.
      // The deployed `stripe-setup` function does that, so we inject `api_version` at deploy-time.
      const defaultWebhookApiVersion =
        process.env.STRIPE_WEBHOOK_API_VERSION ||
        process.env.STRIPE_API_VERSION ||
        '2020-08-27';

      const anyClient = client as any;
      const originalDeployFunction = anyClient.deployFunction?.bind(anyClient);
      if (typeof originalDeployFunction === 'function') {
        anyClient.deployFunction = async (
          name: string,
          code: string,
          verifyJwt = false
        ) => {
          if (name === 'stripe-setup') {
            // Don’t double-inject if it’s already been patched.
            const alreadyPatched = code.includes('findOrCreateManagedWebhook(webhookUrl,');
            if (!alreadyPatched) {
              const before = code;
              code = code.replace(
                /stripeSync\.findOrCreateManagedWebhook\(\s*webhookUrl\s*\)/g,
                `stripeSync.findOrCreateManagedWebhook(webhookUrl, { api_version: '${defaultWebhookApiVersion}' })`
              );
              if (code === before) {
                console.warn(
                  '[provisioning] Warning: could not patch stripe-setup Edge Function code to add webhook api_version (pattern not found)'
                );
              }
            }
          }
          return originalDeployFunction(name, code, verifyJwt);
        };
      }

      await client.install(stripeAccessToken);
      console.log(`[provisioning] Installation complete for ${stripeAccountId} (${projectRef})`);
      return;
    } catch (err) {
      attempts++;
      const msgRaw = err instanceof Error ? err.message : String(err);
      const msg = sanitizeErrorMessage(msgRaw);
      console.warn(
        `[provisioning] Installation attempt ${attempts} failed for ${stripeAccountId} (${projectRef}): ${msg}`
      );
      if (attempts >= maxAttempts) throw err;
      await sleep(5000 * attempts); // Exponential backoff
    }
  }
}

/**
 * Create a Supabase project for this account and record it in `provisioned_databases`.
 */
export async function startProvisioning(
  stripeAccountId: string,
  _livemode: boolean
): Promise<{ projectRef: string; region: string }> {
  const { accessToken: supabaseAccessToken, organizationId, region } = getSupabaseConfig();

  // Generate password and encrypt it
  const dbPassword = generateDbPassword();
  const dbPasswordEnc = encrypt(dbPassword);

  // Create the Supabase project
  const projectName = `stripe-sync-${stripeAccountId}-${Date.now()}`;

  console.log(`[provisioning] Creating project ${projectName} for ${stripeAccountId}`);

  const project = (await supabaseFetch({
    accessToken: supabaseAccessToken,
    endpoint: '/projects',
    method: 'POST',
    body: {
      name: projectName,
      organization_id: organizationId,
      region,
      db_pass: dbPassword,
      plan: 'free',
    },
  })) as { id: string };

  const projectRef = project.id;
  const connectionHost = `aws-1-${region}.pooler.supabase.com`;

  console.log(`[provisioning] Project created: ${projectRef}`);

  // Insert the database record
  await insertProvisionedDb({
    stripe_account_id: stripeAccountId,
    project_ref: projectRef,
    db_password_enc: dbPasswordEnc,
    connection_host: connectionHost,
    region,
  });

  return { projectRef, region };
}

/**
 * Delete a Supabase project via the Management API.
 *
 * We treat 404 as an error so we don’t silently lose track of a project.
 */
export async function deleteSupabaseProject(projectRef: string): Promise<void> {
  const { accessToken } = getSupabaseConfig();

  const url = `https://api.supabase.com/v1/projects/${projectRef}`;

  console.log(`[provisioning] Deleting Supabase project ${projectRef}`);

  const resp = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (resp.ok) {
    console.log(`[provisioning] Successfully deleted Supabase project ${projectRef}`);
    return;
  }

  const text = await resp.text().catch(() => '');

  if (resp.status === 404) {
    throw new Error(
      `Project not found (404). The project may have been deleted outside this app. ` +
        `Local record retained for safety. Response: ${text}`
    );
  }

  throw new Error(
    `Failed to delete Supabase project (${resp.status}): ${text}`
  );
}

/**
 * Provisioning state machine "tick".
 *
 * Vercel isn’t great at long background jobs, so we advance in small steps during status polls.
 */
export async function tickProvisioning(params: {
  stripeAccountId: string;
  livemode: boolean;
}): Promise<void> {
  const { stripeAccountId, livemode } = params;
  const waitDatabaseReadyTimeoutMs = parseTimeoutMs(
    process.env.PROVISIONING_WAIT_DATABASE_READY_TIMEOUT_MS,
    10 * 60 * 1000
  );

  await tryWithProvisioningLock(stripeAccountId, async (client) => {
    const result = await client.query(
      `SELECT
        stripe_account_id,
        project_ref,
        region,
        install_status,
        install_step,
        error_message,
        updated_at
      FROM provisioned_databases
      WHERE stripe_account_id = $1`,
      [stripeAccountId]
    );

    if (result.rowCount === 0) return;

    const row = result.rows[0] as {
      project_ref: string;
      region: string;
      install_status: Exclude<InstallStatus, 'not_provisioned'>;
      install_step: InstallStep | null;
      error_message: string | null;
      updated_at: string | Date;
    };

    const projectRef = row.project_ref;
    const region = row.region;
    const status = row.install_status;
    const step = row.install_step;
    const updatedAt = new Date(row.updated_at);

    const updateProgressTx = async (
      nextStatus: Exclude<InstallStatus, 'not_provisioned'>,
      nextStep: InstallStep | null
    ) => {
      await client.query(
        `UPDATE provisioned_databases SET
          install_status = $1,
          install_step = $2,
          error_message = NULL,
          updated_at = NOW()
        WHERE stripe_account_id = $3`,
        [nextStatus, nextStep, stripeAccountId]
      );
    };

    const setFatalErrorTx = async (message: string) => {
      await client.query(
        `UPDATE provisioned_databases SET
          install_status = 'error',
          error_message = $1,
          updated_at = NOW()
        WHERE stripe_account_id = $2`,
        [message, stripeAccountId]
      );
    };

    // Terminal states
    if (status === 'ready' || status === 'error') {
      return;
    }

    // Normalize: pending/create_project -> provisioning/wait_database_ready
    if (status === 'pending' || step === 'create_project' || step === null) {
      console.log(`[provisioning/tick] Advancing ${stripeAccountId} to wait_database_ready`);
      await updateProgressTx('provisioning', 'wait_database_ready');
      return;
    }

    // Step: wait for DB readiness (single-shot)
    if (step === 'wait_database_ready' || status === 'provisioning') {
      const elapsedMs = Date.now() - updatedAt.getTime();
      if (elapsedMs > waitDatabaseReadyTimeoutMs) {
        const timeoutMsg = `Database failed to stabilize in time (>${Math.round(
          waitDatabaseReadyTimeoutMs / 1000
        )}s). Please try again.`;
        console.warn(
          `[provisioning/tick] wait_database_ready timeout for ${stripeAccountId} (${projectRef}): ${timeoutMsg}`
        );
        await setFatalErrorTx(timeoutMsg);
        return;
      }

      let supabaseAccessToken: string;
      try {
        supabaseAccessToken = getSupabaseConfig().accessToken;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await setFatalErrorTx(msg);
        return;
      }

      const check = await checkDatabaseReadyOnce({
        accessToken: supabaseAccessToken,
        projectRef,
        stripeAccountId,
      });

      if (check.fatalError) {
        await setFatalErrorTx(check.fatalError);
        return;
      }

      if (!check.ready) {
        return;
      }

      await updateProgressTx('installing', 'apply_schema');
      return;
    }

    // Step: apply schema (currently no-op; just advance)
    if (step === 'apply_schema') {
      await updateProgressTx('installing', 'verify_connection');
      return;
    }

    // Step: verify connection (currently no-op; just advance)
    if (step === 'verify_connection') {
      await updateProgressTx('syncing', 'start_sync');
      return;
    }

    // Step: install sync (bounded: one install attempt per tick)
    if (step === 'start_sync') {
      try {
        let supabaseAccessToken: string;
        try {
          supabaseAccessToken = getSupabaseConfig().accessToken;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await setFatalErrorTx(msg);
          return;
        }

        // Refresh Stripe tokens in DB if needed
        await getStripeClient({ stripeAccountId, livemode });

        // Re-fetch from DB and decrypt (getStripeClient doesn't expose raw token)
        const { getOAuthConnection } = await import('./db');
        const { decrypt } = await import('./crypto');

        const connection = await getOAuthConnection(stripeAccountId, livemode);
        if (!connection) {
          throw new Error('OAuth connection not found');
        }

        const stripeAccessToken = decrypt(connection.access_token_enc);

        await installStripeSync(
          supabaseAccessToken,
          projectRef,
          stripeAccessToken,
          region,
          stripeAccountId,
          { maxAttempts: 1 }
        );

        await updateProgressTx('syncing', 'verify_sync');
        return;
      } catch (err) {
        const msgRaw = err instanceof Error ? err.message : String(err);
        const msg = sanitizeErrorMessage(msgRaw);
        console.warn(`[provisioning/tick] start_sync failed for ${stripeAccountId}: ${msg}`);
        // Do NOT auto-retry forever on subsequent status polls; fail fast and let the user explicitly retry.
        await setFatalErrorTx(msg);
        return;
      }
    }

    // Step: verify sync (lightweight delay based on updated_at)
    if (step === 'verify_sync') {
      const elapsedMs = Date.now() - updatedAt.getTime();
      if (elapsedMs >= 3000) {
        await updateProgressTx('ready', 'done');
      }
      return;
    }

    // Unknown step: reset to a safe state
    console.warn(
      `[provisioning/tick] Unknown step for ${stripeAccountId}: ${String(step)}; resetting`
    );
    await updateProgressTx('provisioning', 'wait_database_ready');
  });
}

/**
 * Get the connection string for a ready database
 */
export function getConnectionString(
  projectRef: string,
  dbPassword: string,
  region: string
): string {
  return buildConnectionString(projectRef, dbPassword, region);
}

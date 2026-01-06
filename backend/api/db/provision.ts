/**
 * Database Provisioning Endpoint
 *
 * POST /api/db/provision - Provision a new Supabase database for a Stripe account.
 *   Body: { account_id: string, livemode?: boolean }
 *   Idempotent - returns current status if already provisioned.
 *
 * DELETE /api/db/provision - Deprovision (delete) the Supabase project for a Stripe account.
 *   Query: ?account_id=acct_xxx&livemode=true|false
 *   Only deletes local DB row after Supabase project is successfully deleted.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyOAuthConnection } from '../../lib/auth';
import {
  getProvisionedDb,
  deleteProvisionedDb,
  tryWithProvisioningLock,
} from '../../lib/provisioned-db';
import { startProvisioning, deleteSupabaseProject } from '../../lib/supabase-provisioning';
import type { DbStatusResponse } from '../../lib/provisioning-types';

function headerValue(req: VercelRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function requestId(req: VercelRequest): string | undefined {
  return (
    headerValue(req, 'x-vercel-id') ||
    headerValue(req, 'x-request-id') ||
    headerValue(req, 'cf-ray')
  );
}

function redactStripeAccountId(accountId: string): string {
  if (!accountId) return 'unknown';
  const suffix = accountId.slice(-6);
  if (accountId.startsWith('acct_')) return `acct_…${suffix}`;
  return `…${suffix}`;
}

/**
 * Handler for database provisioning endpoint
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Set CORS headers for Stripe App
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Route to appropriate handler
  if (req.method === 'DELETE') {
    return handleDelete(req, res);
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, DELETE, OPTIONS');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Extract parameters from body
    const rid = requestId(req);
    const hasAuthHeader = Boolean(headerValue(req, 'authorization'));
    const contentType = headerValue(req, 'content-type');

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const accountId = body?.account_id;
    const livemode = body?.livemode === true;

    if (!accountId || typeof accountId !== 'string') {
      console.warn(
        `[db/provision] bad_request ${JSON.stringify({
          requestId: rid,
          method: req.method,
          reason: 'missing_or_invalid_account_id',
          bodyType: typeof req.body,
          contentType,
          hasAuthHeader,
        })}`
      );
      res.status(400).json({ error: 'Missing required parameter: account_id' });
      return;
    }

    console.log(
      `[db/provision] request ${JSON.stringify({
        requestId: rid,
        method: req.method,
        account: redactStripeAccountId(accountId),
        livemodeParsed: livemode,
        bodyLivemodeType: typeof body?.livemode,
        contentType,
        hasAuthHeader,
      })}`
    );

    // Verify OAuth connection
    const auth = await verifyOAuthConnection(accountId, livemode);
    if (!auth.authorized) {
      console.warn(
        `[db/provision] unauthorized ${JSON.stringify({
          requestId: rid,
          account: redactStripeAccountId(accountId),
          requestedLivemode: livemode,
          authError: auth.error,
        })}`
      );
      res.status(401).json({
        error: 'Unauthorized',
        message: auth.error || 'OAuth connection required',
      });
      return;
    }

    // Check for existing database record
    const existingDb = await getProvisionedDb(accountId);

    if (existingDb) {
      // If in error state, delete and allow retry
      if (existingDb.install_status === 'error') {
        console.log(`[provision] Deleting failed record for ${accountId} to allow retry`);
        await deleteProvisionedDb(accountId);
      } else {
        // Return current status (idempotent)
        console.log(`[provision] Returning existing status for ${accountId}: ${existingDb.install_status}`);
        const response: DbStatusResponse = {
          status: existingDb.install_status,
          step: existingDb.install_step,
          error_message: existingDb.error_message,
          connection_string: null, // Only provided by status endpoint when ready
          project_ref: existingDb.project_ref,
          created_at: existingDb.created_at.toISOString(),
        };
        res.status(200).json(response);
        return;
      }
    }

    // Start provisioning
    console.log(`[provision] Starting provisioning for ${accountId}`);
    const { projectRef } = await startProvisioning(accountId, livemode);

    // Return pending status
    const response: DbStatusResponse = {
      status: 'pending',
      step: 'create_project',
      error_message: null,
      connection_string: null,
      project_ref: projectRef,
      created_at: new Date().toISOString(),
    };

    res.status(202).json(response);
  } catch (error) {
    console.error(
      `[db/provision] error ${JSON.stringify({
        requestId: requestId(req),
        message: error instanceof Error ? error.message : String(error),
      })}`
    );
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Handle DELETE /api/db/provision
 * Deprovisions (deletes) the Supabase project for a Stripe account.
 * Only deletes the local DB row after Supabase confirms deletion (2xx).
 */
async function handleDelete(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const rid = requestId(req);

  try {
    // Parse query parameters (DELETE bodies are unreliable)
    const accountId = req.query.account_id;
    const livemodeParam = req.query.livemode;

    if (!accountId || typeof accountId !== 'string') {
      console.warn(
        `[db/provision DELETE] bad_request ${JSON.stringify({
          requestId: rid,
          reason: 'missing_or_invalid_account_id',
        })}`
      );
      res.status(400).json({ error: 'Missing required query parameter: account_id' });
      return;
    }

    const livemode = livemodeParam === 'true';

    console.log(
      `[db/provision DELETE] request ${JSON.stringify({
        requestId: rid,
        account: redactStripeAccountId(accountId),
        livemode,
      })}`
    );

    // Verify OAuth connection
    const auth = await verifyOAuthConnection(accountId, livemode);
    if (!auth.authorized) {
      console.warn(
        `[db/provision DELETE] unauthorized ${JSON.stringify({
          requestId: rid,
          account: redactStripeAccountId(accountId),
          authError: auth.error,
        })}`
      );
      res.status(401).json({
        error: 'Unauthorized',
        message: auth.error || 'OAuth connection required',
      });
      return;
    }

    // Fetch existing record
    const existingDb = await getProvisionedDb(accountId);

    if (!existingDb) {
      // No record exists - already deprovisioned
      const response: DbStatusResponse = {
        status: 'not_provisioned',
        step: null,
        error_message: null,
        connection_string: null,
        project_ref: null,
        created_at: null,
      };
      res.status(200).json(response);
      return;
    }

    const projectRef = existingDb.project_ref;

    // Acquire advisory lock to prevent concurrent tickProvisioning
    const lockResult = await tryWithProvisioningLock(accountId, async () => {
      // Delete the Supabase project (throws on failure including 404)
      await deleteSupabaseProject(projectRef);

      // Only reached if Supabase deletion succeeded (2xx)
      await deleteProvisionedDb(accountId);

      console.log(
        `[db/provision DELETE] success ${JSON.stringify({
          requestId: rid,
          account: redactStripeAccountId(accountId),
          projectRef,
        })}`
      );

      return { deleted: true };
    });

    if (!lockResult.acquired) {
      console.warn(
        `[db/provision DELETE] lock_conflict ${JSON.stringify({
          requestId: rid,
          account: redactStripeAccountId(accountId),
        })}`
      );
      res.status(409).json({
        error: 'Conflict',
        message:
          'Another operation is in progress for this account. Please wait a moment and try again.',
      });
      return;
    }

    // Success - return not_provisioned status
    const response: DbStatusResponse = {
      status: 'not_provisioned',
      step: null,
      error_message: null,
      connection_string: null,
      project_ref: null,
      created_at: null,
    };
    res.status(200).json(response);
  } catch (error) {
    console.error(
      `[db/provision DELETE] error ${JSON.stringify({
        requestId: rid,
        message: error instanceof Error ? error.message : String(error),
      })}`
    );
    res.status(500).json({
      error: 'Failed to delete synced database',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

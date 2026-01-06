/**
 * Database Status Endpoint
 *
 * Returns the provisioning status for a Stripe account's synced database.
 *
 * Route: GET /api/db/status?account_id=acct_xxx&livemode=false
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyOAuthConnection } from '../../lib/auth';
import { getProvisionedDb } from '../../lib/provisioned-db';
import { decrypt } from '../../lib/crypto';
import { getConnectionString, tickProvisioning } from '../../lib/supabase-provisioning';
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
 * Handler for database status endpoint
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Set CORS headers for Stripe App
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Extract parameters
    const accountId = req.query.account_id;
    const livemodeParam = req.query.livemode;
    const rid = requestId(req);
    const hasAuthHeader = Boolean(headerValue(req, 'authorization'));

    if (!accountId || typeof accountId !== 'string') {
      console.warn(
        `[db/status] bad_request ${JSON.stringify({
          requestId: rid,
          method: req.method,
          reason: 'missing_or_invalid_account_id',
          livemodeParam:
            typeof livemodeParam === 'string'
              ? livemodeParam
              : Array.isArray(livemodeParam)
                ? livemodeParam[0]
                : undefined,
          hasAuthHeader,
        })}`
      );
      res.status(400).json({ error: 'Missing required parameter: account_id' });
      return;
    }

    const livemode = livemodeParam === 'true';

    console.log(
      `[db/status] request ${JSON.stringify({
        requestId: rid,
        method: req.method,
        account: redactStripeAccountId(accountId),
        livemodeParam:
          typeof livemodeParam === 'string'
            ? livemodeParam
            : Array.isArray(livemodeParam)
              ? livemodeParam[0]
              : undefined,
        livemodeParsed: livemode,
        hasAuthHeader,
      })}`
    );

    // Verify OAuth connection
    const auth = await verifyOAuthConnection(accountId, livemode);
    if (!auth.authorized) {
      console.warn(
        `[db/status] unauthorized ${JSON.stringify({
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

    // Get provisioned database record
    let db = await getProvisionedDb(accountId);

    // Serverless-friendly progress: advance provisioning in small steps during polling.
    // (Vercel functions are not reliable for long-running "background" work after returning a response.)
    if (db && ['pending', 'provisioning', 'installing', 'syncing'].includes(db.install_status)) {
      try {
        await tickProvisioning({ stripeAccountId: accountId, livemode });
        db = await getProvisionedDb(accountId);
      } catch (err) {
        console.error(
          `[db/status] tick_error ${JSON.stringify({
            requestId: rid,
            account: redactStripeAccountId(accountId),
            message: err instanceof Error ? err.message : String(err),
          })}`
        );
      }
    }

    // No database provisioned yet
    if (!db) {
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

    // Build response
    const response: DbStatusResponse = {
      status: db.install_status,
      step: db.install_step,
      error_message: db.error_message,
      connection_string: null,
      project_ref: db.project_ref,
      created_at: db.created_at.toISOString(),
    };

    // Only include connection string when ready
    if (db.install_status === 'ready') {
      try {
        const dbPassword = decrypt(db.db_password_enc);
        response.connection_string = getConnectionString(
          db.project_ref,
          dbPassword,
          db.region
        );
      } catch (err) {
        console.error('Failed to decrypt database password:', err);
        response.error_message = 'Failed to retrieve connection credentials';
      }
    }

    res.status(200).json(response);
  } catch (error) {
    console.error(
      `[db/status] error ${JSON.stringify({
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

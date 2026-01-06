/**
 * Authentication helpers for API endpoints
 *
 * Verifies that a Stripe account has a valid OAuth connection
 * before allowing access to provisioning endpoints.
 */

import { getStripeClient } from './stripe-client';
import { listAccountConnections } from './db';

/**
 * Result of OAuth connection verification
 */
export interface AuthResult {
  /** Whether the account is authorized */
  authorized: boolean;
  /** The Stripe account ID */
  stripeAccountId: string;
  /** Error message if not authorized */
  error?: string;
}

function redactStripeAccountId(accountId: string): string {
  if (!accountId) return 'unknown';
  const suffix = accountId.slice(-6);
  if (accountId.startsWith('acct_')) return `acct_…${suffix}`;
  return `…${suffix}`;
}

/**
 * Verify that the account has a valid OAuth connection
 *
 * This function:
 * 1. Checks if OAuth tokens exist for the account
 * 2. Makes a test API call (GET /v1/account) to verify token works
 *
 * @param accountId - Stripe account ID (acct_xxx)
 * @param livemode - Whether to check live mode (default: false)
 * @returns Authorization result
 *
 * @example
 * ```typescript
 * const auth = await verifyOAuthConnection('acct_xxx', false);
 * if (!auth.authorized) {
 *   return res.status(401).json({ error: auth.error });
 * }
 * ```
 */
export async function verifyOAuthConnection(
  accountId: string,
  livemode: boolean = false
): Promise<AuthResult> {
  try {
    // Get a Stripe client (this will throw if no connection exists)
    const { client } = await getStripeClient({
      stripeAccountId: accountId,
      livemode,
    });

    // Verify the token actually works by making a test API call
    await client.accounts.retrieve(accountId);

    return {
      authorized: true,
      stripeAccountId: accountId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OAuth verification failed';
    const safeAccount = redactStripeAccountId(accountId);

    const maybeStripeError = error as {
      type?: string;
      code?: string;
      statusCode?: number;
      requestId?: string;
      raw?: { requestId?: string };
    } | null;

    const stripeErrorSummary =
      maybeStripeError && (maybeStripeError.type || maybeStripeError.code || maybeStripeError.statusCode)
        ? {
            type: maybeStripeError.type,
            code: maybeStripeError.code,
            statusCode: maybeStripeError.statusCode,
            requestId: maybeStripeError.requestId || maybeStripeError.raw?.requestId,
          }
        : undefined;

    // Extra diagnostics for the most common case: mode mismatch (connection exists, but not for requested livemode).
    if (typeof message === 'string' && message.includes('No OAuth connection found')) {
      try {
        const connections = await listAccountConnections(accountId);
        const availableLivemodes = Array.from(new Set(connections.map(c => c.livemode)));
        const possibleModeMismatch =
          availableLivemodes.length > 0 && !availableLivemodes.includes(livemode);

        console.warn(
          `[auth] oauth_verify_failed ${JSON.stringify({
            account: safeAccount,
            requestedLivemode: livemode,
            errorMessage: message,
            stripe: stripeErrorSummary,
            availableLivemodes,
            availableConnections: connections.map(c => ({
              livemode: c.livemode,
              updatedAt: c.updated_at?.toISOString?.(),
              accessTokenExpiresAt: c.access_token_expires_at?.toISOString?.(),
              hasScope: Boolean(c.scope),
              hasPublishableKey: Boolean(c.stripe_publishable_key),
            })),
            possibleModeMismatch,
          })}`
        );
      } catch (listErr) {
        const listErrMsg = listErr instanceof Error ? listErr.message : String(listErr);
        console.warn(
          `[auth] oauth_verify_failed ${JSON.stringify({
            account: safeAccount,
            requestedLivemode: livemode,
            errorMessage: message,
            stripe: stripeErrorSummary,
            listConnectionsError: listErrMsg,
          })}`
        );
      }
    } else {
      console.warn(
        `[auth] oauth_verify_failed ${JSON.stringify({
          account: safeAccount,
          requestedLivemode: livemode,
          errorMessage: message,
          stripe: stripeErrorSummary,
        })}`
      );
    }

    return {
      authorized: false,
      stripeAccountId: accountId,
      error: message,
    };
  }
}

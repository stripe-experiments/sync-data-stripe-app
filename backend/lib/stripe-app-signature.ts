/**
 * Stripe Apps request signature verification
 *
 * Verifies that requests from the UI extension are signed by Stripe,
 * cryptographically binding the request to a specific user_id + account_id.
 *
 * See: https://docs.stripe.com/stripe-apps/build-backend#authenticate-ui-to-backend
 */

import type { VercelRequest } from '@vercel/node';
import Stripe from 'stripe';

/**
 * Result of verifying a Stripe App signature
 */
export interface VerifiedStripeAppRequest {
  /** Stripe Dashboard user ID (usr_xxx) */
  userId: string;
  /** Stripe account ID (acct_xxx) */
  accountId: string;
}

/**
 * Error thrown when signature verification fails
 */
export class StripeAppSignatureError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number = 401) {
    super(message);
    this.name = 'StripeAppSignatureError';
    this.statusCode = statusCode;
  }
}

/**
 * Get the app signing secret(s) from environment.
 * Supports rotation by accepting comma-separated secrets.
 *
 * @returns Array of valid signing secrets
 * @throws Error if no signing secret is configured
 */
function getSigningSecrets(): string[] {
  const secretsEnv = process.env.STRIPE_APP_SIGNING_SECRET;

  if (!secretsEnv) {
    throw new StripeAppSignatureError(
      'STRIPE_APP_SIGNING_SECRET environment variable is not set',
      500
    );
  }

  // Support multiple secrets for rotation (comma-separated)
  const secrets = secretsEnv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (secrets.length === 0) {
    throw new StripeAppSignatureError(
      'STRIPE_APP_SIGNING_SECRET is empty',
      500
    );
  }

  return secrets;
}

/**
 * Extract the Stripe-Signature header from a request
 */
function getSignatureHeader(req: VercelRequest): string {
  const sig = req.headers['stripe-signature'];

  if (!sig) {
    throw new StripeAppSignatureError('Missing Stripe-Signature header');
  }

  if (Array.isArray(sig)) {
    throw new StripeAppSignatureError('Invalid Stripe-Signature header');
  }

  return sig;
}

/**
 * Build the canonical payload string for signature verification.
 * Order matters: { user_id, account_id } per Stripe docs.
 */
function buildCanonicalPayload(userId: string, accountId: string): string {
  return JSON.stringify({
    user_id: userId,
    account_id: accountId,
  });
}

/**
 * Extract user_id and account_id from the request.
 * For GET/DELETE: from query params
 * For POST/PUT/PATCH: from JSON body
 */
function extractIdentifiers(req: VercelRequest): {
  userId: string;
  accountId: string;
} {
  let userId: string | undefined;
  let accountId: string | undefined;

  if (req.method === 'GET' || req.method === 'DELETE') {
    // Extract from query parameters
    const queryUserId = req.query.user_id;
    const queryAccountId = req.query.account_id;

    userId = Array.isArray(queryUserId) ? queryUserId[0] : queryUserId;
    accountId = Array.isArray(queryAccountId)
      ? queryAccountId[0]
      : queryAccountId;
  } else {
    // Extract from body (POST/PUT/PATCH)
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    userId = body?.user_id;
    accountId = body?.account_id;
  }

  if (!userId || typeof userId !== 'string') {
    throw new StripeAppSignatureError(
      'Missing required parameter: user_id',
      400
    );
  }

  if (!accountId || typeof accountId !== 'string') {
    throw new StripeAppSignatureError(
      'Missing required parameter: account_id',
      400
    );
  }

  return { userId, accountId };
}

/**
 * Redact a Stripe account ID for logging
 */
function redactAccountId(accountId: string): string {
  if (!accountId) return 'unknown';
  const suffix = accountId.slice(-6);
  if (accountId.startsWith('acct_')) return `acct_…${suffix}`;
  return `…${suffix}`;
}

/**
 * Redact a Stripe user ID for logging
 */
function redactUserId(userId: string): string {
  if (!userId) return 'unknown';
  const suffix = userId.slice(-4);
  if (userId.startsWith('usr_')) return `usr_…${suffix}`;
  return `…${suffix}`;
}

/**
 * Verify a Stripe App signed request.
 *
 * This function:
 * 1. Extracts the Stripe-Signature header
 * 2. Extracts user_id and account_id from the request
 * 3. Builds the canonical payload string
 * 4. Verifies the signature using the app signing secret(s)
 * 5. Returns the verified user_id and account_id
 *
 * @param req - The incoming Vercel request
 * @param options - Optional configuration
 * @returns The verified user_id and account_id
 * @throws StripeAppSignatureError if verification fails
 *
 * @example
 * ```typescript
 * try {
 *   const { userId, accountId } = await verifyStripeAppSignature(req);
 *   // Use accountId for all operations - it's cryptographically verified
 * } catch (error) {
 *   if (error instanceof StripeAppSignatureError) {
 *     return res.status(error.statusCode).json({ error: error.message });
 *   }
 *   throw error;
 * }
 * ```
 */
export async function verifyStripeAppSignature(
  req: VercelRequest,
  options: {
    /** Signature timestamp tolerance in seconds (default: 300 = 5 minutes) */
    tolerance?: number;
  } = {}
): Promise<VerifiedStripeAppRequest> {
  const tolerance = options.tolerance ?? 300;

  // Get the signature header
  const signature = getSignatureHeader(req);

  // Extract identifiers from request
  const { userId, accountId } = extractIdentifiers(req);

  // Build canonical payload (order matters!)
  const payload = buildCanonicalPayload(userId, accountId);

  // Get signing secrets (supports rotation)
  const secrets = getSigningSecrets();

  // Create a Stripe instance for signature verification
  // We use a dummy key since we only need the webhooks.signature helper
  const stripe = new Stripe('sk_dummy_for_signature_verification', {
    apiVersion: '2023-10-16',
    typescript: true,
  });

  // Try each secret (for rotation support)
  let lastError: Error | null = null;

  for (const secret of secrets) {
    try {
      // verifyHeader throws if signature is invalid
      stripe.webhooks.signature.verifyHeader(payload, signature, secret, tolerance);

      // Signature verified successfully
      console.log(
        `[stripe-app-signature] verified ${JSON.stringify({
          user: redactUserId(userId),
          account: redactAccountId(accountId),
        })}`
      );

      return {
        userId,
        accountId,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Try next secret if available
      continue;
    }
  }

  // All secrets failed
  console.warn(
    `[stripe-app-signature] verification_failed ${JSON.stringify({
      user: redactUserId(userId),
      account: redactAccountId(accountId),
      error: lastError?.message ?? 'Unknown error',
    })}`
  );

  throw new StripeAppSignatureError(
    'Invalid signature: request could not be verified'
  );
}

/**
 * Require a valid Stripe App signature on a request.
 * Convenience wrapper that extracts the verified identifiers or throws.
 *
 * @param req - The incoming Vercel request
 * @returns The verified user_id and account_id
 * @throws StripeAppSignatureError if verification fails
 */
export async function requireStripeAppSignature(
  req: VercelRequest
): Promise<VerifiedStripeAppRequest> {
  return verifyStripeAppSignature(req);
}

export { redactAccountId, redactUserId };


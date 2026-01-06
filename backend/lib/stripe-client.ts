/**
 * Stripe client helper.
 *
 * Pulls stored OAuth tokens for a connected account and refreshes when needed.
 */

import Stripe from 'stripe';
import { encrypt, decrypt } from './crypto';
import { getOAuthConnection, updateConnectionTokens } from './db';

/**
 * Stripe token refresh endpoint
 */
const STRIPE_TOKEN_URL = 'https://api.stripe.com/v1/oauth/token';

/**
 * Refresh tokens when they expire within this many minutes
 */
const REFRESH_THRESHOLD_MINUTES = 5;

/**
 * Default token expiry in seconds (1 hour)
 */
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600;

/**
 * Token response from Stripe refresh endpoint
 */
interface RefreshTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  scope: string;
  expires_in?: number;
}

/**
 * Error response from Stripe
 */
interface RefreshTokenError {
  error: string;
  error_description: string;
}

/**
 * Options for getting a Stripe client
 */
export interface GetStripeClientOptions {
  /** Stripe account ID (acct_xxx) */
  stripeAccountId: string;
  /** Whether to use live mode credentials */
  livemode: boolean;
}

/**
 * Result of getting a Stripe client
 */
export interface StripeClientResult {
  /** Configured Stripe SDK instance */
  client: Stripe;
  /** The account ID this client is for */
  stripeAccountId: string;
  /** Whether this is a live mode client */
  livemode: boolean;
}

/**
 * Get the appropriate secret key for the mode
 */
function getSecretKey(livemode: boolean): string {
  const key = livemode
    ? process.env.STRIPE_SECRET_KEY_LIVE
    : process.env.STRIPE_SECRET_KEY_TEST;
  
  if (!key) {
    throw new Error(`Missing STRIPE_SECRET_KEY_${livemode ? 'LIVE' : 'TEST'} environment variable`);
  }
  
  return key;
}

/**
 * Check if response is an error
 */
function isRefreshError(
  response: RefreshTokenResponse | RefreshTokenError
): response is RefreshTokenError {
  return 'error' in response;
}

/**
 * Refresh an access token using the refresh token
 */
async function refreshAccessToken(
  refreshToken: string,
  livemode: boolean
): Promise<RefreshTokenResponse> {
  const secretKey = getSecretKey(livemode);
  
  const response = await fetch(STRIPE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(secretKey + ':').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  
  const result = await response.json() as RefreshTokenResponse | RefreshTokenError;
  
  if (isRefreshError(result)) {
    throw new Error(`Token refresh failed: ${result.error} - ${result.error_description}`);
  }
  
  return result;
}

/**
 * Check if a token needs refreshing
 */
function needsRefresh(expiresAt: Date): boolean {
  const thresholdMs = REFRESH_THRESHOLD_MINUTES * 60 * 1000;
  return expiresAt.getTime() < Date.now() + thresholdMs;
}

/**
 * Get a Stripe SDK client for a connected account.
 *
 * If the access token is close to expiring, we refresh it and store the rotated refresh token.
 */
export async function getStripeClient(
  options: GetStripeClientOptions
): Promise<StripeClientResult> {
  const { stripeAccountId, livemode } = options;
  
  // Load connection from database
  const connection = await getOAuthConnection(stripeAccountId, livemode);
  
  if (!connection) {
    throw new Error(
      `No OAuth connection found for account ${stripeAccountId} (livemode=${livemode})`
    );
  }
  
  // Decrypt the current access token
  let accessToken = decrypt(connection.access_token_enc);
  let expiresAt = connection.access_token_expires_at;
  
  // Check if token needs refreshing
  if (needsRefresh(expiresAt)) {
    console.log(`Refreshing token for account ${stripeAccountId} (livemode=${livemode})`);
    
    // Decrypt refresh token
    const refreshToken = decrypt(connection.refresh_token_enc);
    
    // Refresh the token
    const newTokens = await refreshAccessToken(refreshToken, livemode);
    
    // Calculate new expiry
    const expiresInSeconds = newTokens.expires_in || DEFAULT_TOKEN_EXPIRY_SECONDS;
    const newExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    
    // Encrypt new tokens
    const newAccessTokenEnc = encrypt(newTokens.access_token);
    const newRefreshTokenEnc = encrypt(newTokens.refresh_token);
    
    // Update the DB (refresh tokens rotate, so store the new one).
    await updateConnectionTokens(
      stripeAccountId,
      livemode,
      newAccessTokenEnc,
      newExpiresAt,
      newRefreshTokenEnc
    );
    
    // Use the new access token
    accessToken = newTokens.access_token;
    expiresAt = newExpiresAt;
    
    console.log(`Token refreshed for account ${stripeAccountId} (livemode=${livemode})`);
  }
  
  // Create and return a configured Stripe client
  const client = new Stripe(accessToken, {
    apiVersion: '2023-10-16',
    typescript: true,
  });
  
  return {
    client,
    stripeAccountId,
    livemode,
  };
}

/** Quick check: does this account have an OAuth connection for this mode? */
export async function hasConnection(
  stripeAccountId: string,
  livemode: boolean
): Promise<boolean> {
  const connection = await getOAuthConnection(stripeAccountId, livemode);
  return connection !== null;
}

/** Get connection metadata (no tokens). */
export async function getConnectionMetadata(
  stripeAccountId: string,
  livemode: boolean
): Promise<{
  stripeAccountId: string;
  livemode: boolean;
  scope: string | null;
  createdAt: Date;
  updatedAt: Date;
  tokenExpiresAt: Date;
} | null> {
  const connection = await getOAuthConnection(stripeAccountId, livemode);
  
  if (!connection) {
    return null;
  }
  
  return {
    stripeAccountId: connection.stripe_account_id,
    livemode: connection.livemode,
    scope: connection.scope,
    createdAt: connection.created_at,
    updatedAt: connection.updated_at,
    tokenExpiresAt: connection.access_token_expires_at,
  };
}


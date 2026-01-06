/**
 * Shared TypeScript types for Sync Stripe App
 */

/**
 * OAuth mode - test or live
 */
export type OAuthMode = 'test' | 'live';

/**
 * OAuth state stored in database (before hashing)
 */
export interface OAuthStateRecord {
  state_hash: string;
  mode: OAuthMode;
  expires_at: Date;
  created_at: Date;
}

/**
 * Stripe OAuth connection stored in database
 */
export interface StripeOAuthConnection {
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
 * Stripe OAuth token response from /v1/oauth/token
 */
export interface StripeTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  scope: string;
  livemode: boolean;
  stripe_user_id: string;
  stripe_publishable_key: string;
  /** Token lifetime in seconds (typically 3600 = 1 hour) */
  expires_in?: number;
}

/**
 * Stripe OAuth error response
 */
export interface StripeOAuthError {
  error: string;
  error_description: string;
}

/**
 * Encrypted payload format (versioned for future key rotation)
 */
export interface EncryptedPayload {
  /** Version of the encryption format */
  v: 1;
  /** Initialization vector (base64) */
  iv: string;
  /** Encrypted data (base64) */
  data: string;
  /** Authentication tag (base64) */
  tag: string;
}

/**
 * Parameters for getting a Stripe client
 */
export interface GetStripeClientParams {
  stripeAccountId: string;
  livemode: boolean;
}


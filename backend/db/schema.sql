-- Sync Stripe App Database Schema
-- Run this against your Vercel Postgres database

-- ============================================================================
-- Table: oauth_states
-- Purpose: CSRF protection for OAuth flow
-- ============================================================================
-- Stores SHA-256 hashes of OAuth state parameters.
-- States are consumed (deleted) after single use and have a 10-minute TTL.

CREATE TABLE IF NOT EXISTS oauth_states (
  -- SHA-256 hash of the random state value (not the raw state)
  state_hash VARCHAR(64) PRIMARY KEY,
  
  -- OAuth mode: 'test' or 'live'
  mode VARCHAR(10) NOT NULL CHECK (mode IN ('test', 'live')),
  
  -- State expires after 10 minutes
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  
  -- When the state was created
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at);

-- ============================================================================
-- Table: stripe_oauth_connections
-- Purpose: Store encrypted OAuth tokens for connected Stripe accounts
-- ============================================================================
-- Stores both test and live mode tokens separately using a composite key.
-- All tokens are encrypted with AES-256-GCM before storage.

CREATE TABLE IF NOT EXISTS stripe_oauth_connections (
  -- Stripe account ID (acct_xxx)
  stripe_account_id VARCHAR(255) NOT NULL,
  
  -- Whether this is a live mode connection
  livemode BOOLEAN NOT NULL,
  
  -- OAuth scope granted
  scope VARCHAR(50),
  
  -- Publishable key for this connection
  stripe_publishable_key VARCHAR(255),
  
  -- AES-256-GCM encrypted access token
  access_token_enc TEXT NOT NULL,
  
  -- When the access token expires
  access_token_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  
  -- AES-256-GCM encrypted refresh token
  refresh_token_enc TEXT NOT NULL,
  
  -- When the refresh token was last rotated
  refresh_token_rotated_at TIMESTAMP WITH TIME ZONE,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Composite primary key: allows storing both test and live tokens
  PRIMARY KEY (stripe_account_id, livemode)
);

-- Index for looking up connections by account
CREATE INDEX IF NOT EXISTS idx_stripe_oauth_connections_account 
ON stripe_oauth_connections(stripe_account_id);

-- ============================================================================
-- Cleanup Function: Remove expired OAuth states
-- ============================================================================
-- Call this periodically (e.g., via cron) to clean up expired states.
-- Not strictly necessary as states are deleted on use, but good hygiene.

-- To manually clean up:
-- DELETE FROM oauth_states WHERE expires_at < NOW();

-- ============================================================================
-- Example Queries
-- ============================================================================

-- Insert a new OAuth state:
-- INSERT INTO oauth_states (state_hash, mode, expires_at)
-- VALUES ($1, $2, $3);

-- Consume (validate and delete) an OAuth state:
-- DELETE FROM oauth_states 
-- WHERE state_hash = $1 AND expires_at > NOW()
-- RETURNING mode;

-- Upsert a connection:
-- INSERT INTO stripe_oauth_connections (
--   stripe_account_id, livemode, scope, stripe_publishable_key,
--   access_token_enc, access_token_expires_at,
--   refresh_token_enc, refresh_token_rotated_at
-- ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
-- ON CONFLICT (stripe_account_id, livemode) DO UPDATE SET
--   scope = EXCLUDED.scope,
--   stripe_publishable_key = EXCLUDED.stripe_publishable_key,
--   access_token_enc = EXCLUDED.access_token_enc,
--   access_token_expires_at = EXCLUDED.access_token_expires_at,
--   refresh_token_enc = EXCLUDED.refresh_token_enc,
--   refresh_token_rotated_at = NOW(),
--   updated_at = NOW();


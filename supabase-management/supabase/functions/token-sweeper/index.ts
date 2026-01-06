/**
 * Token Sweeper Edge Function
 *
 * Refreshes expiring Stripe OAuth tokens stored in stripe_oauth_connections.
 * Triggered by pg_cron every 30 minutes via pg_net HTTP POST.
 *
 * Security:
 * - Uses Supabase's built-in JWT authentication (anon key)
 * - Tokens are encrypted/decrypted using AES-256-GCM (compatible with backend)
 * - No tokens are ever logged
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// =============================================================================
// Configuration
// =============================================================================

const STRIPE_TOKEN_URL = "https://api.stripe.com/v1/oauth/token";
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600; // 1 hour
const REFRESH_THRESHOLD_MINUTES = 35; // Refresh tokens expiring in next 35 minutes
const BATCH_SIZE = 200; // Process this many rows per batch
const CONCURRENCY_LIMIT = 5; // Refresh this many tokens in parallel

// =============================================================================
// Types
// =============================================================================

interface StoredConnection {
  stripe_account_id: string;
  livemode: boolean;
  scope: string | null;
  access_token_enc: string;
  access_token_expires_at: string;
  refresh_token_enc: string;
}

interface RefreshTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  scope: string;
  expires_in?: number;
}

interface RefreshTokenError {
  error: string;
  error_description: string;
}

interface RequestBody {
  triggered_by?: string;
  dry_run?: boolean;
  force_all?: boolean;
}

interface RefreshResult {
  stripe_account_id: string;
  livemode: boolean;
  success: boolean;
  error?: string;
  skipped?: boolean;
}

// =============================================================================
// AES-256-GCM Encryption (compatible with backend/lib/crypto.ts)
// =============================================================================

interface EncryptedPayload {
  v: number;
  iv: string;
  data: string;
  tag: string;
}

const CURRENT_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getEncryptionKey(): Uint8Array {
  const keyHex = Deno.env.get("ENCRYPTION_KEY");
  if (!keyHex) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }
  if (keyHex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes (64 hex characters)");
  }
  return hexToBytes(keyHex);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encrypt(plaintext: string): Promise<string> {
  const keyBytes = getEncryptionKey();
  const key = await importKey(keyBytes);

  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // Encrypt
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
    key,
    data
  );

  // The encrypted result includes the auth tag at the end
  const encryptedBytes = new Uint8Array(encrypted);
  const ciphertext = encryptedBytes.slice(0, -TAG_LENGTH);
  const tag = encryptedBytes.slice(-TAG_LENGTH);

  const payload: EncryptedPayload = {
    v: CURRENT_VERSION,
    iv: bytesToBase64(iv),
    data: bytesToBase64(ciphertext),
    tag: bytesToBase64(tag),
  };

  return JSON.stringify(payload);
}

async function decrypt(encryptedJson: string): Promise<string> {
  const keyBytes = getEncryptionKey();
  const key = await importKey(keyBytes);

  let payload: EncryptedPayload;
  try {
    payload = JSON.parse(encryptedJson);
  } catch {
    throw new Error("Invalid encrypted payload: not valid JSON");
  }

  if (payload.v !== CURRENT_VERSION) {
    throw new Error(`Unsupported encryption version: ${payload.v}`);
  }

  if (!payload.iv || !payload.data || !payload.tag) {
    throw new Error("Invalid encrypted payload: missing required fields");
  }

  const iv = base64ToBytes(payload.iv);
  const data = base64ToBytes(payload.data);
  const tag = base64ToBytes(payload.tag);

  if (iv.length !== IV_LENGTH) {
    throw new Error("Invalid encrypted payload: incorrect IV length");
  }

  if (tag.length !== TAG_LENGTH) {
    throw new Error("Invalid encrypted payload: incorrect tag length");
  }

  // Combine ciphertext and tag for Web Crypto API
  const combined = new Uint8Array(data.length + tag.length);
  combined.set(data);
  combined.set(tag, data.length);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
      key,
      combined
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch {
    throw new Error(
      "Decryption failed: invalid ciphertext or authentication tag"
    );
  }
}

// =============================================================================
// Stripe Token Refresh
// =============================================================================

function getStripeSecretKey(livemode: boolean): string {
  const key = livemode
    ? Deno.env.get("STRIPE_SECRET_KEY_LIVE")
    : Deno.env.get("STRIPE_SECRET_KEY_TEST");

  if (!key) {
    throw new Error(
      `Missing STRIPE_SECRET_KEY_${livemode ? "LIVE" : "TEST"} environment variable`
    );
  }

  return key;
}

function isRefreshError(
  response: RefreshTokenResponse | RefreshTokenError
): response is RefreshTokenError {
  return "error" in response;
}

async function refreshAccessToken(
  refreshToken: string,
  livemode: boolean
): Promise<RefreshTokenResponse> {
  const secretKey = getStripeSecretKey(livemode);

  const response = await fetch(STRIPE_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(secretKey + ":")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const result = (await response.json()) as
    | RefreshTokenResponse
    | RefreshTokenError;

  if (isRefreshError(result)) {
    throw new Error(
      `Token refresh failed: ${result.error} - ${result.error_description}`
    );
  }

  return result;
}

// =============================================================================
// Database Operations
// =============================================================================

function createSupabaseClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(supabaseUrl, supabaseKey);
}

async function getExpiringConnections(
  supabase: ReturnType<typeof createClient>,
  forceAll: boolean
): Promise<StoredConnection[]> {
  let query = supabase
    .from("stripe_oauth_connections")
    .select(
      "stripe_account_id, livemode, scope, access_token_enc, access_token_expires_at, refresh_token_enc"
    );

  if (!forceAll) {
    // Only get connections expiring within threshold
    const thresholdDate = new Date(
      Date.now() + REFRESH_THRESHOLD_MINUTES * 60 * 1000
    );
    query = query.lte("access_token_expires_at", thresholdDate.toISOString());
  }

  query = query.limit(BATCH_SIZE);

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to query connections: ${error.message}`);
  }

  return (data as StoredConnection[]) || [];
}

async function updateConnectionTokens(
  supabase: ReturnType<typeof createClient>,
  stripeAccountId: string,
  livemode: boolean,
  accessTokenEnc: string,
  accessTokenExpiresAt: Date,
  refreshTokenEnc: string
): Promise<void> {
  const { error } = await supabase
    .from("stripe_oauth_connections")
    .update({
      access_token_enc: accessTokenEnc,
      access_token_expires_at: accessTokenExpiresAt.toISOString(),
      refresh_token_enc: refreshTokenEnc,
      refresh_token_rotated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_account_id", stripeAccountId)
    .eq("livemode", livemode);

  if (error) {
    throw new Error(`Failed to update tokens: ${error.message}`);
  }
}

// =============================================================================
// Main Refresh Logic
// =============================================================================

async function refreshConnection(
  supabase: ReturnType<typeof createClient>,
  connection: StoredConnection,
  dryRun: boolean
): Promise<RefreshResult> {
  const { stripe_account_id, livemode } = connection;
  const accountSuffix = stripe_account_id.slice(-6);

  try {
    // Decrypt refresh token
    const refreshToken = await decrypt(connection.refresh_token_enc);

    if (dryRun) {
      console.log(
        `[DRY RUN] Would refresh account ...${accountSuffix} (livemode=${livemode})`
      );
      return {
        stripe_account_id,
        livemode,
        success: true,
        skipped: true,
      };
    }

    // Refresh the token
    console.log(`Refreshing token for account ...${accountSuffix} (livemode=${livemode})`);
    const newTokens = await refreshAccessToken(refreshToken, livemode);

    // Calculate new expiry
    const expiresInSeconds =
      newTokens.expires_in || DEFAULT_TOKEN_EXPIRY_SECONDS;
    const newExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    // Encrypt new tokens
    const newAccessTokenEnc = await encrypt(newTokens.access_token);
    const newRefreshTokenEnc = await encrypt(newTokens.refresh_token);

    // Update the database
    await updateConnectionTokens(
      supabase,
      stripe_account_id,
      livemode,
      newAccessTokenEnc,
      newExpiresAt,
      newRefreshTokenEnc
    );

    console.log(
      `Successfully refreshed token for account ...${accountSuffix} (livemode=${livemode})`
    );

    return {
      stripe_account_id,
      livemode,
      success: true,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error(
      `Failed to refresh token for account ...${accountSuffix} (livemode=${livemode}): ${errorMessage}`
    );

    return {
      stripe_account_id,
      livemode,
      success: false,
      error: errorMessage,
    };
  }
}

async function processInBatches(
  supabase: ReturnType<typeof createClient>,
  connections: StoredConnection[],
  dryRun: boolean
): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];

  // Process in chunks with limited concurrency
  for (let i = 0; i < connections.length; i += CONCURRENCY_LIMIT) {
    const batch = connections.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map((conn) => refreshConnection(supabase, conn, dryRun))
    );
    results.push(...batchResults);
  }

  return results;
}

// =============================================================================
// Request Handler
// =============================================================================

Deno.serve(async (req: Request) => {
  // Only allow POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Authentication is handled by Supabase's built-in JWT verification
  // The function will only be called if a valid anon/service_role key is provided

  try {
    // Parse request body
    let body: RequestBody = {};
    try {
      const text = await req.text();
      if (text) {
        body = JSON.parse(text);
      }
    } catch {
      // Empty or invalid body is fine, use defaults
    }

    const dryRun = body.dry_run === true;
    const forceAll = body.force_all === true;
    const triggeredBy = body.triggered_by || "manual";

    console.log(
      `Token sweeper started: triggered_by=${triggeredBy}, dry_run=${dryRun}, force_all=${forceAll}`
    );

    // Create Supabase client
    const supabase = createSupabaseClient();

    // Get connections to refresh
    const connections = await getExpiringConnections(supabase, forceAll);

    if (connections.length === 0) {
      console.log("No tokens need refreshing");
      return new Response(
        JSON.stringify({
          success: true,
          message: "No tokens need refreshing",
          stats: {
            total: 0,
            refreshed: 0,
            failed: 0,
            skipped: 0,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    console.log(`Found ${connections.length} connection(s) to refresh`);

    // Process all connections
    const results = await processInBatches(supabase, connections, dryRun);

    // Summarize results
    const stats = {
      total: results.length,
      refreshed: results.filter((r) => r.success && !r.skipped).length,
      failed: results.filter((r) => !r.success).length,
      skipped: results.filter((r) => r.skipped).length,
    };

    const failedAccounts = results
      .filter((r) => !r.success)
      .map((r) => ({
        account_suffix: r.stripe_account_id.slice(-6),
        livemode: r.livemode,
        error: r.error,
      }));

    console.log(
      `Token sweeper complete: total=${stats.total}, refreshed=${stats.refreshed}, failed=${stats.failed}, skipped=${stats.skipped}`
    );

    return new Response(
      JSON.stringify({
        success: stats.failed === 0,
        message: dryRun
          ? "Dry run complete"
          : `Refreshed ${stats.refreshed} token(s)`,
        stats,
        failed: failedAccounts.length > 0 ? failedAccounts : undefined,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error(`Token sweeper error: ${errorMessage}`);

    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});


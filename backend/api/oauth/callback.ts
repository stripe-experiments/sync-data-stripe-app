/**
 * OAuth Callback Endpoint
 * 
 * Handles the OAuth callback from Stripe after the merchant authorizes.
 * Validates the state, exchanges the code for tokens, encrypts and stores them.
 * 
 * Route: GET /api/oauth/callback?code=xxx&state=yyy
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sha256, encrypt } from '../../lib/crypto';
import { consumeOAuthState, upsertOAuthConnection } from '../../lib/db';
import type { StripeTokenResponse, StripeOAuthError, OAuthMode } from '../../lib/types';

/**
 * Stripe token exchange endpoint
 */
const STRIPE_TOKEN_URL = 'https://api.stripe.com/v1/oauth/token';

/**
 * Default token expiry in seconds (1 hour) if not provided by Stripe
 */
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600;

/**
 * Get the appropriate secret key for the mode
 */
function getSecretKey(mode: OAuthMode): string | undefined {
  return mode === 'live'
    ? process.env.STRIPE_SECRET_KEY_LIVE
    : process.env.STRIPE_SECRET_KEY_TEST;
}

/**
 * Get the appropriate client ID for the mode
 */
function getClientId(mode: OAuthMode): string | undefined {
  return mode === 'live'
    ? process.env.STRIPE_APP_CLIENT_ID_LIVE
    : process.env.STRIPE_APP_CLIENT_ID_TEST;
}

/**
 * Determine the OAuth mode from the account_id in the callback URL.
 * Stripe includes account_id in the callback - if it contains "test", use test mode.
 */
function detectModeFromAccountId(accountId: string | undefined): OAuthMode {
  if (accountId && accountId.toLowerCase().includes('test')) {
    return 'test';
  }
  return 'live';
}

/**
 * Exchange code for tokens using the detected mode.
 * This is used for direct Stripe App installs where we don't have state.
 */
async function exchangeWithDetectedMode(
  code: string,
  accountId: string | undefined
): Promise<{
  mode: OAuthMode;
  response: StripeTokenResponse;
} | null> {
  // Detect mode from account_id (if it contains "test", use test key)
  const detectedMode = detectModeFromAccountId(accountId);
  console.log(`Mode detection: accountId=${accountId}, detectedMode=${detectedMode}`);
  
  const secretKey = detectedMode === 'test'
    ? process.env.STRIPE_SECRET_KEY_TEST
    : process.env.STRIPE_SECRET_KEY_LIVE;
  
  if (!secretKey) {
    console.error(`Missing STRIPE_SECRET_KEY_${detectedMode.toUpperCase()}`);
    return null;
  }
  
  const response = await exchangeCodeForTokens(code, secretKey);
  if (!isOAuthError(response)) {
    return { mode: detectedMode, response };
  }
  
  console.error(`Token exchange failed for detected mode ${detectedMode}: ${response.error} - ${response.error_description}`);
  return null;
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
  code: string,
  secretKey: string
): Promise<StripeTokenResponse | StripeOAuthError> {
  const secretKeyMode =
    secretKey?.startsWith('sk_live') ? 'live' :
    secretKey?.startsWith('sk_test') ? 'test' :
    'unknown';
  const safeCodeLength = typeof code === 'string' ? code.length : 0;
  console.log(`Token exchange starting: keyMode=${secretKeyMode}, codeLength=${safeCodeLength}`);
  
  try {
    // User evidence: "only passed in this" (code + grant_type). 
    // Sending client_id might be causing the 500s if mismatched.
    const requestBody = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      // client_id removed as per user request/evidence
    });
    
    console.log(`Token exchange request: url=${STRIPE_TOKEN_URL}, grant_type=authorization_code, codeLength=${safeCodeLength}`);
    
    const response = await fetch(STRIPE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(secretKey + ':').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: requestBody,
    });
    
    const stripeRequestId = response.headers.get('request-id') || undefined;

    // Log response headers for 500 errors
    if (response.status === 500) {
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      console.log(`500 response headers:`, JSON.stringify({
        'request-id': headers['request-id'],
        'stripe-version': headers['stripe-version'],
        'stripe-should-retry': headers['stripe-should-retry'],
        'x-stripe-routing-context-priority-tier': headers['x-stripe-routing-context-priority-tier'],
      }));
    }
    
    const responseText = await response.text();
    const responseTextTrimmed = responseText?.trim() ?? '';
    const isEmptyBody = responseTextTrimmed === '' || responseTextTrimmed === '{}' ;
    console.log(`Token exchange response: status=${response.status}, requestId=${stripeRequestId || 'unknown'}, bodyLength=${responseText?.length ?? 0}`);
    
    // Handle empty response body
    if (isEmptyBody) {
      console.error(`Empty or invalid response from Stripe: status=${response.status}`);
      return { error: 'empty_response', error_description: `Stripe returned status ${response.status} with empty body` } as StripeOAuthError;
    }
    
    let jsonResponse: StripeTokenResponse | StripeOAuthError;
    try {
      jsonResponse = JSON.parse(responseText) as StripeTokenResponse | StripeOAuthError;
    } catch (parseError) {
      console.error(`Failed to parse response as JSON (status=${response.status}, requestId=${stripeRequestId || 'unknown'})`);
      return { error: 'parse_error', error_description: 'Failed to parse Stripe response' } as StripeOAuthError;
    }
    
    // Log non-200 responses for debugging
    if (!response.ok) {
      const err = jsonResponse as StripeOAuthError;
      console.error(`Stripe token exchange failed: status=${response.status}, requestId=${stripeRequestId || 'unknown'}, error=${err.error}, description=${err.error_description}`);
      return jsonResponse;
    }

    // Success path: DO NOT log tokens.
    const tokenResponse = jsonResponse as StripeTokenResponse;
    const safeStripeUserIdSuffix = tokenResponse.stripe_user_id ? tokenResponse.stripe_user_id.slice(-6) : undefined;
    console.log(`Token exchange success: requestId=${stripeRequestId || 'unknown'}, livemode=${tokenResponse.livemode}, stripeUserIdSuffix=${safeStripeUserIdSuffix || 'unknown'}`);
    
    return jsonResponse;
  } catch (fetchError) {
    console.error(`Token exchange fetch error:`, fetchError);
    return { error: 'fetch_error', error_description: String(fetchError) } as StripeOAuthError;
  }
}

/**
 * Check if response is an error or invalid
 * A valid success response must have access_token, refresh_token, and stripe_user_id
 */
function isOAuthError(response: StripeTokenResponse | StripeOAuthError): response is StripeOAuthError {
  // Explicit error from Stripe
  if ('error' in response) {
    return true;
  }
  // Invalid/empty response (e.g., from a 500 error)
  const tokenResponse = response as StripeTokenResponse;
  if (!tokenResponse.access_token || !tokenResponse.refresh_token || !tokenResponse.stripe_user_id) {
    return true;
  }
  return false;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate success HTML page
 */
function getSuccessHtml(stripeAccountId: string, livemode: boolean): string {
  const mode = livemode ? 'Live' : 'Test';
  const modeClass = livemode ? 'live' : 'test';
  const safeStripeAccountId = escapeHtml(stripeAccountId);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connected — Ready to sync</title>
  <style>
    :root {
      --accent: #635bff;
      --accent-hover: #5851db;
      --accent-soft: rgba(99, 91, 255, 0.12);

      --text: #0a2540;
      --text-muted: #425466;
      --bg: #ffffff;
      --surface: #ffffff;
      --surface-subtle: #f6f9fc;
      --border: #e6ebf1;

      --radius-lg: 16px;
      --radius-md: 8px;

      --shadow: 0 12px 28px rgba(50, 50, 93, 0.08), 0 2px 6px rgba(0, 0, 0, 0.06);
      --focus-ring: 0 0 0 4px rgba(99, 91, 255, 0.25);

      --success: #00d4aa;
      --success-soft: rgba(0, 212, 170, 0.12);
      --success-border: rgba(0, 212, 170, 0.22);

      --warn: #b45309;
      --warn-soft: rgba(255, 187, 0, 0.16);
      --warn-border: rgba(255, 187, 0, 0.28);
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; }

    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
        Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif;
      color: var(--text);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
    }

    .page {
      min-height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .card {
      width: 100%;
      max-width: 560px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .content {
      padding: 32px;
    }

    .header {
      display: flex;
      gap: 14px;
      align-items: flex-start;
      margin-bottom: 18px;
    }

    .icon {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: var(--success-soft);
      border: 1px solid var(--success-border);
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }

    .icon svg {
      width: 22px;
      height: 22px;
      stroke: var(--success);
      stroke-width: 2.5;
    }

    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.25;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--text);
    }

    .subtitle {
      margin: 6px 0 0;
      font-size: 14px;
      line-height: 1.55;
      color: var(--text-muted);
    }

    .details {
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 14px 14px;
      margin-top: 18px;
    }

    .detail-row {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
      align-items: center;
    }

    .detail-row:last-child { border-bottom: none; }

    .detail-label {
      color: var(--text-muted);
      font-size: 13px;
    }

    .detail-value {
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
      text-align: right;
      word-break: break-all;
    }

    .mode-pill {
      display: inline-block;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
        Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif;
      font-weight: 800;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 999px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }

    .mode-pill.live {
      background: var(--success-soft);
      border: 1px solid var(--success-border);
      color: #027a63;
    }

    .mode-pill.test {
      background: var(--warn-soft);
      border: 1px solid var(--warn-border);
      color: var(--warn);
    }

    .actions {
      margin-top: 18px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 12px;
      min-height: 36px;
      background: var(--accent);
      border: 1px solid var(--accent);
      color: #ffffff;
      text-decoration: none;
      border-radius: var(--radius-md);
      font-size: 14px;
      font-weight: 700;
      transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
      -webkit-tap-highlight-color: transparent;
    }

    .btn:hover {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }

    .btn:focus { outline: none; }
    .btn:focus-visible { box-shadow: var(--focus-ring); }

    .note {
      margin-top: 14px;
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.5;
    }

    @media (max-width: 480px) {
      .content { padding: 24px; }
    }

    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="card" role="main" aria-label="Installation successful">
      <div class="content">
        <div class="header">
          <div class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div>
            <h1>Connected — ready to sync</h1>
            <p class="subtitle">
              Next: open Stripe Data Sync in your Dashboard to enable data sync and get your Postgres
              connection string. Your data will stay up to date automatically.
            </p>
          </div>
        </div>

        <div class="details" aria-label="Connection details">
          <div class="detail-row">
            <span class="detail-label">Account</span>
            <span class="detail-value">${safeStripeAccountId}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Mode</span>
            <span class="detail-value" style="font-family: inherit; font-weight: 600;">
              <span class="mode-pill ${modeClass}">${mode}</span>
            </span>
          </div>
        </div>

        <div class="actions">
          <a class="btn" href="https://dashboard.stripe.com/apps" rel="noopener noreferrer">
            Open in Stripe Dashboard
          </a>
        </div>

        <div class="note">You can now close this window.</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Generate error HTML page
 */
function getErrorHtml(title: string, message: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    :root {
      --accent: #635bff;
      --accent-hover: #5851db;
      --accent-soft: rgba(99, 91, 255, 0.12);

      --text: #0a2540;
      --text-muted: #425466;
      --bg: #ffffff;
      --surface: #ffffff;
      --border: #e6ebf1;

      --radius-lg: 16px;
      --radius-md: 8px;

      --shadow: 0 12px 28px rgba(50, 50, 93, 0.08), 0 2px 6px rgba(0, 0, 0, 0.06);
      --focus-ring: 0 0 0 4px rgba(99, 91, 255, 0.25);

      --danger: #dc2626;
      --danger-soft: rgba(220, 38, 38, 0.10);
      --danger-border: rgba(220, 38, 38, 0.18);
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; }

    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
        Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif;
      color: var(--text);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
    }

    .page {
      min-height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .card {
      width: 100%;
      max-width: 560px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .content {
      padding: 32px;
    }

    .header {
      display: flex;
      gap: 14px;
      align-items: flex-start;
      margin-bottom: 16px;
    }

    .icon {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: var(--danger-soft);
      border: 1px solid var(--danger-border);
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }

    .icon svg {
      width: 22px;
      height: 22px;
      stroke: var(--danger);
      stroke-width: 2;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.25;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--text);
    }

    .message {
      margin: 6px 0 0;
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1.55;
    }

    .actions {
      margin-top: 18px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 12px;
      min-height: 36px;
      background: var(--accent);
      border: 1px solid var(--accent);
      color: #ffffff;
      text-decoration: none;
      border-radius: var(--radius-md);
      font-size: 14px;
      font-weight: 700;
      transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
      -webkit-tap-highlight-color: transparent;
    }

    .btn:hover {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }

    .btn:focus { outline: none; }
    .btn:focus-visible { box-shadow: var(--focus-ring); }

    @media (max-width: 480px) {
      .content { padding: 24px; }
    }

    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="card" role="main" aria-label="${safeTitle}">
      <div class="content">
        <div class="header">
          <div class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
          </div>
          <div>
            <h1>${safeTitle}</h1>
            <p class="message">${safeMessage}</p>
          </div>
        </div>

        <div class="actions">
          <a href="/install" class="btn">Try again</a>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Handler for OAuth callback
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow GET requests
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).send('Method Not Allowed');
    return;
  }
  
  // Set security headers
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  
  try {
    // Vercel runtime debug log (no secrets)
    console.log('OAuth callback entry:', JSON.stringify({
      method: req.method,
      queryKeys: Object.keys(req.query || {}),
      hasState: typeof req.query.state === 'string',
      hasCode: typeof req.query.code === 'string',
      codeLength: typeof req.query.code === 'string' ? req.query.code.length : 0,
      // Heuristic-only signals (do not rely on this as truth)
      accountIdHasTest: typeof (req.query as any).account_id === 'string'
        ? String((req.query as any).account_id).includes('test')
        : undefined,
      stripeUserIdHasTest: typeof (req.query as any).stripe_user_id === 'string'
        ? String((req.query as any).stripe_user_id).includes('test')
        : undefined,
    }));

    // Check for error response from Stripe
    const { error, error_description } = req.query;
    if (error) {
      console.error(`OAuth error from Stripe: ${error} - ${error_description}`);
      res.status(400).send(getErrorHtml(
        'Authorization Denied',
        String(error_description || 'The authorization was denied or cancelled.')
      ));
      return;
    }
    
    // Extract code and state from query params
    const { code, state } = req.query;
    
    if (!code || typeof code !== 'string') {
      res.status(400).send(getErrorHtml(
        'Missing Authorization Code',
        'The authorization code was not provided. Please try again.'
      ));
      return;
    }
    
    let tokenResponse: StripeTokenResponse;
    
    // Check if this is a state-based flow (from our /install page) or a direct Stripe App install
    if (state && typeof state === 'string') {
      console.log('OAuth callback: state-based flow (from /install)');
      // State-based flow: validate state and use the stored mode
      const stateHash = sha256(state);
      const mode = await consumeOAuthState(stateHash);
      
      if (!mode) {
        console.error('Invalid or expired OAuth state');
        res.status(403).send(getErrorHtml(
          'Invalid or Expired Request',
          'This authorization request has expired or is invalid. Please start the installation again.'
        ));
        return;
      }
      
      // Get the appropriate secret key and client ID for the mode
      const secretKey = getSecretKey(mode);
      const clientId = getClientId(mode);
      console.log(`OAuth callback (state-based): resolved mode=${mode}, hasSecretKey=${!!secretKey}, hasClientId=${!!clientId}`);
      
      if (!secretKey) {
        console.error(`Missing STRIPE_SECRET_KEY_${mode.toUpperCase()} environment variable`);
        res.status(500).send(getErrorHtml(
          'Configuration Error',
          'Server is not properly configured. Please contact support.'
        ));
        return;
      }
      
      if (!clientId) {
        console.error(`Missing STRIPE_APP_CLIENT_ID_${mode.toUpperCase()} environment variable`);
        res.status(500).send(getErrorHtml(
          'Configuration Error',
          'Server is not properly configured. Please contact support.'
        ));
        return;
      }
      
      // Exchange code for tokens (simplified: no clientId needed)
      const response = await exchangeCodeForTokens(code, secretKey);
      
      if (isOAuthError(response)) {
        console.error(`Token exchange error: ${response.error} - ${response.error_description}`);
        res.status(400).send(getErrorHtml(
          'Token Exchange Failed',
          response.error_description || 'Failed to exchange authorization code for tokens.'
        ));
        return;
      }
      
      tokenResponse = response;
      console.log(`OAuth callback (state-based): mode=${mode}`);
      
    } else {
      // Direct Stripe App install: no state provided
      // This happens when users install through the Stripe Dashboard/Marketplace
      // Use account_id from callback URL to determine test vs live mode
      const accountId = typeof req.query.account_id === 'string' ? req.query.account_id : undefined;
      console.log('OAuth callback: Direct Stripe App install (no state), using account_id to detect mode...');
      console.log('Direct install env presence:', JSON.stringify({
        hasTestSecretKey: !!process.env.STRIPE_SECRET_KEY_TEST,
        hasLiveSecretKey: !!process.env.STRIPE_SECRET_KEY_LIVE,
        accountId: accountId,
      }));
      
      const result = await exchangeWithDetectedMode(code, accountId);
      
      if (!result) {
        console.error('Failed to exchange code with both test and live keys');
        res.status(400).send(getErrorHtml(
          'Token Exchange Failed',
          'Failed to exchange authorization code for tokens. Please try again or contact support.'
        ));
        return;
      }
      
      tokenResponse = result.response;
      console.log(`OAuth callback (direct install): mode=${result.mode}, livemode=${tokenResponse.livemode}`);
    }
    
    // Calculate token expiry
    const expiresInSeconds = tokenResponse.expires_in || DEFAULT_TOKEN_EXPIRY_SECONDS;
    const accessTokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    
    // Encrypt tokens
    const accessTokenEnc = encrypt(tokenResponse.access_token);
    const refreshTokenEnc = encrypt(tokenResponse.refresh_token);
    
    // Store the connection
    await upsertOAuthConnection({
      stripeAccountId: tokenResponse.stripe_user_id,
      livemode: tokenResponse.livemode,
      scope: tokenResponse.scope,
      stripePublishableKey: tokenResponse.stripe_publishable_key,
      accessTokenEnc,
      accessTokenExpiresAt,
      refreshTokenEnc,
    });
    
    // Log success (never log tokens)
    console.log(`OAuth connection stored: account=${tokenResponse.stripe_user_id}, livemode=${tokenResponse.livemode}`);
    
    // Return success page
    res.status(200).send(getSuccessHtml(tokenResponse.stripe_user_id, tokenResponse.livemode));
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send(getErrorHtml(
      'Unexpected Error',
      'An unexpected error occurred during installation. Please try again.'
    ));
  }
}


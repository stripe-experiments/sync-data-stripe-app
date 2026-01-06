/**
 * OAuth Install Endpoint
 * 
 * Initiates the OAuth flow by generating a CSRF state, storing its hash,
 * and redirecting to Stripe's OAuth authorization endpoint.
 * 
 * Route: GET /api/oauth/install?mode=test|live
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { generateRandomState, sha256 } from '../../lib/crypto';
import { insertOAuthState } from '../../lib/db';
import type { OAuthMode } from '../../lib/types';

/**
 * Stripe OAuth authorize URL
 */
const STRIPE_AUTHORIZE_URL = 'https://marketplace.stripe.com/oauth/v2/authorize';

/**
 * State TTL in minutes
 */
const STATE_TTL_MINUTES = 10;

/**
 * Build the Stripe OAuth authorization URL
 */
function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(STRIPE_AUTHORIZE_URL);
  
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  
  // Response type is implicit for Stripe Apps OAuth (authorization code flow)
  // Scope is determined by the app's manifest permissions
  
  return url.toString();
}

/**
 * Validate and parse the mode parameter
 */
function parseMode(modeParam: unknown): OAuthMode {
  if (modeParam === 'test') {
    return 'test';
  }
  // Default to live mode
  return 'live';
}

/**
 * Get the appropriate client ID for the mode
 * Stripe Apps have separate client IDs for test and live modes
 */
function getClientId(mode: OAuthMode): string | undefined {
  return mode === 'live'
    ? process.env.STRIPE_APP_CLIENT_ID_LIVE
    : process.env.STRIPE_APP_CLIENT_ID_TEST;
}

function getInstallErrorHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Couldn’t start sync setup</title>
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
      max-width: 520px;
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
      border: 1px solid rgba(220, 38, 38, 0.18);
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }

    .icon svg {
      width: 22px;
      height: 22px;
      stroke: var(--danger);
    }

    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.25;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--text);
    }

    p {
      margin: 6px 0 0;
      font-size: 14px;
      line-height: 1.55;
      color: var(--text-muted);
    }

    .actions {
      margin-top: 18px;
    }

    .link {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      min-height: 36px;
      border-radius: var(--radius-md);
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      color: var(--accent);
      border: 1px solid rgba(99, 91, 255, 0.22);
      background: rgba(99, 91, 255, 0.06);
      transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
      -webkit-tap-highlight-color: transparent;
    }

    .link:hover {
      border-color: rgba(99, 91, 255, 0.35);
    }

    .link:focus { outline: none; }
    .link:focus-visible { box-shadow: var(--focus-ring); }

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
    <div class="card" role="main" aria-label="Installation Error">
      <div class="content">
        <div class="header">
          <div class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <circle cx="12" cy="16" r="1"></circle>
            </svg>
          </div>
          <div>
            <h1>Couldn’t start sync setup</h1>
            <p>We hit an error while starting the connection flow. Please try again.</p>
          </div>
        </div>

        <div class="actions">
          <a class="link" href="/install">← Back to install page</a>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Handler for OAuth install initiation
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  try {
    // Parse mode from query parameter
    const mode = parseMode(req.query.mode);
    
    // Get the appropriate client ID for this mode
    const clientId = getClientId(mode);
    const baseUrl = process.env.BASE_URL;
    
    if (!clientId) {
      console.error(`Missing STRIPE_APP_CLIENT_ID_${mode.toUpperCase()} environment variable`);
      res.status(500).send('Server configuration error');
      return;
    }
    
    if (!baseUrl) {
      console.error('Missing BASE_URL environment variable');
      res.status(500).send('Server configuration error');
      return;
    }
    
    // Generate cryptographically secure random state
    const state = generateRandomState();
    
    // Hash the state before storing (defense in depth)
    const stateHash = sha256(state);
    
    // Store the hashed state with TTL
    await insertOAuthState(stateHash, mode, STATE_TTL_MINUTES);
    
    // Build the redirect URI
    const redirectUri = `${baseUrl}/api/oauth/callback`;
    
    // Build the authorization URL
    const authorizeUrl = buildAuthorizeUrl({
      clientId,
      redirectUri,
      state
    });
    
    // Log for debugging (never log the actual state value in production)
    console.log(`OAuth install initiated: mode=${mode}, redirectUri=${redirectUri}`);
    
    // Redirect to Stripe OAuth
    res.redirect(302, authorizeUrl);
    
  } catch (error) {
    console.error('OAuth install error:', error);
    
    // Return a user-friendly error page
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(500).send(getInstallErrorHtml());
  }
}


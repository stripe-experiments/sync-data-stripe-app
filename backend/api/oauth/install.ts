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
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Installation Error</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: #f6f9fc;
          }
          .error-container {
            background: white;
            padding: 48px;
            border-radius: 8px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            text-align: center;
            max-width: 400px;
          }
          h1 { color: #e53e3e; margin-bottom: 16px; }
          p { color: #697386; line-height: 1.6; }
          a {
            display: inline-block;
            margin-top: 24px;
            color: #635bff;
            text-decoration: none;
          }
          a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="error-container">
          <h1>Installation Error</h1>
          <p>We encountered an error while starting the installation process. Please try again.</p>
          <a href="/install">← Back to Install Page</a>
        </div>
      </body>
      </html>
    `);
  }
}


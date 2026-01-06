/**
 * Marketplace Install Page
 * 
 * This endpoint serves the public install page required for Stripe Marketplace review.
 * It provides buttons to initiate OAuth installation in test or live mode.
 * 
 * Route: GET /install (via rewrite) or GET /api/install
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * HTML template for the install page
 */
function getInstallPageHtml(baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sync your Stripe data</title>
  <link rel="icon" type="image/png" href="/icon.png">
  <link rel="apple-touch-icon" href="/icon.png">
  <style>
    :root {
      /* Stripe-ish neutrals + accent */
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
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      height: 100%;
    }

    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
        Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Apple Color Emoji', 'Segoe UI Emoji',
        sans-serif;
      color: var(--text);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
    }

    a {
      color: inherit;
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
      padding: 36px;
    }

    .header {
      display: flex;
      gap: 14px;
      align-items: flex-start;
      margin-bottom: 22px;
    }

    .logo {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      overflow: hidden;
      flex: 0 0 auto;
    }

    .logo img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.25;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--text);
    }

    .subtitle {
      margin: 6px 0 0;
      font-size: 15px;
      line-height: 1.55;
      color: var(--text-muted);
    }

    .buttons {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 22px;
    }

    .btn {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 12px;
      min-height: 36px;
      border-radius: var(--radius-md);
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      border: 1px solid transparent;
      transition: box-shadow 0.2s ease, background 0.2s ease, border-color 0.2s ease;
      -webkit-tap-highlight-color: transparent;
    }

    .btn-left {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .btn:focus {
      outline: none;
    }

    .btn:focus-visible {
      box-shadow: var(--focus-ring);
    }

    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }

    .btn-primary:hover {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }

    .btn-secondary {
      background: var(--surface);
      border-color: var(--border);
      color: var(--text);
    }

    .btn-secondary:hover {
      border-color: rgba(99, 91, 255, 0.35);
    }

    .badge {
      flex: 0 0 auto;
      font-size: 12px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 999px;
      border: 1px solid rgba(99, 91, 255, 0.22);
      background: rgba(99, 91, 255, 0.08);
      color: var(--accent);
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }

    .fineprint {
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.55;
    }

    .fineprint a {
      color: var(--accent);
      text-decoration: none;
    }

    .fineprint a:hover {
      text-decoration: underline;
    }

    @media (max-width: 480px) {
      .content {
        padding: 24px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      * {
        transition: none !important;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="card" role="main" aria-label="Install Sync Stripe App">
      <div class="content">
        <div class="header">
          <div class="logo" aria-hidden="true">
            <img src="/icon.png" alt="" />
          </div>
          <div>
            <h1>Sync your Stripe data</h1>
            <p class="subtitle">
              Keep customers, subscriptions, invoices, and more up to date automatically. When you
              enable data sync in the app, we’ll create a Postgres database and share a connection
              string.
            </p>
          </div>
        </div>

        <div class="buttons" aria-label="Choose install mode">
          <a href="${baseUrl}/api/oauth/install?mode=live" class="btn btn-primary">
            <span class="btn-left">
              <span>Sync live data</span>
            </span>
            <span class="badge">Live</span>
          </a>

          <a href="${baseUrl}/api/oauth/install?mode=test" class="btn btn-secondary">
            <span class="btn-left">
              <span>Sync test data</span>
            </span>
            <span class="badge">Test</span>
          </a>
        </div>

        <div class="fineprint">
          <div>
            By continuing, you authorize Sync Stripe App to access your Stripe account data and keep
            it synced automatically.
          </div>
          <div style="margin-top: 10px;">
            <a href="https://stripe.com/docs/stripe-apps" target="_blank" rel="noopener noreferrer">
              Learn more about Stripe Apps →
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Handler for the install page
 */
export default function handler(
  req: VercelRequest,
  res: VercelResponse
): void {
  // Only allow GET requests
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).send('Method Not Allowed');
    return;
  }
  
  // Get base URL from environment or construct from request
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
  
  // Set security headers
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Send the install page
  res.status(200).send(getInstallPageHtml(baseUrl));
}


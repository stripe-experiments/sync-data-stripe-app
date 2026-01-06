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
  <title>Install Sync Stripe App</title>
  <style>
    :root {
      --stripe-purple: #635bff;
      --stripe-purple-dark: #5851db;
      --stripe-green: #00d4aa;
      --stripe-yellow: #ffbb00;
      --text-primary: #1a1f36;
      --text-secondary: #697386;
      --bg-light: #f6f9fc;
      --border-color: #e6ebf1;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 30px 60px rgba(0, 0, 0, 0.12);
      max-width: 480px;
      width: 100%;
      padding: 48px;
      text-align: center;
    }
    
    .logo {
      width: 64px;
      height: 64px;
      background: var(--stripe-purple);
      border-radius: 16px;
      margin: 0 auto 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .logo svg {
      width: 36px;
      height: 36px;
    }
    
    h1 {
      color: var(--text-primary);
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    
    .subtitle {
      color: var(--text-secondary);
      font-size: 16px;
      line-height: 1.6;
      margin-bottom: 32px;
    }
    
    .buttons {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 16px 24px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.2s ease;
      border: none;
      cursor: pointer;
    }
    
    .btn-primary {
      background: var(--stripe-purple);
      color: white;
    }
    
    .btn-primary:hover {
      background: var(--stripe-purple-dark);
      transform: translateY(-1px);
      box-shadow: 0 7px 14px rgba(50, 50, 93, 0.1), 0 3px 6px rgba(0, 0, 0, 0.08);
    }
    
    .btn-secondary {
      background: var(--bg-light);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
    }
    
    .btn-secondary:hover {
      background: #edf2f7;
      transform: translateY(-1px);
    }
    
    .btn svg {
      margin-right: 8px;
    }
    
    .mode-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      margin-left: 8px;
      text-transform: uppercase;
    }
    
    .mode-live {
      background: #dcfce7;
      color: #166534;
    }
    
    .mode-test {
      background: #fef3c7;
      color: #92400e;
    }
    
    .info {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid var(--border-color);
    }
    
    .info p {
      color: var(--text-secondary);
      font-size: 14px;
      line-height: 1.6;
    }
    
    .info a {
      color: var(--stripe-purple);
      text-decoration: none;
    }
    
    .info a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
        <polyline points="22,6 12,13 2,6"/>
      </svg>
    </div>
    
    <h1>Connect Your Stripe Account</h1>
    <p class="subtitle">
      Install Sync Stripe App to securely connect your Stripe account and enable data synchronization.
    </p>
    
    <div class="buttons">
      <a href="${baseUrl}/api/oauth/install?mode=live" class="btn btn-primary">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        Install for Live Mode
        <span class="mode-badge mode-live">Live</span>
      </a>
      
      <a href="${baseUrl}/api/oauth/install?mode=test" class="btn btn-secondary">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
        Install for Test Mode
        <span class="mode-badge mode-test">Test</span>
      </a>
    </div>
    
    <div class="info">
      <p>
        By installing, you authorize Sync Stripe App to access your Stripe account data.
        <br><br>
        <a href="https://stripe.com/docs/stripe-apps" target="_blank" rel="noopener">Learn more about Stripe Apps →</a>
      </p>
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


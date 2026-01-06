## Backend (`backend/`)

Vercel Functions that handle:

- Stripe App OAuth (install + callback)
- issuing Stripe SDK clients with automatic token refresh
- provisioning per-merchant Supabase databases and tracking progress

### Run locally

```bash
cd backend
cp env.example .env.local
npm install
vercel dev
```

### Environment variables (summary)

- **Stripe**: `STRIPE_APP_CLIENT_ID_TEST`, `STRIPE_APP_CLIENT_ID_LIVE`, `STRIPE_SECRET_KEY_TEST`, `STRIPE_SECRET_KEY_LIVE`
- **App**: `BASE_URL`
- **Security**: `ENCRYPTION_KEY`, `STRIPE_APP_SIGNING_SECRET`
- **Database (central Postgres)**: `DATABASE_URL`
- **Provisioning (Supabase Management API)**: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_ORGANIZATION_ID` (optional: `SUPABASE_REGION`)

### Authentication

All `/api/db/*` endpoints require a `Stripe-Signature` header from the UI extension (via `fetchStripeSignature()`). The backend verifies this signature using the app's signing secret (`STRIPE_APP_SIGNING_SECRET`), which cryptographically binds requests to the signed-in Stripe Dashboard user and account.

To get your signing secret:
1. Go to Dashboard → Developers → Apps → Your App
2. Click the overflow menu (⋯) → Signing secret
3. Copy the `absec_...` value

**Secret rotation**: To rotate your signing secret without downtime, set both the new and old secrets comma-separated (e.g., `absec_new,absec_old`). Both will be valid during the rotation period (up to 24 hours).

### Database schema

Apply `db/schema.sql` to the Postgres referenced by `DATABASE_URL`.

### Deploy

```bash
cd backend
vercel --prod
```



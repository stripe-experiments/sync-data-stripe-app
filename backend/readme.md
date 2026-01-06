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
- **Security**: `ENCRYPTION_KEY`
- **Database (central Postgres)**: `DATABASE_URL`
- **Provisioning (Supabase Management API)**: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_ORGANIZATION_ID` (optional: `SUPABASE_REGION`)

### Database schema

Apply `db/schema.sql` to the Postgres referenced by `DATABASE_URL`.

### Deploy

```bash
cd backend
vercel --prod
```



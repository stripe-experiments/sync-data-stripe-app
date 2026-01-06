## supabase-management

Scheduled token refresh for stored Stripe OAuth connections using Supabase `pg_cron` + `pg_net` calling an Edge Function (`token-sweeper`).

### What’s here

- **`supabase/functions/token-sweeper/`**: refreshes expiring OAuth tokens and writes rotated tokens back encrypted (uses `ENCRYPTION_KEY`).
- **`sql/`**: enables `pg_cron`/`pg_net` and schedules the HTTP call to the function.
- **`scripts/`**: deploy + smoke test helpers.

### Setup

```bash
cd supabase-management
cp env.example .env
```

Fill in .env values (SUPABASE_*, STRIPE_*, ENCRYPTION_KEY, TOKEN_SWEEPER_SECRET)

### Deploy (Edge Function + secrets + cron SQL output)

```bash
cd supabase-management
./scripts/deploy.sh
```

This generates `sql/schedule_token_sweeper_configured.sql` (contains secrets; do not commit).

### Enable extensions + schedule the cron job

Run in your Supabase SQL editor:

- `sql/enable_extensions.sql`
- `sql/schedule_token_sweeper_configured.sql` (or fill placeholders in `sql/schedule_token_sweeper.sql`)

### Test the deployed function

```bash
cd supabase-management
./scripts/test-local.sh          # dry run
./scripts/test-local.sh --force  # actually refresh tokens
```
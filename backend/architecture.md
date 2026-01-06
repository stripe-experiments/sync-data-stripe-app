## Backend architecture

### HTTP surface

- **`/install`**: public marketplace landing page.
- **`/api/oauth/install`**: starts OAuth, writes a hashed `state` to `oauth_states`.
- **`/api/oauth/callback`**: validates + consumes state, exchanges code for tokens, stores encrypted tokens in `stripe_oauth_connections`.
- **`/api/db/provision`**: starts provisioning a Supabase project for the Stripe account.
- **`/api/db/status`**: returns current provisioning status (and advances the serverless “tick” state machine).

### Storage (central Postgres)

- **`oauth_states`**: CSRF state hashes with TTL.
- **`stripe_oauth_connections`**: encrypted access/refresh tokens + expiry, keyed by (`stripe_account_id`, `livemode`).
- **`provisioned_databases`**: per-account Supabase `project_ref` + encrypted DB password + status/step.

### Key modules

- **`lib/crypto.ts`**: AES-256-GCM encryption/decryption + SHA-256 helpers.
- **`lib/stripe-client.ts`**: loads tokens, refreshes if expiring soon, persists rotated refresh tokens.
- **`lib/supabase-provisioning.ts`**: creates Supabase projects and installs sync in serverless-friendly steps.
- **`lib/db.ts`**: Postgres access layer (Pool reuse for serverless).



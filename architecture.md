## System architecture

```text
Stripe merchant (Dashboard) ── installs app ──> backend (/install + OAuth)
Stripe app UI extension ── calls ──> backend (/api/db/*)

backend ↔ central Postgres (oauth_states, stripe_oauth_connections, provisioned_databases)
backend ── provisions ──> Supabase Management API ──> per-merchant Supabase project (sync target)
(optional) Supabase cron + Edge Function ── refreshes tokens in central Postgres
```

### Main flows

- **OAuth install**: `/install` → `/api/oauth/install` → Stripe OAuth → `/api/oauth/callback` → store encrypted tokens.
- **Provision database**: Stripe app UI → `/api/db/provision` → provision Supabase project + install sync → UI polls `/api/db/status` until ready.
- **Token refresh**:
  - On-demand in backend when a token is near expiry
  - Optionally via `supabase-management/` token sweeper on a schedule

### Security model (high level)

- **CSRF**: random OAuth `state`, stored as a SHA-256 hash, single-use with a short TTL.
- **Encryption at rest**: AES-256-GCM with `ENCRYPTION_KEY` for tokens (and provisioned DB passwords).
- **Refresh token rotation**: always persist the newly returned refresh token.
- **No token logging**: only non-sensitive identifiers should appear in logs.

### Where to look

- Backend details: `backend/architecture.md`
- UI details: `sync-app/architecture.md`
- Token sweeper details: `supabase-management/architecture.md`



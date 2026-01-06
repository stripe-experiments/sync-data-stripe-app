## Token sweeper architecture

`pg_cron` runs on a schedule (every 30 minutes by default) and uses `pg_net` to invoke the `token-sweeper` Edge Function.

The function:

- reads OAuth connections that are expiring soon from the central Postgres
- decrypts refresh tokens using `ENCRYPTION_KEY`
- calls Stripe’s OAuth token endpoint to refresh
- writes rotated tokens back encrypted

### Security

- Requests must include `x-token-sweeper-secret`.
- The sweeper must share the same `ENCRYPTION_KEY` as the backend.



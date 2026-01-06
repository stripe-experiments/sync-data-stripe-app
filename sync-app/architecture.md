## UI architecture

- Runs inside the Stripe Dashboard as a UI extension.
- Reads the current Stripe account id + mode from the extension context.
- Calls the backend:
  - `GET /api/db/status?account_id=...&livemode=...` (polls while provisioning)
  - `POST /api/db/provision` (start provisioning)
- Displays the provisioned database connection string once ready (with copy affordances).



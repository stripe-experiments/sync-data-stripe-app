## Stripe app UI (`sync-app/`)

Stripe CLI-generated app containing the Stripe Dashboard UI extension.

### Run locally

```bash
cd sync-app
yarn install
stripe apps start
```

### Configure the backend URL

The UI calls your backend at `API_BASE_URL` in `src/views/Home.tsx`. Update it before uploading.

### Upload

```bash
cd sync-app
stripe apps upload
```

### Manifest

Update `stripe-app.json` to point at your deployed backend:

- `post_install_action.url`: `https://<backend>/install`
- `allowed_redirect_uris`: `https://<backend>/api/oauth/callback`



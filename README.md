# Instinct Dashboard

Private status dashboard for Avi's Instinct: project areas, tasks with elapsed
time, priority selection, resolve/reopen, notes, activity log, and shared files.

- **Frontend**: static site on GitHub Pages (`index.html`, `app.js`, `auth_client.js`, `config.js`, `styles.css`). Public files, no secrets, no data.
- **Backend**: Cloudflare Worker (`worker.js`, deployed at instinct-dashboard.avishorwork.workers.dev, free tier) with a Workers KV namespace for storage. Nothing is readable without a server-verified Google sign-in (allowlist) or the API key.
- **Sign-in**: Google Identity Services ID token, verified by the backend with Google, email allowlist enforced, opaque session token (12 h TTL).
- **Agent update API**: `POST {action:"apiUpdate", apiKey, ops:[...]}` to the worker URL. Ops: `upsertProject`, `upsertTask`, `setPriority`, `resolveTask`, `reopenTask`, `note`, `log`, `registerFile`. The API key is stored in the vault ("Instinct dashboard API key") and as a Worker secret; it is never in this repo or in chat. Code updates deploy with the Cloudflare API token in the vault ("Cloudflare API token (instinct-dashboard)").

Repo is public by design (same pattern as the library kiosk site): code only, no data, no secrets.

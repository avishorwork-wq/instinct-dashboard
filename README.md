# Instinct Dashboard

Private status dashboard for Avi's Instinct: project areas, tasks with elapsed
time, priority selection, resolve/reopen, notes, activity log, and shared files.

- **Frontend**: static site on GitHub Pages (`index.html`, `app.js`, `auth_client.js`, `config.js`, `styles.css`). Public files, no secrets, no data.
- **Backend**: Google Apps Script web app (`Code.gs`), deployed under the owner's Google account. Data lives in a private Google Sheet ("Instinct Dashboard") in the owner's Drive. Nothing is readable without a server-verified Google sign-in (allowlist) or the API key.
- **Sign-in**: Google Identity Services ID token, verified by the backend with Google, email allowlist enforced, opaque session token (12 h TTL).
- **Agent update API**: `POST {action:"apiUpdate", apiKey, ops:[...]}` to the `/exec` URL. Ops: `upsertProject`, `upsertTask`, `setPriority`, `resolveTask`, `reopenTask`, `note`, `log`, `registerFile`. The API key is stored in the vault ("Instinct dashboard API key") and in the backend's Script Properties; it is never in this repo or in chat.

Repo is public by design (same pattern as the library kiosk site): code only, no data, no secrets.

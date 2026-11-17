# Afford Super Store — Attendance & Payroll

Free-to-run attendance and payroll for Afford Super Store:

| Part | Folder | Status |
|---|---|---|
| Backend: Cloudflare Worker + one SQLite Durable Object per store | `backend/` | Stage 1 ✅ |
| Admin / Manager Android app (Capacitor) | `apps/admin` | Stage 2 |
| Employee Android app (Capacitor) | `apps/employee` | Stage 3 |
| Owner web page (PIN protected, served by the Worker) | `owner/` | Stage 4 |

Everything runs on free plans: Cloudflare Workers Free (SQLite Durable Objects), GitHub Actions and GitHub Releases. No data is sent to any third party.

## Backend

```bash
cd backend
npm install
npm test                      # 20 automated tests (Node's built-in SQLite)
npm run dev                   # real Cloudflare runtime on http://localhost:8787
node scripts/smoke.mjs http://localhost:8787 dev-setup   # end-to-end check
```

Local secrets live in `backend/.dev.vars` (not committed):

```
SETUP_CODE=dev-setup
PIN_PEPPER=dev-pepper-change-me
```

### Deploying (only when the owner says so)

1. Create a free Cloudflare account and an API token with the **Edit Cloudflare Workers** template.
2. In GitHub → Settings → Secrets and variables → Actions, add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `SETUP_CODE` (a one-time code to create the owner account) and `PIN_PEPPER` (a long random string; never change it later or all PINs stop working).
3. Actions → **Deploy backend (manual)** → Run workflow.
4. The worker URL looks like `https://afford-attendance.<your-subdomain>.workers.dev`.

See [docs/backend.md](docs/backend.md) for how the rules, payroll and security work, and the API list.

# Backend: how it works

One Cloudflare Worker forwards every `/api/*` call to a single Durable Object for the store
(`STORE_ID = "afford"`). The Durable Object keeps all data in its own SQLite database, so the
admin app, employee phones, kiosk phone and owner page all see the same truth. Times are always
**server time**; Pakistan time (UTC+5) is used for dates.

## Security

- **PINs** are 4–6 digits, stored as PBKDF2-SHA256 hashes with a per-PIN salt plus a server-only
  pepper (`PIN_PEPPER` secret). The plain PIN is never stored.
- **Wrong PINs**: 5 wrong tries on one login (20 from one network) lock it for 5 min, then 10, 20, up to 60.
- **Sessions** are random 256-bit tokens; only their SHA-256 is stored. Admin: 30 days, employee: 1 year.
- **One phone = one employee**: the first login links the employee to the phone's device id. A
  different phone is refused (`BOUND_TO_OTHER_PHONE`), and a phone already linked to someone else
  is refused (`PHONE_USED_BY_OTHER`). Only the owner can reset the link.
- **First setup** needs the `SETUP_CODE` secret and works only once.
- **Fake GPS** (mock location reported by Android) is refused when the rule is on.
- **Audit log** records every admin action with who, when, and what changed.
- Nothing is sent to any third party. The only outbound call is to GitHub's public Releases API to
  read the latest app version.

## Attendance rules (all editable in Settings)

| Rule | Default |
|---|---|
| Days basis for daily / hourly rate | 26 (choose 26, 30 or actual days in month) |
| Late grace | 15 min; once passed, lateness counts from shift start (or only after grace) |
| Late cut | on: late minutes × (salary ÷ days basis ÷ shift hours ÷ 60) |
| Early-leave cut | on, 10 min grace |
| Break allowance | 30 min per day; break needs approval (switchable); late return is cut |
| Absent cut | on: one day's pay per absent day |
| Paid leave | 1 day per month (per-employee override), extra leave days are unpaid |
| Past-day requests | last 3 days, current month only |
| Offline punches | accepted up to 72 hours late, flagged as offline |
| Weekly off | Friday (per-employee override) |
| Holidays | list of paid off days |

**Field staff** (e.g. purchasers out of town) can check in and out from anywhere; the GPS point is
saved so admin can see where they were. Admin can also mark days as **out-of-town duty**.
Roles marked **check-out anywhere** (delivery boys, purchasers) can check out away from the store.

**Night shifts** that pass midnight (e.g. 16:00–24:00 or 22:00–06:00) stay on the day the shift started.

**Offline punches**: the phone keeps the server-time offset from its last sync and stamps a queued
punch with "server time now" as estimated from that offset. On sync, the server caps it at the
current time, keeps the order of punches, refuses anything older than the limit, and marks it
`offline` so admin can see it. Each punch carries a client id so retries are never doubled.

## Payroll (per employee per month)

```
daily   = salary ÷ days basis
hourly  = daily ÷ shift hours
net     = salary − absent days × daily − unpaid leave × daily − days before joining × daily
                 − late cut − early cut − late break cut − advances − deposit cut + bonus
```

Weekly offs, holidays, paid leave and out-of-town duty are paid. A current-month statement shows
the figures so far.

**Salary visibility** per employee: `always` (full monthly statement) or `last7` (only the last 7
days of daily records and cuts, no monthly totals).

**Money entries**: `advance` (deducted that month), `deposit` (security deposit paid in),
`deposit_cut` (taken from salary into the deposit), `deposit_return` (paid back), `bonus`.

## Kiosk mode (staff without a phone)

A shared phone at the counter is registered from the admin app. Staff tap their name, type their own
PIN, and the front camera takes a photo kept for 90 days. Kiosk punches must be inside the store radius.

## API

All bodies are JSON. Auth: `Authorization: Bearer <token>`; the employee app also sends `X-Device-Id`.
Errors look like `{ "error": "OUTSIDE_RADIUS", "message": "...", ... }`.

Public: `GET /api/info`, `GET /api/time`, `GET /api/logo`, `GET /api/app/latest?app=admin|employee`,
`POST /api/setup`, `POST /api/admin/login`, `POST /api/emp/login`.

Admin: `me`, `logout`, `me/pin`, `changes` (cheap poll: version + pending count), `board`,
`settings` (GET/PUT), `logo`, `users` (owner only), `employees` (CRUD, `photo`, `pin`,
`reset-device` (owner only), `calendar`, `day/:date`, `money`), `punch`, `punches/:id/void`,
`punches/:id/photo`, `mark`, `break/end`, `requests`, `requests/:id/decide`, `money`,
`money/:id/void`, `payroll`, `payroll/:id`, `reports` (`type=daily|weekly|monthly`, `list=late|absent`,
`format=csv`, `view=summary`), `audit`, `kiosks`.

Manager permissions: `employees.view`, `employees.edit`, `attendance.punch`, `requests.decide`,
`payroll.view`, `money.edit`, `reports.view`, `settings.edit`, `audit.view`, `kiosk.setup`.

Employee: `home`, `punch`, `break/end`, `requests` (GET/POST, `:id/cancel`), `calendar`,
`statement`, `photo`, `logout`.

Kiosk: `employees`, `employees/:id/photo`, `punch`.

Request types: `forgot_in`, `forgot_out`, `past_day`, `leave`, `advance`, `break`,
`undo_checkout`, `field_duty`.

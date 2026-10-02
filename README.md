# Ledger

A personal money tracker: savings goals, regular bills, monthly budgets, and what's left over each pay period.
It's a single static page backed by [Supabase](https://supabase.com) (auth and Postgres), with an optional
iOS home-screen widget built on [Scriptable](https://scriptable.app).

Live at <https://deltabellwebapps.github.io/savings-tracker/>.

## What's in the repo

| Path | What it is |
|---|---|
| `index.html` | The whole web app: markup, styles and script. Four tabs: Overview, Goals, Bills, Budgets. |
| `ledger-core.js` | Rules shared by the app and the widget: dates, bill schedules, the pay period, money formatting, goal plans and projections. |
| `widget/ledger-widget.js` | The Scriptable widget (goals, bills, or both; Home Screen and Lock Screen sizes). |
| `supabase/` | SQL migrations, run by hand in the Supabase SQL editor. |

There's no build step. GitHub Pages serves the files as they are.

## How the money works

- **Pay period.** You're paid on the last day of each month, so a period runs from one payday to the day
  before the next. This is set in `currentPayPeriod()` in `ledger-core.js`.
- **Pay.** Each month's pay is a one-off `bills` row with `kind = 'income'` and `category = 'pay'`, dated on payday.
- **Bills** repeat weekly, fortnightly, monthly, quarterly or yearly from a start date, with an optional last
  payment date. A recurring bill is tracked from the day it was added; earlier occurrences count as settled.
  "Mark paid" records the usual amount, and "Other amount" records a different one for bills that vary.
- **Goals** have either a target date (the app works out the monthly amount) or a fixed monthly amount.
  A £0 deposit marks a month as skipped. Each goal shows a projection: ahead of or behind a steady pace for
  dated goals, or an estimated finish month for the others.
- **Budgets** are monthly allowances (e.g. Groceries £300). They reset each payday, and spends are logged against them.
- **Overview.** Pay + other income − bills = *left over*. Then subtract goals and budgets (each one's plan, or
  more if you've gone over it) to get *free to spend*.
- **Archiving** hides a goal, bill, income source or budget from every list, total and chart without
  deleting its history. You can restore it from the "Archived" list at the bottom of its tab.

## Supabase setup

### Tables

Every table has `id uuid` (primary key), `user_id uuid` (defaults to `auth.uid()`) and `created_at timestamptz`.
Row-level security limits each user to their own rows.

| Table | Columns | Notes |
|---|---|---|
| `goals` | `name`, `target`, `saved`, `category`, `target_date`, `monthly_amount`, `sort_order`, `archived` | `saved` is kept up to date by a trigger on `deposits`. Never write it directly. |
| `deposits` | `goal_id`, `amount`, `note` | Negative = withdrawal, 0 = skipped month. |
| `bills` | `name`, `amount`, `frequency`, `start_date`, `end_date`, `kind` (`bill` / `income`), `category`, `archived` | Also holds income sources and monthly pay. |
| `bill_payments` | `bill_id`, `due_date`, `amount`, `paid_at` | One row per occurrence marked paid. |
| `budgets` | `name`, `amount`, `sort_order`, `archived` | Added in migration 001. |
| `spends` | `budget_id`, `amount`, `note`, `spent_on` | Added in migration 001. Negative = refund. |

The first four tables were created in the Supabase dashboard. Their columns are listed above as the app uses them.

### Migrations

Run each file in `supabase/` once, in order: **Dashboard → SQL Editor → New query → paste → Run**.
Deploy the matching app code only *after* running the migration.

- `001_saved_trigger_archive_budgets.sql` does three things:
  - adds the trigger that keeps `goals.saved` in step with deposits
  - adds the `archived` columns
  - creates `budgets` and `spends`

  The file also has an optional query that checks whether any goal's total has drifted from its deposit history.

### Auth (email + password, and magic links)

Magic links need the app's address allowed as a redirect:
**Dashboard → Authentication → URL Configuration**

- **Site URL:** `https://deltabellwebapps.github.io/savings-tracker/`
- **Redirect URLs:** add the same URL. To test locally, also add e.g. `http://localhost:8000/`.

The link opens the app and signs you in on whichever device you open it on. Use "Sign up" to get a link
that also creates the account. The Scriptable widget still signs in with a password.

## Running locally

Serve the folder over HTTP (opening `index.html` as a file won't load `ledger-core.js` reliably):

```sh
npx serve .            # or: python -m http.server 8000
```

It talks to the live Supabase project, so you're working with real data.

## The widget

1. Install Scriptable on the iPhone.
2. Copy **both** `widget/ledger-widget.js` and `ledger-core.js` into Scriptable's folder
   (iCloud Drive → Scriptable). The widget imports the shared rules with `importModule('ledger-core')`.
   If you change `ledger-core.js`, copy it across again.
3. Run *ledger-widget* once in the Scriptable app to sign in. Only the session token is kept, in the keychain.
4. Add a Scriptable widget to the Home or Lock Screen, pick the script, and set **Parameter** to
   `goals`, `bills` or `both`.

It refreshes about every 15 minutes and shows the last copy it fetched when it's offline.

## Changing the shared rules

Anything about dates, schedules, the pay period, money formatting or goal plans belongs in `ledger-core.js`.
The web app reads it as `window.LedgerCore` and the widget as a Scriptable module, so one edit covers both.
Only after copying the new file to Scriptable does the widget pick it up.

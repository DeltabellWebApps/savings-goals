# Ledger: notes for Claude

See README.md for what the app is, the files, the database tables and setup. This file holds where the work
stands and the decisions behind it.

## Conventions

- No build step. GitHub Pages serves the repo as it is, so keep the app to plain files.
- `index.html` holds the app's markup, CSS and script. Its sections are marked with `// ---------- Name ----------` comments.
- Any rule both the app and the widget need (dates, bill schedules, pay period, money, goal plans)
  goes in `ledger-core.js`, never copied into either. The app reads it as `window.LedgerCore` and the widget via
  `importModule('ledger-core')`.
- Database changes go in a new numbered file in `supabase/` (`002_...sql`) that's safe to re-run. The user runs
  it by hand in the Supabase SQL editor, *before* deploying code that depends on it. Say so every time.
- Never write `goals.saved` from the client. A trigger on `deposits` maintains it.
- UK English and GBP throughout. Dates use `en-GB`.
- Charts are hand-written inline SVG (see `// ---------- Charts ----------`). They use the `--chart` colour token,
  checked against the dataviz palette validator: light `#B8863B`, dark `#B88A44`.
- The user sometimes has `index.html` open and edits it in VS Code. Read files again before editing rather
  than relying on an earlier read.

## Status (as of 2 Oct 2026)

Implemented in the 2 Oct 2026 session:
- auth reload fix
- deposits trigger
- paying a bill at a different amount
- budgets and spends
- charts
- goal projections
- archiving
- magic-link sign-in
- bill search and filters
- drag to reorder goals
- shared `ledger-core.js`
- README

**Deployed.** The main batch went up in GitHub commit `bc0c1e1` ("Add files via upload"), which the user
uploaded through the GitHub web UI. That commit covers `index.html`, `ledger-core.js`, the widget and the
README; `supabase/` and `.claude/` weren't uploaded. The local repo is one commit behind and has nothing
committed. Before committing or pushing, run `git fetch` and compare with `--ignore-cr-at-eol`: files uploaded
through the web UI end up with CRLF line endings, so a plain diff marks every line as changed.

Migration `001_saved_trigger_archive_budgets.sql` **has been run** (user confirmed on 2 Oct 2026). The new
columns and tables are visible through the REST API. The user also confirmed that the Pages URL has been
added to Supabase Auth → URL Configuration (for magic links), and that the latest `ledger-core.js` has been
copied into Scriptable alongside the widget.

**Security, checked 2 Oct 2026:**
- RLS is on for all six tables. Every policy's USING and WITH CHECK rule is `user_id = auth.uid()`, and the
  `bill_payments` check also confirms the bill belongs to the user. A visitor who isn't signed in sees 0 rows.
- The only key in the repo or its history is the public anon key.
- Sign-ups were open with automatic email confirmation. I recommended turning sign-ups off, since the user is
  the only one using the app.
- `.claude/` doesn't go up through GitHub's web upload, which skips names starting with a dot.

Testing so far was against a fake in-memory Supabase in headless Chrome. The real trigger and the widget on an
iPhone haven't been tested.

### Follow-up changes after the main batch (local only, not on GitHub yet as of `bc0c1e1`)

- **Goal schedule check changed** (`projectGoal` in `ledger-core.js`). It now compares the goal's balance at the
  *start* of the pay period (saved minus this period's deposits) with a steady line from the creation date
  to the target date. Gaps under half a month's share count as on schedule.
  - Why: it used to measure at the period *end*, so every dated goal read "behind" until that month's deposit
    went in. The user noticed this on day 3 of a period.
- **Budget wording clarified.** The user read "Resets every payday" as the budget being for one month only.
  Budgets repeat until archived, and only the amount spent resets each payday.
  - The sheet label is now "Amount per month", with a hint saying it repeats.
  - Cards read "£X of £Y this month".
  - No rollover or one-off budgets: the user was happy with how they work once the wording made it clear.

## Decisions on suggested features

- **Payday handling: leave as is.** Payday stays on the last calendar day of the month, even when it falls on a
  weekend. The user may revisit this if it causes problems; don't change it unasked.
- **Pay estimates: declined.** No predicting pay before it's entered.
- **Bill reminders / push notifications: deferred.**
- **Export / backup (CSV/JSON): deferred.**
- **Password reset: not wanted.** Magic link was added instead.
- **Installable PWA: deferred, user will come back to it.** Plan discussed:
  - `manifest.json` and icons (192, 512, maskable, 180 Apple touch icon), plus iOS meta tags
  - `sw.js` caching the app files network-first (so new uploads show up straight away), never caching Supabase
    requests, with a version number to bump on each release
  - optionally, keeping the last loaded data for offline viewing (saving changes offline would be a much bigger job)
  - Estimate: 20–30 minutes with a generated icon, plus the user testing on an iPhone.

## Testing locally

To check UI changes without the real database, serve `index.html` with the Supabase script swapped for an
in-memory fake (seeded data, plus a copy of the deposits trigger), then drive it with headless Chrome over
CDP. The DevTools MCP browser may already be in use by another session, so launch a separate Chrome with
its own `--user-data-dir`. Page loads must change the query string, because a change to the hash alone
doesn't reload the page.

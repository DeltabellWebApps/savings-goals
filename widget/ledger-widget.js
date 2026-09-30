// Ledger widget for Scriptable (https://scriptable.app): savings goals and upcoming bills.
// Run it once in the Scriptable app to sign in, then add a Scriptable widget and pick this script.
// Set the widget's Parameter to choose what it shows:  goals (default)  ·  bills  ·  both
// Supports small, medium and large Home Screen widgets, plus the three Lock Screen sizes.

const SUPABASE_URL = 'https://vpbrurxowgneplxpwkkv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwYnJ1cnhvd2duZXBseHB3a2t2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1MzAwNzcsImV4cCI6MjEwNjEwNjA3N30.3yq74-z1tkQDNA8BB6JFG3_yFwLN-yjHz_7WJyrAqDs';
const APP_URL = 'https://deltabellwebapps.github.io/savings-tracker/';
const SESSION_KEY = 'ledger.session';
const REFRESH_MINUTES = 15;
const MODES = ['goals', 'bills', 'both'];

// Same palette as the web app, light and dark.
const dyn = (light, dark) => Color.dynamic(new Color(light), new Color(dark));
const C = {
  bg: dyn('#FFFDF8', '#202823'),
  ink: dyn('#1F2A24', '#EDE8DC'),
  soft: dyn('#5B6459', '#A6ADA2'),
  line: dyn('#D8D2C2', '#34403A'),
  gold: dyn('#B8863B', '#D6A758'),
  done: dyn('#22392F', '#DDE7DE'),
  danger: dyn('#A24A3B', '#D98C79'),
};

class AuthError extends Error {}

// ---------- Auth ----------
// Only the Supabase session (never the password) is kept, in the iOS keychain.
async function authRequest(grant, body) {
  const req = new Request(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`);
  req.method = 'POST';
  req.headers = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  req.body = JSON.stringify(body);
  const res = await req.loadJSON();
  if (req.response.statusCode !== 200) {
    throw new AuthError(res.error_description || res.msg || 'Sign-in failed');
  }
  const session = {
    access: res.access_token,
    refresh: res.refresh_token,
    expiresAt: Date.now() + (res.expires_in - 60) * 1000,
  };
  Keychain.set(SESSION_KEY, JSON.stringify(session));
  return session;
}

async function getAccessToken(forceRefresh) {
  if (!Keychain.contains(SESSION_KEY)) return null;
  const session = JSON.parse(Keychain.get(SESSION_KEY));
  if (!forceRefresh && Date.now() < session.expiresAt) return session.access;
  try {
    return (await authRequest('refresh_token', { refresh_token: session.refresh })).access;
  } catch (e) {
    if (e instanceof AuthError) Keychain.remove(SESSION_KEY);
    throw e;
  }
}

// ---------- Data ----------
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), 'ledger-widget-cache.json');

async function rest(token, path) {
  const req = new Request(`${SUPABASE_URL}/rest/v1/${path}`);
  req.headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` };
  const rows = await req.loadJSON();
  if (req.response.statusCode === 401) throw new AuthError('Session expired');
  if (req.response.statusCode !== 200) throw new Error(`Supabase returned ${req.response.statusCode}`);
  return rows;
}

// Fetches only what the mode needs; the cache keeps the latest copy of each.
async function fetchAll(token, mode) {
  const out = {};
  const jobs = [];
  if (mode !== 'bills') {
    jobs.push(rest(token, 'goals?select=id,name,target,saved,target_date,monthly_amount,sort_order&order=sort_order.asc')
      .then(rows => { out.goals = rows.map(r => ({ id: r.id, name: r.name, target: Number(r.target), saved: Number(r.saved), targetDate: r.target_date || null, monthlyAmount: r.monthly_amount == null ? null : Number(r.monthly_amount) })); }));
    // This pay period's deposits; £0 ones mark a goal as skipped.
    const since = encodeURIComponent(currentPayPeriod().start.toISOString());
    jobs.push(rest(token, `deposits?select=goal_id,amount,created_at&created_at=gte.${since}`)
      .then(rows => { out.periodDeposits = rows.map(r => ({ goalId: r.goal_id, amount: Number(r.amount), createdAt: r.created_at })); }));
  }
  if (mode !== 'goals') {
    jobs.push(rest(token, 'bills?select=id,name,amount,frequency,start_date,end_date,created_at&kind=eq.bill')
      .then(rows => { out.bills = rows.map(r => ({ id: r.id, name: r.name, amount: Number(r.amount), frequency: r.frequency, startDate: r.start_date, endDate: r.end_date || null, createdAt: r.created_at })); }));
    jobs.push(rest(token, 'bill_payments?select=bill_id,due_date')
      .then(rows => { out.paid = rows.map(r => r.bill_id + '|' + r.due_date); }));
  }
  await Promise.all(jobs);
  return out;
}

function readCache() {
  return fm.fileExists(cachePath) ? JSON.parse(fm.readString(cachePath)) : null;
}

// Returns { goals, bills, paid, at, stale } or { signedOut } or { error }. Falls back to the cache when offline.
async function loadData(mode) {
  try {
    let token = await getAccessToken(false);
    if (!token) return { signedOut: true };
    let fresh;
    try {
      fresh = await fetchAll(token, mode);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      token = await getAccessToken(true); // token rejected early; refresh once and retry
      fresh = await fetchAll(token, mode);
    }
    const data = { ...(readCache() || {}), ...fresh, at: Date.now() };
    fm.writeString(cachePath, JSON.stringify(data));
    return data;
  } catch (e) {
    if (e instanceof AuthError) return { signedOut: true };
    const cached = readCache();
    const hasWhatWeNeed = cached && (mode === 'bills' || cached.goals) && (mode === 'goals' || cached.bills);
    if (hasWhatWeNeed) return { ...cached, stale: true };
    return { error: "Couldn't connect" };
  }
}

// ---------- Helpers (mirroring the web app) ----------
function formatMoney(n) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.round(Math.abs(Number(n)) * 100) / 100;
  const pence = Number.isInteger(abs) ? 0 : 2;
  return sign + '£' + abs.toLocaleString('en-GB', { minimumFractionDigits: pence, maximumFractionDigits: 2 });
}

function pctOf(g) {
  return g.target > 0 ? Math.min(100, (g.saved / g.target) * 100) : 0;
}

function isDone(g) {
  return g.target > 0 && g.saved >= g.target;
}

// Pay lands on the last day of each month; a period runs from one payday to the day before the next.
function currentPayPeriod() {
  const today = startOfToday();
  let start = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  if (start > today) start = new Date(today.getFullYear(), today.getMonth(), 0);
  return { start, end: addDays(new Date(start.getFullYear(), start.getMonth() + 2, 0), -1) };
}

// Same as the web app's goalPlan: this period's amount is worked out from where the goal stood when the
// period began, so saving during the period counts towards it. The cache may hold an older period's
// deposits, hence the date check.
function goalPlan(g, deposits) {
  const period = currentPayPeriod();
  const mine = (deposits || []).filter(d => d.goalId === g.id && new Date(d.createdAt) >= period.start);
  const skipped = mine.some(d => d.amount === 0);
  const savedThisPeriod = mine.reduce((s, d) => s + d.amount, 0);
  const remaining = g.target - g.saved;
  const remainingAtStart = remaining + savedThisPeriod;
  const plan = { planned: 0, savedThisPeriod, skipped, remaining, overdue: false, dueLabel: null, afterSkip: 0 };
  if (g.targetDate) {
    const due = parseLocalDate(g.targetDate);
    plan.dueLabel = due.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    if (due <= startOfToday()) {
      plan.overdue = remaining > 0;
    } else if (remainingAtStart > 0) {
      const monthsLeft = Math.max(1, Math.ceil((due - period.start) / (1000 * 60 * 60 * 24 * 30.44)));
      plan.planned = remainingAtStart / monthsLeft;
      plan.afterSkip = Math.max(0, remaining) / Math.max(1, monthsLeft - 1);
    }
  } else if (g.monthlyAmount) {
    plan.planned = Math.min(g.monthlyAmount, Math.max(0, remainingAtStart));
    plan.afterSkip = g.monthlyAmount;
  }
  return plan;
}

function planLine(p) {
  if (p.overdue) return `Target date passed · ${formatMoney(p.remaining)} to go`;
  if (p.skipped) return `Skipped this month · then ${formatMoney(p.afterSkip)}/mo`;
  if (p.planned > 0 && p.savedThisPeriod >= p.planned) return `✓ ${formatMoney(p.savedThisPeriod)} saved this month`;
  if (p.planned > 0 && p.savedThisPeriod > 0) return `${formatMoney(p.savedThisPeriod)} of ${formatMoney(p.planned)} saved this month`;
  if (p.planned > 0) return `Save ${formatMoney(p.planned)}/mo${p.dueLabel ? ` to hit this by ${p.dueLabel}` : ''}`;
  return null;
}

function timeLabel(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- Bill schedule (same rules as the web app) ----------
function parseLocalDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfToday() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function occurrence(start, freq, n) {
  if (freq === 'weekly') return addDays(start, 7 * n);
  if (freq === 'fortnightly') return addDays(start, 14 * n);
  const step = { monthly: 1, quarterly: 3, yearly: 12 }[freq];
  const y = start.getFullYear(), m = start.getMonth() + step * n;
  const lastDay = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(start.getDate(), lastDay));
}

function* occurrencesFrom(bill, from) {
  const start = parseLocalDate(bill.startDate);
  if (bill.frequency === 'once') {
    if (start >= from) yield start;
    return;
  }
  const end = bill.endDate ? parseLocalDate(bill.endDate) : null;
  for (let n = 0, d = start; !end || d <= end; d = occurrence(start, bill.frequency, ++n)) {
    if (d >= from) yield d;
  }
}

// Recurring bills are tracked from the day they were added; occurrences before that count as settled.
function trackFrom(bill) {
  if (bill.frequency === 'once') return parseLocalDate(bill.startDate);
  const c = new Date(bill.createdAt);
  return new Date(c.getFullYear(), c.getMonth(), c.getDate());
}

// Every unpaid occurrence (overdue ones included) up to two months ahead, soonest first.
function upcomingBills(data) {
  const paid = new Set(data.paid || []);
  const horizon = addDays(startOfToday(), 60);
  const items = [];
  (data.bills || []).forEach(b => {
    for (const d of occurrencesFrom(b, trackFrom(b))) {
      if (d > horizon) break;
      if (!paid.has(b.id + '|' + toISODate(d))) items.push({ name: b.name, amount: b.amount, date: d });
    }
  });
  return items.sort((x, y) => x.date - y.date);
}

function billStats(items) {
  const today = startOfToday();
  const weekEnd = addDays(today, 7);
  return {
    overdue: items.filter(i => i.date < today).length,
    dueThisWeek: items.filter(i => i.date <= weekEnd).reduce((s, i) => s + i.amount, 0),
  };
}

function whenLabel(d) {
  const days = Math.round((d - startOfToday()) / 86400000);
  if (days < 0) return `Overdue · ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// ---------- Drawing ----------
function addText(parent, str, font, color, opts = {}) {
  const t = parent.addText(str);
  t.font = font;
  if (color) t.textColor = color;
  t.lineLimit = opts.lines || 1;
  if (opts.scale) t.minimumScaleFactor = opts.scale;
  return t;
}

function addBar(parent, width, pct, done, colors) {
  const height = 6;
  const track = parent.addStack();
  track.size = new Size(width, height);
  track.cornerRadius = height / 2;
  track.backgroundColor = colors ? colors.track : C.line;
  const fillWidth = pct > 0 ? Math.max(height, (width * pct) / 100) : 0;
  if (fillWidth > 0) {
    const fill = track.addStack();
    fill.size = new Size(fillWidth, height);
    fill.cornerRadius = height / 2;
    fill.backgroundColor = colors ? colors.fill : (done ? C.done : C.gold);
  }
  track.addSpacer();
}

function addGoalRow(parent, g, width, opts = {}) {
  const row = parent.addStack();
  row.layoutVertically();
  const top = row.addStack();
  top.centerAlignContent();
  addText(top, `${isDone(g) ? '✓ ' : ''}${g.name}`, Font.mediumSystemFont(opts.compact ? 12 : 13), C.ink);
  top.addSpacer();
  const amounts = opts.compact ? `${pctOf(g).toFixed(0)}%` : `${formatMoney(g.saved)} / ${formatMoney(g.target)}`;
  addText(top, amounts, Font.regularMonospacedSystemFont(11), C.soft, { scale: 0.7 });
  row.addSpacer(4);
  addBar(row, width, pctOf(g), isDone(g));
  if (opts.withSuggestion) {
    const msg = planLine(goalPlan(g, opts.periodDeposits));
    if (msg) {
      row.addSpacer(3);
      addText(row, msg, Font.regularSystemFont(10), C.soft);
    }
  }
}

function addBillRow(parent, item, opts = {}) {
  const row = parent.addStack();
  row.centerAlignContent();
  const left = row.addStack();
  left.layoutVertically();
  addText(left, item.name, Font.mediumSystemFont(opts.compact ? 12 : 13), C.ink);
  addText(left, whenLabel(item.date), Font.regularSystemFont(10), item.date < startOfToday() ? C.danger : C.soft);
  row.addSpacer();
  addText(row, formatMoney(item.amount), Font.mediumMonospacedSystemFont(opts.compact ? 11 : 12), C.ink, { scale: 0.7 });
}

function addHeader(w, title, right, rightColor) {
  const head = w.addStack();
  head.centerAlignContent();
  addText(head, title, Font.boldSystemFont(15), C.ink);
  head.addSpacer();
  addText(head, right, Font.mediumMonospacedSystemFont(11), rightColor || C.gold, { scale: 0.7 });
}

function addLabel(parent, str) {
  addText(parent, str, Font.semiboldMonospacedSystemFont(10), C.gold);
}

function addFooter(w, data, always) {
  if (!always && !data.stale) return;
  w.addSpacer(6);
  addText(w, `${data.stale ? 'Offline · ' : ''}Updated ${timeLabel(data.at)}`, Font.regularSystemFont(9), C.soft);
}

function billsSummary(stats) {
  return stats.overdue
    ? { text: `${stats.overdue} overdue`, color: C.danger }
    : { text: `${formatMoney(stats.dueThisWeek)} this week`, color: C.gold };
}

function messageWidget(w, family, title, body) {
  if (family.startsWith('accessory')) {
    addText(w, title, Font.semiboldSystemFont(12), null, { lines: 2 });
    return w;
  }
  addLabel(w, 'LEDGER');
  w.addSpacer(6);
  addText(w, title, Font.semiboldSystemFont(14), C.ink, { lines: 2 });
  w.addSpacer(4);
  addText(w, body, Font.regularSystemFont(11), C.soft, { lines: 3 });
  w.addSpacer();
  return w;
}

// ---------- Layouts ----------
function goalsLayout(w, family, data, goals) {
  const totalSaved = goals.reduce((s, g) => s + g.saved, 0);
  const totalTarget = goals.reduce((s, g) => s + g.target, 0);
  const totalPct = totalTarget > 0 ? Math.min(100, (totalSaved / totalTarget) * 100) : 0;
  const top = goals[0];

  if (family === 'accessoryInline') {
    w.addText(`${formatMoney(totalSaved)} saved · ${totalPct.toFixed(0)}%`);
  } else if (family === 'accessoryCircular') {
    circular(w, `${totalPct.toFixed(0)}%`, 'saved');
  } else if (family === 'accessoryRectangular') {
    addText(w, top.name, Font.semiboldSystemFont(13));
    addText(w, `${formatMoney(top.saved)} of ${formatMoney(top.target)} · ${pctOf(top).toFixed(0)}%`, Font.regularSystemFont(11), null, { scale: 0.7 });
    w.addSpacer(4);
    addBar(w, 140, pctOf(top), false, { track: new Color('#ffffff', 0.3), fill: Color.white() });
  } else if (family === 'small') {
    addLabel(w, 'LEDGER');
    w.addSpacer(4);
    addText(w, formatMoney(totalSaved), Font.boldSystemFont(24), C.ink, { scale: 0.6 });
    addText(w, `of ${formatMoney(totalTarget)}`, Font.regularMonospacedSystemFont(10), C.soft, { scale: 0.7 });
    w.addSpacer();
    addText(w, top.name, Font.mediumSystemFont(13), C.ink);
    w.addSpacer(5);
    addBar(w, 120, pctOf(top), isDone(top));
    w.addSpacer(4);
    addText(w, `${pctOf(top).toFixed(0)}% · ${formatMoney(top.saved)}`, Font.regularMonospacedSystemFont(10), C.soft, { scale: 0.7 });
  } else {
    const large = family !== 'medium';
    addHeader(w, 'Goals', `${formatMoney(totalSaved)} saved`);
    w.addSpacer(large ? 12 : 10);
    goals.slice(0, large ? 6 : 3).forEach((g, i) => {
      if (i > 0) w.addSpacer(large ? 12 : 8);
      addGoalRow(w, g, 285, { withSuggestion: large, periodDeposits: data.periodDeposits });
    });
    w.addSpacer();
    addFooter(w, data, large);
  }
}

function billsLayout(w, family, data, items) {
  const stats = billStats(items);
  const next = items[0];

  if (!next) {
    if (family.startsWith('accessory')) w.addText('No bills due');
    else messageWidget(w, family, 'Nothing due', 'No unpaid bills in the next two months.');
    return;
  }

  if (family === 'accessoryInline') {
    w.addText(`${next.name} ${formatMoney(next.amount)} · ${whenLabel(next.date)}`);
  } else if (family === 'accessoryCircular') {
    const count = items.filter(i => i.date <= addDays(startOfToday(), 7)).length;
    circular(w, String(count), 'due soon');
  } else if (family === 'accessoryRectangular') {
    addText(w, 'Next bill', Font.regularSystemFont(11));
    addText(w, `${next.name} · ${formatMoney(next.amount)}`, Font.semiboldSystemFont(13), null, { scale: 0.7 });
    addText(w, whenLabel(next.date), Font.regularSystemFont(11));
  } else if (family === 'small') {
    addLabel(w, 'NEXT BILL');
    w.addSpacer(6);
    addText(w, next.name, Font.mediumSystemFont(14), C.ink);
    addText(w, formatMoney(next.amount), Font.boldSystemFont(24), C.ink, { scale: 0.6 });
    addText(w, whenLabel(next.date), Font.regularSystemFont(11), next.date < startOfToday() ? C.danger : C.soft);
    w.addSpacer();
    const s = billsSummary(stats);
    addText(w, s.text, Font.mediumMonospacedSystemFont(10), s.color, { scale: 0.7 });
  } else {
    const large = family !== 'medium';
    const s = billsSummary(stats);
    addHeader(w, 'Bills', s.text, s.color);
    w.addSpacer(large ? 12 : 8);
    items.slice(0, large ? 7 : 3).forEach((item, i) => {
      if (i > 0) w.addSpacer(large ? 10 : 6);
      addBillRow(w, item);
    });
    w.addSpacer();
    addFooter(w, data, large);
  }
}

function bothLayout(w, family, data, goals, items) {
  const totalSaved = goals.reduce((s, g) => s + g.saved, 0);
  const next = items[0];
  const stats = billStats(items);

  if (family === 'accessoryInline') {
    w.addText(`${formatMoney(totalSaved)} saved${next ? ` · next: ${next.name}` : ''}`);
  } else if (family === 'accessoryCircular') {
    const totalTarget = goals.reduce((s, g) => s + g.target, 0);
    circular(w, `${totalTarget > 0 ? Math.min(100, (totalSaved / totalTarget) * 100).toFixed(0) : 0}%`, 'saved');
  } else if (family === 'accessoryRectangular') {
    addText(w, `${formatMoney(totalSaved)} saved`, Font.semiboldSystemFont(13));
    addText(w, next ? `Next: ${next.name} ${formatMoney(next.amount)}` : 'No bills due', Font.regularSystemFont(11), null, { scale: 0.7 });
    if (next) addText(w, whenLabel(next.date), Font.regularSystemFont(11));
  } else if (family === 'small') {
    addLabel(w, 'LEDGER');
    w.addSpacer(4);
    addText(w, formatMoney(totalSaved), Font.boldSystemFont(22), C.ink, { scale: 0.6 });
    addText(w, 'saved', Font.regularMonospacedSystemFont(10), C.soft);
    w.addSpacer();
    addText(w, 'Next bill', Font.regularSystemFont(10), C.soft);
    if (next) {
      addText(w, `${next.name} · ${formatMoney(next.amount)}`, Font.mediumSystemFont(12), C.ink, { scale: 0.7 });
      addText(w, whenLabel(next.date), Font.regularSystemFont(10), next.date < startOfToday() ? C.danger : C.soft);
    } else {
      addText(w, 'Nothing due', Font.mediumSystemFont(12), C.ink);
    }
  } else if (family === 'medium') {
    // Two columns: goals on the left, bills on the right.
    const cols = w.addStack();
    const left = cols.addStack();
    left.layoutVertically();
    left.size = new Size(135, 0);
    addLabel(left, 'GOALS');
    left.addSpacer(8);
    goals.slice(0, 3).forEach((g, i) => {
      if (i > 0) left.addSpacer(8);
      addGoalRow(left, g, 135, { compact: true });
    });
    left.addSpacer();
    cols.addSpacer(16);
    const right = cols.addStack();
    right.layoutVertically();
    addLabel(right, 'BILLS');
    right.addSpacer(8);
    if (items.length === 0) addText(right, 'Nothing due', Font.regularSystemFont(11), C.soft);
    items.slice(0, 3).forEach((item, i) => {
      if (i > 0) right.addSpacer(6);
      addBillRow(right, item, { compact: true });
    });
    right.addSpacer();
  } else {
    addHeader(w, 'Goals', `${formatMoney(totalSaved)} saved`);
    w.addSpacer(10);
    goals.slice(0, 3).forEach((g, i) => {
      if (i > 0) w.addSpacer(10);
      addGoalRow(w, g, 285);
    });
    w.addSpacer(18);
    const s = billsSummary(stats);
    addHeader(w, 'Bills', s.text, s.color);
    w.addSpacer(10);
    if (items.length === 0) addText(w, 'No unpaid bills in the next two months.', Font.regularSystemFont(11), C.soft);
    items.slice(0, 4).forEach((item, i) => {
      if (i > 0) w.addSpacer(8);
      addBillRow(w, item);
    });
    w.addSpacer();
    addFooter(w, data, true);
  }
}

function circular(w, big, small) {
  w.addAccessoryWidgetBackground = true;
  const s = w.addStack();
  s.layoutVertically();
  s.centerAlignContent();
  [addText(s, big, Font.boldRoundedSystemFont(16), null, { scale: 0.6 }), addText(s, small, Font.regularSystemFont(9))]
    .forEach(t => t.centerAlignText());
}

function buildWidget(family, mode, data) {
  const w = new ListWidget();
  const accessory = family.startsWith('accessory');
  if (!accessory) {
    w.backgroundColor = C.bg;
    if (family === 'small') w.setPadding(14, 14, 14, 14);
  }
  w.url = APP_URL + { goals: '#goals', bills: '#bills', both: '#overview' }[mode];
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);

  if (data.signedOut) return messageWidget(w, family, 'Sign in needed', 'Open Scriptable and run this script to sign in.');
  if (data.error) return messageWidget(w, family, data.error, 'Will try again shortly.');

  // Unfinished goals first, keeping the order set in the app.
  const allGoals = data.goals || [];
  const goals = [...allGoals.filter(g => !isDone(g)), ...allGoals.filter(isDone)];
  const items = mode === 'goals' ? [] : upcomingBills(data);

  if (mode !== 'bills' && goals.length === 0) return messageWidget(w, family, 'No goals yet', 'Add one in the Ledger app.');

  if (mode === 'goals') goalsLayout(w, family, data, goals);
  else if (mode === 'bills') billsLayout(w, family, data, items);
  else bothLayout(w, family, data, goals, items);
  return w;
}

// ---------- Running in the app ----------
async function signIn() {
  const a = new Alert();
  a.title = 'Sign in to Ledger';
  a.message = 'Use the same email and password as the website.';
  a.addTextField('Email');
  a.addSecureTextField('Password');
  a.addAction('Sign in');
  a.addCancelAction('Cancel');
  if (await a.presentAlert() === -1) return false;
  try {
    await authRequest('password', { email: a.textFieldValue(0).trim(), password: a.textFieldValue(1) });
    return true;
  } catch (e) {
    const err = new Alert();
    err.title = "Couldn't sign in";
    err.message = e.message;
    err.addAction('OK');
    await err.presentAlert();
    return false;
  }
}

async function pick(title, message, options) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  options.forEach(o => a.addAction(o));
  a.addCancelAction('Cancel');
  return a.presentAlert();
}

async function runInApp() {
  if (!Keychain.contains(SESSION_KEY) && !(await signIn())) return;
  const choice = await pick(
    'Ledger widget',
    "You're signed in. Add a Scriptable widget, choose this script, and set Parameter to goals, bills or both.",
    ['Preview goals', 'Preview bills', 'Preview both', 'Sign out']
  );
  if (choice === 3) {
    Keychain.remove(SESSION_KEY);
    if (fm.fileExists(cachePath)) fm.remove(cachePath);
    return;
  }
  const mode = MODES[choice];
  if (!mode) return;
  const family = ['small', 'medium', 'large'][await pick('Size', null, ['Small', 'Medium', 'Large'])];
  if (!family) return;
  const w = buildWidget(family, mode, await loadData(mode));
  if (family === 'small') await w.presentSmall();
  else if (family === 'medium') await w.presentMedium();
  else await w.presentLarge();
}

if (config.runsInWidget) {
  const param = String(args.widgetParameter || '').trim().toLowerCase();
  const mode = MODES.includes(param) ? param : 'goals';
  Script.setWidget(buildWidget(config.widgetFamily || 'medium', mode, await loadData(mode)));
} else {
  await runInApp();
}
Script.complete();

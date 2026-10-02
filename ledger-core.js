// Shared rules for the Ledger web app and the Scriptable widget: dates, bill schedules, pay periods,
// money formatting and goal plans. Change them here and both pick it up.
// The web app loads this with a <script> tag (as window.LedgerCore); the widget uses importModule('ledger-core').
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FREQUENCY_LABELS = {
    weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly',
    quarterly: 'Quarterly', yearly: 'Yearly', once: 'One-off'
  };
  const PER_MONTH = { weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12, once: 0 };
  const AVG_MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;

  // ---------- Dates ----------
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

  function lastDayOfMonth(y, m) {
    return new Date(y, m + 1, 0);
  }

  function monthShort(d) {
    return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  }

  // ---------- Bill schedule ----------
  // nth occurrence from start. Month-based bills keep the start's day, clamped to the month's end (31st -> 30th/28th).
  function occurrence(start, freq, n) {
    if (freq === 'weekly') return addDays(start, 7 * n);
    if (freq === 'fortnightly') return addDays(start, 14 * n);
    const step = { monthly: 1, quarterly: 3, yearly: 12 }[freq];
    const y = start.getFullYear(), m = start.getMonth() + step * n;
    const lastDay = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(start.getDate(), lastDay));
  }

  // Occurrences on or after `from`, in order, stopping after the end date (if any).
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

  // Occurrences within [from, to], in order.
  function occurrencesBetween(bill, from, to) {
    const out = [];
    for (const d of occurrencesFrom(bill, from)) {
      if (d > to) break;
      out.push(d);
    }
    return out;
  }

  function nextDue(bill) {
    return occurrencesFrom(bill, startOfToday()).next().value || null;
  }

  // Recurring bills are tracked from the day they were added; occurrences before that count as settled.
  function trackFrom(bill) {
    if (bill.frequency === 'once') return parseLocalDate(bill.startDate);
    const c = new Date(bill.createdAt);
    return new Date(c.getFullYear(), c.getMonth(), c.getDate());
  }

  // Average per month across entries that haven't ended.
  function monthlyAverage(list, today) {
    return list
      .filter(b => !b.endDate || parseLocalDate(b.endDate) >= today)
      .reduce((s, b) => s + b.amount * PER_MONTH[b.frequency], 0);
  }

  // ---------- Pay period ----------
  // Pay lands on the last day of each month, so a period runs from one payday to the day before the next.
  function currentPayPeriod() {
    const today = startOfToday();
    let start = lastDayOfMonth(today.getFullYear(), today.getMonth());
    if (start > today) start = lastDayOfMonth(today.getFullYear(), today.getMonth() - 1);
    const nextPayday = lastDayOfMonth(start.getFullYear(), start.getMonth() + 1);
    return { start, end: addDays(nextPayday, -1), nextPayday };
  }

  // ---------- Money ----------
  function formatMoney(n) {
    const sign = n < 0 ? '-' : '';
    const abs = Math.round(Math.abs(Number(n)) * 100) / 100;
    const pence = Number.isInteger(abs) ? 0 : 2; // £950, but £174.50 rather than £174.5
    return sign + '£' + abs.toLocaleString('en-GB', { minimumFractionDigits: pence, maximumFractionDigits: 2 });
  }

  // ---------- Goals ----------
  function pctOf(g) {
    return g.target > 0 ? Math.min(100, (g.saved / g.target) * 100) : 0;
  }

  function isDone(g) {
    return g.target > 0 && g.saved >= g.target;
  }

  // What a goal asks for this pay period. It's worked out from where the goal stood when the period began,
  // so money added during the period counts towards it rather than shrinking it. `deposits` may hold other
  // goals' and older periods' deposits; only this goal's from this period count. £0 deposits mark a skip.
  //   planned   — this period's amount (from the target date, or the goal's monthly amount)
  //   committed — what the Overview sets aside: the plan, or more if more was saved; only what was saved if skipped
  //   afterSkip — the monthly amount needed from next period if this one is skipped
  //   projection — a short forecast line (finish month, or ahead/behind a steady pace), or null
  function goalPlan(goal, deposits) {
    const period = currentPayPeriod();
    const mine = (deposits || []).filter(d => d.goalId === goal.id && new Date(d.createdAt) >= period.start);
    const skip = mine.find(d => d.amount === 0) || null;
    const savedThisPeriod = mine.reduce((s, d) => s + d.amount, 0);
    const remaining = goal.target - goal.saved;
    const remainingAtStart = remaining + savedThisPeriod;
    const plan = { planned: 0, savedThisPeriod, skip, remaining, overdue: false, dueLabel: null, afterSkip: 0 };

    if (goal.targetDate) {
      const due = parseLocalDate(goal.targetDate);
      plan.dueLabel = monthShort(due);
      if (due <= startOfToday()) {
        plan.overdue = remaining > 0;
      } else if (remainingAtStart > 0) {
        const monthsLeft = Math.max(1, Math.ceil((due - period.start) / AVG_MONTH_MS));
        plan.planned = remainingAtStart / monthsLeft;
        plan.afterSkip = Math.max(0, remaining) / Math.max(1, monthsLeft - 1);
      }
    } else if (goal.monthlyAmount) {
      plan.planned = Math.min(goal.monthlyAmount, Math.max(0, remainingAtStart));
      plan.afterSkip = goal.monthlyAmount;
    }

    plan.committed = skip ? Math.max(0, savedThisPeriod) : Math.max(plan.planned, savedThisPeriod);
    plan.projection = isDone(goal) || plan.overdue ? null : projectGoal(goal, plan, period);
    return plan;
  }

  function addMonths(d, n) {
    return new Date(d.getFullYear(), d.getMonth() + n, 1);
  }

  function projectGoal(goal, plan, period) {
    const today = startOfToday();

    // With a deadline: compare where the goal stood when this pay period began against a steady line from
    // the day it was made to the target date. Using the start of the period means this month's saving (or
    // not having done it yet) doesn't move it; only earlier months falling short or getting ahead do.
    // Gaps under half a month's share count as on schedule.
    if (goal.targetDate) {
      const created = goal.createdAt ? new Date(goal.createdAt) : null;
      const due = parseLocalDate(goal.targetDate);
      if (!created || due <= created) return null;
      const expected = goal.target * Math.min(1, Math.max(0, (period.start - created) / (due - created)));
      const savedAtStart = goal.saved - plan.savedThisPeriod;
      const diff = savedAtStart - expected;
      const monthlyShare = goal.target / Math.max(1, (due - created) / AVG_MONTH_MS);
      if (Math.abs(diff) < Math.max(1, monthlyShare / 2)) return { text: 'On schedule', tone: 'good' };
      return diff > 0
        ? { text: `${formatMoney(diff)} ahead of schedule`, tone: 'good' }
        : { text: `${formatMoney(-diff)} behind schedule`, tone: 'behind' };
    }

    // With a monthly amount: count the periods still needed, this one included if its amount isn't in yet.
    if (goal.monthlyAmount) {
      const thisPeriodLeft = plan.skip ? 0 : Math.max(0, plan.planned - Math.max(0, plan.savedThisPeriod));
      const after = plan.remaining - thisPeriodLeft;
      const months = after <= 0 ? 0 : Math.ceil(after / goal.monthlyAmount);
      return { text: `Done around ${monthShort(addMonths(period.end, months))} at ${formatMoney(goal.monthlyAmount)}/mo`, tone: 'neutral' };
    }

    // Neither: extrapolate from the average since the goal was made, once there's a month of history.
    if (goal.createdAt && goal.saved > 0) {
      const months = (today - new Date(goal.createdAt)) / AVG_MONTH_MS;
      if (months < 1) return null;
      const rate = goal.saved / months;
      return { text: `Done around ${monthShort(addMonths(today, Math.ceil(plan.remaining / rate)))} at your average ${formatMoney(rate)}/mo`, tone: 'neutral' };
    }
    return null;
  }

  return {
    FREQUENCY_LABELS, PER_MONTH, AVG_MONTH_MS,
    parseLocalDate, toISODate, startOfToday, addDays, lastDayOfMonth, monthShort,
    occurrence, occurrencesFrom, occurrencesBetween, nextDue, trackFrom, monthlyAverage,
    currentPayPeriod, formatMoney, pctOf, isDone, goalPlan
  };
});

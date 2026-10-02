-- Ledger migration 001
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Run it BEFORE deploying the matching index.html / widget: the new code expects these columns and tables.
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Keep goals.saved in step with deposits, inside the database.
--    Previously the app inserted a deposit and then wrote the new total as a second request, so a dropped
--    connection between the two (or two devices saving at once) left the total wrong. Now the deposit
--    write itself adjusts the total, atomically, and the app no longer writes `saved` at all.
-- ---------------------------------------------------------------------------
create or replace function public.apply_deposit_to_goal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.goals set saved = saved - old.amount where id = old.goal_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    update public.goals set saved = saved + new.amount where id = new.goal_id;
  end if;
  return null;
end;
$$;

drop trigger if exists deposits_apply_to_goal on public.deposits;
create trigger deposits_apply_to_goal
  after insert or update of amount, goal_id or delete on public.deposits
  for each row execute function public.apply_deposit_to_goal();

-- Optional: check whether any goal's total has already drifted from its deposit history.
--   select g.name, g.saved, coalesce(sum(d.amount), 0) as from_deposits
--   from public.goals g left join public.deposits d on d.goal_id = g.id
--   group by g.id having g.saved <> coalesce(sum(d.amount), 0);
-- If it lists anything and the deposit history is right, reset the totals from it:
--   update public.goals g set saved = coalesce((select sum(amount) from public.deposits d where d.goal_id = g.id), 0);

-- ---------------------------------------------------------------------------
-- 2. Archiving goals and bills (and income sources, which live in bills).
-- ---------------------------------------------------------------------------
alter table public.goals add column if not exists archived boolean not null default false;
alter table public.bills add column if not exists archived boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3. Budgets: a monthly allowance per spending category, and the spends logged against it.
-- ---------------------------------------------------------------------------
create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  amount numeric(12, 2) not null check (amount > 0),
  sort_order integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.spends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  budget_id uuid not null references public.budgets (id) on delete cascade,
  amount numeric(12, 2) not null,
  note text,
  spent_on date not null default current_date,
  created_at timestamptz not null default now()
);

create index if not exists spends_budget_id_idx on public.spends (budget_id);
create index if not exists spends_user_spent_on_idx on public.spends (user_id, spent_on);

alter table public.budgets enable row level security;
alter table public.spends enable row level security;

drop policy if exists "Own budgets" on public.budgets;
create policy "Own budgets" on public.budgets
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Own spends" on public.spends;
create policy "Own spends" on public.spends
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.budgets, public.spends to authenticated;

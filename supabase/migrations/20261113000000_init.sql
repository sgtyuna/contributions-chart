-- Family Contributions Chart: database setup.
-- One Supabase project = one family. Everyone signed in to the family
-- account can read and write the shared lists. The Mom PIN and the
-- "This one feels hard" flags are only reachable through PIN-checked
-- functions below.

create extension if not exists pgcrypto with schema extensions;

-- People who tap their name. The kids' names are typed in on first run
-- and live only here, never in the app's code.
create table public.people (
  id   text primary key,
  name text not null,
  role text not null check (role in ('kid', 'mom')),
  sort int  not null default 0
);

-- One row of family settings.
create table public.settings (
  id         int primary key default 1 check (id = 1),
  timezone   text not null default 'America/New_York',
  reset_day  int  not null default 1 check (reset_day between 0 and 6), -- 0 = Sunday, 1 = Monday
  seeded     boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);

-- Words the app shows (welcome line, gentle notes...). Editable by Mom.
create table public.texts (
  key   text primary key,
  value text not null default ''
);

-- Each boy's contributions.
create table public.contributions (
  id         uuid primary key default gen_random_uuid(),
  person_id  text not null references public.people(id),
  name       text not null,
  why        text not null default '',
  thanks     text not null default '',
  icon       text not null default '',
  kind       text not null check (kind in ('daily', 'weekly', 'once')),
  weekday    int  check (weekday between 0 and 6), -- weekly only; null = any day of the week
  sort       int  not null default 0,
  created_at timestamptz not null default now()
);

-- Dated history of check-offs. Clearing a list never touches this table;
-- a new day or week simply has no row yet. Un-checking deletes the row.
create table public.checkoffs (
  id              uuid primary key,
  contribution_id uuid references public.contributions(id) on delete set null,
  person_id       text not null references public.people(id),
  kind            text not null check (kind in ('daily', 'weekly', 'once')),
  period          text not null, -- the day (daily) or the week's first day (weekly, once)
  day             date not null, -- family-timezone date it was checked
  week_start      date not null,
  name            text not null, -- kept so history reads right even if the contribution changes
  icon            text not null default '',
  checked_at      timestamptz not null default now(),
  unique (contribution_id, period)
);
create index checkoffs_week on public.checkoffs (week_start);

-- Idea list: contributions not on anyone's list yet.
create table public.ideas (
  id       uuid primary key default gen_random_uuid(),
  category text not null default '',
  name     text not null,
  why      text not null default '',
  thanks   text not null default '',
  icon     text not null default '',
  kind     text not null default 'weekly' check (kind in ('daily', 'weekly', 'once')),
  sort     int  not null default 0
);

-- Requests from the boys: suggest a new one, ask for an idea, or trade.
create table public.requests (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('suggest', 'idea', 'trade')),
  from_person       text not null references public.people(id),
  status            text not null default 'pending' check (status in ('pending', 'approved', 'not_this_time')),
  name              text,
  why               text,
  icon              text,
  contribution_kind text check (contribution_kind in ('daily', 'weekly', 'once')),
  idea_id           uuid references public.ideas(id) on delete set null,
  to_person         text references public.people(id),
  give_id           uuid references public.contributions(id) on delete set null,
  take_id           uuid references public.contributions(id) on delete set null,
  partner           text check (partner in ('waiting', 'agreed', 'declined')),
  created_at        timestamptz not null default now(),
  answered_at       timestamptz
);

-- Family meeting note, one per week.
create table public.weekly_notes (
  week_start date primary key,
  note       text not null default '',
  updated_at timestamptz not null default now()
);

-- Private: "This one feels hard." Nobody can read this table directly.
create table public.hard_flags (
  id              uuid primary key default gen_random_uuid(),
  contribution_id uuid references public.contributions(id) on delete set null,
  person_id       text not null references public.people(id),
  name            text not null,
  created_at      timestamptz not null default now(),
  unique (contribution_id)
);

-- Private: Mom's PIN (stored as a one-way hash).
create table public.mom_pin (
  id       int primary key default 1 check (id = 1),
  pin_hash text not null
);

-- Row-level security: signed-in family only.
alter table public.people        enable row level security;
alter table public.settings      enable row level security;
alter table public.texts         enable row level security;
alter table public.contributions enable row level security;
alter table public.checkoffs     enable row level security;
alter table public.ideas         enable row level security;
alter table public.requests      enable row level security;
alter table public.weekly_notes  enable row level security;
alter table public.hard_flags    enable row level security;
alter table public.mom_pin       enable row level security;

create policy family_all on public.people        for all to authenticated using (true) with check (true);
create policy family_read on public.settings     for select to authenticated using (true);
create policy family_edit on public.settings     for update to authenticated using (true) with check (true);
create policy family_all on public.texts         for all to authenticated using (true) with check (true);
create policy family_all on public.contributions for all to authenticated using (true) with check (true);
create policy family_all on public.checkoffs     for all to authenticated using (true) with check (true);
create policy family_all on public.ideas         for all to authenticated using (true) with check (true);
create policy family_all on public.requests      for all to authenticated using (true) with check (true);
create policy family_all on public.weekly_notes  for all to authenticated using (true) with check (true);
-- hard_flags: a boy can add a flag, nobody can read it except through mom_hard_flags().
create policy family_flag on public.hard_flags   for insert to authenticated with check (true);
-- mom_pin: no policies, so no direct access at all.

revoke all on public.hard_flags from anon;
revoke all on public.mom_pin from anon, authenticated;
revoke select, update, delete on public.hard_flags from authenticated;

-- PIN helpers ----------------------------------------------------------

create function public.pin_ok(pin text) returns boolean
language sql security definer set search_path = public, extensions stable as $$
  select exists (select 1 from public.mom_pin where pin_hash = extensions.crypt(pin, pin_hash));
$$;
revoke execute on function public.pin_ok(text) from public, anon, authenticated;

create function public.pin_is_set() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.mom_pin);
$$;

create function public.check_pin(pin text) returns boolean
language sql security definer set search_path = public, extensions stable as $$
  select public.pin_ok(pin);
$$;

-- First use: old_pin is ignored when no PIN exists yet.
create function public.set_pin(old_pin text, new_pin text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new_pin is null or new_pin !~ '^[0-9]{4,8}$' then
    raise exception 'PIN must be 4 to 8 numbers';
  end if;
  if exists (select 1 from public.mom_pin) and not public.pin_ok(old_pin) then
    return false;
  end if;
  insert into public.mom_pin (id, pin_hash) values (1, extensions.crypt(new_pin, extensions.gen_salt('bf')))
  on conflict (id) do update set pin_hash = excluded.pin_hash;
  return true;
end $$;

create function public.mom_hard_flags(pin text)
returns table (id uuid, person_id text, name text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.pin_ok(pin) then raise exception 'PIN needed'; end if;
  return query select f.id, f.person_id, f.name, f.created_at from public.hard_flags f order by f.created_at;
end $$;

create function public.clear_hard_flag(pin text, flag_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.pin_ok(pin) then raise exception 'PIN needed'; end if;
  delete from public.hard_flags where id = flag_id;
end $$;

-- A boy taps "This one feels hard". Safe to tap twice.
create function public.flag_hard(contribution uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.hard_flags (contribution_id, person_id, name)
  select c.id, c.person_id, c.name from public.contributions c where c.id = contribution
  on conflict (contribution_id) do nothing;
end $$;

-- Mom answers a request. Trades only go through once the other boy agreed.
create function public.answer_request(pin text, request_id uuid, yes boolean) returns text
language plpgsql security definer set search_path = public as $$
declare
  r public.requests;
  i public.ideas;
  g public.contributions;
  t public.contributions;
begin
  if not public.pin_ok(pin) then raise exception 'PIN needed'; end if;
  select * into r from public.requests where id = request_id for update;
  if r.id is null or r.status <> 'pending' then return 'gone'; end if;

  if not yes then
    update public.requests set status = 'not_this_time', answered_at = now() where id = r.id;
    return 'not_this_time';
  end if;

  if r.kind = 'suggest' then
    insert into public.contributions (person_id, name, why, thanks, icon, kind, sort)
    values (r.from_person, r.name, coalesce(r.why, ''), '', coalesce(r.icon, ''),
            coalesce(r.contribution_kind, 'weekly'),
            (select coalesce(max(sort), 0) + 1 from public.contributions where person_id = r.from_person));
  elsif r.kind = 'idea' then
    select * into i from public.ideas where id = r.idea_id;
    if i.id is null then return 'gone'; end if;
    insert into public.contributions (person_id, name, why, thanks, icon, kind, sort)
    values (r.from_person, i.name, i.why, i.thanks, i.icon, i.kind,
            (select coalesce(max(sort), 0) + 1 from public.contributions where person_id = r.from_person));
  elsif r.kind = 'trade' then
    if r.partner is distinct from 'agreed' then return 'waiting'; end if;
    select * into g from public.contributions where id = r.give_id for update;
    select * into t from public.contributions where id = r.take_id for update;
    if g.id is null or t.id is null or g.person_id <> r.from_person or t.person_id <> r.to_person then
      return 'gone';
    end if;
    update public.contributions set person_id = r.to_person where id = g.id;
    update public.contributions set person_id = r.from_person where id = t.id;
  end if;

  update public.requests set status = 'approved', answered_at = now() where id = r.id;
  return 'approved';
end $$;

-- Starter content goes in once, on first run. Later loads never overwrite edits.
create function public.seed_family(payload jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  s public.settings;
  kid jsonb;
  item jsonb;
  n int;
begin
  select * into s from public.settings where id = 1 for update;
  if s.seeded then return false; end if;

  insert into public.people (id, name, role, sort)
  select p->>'id', p->>'name', p->>'role', ord
  from jsonb_array_elements(payload->'people') with ordinality as x(p, ord)
  on conflict (id) do nothing;

  insert into public.texts (key, value)
  select key, value #>> '{}' from jsonb_each(payload->'texts')
  on conflict (key) do nothing;

  for kid in select p from jsonb_array_elements(payload->'people') p where p->>'role' = 'kid' loop
    n := 0;
    for item in select jsonb_array_elements(payload->'starter') loop
      n := n + 1;
      insert into public.contributions (person_id, name, why, thanks, icon, kind, weekday, sort)
      values (kid->>'id', item->>'name', item->>'why', item->>'thanks', coalesce(item->>'icon', ''),
              item->>'kind', (item->>'weekday')::int, n);
    end loop;
  end loop;

  n := 0;
  for item in select jsonb_array_elements(payload->'ideas') loop
    n := n + 1;
    insert into public.ideas (category, name, why, thanks, icon, kind, sort)
    values (coalesce(item->>'category', ''), item->>'name', item->>'why', item->>'thanks',
            coalesce(item->>'icon', ''), coalesce(item->>'kind', 'weekly'), n);
  end loop;

  update public.settings set seeded = true, updated_at = now() where id = 1;
  return true;
end $$;

-- Keep-awake ping for the free plan (a daily GitHub Action calls this).
create function public.ping() returns int
language sql security definer set search_path = public stable as $$
  select count(*)::int from public.settings;
$$;
grant execute on function public.ping() to anon;

revoke execute on function public.pin_is_set(), public.check_pin(text), public.set_pin(text, text),
  public.mom_hard_flags(text), public.clear_hard_flag(text, uuid), public.flag_hard(uuid),
  public.answer_request(text, uuid, boolean), public.seed_family(jsonb) from public, anon;
grant execute on function public.pin_is_set(), public.check_pin(text), public.set_pin(text, text),
  public.mom_hard_flags(text), public.clear_hard_flag(text, uuid), public.flag_hard(uuid),
  public.answer_request(text, uuid, boolean), public.seed_family(jsonb) to authenticated;

-- Live updates to every open device (hard_flags and mom_pin stay out).
alter publication supabase_realtime add table
  public.people, public.settings, public.texts, public.contributions,
  public.checkoffs, public.ideas, public.requests, public.weekly_notes;

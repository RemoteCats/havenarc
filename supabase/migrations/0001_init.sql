-- 0001_init.sql — core schema for enquiries, bookings and visitor chat.
--
-- Guarded and re-runnable: every object is created with `if not exists`, a
-- `duplicate_object` catch, or a `drop ... if exists` first, so applying this
-- file twice is a no-op rather than an error.
--
-- Wrapped in a transaction on purpose. Every policy below is written as
-- `drop policy if exists` followed by `create policy`, which is the only way to
-- make a policy definition re-runnable, and it leaves a window: a run that stops
-- between the two, because the editor timed out or a later statement failed,
-- destroys a working policy and does not put it back. Re-running a migration to
-- repair the schema could then be what breaks it. Inside a transaction the run
-- either fully applies or changes nothing at all.

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Admins
-- ---------------------------------------------------------------------------

create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

-- SECURITY DEFINER so policies on other tables can ask "is the caller staff?"
-- without the read of `admins` itself being filtered by the policies on
-- `admins` — which is what would otherwise recurse.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated, service_role;

-- A signed-in user may read their own row (that is how the dashboard decides
-- whether to show the "not on the admin list" notice); admins may read all.
drop policy if exists admins_select_self on public.admins;
create policy admins_select_self on public.admins
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists admins_select_all on public.admins;
create policy admins_select_all on public.admins
  for select to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.item_status as enum ('new', 'in_progress', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.booking_status as enum ('new', 'confirmed', 'completed', 'cancelled');
exception when duplicate_object then null; end $$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enquiries — written only by the server function holding the service role.
-- No anon policy exists, so a leaked anon key cannot stuff the inbox.
-- ---------------------------------------------------------------------------

create table if not exists public.enquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  email text not null,
  phone text,
  subject text,
  scope text,
  status public.item_status not null default 'new',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.enquiries enable row level security;

create index if not exists enquiries_created_at_idx on public.enquiries (created_at desc);

drop trigger if exists enquiries_touch_updated_at on public.enquiries;
create trigger enquiries_touch_updated_at
  before update on public.enquiries
  for each row execute function public.touch_updated_at();

drop policy if exists enquiries_admin_select on public.enquiries;
create policy enquiries_admin_select on public.enquiries
  for select to authenticated
  using (public.is_admin());

drop policy if exists enquiries_admin_update on public.enquiries;
create policy enquiries_admin_update on public.enquiries
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Bookings — same shape: service-role writes, admin reads.
-- ---------------------------------------------------------------------------

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  patient_name text not null,
  email text not null,
  phone text,
  service text not null,
  preferred_date date not null,
  preferred_time text not null,
  notes text,
  status public.booking_status not null default 'new',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bookings enable row level security;

create index if not exists bookings_created_at_idx on public.bookings (created_at desc);

drop trigger if exists bookings_touch_updated_at on public.bookings;
create trigger bookings_touch_updated_at
  before update on public.bookings
  for each row execute function public.touch_updated_at();

drop policy if exists bookings_admin_select on public.bookings;
create policy bookings_admin_select on public.bookings
  for select to authenticated
  using (public.is_admin());

drop policy if exists bookings_admin_update on public.bookings;
create policy bookings_admin_update on public.bookings
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Chat — written from the browser under the visitor's own anonymous session,
-- because RLS can express "your own session" precisely.
-- ---------------------------------------------------------------------------

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null default auth.uid(),
  visitor_name text,
  visitor_email text,
  last_message_at timestamptz not null default now(),
  status public.item_status not null default 'new',
  created_at timestamptz not null default now()
);

alter table public.chat_sessions enable row level security;
alter table public.chat_sessions replica identity full;

create index if not exists chat_sessions_visitor_idx on public.chat_sessions (visitor_id);
create index if not exists chat_sessions_last_message_idx on public.chat_sessions (last_message_at desc);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  sender text not null check (sender in ('visitor', 'agent')),
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

alter table public.chat_messages enable row level security;
alter table public.chat_messages replica identity full;

create index if not exists chat_messages_session_idx on public.chat_messages (session_id, created_at);

-- Visitor policies. `auth.uid()` is a real user id because the widget calls
-- signInAnonymously(); there is no bearer-token scheme to forge.
drop policy if exists chat_sessions_visitor_insert on public.chat_sessions;
create policy chat_sessions_visitor_insert on public.chat_sessions
  for insert to authenticated
  with check (visitor_id = auth.uid());

drop policy if exists chat_sessions_visitor_select on public.chat_sessions;
create policy chat_sessions_visitor_select on public.chat_sessions
  for select to authenticated
  using (visitor_id = auth.uid());

drop policy if exists chat_sessions_admin_select on public.chat_sessions;
create policy chat_sessions_admin_select on public.chat_sessions
  for select to authenticated
  using (public.is_admin());

drop policy if exists chat_sessions_admin_update on public.chat_sessions;
create policy chat_sessions_admin_update on public.chat_sessions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists chat_messages_visitor_insert on public.chat_messages;
create policy chat_messages_visitor_insert on public.chat_messages
  for insert to authenticated
  with check (
    sender = 'visitor'
    and exists (
      select 1 from public.chat_sessions s
      where s.id = chat_messages.session_id and s.visitor_id = auth.uid()
    )
  );

drop policy if exists chat_messages_visitor_select on public.chat_messages;
create policy chat_messages_visitor_select on public.chat_messages
  for select to authenticated
  using (
    exists (
      select 1 from public.chat_sessions s
      where s.id = chat_messages.session_id and s.visitor_id = auth.uid()
    )
  );

drop policy if exists chat_messages_admin_select on public.chat_messages;
create policy chat_messages_admin_select on public.chat_messages
  for select to authenticated
  using (public.is_admin());

drop policy if exists chat_messages_admin_insert on public.chat_messages;
create policy chat_messages_admin_insert on public.chat_messages
  for insert to authenticated
  with check (sender = 'agent' and public.is_admin());

-- A visitor writing to a conversation staff had closed reopens it, so a
-- follow-up is never missed. An agent reply leaves the status alone.
-- SECURITY DEFINER because the visitor has no update policy on chat_sessions.
create or replace function public.touch_chat_session()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.chat_sessions
     set last_message_at = new.created_at,
         status = case when new.sender = 'visitor' then 'new'::public.item_status else status end
   where id = new.session_id;
  return null;
end;
$$;

drop trigger if exists chat_messages_touch_session on public.chat_messages;
create trigger chat_messages_touch_session
  after insert on public.chat_messages
  for each row execute function public.touch_chat_session();

-- ---------------------------------------------------------------------------
-- Grants. RLS still decides every row; these only open the door.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;
grant select on public.admins to authenticated;
grant select, update on public.enquiries to authenticated;
grant select, update on public.bookings to authenticated;
grant select, insert, update on public.chat_sessions to authenticated;
grant select, insert on public.chat_messages to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime. Guarded on pg_publication_tables so re-running is safe.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array array['chat_sessions', 'chat_messages', 'bookings'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

commit;

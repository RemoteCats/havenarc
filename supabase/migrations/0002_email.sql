-- 0002_email.sql — inbound/outbound email threads.
--
-- Optional: only needed to receive mail through the Resend inbound webhook.
-- Everything here is written by the server route holding the service role, so
-- there is no insert policy at all.
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

do $$ begin
  create type public.item_status as enum ('new', 'in_progress', 'closed');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Threads, keyed per correspondent rather than per mailbox.
-- ---------------------------------------------------------------------------

create table if not exists public.email_threads (
  id uuid primary key default gen_random_uuid(),
  subject text not null default '',
  participant_email text not null,
  participant_name text,
  last_message_at timestamptz not null default now(),
  status public.item_status not null default 'new',
  created_at timestamptz not null default now()
);

alter table public.email_threads enable row level security;
alter table public.email_threads replica identity full;

-- A reply carrying no In-Reply-To header still has to find its thread, so the
-- lookup key is the correspondent plus the subject with `Re:`/`Fwd:` already
-- stripped by the caller.
create index if not exists email_threads_participant_subject_idx
  on public.email_threads (lower(participant_email), lower(subject));

create index if not exists email_threads_last_message_idx
  on public.email_threads (last_message_at desc);

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.email_threads (id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_email text not null,
  from_name text,
  to_email text,
  subject text,
  body_text text,
  body_html text,
  message_id text,
  in_reply_to text,
  has_attachments boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.email_messages enable row level security;
alter table public.email_messages replica identity full;

create index if not exists email_messages_thread_idx
  on public.email_messages (thread_id, created_at);

-- Inbound webhooks retry. Filing the same mail twice would duplicate the
-- conversation, so the provider's message id is unique when present.
create unique index if not exists email_messages_message_id_key
  on public.email_messages (message_id)
  where message_id is not null;

-- ---------------------------------------------------------------------------
-- Policies: admin-only read. No insert policy — the service role writes.
-- ---------------------------------------------------------------------------

drop policy if exists email_threads_admin_select on public.email_threads;
create policy email_threads_admin_select on public.email_threads
  for select to authenticated
  using (public.is_admin());

drop policy if exists email_threads_admin_update on public.email_threads;
create policy email_threads_admin_update on public.email_threads
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists email_messages_admin_select on public.email_messages;
create policy email_messages_admin_select on public.email_messages
  for select to authenticated
  using (public.is_admin());

grant select, update on public.email_threads to authenticated;
grant select on public.email_messages to authenticated;

-- ---------------------------------------------------------------------------
-- Touch trigger, driven by inbound mail only.
-- ---------------------------------------------------------------------------

create or replace function public.touch_email_thread()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.email_threads
     set last_message_at = new.created_at,
         status = case when new.direction = 'inbound' then 'new'::public.item_status else status end
   where id = new.thread_id;
  return null;
end;
$$;

drop trigger if exists email_messages_touch_thread on public.email_messages;
create trigger email_messages_touch_thread
  after insert on public.email_messages
  for each row execute function public.touch_email_thread();

-- ---------------------------------------------------------------------------
-- Realtime, guarded the same way as 0001.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array array['email_threads', 'email_messages'] loop
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

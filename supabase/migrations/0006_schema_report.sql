-- 0006_schema_report.sql — one place that knows what the schema should contain.
--
-- verify.sql used to carry these expectations on its own, which meant the only
-- way to find a missing policy was to remember to paste a file into the SQL
-- editor. A chat that has stopped accepting messages looks like a bug in the
-- widget, not like a policy that is no longer there, so /api/health now asks
-- this function and prints the answer.
--
-- SECURITY DEFINER because it reads the catalogs, and granted to service_role
-- only: it describes the shape of the schema, which is not something to hand
-- to the browser. Guarded and re-runnable like the rest.
--
-- Wrapped in a transaction on purpose. Every policy below is written as
-- `drop policy if exists` followed by `create policy`, which is the only way to
-- make a policy definition re-runnable, and it leaves a window: a run that stops
-- between the two, because the editor timed out or a later statement failed,
-- destroys a working policy and does not put it back. Re-running a migration to
-- repair the schema could then be what breaks it. Inside a transaction the run
-- either fully applies or changes nothing at all.

begin;

create or replace function public.schema_report()
returns text[]
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $fn$
declare
  problems text[] := '{}';
  has_email boolean;
  r record;

  -- expected: table name
  core_tables text[] := array[
    'admins', 'enquiries', 'bookings', 'chat_sessions', 'chat_messages', 'site_settings'
  ];
  email_tables text[] := array['email_threads', 'email_messages'];

  -- expected: table.policy
  core_policies text[] := array[
    'admins.admins_select_self',
    'admins.admins_select_all',
    'enquiries.enquiries_admin_select',
    'enquiries.enquiries_admin_update',
    'bookings.bookings_admin_select',
    'bookings.bookings_admin_update',
    'chat_sessions.chat_sessions_visitor_insert',
    'chat_sessions.chat_sessions_visitor_select',
    'chat_sessions.chat_sessions_admin_select',
    'chat_sessions.chat_sessions_admin_update',
    'chat_messages.chat_messages_visitor_insert',
    'chat_messages.chat_messages_visitor_select',
    'chat_messages.chat_messages_admin_select',
    'chat_messages.chat_messages_admin_insert',
    'site_settings.site_settings_public_select',
    'site_settings.site_settings_admin_update'
  ];
  email_policies text[] := array[
    'email_threads.email_threads_admin_select',
    'email_threads.email_threads_admin_update',
    'email_messages.email_messages_admin_select'
  ];

  -- expected: table.trigger
  core_triggers text[] := array[
    'enquiries.enquiries_touch_updated_at',
    'bookings.bookings_touch_updated_at',
    'chat_messages.chat_messages_touch_session',
    'site_settings.site_settings_touch_updated_at'
  ];
  email_triggers text[] := array['email_messages.email_messages_touch_thread'];

  core_realtime text[] := array['chat_sessions', 'chat_messages', 'bookings', 'site_settings'];
  email_realtime text[] := array['email_threads', 'email_messages'];

  -- expected: table.column, for columns added by a later migration
  core_columns text[] := array['site_settings.offices'];

  -- expected: role.privilege.table
  --
  -- A policy decides which rows a role may touch; a grant decides whether it may
  -- touch the table at all, and the two fail almost identically. Without the
  -- insert grant a visitor's message is refused with "permission denied for
  -- table chat_messages", which reads like the RLS refusal and was invisible
  -- here, because this function used to check policies and not grants.
  core_grants text[] := array[
    'authenticated.INSERT.chat_sessions',
    'authenticated.SELECT.chat_sessions',
    'authenticated.UPDATE.chat_sessions',
    'authenticated.INSERT.chat_messages',
    'authenticated.SELECT.chat_messages',
    'authenticated.SELECT.enquiries',
    'authenticated.UPDATE.enquiries',
    'authenticated.SELECT.bookings',
    'authenticated.UPDATE.bookings',
    'authenticated.SELECT.admins',
    'anon.SELECT.site_settings',
    'authenticated.SELECT.site_settings',
    'authenticated.UPDATE.site_settings'
  ];
  email_grants text[] := array[
    'authenticated.SELECT.email_threads',
    'authenticated.UPDATE.email_threads',
    'authenticated.SELECT.email_messages'
  ];

  core_functions text[] := array['is_admin', 'touch_updated_at', 'touch_chat_session'];
  core_types text[] := array['item_status', 'booking_status'];

  name text;
  parts text[];begin
  has_email := to_regclass('public.email_threads') is not null;

  -- Tables -------------------------------------------------------------
  foreach name in array (core_tables || case when has_email then email_tables else '{}'::text[] end) loop
    if to_regclass('public.' || quote_ident(name)) is null then
      problems := problems || format('missing table public.%s', name);
    elsif not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = name and c.relrowsecurity
    ) then
      problems := problems || format('row level security is OFF on public.%s', name);
    end if;
  end loop;

  -- Grants ---------------------------------------------------------------
  foreach name in array (core_grants || case when has_email then email_grants else '{}'::text[] end) loop
    parts := string_to_array(name, '.');
    if to_regclass('public.' || quote_ident(parts[3])) is not null and not exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = parts[3]
        and grantee = parts[1]
        and privilege_type = parts[2]
    ) then
      problems := problems || format('missing grant: %s on public.%s to %s', parts[2], parts[3], parts[1]);
    end if;
  end loop;

  -- Columns ------------------------------------------------------------
  foreach name in array core_columns loop
    parts := string_to_array(name, '.');
    if to_regclass('public.' || quote_ident(parts[1])) is not null and not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = parts[1] and column_name = parts[2]
    ) then
      problems := problems || format('missing column %s on public.%s', parts[2], parts[1]);
    end if;
  end loop;

  -- Types --------------------------------------------------------------
  foreach name in array core_types loop
    if to_regtype('public.' || quote_ident(name)) is null then
      problems := problems || format('missing type public.%s', name);
    end if;
  end loop;

  -- Functions ----------------------------------------------------------
  foreach name in array (core_functions || case when has_email then array['touch_email_thread'] else '{}'::text[] end) loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = name
    ) then
      problems := problems || format('missing function public.%s()', name);
    end if;
  end loop;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_admin' and p.prosecdef
  ) then
    problems := problems || 'public.is_admin() is not SECURITY DEFINER (policies will recurse on admins)';
  end if;

  -- Policies -----------------------------------------------------------
  foreach name in array (core_policies || case when has_email then email_policies else '{}'::text[] end) loop
    parts := string_to_array(name, '.');
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = parts[1] and policyname = parts[2]
    ) then
      problems := problems || format('missing policy %s on public.%s', parts[2], parts[1]);
    end if;
  end loop;

  -- enquiries and bookings must have NO policy granted to anon.
  for r in
    select tablename, policyname, roles
    from pg_policies
    where schemaname = 'public' and tablename in ('enquiries', 'bookings')
  loop
    if 'anon' = any (r.roles) or 'public' = any (r.roles) then
      problems := problems || format(
        'policy %s on public.%s is exposed to anon — form writes must go through the service role only',
        r.policyname, r.tablename
      );
    end if;
  end loop;

  -- Triggers -----------------------------------------------------------
  foreach name in array (core_triggers || case when has_email then email_triggers else '{}'::text[] end) loop
    parts := string_to_array(name, '.');
    if not exists (
      select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = parts[1] and t.tgname = parts[2] and not t.tgisinternal
    ) then
      problems := problems || format('missing trigger %s on public.%s', parts[2], parts[1]);
    end if;
  end loop;

  -- Realtime publication ------------------------------------------------
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    problems := problems || 'missing publication supabase_realtime';
  else
    foreach name in array (core_realtime || case when has_email then email_realtime else '{}'::text[] end) loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = name
      ) then
        problems := problems || format('public.%s is not in the supabase_realtime publication', name);
      end if;
    end loop;
  end if;

  return problems;
end;
$fn$;

revoke all on function public.schema_report() from public, anon, authenticated;
grant execute on function public.schema_report() to service_role;

commit;

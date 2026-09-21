-- 0003_site_settings.sql — contact details the studio can edit from /admin.
--
-- Guarded and re-runnable, like 0001 and 0002.
--
-- Unlike every other table here, this one IS publicly readable: it holds the
-- address block printed in the footer. Only admins may write it.
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

create table if not exists public.site_settings (
  id text primary key default 'default',
  email text not null default 'frontdesk@meastroarchitecture.com',
  website text not null default 'www.meastroarchitecture.com',
  hours text not null default 'Monday – Friday, 09:00 – 18:00',
  updated_at timestamptz not null default now(),
  constraint site_settings_single_row check (id = 'default')
);

alter table public.site_settings enable row level security;
alter table public.site_settings replica identity full;

-- Seed the single row. `on conflict do nothing` keeps edits across re-runs.
insert into public.site_settings (id) values ('default') on conflict (id) do nothing;

drop trigger if exists site_settings_touch_updated_at on public.site_settings;
create trigger site_settings_touch_updated_at
  before update on public.site_settings
  for each row execute function public.touch_updated_at();

-- Public read: this is the footer, not a secret.
drop policy if exists site_settings_public_select on public.site_settings;
create policy site_settings_public_select on public.site_settings
  for select to anon, authenticated
  using (true);

drop policy if exists site_settings_admin_update on public.site_settings;
create policy site_settings_admin_update on public.site_settings
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on public.site_settings to anon, authenticated;
grant update on public.site_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'site_settings'
  ) then
    alter publication supabase_realtime add table public.site_settings;
  end if;
end $$;

commit;

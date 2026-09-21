-- 0004_site_address.sql — the studio address, alongside the other editable
-- contact details. Guarded and re-runnable like the rest.
--
-- Wrapped in a transaction on purpose. Every policy below is written as
-- `drop policy if exists` followed by `create policy`, which is the only way to
-- make a policy definition re-runnable, and it leaves a window: a run that stops
-- between the two, because the editor timed out or a later statement failed,
-- destroys a working policy and does not put it back. Re-running a migration to
-- repair the schema could then be what breaks it. Inside a transaction the run
-- either fully applies or changes nothing at all.

begin;

alter table public.site_settings
  add column if not exists address text not null
  default '54-A Sager Dr, Rochester, NY 14607, United States';

-- Fill the existing row if it predates the column.
update public.site_settings
   set address = '54-A Sager Dr, Rochester, NY 14607, United States'
 where coalesce(address, '') = '';

commit;

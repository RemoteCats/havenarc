-- 0005_offices.sql — the studio's offices, one row each with a phone number.
--
-- Replaces the single `address` column added in 0004. That column is left in
-- place (dropping it would break a deployment still running the old bundle);
-- it is simply no longer read. Guarded and re-runnable like the rest.
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
  add column if not exists offices jsonb not null default '[
    {
      "label": "Rochester",
      "address": "54-A Sager Dr, Rochester, NY 14607, United States",
      "phone": "+1 929 647 6610"
    },
    {
      "label": "Jacksonville",
      "address": "5646 St Augustine Rd, Jacksonville, FL 32206, United States",
      "phone": "+1 945 216 0576"
    },
    {
      "label": "Richmond",
      "address": "13353 Commerce Parkway, Richmond, BC V6V 3A1, Canada",
      "phone": "+1 604 243 2243"
    }
  ]'::jsonb;

-- Must be a JSON array: the loader falls back to the built-in list for anything
-- else, and a constraint here is cheaper than discovering it in the footer.
alter table public.site_settings drop constraint if exists site_settings_offices_is_array;
alter table public.site_settings
  add constraint site_settings_offices_is_array
  check (jsonb_typeof(offices) = 'array');

-- Carry over a single address that was edited from /admin before this ran.
--
-- Adding a column with a default backfills every existing row, so the array is
-- never empty by the time we get here. The tell is that the first office still
-- holds the built-in Rochester address while `address` holds something else:
-- that is an edit, and it would otherwise be silently dropped. Once rewritten
-- the condition no longer matches, so re-running changes nothing.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'site_settings' and column_name = 'address'
  ) then
    update public.site_settings
       set offices = jsonb_set(offices, '{0,address}', to_jsonb(address))
     where coalesce(address, '') <> ''
       and address <> '54-A Sager Dr, Rochester, NY 14607, United States'
       and jsonb_array_length(offices) > 0
       and offices -> 0 ->> 'address' = '54-A Sager Dr, Rochester, NY 14607, United States';
  end if;
end $$;

-- 0003 seeded the hours with en dashes, which the studio has since dropped from
-- its copy. Only touch a row still carrying that exact string, so an edit made
-- from the dashboard survives.
update public.site_settings
   set hours = 'Monday to Friday, 09:00 to 18:00'
 where hours = 'Monday – Friday, 09:00 – 18:00';

alter table public.site_settings
  alter column hours set default 'Monday to Friday, 09:00 to 18:00';

commit;

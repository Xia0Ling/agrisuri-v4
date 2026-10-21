-- ============================================================================
-- Raise the account caps: farmer 50, admin 15, DA officer 15.
--
-- Paste into Supabase -> SQL Editor -> Run. Safe to re-run.
-- `sql/schema.sql` already contains this version; this file exists so the cap
-- change can be applied to a database that was created from the older schema.
-- ============================================================================

create or replace function public.enforce_role_cap()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  v_count int;
begin
  -- Serialise all role-cap checks for the duration of the transaction. Without
  -- this, two concurrent inserts can both read count = 49 and both succeed.
  perform pg_advisory_xact_lock(hashtext('agrisuri.role_cap'));

  if new.role = 'farmer' then
    select count(*) into v_count from public.profiles where role = 'farmer' and id <> new.id;
    if v_count >= 50 then
      raise exception 'Farmer account limit reached (maximum 50).' using errcode = 'check_violation';
    end if;
  elsif new.role = 'admin' then
    select count(*) into v_count from public.profiles where role = 'admin' and id <> new.id;
    if v_count >= 15 then
      raise exception 'Admin account limit reached (maximum 15).' using errcode = 'check_violation';
    end if;
  elsif new.role = 'da' then
    select count(*) into v_count from public.profiles where role = 'da' and id <> new.id;
    if v_count >= 15 then
      raise exception 'DA Officer account limit reached (maximum 15).' using errcode = 'check_violation';
    end if;
    if new.jurisdiction_id is null then
      raise exception 'A DA Officer must be assigned to a jurisdiction.' using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists role_cap on public.profiles;
create trigger role_cap before insert or update of role on public.profiles
  for each row execute function public.enforce_role_cap();

-- Verify
select
  'farmer' as role, 50 as cap union all
  select 'admin', 15 union all
  select 'da', 15;

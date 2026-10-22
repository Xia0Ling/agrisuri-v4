-- ============================================================================
-- Admin hard-delete of a scan record.
--
-- The RLS policy already lets an admin delete from `scans`, but a bare table
-- delete is invisible afterwards: no audit trail, and the photo is left behind
-- in storage. This RPC does all three things in one place.
--
-- Deleting the row cascades to scan_predictions and scan_feedback (both
-- declared ON DELETE CASCADE), so nothing is orphaned in the database.
--
-- Paste into Supabase -> SQL Editor -> Run. Safe to re-run.
-- ============================================================================

create or replace function public.admin_delete_scan(p_scan_id uuid)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_role text := public.my_role();
  v_path text;
begin
  if v_role <> 'admin' then
    raise exception 'Only an administrator can delete scan records';
  end if;

  select image_path into v_path from public.scans where id = p_scan_id;

  if not found then
    raise exception 'Scan not found';
  end if;

  -- Written before the delete so the audit row survives the cascade.
  insert into public.audit_events (actor_id, actor_role, action, target_type, target_id)
  values (auth.uid(), v_role, 'scan.delete', 'scan', p_scan_id::text);

  delete from public.scans where id = p_scan_id;

  -- The caller removes this object from storage; the client holds the session
  -- the storage policy checks against.
  return v_path;
end $$;

grant execute on function public.admin_delete_scan(uuid) to authenticated;

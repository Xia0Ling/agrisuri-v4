-- ============================================================================
-- Review workflow for farmer feedback.
--
-- A farmer saying "wrong" is a claim, not a fact. Before it becomes training
-- data, a DA officer (their own jurisdiction) or an admin checks that the
-- barangay on the scan is plausible and that the correction makes sense.
--
--   pending  -> sits in the Mail tab
--   approved -> appears in Training data, leaves the Mail tab
--   rejected -> dropped, image may be deleted
--
-- Paste into Supabase -> SQL Editor -> Run. Safe to re-run.
-- ============================================================================

alter table public.scan_feedback
  add column if not exists status text not null default 'pending',
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;

-- The inline default cannot carry a CHECK, so add it separately.
alter table public.scan_feedback
  drop constraint if exists scan_feedback_status_check;
alter table public.scan_feedback
  add constraint scan_feedback_status_check
  check (status in ('pending', 'approved', 'rejected'));

-- "Others" is a null corrected_code plus the farmer's own words. A wrong
-- verdict with no class and no explanation is useless for retraining, so the
-- database refuses it.
alter table public.scan_feedback
  drop constraint if exists scan_feedback_other_needs_reason;
alter table public.scan_feedback
  add constraint scan_feedback_other_needs_reason
  check (
    verdict <> 'wrong'
    or corrected_code is not null
    or (note is not null and length(btrim(note)) >= 4)
  );

create index if not exists scan_feedback_status_idx
  on public.scan_feedback (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Reviewers may change the review columns; a farmer may not.
-- RLS cannot restrict columns, so a trigger enforces it.
-- ---------------------------------------------------------------------------

create or replace function public.guard_feedback_review()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.my_role() in ('admin', 'da') then
    if new.status is distinct from old.status and new.status <> 'pending' then
      new.reviewed_by := coalesce(new.reviewed_by, auth.uid());
      new.reviewed_at := coalesce(new.reviewed_at, now());
    end if;
    return new;
  end if;

  -- Farmer editing their own verdict: any change sends it back for review.
  new.status      := 'pending';
  new.reviewed_by := null;
  new.reviewed_at := null;
  new.review_note := null;
  return new;
end $$;

drop trigger if exists scan_feedback_guard on public.scan_feedback;
create trigger scan_feedback_guard before update on public.scan_feedback
  for each row execute function public.guard_feedback_review();

-- ---------------------------------------------------------------------------
-- Policies: reviewers update within their scope
-- ---------------------------------------------------------------------------

drop policy if exists feedback_admin_update on public.scan_feedback;
create policy feedback_admin_update on public.scan_feedback
  for update to authenticated
  using (public.my_role() = 'admin')
  with check (public.my_role() = 'admin');

drop policy if exists feedback_da_update on public.scan_feedback;
create policy feedback_da_update on public.scan_feedback
  for update to authenticated
  using (
    public.my_role() = 'da'
    and exists (
      select 1 from public.scans s
      where s.id = scan_id and s.jurisdiction_id = public.my_jurisdiction()
    )
  )
  with check (
    public.my_role() = 'da'
    and exists (
      select 1 from public.scans s
      where s.id = scan_id and s.jurisdiction_id = public.my_jurisdiction()
    )
  );

-- Existing rows predate the workflow: they go into the queue.
update public.scan_feedback set status = 'pending' where status is null;

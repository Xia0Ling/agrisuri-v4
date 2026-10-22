-- ============================================================================
-- Rejection class for farmer submissions.
--
-- A reviewer rejecting a photo is not throwing it away. A leaf the model
-- misread, that a human says is "not a leaf" or "not a supported crop", is
-- exactly the negative example the gates need. Deleting it was wasteful.
--
--   not_leaf            -> the gates should have caught it, and did not
--   not_supported_crop -> the model answered for a crop it cannot handle
--
-- Paste into Supabase -> SQL Editor -> Run. Safe to re-run.
-- ============================================================================

alter table public.scan_feedback
  add column if not exists reject_class text;

alter table public.scan_feedback
  drop constraint if exists scan_feedback_reject_class_check;
alter table public.scan_feedback
  add constraint scan_feedback_reject_class_check
  check (reject_class is null or reject_class in ('not_leaf', 'not_supported_crop'));

-- A rejected row must say which negative class it belongs to; an approved row
-- must not. This keeps the export from guessing.
alter table public.scan_feedback
  drop constraint if exists scan_feedback_reject_needs_class;
alter table public.scan_feedback
  add constraint scan_feedback_reject_needs_class
  check (
    (status = 'rejected' and reject_class is not null)
    or (status <> 'rejected' and reject_class is null)
  );

create index if not exists scan_feedback_reject_idx
  on public.scan_feedback (reject_class)
  where reject_class is not null;

-- The existing guard resets review state for a farmer editing their own row.
-- It must clear reject_class too, or the constraint above rejects the update.
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

  new.status      := 'pending';
  new.reviewed_by := null;
  new.reviewed_at := null;
  new.review_note := null;
  new.reject_class := null;
  return new;
end $$;

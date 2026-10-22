-- ============================================================================
-- Scan feedback: the farmer tells us whether the model was right.
--
-- Why this exists: a model can be confidently wrong. Late blight and early
-- blight look alike at 512 px, and a softmax score of 0.94 is not evidence that
-- the answer is right. No UI change fixes that. Only more labelled data does.
--
-- Paste into Supabase -> SQL Editor -> Run. Safe to re-run.
-- ============================================================================

create table if not exists public.scan_feedback (
  scan_id        uuid primary key references public.scans(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  verdict        text not null check (verdict in ('correct', 'wrong', 'unsure')),
  -- diseases.code the farmer says it actually was. Only set when verdict='wrong'.
  corrected_code text,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists scan_feedback_user_idx    on public.scan_feedback (user_id, created_at desc);
create index if not exists scan_feedback_verdict_idx on public.scan_feedback (verdict, created_at desc);

alter table public.scan_feedback enable row level security;

-- A farmer may only speak about their own scans.
drop policy if exists feedback_own_read on public.scan_feedback;
create policy feedback_own_read on public.scan_feedback
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists feedback_own_insert on public.scan_feedback;
create policy feedback_own_insert on public.scan_feedback
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.scans s where s.id = scan_id and s.user_id = auth.uid())
  );

-- Upsert needs an UPDATE path as well, so a farmer can correct themselves.
drop policy if exists feedback_own_update on public.scan_feedback;
create policy feedback_own_update on public.scan_feedback
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Admin sees everything; a DA officer sees their own jurisdiction only.
drop policy if exists feedback_admin_read on public.scan_feedback;
create policy feedback_admin_read on public.scan_feedback
  for select to authenticated
  using (public.my_role() = 'admin');

drop policy if exists feedback_da_read on public.scan_feedback;
create policy feedback_da_read on public.scan_feedback
  for select to authenticated
  using (
    public.my_role() = 'da'
    and exists (
      select 1 from public.scans s
      where s.id = scan_id
        and s.jurisdiction_id = public.my_jurisdiction()
    )
  );

-- Rows are written through PostgREST upsert (on_conflict=scan_id).
grant select, insert, update on public.scan_feedback to authenticated;

-- Keep updated_at honest without a trigger function per table.
create or replace function public.touch_scan_feedback()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists scan_feedback_touch on public.scan_feedback;
create trigger scan_feedback_touch before update on public.scan_feedback
  for each row execute function public.touch_scan_feedback();

-- ---------------------------------------------------------------------------
-- Reporting: how often is the model wrong, and where does it confuse things?
-- ---------------------------------------------------------------------------

create or replace function public.analytics_feedback(p_limit int default 20)
returns table (
  predicted_code text,
  corrected_code text,
  times          bigint
)
language sql stable security definer set search_path = public, extensions as $$
  select s.top_label, f.corrected_code, count(*)::bigint
  from public.scan_feedback f
  join public.scans s on s.id = f.scan_id
  where f.verdict = 'wrong'
  group by s.top_label, f.corrected_code
  order by count(*) desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

grant execute on function public.analytics_feedback(int) to authenticated;

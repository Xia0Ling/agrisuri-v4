-- ============================================================================
-- Terms of use acceptance.
--
-- The app tells a farmer what a leaf probably has. That is a guess, and the
-- terms are the record that the farmer was told so before acting on it.
--
-- Stored per profile, with the version, so a future change to the wording can
-- be re-presented instead of silently inheriting consent for text nobody read.
--
-- Paste into Supabase -> SQL Editor -> Run. Safe to re-run.
-- ============================================================================

alter table public.profiles
  add column if not exists terms_version text,
  add column if not exists terms_accepted_at timestamptz;

/**
 * Record acceptance for the signed-in user. The version comes from the client
 * but the timestamp does not: a client could claim an old acceptance date.
 */
create or replace function public.accept_terms(p_version text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_version is null or length(btrim(p_version)) < 4 then
    raise exception 'A terms version is required';
  end if;

  update public.profiles
     set terms_version = p_version,
         terms_accepted_at = now()
   where id = auth.uid();
end $$;

grant execute on function public.accept_terms(text) to authenticated;

-- ============================================================================
-- AgriSuri — one-time reset of the v3 schema
--
-- ██  THIS IS DESTRUCTIVE. IT DELETES THE v3 TABLES AND ALL ROWS IN THEM.  ██
--
-- Only run this if you are upgrading from the v3 prototype and you accept losing
-- whatever is in `profiles`, `scans` and `role_keys`. In the reference project
-- those three tables are empty, which is why the upgrade is safe there.
--
-- Check before you run it:
--   select count(*) from public.profiles;   -- should be 0
--   select count(*) from public.scans;      -- should be 0
--
-- If either count is non-zero and you care about the data, export it first:
--   Supabase Dashboard -> Table Editor -> Export as CSV
--
-- Then run sql/schema.sql. Do not re-run this file afterwards.
-- ============================================================================

begin;

-- Triggers on auth.users
drop trigger if exists on_signup on auth.users;

-- Policies (dropping the table removes them, but storage policies are separate)
drop policy if exists "upload own images" on storage.objects;
drop policy if exists "read own or staff"   on storage.objects;

-- Tables (scan_predictions and the rest did not exist in v3)
drop table if exists public.scan_predictions   cascade;
drop table if exists public.audit_events       cascade;
drop table if exists public.staff_invites      cascade;
drop table if exists public.training_candidates cascade;
drop table if exists public.diseases           cascade;
drop table if exists public.crop_types         cascade;
drop table if exists public.barangays          cascade;
drop table if exists public.jurisdictions      cascade;
drop table if exists public.role_keys          cascade;
drop table if exists public.scans              cascade;
drop table if exists public.profiles           cascade;

-- Functions
drop function if exists public.enforce_role_cap()            cascade;
drop function if exists public.handle_new_user()             cascade;
drop function if exists public.my_role()                     cascade;
drop function if exists public.my_jurisdiction()             cascade;
drop function if exists public.my_barangay()                 cascade;
drop function if exists public.verify_staff_login(text, text) cascade;
drop function if exists public.touch_updated_at()            cascade;

commit;

-- Next: run sql/schema.sql, then follow SETUP.md to bootstrap the first admin.

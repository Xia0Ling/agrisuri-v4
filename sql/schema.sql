-- ============================================================================
-- AgriSuri — consolidated schema, RLS, and RPCs
-- Supabase / PostgreSQL 15+
-- Run once in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- Design notes
--  * Role is NEVER read from client-supplied metadata unless a valid one-time
--    staff invite is presented. Farmers self-register; staff do not.
--  * Jurisdiction is derived server-side from the farmer's barangay. A client
--    cannot inject a scan into another jurisdiction.
--  * Account caps are enforced inside a trigger that takes a transaction-scoped
--    advisory lock, so concurrent signups cannot race past the limit.
--  * Coordinates are stored rounded to 3 decimals (~110 m) — enough for
--    barangay analytics, deliberately not enough to identify a household.
--  * Analytics are computed in SQL (invoker rights) so RLS scoping applies
--    automatically and the client never receives rows it may not see.
-- ============================================================================

create extension if not exists pgcrypto;

-- Supabase installs pgcrypto into the `extensions` schema, not `public`. Every
-- function below pins its search_path (required for SECURITY DEFINER), so the
-- schema has to be listed explicitly or digest()/gen_random_bytes() will not
-- resolve. Adding a schema that does not exist is harmless.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    raise exception 'pgcrypto is missing. Run: create extension pgcrypto;';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Version guard
--
-- v3 created `scans` with different columns. `create table if not exists` would
-- silently keep that shape and every RPC below would fail at runtime. Fail loudly
-- instead, before anything is half-migrated.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'scans' and column_name = 'top_disease'
  ) then
    raise exception
      'Legacy v3 schema detected. Run sql/reset.sql first (it drops the empty v3 tables).';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Reference data: jurisdictions / barangays / crops / diseases
-- ---------------------------------------------------------------------------

create table if not exists public.jurisdictions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  province    text,
  region      text,
  created_at  timestamptz not null default now()
);

create table if not exists public.barangays (
  id              uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null references public.jurisdictions(id) on delete cascade,
  name            text not null,
  unique (jurisdiction_id, name)
);

create table if not exists public.crop_types (
  code      text primary key,
  name      text not null,
  is_active boolean not null default true
);

create table if not exists public.diseases (
  id            uuid primary key default gen_random_uuid(),
  crop_code     text not null references public.crop_types(code) on delete cascade,
  code          text not null unique,
  name          text not null,
  is_healthy    boolean not null default false,
  severity      text check (severity in ('low', 'moderate', 'high')),
  symptoms      text,
  treatment     text,
  prevention    text,
  safety        text,
  source        text,
  created_at    timestamptz not null default now()
);

insert into public.crop_types (code, name) values
  ('tomato', 'Tomato'),
  ('palay',  'Palay (Rice)')
on conflict (code) do nothing;

-- Seed the pilot municipality. Extend this list for other LGUs.
insert into public.jurisdictions (name, province, region)
values ('Peñaranda', 'Nueva Ecija', 'Central Luzon')
on conflict (name) do nothing;

insert into public.barangays (jurisdiction_id, name)
select j.id, b.name
from public.jurisdictions j
cross join (values
  ('Callos'), ('Las Piñas'), ('Poblacion I'), ('Poblacion II'), ('Poblacion III'),
  ('Poblacion IV'), ('San Josef'), ('San Mariano'), ('Santo Tomas'), ('Sinasajan')
) as b(name)
where j.name = 'Peñaranda'
on conflict (jurisdiction_id, name) do nothing;

insert into public.diseases (crop_code, code, name, is_healthy, severity, symptoms, treatment, prevention, safety, source) values
  ('tomato','tomato_healthy','Healthy',true,null,
   'Uniform green foliage, no lesions, no yellowing.',
   'No treatment required.',
   'Continue weekly scouting and balanced fertilisation.',
   'No chemical action needed.',
   'Cornell Vegetable MD Online'),
  ('tomato','tomato_early_blight','Early Blight (Alternaria solani)',false,'moderate',
   'Dark brown lesions with concentric rings ("target spots"), usually starting on older lower leaves; yellowing around lesions.',
   'Remove and destroy badly infected lower leaves. Apply a registered chlorothalonil- or mancozeb-based fungicide following the product label. Repeat per label interval while conditions stay humid.',
   'Rotate away from tomato/potato for 2-3 seasons, stake plants for airflow, mulch to stop soil splash, water at the base not overhead.',
   'Wear gloves and a mask when spraying. Observe the pre-harvest interval on the label.',
   'Cornell Vegetable MD Online'),
  ('tomato','tomato_late_blight','Late Blight (Phytophthora infestans)',false,'high',
   'Water-soaked grey-green patches turning brown-black, white fuzzy mould on the underside in humid weather, rapid collapse of the plant.',
   'Act immediately: uproot and destroy infected plants (do not compost). Apply a registered protective fungicide to surrounding plants. Notify neighbouring farms — this spreads fast.',
   'Use certified disease-free seed, avoid overhead irrigation, keep rows ventilated, destroy volunteer tomato/potato plants.',
   'Highly contagious to other farms. Disinfect tools and boots between plots.',
   'Cornell Vegetable MD Online'),
  ('tomato','tomato_leaf_mold','Leaf Mold (Passalora fulva)',false,'moderate',
   'Pale green-yellow blotches on the upper leaf, olive-green to brown velvety mould on the underside; common in humid tunnels.',
   'Improve ventilation, remove affected leaves, apply a registered fungicide if spread continues.',
   'Reduce humidity, avoid leaf wetness, space plants, use resistant varieties.',
   'Follow label dosage; do not spray within the pre-harvest interval.',
   'Cornell Vegetable MD Online'),
  ('tomato','tomato_septoria','Septoria Leaf Spot',false,'moderate',
   'Many small circular spots with pale centres and dark margins, starting low on the plant; heavy defoliation in wet weather.',
   'Remove infected leaves, apply a registered fungicide, mulch to prevent soil splash.',
   'Crop rotation, clean seed, drip irrigation, remove crop debris after harvest.',
   'Observe label re-entry and pre-harvest intervals.',
   'Cornell Vegetable MD Online'),
  ('tomato','tomato_bacterial_spot','Bacterial Spot',false,'moderate',
   'Small water-soaked spots turning dark and greasy, scabby raised centres on fruit.',
   'No reliable chemical cure. Remove infected plants, avoid working in wet foliage, apply copper-based products only as suppression per label.',
   'Use certified clean seed and transplants, rotate crops, sanitise tools.',
   'Copper products are toxic to aquatic life — never rinse equipment near waterways.',
   'Cornell Vegetable MD Online'),
  ('tomato','tomato_yellow_leaf_curl','Yellow Leaf Curl Virus',false,'high',
   'Upward curling and yellowing of leaf margins, stunted growth, little or no fruit set.',
   'No cure once infected — remove and destroy infected plants. Control the whitefly vector with recommended measures.',
   'Use resistant varieties and whitefly-proof netting, manage weeds that host whiteflies, avoid planting next to infected fields.',
   'Virus spreads by whiteflies; act on the whole field, not single plants.',
   'Cornell Vegetable MD Online'),
  ('tomato','tomato_mosaic','Mosaic Virus',false,'high',
   'Mottled light and dark green patches, leaf distortion, stunting.',
   'No cure. Remove and destroy infected plants. Disinfect tools and hands frequently.',
   'Use clean seed, control aphids, avoid tobacco contamination near plants.',
   'Do not save seed from infected plants.',
   'Cornell Vegetable MD Online'),

  ('palay','palay_healthy','Healthy',true,null,
   'Uniform green leaves, no lesions, healthy tillering.',
   'No treatment required.',
   'Continue weekly field scouting and balanced fertiliser.',
   'No chemical action needed.',
   'PhilRice Rice Doctor / IRRI Rice Knowledge Bank'),
  ('palay','palay_blast','Rice Blast (Magnaporthe oryzae)',false,'high',
   'Spindle-shaped (diamond) lesions with grey centres and brown margins on leaves; neck rot at the panicle base causes white empty heads.',
   'Apply a registered fungicide at the recommended growth stage. Avoid excess nitrogen. Drain the field briefly where feasible.',
   'Use resistant varieties, split nitrogen applications, avoid late afternoon irrigation, do not burn infected straw in the field.',
   'Follow the label pre-harvest interval; wear protective equipment when spraying.',
   'PhilRice Rice Doctor / IRRI Rice Knowledge Bank'),
  ('palay','palay_brown_spot','Brown Spot (Bipolaris oryzae)',false,'moderate',
   'Oval brown spots with a grey centre, often on nutrient-deficient or water-stressed plants.',
   'Correct nutrient deficiency (especially potassium and silicon), apply a registered fungicide if severe.',
   'Balanced fertilisation, clean seed, good water management, treat seed before sowing.',
   'Follow label dosage and pre-harvest interval.',
   'PhilRice Rice Doctor / IRRI Rice Knowledge Bank'),
  ('palay','palay_bacterial_blight','Bacterial Leaf Blight (Xanthomonas oryzae)',false,'high',
   'Water-soaked yellow streaks from leaf tips, wilting of seedlings, milky bacterial ooze in early morning.',
   'No effective chemical cure. Drain the field, stop excess nitrogen, remove severely affected plants.',
   'Use resistant varieties, avoid clipping seedling tips at transplanting, keep bunds clean, avoid flood irrigation from infected fields.',
   'Bacteria spread in irrigation water — coordinate water management with neighbours.',
   'PhilRice Rice Doctor / IRRI Rice Knowledge Bank'),
  ('palay','palay_sheath_blight','Sheath Blight (Rhizoctonia solani)',false,'moderate',
   'Oval greenish-grey lesions on the leaf sheath near the water line, banded pattern, lodging in severe cases.',
   'Apply a registered fungicide at early symptom appearance. Reduce dense planting.',
   'Wider spacing, balanced nitrogen, remove sclerotia-bearing stubble after harvest.',
   'Follow label dosage and pre-harvest interval.',
   'PhilRice Rice Doctor / IRRI Rice Knowledge Bank'),
  ('palay','palay_tungro','Tungro',false,'high',
   'Yellow-orange discolouration from the leaf tip downward, stunting, reduced tillering; spread by green leafhoppers.',
   'No cure. Rogue out infected plants. Manage the green leafhopper vector per local advisory.',
   'Plant resistant varieties, synchronise planting in the barangay, manage alternate hosts.',
   'Coordinate vector control at barangay level — individual action is ineffective.',
   'PhilRice Rice Doctor / IRRI Rice Knowledge Bank')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  full_name       text not null default '',
  role            text not null default 'farmer' check (role in ('farmer', 'da', 'admin')),
  jurisdiction_id uuid references public.jurisdictions(id),
  barangay_id     uuid references public.barangays(id),
  is_active       boolean not null default true,
  consent_training    boolean not null default false,
  consent_recorded_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles(role);
create index if not exists profiles_jur_idx on public.profiles(jurisdiction_id);

-- ---------------------------------------------------------------------------
-- 3. Scans + predictions
-- ---------------------------------------------------------------------------

create table if not exists public.scans (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  crop_code        text references public.crop_types(code),
  status           text not null default 'validated'
                     check (status in ('validated', 'rejected', 'confirmed', 'excluded')),
  top_disease_id   uuid references public.diseases(id),
  top_label        text,
  top_confidence   numeric(5, 4) check (top_confidence is null or (top_confidence >= 0 and top_confidence <= 1)),
  confidence_band  text check (confidence_band in ('high', 'medium', 'low')),
  image_path       text,
  image_quality    jsonb,
  validation       jsonb,
  model_id         text,
  model_version    text,
  inference_mode   text check (inference_mode in ('online', 'offline')),
  normalized       jsonb,
  lat              double precision,
  lng              double precision,
  location_source  text check (location_source in ('gps', 'manual', 'profile', 'none')),
  barangay_id      uuid references public.barangays(id),
  jurisdiction_id  uuid references public.jurisdictions(id),
  consent_training boolean not null default false,
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create index if not exists scans_user_created_idx on public.scans(user_id, created_at desc);
create index if not exists scans_jur_created_idx  on public.scans(jurisdiction_id, created_at desc);
create index if not exists scans_brgy_created_idx on public.scans(barangay_id, created_at desc);

create table if not exists public.scan_predictions (
  id             bigint generated always as identity primary key,
  scan_id        uuid not null references public.scans(id) on delete cascade,
  disease_id     uuid references public.diseases(id),
  label          text not null,
  raw_confidence numeric(6, 5) not null,
  normalized_pct numeric(5, 2),
  rank           smallint not null,
  unique (scan_id, label)
);

create index if not exists scan_predictions_scan_idx on public.scan_predictions(scan_id);

-- ---------------------------------------------------------------------------
-- 4. Audit trail
-- ---------------------------------------------------------------------------

create table if not exists public.audit_events (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_role  text,
  action      text not null,
  target_type text,
  target_id   text,
  meta        jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_created_idx on public.audit_events(created_at desc);

-- ---------------------------------------------------------------------------
-- 5. Staff invites (one-time, hashed, no shared secret in the client)
-- ---------------------------------------------------------------------------

create table if not exists public.staff_invites (
  id              uuid primary key default gen_random_uuid(),
  code_hash       text not null unique,
  role            text not null check (role in ('da', 'admin')),
  jurisdiction_id uuid references public.jurisdictions(id),
  created_by      uuid references public.profiles(id) on delete set null,
  expires_at      timestamptz not null default now() + interval '7 days',
  used_by         uuid references public.profiles(id) on delete set null,
  used_at         timestamptz,
  revoked         boolean not null default false,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5b. Developer access keys
--
-- The "Developer Mode" button on the login page lets a staff member register
-- with a shared access code. Only the SHA-256 hash lives in the database, so a
-- leaked client bundle cannot reveal it. Keys can be rotated or disabled at any
-- time with a single UPDATE.
-- ---------------------------------------------------------------------------

create table if not exists public.staff_keys (
  role       text primary key check (role in ('da', 'admin')),
  key_hash   text not null,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.staff_keys enable row level security;
revoke all on public.staff_keys from anon, authenticated;

-- Demo keys. Change these before any real deployment:
--   admin      AGRI-ADMIN-2026
--   da officer AGRI-OFFICER-2026
insert into public.staff_keys (role, key_hash, active) values
  ('admin', encode(digest('AGRI-ADMIN-2026', 'sha256'), 'hex'), true),
  ('da',    encode(digest('AGRI-OFFICER-2026', 'sha256'), 'hex'), true)
on conflict (role) do update
  set key_hash = excluded.key_hash,
      active = excluded.active,
      updated_at = now();

-- ---------------------------------------------------------------------------
-- 6. Training data candidates (predictions are NOT ground truth)
-- ---------------------------------------------------------------------------

create table if not exists public.training_candidates (
  id             uuid primary key default gen_random_uuid(),
  scan_id        uuid not null unique references public.scans(id) on delete cascade,
  label_status   text not null default 'unlabeled'
                   check (label_status in ('unlabeled', 'reviewed', 'excluded')),
  reviewed_label text,
  reviewed_by    uuid references public.profiles(id) on delete set null,
  reviewed_at    timestamptz,
  notes          text,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 6b. Scan feedback: the farmer's verdict on a diagnosis
--
-- A confident answer is not a correct one. This is the only source of ground
-- truth the system has, and it is what a retraining set is built from.
-- ---------------------------------------------------------------------------

create table if not exists public.scan_feedback (
  scan_id        uuid primary key references public.scans(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  verdict        text not null check (verdict in ('correct', 'wrong', 'unsure')),
  corrected_code text,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.scan_feedback enable row level security;

-- ---------------------------------------------------------------------------
-- 7. Helper functions (security definer, fixed search_path)
-- ---------------------------------------------------------------------------

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'anon');
$$;

create or replace function public.my_jurisdiction()
returns uuid language sql stable security definer set search_path = public, extensions as $$
  select jurisdiction_id from public.profiles where id = auth.uid();
$$;

create or replace function public.my_barangay()
returns uuid language sql stable security definer set search_path = public, extensions as $$
  select barangay_id from public.profiles where id = auth.uid();
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 8. Account cap enforcement (transaction-safe)
-- ---------------------------------------------------------------------------

create or replace function public.enforce_role_cap()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  v_count int;
begin
  -- Serialise all role-cap checks for the duration of the transaction. Without
  -- this, two concurrent inserts can both read count = 9 and both succeed.
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

-- ---------------------------------------------------------------------------
-- 9. Signup: role comes from a one-time invite, never from the client
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code    text := nullif(trim(new.raw_user_meta_data ->> 'access_code'), '');
  v_name    text := nullif(trim(new.raw_user_meta_data ->> 'full_name'), '');
  v_barangay text := nullif(trim(new.raw_user_meta_data ->> 'barangay_id'), '');
  v_req_role text := nullif(trim(new.raw_user_meta_data ->> 'role'), '');
  v_invite  public.staff_invites;
  v_role    text := 'farmer';
  v_jur     uuid;
  v_brgy    uuid;
  v_via     text := 'self_signup';
begin
  if v_code is not null then
    -- 1. A one-time invite takes priority: it pins both the role and the scope.
    select * into v_invite
    from public.staff_invites
    where code_hash = encode(digest(v_code, 'sha256'), 'hex')
      and used_at is null
      and revoked = false
      and expires_at > now()
    for update;

    if v_invite.id is not null then
      v_role := v_invite.role;
      v_jur  := v_invite.jurisdiction_id;
      v_via  := 'staff_invite';

      update public.staff_invites
         set used_by = new.id, used_at = now()
       where id = v_invite.id;
    else
      -- 2. Developer access key. The claimed role must match the key's role, so
      --    a client cannot ask for "admin" while presenting the officer key.
      if v_req_role is null or v_req_role not in ('admin', 'da') then
        raise exception 'Choose Admin or DA Officer before registering.' using errcode = 'check_violation';
      end if;

      if not exists (
        select 1 from public.staff_keys k
        where k.role = v_req_role
          and k.active
          and k.key_hash = encode(digest(v_code, 'sha256'), 'hex')
      ) then
        raise exception 'Invalid access code for that role.' using errcode = 'check_violation';
      end if;

      v_role := v_req_role;
      v_via  := 'staff_key';

      if v_role = 'da' then
        -- The pilot covers one municipality, so a DA Officer defaults to it.
        -- An admin can move them later from Accounts -> Role.
        select id into v_jur from public.jurisdictions order by name limit 1;
        if v_jur is null then
          raise exception 'No jurisdiction configured. Run sql/schema.sql.' using errcode = 'check_violation';
        end if;
      end if;
    end if;

    v_brgy := null;
  else
    -- Farmer path. A barangay is expected from the signup form, but it is not
    -- mandatory: accounts provisioned from the Supabase dashboard carry no
    -- metadata, and rejecting those would make admin-side onboarding impossible.
    -- A farmer with no barangay simply cannot save a scan until they set one,
    -- which they do once through set_my_barangay().
    if v_barangay is not null then
      select b.id, b.jurisdiction_id into v_brgy, v_jur
      from public.barangays b where b.id::text = v_barangay;
      if v_brgy is null then
        raise exception 'Unknown barangay.' using errcode = 'check_violation';
      end if;
    end if;
  end if;

  insert into public.profiles (id, full_name, role, jurisdiction_id, barangay_id)
  values (new.id, coalesce(v_name, ''), v_role, v_jur, v_brgy);

  insert into public.audit_events (actor_id, actor_role, action, target_type, target_id, meta)
  values (new.id, v_role, 'account.create', 'profile', new.id::text,
          jsonb_build_object('via', v_via));

  return new;
end $$;

drop trigger if exists on_signup on auth.users;
create trigger on_signup after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 10. Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles            enable row level security;
alter table public.scans               enable row level security;
alter table public.scan_predictions    enable row level security;
alter table public.audit_events        enable row level security;
alter table public.staff_invites       enable row level security;
alter table public.training_candidates enable row level security;
alter table public.diseases            enable row level security;
alter table public.crop_types          enable row level security;
alter table public.jurisdictions       enable row level security;
alter table public.barangays           enable row level security;

-- Reference data is readable by any signed-in user, writable by nobody.
drop policy if exists ref_read_crops on public.crop_types;
create policy ref_read_crops on public.crop_types for select to authenticated using (true);

drop policy if exists ref_read_diseases on public.diseases;
create policy ref_read_diseases on public.diseases for select to authenticated using (true);

drop policy if exists ref_read_jur on public.jurisdictions;
create policy ref_read_jur on public.jurisdictions for select to authenticated using (true);

drop policy if exists ref_read_brgy on public.barangays;
create policy ref_read_brgy on public.barangays for select to authenticated using (true);

-- The signup form is unauthenticated and must list barangays. This is public
-- reference data (no personal information), so anon read is intentional.
drop policy if exists ref_read_jur_anon on public.jurisdictions;
create policy ref_read_jur_anon on public.jurisdictions for select to anon using (true);

drop policy if exists ref_read_brgy_anon on public.barangays;
create policy ref_read_brgy_anon on public.barangays for select to anon using (true);

-- profiles: self, admin (all), DA (own jurisdiction, farmers only)
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (
  id = auth.uid()
  or public.my_role() = 'admin'
  or (public.my_role() = 'da'
      and jurisdiction_id = public.my_jurisdiction()
      and role = 'farmer')
);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Role, jurisdiction and active flag are not client-writable at all; only the
-- RPCs below (security definer, admin-checked) can change them.
--
-- Postgres privilege model note: a table-level GRANT UPDATE cannot be narrowed
-- by revoking individual columns, so the table grant is dropped and only the
-- self-service columns are granted back.
revoke update, insert, delete on public.profiles from authenticated;
grant update (full_name, consent_training, consent_recorded_at) on public.profiles to authenticated;

-- scans: owner, admin (all), DA (own jurisdiction)
drop policy if exists scans_select on public.scans;
create policy scans_select on public.scans for select to authenticated using (
  user_id = auth.uid()
  or public.my_role() = 'admin'
  or (public.my_role() = 'da' and jurisdiction_id = public.my_jurisdiction())
);

drop policy if exists scans_delete_own on public.scans;
create policy scans_delete_own on public.scans for delete to authenticated using (
  user_id = auth.uid() or public.my_role() = 'admin'
);

-- Inserts go through create_scan(); direct inserts are denied.
revoke insert, update on public.scans from authenticated;

drop policy if exists predictions_select on public.scan_predictions;
create policy predictions_select on public.scan_predictions for select to authenticated using (
  exists (select 1 from public.scans s where s.id = scan_id)
);

drop policy if exists audit_select on public.audit_events;
create policy audit_select on public.audit_events for select to authenticated using (
  public.my_role() = 'admin'
);

drop policy if exists invites_admin on public.staff_invites;
create policy invites_admin on public.staff_invites for select to authenticated using (
  public.my_role() = 'admin'
);

drop policy if exists training_admin on public.training_candidates;
create policy training_admin on public.training_candidates for select to authenticated using (
  public.my_role() = 'admin'
);

-- ---------------------------------------------------------------------------
-- 10b. Write privileges: nothing is written directly by a client.
--      Every mutation goes through a security-definer RPC so that invariants
--      (account caps, role source, jurisdiction, audit rows) cannot be skipped.
-- ---------------------------------------------------------------------------

revoke insert, update, delete on public.audit_events        from authenticated;
revoke insert, update, delete on public.staff_invites       from authenticated;
revoke insert, update, delete on public.training_candidates from authenticated;
revoke insert, update, delete on public.scan_predictions    from authenticated;
revoke insert, update, delete on public.diseases            from authenticated;
revoke insert, update, delete on public.crop_types          from authenticated;
revoke insert, update, delete on public.jurisdictions       from authenticated;
revoke insert, update, delete on public.barangays           from authenticated;

-- ---------------------------------------------------------------------------
-- 11. Atomic scan creation
-- ---------------------------------------------------------------------------

create or replace function public.create_scan(
  p_crop_code       text,
  p_status          text,
  p_top_label       text,
  p_top_code        text,
  p_top_confidence  numeric,
  p_confidence_band text,
  p_image_path      text,
  p_image_quality   jsonb,
  p_validation      jsonb,
  p_model_id        text,
  p_model_version   text,
  p_inference_mode  text,
  p_normalized      jsonb,
  p_predictions     jsonb,
  p_lat             double precision,
  p_lng             double precision,
  p_location_source text,
  p_barangay_id     uuid,
  p_consent_training boolean
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid   uuid := auth.uid();
  v_prof  public.profiles;
  v_brgy  uuid;
  v_jur   uuid;
  v_scan  uuid;
  v_top   uuid;
  v_item  jsonb;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_prof from public.profiles where id = v_uid;
  if v_prof.id is null or v_prof.role <> 'farmer' then
    raise exception 'Only farmer accounts can submit scans';
  end if;

  if p_status not in ('validated', 'rejected') then
    raise exception 'Invalid scan status';
  end if;

  -- A rejected scan must never carry a diagnosis.
  if p_status = 'rejected' and (p_top_label is not null or p_top_code is not null) then
    raise exception 'A rejected scan cannot contain a disease prediction';
  end if;

  if p_crop_code is not null
     and not exists (select 1 from public.crop_types where code = p_crop_code and is_active) then
    raise exception 'Unsupported crop';
  end if;

  v_brgy := coalesce(p_barangay_id, v_prof.barangay_id);
  if v_brgy is null then raise exception 'Barangay is required'; end if;

  select b.jurisdiction_id into v_jur from public.barangays b where b.id = v_brgy;
  if v_jur is null then raise exception 'Unknown barangay'; end if;
  if v_prof.jurisdiction_id is not null and v_jur <> v_prof.jurisdiction_id then
    raise exception 'Barangay is outside your jurisdiction';
  end if;

  if p_top_code is not null then
    select id into v_top from public.diseases where code = p_top_code;
  end if;

  insert into public.scans (
    user_id, crop_code, status, top_disease_id, top_label, top_confidence, confidence_band,
    image_path, image_quality, validation, model_id, model_version, inference_mode,
    normalized, lat, lng, location_source, barangay_id, jurisdiction_id, consent_training
  ) values (
    v_uid, p_crop_code, p_status, v_top, p_top_label, p_top_confidence, p_confidence_band,
    p_image_path, p_image_quality, p_validation, p_model_id, p_model_version, p_inference_mode,
    p_normalized,
    case when p_lat is null then null else round(p_lat::numeric, 3)::float8 end,
    case when p_lng is null then null else round(p_lng::numeric, 3)::float8 end,
    coalesce(p_location_source, 'none'), v_brgy, v_jur,
    coalesce(p_consent_training, v_prof.consent_training)
  ) returning id into v_scan;

  for v_item in select * from jsonb_array_elements(coalesce(p_predictions, '[]'::jsonb)) loop
    insert into public.scan_predictions (scan_id, disease_id, label, raw_confidence, normalized_pct, rank)
    values (
      v_scan,
      (select id from public.diseases where code = v_item ->> 'code'),
      v_item ->> 'label',
      coalesce((v_item ->> 'raw')::numeric, 0),
      nullif(v_item ->> 'pct', '')::numeric,
      coalesce((v_item ->> 'rank')::smallint, 1)
    );
  end loop;

  insert into public.audit_events (actor_id, actor_role, action, target_type, target_id)
  values (v_uid, v_prof.role, 'scan.create', 'scan', v_scan::text);

  return v_scan;
end $$;

-- ---------------------------------------------------------------------------
-- 12. Admin RPCs
-- ---------------------------------------------------------------------------

create or replace function public.admin_set_role(p_target uuid, p_role text, p_jurisdiction uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_before public.profiles;
begin
  if public.my_role() <> 'admin' then raise exception 'Not authorised'; end if;
  if p_role not in ('farmer', 'da', 'admin') then raise exception 'Invalid role'; end if;
  if p_target = auth.uid() then raise exception 'You cannot change your own role'; end if;

  select * into v_before from public.profiles where id = p_target;
  if v_before.id is null then raise exception 'Profile not found'; end if;

  update public.profiles
     set role = p_role,
         jurisdiction_id = case when p_role = 'farmer' then jurisdiction_id else p_jurisdiction end,
         barangay_id = case when p_role = 'farmer' then barangay_id else null end
   where id = p_target;

  insert into public.audit_events (actor_id, actor_role, action, target_type, target_id, meta)
  values (auth.uid(), 'admin', 'account.role_change', 'profile', p_target::text,
          jsonb_build_object('from', v_before.role, 'to', p_role, 'jurisdiction', p_jurisdiction));
end $$;

create or replace function public.admin_create_invite(p_role text, p_jurisdiction uuid, p_days int default 7)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_code text; v_hash text;
begin
  if public.my_role() <> 'admin' then raise exception 'Not authorised'; end if;
  if p_role not in ('da', 'admin') then raise exception 'Invalid role'; end if;
  if p_role = 'da' and p_jurisdiction is null then
    raise exception 'A DA Officer invite needs a jurisdiction';
  end if;
  if p_days < 1 or p_days > 30 then raise exception 'Validity must be 1-30 days'; end if;

  v_code := 'AGRI-' || upper(encode(gen_random_bytes(9), 'hex'));
  v_hash := encode(digest(v_code, 'sha256'), 'hex');

  insert into public.staff_invites (code_hash, role, jurisdiction_id, created_by, expires_at)
  values (v_hash, p_role, p_jurisdiction, auth.uid(), now() + make_interval(days => p_days));

  insert into public.audit_events (actor_id, actor_role, action, target_type, meta)
  values (auth.uid(), 'admin', 'invite.create', 'staff_invite', jsonb_build_object('role', p_role));

  -- Returned exactly once; only the hash is stored.
  return v_code;
end $$;

create or replace function public.admin_set_active(p_target uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.my_role() <> 'admin' then raise exception 'Not authorised'; end if;
  if p_target = auth.uid() then raise exception 'You cannot deactivate your own account'; end if;
  update public.profiles set is_active = p_active where id = p_target;
  insert into public.audit_events (actor_id, actor_role, action, target_type, target_id, meta)
  values (auth.uid(), 'admin', case when p_active then 'account.activate' else 'account.deactivate' end,
          'profile', p_target::text, null);
end $$;

-- ---------------------------------------------------------------------------
-- 12b. One-time barangay claim
--      For accounts that were provisioned without one (dashboard-created users,
--      seeded demo accounts). It can only ever be set once by the user, and the
--      barangay must exist, so it cannot be used to jump jurisdictions.
-- ---------------------------------------------------------------------------

create or replace function public.set_my_barangay(p_barangay uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_prof public.profiles;
  v_jur  uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into v_prof from public.profiles where id = auth.uid();
  if v_prof.id is null then raise exception 'Profile not found'; end if;
  if v_prof.role <> 'farmer' then raise exception 'Only farmers have a barangay'; end if;
  if v_prof.barangay_id is not null then
    raise exception 'Your barangay is already set. Ask an administrator to change it.';
  end if;

  select jurisdiction_id into v_jur from public.barangays where id = p_barangay;
  if v_jur is null then raise exception 'Unknown barangay'; end if;

  update public.profiles
     set barangay_id = p_barangay, jurisdiction_id = v_jur
   where id = auth.uid();

  insert into public.audit_events (actor_id, actor_role, action, target_type, target_id)
  values (auth.uid(), v_prof.role, 'profile.set_barangay', 'profile', auth.uid()::text);
end $$;

-- ---------------------------------------------------------------------------
-- 13. Analytics (invoker rights -> RLS applies, so scoping is automatic)
-- ---------------------------------------------------------------------------

create or replace function public.analytics_summary(p_from timestamptz, p_to timestamptz, p_barangay uuid default null)
returns jsonb language sql stable as $$
  with s as (
    select sc.*, d.is_healthy
    from public.scans sc
    left join public.diseases d on d.id = sc.top_disease_id
    where sc.deleted_at is null
      and sc.status <> 'rejected'
      and sc.created_at >= p_from and sc.created_at < p_to
      and (p_barangay is null or sc.barangay_id = p_barangay)
  )
  select jsonb_build_object(
    'scans',      count(*),
    'farmers',    count(distinct user_id),
    'affected',   count(*) filter (where top_disease_id is not null and coalesce(is_healthy, false) = false),
    'confirmed',  count(*) filter (where status = 'confirmed'),
    'barangays',  count(distinct barangay_id)
  ) from s;
$$;

create or replace function public.analytics_series(
  p_from timestamptz, p_to timestamptz, p_bucket text default 'day', p_barangay uuid default null)
returns table (bucket timestamptz, scans bigint, affected bigint)
language sql stable as $$
  with b as (
    select gs as bucket
    from generate_series(
      date_trunc(p_bucket, p_from at time zone 'Asia/Manila'),
      date_trunc(p_bucket, p_to at time zone 'Asia/Manila') - interval '1 second',
      ('1 ' || p_bucket)::interval
    ) gs
  ), s as (
    select date_trunc(p_bucket, sc.created_at at time zone 'Asia/Manila') as bucket,
           sc.top_disease_id, d.is_healthy
    from public.scans sc
    left join public.diseases d on d.id = sc.top_disease_id
    where sc.deleted_at is null
      and sc.status <> 'rejected'
      and sc.created_at >= p_from and sc.created_at < p_to
      and (p_barangay is null or sc.barangay_id = p_barangay)
  )
  select b.bucket,
         coalesce(count(s.bucket), 0)::bigint as scans,
         coalesce(count(s.bucket) filter (where s.top_disease_id is not null and coalesce(s.is_healthy, false) = false), 0)::bigint as affected
  from b left join s on s.bucket = b.bucket
  group by b.bucket
  order by b.bucket;
$$;

-- One row per scan (never per prediction) so totals cannot double-count.
create or replace function public.analytics_diseases(
  p_from timestamptz, p_to timestamptz, p_barangay uuid default null, p_limit int default 10)
returns table (label text, code text, is_healthy boolean, scans bigint)
language sql stable as $$
  select coalesce(d.name, 'Unclassified') as label,
         coalesce(d.code, 'unknown')     as code,
         coalesce(d.is_healthy, false)   as is_healthy,
         count(*)::bigint                as scans
  from public.scans sc
  left join public.diseases d on d.id = sc.top_disease_id
  where sc.deleted_at is null
    and sc.status <> 'rejected'
    and sc.created_at >= p_from and sc.created_at < p_to
    and (p_barangay is null or sc.barangay_id = p_barangay)
  group by d.name, d.code, d.is_healthy
  order by count(*) desc
  limit greatest(p_limit, 1);
$$;

create or replace function public.analytics_crops(
  p_from timestamptz, p_to timestamptz, p_barangay uuid default null)
returns table (crop_code text, crop_name text, scans bigint)
language sql stable as $$
  select coalesce(sc.crop_code, 'unknown') as crop_code,
         coalesce(ct.name, 'Unknown')      as crop_name,
         count(*)::bigint                  as scans
  from public.scans sc
  left join public.crop_types ct on ct.code = sc.crop_code
  where sc.deleted_at is null
    and sc.status <> 'rejected'
    and sc.created_at >= p_from and sc.created_at < p_to
    and (p_barangay is null or sc.barangay_id = p_barangay)
  group by sc.crop_code, ct.name
  order by count(*) desc;
$$;

create or replace function public.analytics_barangays(p_from timestamptz, p_to timestamptz)
returns table (barangay_id uuid, barangay text, scans bigint, affected bigint, farmers bigint)
language sql stable as $$
  select sc.barangay_id,
         coalesce(b.name, 'Unknown') as barangay,
         count(*)::bigint as scans,
         count(*) filter (where sc.top_disease_id is not null and coalesce(d.is_healthy, false) = false)::bigint as affected,
         count(distinct sc.user_id)::bigint as farmers
  from public.scans sc
  left join public.barangays b on b.id = sc.barangay_id
  left join public.diseases d on d.id = sc.top_disease_id
  where sc.deleted_at is null
    and sc.status <> 'rejected'
    and sc.created_at >= p_from and sc.created_at < p_to
  group by sc.barangay_id, b.name
  order by count(*) desc;
$$;

-- Barangay x disease matrix for the stacked chart. Only the top N diseases per
-- barangay are returned so the legend stays readable; the table view shows all.
create or replace function public.analytics_barangay_disease(
  p_from timestamptz, p_to timestamptz, p_limit int default 8)
returns table (barangay text, disease text, scans bigint)
language sql stable as $$
  with ranked as (
    select coalesce(b.name, 'Unknown')     as barangay,
           coalesce(d.name, 'Unclassified') as disease,
           count(*)::bigint                 as scans,
           row_number() over (
             partition by sc.barangay_id
             order by count(*) desc
           ) as rn
    from public.scans sc
    left join public.barangays b on b.id = sc.barangay_id
    left join public.diseases d on d.id = sc.top_disease_id
    where sc.deleted_at is null
      and sc.status <> 'rejected'
      and sc.created_at >= p_from and sc.created_at < p_to
    group by sc.barangay_id, b.name, d.name
  )
  select barangay, disease, scans
  from ranked
  where rn <= greatest(p_limit, 1)
  order by barangay, scans desc;
$$;

-- Lets the signup form tell the user "that code is invalid" *before* creating an
-- auth user, instead of showing a generic "database error". The trigger remains
-- the authoritative check, so a race still cannot produce a staff account.
create or replace function public.check_access_code(p_code text, p_role text default null)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select coalesce(
    (select jsonb_build_object('valid', true, 'source', 'invite', 'role', i.role, 'expires_at', i.expires_at)
       from public.staff_invites i
      where i.code_hash = encode(digest(p_code, 'sha256'), 'hex')
        and i.used_at is null
        and i.revoked = false
        and i.expires_at > now()
      limit 1),
    (select jsonb_build_object('valid', true, 'source', 'key', 'role', k.role)
       from public.staff_keys k
      where k.role = p_role
        and k.active
        and k.key_hash = encode(digest(p_code, 'sha256'), 'hex')
      limit 1),
    jsonb_build_object('valid', false)
  );
$$;

-- Kept for older callers; delegates to the function above.
create or replace function public.validate_invite(p_code text)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select public.check_access_code(p_code, null);
$$;

-- Per-farmer rollup for the farmer directory. Kept in SQL so the page never
-- shows a placeholder where a real count belongs.
create or replace function public.analytics_farmers(p_from timestamptz default null, p_to timestamptz default null)
returns table (user_id uuid, scans bigint, affected bigint, last_scan timestamptz)
language sql stable as $$
  select sc.user_id,
         count(*)::bigint as scans,
         count(*) filter (where sc.top_disease_id is not null and coalesce(d.is_healthy, false) = false)::bigint as affected,
         max(sc.created_at) as last_scan
  from public.scans sc
  left join public.diseases d on d.id = sc.top_disease_id
  where sc.deleted_at is null
    and sc.status <> 'rejected'
    and (p_from is null or sc.created_at >= p_from)
    and (p_to is null or sc.created_at < p_to)
  group by sc.user_id;
$$;

-- ---------------------------------------------------------------------------
-- 14. Grants
-- ---------------------------------------------------------------------------

grant execute on function public.my_role()          to authenticated;
grant execute on function public.my_jurisdiction()  to authenticated;
grant execute on function public.my_barangay()      to authenticated;
grant execute on function public.create_scan(text, text, text, text, numeric, text, text, jsonb, jsonb,
  text, text, text, jsonb, jsonb, double precision, double precision, text, uuid, boolean) to authenticated;
grant execute on function public.admin_set_role(uuid, text, uuid)     to authenticated;
grant execute on function public.admin_create_invite(text, uuid, int) to authenticated;
grant execute on function public.admin_set_active(uuid, boolean)      to authenticated;
grant execute on function public.set_my_barangay(uuid)                to authenticated;
grant execute on function public.analytics_summary(timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.analytics_series(timestamptz, timestamptz, text, uuid) to authenticated;
grant execute on function public.analytics_diseases(timestamptz, timestamptz, uuid, int) to authenticated;
grant execute on function public.analytics_crops(timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.analytics_barangays(timestamptz, timestamptz) to authenticated;
grant execute on function public.analytics_barangay_disease(timestamptz, timestamptz, int) to authenticated;
grant execute on function public.analytics_farmers(timestamptz, timestamptz) to authenticated;
grant execute on function public.validate_invite(text) to anon, authenticated;
grant execute on function public.check_access_code(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 15. Storage: private bucket, owner + scoped staff access
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('crop-images', 'crop-images', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "crop images insert own" on storage.objects;
create policy "crop images insert own" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'crop-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "crop images read" on storage.objects;
create policy "crop images read" on storage.objects for select to authenticated
  using (
    bucket_id = 'crop-images'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.my_role() = 'admin'
      or (
        public.my_role() = 'da'
        and exists (
          select 1 from public.scans s
          where s.image_path = storage.objects.name
            and s.jurisdiction_id = public.my_jurisdiction()
        )
      )
    )
  );

drop policy if exists "crop images delete own" on storage.objects;
create policy "crop images delete own" on storage.objects for delete to authenticated
  using (
    bucket_id = 'crop-images'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.my_role() = 'admin')
  );

-- ---------------------------------------------------------------------------
-- 16. Bootstrap the first admin
--    1. Sign up normally through auth.html (you become a farmer).
--    2. Run the block below with your email.
--    3. Delete this block afterwards.
-- ---------------------------------------------------------------------------
-- update public.profiles set role = 'admin'
--  where id = (select id from auth.users where email = 'you@example.com');

# START HERE — from empty database to working accounts

Follow this in order. Every step has a check so you know it worked before moving on.

Related docs: `TRAINING-GUIDE.md` (get data, train the three models) ·
`AI-SETUP.md` (class contract, gateway deploy) · `DEPLOY.md` (GitHub Pages and
other hosts) · `SETUP.md` (reference).

---

## What happens when someone registers

Understanding this makes the rest obvious:

```
auth.html form
   └─ supabase.auth.signUp({ email, password, options: { data: {...} } })
        └─ Supabase creates a row in  auth.users        ← the login credential
             └─ trigger  on_signup  fires  handle_new_user()
                  └─ inserts a row in  public.profiles  ← the role, name, barangay
                       └─ trigger  enforce_role_cap  checks 10 / 6 / 5
```

So there are **two** tables per account: `auth.users` (email + password, managed by
Supabase) and `public.profiles` (everything the app shows). If the trigger is
missing, the login is created but the app has no profile and bounces you back to
the login page. That is why step 2 matters.

---

## Step 0 — You need

- The Supabase project open: **Project → SQL Editor**
- Your project URL and publishable key already in `script/config.js` (done)

---

## Step 1 — Clean out the old v3 tables

You already ran `sql/reset.sql`. Confirm it worked:

```sql
select table_name
  from information_schema.tables
 where table_schema = 'public'
 order by table_name;
```

**Expected:** an empty result, or only tables you do not recognise.
**If you see `profiles` or `scans`:** run `sql/reset.sql` again first.

---

## Step 2 — Create everything

1. Open **SQL Editor → New query**
2. Paste the **entire** contents of `sql/schema.sql`
3. Press **Run**

This is one transaction: if any statement fails, nothing is applied and you can
safely fix and re-run. It is idempotent — running it twice is fine.

**If you get `42883: function digest(text, unknown) does not exist`**, your copy of
`schema.sql` is older than this fix. The functions must declare
`set search_path = public, extensions` because Supabase installs pgcrypto in the
`extensions` schema. Re-download / re-copy the file.

---

## Step 3 — Verify the schema

Run this and compare:

```sql
select
  (select count(*) from public.jurisdictions) as jurisdictions,   -- 1
  (select count(*) from public.barangays)      as barangays,      -- 10
  (select count(*) from public.diseases)       as diseases,       -- 12
  (select count(*) from public.staff_keys)     as staff_keys,     -- 2
  (select count(*) from public.profiles)       as profiles,       -- 0
  (select count(*) from public.scans)          as scans;          -- 0
```

**Expected:**

| jurisdictions | barangays | diseases | staff_keys | profiles | scans |
| --- | --- | --- | --- | --- | --- |
| 1 | 10 | 12 | 2 | 0 | 0 |

Then confirm the signup trigger exists — this is the piece that saves accounts:

```sql
select tgname, tgenabled
  from pg_trigger
 where tgrelid = 'auth.users'::regclass
   and not tgisinternal;
```

**Expected:** one row, `on_signup`, `tgenabled = O`.

And the row-level security is on:

```sql
select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public'
 order by tablename;
```

**Expected:** `rowsecurity = true` on every table.

---

## Step 4 — Turn off email confirmation (for the demo)

By default Supabase emails a confirmation link, so `signUp` returns no session
and the user cannot log in until they click it.

**The toggle is NOT inside the Email provider sheet.** The sheet you get when you
click the `Email` row only holds provider options (password length, OTP, leaked
password checks). `Confirm email` lives one level up.

1. Left sidebar → **Authentication → Sign In / Providers** (the parent page)
2. Scroll to the **User Signups** section
3. Find **Confirm email** — it sits next to *Allow new users to sign up*
4. Turn it **off**, then **Save**

You can turn it back on later; the app already shows a "confirm your email"
message when it is on.

### If you still cannot find it

Dashboard layouts change. Skip the toggle and confirm accounts from SQL instead —
this works regardless of which version you are on:

```sql
-- confirm one account
update auth.users
   set email_confirmed_at = now()
 where email = 'you@example.com';

-- or confirm everything created so far (demo only)
update auth.users
   set email_confirmed_at = now()
 where email_confirmed_at is null;
```

Then log in normally.

### Optional: auto-confirm every signup (development only)

Only if you accept that email addresses are never actually verified. Do **not**
ship this to production.

```sql
create or replace function public.auto_confirm_signup()
returns trigger language plpgsql security definer
set search_path = public, extensions as $$
begin
  update auth.users
     set email_confirmed_at = coalesce(email_confirmed_at, now())
   where id = new.id;
  return new;
end $$;

drop trigger if exists auto_confirm on auth.users;
create trigger auto_confirm after insert on auth.users
  for each row execute function public.auto_confirm_signup();
```

Remove it with `drop trigger if exists auto_confirm on auth.users;` before going
live.

---

## Step 5 — Create your first admin

Staff cannot self-register without a key, and the first admin has no one to issue
one. So: register as a farmer, then promote yourself.

**5a.** Open `auth.html` → **Register** → fill in name, barangay, email, password.

**Expected:** you land on the farmer dashboard. If you instead get
*"Registration did not complete"*, the trigger is missing — go back to step 3.

**5b.** Confirm the profile row exists:

```sql
select p.full_name, p.role, b.name as barangay, u.email
  from public.profiles p
  join auth.users u on u.id = p.id
  left join public.barangays b on b.id = p.barangay_id;
```

**Expected:** one row, `role = farmer`.

**5c.** Promote yourself:

```sql
update public.profiles
   set role = 'admin'
 where id = (select id from auth.users where email = 'YOUR-EMAIL-HERE');
```

**5d.** Sign out in the app, sign back in. The sidebar now shows
**Accounts** and **Audit log**.

---

## Step 6 — Create the DA Officer

1. Open `auth.html`
2. Click **Developer mode** (bottom-right) — the form switches to staff
3. Pick **DA Officer**
4. Access code: `AGRI-OFFICER-2026`
5. Fill in name, email, password → **Register as staff**

**Expected:** you land on the staff dashboard, scoped to Peñaranda.

The role is decided by the database: the trigger hashes the code, looks it up in
`staff_keys`, and only accepts it if the row's role matches the tab you picked.

**Verify:**

```sql
select p.full_name, p.role, j.name as jurisdiction
  from public.profiles p
  left join public.jurisdictions j on j.id = p.jurisdiction_id
 order by p.created_at;
```

**Expected:** `admin` with no jurisdiction, `da` with `Peñaranda`, plus the farmer.

Every successful signup also writes an audit row:

```sql
select actor_role, action, meta->>'via' as via, created_at
  from public.audit_events
 order by created_at desc
 limit 5;
```

---

## Step 7 — What you should see now

| Screen | Expected |
| --- | --- |
| Farmer dashboard | Charts filled with **Sample data** badge, weather card live |
| Scan tab | Model status: *Not set*. Scan works and returns a labelled sample result |
| History | Sample rows, each marked *Sample data* |
| Staff overview | KPIs and charts, **Sample data** badge |
| Accounts | Your accounts listed, caps shown as *n of 10 / 6 / 5* |

Sample data appears **only** while the database has zero scans. The moment a real
scan is saved, it disappears and the badge goes away.

To see the true empty state, set `DEMO_DATA.enabled = false` in `script/config.js`.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `42883: function digest(text, unknown) does not exist` | Function `search_path` missing `extensions` | Use the current `schema.sql`; all functions must say `set search_path = public, extensions` |
| `Legacy v3 schema detected` | Old tables still present | Run `sql/reset.sql`, then `schema.sql` |
| `relation "..." already exists` | Partial earlier run | Safe to ignore, or re-run `reset.sql` then `schema.sql` |
| Signup says *"Database error saving new user"* | Trigger raised: bad barangay, bad code, or a full cap | Check the specific cap message; verify step 3 |
| Signup succeeds but login bounces back | No profile row | The `on_signup` trigger is missing — step 3 |
| Cannot log in after registering | Email confirmation is on | Step 4, or click the link in your inbox |
| Everything shows 0 | No scans and sample data is off | Set `DEMO_DATA.enabled = true` |
| `permission denied for table profiles` | RLS with no matching policy | Re-run `schema.sql`; do not disable RLS |
| Storage upload fails | Bucket missing | Re-run `schema.sql`; check Storage → Buckets for `crop-images` |

---

## Changing the access keys later

```sql
-- rotate
update public.staff_keys
   set key_hash = encode(digest('YOUR-NEW-CODE', 'sha256'), 'hex'),
       updated_at = now()
 where role = 'admin';

-- disable
update public.staff_keys set active = false where role = 'da';
```

Only the hash is stored, so the plain code cannot be read back out.

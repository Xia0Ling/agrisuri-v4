# Deployment

## What runs where

| Piece | Hosted on | Why |
|---|---|---|
| HTML / CSS / JS / assets | GitHub Pages (or any static host) | No build step, no server code |
| Auth, Postgres, storage | Supabase | Already provisioned |
| `/infer` inference gateway | Supabase Edge Functions | Holds the Roboflow key — **must not** go to a static host |

A static host cannot run the gateway. Deploying the front end without deploying
the function leaves the app in "Model not configured" mode with the heuristics
running — it still works, it just cannot name diseases.

---

## GitHub Pages

### 1. Push the repo

```bash
git init
git add .
git commit -m "AgriSuri v4"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

### 2. Turn Pages on

Repo → **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`,
folder `/ (root)` → Save.

URL becomes `https://<user>.github.io/<repo>/`.

### 3. Fix Supabase auth URLs — this is the step people forget

Supabase → **Authentication → URL Configuration**:

- **Site URL**: `https://<user>.github.io/<repo>/`
- **Redirect URLs**: add `https://<user>.github.io/<repo>/**` and
  `http://localhost:5173/**`

`signUp` in `script/auth.js` passes no `emailRedirectTo`, so the confirmation
link uses **Site URL**. Leave it on `localhost` and every new farmer who confirms
their email lands on a dead page.

### 4. Why this project survives a subpath

GitHub project sites live under `/<repo>/`, not `/`. That breaks any `href="/…"`.
This repo has none — every reference is relative (`style/app.css`,
`script/config.js`, `assets/…`), the manifest uses `"scope": "./"` with
`"start_url": "landing.html"`, and the service worker registers with
`register('sw.js')`, which scopes to `/<repo>/`.

`.nojekyll` is present so Pages does not run Jekyll over the folder.

### 5. Caveats

- **Case sensitivity.** Pages is Linux and case-sensitive; Windows is not.
  `Assets/Logo.png` will 404 in production but work locally.
- **No custom headers.** Pages cannot send CSP, HSTS or `X-Frame-Options`.
  If you need those, use Cloudflare Pages or Netlify.
- **Private repo needs GitHub Pro** for Pages. Public repo is free.
- **HTTPS is required for the camera.** Pages provides it. Opening the files
  from `file://` disables `getUserMedia`; the app falls back to the file picker.
- Limits: 1 GB repo, 100 MB per file, ~100 GB/month bandwidth. This app is far
  below all three.

---

## Other hosts

| Host | Setup | Notes |
|---|---|---|
| **Cloudflare Pages** | Connect repo, build command empty, output `/` | Best option if you want security headers or a private repo. `_headers` file supported |
| **Netlify** | Drag the folder, or connect repo | `_headers` and `_redirects` supported |
| **Vercel** | Import repo, framework preset *Other* | Fine, no headers file |
| **Firebase Hosting** | `firebase init hosting`, public dir `.` | Fine, more setup |

All of them serve the same static folder. No build step anywhere — if a host
asks for a build command, leave it empty and set the output directory to `/`.

---

## Before going live

1. Deploy the `infer` function and set its secrets — see `AI-SETUP.md` Step 5.
2. Put the absolute function URL in `AI_CONFIG.gatewayUrl`. It is cross-origin
   by design and the function returns `Access-Control-Allow-Origin: *`, so it
   works from any host.
3. Set `DEMO_DATA.enabled = false` in `script/config.js` once real scans exist.
4. Run the acceptance test in `AI-SETUP.md` Step 9 against the deployed URL,
   not localhost — the camera and service worker behave differently.

---

## Verify a deploy

```bash
# shell loads
curl -I https://<user>.github.io/<repo>/index.html

# gateway is reachable (401 is correct — it means the function is up and
# rejecting the missing token, not that it is broken)
curl -i -X POST https://<ref>.supabase.co/functions/v1/infer \
  -H "Content-Type: application/json" -d '{"stage":"shape_gate"}'
```

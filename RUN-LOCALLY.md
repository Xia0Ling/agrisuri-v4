# Run AgriSuri on your laptop and phone

Two machines, one Wi-Fi network. No hosting, no Docker, no build step.

The app is a static front end served by `tools/serve.js`. The database, auth and
inference gateway stay on Supabase — that is deliberate, because the Roboflow
key must never reach a browser.

---

## 1. Start the server (laptop)

```powershell
cd "C:\Users\Admin\Downloads\AgriSuri v4"
$env:Path += ";C:\Users\Admin\.workbuddy-ai\binaries\node\versions\22.22.2-6"
npm run serve:lan
```

It prints the addresses it is reachable on:

```
local   http://localhost:5173
phone   http://10.133.146.15:5173
```

Open the `local` one on the laptop. Leave the window open — closing it stops the
server.

**The `phone` IP changes** whenever you join a different Wi-Fi or a VPN comes up.
Always copy the one printed in the current run; do not reuse an old URL.

`npm run serve` (without `:lan`) binds to `127.0.0.1` only, so nothing on the
network can reach it. Use that when you do not need the phone.

---

## 2. Open it on the phone

1. Connect the phone to the **same Wi-Fi** as the laptop.
2. Type the `phone` URL into the phone browser.

### If the phone cannot connect

Windows treats this Wi-Fi as a **Public** network. On this machine `node.exe`
already has an inbound Allow rule, so it should connect as-is. If it times out
anyway, open **PowerShell as Administrator** and run:

```powershell
$prog = "C:\Users\Admin\.workbuddy-ai\binaries\node\versions\22.22.2-6\node.exe"

New-NetFirewallRule -DisplayName "AgriSuri dev server (LAN)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173 `
  -RemoteAddress LocalSubnet -Profile Public,Private `
  -Program $prog
```

If a **Block** rule exists for the same program, it wins over any allow rule.
Disable it first:

```powershell
Get-NetFirewallRule -Direction Inbound |
  Where-Object { $_.Action -eq 'Block' } |
  ForEach-Object {
    $f = $_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
    if ($f.Program -eq $prog) { Disable-NetFirewallRule -Name $_.Name }
  }
```

Optional hardening — the auto-created rule allows `node.exe` on **any** port
from **any** address. To restrict it to this project's port and your own subnet,
delete the wide rules and keep only the narrow one:

```powershell
Get-NetFirewallRule -Direction Inbound |
  Where-Object { $_.DisplayName -eq 'node.exe' -and $_.Action -eq 'Allow' } |
  ForEach-Object {
    $f = $_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
    if ($f.Program -eq $prog) { Remove-NetFirewallRule -Name $_.Name }
  }
```

To undo everything:

```powershell
Remove-NetFirewallRule -DisplayName "AgriSuri dev server (LAN)"
```

### Camera on the phone

No HTTPS needed. The scan screen detects a coarse pointer and uses
`<input type="file" capture="environment">`, which opens the native camera app.
That path does not require a secure context. The desktop live-preview
(`getUserMedia`) only runs on `localhost`, which already counts as secure.

---

## 3. Inference — local first, gateway later

There are two ways the browser reaches the models, and `script/config.js` picks
one automatically from `location.hostname`:

| Host | Gateway used | Key lives in |
|---|---|---|
| `localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `172.16–31.x` | `/api/infer` on the dev server | `tools/roboflow.key` |
| anything else (GitHub Pages) | Supabase Edge Function `infer` | Supabase secrets |

**Locally there is nothing to deploy.** `tools/serve.js` exposes
`POST /api/infer` with exactly the same request and response shape as the Edge
Function, so `script/ai.js` has no special case. The key never reaches the
browser: the server reads `tools/roboflow.key` (gitignored) or
`ROBOFLOW_API_KEY` from the environment.

The startup banner confirms it:

```
inference  /api/infer -> Roboflow (key loaded)
```

If it says `DISABLED`, the key file is missing.

### Verify the chain without a camera

```powershell
node tools/verify-pipeline.js
```

It runs real images from `dataset/` through the proxy, then feeds the raw
predictions through the same `Core` functions the browser uses — so it tests the
decision logic, not just that the models answer.

### Deploying the gateway (only needed for GitHub)

GitHub Pages is static, so the key has to live somewhere else.

Easiest path: **double-click `SETUP-GATEWAY.cmd`** in the project folder. It adds
the CLI to PATH, opens the browser for `supabase login`, then runs the deploy
script. It pauses at the end so you can read the result.

Or do it by hand:

```powershell
$env:Path += ";C:\Users\Admin\.workbuddy-ai\binaries\node\versions\22.22.2-6"
supabase.cmd login
```

Browser opens → approve → then:

```powershell
cd "C:\Users\Admin\Downloads\AgriSuri v4"
powershell -ExecutionPolicy Bypass -File tools\deploy-gateway.ps1
```

The script sets six secrets, deploys the function, and verifies the endpoint.
It is safe to re-run — secrets are overwritten, not duplicated.

Expected last line: `gateway is live`.

---

## 4. Verify from the app

1. Laptop: `http://localhost:5173`
2. Sign in (or register a farmer account)
3. **Scan → Model status** — all four rows should read *Configured*
4. Take a photo with the phone, or upload one on the laptop

A scan runs four steps in a fixed order:

| Step | What it proves | Model |
|---|---|---|
| Quality | not blurry, not dark, leaf fills the frame | heuristic |
| Shape gate | this is a plant, not a desk | `shape-u5iks/1` |
| Texture gate | leaf surface, not a wall or floor | `texture-8frhk/1` |
| Disease | which disease, or healthy | `tomato_diseases-ksz6z/1` · `rice_diseases-qcvnv/1` |

The result screen lists every class with its normalised percentage, highest
first, and shows **what to do** and **how to prevent it** from the `diseases`
table.

### How the gates decide

Raw softmax scores are not calibrated. On this dataset a palay field photo
scores 0.52 vs 0.48, while a wall scores 0.89 vs 0.11. Both are binary answers,
but only one carries information.

So the gates reject only on a **confident negative** — top class matches a
negative pattern *and* it beats the runner-up by 0.15 or clears the threshold.
Everything else passes to the next layer. A false reject costs a farmer the
whole scan; a false accept costs one extra model call, and the disease stage
still reports low confidence honestly.

Measured on this dataset: 0/12 negative images passed either gate, 11/12
close-up leaf patches and 8/8 palay field photos reached the disease model.

Rejections at the gates are data-quality events. They are recorded but excluded
from every analytics aggregate — a wall photo must not inflate the scan count.

---

## 5. What the server will and will not serve

`tools/serve.js` uses an allow-list, not a deny-list. Only these are reachable:

- `*.html` at the root
- `script/`, `style/`, `assets/`
- `manifest.json`, `sw.js`, `favicon.ico`

Everything else returns 404, including `dataset/`, `sql/`,
`supabase/functions/` (server-only code) and `.workbuddy-ai/`. This matters
because `--lan` exposes the port to every device on the network — a traversal
guard alone would still have served those folders.

---

## 6. Account caps

The database allows **50 farmers, 15 admins, 15 DA officers**. The cap is
enforced by a trigger, not by the UI, and it takes an advisory lock so two
simultaneous signups cannot both squeeze past the last slot.

`sql/schema.sql` already carries these numbers. A database created from an
older schema needs the change applied once — paste `sql/apply-role-caps.sql`
into **Supabase → SQL Editor → Run**. It is idempotent.

Changing a number means editing three places: the function in `schema.sql`, the
same function in `apply-role-caps.sql`, and the assertion in
`tests/integrity.test.js`. The test exists so the cap cannot drift silently.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Phone times out | firewall block rule | run the admin block in step 2 |
| `inference DISABLED` in the banner | no key file | create `tools/roboflow.key` with the Roboflow key |
| Scan says `model_not_configured` | key missing, or wrong host | check the banner; on a public host the Edge Function must be deployed |
| `upstream_error ... 404` | model slug renamed after training | add the pre-rename slug to `MODELS` in `serve.js` |
| Scan rejected as not-a-leaf | gate margin above 0.15 | genuine negative, or a photo with no leaf in frame |
| Wrong network shown | laptop on a different SSID | join the same Wi-Fi; 5 GHz vs 2.4 GHz is fine |
| `EADDRINUSE` | port already used | `npm run serve:lan -- 5174` |
| Camera button downloads a file | desktop browser without permission | allow camera, or use *Upload* |
| Blank page after edits | service worker cache | hard reload, or DevTools → Application → Unregister |

---

## Ports and addresses

| What | Where |
|---|---|
| Front end | `http://localhost:5173` (laptop), `http://<lan-ip>:5173` (phone) |
| Database / auth | `https://romlxfchyvjbwuzsgoqq.supabase.co` |
| Inference | `https://romlxfchyvjbwuzsgoqq.supabase.co/functions/v1/infer` |

The `phone` address is whatever the server prints. It is derived from the active
network adapter, so a VPN, a Wi-Fi change, or a router reboot can change it.

### Two limits of HTTP dev mode

- **Service worker / offline cache does not register.** Browsers require HTTPS
  for service workers. The app catches the failure and keeps working online.
- **"Add to Home Screen" still works**, but the installed icon will not cache
  pages offline. Use a tunnel or real hosting if you need offline mode.

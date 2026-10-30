# Portfolio Tracker

A personal Progressive Web App for tracking **simulated** investment portfolios
and answering one question: *if the same money went into each portfolio, which
would do best?* Everything runs in the browser and data stays on your device.

- Free and open-source only. The only runtime libraries are React and React DOM.
- Runs in any modern browser on Windows. Installs on iPhone via Safari →
  Share → **Add to Home Screen** (see *Put it online* below).

---

## Run it on Windows

1. Install **Node.js 22.12 or newer** (the current LTS is fine) from <https://nodejs.org>. Accept the defaults.
   Check with `node -v`.
2. Unzip this folder, e.g. to `C:\Users\<you>\portfolio-tracker`.
3. Open the folder in File Explorer, click the address bar, type `powershell`, press Enter.
4. Install dependencies (first time only, ~1 minute):

   ```powershell
   npm install
   ```

   If PowerShell says *"running scripts is disabled on this system"*, run this once
   and answer `Y`, then retry:

   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```

   (Or use `npm.cmd install`, or run the commands from Command Prompt instead.)

5. Start the app:

   ```powershell
   npm run dev
   ```

   Open the `Local:` address it prints (usually <http://localhost:5173>) in Edge or Chrome.
   Stop it with `Ctrl + C`.

### Other commands

| Command | What it does |
|---|---|
| `npm test` | Runs the unit tests for the money, ledger, allocation, schedule and switch logic |
| `npm run typecheck` | Checks all TypeScript for type errors |
| `npm run build` | Type-checks and builds the production version into `dist/` |
| `npm run preview` | Serves the production build locally (this one includes offline support) |

### Peek at it on your iPhone during development

`npm run dev` also prints a `Network:` address such as `http://192.168.1.20:5173`.
With the phone on the same Wi-Fi, open that address in Safari. If Windows asks
whether Node.js may use the network, allow it on **private networks**. This is
for looking only: installing to the Home Screen and offline mode need HTTPS —
see *Put it online* below.

---

## Put it online and install it on your iPhone (free)

The app is hosted on **GitHub Pages** (free HTTPS). Every time you push the
code, GitHub runs the tests, builds the app and publishes it — see
`.github/workflows/deploy.yml`. Your portfolio data is never uploaded: it stays
in each device's browser. The repository only holds the code.

### A. One-time setup (about 20 minutes)

1. **Install Git for Windows** from <https://git-scm.com/download/win> (accept the
   defaults). Close and reopen PowerShell, then check: `git --version`.
2. **Tell Git your name** (shown on your commits):

   ```powershell
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```

3. **Create the repository on GitHub:** github.com → **+** (top right) →
   **New repository** → name it `portfolio-tracker` → choose **Public** (free
   GitHub Pages needs a public repository; it contains code only, none of your
   data) → leave *Add a README*, *.gitignore* and *license* **off** →
   **Create repository**.
4. **Upload the code.** In PowerShell, inside the project folder (replace
   `YOUR-USERNAME`):

   ```powershell
   git init
   git add .
   git status            # node_modules and dist must NOT be listed
   git commit -m "Portfolio tracker"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/portfolio-tracker.git
   git push -u origin main
   ```

   A sign-in window opens the first time — sign in to GitHub in the browser.
5. **Turn on Pages:** on the repository page → **Settings** → **Pages** →
   *Build and deployment* → **Source: GitHub Actions**.
6. **Watch it publish:** **Actions** tab → *Test and deploy*. After ~2 minutes it
   turns green. If the first run failed because Pages wasn't on yet, open it and
   click **Re-run all jobs**.
7. **Open the app:** `https://YOUR-USERNAME.github.io/portfolio-tracker/`

### B. Move your data to the online app

The online app is a new address, so it starts empty (each address has its own
storage). On the laptop: open the **local** app → **Settings → Download
backup**, then open the **online** app → **Settings → Restore from backup**.

### C. Install on iPhone

1. In **Safari**, open `https://YOUR-USERNAME.github.io/portfolio-tracker/`.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open the app **from the Home Screen icon** (it has its own storage, separate
   from Safari) → **Settings → Restore from backup** → choose your backup file.

From then on, use the Home Screen app on the phone and the online address on
the laptop (Edge/Chrome can also install it: the ⊕ icon in the address bar).
Installed apps open offline and Safari doesn't clear their data.

### D. Publishing future updates

Copy the new zip over the project folder (Replace), then:

```powershell
npm install
npm test
git add .
git commit -m "Describe the update"
git push
```

It's live about 2 minutes later. On the iPhone, close the app fully and reopen
it (sometimes twice) to load the new version — **Settings** shows the version
number at the bottom.

---

## Folder structure

```
src/
  app/            App shell, tab routing, PWA setup (service worker, persistent storage)
  ui/
    components/   Reusable pieces (TabBar, Dialog)
    screens/      One file per screen
    styles.css    Design tokens (colours, spacing) + all styles
  application/    Glue between UI and data (useLiveQuery hook; later: use cases, refresh scheduler)
  domain/         Pure TypeScript business logic — no browser APIs, no React
    money/        Dec fixed-point decimal + formatting
    calendar/     ISO dates + US market trading calendar (holidays, next trading day)
    portfolio/    Ledger replay (positions, cost basis, cash), valuation, breakdown by class
    pricing/      Price on a date, manual-price freshness and reminders
    assets/       Add asset / Update holding validation, delete-asset plan
    sync/         Backup file format + merge rules (two-device use)
    contributions/ Allocation validation, purchase planner, recurring schedule, ledger entries
    switches/     Opening positions for past-dated portfolios, statement check, switch cost
    types.ts      Shared data shapes
  data/
    db/           IndexedDB wrapper + schema/migrations
    repositories/ Read/write functions per entity
public/           manifest, service worker, icons
tests/            Unit tests, mirroring src/domain
```

**Dependency rule:** `ui → application → domain` and `application → data → domain`.
The domain imports nothing from the other layers. That keeps the financial logic
testable without a browser, and lets new asset types, data providers or signal
rules be added without touching screens.

**Where the formulas are documented:** each domain file starts with a comment
block explaining its maths (e.g. average-cost basis in `portfolio/ledger.ts`,
rounding and top-up rules in `contributions/purchase.ts`, switch cost in
`switches/opening.ts`).

### Why so few libraries?

| Instead of | This project uses | Reason |
|---|---|---|
| decimal.js | `domain/money/decimal.ts` (BigInt, 12 dp) | Exact cents/shares; ~150 lines, fully tested |
| Dexie | `data/db/idb.ts` | Thin IndexedDB wrapper; atomic multi-store writes |
| Tailwind | `ui/styles.css` with CSS variables | No build plugin; colours live in one place |
| vite-plugin-pwa | `public/sw.js` + `manifest.webmanifest` | Short, readable caching rules |
| Zustand / TanStack Query | `useLiveQuery` hook | Screens re-read the DB when it changes |

Fewer dependencies mean fewer breaking upgrades. Any of these can be swapped in
later without touching the domain layer.

---

## Data and privacy

- All data is stored in this browser's IndexedDB, on this device only. Nothing
  is uploaded.
- The laptop and the iPhone keep **separate** copies. To keep them in step:
  **Settings → Download/Share backup** on the device you just used, then
  **Settings → Restore from backup** on the other. Restoring *merges*:
  new items are added, the most recent edit wins, deletions carry over.
- Backups contain your portfolio data (not your API key or settings). Keep them private.
- The app asks the browser for persistent storage so data isn't evicted when
  space runs low. Regular backups are still the real safeguard.

---

## Roadmap

| Step | Feature | Status |
|---|---|---|
| 1 | Project scaffold, domain core + tests, database, Portfolios screen (create / rename / delete) | ✅ |
| 2 | Manual-price assets, starting positions, units/price updates, reminders, delete asset, portfolio dashboard | ✅ |
| 3 | Backup & restore with **merge** (use the laptop and iPhone side by side), delete all data | ✅ |
| 4 | Free HTTPS hosting (GitHub Pages), offline mode, install on iPhone | ✅ |
| 5 | Market data: Twelve Data provider behind an interface, price cache, rate limiter, Settings (API key) | |
| 6 | Money & allocation: versioned targets, one-time and recurring contributions, catch-up, ledger screen | |
| 7 | Dashboard: performance chart (1D–All), projection | |
| 8 | Signals & risk profile | |
| 9 | Compare: equal-money backtest, TWR view, Sharpe, drawdown; Track a switch | |

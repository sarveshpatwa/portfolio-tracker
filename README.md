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
    pricing/      Price on a date, manual-price freshness and reminders, price links (Vanguard)
    assets/       Add asset / Update holding validation, delete-asset plan
    sync/         Backup file format + merge rules (two-device use)
    market/       US market hours (DST-safe), free-plan budget + credit limiter, history gaps
    contributions/ Allocation validation, purchase planner, recurring schedule, ledger entries
    switches/     Opening positions for past-dated portfolios, statement check, switch cost
    types.ts      Shared data shapes
  data/
    db/           IndexedDB wrapper + schema/migrations
    repositories/ Read/write functions per entity (+ device settings)
    providers/    MarketDataProvider interface + Twelve Data adapter (swap here)
public/           manifest, service worker, icons
relay/            Cloudflare Worker for price links (deployed separately, not part of the app build)
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

## Live prices (Twelve Data, free)

1. Create a free account at <https://twelvedata.com/pricing> (Basic plan) and copy your API key.
2. In the app: **Settings → Market data** → paste the key → **Save and test**.
3. **Add asset → Market ticker** → search a US ticker or name → pick it → optionally enter
   shares and a purchase date (leave the cost empty to use that day's closing price).

How it stays within the free 8 credits/minute and 800/day:

- Live quotes only during US market hours (9:30–16:00 New York time), every 5–30 minutes
  (your choice), automatically spaced out if you hold many tickers. 1 credit per ticker.
- A ticker's daily history is downloaded once (1 credit), then only missing days.
  Today's live price becomes the closing price after the bell — no extra request.
- Downloaded market prices are **not** put in backups (they'd be large); each device
  downloads its own after a restore.
- Prices refresh only while the app is open (iOS pauses web apps in the background).

If prices never load and Settings says the browser blocked the request, Twelve Data is
refusing calls from web pages. The **Advanced → API address** field lets you point the
app at a small free proxy (e.g. a Cloudflare Worker) instead — ask and it can be added.

## Price links (Vanguard funds without a ticker)

Some Vanguard funds (e.g. plan or trust funds in a 401k) have no ticker, but Vanguard's
fund page shows their price every day. A manual asset can carry that page's link, and the
app then fetches the closing price daily. Typing prices still works: **a typed price always
wins on its date**.

Browsers don't let a web app read Vanguard's data directly, so the app asks a tiny relay
that you own: a free **Cloudflare Worker** (`relay/worker.js`, ~80 lines). It only fetches
`vanguard.com` addresses, only answers your app's address, stores nothing, and sees fund
numbers — never your holdings. The free plan allows 100,000 requests a day; the app uses a
few per fund per day.

### One-time relay setup (about 10 minutes)

1. Sign up (free, no card) at <https://dash.cloudflare.com/sign-up> and verify your email.
2. In the dashboard: **Workers & Pages** (may be under **Compute**) → **Create** →
   **Create Worker** (or *Start with Hello World*) → name it `vanguard-relay` → **Deploy**.
3. Click **Edit code**. Delete everything in the editor, paste the whole content of
   `relay/worker.js` from this project, and click **Deploy**.
   - If you open the app from an address other than `https://sarveshpatwa.github.io`,
     add it to `ALLOWED_ORIGINS` at the top of the file first.
4. Copy the worker's address shown at the top, e.g.
   `https://vanguard-relay.yourname.workers.dev`.
5. In the app: **Settings → Price links** → paste it into **Relay address** → **Save and
   test**. It should say *"Relay works — fund 0066 is $1.0000 (…)"*.
   Do this on the laptop **and** the iPhone (device settings aren't in backups).

### Using it (one-time setup per fund)

- **All funds at once:** **Settings → Your funds** lists every manual-price asset across all
  portfolios (the same fund held in two portfolios is one row, matched by name). Type each
  Vanguard fund's code once — e.g. `0066` or `N467` — and tap **Save codes**. That's it:
  from then on prices are fetched automatically. **Fetch all now** forces a refresh.
- **New asset:** Add asset → Manual price → paste the fund's Vanguard page link or code
  under *Daily price from Vanguard*. Leave the price empty to start from Vanguard's latest price.
- **One asset:** tap **···** on the holding → paste the link or code → **Save link** (also
  applied to the same fund in your other portfolios). The same place has **Fetch now**,
  **Open Vanguard page** and removing the link.
- Prices you typed **before** setting up a code (e.g. starting prices) are replaced by
  Vanguard's price for the same day. Prices you type **after** setup win on their date.
- Prices are fetched when the app opens and while it's open, once Vanguard has published
  the day's price (US evening; India early morning). If a fetch fails, the holding says so
  and keeps the last price.
- Fetched prices **are** included in backups (Vanguard's feed only gives the latest price,
  so past days can't be downloaded again).

### If it stops working

Vanguard's price feed isn't an official public service and can change. If Settings →
*Save and test* says the data address may have changed: open the fund page in Edge →
**F12 → Network → Fetch/XHR** → reload → filter `json` → find the request whose Preview
shows the price → copy its URL, replace the fund number with `{id}`, and paste it into
**Settings → Price links → Advanced → Vanguard data address**.

## Simulated contributions (Money & allocation)

Open a portfolio → **Add money**.

1. **Target allocation** — percentages per asset; they must total 100%. Saving creates a new
   *version* that applies from today; past contributions keep the version they used.
2. **How to buy** — fractional shares (6 decimals, sub-cent leftover stays as cash) or whole
   shares (remainder stays as cash; optional top-up of assets still below target).
3. **One-time** — an amount and a date. Today = current prices; a past date = that day's
   closing prices (manual assets: the last price you entered by then). You can also invest
   cash already in the portfolio.
4. **Recurring** — amount, how often, start date (a past start back-fills every missed
   contribution). Each date trades at that day's **closing price**, after the close;
   weekends/holidays move to the next trading day. Dates missed while the app was closed are
   caught up the next time it opens. Pausing skips the paused period.

Using both devices: each scheduled buy gets a fixed id (rule + date), so if the laptop and
the iPhone both run it, merging backups keeps one copy.

## Performance chart and projection

Open a portfolio: below the totals is **Performance**.

- **Lines:** portfolio value (solid blue) and amount invested (dashed grey). The gap is your gain.
- **Ranges:** 1D / 1W / 1M / 1Y / All (your choice is remembered). The headline shows the
  **time-weighted return** for the range — money you add doesn't count as growth — and the
  change in gain in dollars.
- **Read a day:** tap or drag on the chart (or focus it and use ← →). *Show as table* lists the numbers.
- **1D** compares the latest value with the previous trading day's close (the free data plan
  has no minute-by-minute prices). On weekends it shows Friday's move.
- Market assets use each day's closing price; manual and Vanguard-linked assets keep their
  last price until the next one (like a fund statement).

**Projection (Estimate)** extends the portfolio's own annualised return 1, 5 and 10 years,
including running recurring contributions (can be switched off). You can type your own growth
rate (e.g. 5 or 7%) to compare. It appears after about 3 months of history and always lists its
assumptions: steady growth, contributions continue, no fees or taxes, past returns don't predict
future ones. Formulas are in `src/domain/portfolio/history.ts` and `projection.ts`.

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
| 5 | Market data: ticker search, live prices during US market hours, daily history, credit limiter, Settings (API key) | ✅ |
| 6 | Money & allocation: versioned targets, buy rules, one-time and recurring contributions (with back-fill and catch-up), ledger + CSV | ✅ |
| 6.5 | Price links: daily prices for Vanguard funds without a ticker, via your free Cloudflare relay | ✅ |
| 7 | Dashboard: performance chart (1D–All, time-weighted return), projection estimate, card trend lines | ✅ |
| 8 | Signals & risk profile | |
| 9 | Compare: equal-money backtest, TWR view, Sharpe, drawdown; Track a switch | |

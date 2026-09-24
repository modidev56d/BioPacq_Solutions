# BioPacq — Live Server Edition (+ Ordering, Admin & Payments)

This turns the original single-file BioPacq app into a real client/server app:

- **Node.js + Express** serves the app and a REST API.
- **SQLite** (via `better-sqlite3`) stores everything on disk in `data/biopacq.db` —
  products, customers, custom rates, stock log, sales, payments.
- **WebSocket** pushes every change to every connected device instantly, so your
  phone and your PC (or two phones) always show the same live data.

The look and feel of the app is untouched — only the data layer changed
(no more `localStorage`; it now talks to this server).

This now has **three screens**, all backed by the same live server:

| Screen | URL | Who it's for |
|---|---|---|
| Business Register | `/index.html` | The original stock/customer/rate ledger |
| **Customer app** | `/customer.html` | Customers browse, add to cart, pay or use credit, and track order status live — installable as a home-screen app |
| **Admin orders panel** | `/admin.html` | You accept/reject new orders within a countdown window, then move them through Preparing → Ready → Out for delivery → Delivered |

Every screen updates instantly on every device via the same WebSocket the register already used — place an order on a phone and it appears on the admin panel within a second.

## 1. Install (one-time)

You need [Node.js](https://nodejs.org) installed (v18 or newer). Then, in this folder:

```bash
npm install
```

## 2. Run the server

```bash
npm start
```

You'll see something like:

```
BioPacq server is running.
------------------------------------------------------------
On this computer:   http://localhost:4000
On your phone/others: http://192.168.1.23:4000   (same WiFi)
------------------------------------------------------------
Data is stored in ./data/biopacq.db — back it up any time.
```

- On the **same computer**: open `http://localhost:4000` in your browser.
- On your **phone**, or a second PC, make sure it's on the **same WiFi**
  as the computer running the server, then open the second URL shown
  (the one with the `192.168.x.x` address) in that device's browser.
- Add it to your phone's home screen (Chrome/Safari → "Add to Home Screen")
  for a full-screen, app-like feel.

Every device that has that page open will update live — add a sale on your
phone and it appears on the PC's dashboard within a second, no refresh needed.

## 3. Keep it running

The server needs to keep running on one computer for everyone to connect to it
(think of it as your "office PC" acting as the shared database). Closing the
terminal / stopping `npm start` takes the app offline for everyone until you
start it again. For always-on use, run it on a computer that stays on, or look
into a process manager like `pm2` (`npm install -g pm2`, then `pm2 start server.js`).

## Where your data lives now

Everything is in `data/biopacq.db`, a single SQLite file. Back it up by simply
copying that file. Import/export to Excel (the spreadsheet icon in the header)
still works exactly as before, and is a good way to keep an extra backup.

## Project layout

```
BioPacq_server/
  server.js      — Express app + WebSocket live-sync broadcast
  db.js          — SQLite schema, seed data, all reads/writes
  package.json
  public/
    index.html   — the app itself (same design, now calls the API)
  data/
    biopacq.db   — created automatically on first run
```

## REST API (for reference)

| Method | Path                          | Purpose                          |
|--------|-------------------------------|-----------------------------------|
| GET    | `/api/state`                  | Full current state (now includes `orders`) |
| GET    | `/api/config`                 | Whether online payments are configured |
| POST   | `/api/stock`                  | Log incoming stock                |
| POST   | `/api/sales`                  | Log a sale (checks stock)         |
| POST   | `/api/customers`              | Add a customer                    |
| PUT    | `/api/customers/:id/rates`    | Update a customer's rate matrix   |
| POST   | `/api/payments`               | Record a payment                  |
| POST   | `/api/import`                 | Commit a parsed Excel import      |
| POST   | `/api/orders/register`        | Quick sign-up for a new customer from the ordering app |
| GET    | `/api/orders`                 | List orders (filter with `?status=` / `?customerId=`) |
| POST   | `/api/orders/create-payment-order` | Step 1 of online payment: creates a Razorpay order |
| POST   | `/api/orders`                 | Place an order (verifies Razorpay signature if paid online) |
| POST   | `/api/orders/:id/accept`      | Admin accepts — deducts stock, books the sale       |
| POST   | `/api/orders/:id/reject`      | Admin rejects, with an optional reason              |
| POST   | `/api/orders/:id/cancel`      | Customer cancels while still pending                |
| PUT    | `/api/orders/:id/status`      | Move an accepted order through the delivery pipeline |

A WebSocket at `/ws` pushes `{"type":"state","payload":{...}}` after every change.

## How the order flow works

1. A customer opens `/customer.html`, enters their phone number (existing
   customers are recognized automatically; new ones register with a name in
   one tap).
2. They build a cart at their own negotiated rates (same rate table as the
   register) and place the order, choosing **Pay Online** or **Credit /
   Udhari** (pay later, same as before).
3. The order lands on `/admin.html` instantly with a **countdown** (10
   minutes by default — change `ACCEPT_WINDOW_MINUTES` in `.env`). You Accept
   or Reject.
   - **Accept** deducts stock and books it as a real sale in the register
     automatically (paid sale if online, udhari if credit) — nothing to
     re-enter.
   - If you don't respond in time, the order **auto-expires** and the
     customer is told immediately.
4. Once accepted, move it through **Preparing → Ready → Out for delivery →
   Delivered** with one tap each; the customer sees the same progress bar
   live on their phone.

## Setting up real online payments (Razorpay)

This app integrates **Razorpay** (India-first, supports UPI/cards/netbanking)
because it's genuinely free to integrate and has a real free tier — but by
law, *any* payment gateway needs your business identity (KYC) before it will
move real money into your bank account. There's no way around that requirement
with any provider, free or paid.

1. Sign up at https://dashboard.razorpay.com/signup — free, no cost to create
   an account.
2. You get **test API keys immediately**, with no KYC required. These let you
   build and fully test the entire payment flow with fake card numbers.
3. When you're ready to accept real money, complete KYC in the dashboard
   (PAN, bank account, business proof — usually reviewed in a few days).
   Once approved, switch to your **live** keys.
4. Copy `.env.example` to `.env` and paste your `RAZORPAY_KEY_ID` and
   `RAZORPAY_KEY_SECRET` in.
5. Restart the server. The **Pay Online** option now appears automatically
   in the customer app. Leave the keys blank and the app works fine with
   **Credit/Udhari only** — nothing breaks.

Razorpay's free plan charges a small per-transaction fee only when a payment
actually succeeds (standard for every payment gateway, since card networks
and banks take a cut) — there's no monthly fee and no setup fee.

## Turning it into an "app" — for free

A **real** Play Store / App Store listing always costs something (Google
Play: one-time $25; Apple App Store: $99/year) — that's Google/Apple's fee,
not something any tool can waive. The genuinely free, zero-cost way to get an
app-like experience is a **PWA** (Progressive Web App), which this project
already is:

1. Deploy the server (see below) so it has a real `https://` address.
2. On a phone, open `/customer.html` (customers) or `/admin.html` (you) in
   Chrome or Safari.
3. Tap the browser menu → **"Add to Home Screen"** (Android/Chrome) or
   **Share → "Add to Home Screen"** (iPhone/Safari).
4. It now behaves like a real app: its own icon, full-screen (no browser
   bar), and works offline for browsing thanks to the built-in service
   worker. Live orders and stock still need an internet connection, same as
   any live app like Zomato.

## Free deployment (so it works from anywhere, not just one WiFi)

Right now the server only reaches devices on the same WiFi. To make it work
over the internet for free, deploy it to a free hosting tier. Two good, free
options:

**Render (easiest)**
1. Push this folder to a GitHub repo.
2. On https://render.com → New → Web Service → connect the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Add your `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` under Environment.
5. Render gives you a free `https://yourapp.onrender.com` URL. Share
   `/customer.html` with customers and keep `/admin.html` for yourself.
   ⚠️ Render's free tier sleeps after ~15 minutes idle (a short delay on the
   next request) and its disk **resets on every redeploy** — fine for
   getting started, but back up `data/biopacq.db` regularly (the export
   button in the register still works), or upgrade to a paid instance /
   attach a persistent disk once you're relying on it daily.

**Railway** (https://railway.app) works the same way and currently offers a
small free monthly credit with a persistent volume, which avoids the
disk-reset issue — a good next step if Render's resets become a problem.

Either way, once it's deployed, both the customer and admin PWAs work from
any phone, anywhere — not just your office WiFi.

## Troubleshooting

- **"Cannot find module 'express'"** (or `razorpay`, `dotenv`) → you skipped `npm install`; run it in this folder.
- **"Pay Online" doesn't show up for customers** → you haven't added Razorpay keys to `.env` yet (or the server hasn't been restarted since you added them). Credit/Udhari still works either way.
- **Phone can't reach the PC's address** → both devices must be on the same
  WiFi network, and your PC's firewall must allow inbound connections on the
  port shown (4000 by default). On Windows, allow Node.js through Windows
  Defender Firewall when prompted the first time.
- **Want a different port** → run `PORT=5000 npm start` (Mac/Linux) or
  `set PORT=5000 && npm start` (Windows).
- I couldn't run `npm install` or start the server myself while building this
  (no internet access in this environment) — the code has been checked for
  syntax errors, but please tell me if anything breaks on your machine so I
  can fix it.
"# BioPacq_Solutions" 

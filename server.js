// server.js — BioPacq backend.
// Serves the app, exposes a REST API backed by SQLite, and pushes every change
// to all connected devices in real time over WebSocket.

require("dotenv").config();
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const Razorpay = require("razorpay");
const db = require("./db");

const PORT = process.env.PORT || 4000;

// Razorpay only turns on once real keys are set in .env (see .env.example).
// Without keys, everything still works — customers just use "Credit / Udhari"
// instead of "Pay Online".
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const razorpay =
  RZP_KEY_ID && RZP_KEY_SECRET
    ? new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET })
    : null;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcastState() {
  const state = db.getFullState();
  const msg = JSON.stringify({ type: "state", payload: state });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on("connection", (ws) => {
  // Send current state immediately to any newly connected device.
  ws.send(JSON.stringify({ type: "state", payload: db.getFullState() }));
});

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------
app.get("/api/state", (req, res) => {
  res.json(db.getFullState());
});

// Public, non-secret info the front-ends need to know at load time.
app.get("/api/config", (req, res) => {
  res.json({
    razorpayEnabled: !!razorpay,
    razorpayKeyId: RZP_KEY_ID || null,
    acceptWindowMinutes: db.ACCEPT_WINDOW_MINUTES,
  });
});

app.post("/api/stock", (req, res) => {
  const result = db.addStock(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  broadcastState();
  res.json({ ok: true, state: db.getFullState() });
});

app.post("/api/sales", (req, res) => {
  const result = db.addSale(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  broadcastState();
  res.json({ ok: true, state: db.getFullState() });
});

app.post("/api/customers", (req, res) => {
  const result = db.addCustomer(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  broadcastState();
  res.json({ ok: true, state: db.getFullState() });
});

app.put("/api/customers/:id/rates", (req, res) => {
  const result = db.updateCustomerRates(req.params.id, (req.body || {}).rates);
  if (result.error) return res.status(400).json({ error: result.error });
  broadcastState();
  res.json({ ok: true, state: db.getFullState() });
});

app.post("/api/payments", (req, res) => {
  const result = db.addPayment(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  broadcastState();
  res.json({ ok: true, state: db.getFullState() });
});

app.post("/api/import", (req, res) => {
  const report = db.importData(req.body || {});
  broadcastState();
  res.json({ report, state: db.getFullState() });
});

// ---------------------------------------------------------------------------
// ORDERS — customer places, admin accepts/rejects within a live time window
// ---------------------------------------------------------------------------

// Quick self-registration for a new walk-in customer from the customer app.
app.post("/api/orders/register", (req, res) => {
  const result = db.addCustomer(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  broadcastState();
  res.json({ ok: true, id: result.id });
});

app.get("/api/orders", (req, res) => {
  res.json(db.listOrders({ status: req.query.status, customerId: req.query.customerId }));
});

app.get("/api/orders/:id", (req, res) => {
  const o = db.getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "Order not found." });
  res.json(o);
});

// Step 1 (only for "Pay Online"): create a Razorpay order for the cart total.
app.post("/api/orders/create-payment-order", async (req, res) => {
  if (!razorpay) {
    return res.status(400).json({ error: "Online payments are not configured yet on this server." });
  }
  const amount = Number((req.body || {}).amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount." });
  try {
    const rzpOrder = await razorpay.orders.create({
      amount: Math.round(amount * 100), // paise
      currency: "INR",
      receipt: "rcpt_" + Date.now(),
    });
    res.json({ ok: true, keyId: RZP_KEY_ID, order: rzpOrder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not start payment. Try again." });
  }
});

// Step 2: create the actual order. If paymentMethod is "online", the
// Razorpay signature is verified server-side before anything is trusted.
app.post("/api/orders", (req, res) => {
  const body = req.body || {};
  if (body.paymentMethod === "online") {
    if (!razorpay) return res.status(400).json({ error: "Online payments are not configured." });
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = body;
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ error: "Missing payment confirmation." });
    }
    const expected = crypto
      .createHmac("sha256", RZP_KEY_SECRET)
      .update(razorpayOrderId + "|" + razorpayPaymentId)
      .digest("hex");
    if (expected !== razorpaySignature) {
      return res.status(400).json({ error: "Payment verification failed." });
    }
  }

  const result = db.createOrder(body);
  if (result.error) return res.status(400).json({ error: result.error });
  broadcastState();
  res.json({ ok: true, order: result.order });
});

app.post("/api/orders/:id/accept", (req, res) => {
  const result = db.acceptOrder(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  broadcastState();
  res.json({ ok: true, order: result.order });
});

app.post("/api/orders/:id/reject", (req, res) => {
  const result = db.rejectOrder(req.params.id, (req.body || {}).reason);
  if (result.error) return res.status(400).json({ error: result.error });
  broadcastState();
  res.json({ ok: true, order: result.order });
});

app.post("/api/orders/:id/cancel", (req, res) => {
  const result = db.cancelOrder(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  broadcastState();
  res.json({ ok: true, order: result.order });
});

app.put("/api/orders/:id/status", (req, res) => {
  const result = db.updateOrderStatus(req.params.id, (req.body || {}).status);
  if (result.error) return res.status(400).json({ error: result.error });
  broadcastState();
  res.json({ ok: true, order: result.order });
});

// Auto-expire orders the admin never responded to in time, and let every
// connected screen (customer + admin) know instantly.
setInterval(() => {
  const expired = db.expireStalePending();
  if (expired.length) broadcastState();
}, 15000);

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  const lanIps = [];
  Object.values(nets).forEach((ifaces) => {
    (ifaces || []).forEach((i) => {
      if (i.family === "IPv4" && !i.internal) lanIps.push(i.address);
    });
  });

  console.log("");
  console.log("  BioPacq server is running.");
  console.log("  ------------------------------------------------------------");
  console.log(`  Business register:  http://localhost:${PORT}/index.html`);
  console.log(`  Customer ordering:  http://localhost:${PORT}/customer.html`);
  console.log(`  Admin orders panel: http://localhost:${PORT}/admin.html`);
  lanIps.forEach((ip) => {
    console.log(`  On your phone/others: http://${ip}:${PORT}/customer.html   (same WiFi)`);
  });
  console.log("  ------------------------------------------------------------");
  console.log("  Data is stored in ./data/biopacq.db — back it up any time.");
  console.log(
    razorpay
      ? "  Online payments: Razorpay is configured. ✅"
      : "  Online payments: not set up yet — customers will use Credit/Udhari. See .env.example."
  );
  console.log("");
});

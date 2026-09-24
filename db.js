const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
// Replace './your-database-folder' with the folder name you are using in your connection string
// For example, if your database path is 'data/database.db', use 'data' here
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)){
    fs.mkdirSync(dbDir, { recursive: true });
}

// db.js — SQLite data layer for BioPacq.
// All persistent state lives in ./data/biopacq.db (created automatically on first run).
const dbPath = path.resolve(__dirname, 'data/database.db'); 

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`Successfully created database directory at: ${dbDir}`);
}
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "data", "biopacq.db");
const db = new Database(dbPath, { verbose: console.log });
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    stock REAL NOT NULL DEFAULT 0,
    baseCost REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT
  );

  CREATE TABLE IF NOT EXISTS customer_rates (
    customerId TEXT NOT NULL,
    productId TEXT NOT NULL,
    rate REAL NOT NULL,
    PRIMARY KEY (customerId, productId),
    FOREIGN KEY (customerId) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS stock_log (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    productId TEXT NOT NULL,
    qty REAL NOT NULL,
    cost REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    customerId TEXT NOT NULL,
    productId TEXT NOT NULL,
    qty REAL NOT NULL,
    rate REAL NOT NULL,
    total REAL NOT NULL,
    cost REAL NOT NULL,
    margin REAL NOT NULL,
    status TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    customerId TEXT NOT NULL,
    amount REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customerId TEXT NOT NULL,
    customerName TEXT NOT NULL,
    customerPhone TEXT,
    itemsJson TEXT NOT NULL,
    amount REAL NOT NULL,
    paymentMethod TEXT NOT NULL,         -- 'online' | 'credit'
    paymentStatus TEXT NOT NULL,         -- 'paid' | 'credit' | 'failed'
    razorpayOrderId TEXT,
    razorpayPaymentId TEXT,
    status TEXT NOT NULL,                -- pending_review|accepted|rejected|preparing|ready|out_for_delivery|delivered|expired|cancelled
    note TEXT,
    placedAt TEXT NOT NULL,
    acceptDeadline TEXT NOT NULL,
    respondedAt TEXT
  );
`);

// How long the admin has to accept/reject a new order before it auto-expires.
const ACCEPT_WINDOW_MINUTES = Number(process.env.ACCEPT_WINDOW_MINUTES || 10);

// ---------------------------------------------------------------------------
// SEED (only if the database is empty — first run)
// ---------------------------------------------------------------------------
function seedIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
  if (count > 0) return;

  const insertProduct = db.prepare(
    "INSERT INTO products (id, name, unit, stock, baseCost) VALUES (?,?,?,?,?)"
  );
  const insertCustomer = db.prepare(
    "INSERT INTO customers (id, name, phone) VALUES (?,?,?)"
  );
  const insertRate = db.prepare(
    "INSERT INTO customer_rates (customerId, productId, rate) VALUES (?,?,?)"
  );
  const insertStock = db.prepare(
    "INSERT INTO stock_log (id, date, productId, qty, cost) VALUES (?,?,?,?,?)"
  );
  const insertSale = db.prepare(
    "INSERT INTO sales (id, date, customerId, productId, qty, rate, total, cost, margin, status) VALUES (?,?,?,?,?,?,?,?,?,?)"
  );
  const insertPayment = db.prepare(
    "INSERT INTO payments (id, date, customerId, amount) VALUES (?,?,?,?)"
  );

  const seed = db.transaction(() => {
    insertProduct.run("p1", "Bagasse Box", "pc", 850, 9);
    insertProduct.run("p2", "Areca Plate", "pc", 1200, 4);
    insertProduct.run("p3", "Compostable Cup", "pc", 2000, 3);

    insertCustomer.run("c1", "Sharma Traders", "98200 11223");
    insertRate.run("c1", "p1", 14);
    insertRate.run("c1", "p2", 7);
    insertRate.run("c1", "p3", 5);

    insertCustomer.run("c2", "Patel Enterprises", "98700 44556");
    insertRate.run("c2", "p1", 13);
    insertRate.run("c2", "p2", 6.5);
    insertRate.run("c2", "p3", 4.5);

    insertStock.run(uid("st"), "2026-09-01", "p1", 850, 9);
    insertStock.run(uid("st"), "2026-09-01", "p2", 1200, 4);
    insertStock.run(uid("st"), "2026-09-01", "p3", 2000, 3);

    insertSale.run(uid("sl"), "2026-09-01", "c1", "p1", 357, 14, 4998, 3213, 1785, "udhari");
    insertSale.run(uid("sl"), "2026-09-10", "c2", "p2", 492, 6.5, 3198, 1968, 1230, "udhari");

    insertPayment.run(uid("pm"), "2026-09-15", "c1", 2000);
    insertPayment.run(uid("pm"), "2026-09-20", "c1", 1000);
  });
  seed();
}
seedIfEmpty();

// ---------------------------------------------------------------------------
// READ: full state, shaped exactly like the original localStorage object
// ---------------------------------------------------------------------------
function getFullState() {
  const products = db.prepare("SELECT * FROM products").all();
  const customersRaw = db.prepare("SELECT * FROM customers").all();
  const rateRows = db.prepare("SELECT * FROM customer_rates").all();
  const stockLog = db
    .prepare("SELECT * FROM stock_log ORDER BY date DESC, rowid DESC")
    .all();
  const sales = db
    .prepare("SELECT * FROM sales ORDER BY date DESC, rowid DESC")
    .all();
  const payments = db
    .prepare("SELECT * FROM payments ORDER BY date DESC, rowid DESC")
    .all();
  const orders = listOrders();

  const customers = customersRaw.map((c) => {
    const rates = {};
    rateRows
      .filter((r) => r.customerId === c.id)
      .forEach((r) => {
        rates[r.productId] = r.rate;
      });
    return { id: c.id, name: c.name, phone: c.phone || "", rates };
  });

  return { products, customers, stockLog, sales, payments, orders };
}

// ---------------------------------------------------------------------------
// WRITE OPERATIONS
// ---------------------------------------------------------------------------
function getProduct(id) {
  return db.prepare("SELECT * FROM products WHERE id = ?").get(id);
}
function getCustomer(id) {
  return db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
}
function productByNameFuzzy(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  return (
    db
      .prepare("SELECT * FROM products")
      .all()
      .find((p) => p.name.trim().toLowerCase() === n) || null
  );
}
function customerByNameFuzzy(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  return (
    db
      .prepare("SELECT * FROM customers")
      .all()
      .find((c) => c.name.trim().toLowerCase() === n) || null
  );
}

function addStock({ date, productId, qty, cost }) {
  const p = getProduct(productId);
  if (!p) return { error: "Unknown product." };
  qty = Number(qty);
  cost = Number(cost);
  if (!qty || qty <= 0 || isNaN(cost) || cost < 0) {
    return { error: "Fill quantity and base cost to add stock." };
  }
  const tx = db.transaction(() => {
    db.prepare("UPDATE products SET stock = stock + ?, baseCost = ? WHERE id = ?").run(
      qty,
      cost,
      productId
    );
    db.prepare(
      "INSERT INTO stock_log (id, date, productId, qty, cost) VALUES (?,?,?,?,?)"
    ).run(uid("st"), date || todayStr(), productId, qty, cost);
  });
  tx();
  return { ok: true, product: getProduct(productId) };
}

function addSale({ date, customerId, productId, qty, rate, status }) {
  const p = getProduct(productId);
  const c = getCustomer(customerId);
  qty = Number(qty);
  rate = Number(rate);
  if (!c || !p || !qty || qty <= 0 || isNaN(rate) || rate < 0) {
    return { error: "Fill quantity and rate to log this sale." };
  }
  if (qty > p.stock) {
    return { error: `Only ${p.stock} ${p.unit} of ${p.name} left in stock.` };
  }
  status = status === "udhari" ? "udhari" : "paid";
  const total = Math.round(qty * rate * 100) / 100;
  const cost = Math.round(qty * p.baseCost * 100) / 100;
  const margin = Math.round((total - cost) * 100) / 100;

  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO sales (id, date, customerId, productId, qty, rate, total, cost, margin, status) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(uid("sl"), date || todayStr(), customerId, productId, qty, rate, total, cost, margin, status);
    db.prepare("UPDATE products SET stock = stock - ? WHERE id = ?").run(qty, productId);
  });
  tx();
  return { ok: true };
}

function addCustomer({ name, phone }) {
  name = (name || "").trim();
  if (!name) return { error: "Enter a business name." };
  const id = uid("cu");
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO customers (id, name, phone) VALUES (?,?,?)").run(
      id,
      name,
      (phone || "").trim()
    );
    const products = db.prepare("SELECT * FROM products").all();
    const insertRate = db.prepare(
      "INSERT INTO customer_rates (customerId, productId, rate) VALUES (?,?,?)"
    );
    products.forEach((p) => insertRate.run(id, p.id, p.baseCost));
  });
  tx();
  return { ok: true, id };
}

function updateCustomerRates(customerId, rates) {
  const c = getCustomer(customerId);
  if (!c) return { error: "Unknown customer." };
  const upsert = db.prepare(`
    INSERT INTO customer_rates (customerId, productId, rate) VALUES (?,?,?)
    ON CONFLICT(customerId, productId) DO UPDATE SET rate = excluded.rate
  `);
  const tx = db.transaction(() => {
    Object.keys(rates || {}).forEach((productId) => {
      const val = Number(rates[productId]);
      if (!isNaN(val) && val >= 0) upsert.run(customerId, productId, val);
    });
  });
  tx();
  return { ok: true };
}

function addPayment({ customerId, date, amount }) {
  const c = getCustomer(customerId);
  amount = Number(amount);
  if (!c || !amount || amount <= 0) {
    return { error: "Enter an amount to record a payment." };
  }
  db.prepare("INSERT INTO payments (id, date, customerId, amount) VALUES (?,?,?,?)").run(
    uid("pm"),
    date || todayStr(),
    customerId,
    amount
  );
  return { ok: true };
}

// -------- Import (mirrors the original client-side importWorkbook logic) ---
function importData({ stockRows = [], customerRows = [], saleRows = [] }) {
  const report = {
    stock: { added: 0, errors: [] },
    customers: { added: 0, updated: 0, errors: [] },
    sales: { added: 0, errors: [] },
    sheetsFound: [],
  };

  const tx = db.transaction(() => {
    if (stockRows.length) {
      report.sheetsFound.push("Stock");
      stockRows.forEach((row, idx) => {
        const { date, productName, qty, cost } = row;
        const q = Number(qty);
        if (!productName || isNaN(q) || q <= 0) {
          report.stock.errors.push(`Row ${idx + 2}: missing product or quantity — skipped.`);
          return;
        }
        const p = productByNameFuzzy(productName);
        if (!p) {
          report.stock.errors.push(`Row ${idx + 2}: product "${productName}" not found in the app — skipped.`);
          return;
        }
        let c = Number(cost);
        if (isNaN(c) || c < 0) c = p.baseCost;
        db.prepare("UPDATE products SET stock = stock + ?, baseCost = ? WHERE id = ?").run(q, c, p.id);
        db.prepare(
          "INSERT INTO stock_log (id, date, productId, qty, cost) VALUES (?,?,?,?,?)"
        ).run(uid("st"), date || todayStr(), p.id, q, c);
        report.stock.added++;
      });
    }

    if (customerRows.length) {
      report.sheetsFound.push("Customers");
      customerRows.forEach((row, idx) => {
        let { name, phone, rates } = row;
        if (!name || !String(name).trim()) {
          report.customers.errors.push(`Row ${idx + 2}: missing customer name — skipped.`);
          return;
        }
        name = String(name).trim();
        const existing = customerByNameFuzzy(name);
        const allProducts = db.prepare("SELECT * FROM products").all();
        const resolvedRates = {}; // productId -> rate
        Object.keys(rates || {}).forEach((prodNameKey) => {
          const p = productByNameFuzzy(prodNameKey);
          const val = Number(rates[prodNameKey]);
          if (p && !isNaN(val) && val >= 0) resolvedRates[p.id] = val;
        });

        if (existing) {
          db.prepare("UPDATE customers SET phone = COALESCE(NULLIF(?, ''), phone) WHERE id = ?").run(
            (phone || "").trim(),
            existing.id
          );
          const upsert = db.prepare(`
            INSERT INTO customer_rates (customerId, productId, rate) VALUES (?,?,?)
            ON CONFLICT(customerId, productId) DO UPDATE SET rate = excluded.rate
          `);
          allProducts.forEach((p) => {
            const rate = resolvedRates[p.id] != null ? resolvedRates[p.id] : p.baseCost;
            upsert.run(existing.id, p.id, rate);
          });
          report.customers.updated++;
        } else {
          const id = uid("cu");
          db.prepare("INSERT INTO customers (id, name, phone) VALUES (?,?,?)").run(
            id,
            name,
            (phone || "").trim()
          );
          const insertRate = db.prepare(
            "INSERT INTO customer_rates (customerId, productId, rate) VALUES (?,?,?)"
          );
          allProducts.forEach((p) => {
            const rate = resolvedRates[p.id] != null ? resolvedRates[p.id] : p.baseCost;
            insertRate.run(id, p.id, rate);
          });
          report.customers.added++;
        }
      });
    }

    if (saleRows.length) {
      report.sheetsFound.push("Daily Sales");
      saleRows.forEach((row, idx) => {
        const { date, customerName, productName, qty, rate, status } = row;
        const q = Number(qty);
        const r = Number(rate);
        if (!customerName || !productName || isNaN(q) || q <= 0 || isNaN(r) || r < 0) {
          report.sales.errors.push(`Row ${idx + 2}: missing customer, product, quantity or rate — skipped.`);
          return;
        }
        const c = customerByNameFuzzy(customerName);
        const p = productByNameFuzzy(productName);
        if (!c) {
          report.sales.errors.push(`Row ${idx + 2}: customer "${customerName}" not found — skipped.`);
          return;
        }
        if (!p) {
          report.sales.errors.push(`Row ${idx + 2}: product "${productName}" not found — skipped.`);
          return;
        }
        const total = Math.round(q * r * 100) / 100;
        const cost = Math.round(q * p.baseCost * 100) / 100;
        const margin = Math.round((total - cost) * 100) / 100;
        const st = status === "udhari" ? "udhari" : "paid";
        db.prepare(
          "INSERT INTO sales (id, date, customerId, productId, qty, rate, total, cost, margin, status) VALUES (?,?,?,?,?,?,?,?,?,?)"
        ).run(uid("sl"), date || todayStr(), c.id, p.id, q, r, total, cost, margin, st);
        // Import does not force-deduct stock (matches original: quantities came in via the Stock sheet separately).
        report.sales.added++;
      });
    }
  });
  tx();

  if (report.sheetsFound.length === 0) {
    report.fatal =
      'No matching sheets found. Name your tabs "Stock", "Customers" or "Daily Sales" (any one, or all three) so the app knows what to import.';
  }
  return report;
}

// ---------------------------------------------------------------------------
// ORDERS — customer-facing "place order" flow with a live accept/reject window
// ---------------------------------------------------------------------------
function rowToOrder(row) {
  if (!row) return null;
  return { ...row, items: JSON.parse(row.itemsJson) };
}

function listOrders({ status, customerId } = {}) {
  let rows = db.prepare("SELECT * FROM orders ORDER BY placedAt DESC").all();
  if (status) rows = rows.filter((o) => o.status === status);
  if (customerId) rows = rows.filter((o) => o.customerId === customerId);
  return rows.map(rowToOrder);
}

function getOrder(id) {
  return rowToOrder(db.prepare("SELECT * FROM orders WHERE id = ?").get(id));
}

// items: [{ productId, name, qty, rate }]
// paymentMethod: 'online' (already verified/paid via Razorpay) or 'credit' (udhari, pay later)
function createOrder({
  customerId,
  customerName,
  customerPhone,
  items,
  paymentMethod,
  razorpayOrderId,
  razorpayPaymentId,
}) {
  const c = getCustomer(customerId);
  if (!c) return { error: "Unknown customer. Please register first." };
  if (!Array.isArray(items) || items.length === 0) {
    return { error: "Your cart is empty." };
  }

  // Re-check stock and re-price server-side (never trust the client's totals).
  const priced = [];
  for (const it of items) {
    const p = getProduct(it.productId);
    if (!p) return { error: `Product "${it.productId}" not found.` };
    const qty = Number(it.qty);
    if (!qty || qty <= 0) return { error: `Invalid quantity for ${p.name}.` };
    if (qty > p.stock) {
      return { error: `Only ${p.stock} ${p.unit} of ${p.name} left in stock.` };
    }
    const rateRow = db
      .prepare("SELECT rate FROM customer_rates WHERE customerId = ? AND productId = ?")
      .get(customerId, p.id);
    const rate = rateRow ? rateRow.rate : p.baseCost;
    priced.push({ productId: p.id, name: p.name, unit: p.unit, qty, rate, total: Math.round(qty * rate * 100) / 100 });
  }
  const amount = Math.round(priced.reduce((s, it) => s + it.total, 0) * 100) / 100;

  const method = paymentMethod === "online" ? "online" : "credit";
  const paymentStatus = method === "online" ? "paid" : "credit";

  const now = new Date();
  const deadline = new Date(now.getTime() + ACCEPT_WINDOW_MINUTES * 60000);
  const id = uid("or");

  db.prepare(
    `INSERT INTO orders
      (id, customerId, customerName, customerPhone, itemsJson, amount, paymentMethod, paymentStatus,
       razorpayOrderId, razorpayPaymentId, status, note, placedAt, acceptDeadline, respondedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    customerId,
    customerName || c.name,
    customerPhone || c.phone || "",
    JSON.stringify(priced),
    amount,
    method,
    paymentStatus,
    razorpayOrderId || null,
    razorpayPaymentId || null,
    "pending_review",
    null,
    now.toISOString(),
    deadline.toISOString(),
    null
  );

  return { ok: true, order: getOrder(id) };
}

// Accept: locks in the order, deducts stock, and books it as a real sale
// (paid sale if it was an online payment, udhari/credit sale otherwise).
function acceptOrder(id) {
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!o) return { error: "Order not found." };
  if (o.status !== "pending_review") return { error: `Order is already ${o.status}.` };

  const items = JSON.parse(o.itemsJson);
  // Verify stock is still available for every line before committing anything.
  for (const it of items) {
    const p = getProduct(it.productId);
    if (!p || it.qty > p.stock) {
      return { error: `Not enough stock left for ${it.name} to accept this order.` };
    }
  }

  const saleStatus = o.paymentMethod === "online" ? "paid" : "udhari";
  const tx = db.transaction(() => {
    items.forEach((it) => {
      const p = getProduct(it.productId);
      const cost = Math.round(it.qty * p.baseCost * 100) / 100;
      const margin = Math.round((it.total - cost) * 100) / 100;
      db.prepare("UPDATE products SET stock = stock - ? WHERE id = ?").run(it.qty, it.productId);
      db.prepare(
        "INSERT INTO sales (id, date, customerId, productId, qty, rate, total, cost, margin, status) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).run(uid("sl"), todayStr(), o.customerId, it.productId, it.qty, it.rate, it.total, cost, margin, saleStatus);
    });
    if (o.paymentMethod === "online") {
      db.prepare("INSERT INTO payments (id, date, customerId, amount) VALUES (?,?,?,?)").run(
        uid("pm"),
        todayStr(),
        o.customerId,
        o.amount
      );
    }
    db.prepare("UPDATE orders SET status = 'accepted', respondedAt = ? WHERE id = ?").run(
      new Date().toISOString(),
      id
    );
  });
  tx();
  return { ok: true, order: getOrder(id) };
}

function rejectOrder(id, reason) {
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!o) return { error: "Order not found." };
  if (o.status !== "pending_review") return { error: `Order is already ${o.status}.` };
  db.prepare("UPDATE orders SET status = 'rejected', note = ?, respondedAt = ? WHERE id = ?").run(
    (reason || "").trim() || "Rejected by store.",
    new Date().toISOString(),
    id
  );
  return { ok: true, order: getOrder(id) };
}

function cancelOrder(id) {
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!o) return { error: "Order not found." };
  if (o.status !== "pending_review") return { error: "This order can no longer be cancelled." };
  db.prepare("UPDATE orders SET status = 'cancelled', respondedAt = ? WHERE id = ?").run(
    new Date().toISOString(),
    id
  );
  return { ok: true, order: getOrder(id) };
}

// Any status after acceptance: preparing -> ready -> out_for_delivery -> delivered
const NEXT_STATUSES = ["accepted", "preparing", "ready", "out_for_delivery", "delivered"];
function updateOrderStatus(id, status) {
  if (!NEXT_STATUSES.includes(status)) return { error: "Invalid status." };
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!o) return { error: "Order not found." };
  if (o.status === "pending_review" || o.status === "rejected" || o.status === "expired" || o.status === "cancelled") {
    return { error: "This order was never accepted." };
  }
  db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, id);
  return { ok: true, order: getOrder(id) };
}

// Called on a timer: any order still pending_review past its deadline auto-expires.
function expireStalePending() {
  const nowIso = new Date().toISOString();
  const stale = db
    .prepare("SELECT id FROM orders WHERE status = 'pending_review' AND acceptDeadline < ?")
    .all(nowIso);
  if (stale.length === 0) return [];
  const upd = db.prepare("UPDATE orders SET status = 'expired', respondedAt = ? WHERE id = ?");
  const tx = db.transaction(() => stale.forEach((r) => upd.run(nowIso, r.id)));
  tx();
  return stale.map((r) => r.id);
}

module.exports = {
  getFullState,
  addStock,
  addSale,
  addCustomer,
  updateCustomerRates,
  addPayment,
  importData,
  getCustomer,
  getProduct,
  createOrder,
  listOrders,
  getOrder,
  acceptOrder,
  rejectOrder,
  cancelOrder,
  updateOrderStatus,
  expireStalePending,
  ACCEPT_WINDOW_MINUTES,
};

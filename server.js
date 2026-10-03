// server.js
// Small read-only proxy between your OTB planner artifact and Shopify's Admin API.
// The Admin API token lives only here (server-side) - the browser never sees it.

const express = require("express");
const cors = require("cors");

// Load .env file
try {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (!process.env[key]) process.env[key] = value;
      }
    });
  }
} catch (e) { /* ignore */ }

const PORT = process.env.PORT || 8787;
const STORE = process.env.SHOPIFY_STORE; // e.g. yourstore.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN; // shpat_...
const API_VERSION = "2026-07";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"; // lock this down to your artifact's origin if you have it

if (!STORE || !TOKEN) {
  console.error("Missing SHOPIFY_STORE or SHOPIFY_ADMIN_TOKEN env vars.");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.static(require("path").join(__dirname, "public")));

// ---- Password on the data -------------------------------------------------------------------
// The page itself is public (the code is on GitHub anyway); the DATA is not. Every endpoint that
// returns or changes business data needs the header x-otb-key to match STATE_PASSWORD, which is
// set in Render's Environment settings and nowhere else. If STATE_PASSWORD isn't set, everything
// stays open exactly as before, so deploying this before adding the variable breaks nothing.
const crypto = require("crypto");
const STATE_PASSWORD = process.env.STATE_PASSWORD || "";
if (!STATE_PASSWORD) console.warn("STATE_PASSWORD is not set - /state and the sales endpoints are open to anyone with the URL.");
const failedTries = new Map(); // ip -> { count, first }
const LOCKOUT_TRIES = 10, LOCKOUT_MS = 15 * 60 * 1000;
function requirePassword(req, res, next) {
  if (!STATE_PASSWORD) return next();
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const now = Date.now();
  const f = failedTries.get(ip);
  if (f && now - f.first >= LOCKOUT_MS) failedTries.delete(ip);
  const cur = failedTries.get(ip);
  if (cur && cur.count >= LOCKOUT_TRIES) return res.status(429).json({ error: "Too many wrong passwords. Try again in 15 minutes." });
  const given = String(req.headers["x-otb-key"] || "");
  // Compare hashes so the check takes the same time whatever was typed.
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(STATE_PASSWORD).digest();
  if (given && crypto.timingSafeEqual(a, b)) { failedTries.delete(ip); return next(); }
  if (given) { // a request with no password at all isn't a guess - don't count it toward the lockout
    if (cur) cur.count++; else failedTries.set(ip, { count: 1, first: now });
  }
  return res.status(401).json({ error: "Password required." });
}
app.use(["/state", "/sales-by-type", "/vendor-report", "/inventory-by-type", "/line-items", "/week-summary"], requirePassword);

async function shopifyGraphQL(query, variables, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const data = await res.json();
    const throttled = data.errors && Array.isArray(data.errors) && data.errors.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < retries) {
      // Shopify's GraphQL API uses a cost-based leaky-bucket limit - back off and let it refill
      // rather than failing outright, since a full catalog scan can burn through it quickly.
      const wait = data.extensions?.cost?.throttleStatus?.restoreRate
        ? Math.ceil(1000 / data.extensions.cost.throttleStatus.restoreRate) * 200
        : 1000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    return data.data;
  }
}

app.get("/health", (req, res) => res.json({ ok: true, store: STORE }));

// Server-side app state (so the same data shows up on every device/browser).
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const STATE_KEY = "otb-app-state";
async function upstash(command) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
app.get("/state", async (req, res) => {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return res.status(501).json({ error: "Server-side storage isn't configured (missing UPSTASH_REDIS_REST_URL/TOKEN)." });
  try {
    const value = await upstash(["GET", STATE_KEY]);
    res.json({ value: value || null });
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});
app.use(express.json({ limit: "5mb" }));
app.post("/state", async (req, res) => {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return res.status(501).json({ error: "Server-side storage isn't configured (missing UPSTASH_REDIS_REST_URL/TOKEN)." });
  try {
    const value = JSON.stringify(req.body);
    await upstash(["SET", STATE_KEY, value]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

// GET /sales-by-type?start=2026-07-01&end=2026-07-31
// Returns { "1101 Tees/Tunics Solid": { sales: 1234.56, cogs: 567.89 }, ... }
// Gross sales are attributed to the month the order was CREATED. Returns are attributed to
// the month the REFUND actually happened, even if the original order was created in an
// earlier month - matching how Shopify's own Net Sales report works.
app.get("/sales-by-type", async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end (YYYY-MM-DD) are required" });

  const totals = {};
  function addTotal(type, sales, cogs) {
    if (!type) type = "9999 Unclassified";
    if (!totals[type]) totals[type] = { sales: 0, cogs: 0 };
    totals[type].sales += sales;
    totals[type].cogs += cogs;
  }
  function inRange(isoDateTime) {
    const d = (isoDateTime || "").slice(0, 10);
    return d >= start && d <= end;
  }

  const MAX_PAGES = 40; // safety cap ~2000 orders per pass
  let truncated = false;

  try {
    // Pass 1: gross sales - orders CREATED in this window
    {
      const searchQuery = `created_at:>=${start} AND created_at:<=${end} AND -status:cancelled`;
      let cursor = null, hasNextPage = true, pages = 0;
      const query = `
        query($cursor: String, $searchQuery: String!) {
          orders(first: 50, after: $cursor, query: $searchQuery) {
            edges {
              cursor
              node {
                subtotalPriceSet { shopMoney { amount } }
                lineItems(first: 100) {
                  edges {
                    node {
                      quantity
                      isGiftCard
                      discountedTotalSet { shopMoney { amount } }
                      product { productType }
                      variant { inventoryItem { unitCost { amount } } }
                    }
                  }
                }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `;
      while (hasNextPage && pages < MAX_PAGES) {
        const data = await shopifyGraphQL(query, { cursor, searchQuery });
        data.orders.edges.forEach(({ node, cursor: c }) => {
          cursor = c;
          // Collect this order's non-gift-card lines first, so we can reconcile against the
          // order's actual subtotal - catches order-level discounts (e.g. loyalty point
          // redemptions) that don't show up on any individual line item's own discount field.
          const orderLines = [];
let lineItemSum = 0;    // non-gift-card only - used to attribute dollars to categories
let lineItemSumAll = 0; // includes gift cards - used to reconcile against the order subtotal
node.lineItems.edges.forEach(({ node: li }) => {
  const sales = parseFloat(li.discountedTotalSet.shopMoney.amount || 0);
  lineItemSumAll += sales;
  if (li.isGiftCard) return; // gift card sales aren't revenue
  const type = li.product?.productType;
  const unitCost = parseFloat(li.variant?.inventoryItem?.unitCost?.amount || 0);
  const cogs = unitCost * li.quantity;
  lineItemSum += sales;
  orderLines.push({ type, sales, cogs });
});
const orderSubtotal = parseFloat(node.subtotalPriceSet?.shopMoney?.amount ?? lineItemSumAll);
const extraDiscount = lineItemSumAll - orderSubtotal;
orderLines.forEach((line) => {
  let adjustedSales = line.sales;
  if (Math.abs(extraDiscount) > 0.01 && lineItemSum > 0) {
    // Spread the order-level discount proportionally across the non-gift-card lines only
    // (using their share of the non-gift-card total) - any portion that would've landed on
    // a gift card line is simply dropped, since gift card sales aren't tracked as revenue.
    adjustedSales -= extraDiscount * (line.sales / lineItemSum);
  }
  addTotal(line.type, adjustedSales, line.cogs);
});
        });
        hasNextPage = data.orders.pageInfo.hasNextPage;
        pages++;
      }
      if (hasNextPage) truncated = true;
    }

    // Pass 2: returns - any order UPDATED in this window (catches orders created in a prior
    // month but refunded now), subtracting only the refunds whose own date falls in-window.
    {
      const searchQuery = `updated_at:>=${start} AND updated_at:<=${end} AND -status:cancelled`;
      let cursor = null, hasNextPage = true, pages = 0;
      const query = `
        query($cursor: String, $searchQuery: String!) {
          orders(first: 50, after: $cursor, query: $searchQuery) {
            edges {
              cursor
              node {
                refunds {
                  createdAt
                  refundLineItems(first: 100) {
                    edges {
                      node {
                        quantity
                        subtotalSet { shopMoney { amount } }
                        lineItem { isGiftCard product { productType } variant { inventoryItem { unitCost { amount } } } }
                      }
                    }
                  }
                }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `;
      while (hasNextPage && pages < MAX_PAGES) {
        const data = await shopifyGraphQL(query, { cursor, searchQuery });
        data.orders.edges.forEach(({ node, cursor: c }) => {
          cursor = c;
          node.refunds.forEach((refund) => {
            if (!inRange(refund.createdAt)) return; // refund happened outside this window - skip
            refund.refundLineItems.edges.forEach(({ node: rli }) => {
              if (rli.lineItem?.isGiftCard) return;
              const type = rli.lineItem?.product?.productType;
              const refundAmt = parseFloat(rli.subtotalSet.shopMoney.amount || 0);
              // A returned item gives its cost back too - leaving COGS in place made any week
              // or month with returns read as a margin collapse.
              const refundCost = parseFloat(rli.lineItem?.variant?.inventoryItem?.unitCost?.amount || 0) * rli.quantity;
              addTotal(type, -refundAmt, -refundCost);
            });
          });
        });
        hasNextPage = data.orders.pageInfo.hasNextPage;
        pages++;
      }
      if (hasNextPage) truncated = true;
    }

    res.json({ totals, truncated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /vendor-report?start=2026-07-01&end=2026-07-31
// Returns { vendors: { "VendorName": { sales, cogs, byType: { "1101 ...": {sales, cogs} } } } }
// Same proven logic as /sales-by-type (gift card exclusion, order-subtotal reconciliation for
// discounts like loyalty points, refunds attributed to the month they happened) but grouped by
// vendor instead of category, with a per-product-type breakdown so the frontend can compute a
// sales-weighted "planned margin" from each category's GM% assumption.
app.get("/vendor-report", async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end (YYYY-MM-DD) are required" });

  const vendorTotals = {};
  function addVendor(vendor, type, sales, cogs) {
    if (!vendor) vendor = "(No vendor set)";
    if (!type) type = "9999 Unclassified";
    if (!vendorTotals[vendor]) vendorTotals[vendor] = { sales: 0, cogs: 0, byType: {} };
    vendorTotals[vendor].sales += sales;
    vendorTotals[vendor].cogs += cogs;
    if (!vendorTotals[vendor].byType[type]) vendorTotals[vendor].byType[type] = { sales: 0, cogs: 0 };
    vendorTotals[vendor].byType[type].sales += sales;
    vendorTotals[vendor].byType[type].cogs += cogs;
  }
  function inRange(isoDateTime) {
    const d = (isoDateTime || "").slice(0, 10);
    return d >= start && d <= end;
  }

  const MAX_PAGES = 40;
  let truncated = false;

  try {
    // Pass 1: gross sales - orders CREATED in this window
    {
      const searchQuery = `created_at:>=${start} AND created_at:<=${end} AND -status:cancelled`;
      let cursor = null, hasNextPage = true, pages = 0;
      const query = `
        query($cursor: String, $searchQuery: String!) {
          orders(first: 50, after: $cursor, query: $searchQuery) {
            edges {
              cursor
              node {
                subtotalPriceSet { shopMoney { amount } }
                lineItems(first: 100) {
                  edges {
                    node {
                      quantity
                      isGiftCard
                      vendor
                      discountedTotalSet { shopMoney { amount } }
                      product { productType }
                      variant { inventoryItem { unitCost { amount } } }
                    }
                  }
                }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `;
      while (hasNextPage && pages < MAX_PAGES) {
        const data = await shopifyGraphQL(query, { cursor, searchQuery });
        data.orders.edges.forEach(({ node, cursor: c }) => {
          cursor = c;
          const orderLines = [];
          let lineItemSum = 0, lineItemSumAll = 0;
          node.lineItems.edges.forEach(({ node: li }) => {
            const sales = parseFloat(li.discountedTotalSet.shopMoney.amount || 0);
            lineItemSumAll += sales;
            if (li.isGiftCard) return;
            const type = li.product?.productType;
            const vendor = li.vendor;
            const unitCost = parseFloat(li.variant?.inventoryItem?.unitCost?.amount || 0);
            const cogs = unitCost * li.quantity;
            lineItemSum += sales;
            orderLines.push({ type, vendor, sales, cogs });
          });
          // Same reconciliation as /sales-by-type: the ORIGINAL subtotal (currentSubtotal already
          // has refunds taken out, which pass 2 subtracts again), compared against every line
          // including gift cards, spread in either direction.
          const orderSubtotal = parseFloat(node.subtotalPriceSet?.shopMoney?.amount ?? lineItemSumAll);
          const extraDiscount = lineItemSumAll - orderSubtotal;
          orderLines.forEach((line) => {
            let adjustedSales = line.sales;
            if (Math.abs(extraDiscount) > 0.01 && lineItemSum > 0) {
              adjustedSales -= extraDiscount * (line.sales / lineItemSum);
            }
            addVendor(line.vendor, line.type, adjustedSales, line.cogs);
          });
        });
        hasNextPage = data.orders.pageInfo.hasNextPage;
        pages++;
      }
      if (hasNextPage) truncated = true;
    }

    // Pass 2: returns - orders UPDATED in this window, refunds attributed by their own date
    {
      const searchQuery = `updated_at:>=${start} AND updated_at:<=${end} AND -status:cancelled`;
      let cursor = null, hasNextPage = true, pages = 0;
      const query = `
        query($cursor: String, $searchQuery: String!) {
          orders(first: 50, after: $cursor, query: $searchQuery) {
            edges {
              cursor
              node {
                refunds {
                  createdAt
                  refundLineItems(first: 100) {
                    edges {
                      node {
                        quantity
                        subtotalSet { shopMoney { amount } }
                        lineItem { isGiftCard vendor product { productType } variant { inventoryItem { unitCost { amount } } } }
                      }
                    }
                  }
                }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `;
      while (hasNextPage && pages < MAX_PAGES) {
        const data = await shopifyGraphQL(query, { cursor, searchQuery });
        data.orders.edges.forEach(({ node, cursor: c }) => {
          cursor = c;
          node.refunds.forEach((refund) => {
            if (!inRange(refund.createdAt)) return;
            refund.refundLineItems.edges.forEach(({ node: rli }) => {
              if (rli.lineItem?.isGiftCard) return;
              const type = rli.lineItem?.product?.productType;
              const vendor = rli.lineItem?.vendor;
              const refundAmt = parseFloat(rli.subtotalSet.shopMoney.amount || 0);
              const refundCost = parseFloat(rli.lineItem?.variant?.inventoryItem?.unitCost?.amount || 0) * rli.quantity;
              addVendor(vendor, type, -refundAmt, -refundCost);
            });
          });
        });
        hasNextPage = data.orders.pageInfo.hasNextPage;
        pages++;
      }
      if (hasNextPage) truncated = true;
    }

    res.json({ vendors: vendorTotals, truncated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /inventory-by-type
// Returns { "1101 Tees/Tunics Solid": { units: 120, value: 4560.00 }, ... }
app.get("/inventory-by-type", async (req, res) => {
  const totals = {};
  function addTotal(type, units, value) {
    if (!type) type = "9999 Unclassified";
    if (!totals[type]) totals[type] = { units: 0, value: 0 };
    totals[type].units += units;
    totals[type].value += value;
  }

  let cursor = null;
  let hasNextPage = true;
  let pages = 0;
  let variantsScanned = 0;
  // 500 pages x 100 variants = up to 50,000 variants - comfortably covers a boutique's full
  // catalog. Previously capped at 60 pages (6,000 variants), which silently truncated the scan
  // partway through the catalog and made Weeks of Stock numbers look near-zero across the board
  // for anything not reached before the cap.
  const MAX_PAGES = 500;

  const query = `
    query($cursor: String) {
      productVariants(first: 100, after: $cursor) {
        edges {
          cursor
          node {
            inventoryQuantity
            inventoryItem { unitCost { amount } }
            product { productType }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  `;

  try {
    while (hasNextPage && pages < MAX_PAGES) {
      const data = await shopifyGraphQL(query, { cursor });
      const edges = data.productVariants.edges;
      edges.forEach(({ node, cursor: c }) => {
        cursor = c;
        const type = node.product?.productType;
        const units = node.inventoryQuantity || 0;
        const unitCost = parseFloat(node.inventoryItem?.unitCost?.amount || 0);
        addTotal(type, units, units * unitCost);
        variantsScanned++;
      });
      hasNextPage = data.productVariants.pageInfo.hasNextPage;
      pages++;
    }
    res.json({ totals, truncated: hasNextPage, pagesScanned: pages, variantsScanned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ===== Weekly Owner Dashboard ==============================================
// GET /week-summary?start=2026-09-21&end=2026-09-27
// Everything the dashboard needs for one span of days, in ONE pass over the orders:
//   totals  - gross, discounts, returns, net, orders, units, cogs
//   days    - the same per local calendar day (so Mon-Sun weeks and week-to-date line up)
//   byType  - { "1101 ...": { net, units, cogs } }
//   byVendor- { "Vendor": { net, units, cogs } }
// Definitions follow /sales-by-type exactly (gift cards excluded, order-level discounts such as
// loyalty redemptions spread across the lines, returns dated by when the refund happened), with
// two differences: returned items also give back their COST, so a week with returns does not
// read as a margin collapse; and days are cut in the SHOP's time zone, not UTC.
// Shopify only lets this app see roughly the last 60 days of orders - older weeks come from the
// imported files instead, and the dashboard says which it is using.
let SHOP_TZ = null;
async function shopTimeZone() {
  if (SHOP_TZ) return SHOP_TZ;
  try {
    const d = await shopifyGraphQL(`{ shop { ianaTimezone } }`, {});
    SHOP_TZ = d.shop.ianaTimezone || "America/Regina";
  } catch (e) { SHOP_TZ = "America/Regina"; }
  return SHOP_TZ;
}
// Local calendar date (YYYY-MM-DD) of a UTC timestamp in the given zone.
function localDate(iso, tz) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
// UTC instant at which a local calendar day begins.
function localDayStartUTC(ymd, tz) {
  const [y, m, d] = ymd.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
    const g = (t) => Number(p.find((x) => x.type === t).value);
    const asIfUTC = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
    guess -= asIfUTC - Date.UTC(y, m - 1, d);
  }
  return new Date(guess).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function addDaysYMD(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

app.get("/week-summary", async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end (YYYY-MM-DD) are required" });
  const tz = await shopTimeZone();
  const fromUTC = localDayStartUTC(start, tz);
  const toUTC = localDayStartUTC(addDaysYMD(end, 1), tz); // exclusive

  const blank = () => ({ gross: 0, discounts: 0, returns: 0, net: 0, orders: 0, units: 0, cogs: 0 });
  const totals = blank();
  const days = {};
  for (let d = start; d <= end; d = addDaysYMD(d, 1)) days[d] = blank();
  const byType = {}, byVendor = {};
  function dim(map, key) { if (!map[key]) map[key] = { net: 0, units: 0, cogs: 0 }; return map[key]; }
  function add(day, field, v) { totals[field] += v; if (days[day]) days[day][field] += v; }

  const MAX_PAGES = 40;
  let truncated = false;
  try {
    // Pass 1: sales - orders CREATED in the window
    {
      const searchQuery = `created_at:>='${fromUTC}' AND created_at:<'${toUTC}' AND -status:cancelled`;
      let cursor = null, hasNextPage = true, pages = 0;
      const query = `
        query($cursor: String, $searchQuery: String!) {
          orders(first: 50, after: $cursor, query: $searchQuery) {
            edges { cursor node {
              createdAt
              subtotalPriceSet { shopMoney { amount } }
              lineItems(first: 100) { edges { node {
                quantity isGiftCard vendor
                originalTotalSet { shopMoney { amount } }
                discountedTotalSet { shopMoney { amount } }
                product { productType }
                variant { inventoryItem { unitCost { amount } } }
              } } }
            } }
            pageInfo { hasNextPage }
          }
        }`;
      while (hasNextPage && pages < MAX_PAGES) {
        const data = await shopifyGraphQL(query, { cursor, searchQuery });
        data.orders.edges.forEach(({ node, cursor: c }) => {
          cursor = c;
          const day = localDate(node.createdAt, tz);
          const lines = [];
          let lineSum = 0, lineSumAll = 0;
          node.lineItems.edges.forEach(({ node: li }) => {
            const sales = parseFloat(li.discountedTotalSet.shopMoney.amount || 0);
            lineSumAll += sales;
            if (li.isGiftCard) return;
            const unitCost = parseFloat(li.variant?.inventoryItem?.unitCost?.amount || 0);
            lineSum += sales;
            lines.push({ type: li.product?.productType || "9999 Unclassified", vendor: li.vendor || "(No vendor set)", qty: li.quantity,
                         gross: parseFloat(li.originalTotalSet?.shopMoney?.amount || 0), sales, cogs: unitCost * li.quantity });
          });
          if (!lines.length) return; // gift-card-only order: not a merchandise transaction
          const subtotal = parseFloat(node.subtotalPriceSet?.shopMoney?.amount ?? lineSumAll);
          const extra = lineSumAll - subtotal;
          add(day, "orders", 1);
          lines.forEach((l) => {
            let net = l.sales;
            if (Math.abs(extra) > 0.01 && lineSum > 0) net -= extra * (l.sales / lineSum);
            add(day, "gross", l.gross);
            add(day, "discounts", l.gross - net);
            add(day, "net", net);
            add(day, "units", l.qty);
            add(day, "cogs", l.cogs);
            const t = dim(byType, l.type); t.net += net; t.units += l.qty; t.cogs += l.cogs;
            const v = dim(byVendor, l.vendor); v.net += net; v.units += l.qty; v.cogs += l.cogs;
          });
        });
        hasNextPage = data.orders.pageInfo.hasNextPage;
        pages++;
      }
      if (hasNextPage) truncated = true;
    }
    // Pass 2: returns - refunds whose own date falls in the window. No upper bound on updated_at:
    // an order refunded in the window and touched again afterwards must still be found.
    {
      const searchQuery = `updated_at:>='${fromUTC}' AND -status:cancelled`;
      let cursor = null, hasNextPage = true, pages = 0;
      const query = `
        query($cursor: String, $searchQuery: String!) {
          orders(first: 50, after: $cursor, query: $searchQuery) {
            edges { cursor node {
              refunds { createdAt refundLineItems(first: 100) { edges { node {
                quantity
                subtotalSet { shopMoney { amount } }
                lineItem { isGiftCard vendor product { productType } variant { inventoryItem { unitCost { amount } } } }
              } } } }
            } }
            pageInfo { hasNextPage }
          }
        }`;
      while (hasNextPage && pages < MAX_PAGES) {
        const data = await shopifyGraphQL(query, { cursor, searchQuery });
        data.orders.edges.forEach(({ node, cursor: c }) => {
          cursor = c;
          node.refunds.forEach((refund) => {
            if (!refund.createdAt || refund.createdAt < fromUTC || refund.createdAt >= toUTC) return;
            const day = localDate(refund.createdAt, tz);
            refund.refundLineItems.edges.forEach(({ node: r }) => {
              if (r.lineItem?.isGiftCard) return;
              const amt = parseFloat(r.subtotalSet.shopMoney.amount || 0);
              const cost = parseFloat(r.lineItem?.variant?.inventoryItem?.unitCost?.amount || 0) * r.quantity;
              add(day, "returns", amt);
              add(day, "net", -amt);
              add(day, "units", -r.quantity);
              add(day, "cogs", -cost);
              const t = dim(byType, r.lineItem?.product?.productType || "9999 Unclassified"); t.net -= amt; t.units -= r.quantity; t.cogs -= cost;
              const v = dim(byVendor, r.lineItem?.vendor || "(No vendor set)"); v.net -= amt; v.units -= r.quantity; v.cogs -= cost;
            });
          });
        });
        hasNextPage = data.orders.pageInfo.hasNextPage;
        pages++;
      }
      if (hasNextPage) truncated = true;
    }
    res.json({ start, end, tz, totals, days, byType, byVendor, truncated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /line-items?type=5203%20Bracelets&start=2026-07-01&end=2026-07-31
// Debug tool: shows the raw per-order math behind /sales-by-type for one product type,
// so a category total can be audited order-by-order against Shopify's own reports.
app.get("/line-items", async (req, res) => {
  const { type, start, end } = req.query;
  if (!type || !start || !end) return res.status(400).json({ error: "type, start, and end are required" });

  const rows = [];
  function inRange(isoDateTime) {
    const d = (isoDateTime || "").slice(0, 10);
    return d >= start && d <= end;
  }

  try {
    // Same "created in window" pass as /sales-by-type, but recording per-order detail
    // instead of totals.
    {
      const searchQuery = `created_at:>=${start} AND created_at:<=${end} AND -status:cancelled`;
      let cursor = null, hasNextPage = true, pages = 0;
      const query = `
        query($cursor: String, $searchQuery: String!) {
          orders(first: 50, after: $cursor, query: $searchQuery) {
            edges {
              cursor
              node {
                name
                createdAt
                currentSubtotalPriceSet { shopMoney { amount } }
                subtotalPriceSet { shopMoney { amount } }
                lineItems(first: 100) {
  edges {
    node {
      title
      quantity
      isGiftCard
      originalTotalSet { shopMoney { amount } }
      discountedTotalSet { shopMoney { amount } }
      discountAllocations {
        allocatedAmountSet { shopMoney { amount } }
        discountApplication {
          allocationMethod
          targetSelection
          ... on ManualDiscountApplication { title }
          ... on DiscountCodeApplication { code }
          ... on AutomaticDiscountApplication { title }
        }
      }
      product { productType }
    }
  }
}
                refunds {
                  createdAt
                  refundLineItems(first: 100) {
                    edges {
                      node {
                        subtotalSet { shopMoney { amount } }
                        lineItem { isGiftCard product { productType } title }
                      }
                    }
                  }
                }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `;
      while (hasNextPage && pages < 40) {
        const data = await shopifyGraphQL(query, { cursor, searchQuery });
        data.orders.edges.forEach(({ node, cursor: c }) => {
          cursor = c;
          let lineItemSum = 0, lineItemSumAll = 0;
          const matchingLines = [];
          node.lineItems.edges.forEach(({ node: li }) => {
            const sales = parseFloat(li.discountedTotalSet.shopMoney.amount || 0);
            lineItemSumAll += sales;
            if (li.isGiftCard) return;
            lineItemSum += sales;
            if (li.product?.productType === type) {
  matchingLines.push({
    title: li.title,
    qty: li.quantity,
    originalTotal: parseFloat(li.originalTotalSet?.shopMoney?.amount || 0),
    discountedTotal: sales,
    discountAllocations: (li.discountAllocations || []).map((da) => ({
      amount: parseFloat(da.allocatedAmountSet?.shopMoney?.amount || 0),
      title: da.discountApplication?.title || da.discountApplication?.code || "(unnamed)",
      allocationMethod: da.discountApplication?.allocationMethod,
      targetSelection: da.discountApplication?.targetSelection,
    })),
  });
}
          });
          const orderSubtotal = parseFloat(node.subtotalPriceSet?.shopMoney?.amount ?? lineItemSumAll);
          const extraDiscount = lineItemSumAll - orderSubtotal;
          const matchingRefunds = [];
          node.refunds.forEach((refund) => {
            refund.refundLineItems.edges.forEach(({ node: rli }) => {
              if (rli.lineItem?.isGiftCard) return;
              if (rli.lieuItem?.product?.productType !== type && rli.lineItem?.product?.productType !== type) return;
              matchingRefunds.push({
                refundDate: refund.createdAt, inRange: inRange(refund.createdAt),
                title: rli.lineItem?.title, amount: parseFloat(rli.subtotalSet.shopMoney.amount || 0),
              });
            });
          });
          if (matchingLines.length || matchingRefunds.length) {
            rows.push({
              order: node.name, createdAt: node.createdAt,
              currentSubtotal: node.currentSubtotalPriceSet?.shopMoney?.amount,
              subtotal: node.subtotalPriceSet?.shopMoney?.amount,
              lineItemSum, lineItemSumAll, extraDiscount,
              matchingLines, matchingRefunds,
            });
          }
        });
        hasNextPage = data.orders.pageInfo.hasNextPage;
        pages++;
      }
    }
    res.json({ type, start, end, orders: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => console.log(`OTB Shopify proxy listening on :${PORT}`));

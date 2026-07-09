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

async function shopifyGraphQL(query, variables) {
  const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
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

  const searchQuery = `created_at:>=${start} AND created_at:<=${end}`;
  let cursor = null;
  let hasNextPage = true;
  let pages = 0;
  const MAX_PAGES = 40; // safety cap ~2000 orders

  const query = `
    query($cursor: String, $searchQuery: String!) {
      orders(first: 50, after: $cursor, query: $searchQuery) {
        edges {
          cursor
          node {
            lineItems(first: 100) {
              edges {
                node {
                  quantity
                  discountedTotalSet { shopMoney { amount } }
                  product { productType }
                  variant { inventoryItem { unitCost { amount } } }
                }
              }
            }
            refunds {
              refundLineItems(first: 100) {
                edges {
                  node {
                    quantity
                    subtotalSet { shopMoney { amount } }
                    lineItem { product { productType } }
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

  try {
    while (hasNextPage && pages < MAX_PAGES) {
      const data = await shopifyGraphQL(query, { cursor, searchQuery });
      const edges = data.orders.edges;
      edges.forEach(({ node, cursor: c }) => {
        cursor = c;
        node.lineItems.edges.forEach(({ node: li }) => {
          const type = li.product?.productType;
          const sales = parseFloat(li.discountedTotalSet.shopMoney.amount || 0);
          const unitCost = parseFloat(li.variant?.inventoryItem?.unitCost?.amount || 0);
          const cogs = unitCost * li.quantity;
          addTotal(type, sales, cogs);
        });
        node.refunds.forEach((refund) => {
          refund.refundLineItems.edges.forEach(({ node: rli }) => {
            const type = rli.lineItem?.product?.productType;
            const refundAmt = parseFloat(rli.subtotalSet.shopMoney.amount || 0);
            addTotal(type, -refundAmt, 0);
          });
        });
      });
      hasNextPage = data.orders.pageInfo.hasNextPage;
      pages++;
    }
    res.json({ totals, truncated: hasNextPage, pagesScanned: pages });
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
  const MAX_PAGES = 60;

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
      });
      hasNextPage = data.productVariants.pageInfo.hasNextPage;
      pages++;
    }
    res.json({ totals, truncated: hasNextPage, pagesScanned: pages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => console.log(`OTB Shopify proxy listening on :${PORT}`));

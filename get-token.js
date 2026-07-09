// get-token.js
// One-time helper: walks you through Shopify's OAuth authorization code grant
// and hands you back a permanent Admin API access token (shpat_...).
//
// Usage:
//   SHOPIFY_STORE=yourstore.myshopify.com \
//   SHOPIFY_CLIENT_ID=xxx \
//   SHOPIFY_CLIENT_SECRET=yyy \
//   SHOPIFY_SCOPES=read_products,read_orders,read_inventory \
//   node get-token.js
//
// It starts a tiny local server on http://localhost:3457, prints a URL for
// you to open in your browser, and once you approve the app on Shopify, it
// captures the redirect, exchanges the code for a token, prints it, and
// writes it into a local .env file.

const http = require("http");
const { URL } = require("url");

const STORE = process.env.SHOPIFY_STORE;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SCOPES = process.env.SHOPIFY_SCOPES || "read_products,read_orders,read_inventory";
const REDIRECT_PORT = 3457;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

if (!STORE || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing env vars. Required: SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET");
  process.exit(1);
}

const state = Math.random().toString(36).slice(2);
const authorizeUrl = `https://${STORE}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${encodeURIComponent(SCOPES)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;

console.log("\n1. Make sure the redirect URL below is added to your app's allowed redirect URLs in the Dev Dashboard:");
console.log(`   ${REDIRECT_URI}\n`);
console.log("2. Open this URL in your browser and approve the app on your store:\n");
console.log(`   ${authorizeUrl}\n`);
console.log("Waiting for you to approve the app...\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
  if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (returnedState !== state) {
    res.writeHead(400); res.end("State mismatch - please try again.");
    return;
  }
  if (!code) {
    res.writeHead(400); res.end("No authorization code received.");
    return;
  }

  try {
    const tokenRes = await fetch(`https://${STORE}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("Token exchange failed:", tokenData);
      res.writeHead(500); res.end("Token exchange failed - check your terminal.");
      server.close();
      return;
    }

    console.log("\n✅ Success! Your Admin API access token:\n");
    console.log(`   ${tokenData.access_token}\n`);
    console.log("Scopes granted:", tokenData.scope, "\n");

    const fs = require("fs");
    const envLine = `SHOPIFY_STORE=${STORE}\nSHOPIFY_ADMIN_TOKEN=${tokenData.access_token}\n`;
    fs.writeFileSync(".env", envLine);
    console.log("Wrote SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN into ./.env — keep this file secret.\n");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>Done. Token saved to .env — you can close this tab and return to your terminal.</h2>");
  } catch (err) {
    console.error(err);
    res.writeHead(500); res.end("Error during token exchange - check your terminal.");
  } finally {
    setTimeout(() => { server.close(); process.exit(0); }, 500);
  }
});

server.listen(REDIRECT_PORT);

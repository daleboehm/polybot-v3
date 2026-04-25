#!/usr/bin/env node
// Manual MAKER-side BUY via direct CLOB. Posts a resting limit order at the
// price you specify. Use this when the spread is wide enough to save 1-2¢
// per trade vs taking the ask. Order rests on the book until filled or
// cancelled. Bypasses engine + kill-switch.
//
// Usage:
//   node scripts/manual-buy-post.mjs <condition_id> <YES|NO> <price> <size_usdc> [ttl_minutes]
//
// Example: post a 0.93 bid for $25 of NO on the Mazatlán market, valid 30 min:
//   node scripts/manual-buy-post.mjs 0xfe54... NO 0.93 25 30
//
// To cancel before fill:
//   node -e '(async ()=>{const{readFileSync}=await import("node:fs"); const c=JSON.parse(readFileSync("/opt/polybot-v3/state/api_keys.json","utf8")); const w=JSON.parse(readFileSync("/opt/polybot-v3/state/wallet.json","utf8")); const {ClobClient}=await import("@polymarket/clob-client"); const {createWalletClient,http}=await import("viem"); const {polygon}=await import("viem/chains"); const {privateKeyToAccount}=await import("viem/accounts"); const a=privateKeyToAccount(w.private_key.startsWith("0x")?w.private_key:"0x"+w.private_key); const wc=createWalletClient({account:a,chain:polygon,transport:http()}); const cl=new ClobClient("https://clob.polymarket.com",137,wc,{key:c.POLY_API_KEY,secret:c.POLY_SECRET,passphrase:c.POLY_PASSPHRASE}); console.log(await cl.cancelOrder({orderID:process.argv[1]}));})()' <ORDER_ID>

import { readFileSync } from "node:fs";

const [,, condId, side, priceStr, sizeStr, ttlMinStr] = process.argv;
if (!condId || !["YES","NO"].includes(side) || !priceStr || !sizeStr) {
  console.error("Usage: manual-buy-post.mjs <condition_id> <YES|NO> <price> <size_usdc> [ttl_minutes]");
  process.exit(1);
}
const price = parseFloat(priceStr);
const sizeUsdc = parseFloat(sizeStr);
const ttlMin = ttlMinStr ? parseInt(ttlMinStr) : 0; // 0 = GTC (good til cancel)
const shares = Math.floor((sizeUsdc / price) * 100) / 100;

console.log("MAKER BUY:", condId.substring(0,16)+"...", side, "@", price, "for", sizeUsdc, "USDC ->", shares, "shares", ttlMin ? "TTL "+ttlMin+"m" : "GTC");

// Sanity check vs current ask — warn if we are crossing the spread (at which
// point use manual-buy.mjs instead, this script is for resting orders).
const m = await fetch("https://gamma-api.polymarket.com/markets/keyset?condition_ids=" + condId).then(r=>r.json()).then(d=>d.markets?.[0]);
if (!m) { console.error("market not found"); process.exit(1); }
const op = JSON.parse(m.outcomePrices);
const bestBid_o0 = parseFloat(m.bestBid || 0);
const bestAsk_o0 = parseFloat(m.bestAsk || 0);
const tokenIds = JSON.parse(m.clobTokenIds);
const tokenId = side === "YES" ? tokenIds[0] : tokenIds[1];
const myAsk = side === "YES" ? bestAsk_o0 : (1 - bestBid_o0);
const myBid = side === "YES" ? bestBid_o0 : (1 - bestAsk_o0);
console.log("book: my-side bid=", myBid.toFixed(3), "my-side ask=", myAsk.toFixed(3), "  outcomePrices=", op);
if (price >= myAsk) {
  console.warn("WARNING: your price >= current ask. This will cross the spread. Use manual-buy.mjs for taker.");
}

const creds = JSON.parse(readFileSync("/opt/polybot-v3/state/api_keys.json","utf8"));
const wallet = JSON.parse(readFileSync("/opt/polybot-v3/state/wallet.json","utf8"));
const { ClobClient, Side, OrderType } = await import("@polymarket/clob-client");
const { createWalletClient, http } = await import("viem");
const { polygon } = await import("viem/chains");
const { privateKeyToAccount } = await import("viem/accounts");
const pk = wallet.private_key.startsWith("0x") ? wallet.private_key : "0x"+wallet.private_key;
const account = privateKeyToAccount(pk);
const walletClient = createWalletClient({ account, chain: polygon, transport: http("https://polygon-mainnet.g.alchemy.com/v2/OcQ_bZAEzXt_YW0tx9XVv") });
const client = new ClobClient("https://clob.polymarket.com", 137, walletClient, { key: creds.POLY_API_KEY, secret: creds.POLY_SECRET, passphrase: creds.POLY_PASSPHRASE });

const order = { tokenID: tokenId, price, size: shares, side: Side.BUY };
const orderType = ttlMin > 0 ? OrderType.GTD : OrderType.GTC;
const expiration = ttlMin > 0 ? Math.floor(Date.now()/1000) + ttlMin*60 : 0;
if (ttlMin > 0) order.expiration = expiration;

console.log("placing", orderType, ttlMin > 0 ? "expires "+new Date(expiration*1000).toISOString() : "", order);
const signed = await client.createOrder(order, { orderType });
const resp = await client.postOrder(signed, orderType);
console.log("RESPONSE:", JSON.stringify(resp).substring(0,800));
if (resp.orderID) console.log("\nTo cancel:", resp.orderID);

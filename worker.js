// ── Crypto Hype Radar — Cloudflare Worker ────────────────────────────────────
// Existing endpoints:
//   POST /subscribe      — save push subscription + watchlist coins
//   POST /update-coins   — update watchlist coins for existing subscription
//   POST /send-push      — manually trigger push to all matching subscribers
//   POST /               — forward email alert signup to Make.com
//   scheduled            — cron: fetch CoinGecko signals, push watchlist alerts
//
// Hype Trader Simulator endpoints (D1-backed):
//   POST   /sim/init          — create or retrieve trader account
//   POST   /sim/trade         — execute a BUY or SELL
//   GET    /sim/portfolio     — get balance, open positions, trade history
//   GET    /sim/leaderboard   — top 50 traders by % return
//   POST   /sim/reset         — reset account back to $10,000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

export default {
  // ── HTTP handler ────────────────────────────────────────────────────────────
  async fetch(request, env, ctx) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    // ── Simulator routes ─────────────────────────────────────────────────────

    if (url.pathname === '/sim/init' && request.method === 'POST') {
      return handleSimInit(request, env);
    }
    if (url.pathname === '/sim/trade' && request.method === 'POST') {
      return handleSimTrade(request, env);
    }
    if (url.pathname === '/sim/portfolio' && request.method === 'GET') {
      return handleSimPortfolio(request, env);
    }
    if (url.pathname === '/sim/leaderboard' && request.method === 'GET') {
      return handleSimLeaderboard(request, env);
    }
    if (url.pathname === '/sim/reset' && request.method === 'POST') {
      return handleSimReset(request, env);
    }

    // ── Existing push notification routes ────────────────────────────────────

    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const text = await request.text();
      let data = {};
      try { data = JSON.parse(text); } catch(e) {}
      const sub = data.subscription;
      const coins = data.coins || [];
      if (!sub || !sub.endpoint) {
        return new Response('Invalid subscription', { status: 400, headers: CORS });
      }
      const key = 'sub_' + btoa(sub.endpoint).slice(0, 40).replace(/[^a-zA-Z0-9]/g, '');
      await env.HYPE_CACHE.put(key, JSON.stringify({ sub, coins, saved: Date.now() }));
      return new Response('subscribed', { headers: CORS });
    }

    if (request.method === 'POST' && url.pathname === '/update-coins') {
      const text = await request.text();
      let data = {};
      try { data = JSON.parse(text); } catch(e) {}
      const sub = data.subscription;
      const coins = data.coins || [];
      if (!sub || !sub.endpoint) {
        return new Response('Invalid', { status: 400, headers: CORS });
      }
      const key = 'sub_' + btoa(sub.endpoint).slice(0, 40).replace(/[^a-zA-Z0-9]/g, '');
      const existing = await env.HYPE_CACHE.get(key);
      if (existing) {
        const parsed = JSON.parse(existing);
        parsed.coins = coins;
        await env.HYPE_CACHE.put(key, JSON.stringify(parsed));
      }
      return new Response('updated', { headers: CORS });
    }

    if (request.method === 'POST' && url.pathname === '/send-push') {
      const text = await request.text();
      let data = {};
      try { data = JSON.parse(text); } catch(e) {}
      const { title, body, coin, type } = data;
      const list = await env.HYPE_CACHE.list({ prefix: 'sub_' });
      let sent = 0;
      for (const key of list.keys) {
        const raw = await env.HYPE_CACHE.get(key.name);
        if (!raw) continue;
        const { sub, coins } = JSON.parse(raw);
        const shouldSend = type === 'global' || !coin || !coins.length || coins.includes(coin);
        if (!shouldSend) continue;
        try {
          await sendPush(sub, { title, body }, env);
          sent++;
        } catch(e) {
          if (e.message && e.message.includes('410')) {
            await env.HYPE_CACHE.delete(key.name);
          }
        }
      }
      return new Response(JSON.stringify({ sent }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    if (request.method === 'POST') {
      const text = await request.text();
      let data = {};
      try { data = JSON.parse(text); } catch(e) {}
      await fetch('https://hook.us2.make.com/s7kigp8twu2wv3c33oup12ynsk7irbgw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email:       data.email       || '',
          coin_ticker: data.coin_ticker || '',
          coin_name:   data.coin_name   || '',
          coin_price:  data.coin_price  || '',
          hype_score:  data.hype_score  || 0,
          signal:      data.signal      || '',
          frequency:   data.frequency   || 'daily',
          timestamp:   data.timestamp   || '',
          source:      data.source      || ''
        })
      });
      return new Response('ok', { headers: CORS });
    }

    // ── CoinGecko proxy routes (KV-cached, 5 min TTL) ──────────────────────

    if (url.pathname === '/cg/trending') {
      return proxyCoingecko('https://api.coingecko.com/api/v3/search/trending', 'cg_trending', 300, env);
    }
    if (url.pathname === '/cg/gainers') {
      // top_gainers_losers is Pro-only — use free markets endpoint sorted by 24h change
      return handleGainersFree(env);
    }
    if (url.pathname === '/cg/markets') {
      const ids = url.searchParams.get('ids') || '';
      const cacheKey = 'cg_markets_' + ids.split(',').sort().join(',').slice(0,80);
      return proxyCoingecko(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=40&page=1&sparkline=true&price_change_percentage=24h`, cacheKey, 120, env);
    }
    if (url.pathname === '/cg/search') {
      const q = url.searchParams.get('q') || '';
      const cacheKey = 'cg_search_' + encodeURIComponent(q).slice(0,40);
      return proxyCoingecko(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`, cacheKey, 300, env);
    }
    if (url.pathname === '/cg/coin') {
      const id = url.searchParams.get('id') || '';
      const cacheKey = 'cg_coin_' + id.slice(0,40);
      return proxyCoingecko(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${id}&sparkline=true&price_change_percentage=24h`, cacheKey, 120, env);
    }
    if (url.pathname === '/cg/chart') {
      const id = url.searchParams.get('id') || '';
      const cacheKey = 'cg_chart_' + id.slice(0,40);
      return proxyCoingecko(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=7&interval=daily`, cacheKey, 300, env);
    }
    if (url.pathname === '/cg/price') {
      const ids = url.searchParams.get('ids') || '';
      const cacheKey = 'cg_price_' + ids.split(',').sort().join(',').slice(0,80);
      return proxyCoingecko(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, cacheKey, 60, env);
    }
    if (url.pathname === '/cg/fng') {
      return proxyCoingecko('https://api.alternative.me/fng/?limit=1', 'cg_fng', 300, env);
    }

    // ── Reddit OAuth proxy ────────────────────────────────────────────────────
    if (url.pathname === '/reddit/hot') {
      return handleRedditHot(url, env);
    }

    // ── Saved List (D1-backed, replaces localStorage watchlist) ──────────────
    if (url.pathname === '/saved/add' && request.method === 'POST') {
      return handleSavedAdd(request, env);
    }
    if (url.pathname === '/saved/remove' && request.method === 'POST') {
      return handleSavedRemove(request, env);
    }
    if (url.pathname === '/saved/list' && request.method === 'GET') {
      return handleSavedList(request, env);
    }

    // ── Coin radar history ────────────────────────────────────────────────────
    if (url.pathname === '/radar/coin' && request.method === 'GET') {
      return handleRadarCoin(request, env);
    }
    if (url.pathname === '/radar/prices' && request.method === 'GET') {
      return handleRadarPrices(request, env);
    }

    return new Response('Crypto Hype Radar — Webhook Proxy', {
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  // ── Scheduled cron handler ──────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFullCron(env));
  }
};

// ════════════════════════════════════════════════════════════════════════════
// SIMULATOR HANDLERS
// ════════════════════════════════════════════════════════════════════════════

// POST /sim/init  { id, username }
// Creates a new trader if id not found, or returns existing one.
async function handleSimInit(request, env) {
  let data = {};
  try { data = await request.json(); } catch(e) {}
  const { id, username } = data;
  if (!id) return json({ error: 'id required' }, 400);

  const now = Date.now();
  const name = (username || '').trim().slice(0, 24) || 'Anon Trader';

  // Upsert — create if not exists, otherwise return existing
  await env.HYPE_TRADER.prepare(
    `INSERT INTO traders (id, username, balance, created_at, updated_at)
     VALUES (?, ?, 10000.00, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = CASE WHEN excluded.username != '' THEN excluded.username ELSE traders.username END,
       updated_at = excluded.updated_at`
  ).bind(id, name, now, now).run();

  const trader = await env.HYPE_TRADER.prepare(
    `SELECT * FROM traders WHERE id = ?`
  ).bind(id).first();

  return json({ ok: true, trader });
}

// POST /sim/trade  { trader_id, side, coin_id, ticker, coin_name, price, qty, hype_score, take_profit, stop_loss }
async function handleSimTrade(request, env) {
  let data = {};
  try { data = await request.json(); } catch(e) {}
  const { trader_id, side, coin_id, ticker, coin_name, price, qty, hype_score, take_profit, stop_loss } = data;

  if (!trader_id || !side || !coin_id || !price || !qty) {
    return json({ error: 'Missing required fields' }, 400);
  }
  if (!['BUY', 'SELL'].includes(side)) {
    return json({ error: 'side must be BUY or SELL' }, 400);
  }

  const now = Date.now();
  const usd_value = price * qty;

  // Load trader
  const trader = await env.HYPE_TRADER.prepare(
    `SELECT * FROM traders WHERE id = ?`
  ).bind(trader_id).first();
  if (!trader) return json({ error: 'Trader not found' }, 404);

  if (side === 'BUY') {
    if (trader.balance < usd_value) {
      return json({ error: 'Insufficient balance', balance: trader.balance }, 400);
    }
    // Deduct balance
    await env.HYPE_TRADER.prepare(
      `UPDATE traders SET balance = balance - ?, updated_at = ? WHERE id = ?`
    ).bind(usd_value, now, trader_id).run();

    // Open position
    await env.HYPE_TRADER.prepare(
      `INSERT INTO positions (trader_id, coin_id, ticker, coin_name, qty, entry_price, entry_ts, take_profit, stop_loss, hype_score, signal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BUY')`
    ).bind(trader_id, coin_id, ticker.toUpperCase(), coin_name, qty, price, now, take_profit || null, stop_loss || null, hype_score || null).run();

    // Log trade
    await env.HYPE_TRADER.prepare(
      `INSERT INTO trades (trader_id, coin_id, ticker, coin_name, side, qty, price, usd_value, pnl, pnl_pct, entry_price, hype_score, signal, ts)
       VALUES (?, ?, ?, ?, 'BUY', ?, ?, ?, NULL, NULL, ?, ?, 'BUY', ?)`
    ).bind(trader_id, coin_id, ticker.toUpperCase(), coin_name, qty, price, usd_value, price, hype_score || null, now).run();

    const updated = await env.HYPE_TRADER.prepare(`SELECT * FROM traders WHERE id = ?`).bind(trader_id).first();
    return json({ ok: true, action: 'BUY', coin: ticker, qty, price, usd_value, balance: updated.balance });
  }

  if (side === 'SELL') {
    // Find open position for this coin
    const position = await env.HYPE_TRADER.prepare(
      `SELECT * FROM positions WHERE trader_id = ? AND coin_id = ? LIMIT 1`
    ).bind(trader_id, coin_id).first();

    if (!position) return json({ error: 'No open position for this coin' }, 400);

    const sell_qty = Math.min(qty, position.qty);
    const sell_value = price * sell_qty;
    const cost_basis = position.entry_price * sell_qty;
    const pnl = sell_value - cost_basis;
    const pnl_pct = ((price - position.entry_price) / position.entry_price) * 100;

    // Credit balance
    await env.HYPE_TRADER.prepare(
      `UPDATE traders SET balance = balance + ?, updated_at = ? WHERE id = ?`
    ).bind(sell_value, now, trader_id).run();

    // Remove or reduce position
    if (sell_qty >= position.qty) {
      await env.HYPE_TRADER.prepare(`DELETE FROM positions WHERE id = ?`).bind(position.id).run();
    } else {
      await env.HYPE_TRADER.prepare(
        `UPDATE positions SET qty = qty - ? WHERE id = ?`
      ).bind(sell_qty, position.id).run();
    }

    // Log trade
    await env.HYPE_TRADER.prepare(
      `INSERT INTO trades (trader_id, coin_id, ticker, coin_name, side, qty, price, usd_value, pnl, pnl_pct, entry_price, hype_score, signal, ts)
       VALUES (?, ?, ?, ?, 'SELL', ?, ?, ?, ?, ?, ?, ?, 'SELL', ?)`
    ).bind(trader_id, coin_id, ticker.toUpperCase(), coin_name, sell_qty, price, sell_value, pnl, pnl_pct, position.entry_price, hype_score || null, now).run();

    const updated = await env.HYPE_TRADER.prepare(`SELECT * FROM traders WHERE id = ?`).bind(trader_id).first();
    return json({ ok: true, action: 'SELL', coin: ticker, qty: sell_qty, price, usd_value: sell_value, pnl, pnl_pct, balance: updated.balance });
  }
}

// GET /sim/portfolio?id=<trader_id>
async function handleSimPortfolio(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);

  const trader = await env.HYPE_TRADER.prepare(`SELECT * FROM traders WHERE id = ?`).bind(id).first();
  if (!trader) return json({ error: 'Trader not found' }, 404);

  const positions = await env.HYPE_TRADER.prepare(
    `SELECT * FROM positions WHERE trader_id = ? ORDER BY entry_ts DESC`
  ).bind(id).all();

  const trades = await env.HYPE_TRADER.prepare(
    `SELECT * FROM trades WHERE trader_id = ? ORDER BY ts DESC LIMIT 50`
  ).bind(id).all();

  // Compute stats
  const sellTrades = (trades.results || []).filter(t => t.side === 'SELL');
  const totalPnl = sellTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins = sellTrades.filter(t => (t.pnl || 0) > 0).length;
  const winRate = sellTrades.length > 0 ? Math.round((wins / sellTrades.length) * 100) : 0;

  return json({
    trader,
    positions: positions.results || [],
    trades: trades.results || [],
    stats: {
      total_trades: sellTrades.length,
      wins,
      win_rate: winRate,
      total_pnl: totalPnl,
      total_return_pct: ((trader.balance - 10000) / 10000) * 100
    }
  });
}

// GET /sim/leaderboard
async function handleSimLeaderboard(request, env) {
  // Compute leaderboard: balance + unrealized gains from open positions
  // For simplicity, rank by current balance (realized gains)
  const result = await env.HYPE_TRADER.prepare(
    `SELECT id, username, balance,
            ROUND(((balance - 10000.0) / 10000.0) * 100, 2) AS return_pct,
            created_at
     FROM traders
     WHERE username != ''
     ORDER BY balance DESC
     LIMIT 50`
  ).all();

  return json({ leaderboard: result.results || [] });
}

// POST /sim/reset  { id }
async function handleSimReset(request, env) {
  let data = {};
  try { data = await request.json(); } catch(e) {}
  const { id } = data;
  if (!id) return json({ error: 'id required' }, 400);

  const now = Date.now();
  await env.HYPE_TRADER.prepare(
    `UPDATE traders SET balance = 10000.00, updated_at = ? WHERE id = ?`
  ).bind(now, id).run();
  await env.HYPE_TRADER.prepare(`DELETE FROM positions WHERE trader_id = ?`).bind(id).run();
  await env.HYPE_TRADER.prepare(`DELETE FROM trades WHERE trader_id = ?`).bind(id).run();

  return json({ ok: true, message: 'Account reset to $10,000' });
}

// ════════════════════════════════════════════════════════════════════════════
// SIGNAL SCAN (existing cron logic)
// ════════════════════════════════════════════════════════════════════════════
async function runSignalScan(env) {
  try {
    const trendingRes = await fetch(
      'https://api.coingecko.com/api/v3/search/trending',
      { headers: { 'Accept': 'application/json' } }
    );
    if (!trendingRes.ok) return;
    const trendingData = await trendingRes.json();
    const trendingCoins = (trendingData.coins || []).map(c => c.item);

    const gainersRes = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=percent_change_24h_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h',
      { headers: { 'Accept': 'application/json' } }
    );
    const gainers = gainersRes.ok ? await gainersRes.json() : [];

    const scoreMap = {};
    trendingCoins.forEach((coin, i) => {
      const id = coin.id;
      if (!scoreMap[id]) scoreMap[id] = { id, name: coin.name, symbol: coin.symbol, score: 0, price_change: 0 };
      scoreMap[id].score += Math.max(1, 4 - Math.floor(i / 2));
    });
    gainers.forEach(coin => {
      const id = coin.id;
      const change = coin.price_change_percentage_24h || 0;
      if (!scoreMap[id]) scoreMap[id] = { id, name: coin.name, symbol: coin.symbol.toUpperCase(), score: 0, price_change: change };
      scoreMap[id].price_change = change;
      if (change >= 20) scoreMap[id].score += 3;
      else if (change >= 10) scoreMap[id].score += 2;
      else if (change >= 5)  scoreMap[id].score += 1;
    });

    const buySignals = Object.values(scoreMap).filter(c => c.score >= 4);
    if (buySignals.length === 0) return;
    const buyIds = new Set(buySignals.map(c => c.id));

    const list = await env.HYPE_CACHE.list({ prefix: 'sub_' });
    if (!list.keys.length) return;

    const prevStateRaw = await env.HYPE_CACHE.get('_signal_state');
    const prevState = prevStateRaw ? JSON.parse(prevStateRaw) : {};
    const newState = {};
    buySignals.forEach(c => { newState[c.id] = 'BUY'; });
    const newBuyIds = new Set(
      buySignals.filter(c => prevState[c.id] !== 'BUY').map(c => c.id)
    );
    await env.HYPE_CACHE.put('_signal_state', JSON.stringify(newState), { expirationTtl: 3600 });
    if (newBuyIds.size === 0) return;

    for (const key of list.keys) {
      const raw = await env.HYPE_CACHE.get(key.name);
      if (!raw) continue;
      let record;
      try { record = JSON.parse(raw); } catch(e) { continue; }
      const { sub, coins: watchedCoins } = record;
      if (!watchedCoins || !watchedCoins.length) continue;
      const alerts = watchedCoins.filter(id => newBuyIds.has(id)).map(id => scoreMap[id]).filter(Boolean);
      if (!alerts.length) continue;
      const coinList = alerts.map(c => `${c.symbol} +${c.price_change.toFixed(1)}%`).join(', ');
      const title = alerts.length === 1 ? `🚀 BUY Signal: ${alerts[0].name}` : `🚀 ${alerts.length} BUY Signals on Your Watchlist`;
      const body = alerts.length === 1
        ? `${alerts[0].symbol} is trending with a strong BUY signal. +${alerts[0].price_change.toFixed(1)}% in 24h.`
        : `New BUY signals: ${coinList}`;
      try {
        await sendPush(sub, { title, body }, env);
      } catch(e) {
        if (e.message && e.message.includes('410')) {
          await env.HYPE_CACHE.delete(key.name);
        }
      }
    }
  } catch(err) {
    console.error('[CHR cron] Signal scan failed:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PUSH DELIVERY (unchanged)
// ════════════════════════════════════════════════════════════════════════════
async function sendPush(subscription, payload, env) {
  const vapidPublicKey = env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = env.VAPID_PRIVATE_KEY;
  const subject = 'mailto:adamjwconsulting@gmail.com';
  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys.p256dh;
  const auth = subscription.keys.auth;
  const vapidHeaders = await buildVapidHeaders(vapidPublicKey, vapidPrivateKey, subject, endpoint);
  const encrypted = await encryptPayload(JSON.stringify(payload), p256dh, auth);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      ...vapidHeaders,
      ...encrypted.headers
    },
    body: encrypted.body
  });
  if (!response.ok && response.status !== 201) {
    throw new Error(response.status.toString());
  }
}

async function buildVapidHeaders(publicKey, privateKey, subject, endpoint) {
  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 3600;
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = { aud: audience, exp, sub: subject };
  const enc = (obj) => base64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = `${enc(header)}.${enc(claims)}`;
  const keyData = base64urlDecode(privateKey);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64url(new Uint8Array(sig))}`;
  return { 'Authorization': `vapid t=${jwt}, k=${publicKey}` };
}

async function encryptPayload(payload, p256dhBase64, authBase64) {
  const p256dh = base64urlDecode(p256dhBase64);
  const auth = base64urlDecode(authBase64);
  const clientKey = await crypto.subtle.importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKeyPair.privateKey, 256);
  const serverPublicKeyRaw = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(new Uint8Array(sharedBits), auth, concat(new Uint8Array(serverPublicKeyRaw), p256dh), 32);
  const cek = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, new TextEncoder().encode(payload + '\x02'));
  const header = buildEncryptionHeader(salt, new Uint8Array(serverPublicKeyRaw));
  return {
    headers: { 'Encryption': `salt=${base64url(salt)}` },
    body: concat(header, new Uint8Array(encrypted))
  };
}

function buildEncryptionHeader(salt, serverPublicKey) {
  const header = new Uint8Array(21 + serverPublicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = serverPublicKey.length;
  header.set(serverPublicKey, 21);
  return header;
}

async function hkdf(ikm, salt, info, length) {
  const keyMaterial = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, keyMaterial, length * 8);
  return new Uint8Array(bits);
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
}

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - padded.length % 4) % 4;
  return Uint8Array.from(atob(padded + '='.repeat(padLen)), c => c.charCodeAt(0));
}

// ════════════════════════════════════════════════════════════════════════════
// FREE-TIER GAINERS (replaces Pro-only top_gainers_losers endpoint)
// ════════════════════════════════════════════════════════════════════════════
async function handleGainersFree(env) {
  const cacheKey = 'cg_gainers_free';
  try {
    const cached = await env.HYPE_CACHE.get(cacheKey);
    if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch(e) {}

  try {
    // Fetch top 100 coins by market cap, sorted by 24h change
    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h',
      { headers: { 'Accept': 'application/json', 'User-Agent': 'CryptoHypeRadar/1.0' } }
    );
    if (!res.ok) return new Response(JSON.stringify({ top_gainers: [], top_losers: [] }), { headers: { 'Content-Type': 'application/json', ...CORS } });
    const coins = await res.json();
    const sorted = [...coins].sort((a, b) => (b.price_change_percentage_24h || 0) - (a.price_change_percentage_24h || 0));
    const top_gainers = sorted.slice(0, 15).map(c => ({ id: c.id, symbol: c.symbol, name: c.name, usd: c.current_price, usd_24h_change: c.price_change_percentage_24h }));
    const top_losers = sorted.slice(-10).reverse().map(c => ({ id: c.id, symbol: c.symbol, name: c.name, usd: c.current_price, usd_24h_change: c.price_change_percentage_24h }));
    const body = JSON.stringify({ top_gainers, top_losers });
    try { await env.HYPE_CACHE.put(cacheKey, body, { expirationTtl: 300 }); } catch(e) {}
    return new Response(body, { headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch(e) {
    return new Response(JSON.stringify({ top_gainers: [], top_losers: [] }), { headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// COINGECKO PROXY HELPER (KV-cached)
// ════════════════════════════════════════════════════════════════════════════
async function proxyCoingecko(upstreamUrl, cacheKey, ttlSeconds, env) {
  // Try KV cache first
  try {
    const cached = await env.HYPE_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
  } catch(e) {}

  // Fetch from CoinGecko server-side
  try {
    const res = await fetch(upstreamUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'CryptoHypeRadar/1.0' }
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'upstream_error', status: res.status }), {
        status: res.status,
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
    const body = await res.text();
    // Cache the result
    try {
      await env.HYPE_CACHE.put(cacheKey, body, { expirationTtl: ttlSeconds });
    } catch(e) {}
    return new Response(body, {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: 'fetch_failed', message: e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// REDDIT OAUTH PROXY
// GET /reddit/hot?sub=<subreddit>&limit=<n>
// Uses Reddit OAuth app credentials stored as Worker secrets:
//   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET
// Falls back to public JSON API if secrets not configured.
// ════════════════════════════════════════════════════════════════════════════

async function handleRedditHot(url, env) {
  const sub = (url.searchParams.get('sub') || 'CryptoCurrency').replace(/[^a-zA-Z0-9_]/g, '');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '25'), 50);
  const cacheKey = `reddit_hot_${sub}_${limit}`;

  // Check cache first (5 min TTL)
  try {
    const cached = await env.HYPE_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, { headers: { 'Content-Type': 'application/json', ...CORS } });
    }
  } catch(e) {}

  // Try authenticated OAuth if credentials are available
  if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) {
    try {
      const posts = await fetchRedditOAuth(sub, limit, env);
      const body = JSON.stringify(posts);
      try { await env.HYPE_CACHE.put(cacheKey, body, { expirationTtl: 300 }); } catch(e) {}
      return new Response(body, { headers: { 'Content-Type': 'application/json', ...CORS } });
    } catch(e) {
      console.warn('[Reddit OAuth] failed, falling back to public API:', e.message);
    }
  }

  // Fallback: public JSON API (no auth)
  try {
    const r = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=${limit}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'CryptoHypeRadar/1.0' }
    });
    if (!r.ok) throw new Error('Reddit public API returned ' + r.status);
    const d = await r.json();
    const posts = (d.data?.children || [])
      .map(p => p.data)
      .filter(p => !p.stickied)
      .map(p => ({
        subreddit: p.subreddit,
        title: p.title,
        author: p.author,
        score: p.score,
        num_comments: p.num_comments,
        permalink: p.permalink,
        created_utc: p.created_utc,
        selftext: (p.selftext || '').slice(0, 200),
        upvote_ratio: p.upvote_ratio || 0
      }));
    const body = JSON.stringify(posts);
    try { await env.HYPE_CACHE.put(cacheKey, body, { expirationTtl: 300 }); } catch(e) {}
    return new Response(body, { headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch(e) {
    return new Response(JSON.stringify({ error: 'reddit_unavailable', posts: [] }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}

async function fetchRedditOAuth(sub, limit, env) {
  // Get OAuth token (cached for ~1 hour)
  const tokenKey = 'reddit_oauth_token';
  let token = null;

  try {
    const cached = await env.HYPE_CACHE.get(tokenKey);
    if (cached) token = cached;
  } catch(e) {}

  if (!token) {
    const creds = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`);
    const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'CryptoHypeRadar/1.0 by UniqueQuiet9204'
      },
      body: 'grant_type=client_credentials'
    });
    if (!tokenRes.ok) throw new Error('Token fetch failed: ' + tokenRes.status);
    const tokenData = await tokenRes.json();
    token = tokenData.access_token;
    if (!token) throw new Error('No access token in response');
    // Cache for 50 minutes (token lasts 60)
    try { await env.HYPE_CACHE.put(tokenKey, token, { expirationTtl: 3000 }); } catch(e) {}
  }

  const r = await fetch(`https://oauth.reddit.com/r/${sub}/hot?limit=${limit}&raw_json=1`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'CryptoHypeRadar/1.0 by UniqueQuiet9204',
      'Accept': 'application/json'
    }
  });
  if (!r.ok) throw new Error('Reddit OAuth API returned ' + r.status);
  const d = await r.json();
  return (d.data?.children || [])
    .map(p => p.data)
    .filter(p => !p.stickied)
    .map(p => ({
      subreddit: p.subreddit,
      title: p.title,
      author: p.author,
      score: p.score,
      num_comments: p.num_comments,
      permalink: p.permalink,
      created_utc: p.created_utc,
      selftext: (p.selftext || '').slice(0, 200),
      upvote_ratio: p.upvote_ratio || 0
    }));
}


// ════════════════════════════════════════════════════════════════════════════
// SAVED LIST HANDLERS (D1-backed, replaces localStorage watchlist)
// ════════════════════════════════════════════════════════════════════════════

// POST /saved/add  { trader_id, coin_id, ticker, coin_name }
async function handleSavedAdd(request, env) {
  let data = {};
  try { data = await request.json(); } catch(e) {}
  const { trader_id, coin_id, ticker, coin_name } = data;
  if (!trader_id || !coin_id) return json({ error: 'trader_id and coin_id required' }, 400);
  const now = Date.now();
  try {
    await env.HYPE_TRADER.prepare(
      `INSERT OR IGNORE INTO saved_list (trader_id, coin_id, ticker, coin_name, saved_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(trader_id, coin_id, (ticker||coin_id).toUpperCase(), coin_name||coin_id, now).run();
    return json({ ok: true });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// POST /saved/remove  { trader_id, coin_id }
async function handleSavedRemove(request, env) {
  let data = {};
  try { data = await request.json(); } catch(e) {}
  const { trader_id, coin_id } = data;
  if (!trader_id || !coin_id) return json({ error: 'trader_id and coin_id required' }, 400);
  try {
    await env.HYPE_TRADER.prepare(
      `DELETE FROM saved_list WHERE trader_id = ? AND coin_id = ?`
    ).bind(trader_id, coin_id).run();
    return json({ ok: true });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// GET /saved/list?id=<trader_id>
async function handleSavedList(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);
  try {
    const rows = await env.HYPE_TRADER.prepare(
      `SELECT sl.coin_id, sl.ticker, sl.coin_name, sl.saved_at,
              cr.first_seen_price, cr.first_seen_ts, cr.last_signal, cr.last_hype,
              cp.price_usd AS current_price, cp.change_24h, cp.updated_at AS price_updated
       FROM saved_list sl
       LEFT JOIN coin_radar cr ON cr.coin_id = sl.coin_id
       LEFT JOIN coin_prices cp ON cp.coin_id = sl.coin_id
       WHERE sl.trader_id = ?
       ORDER BY sl.saved_at DESC`
    ).bind(id).all();
    return json({ saved: rows.results || [] });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// RADAR COIN HANDLERS
// ════════════════════════════════════════════════════════════════════════════

// GET /radar/coin?id=<coin_id>  — returns radar history for a single coin
async function handleRadarCoin(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);
  try {
    const row = await env.HYPE_TRADER.prepare(
      `SELECT cr.*, cp.price_usd AS current_price, cp.change_24h, cp.updated_at AS price_updated
       FROM coin_radar cr
       LEFT JOIN coin_prices cp ON cp.coin_id = cr.coin_id
       WHERE cr.coin_id = ?`
    ).bind(id).first();
    if (!row) return json({ found: false });
    return json({ found: true, coin: row });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// GET /radar/prices?ids=<comma-separated coin_ids>  — bulk price lookup from D1
async function handleRadarPrices(request, env) {
  const url = new URL(request.url);
  const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 50);
  if (!ids.length) return json({ prices: {} });
  try {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await env.HYPE_TRADER.prepare(
      `SELECT coin_id, price_usd, change_24h, updated_at FROM coin_prices WHERE coin_id IN (${placeholders})`
    ).bind(...ids).all();
    const prices = {};
    (rows.results || []).forEach(r => { prices[r.coin_id] = { usd: r.price_usd, change_24h: r.change_24h, updated_at: r.updated_at }; });
    return json({ prices });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FULL CRON JOB — runs every 5 minutes via Cloudflare scheduled trigger
// 1. Fetch trending coins from CoinGecko
// 2. Upsert into coin_radar (first_seen, last_seen, signal, price)
// 3. Collect all coins needing price updates (radar + open positions + saved list)
// 4. Batch-fetch prices from CoinGecko, store in coin_prices
// 5. Check for signal flips on saved/held coins → push alerts
// ════════════════════════════════════════════════════════════════════════════
async function runFullCron(env) {
  try {
    // ── Step 1: Fetch trending + gainers ──────────────────────────────────────
    const [trendingRes, gainersRes] = await Promise.all([
      fetch('https://api.coingecko.com/api/v3/search/trending', {
        headers: { 'Accept': 'application/json', 'User-Agent': 'CryptoHypeRadar/1.0' }
      }),
      fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=percent_change_24h_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h', {
        headers: { 'Accept': 'application/json', 'User-Agent': 'CryptoHypeRadar/1.0' }
      })
    ]);

    if (!trendingRes.ok) {
      console.error('[CHR cron] Trending fetch failed:', trendingRes.status);
      return;
    }

    const trendingData = await trendingRes.json();
    const trendingCoins = (trendingData.coins || []).slice(0, 15).map(c => c.item);
    const gainers = gainersRes.ok ? await gainersRes.json() : [];

    // ── Step 2: Build score map and signal map ────────────────────────────────
    const scoreMap = {};
    trendingCoins.forEach((coin, i) => {
      const id = coin.id;
      if (!scoreMap[id]) scoreMap[id] = {
        id, name: coin.name, symbol: coin.symbol?.toUpperCase() || id,
        image: coin.thumb || coin.large || '',
        score: 0, price_change: 0, price: coin.data?.price || 0
      };
      scoreMap[id].score += Math.max(1, 4 - Math.floor(i / 2));
    });
    gainers.forEach(coin => {
      const id = coin.id;
      const change = coin.price_change_percentage_24h || 0;
      if (!scoreMap[id]) scoreMap[id] = {
        id, name: coin.name, symbol: coin.symbol?.toUpperCase() || id,
        image: coin.image || '',
        score: 0, price_change: change, price: coin.current_price || 0
      };
      scoreMap[id].price_change = change;
      scoreMap[id].price = scoreMap[id].price || coin.current_price || 0;
      if (change >= 20) scoreMap[id].score += 3;
      else if (change >= 10) scoreMap[id].score += 2;
      else if (change >= 5) scoreMap[id].score += 1;
    });

    const signalFor = (score, change) => {
      if (score >= 6 && change >= 10) return 'moon';
      if (change <= -15) return 'dump';
      if (score >= 4) return 'trend';
      return 'watch';
    };

    const now = Date.now();
    const radarCoins = Object.values(scoreMap);
    const radarIds = radarCoins.map(c => c.id);

    // ── Step 3: Upsert coin_radar ─────────────────────────────────────────────
    for (const coin of radarCoins) {
      const signal = signalFor(coin.score, coin.price_change);
      const hype = Math.min(99, Math.round((coin.score / 10) * 100));
      try {
        await env.HYPE_TRADER.prepare(
          `INSERT INTO coin_radar (coin_id, ticker, coin_name, image_url, first_seen_ts, first_seen_price, last_seen_ts, last_signal, last_hype, last_price, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(coin_id) DO UPDATE SET
             last_seen_ts = excluded.last_seen_ts,
             last_signal = excluded.last_signal,
             last_hype = excluded.last_hype,
             last_price = CASE WHEN excluded.last_price > 0 THEN excluded.last_price ELSE coin_radar.last_price END,
             updated_at = excluded.updated_at`
        ).bind(
          coin.id, coin.symbol, coin.name, coin.image,
          now, coin.price > 0 ? coin.price : null,
          now, signal, hype,
          coin.price > 0 ? coin.price : null,
          now
        ).run();
      } catch(e) {
        console.warn('[CHR cron] coin_radar upsert failed for', coin.id, e.message);
      }
    }

    // ── Step 4: Collect all coin IDs needing price updates ───────────────────
    // radar coins + open positions + saved list
    const positionRows = await env.HYPE_TRADER.prepare(
      `SELECT DISTINCT coin_id FROM positions`
    ).all();
    const savedRows = await env.HYPE_TRADER.prepare(
      `SELECT DISTINCT coin_id FROM saved_list`
    ).all();

    const allIds = new Set([
      ...radarIds,
      ...(positionRows.results || []).map(r => r.coin_id),
      ...(savedRows.results || []).map(r => r.coin_id)
    ]);

    // Batch into groups of 50 (CoinGecko simple/price limit)
    const idArray = [...allIds];
    const batches = [];
    for (let i = 0; i < idArray.length; i += 50) {
      batches.push(idArray.slice(i, i + 50));
    }

    const priceMap = {};
    for (const batch of batches) {
      try {
        const r = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${batch.join(',')}&vs_currencies=usd&include_24hr_change=true`,
          { headers: { 'Accept': 'application/json', 'User-Agent': 'CryptoHypeRadar/1.0' } }
        );
        if (r.ok) {
          const data = await r.json();
          Object.assign(priceMap, data);
        }
      } catch(e) {
        console.warn('[CHR cron] Price batch fetch failed:', e.message);
      }
    }

    // ── Step 5: Upsert coin_prices ────────────────────────────────────────────
    for (const [coinId, data] of Object.entries(priceMap)) {
      const price = data.usd;
      const change = data.usd_24h_change || 0;
      if (!price) continue;
      try {
        await env.HYPE_TRADER.prepare(
          `INSERT INTO coin_prices (coin_id, price_usd, change_24h, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(coin_id) DO UPDATE SET
             price_usd = excluded.price_usd,
             change_24h = excluded.change_24h,
             updated_at = excluded.updated_at`
        ).bind(coinId, price, change, now).run();
      } catch(e) {
        console.warn('[CHR cron] coin_prices upsert failed for', coinId, e.message);
      }
    }

    // ── Step 6: Signal flip alerts for saved/held coins ───────────────────────
    // Load previous signal state from KV
    const prevStateRaw = await env.HYPE_CACHE.get('_signal_state_v2');
    const prevState = prevStateRaw ? JSON.parse(prevStateRaw) : {};
    const newState = {};
    radarCoins.forEach(c => {
      newState[c.id] = signalFor(c.score, c.price_change);
    });
    await env.HYPE_CACHE.put('_signal_state_v2', JSON.stringify(newState), { expirationTtl: 3600 });

    // Find coins that newly became 'moon' (BUY signal)
    const newMoonIds = new Set(
      radarCoins
        .filter(c => newState[c.id] === 'moon' && prevState[c.id] !== 'moon')
        .map(c => c.id)
    );

    // Send push alerts to subscribers watching these coins
    if (newMoonIds.size > 0) {
      const list = await env.HYPE_CACHE.list({ prefix: 'sub_' });
      for (const key of list.keys) {
        const raw = await env.HYPE_CACHE.get(key.name);
        if (!raw) continue;
        let record;
        try { record = JSON.parse(raw); } catch(e) { continue; }
        const { sub, coins: watchedCoins } = record;
        if (!watchedCoins || !watchedCoins.length) continue;
        const alerts = watchedCoins
          .filter(id => newMoonIds.has(id))
          .map(id => scoreMap[id])
          .filter(Boolean);
        if (!alerts.length) continue;
        const coinList = alerts.map(c => `${c.symbol} +${c.price_change.toFixed(1)}%`).join(', ');
        const title = alerts.length === 1
          ? `🚀 BUY Signal: ${alerts[0].name}`
          : `🚀 ${alerts.length} BUY Signals on Your Saved List`;
        const body = alerts.length === 1
          ? `${alerts[0].symbol} is trending with a strong BUY signal. +${alerts[0].price_change.toFixed(1)}% in 24h.`
          : `New BUY signals: ${coinList}`;
        try {
          await sendPush(sub, { title, body }, env);
        } catch(e) {
          if (e.message && e.message.includes('410')) {
            await env.HYPE_CACHE.delete(key.name);
          }
        }
      }
    }

    console.log(`[CHR cron] Done. Radar: ${radarCoins.length} coins. Prices updated: ${Object.keys(priceMap).length}. New MOON signals: ${newMoonIds.size}`);
  } catch(err) {
    console.error('[CHR cron] runFullCron failed:', err.message);
    // Fallback to original signal scan so push alerts still work
    await runSignalScan(env);
  }
}

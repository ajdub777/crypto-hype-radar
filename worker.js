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

    return new Response('Crypto Hype Radar — Webhook Proxy', {
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  // ── Scheduled cron handler ──────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSignalScan(env));
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

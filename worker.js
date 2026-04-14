// ── Crypto Hype Radar — Cloudflare Worker ────────────────────────────────────
// Endpoints:
//   POST /subscribe      — save push subscription + watchlist coins
//   POST /update-coins   — update watchlist coins for existing subscription
//   POST /send-push      — manually trigger push to all matching subscribers
//   POST /               — forward email alert signup to Make.com
//   scheduled            — cron: fetch CoinGecko signals, push watchlist alerts

export default {
  // ── HTTP handler ────────────────────────────────────────────────────────────
  async fetch(request, env, ctx) {

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const text = await request.text();
      let data = {};
      try { data = JSON.parse(text); } catch(e) {}
      const sub = data.subscription;
      const coins = data.coins || [];
      if (!sub || !sub.endpoint) {
        return new Response('Invalid subscription', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      const key = 'sub_' + btoa(sub.endpoint).slice(0, 40).replace(/[^a-zA-Z0-9]/g, '');
      await env.HYPE_CACHE.put(key, JSON.stringify({ sub, coins, saved: Date.now() }));
      return new Response('subscribed', { headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    if (request.method === 'POST' && url.pathname === '/update-coins') {
      const text = await request.text();
      let data = {};
      try { data = JSON.parse(text); } catch(e) {}
      const sub = data.subscription;
      const coins = data.coins || [];
      if (!sub || !sub.endpoint) {
        return new Response('Invalid', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      const key = 'sub_' + btoa(sub.endpoint).slice(0, 40).replace(/[^a-zA-Z0-9]/g, '');
      const existing = await env.HYPE_CACHE.get(key);
      if (existing) {
        const parsed = JSON.parse(existing);
        parsed.coins = coins;
        await env.HYPE_CACHE.put(key, JSON.stringify(parsed));
      }
      return new Response('updated', { headers: { 'Access-Control-Allow-Origin': '*' } });
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
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
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
      return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    return new Response('Crypto Hype Radar — Webhook Proxy', {
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  // ── Scheduled cron handler ──────────────────────────────────────────────────
  // Runs every 5 minutes (set cron trigger to: */5 * * * *)
  // Fetches trending + top gainers from CoinGecko, scores signals,
  // then pushes alerts to subscribers whose watchlist contains a BUY coin.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSignalScan(env));
  }
};

// ── Signal scan ──────────────────────────────────────────────────────────────
async function runSignalScan(env) {
  try {
    // 1. Fetch trending coins from CoinGecko
    const trendingRes = await fetch(
      'https://api.coingecko.com/api/v3/search/trending',
      { headers: { 'Accept': 'application/json' } }
    );
    if (!trendingRes.ok) return;
    const trendingData = await trendingRes.json();
    const trendingCoins = (trendingData.coins || []).map(c => c.item);

    // 2. Fetch top gainers (markets sorted by 24h change)
    const gainersRes = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=percent_change_24h_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h',
      { headers: { 'Accept': 'application/json' } }
    );
    const gainers = gainersRes.ok ? await gainersRes.json() : [];

    // 3. Build a map of coin id → signal score
    const scoreMap = {};

    // Trending coins get a base hype boost
    trendingCoins.forEach((coin, i) => {
      const id = coin.id;
      if (!scoreMap[id]) scoreMap[id] = { id, name: coin.name, symbol: coin.symbol, score: 0, price_change: 0 };
      // Top trending = higher score (rank 1 = +3, rank 7 = +1)
      scoreMap[id].score += Math.max(1, 4 - Math.floor(i / 2));
    });

    // Gainers with strong 24h price change get a score boost
    gainers.forEach(coin => {
      const id = coin.id;
      const change = coin.price_change_percentage_24h || 0;
      if (!scoreMap[id]) scoreMap[id] = { id, name: coin.name, symbol: coin.symbol.toUpperCase(), score: 0, price_change: change };
      scoreMap[id].price_change = change;
      if (change >= 20) scoreMap[id].score += 3;
      else if (change >= 10) scoreMap[id].score += 2;
      else if (change >= 5)  scoreMap[id].score += 1;
    });

    // 4. Determine which coins have a BUY signal (score >= 4)
    const buySignals = Object.values(scoreMap).filter(c => c.score >= 4);
    if (buySignals.length === 0) return; // Nothing to push

    const buyIds = new Set(buySignals.map(c => c.id));

    // 5. Load all push subscribers
    const list = await env.HYPE_CACHE.list({ prefix: 'sub_' });
    if (!list.keys.length) return;

    // 6. Check previous signal state to avoid repeat notifications
    const prevStateRaw = await env.HYPE_CACHE.get('_signal_state');
    const prevState = prevStateRaw ? JSON.parse(prevStateRaw) : {};
    const newState = {};
    buySignals.forEach(c => { newState[c.id] = 'BUY'; });

    // Only notify for coins that are NEW BUY signals (weren't BUY last run)
    const newBuyIds = new Set(
      buySignals
        .filter(c => prevState[c.id] !== 'BUY')
        .map(c => c.id)
    );

    // Save current signal state for next run
    await env.HYPE_CACHE.put('_signal_state', JSON.stringify(newState), { expirationTtl: 3600 });

    if (newBuyIds.size === 0) return; // No new signals since last run

    // 7. For each subscriber, check if any of their watchlist coins have a new BUY
    for (const key of list.keys) {
      const raw = await env.HYPE_CACHE.get(key.name);
      if (!raw) continue;
      let record;
      try { record = JSON.parse(raw); } catch(e) { continue; }
      const { sub, coins: watchedCoins } = record;
      if (!watchedCoins || !watchedCoins.length) continue;

      // Find which of this user's watched coins have a new BUY signal
      const alerts = watchedCoins
        .filter(id => newBuyIds.has(id))
        .map(id => scoreMap[id])
        .filter(Boolean);

      if (!alerts.length) continue;

      // Build notification message
      const coinList = alerts.map(c => `${c.symbol} +${c.price_change.toFixed(1)}%`).join(', ');
      const title = alerts.length === 1
        ? `🚀 BUY Signal: ${alerts[0].name}`
        : `🚀 ${alerts.length} BUY Signals on Your Watchlist`;
      const body = alerts.length === 1
        ? `${alerts[0].symbol} is trending with a strong BUY signal. +${alerts[0].price_change.toFixed(1)}% in 24h.`
        : `New BUY signals: ${coinList}`;

      try {
        await sendPush(sub, { title, body }, env);
      } catch(e) {
        // Remove stale/expired subscriptions (HTTP 410 = Gone)
        if (e.message && e.message.includes('410')) {
          await env.HYPE_CACHE.delete(key.name);
        }
      }
    }
  } catch(err) {
    // Silently fail — cron will retry on next interval
    console.error('[CHR cron] Signal scan failed:', err.message);
  }
}

// ── Push delivery ────────────────────────────────────────────────────────────
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
  const clientKey = await crypto.subtle.importKey(
    'raw', p256dh,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, ['deriveKey', 'deriveBits']
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientKey },
    serverKeyPair.privateKey, 256
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const serverPublicKeyRaw = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);
  const prk = await hkdf(
    new Uint8Array(sharedBits), auth,
    concat(str('WebPush: info\0'), p256dh, new Uint8Array(serverPublicKeyRaw)), 32
  );
  const cek = await hkdf(prk, salt, concat(str('Content-Encoding: aes128gcm\0'), new Uint8Array(1)), 16);
  const nonce = await hkdf(prk, salt, concat(str('Content-Encoding: nonce\0'), new Uint8Array(1)), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = new TextEncoder().encode(payload + '\x02');
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data);
  const serverPublicKey = new Uint8Array(serverPublicKeyRaw);
  const header = new Uint8Array(21 + serverPublicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = serverPublicKey.length;
  header.set(serverPublicKey, 21);
  const body = concat(header, new Uint8Array(encrypted));
  return { headers: { 'Content-Length': body.byteLength.toString() }, body };
}

async function hkdf(ikm, salt, info, length) {
  const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
  const prkKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const t = new Uint8Array(await crypto.subtle.sign('HMAC', prkKey, concat(info, new Uint8Array([1]))));
  return t.slice(0, length);
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) { result.set(new Uint8Array(arr.buffer || arr), offset); offset += arr.byteLength; }
  return result;
}

function str(s) { return new TextEncoder().encode(s); }
function base64url(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function base64urlDecode(s) { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }

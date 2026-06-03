-- ── Hype Trader Simulator — D1 Schema ────────────────────────────────────────
-- Tables: traders, positions, trades, coin_radar, saved_list, coin_prices
-- No auth required — users identified by a UUID stored in localStorage

-- Trader accounts (anonymous, UUID-based)
CREATE TABLE IF NOT EXISTS traders (
  id          TEXT PRIMARY KEY,          -- UUID generated client-side
  username    TEXT NOT NULL DEFAULT '',  -- optional display name
  balance     REAL NOT NULL DEFAULT 10000.00,
  created_at  INTEGER NOT NULL,          -- unix ms
  updated_at  INTEGER NOT NULL
);

-- Open positions (coins currently held)
CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id   TEXT NOT NULL REFERENCES traders(id),
  coin_id     TEXT NOT NULL,             -- CoinGecko id e.g. "bitcoin"
  ticker      TEXT NOT NULL,             -- e.g. "BTC"
  coin_name   TEXT NOT NULL,
  qty         REAL NOT NULL,             -- number of coins held
  entry_price REAL NOT NULL,             -- price at time of buy
  entry_ts    INTEGER NOT NULL,          -- unix ms
  take_profit REAL,                      -- optional TP level
  stop_loss   REAL,                      -- optional SL level
  hype_score  INTEGER,
  signal      TEXT NOT NULL DEFAULT 'BUY'
);

-- Closed trades (full history)
CREATE TABLE IF NOT EXISTS trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id    TEXT NOT NULL REFERENCES traders(id),
  coin_id      TEXT NOT NULL,
  ticker       TEXT NOT NULL,
  coin_name    TEXT NOT NULL,
  side         TEXT NOT NULL,            -- 'BUY' or 'SELL'
  qty          REAL NOT NULL,
  price        REAL NOT NULL,
  usd_value    REAL NOT NULL,            -- qty * price
  pnl          REAL,                     -- null for BUY trades, set on SELL
  pnl_pct      REAL,                     -- % gain/loss
  entry_price  REAL,                     -- original buy price (set on SELL)
  hype_score   INTEGER,
  signal       TEXT,
  ts           INTEGER NOT NULL          -- unix ms
);

-- ── Radar history — every coin that ever appeared in the top 15 scan ─────────
-- Used to track coins after they fall off the trending list
CREATE TABLE IF NOT EXISTS coin_radar (
  coin_id       TEXT PRIMARY KEY,        -- CoinGecko id
  ticker        TEXT NOT NULL,
  coin_name     TEXT NOT NULL,
  image_url     TEXT,
  first_seen_ts INTEGER NOT NULL,        -- unix ms when first detected on radar
  first_seen_price REAL,                 -- price when first detected
  last_seen_ts  INTEGER NOT NULL,        -- unix ms of last scan appearance
  last_signal   TEXT,                    -- 'moon','dump','trend','watch'
  last_hype     INTEGER,
  last_price    REAL,
  updated_at    INTEGER NOT NULL
);

-- ── Per-user saved list (replaces localStorage watchlist) ────────────────────
CREATE TABLE IF NOT EXISTS saved_list (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id   TEXT NOT NULL,             -- same UUID as traders table
  coin_id     TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  coin_name   TEXT NOT NULL,
  saved_at    INTEGER NOT NULL,
  UNIQUE(trader_id, coin_id)
);

-- ── Latest prices cache (updated by cron every 5 min) ────────────────────────
-- Covers all coins in coin_radar + any coin in open positions or saved_list
CREATE TABLE IF NOT EXISTS coin_prices (
  coin_id     TEXT PRIMARY KEY,
  price_usd   REAL NOT NULL,
  change_24h  REAL,
  updated_at  INTEGER NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_positions_trader  ON positions(trader_id);
CREATE INDEX IF NOT EXISTS idx_trades_trader     ON trades(trader_id);
CREATE INDEX IF NOT EXISTS idx_trades_ts         ON trades(ts DESC);
CREATE INDEX IF NOT EXISTS idx_saved_trader      ON saved_list(trader_id);
CREATE INDEX IF NOT EXISTS idx_radar_last_seen   ON coin_radar(last_seen_ts DESC);

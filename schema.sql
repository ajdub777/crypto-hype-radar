-- ── Hype Trader Simulator — D1 Schema ────────────────────────────────────────
-- Tables: traders, positions, trades
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

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_positions_trader ON positions(trader_id);
CREATE INDEX IF NOT EXISTS idx_trades_trader    ON trades(trader_id);
CREATE INDEX IF NOT EXISTS idx_trades_ts        ON trades(ts DESC);

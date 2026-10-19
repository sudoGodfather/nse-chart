// NSE Chart Backend — wraps stock-nse-india and exposes JSON endpoints
const express = require('express');
const path = require('path');
const { NseIndia } = require('stock-nse-india');

const nse = new NseIndia();
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const validSymbol = (s) => /^[A-Z0-9&-]{1,20}$/.test(s);

// ── Historical (daily OHLCV) ────────────────────────────────────────────────
app.get('/api/historical', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase().trim();
    if (!validSymbol(symbol))
      return res.status(400).json({ error: 'Enter a valid NSE symbol, e.g. RELIANCE.' });

    const start = new Date(req.query.start);
    const end   = new Date(req.query.end);
    if (isNaN(start) || isNaN(end) || start > end)
      return res.status(400).json({ error: 'Pick a valid date range.' });

    const chunks = await nse.getEquityHistoricalData(symbol, { start, end });
    const byDate = new Map();
    for (const chunk of chunks) {
      for (const r of (chunk.data || [])) {
        // Parse date from "19-Oct-2026" → "2026-10-19"
        const rawDate = r.mtimestamp || r.CH_TIMESTAMP || '';
        let dateKey = rawDate;
        if (/^\d{2}-[A-Za-z]{3}-\d{4}$/.test(rawDate)) {
          dateKey = new Date(rawDate).toISOString().slice(0, 10);
        } else {
          dateKey = String(rawDate).slice(0, 10);
        }
        byDate.set(dateKey, {
          date:   dateKey,
          open:   r.chOpeningPrice   ?? r.CH_OPENING_PRICE,
          high:   r.chTradeHighPrice ?? r.CH_TRADE_HIGH_PRICE,
          low:    r.chTradeLowPrice  ?? r.CH_TRADE_LOW_PRICE,
          close:  r.chClosingPrice   ?? r.CH_CLOSING_PRICE,
          volume: r.chTotTradedQty   ?? r.CH_TOT_TRADED_QTY,
        });
      }
    }
    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    res.json({ symbol, rows });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not fetch data from NSE.' });
  }
});

// ── Intraday (minute-level) ─────────────────────────────────────────────────
app.get('/api/intraday', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase().trim();
    if (!validSymbol(symbol))
      return res.status(400).json({ error: 'Enter a valid NSE symbol, e.g. RELIANCE.' });

    const data = await nse.getEquityIntradayData(symbol);
    let pts = data.grapthData || data.graphData || [];

    // NSE sometimes sends IST clock time as if it were UTC — normalise
    if (pts.length && new Date(pts[0][0]).getUTCHours() >= 8)
      pts = pts.map(([t, p]) => [t - 5.5 * 3600 * 1000, p]);

    res.json({ symbol, points: pts.map(([t, p]) => ({ t, price: p })) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not fetch data from NSE.' });
  }
});

// ── Quote (live / last-traded price) ───────────────────────────────────────
app.get('/api/quote', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase().trim();
    if (!validSymbol(symbol))
      return res.status(400).json({ error: 'Invalid symbol.' });

    const data = await nse.getEquityDetails(symbol);
    const info = data?.priceInfo || {};
    res.json({
      symbol,
      lastPrice:       info.lastPrice,
      change:          info.change,
      pChange:         info.pChange,
      open:            info.open,
      high:            info.intraDayHighLow?.max,
      low:             info.intraDayHighLow?.min,
      previousClose:   info.previousClose,
      weekHigh52:      info.weekHighLow?.max,
      weekLow52:       info.weekHighLow?.min,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not fetch quote.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`NSE Chart running at http://localhost:${port}`));

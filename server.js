// NSE Chart Backend — wraps stock-nse-india and exposes JSON endpoints
const express = require('express');
const path = require('path');
const https = require('https');
const { NseIndia } = require('stock-nse-india');

const nse = new NseIndia();
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Known indices and their charting scripcode / tokens
const INDEX_TOKENS = {
  'NIFTY 50': '26000',
  'NIFTY IT': '26001',
  'NIFTY NEXT 50': '26002',
  'NIFTY BANK': '26004',
  'BANKNIFTY': '26004',
  'NIFTY MIDCAP 100': '26005',
  'NIFTY 500': '26006',
  'NIFTY 100': '26007',
  'NIFTY MIDCAP 50': '26008',
  'NIFTY REALTY': '26009',
  'NIFTY INFRA': '26010',
  'NIFTY ENERGY': '26012',
  'NIFTY FMCG': '26013',
  'NIFTY MNC': '26014',
  'NIFTY PHARMA': '26015',
  'NIFTY PSE': '26016',
  'NIFTY PSU BANK': '26017',
  'NIFTY SERV SECTOR': '26018',
  'NIFTY SMLCAP 100': '26019',
  'NIFTY 200': '26020',
  'NIFTY AUTO': '26021',
  'NIFTY FINANCIAL SERVICES': '26004',
  'FINNIFTY': '26004',
};

// Aliases for renamed or commonly mistyped symbols
const ALIASES = {
  'TATAMOTORS': 'TMPV',
  'TATAMOTOR': 'TMPV',
  'NIFTY': 'NIFTY 50',
  'BANKNIFTY': 'NIFTY BANK',
  'FINNIFTY': 'NIFTY FINANCIAL SERVICES',
  'NIFTYIT': 'NIFTY IT',
  'BAJAJAUTO': 'BAJAJ-AUTO',
  'MM': 'M&M',
  'L&T': 'LT',
};

// In-memory stock directory (loaded from NSE EQUITY_L.csv)
let stockDirectory = [];

function loadStockDirectory() {
  const url = 'https://archives.nseindia.com/content/equities/EQUITY_L.csv';
  https.get(url, (res) => {
    if (res.statusCode !== 200) return;
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      try {
        const lines = data.split('\n');
        const list = [];
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const parts = line.split(',');
          const symbol = (parts[0] || '').trim();
          const name = (parts[1] || '').trim();
          const series = (parts[2] || '').trim();
          if (symbol) {
            list.push({ symbol, name, series: series || 'EQ', type: 'Equity' });
          }
        }
        if (list.length > 500) {
          stockDirectory = list;
          console.log(`Loaded ${list.length} NSE stocks from master list.`);
        }
      } catch (err) {
        console.error('Error parsing EQUITY_L.csv:', err.message);
      }
    });
  }).on('error', (e) => {
    console.warn('Could not load EQUITY_L.csv, using default stocks:', e.message);
  });
}
loadStockDirectory();

// Normalize and resolve symbol
function resolveSymbol(input) {
  let s = decodeURIComponent(String(input || '')).trim().toUpperCase();
  if (ALIASES[s]) s = ALIASES[s];
  return s;
}

function isIndex(symbol) {
  const upper = symbol.toUpperCase();
  return Boolean(INDEX_TOKENS[upper]) || upper.startsWith('NIFTY') || upper.startsWith('BANKNIFTY');
}

const validSymbol = (s) => /^[A-Z0-9&_ -]{1,35}$/i.test(s);

// ── Search & Autocomplete API ────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const query = (req.query.q || '').trim().toLowerCase();

  // Index suggestions
  const indexMatches = Object.entries(INDEX_TOKENS).map(([name, token]) => ({
    symbol: name,
    name: `${name} Index`,
    type: 'Index',
    token
  })).filter(idx => !query || idx.symbol.toLowerCase().includes(query) || idx.name.toLowerCase().includes(query));

  if (!query) {
    // Return top popular stocks & indices when search box is empty
    const popularSymbols = ['NIFTY 50', 'NIFTY BANK', 'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'TMPV', 'TMCV', 'SBIN', 'ITC', 'BHARTIARTL', 'LT', 'M&M', 'ZOMATO'];
    const results = [];
    for (const sym of popularSymbols) {
      if (INDEX_TOKENS[sym]) {
        results.push({ symbol: sym, name: `${sym} Index`, type: 'Index' });
      } else {
        const found = stockDirectory.find(s => s.symbol === sym);
        results.push({
          symbol: sym,
          name: found ? found.name : sym,
          type: 'Equity'
        });
      }
    }
    return res.json({ results });
  }

  // Stock matches
  const stockExact = [];
  const stockPrefix = [];
  const stockName = [];

  for (const item of stockDirectory) {
    const symLower = item.symbol.toLowerCase();
    const nameLower = item.name.toLowerCase();

    if (symLower === query) {
      stockExact.push(item);
    } else if (symLower.startsWith(query)) {
      stockPrefix.push(item);
    } else if (nameLower.includes(query) || symLower.includes(query)) {
      stockName.push(item);
    }
  }

  // Add alias matches (like TATAMOTORS)
  if (query.includes('tata motor') || query === 'tatamotors') {
    const tmcv = stockDirectory.find(s => s.symbol === 'TMCV');
    const tmpv = stockDirectory.find(s => s.symbol === 'TMPV');
    if (tmpv && !stockExact.includes(tmpv)) stockExact.unshift(tmpv);
    if (tmcv && !stockExact.includes(tmcv)) stockExact.unshift(tmcv);
  }

  const combined = [
    ...indexMatches.slice(0, 4),
    ...stockExact,
    ...stockPrefix.slice(0, 10),
    ...stockName.slice(0, 15)
  ];

  // Deduplicate by symbol
  const seen = new Set();
  const results = [];
  for (const r of combined) {
    if (!seen.has(r.symbol)) {
      seen.add(r.symbol);
      results.push(r);
    }
    if (results.length >= 20) break;
  }

  res.json({ results });
});

// ── Historical (daily OHLCV) ────────────────────────────────────────────────
app.get('/api/historical', async (req, res) => {
  try {
    const rawSymbol = String(req.query.symbol || '');
    const symbol = resolveSymbol(rawSymbol);
    if (!validSymbol(symbol))
      return res.status(400).json({ error: 'Enter a valid NSE symbol, e.g. RELIANCE, TCS, or NIFTY 50.' });

    const start = new Date(req.query.start);
    const end   = new Date(req.query.end);
    if (isNaN(start) || isNaN(end) || start > end)
      return res.status(400).json({ error: 'Pick a valid date range.' });

    const byDate = new Map();

    if (isIndex(symbol)) {
      // Index Historical via charting endpoint
      const token = INDEX_TOKENS[symbol] || '26000';
      const chart = await nse.getEquityChartHistoricalData(symbol, { start, end }, token, 'Index', 'D', '1');
      const dataArr = chart?.data || [];
      for (const r of dataArr) {
        if (!r.time) continue;
        const dateKey = new Date(r.time).toISOString().slice(0, 10);
        byDate.set(dateKey, {
          date:   dateKey,
          open:   r.open,
          high:   r.high,
          low:    r.low,
          close:  r.close,
          volume: r.volume || 0,
        });
      }
    } else {
      // Equity Historical
      try {
        const chunks = await nse.getEquityHistoricalData(symbol, { start, end });
        for (const chunk of chunks) {
          for (const r of (chunk.data || [])) {
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
              volume: r.chTotTradedQty   ?? r.CH_TOT_TRADED_QTY ?? 0,
            });
          }
        }
      } catch (equityErr) {
        // Fallback to charting endpoint if equity quote API fails
        try {
          const chart = await nse.getEquityChartHistoricalData(symbol, { start, end }, undefined, 'Equity', 'D', '1');
          const dataArr = chart?.data || [];
          for (const r of dataArr) {
            if (!r.time) continue;
            const dateKey = new Date(r.time).toISOString().slice(0, 10);
            byDate.set(dateKey, {
              date:   dateKey,
              open:   r.open,
              high:   r.high,
              low:    r.low,
              close:  r.close,
              volume: r.volume || 0,
            });
          }
        } catch (chartErr) {
          throw equityErr;
        }
      }
    }

    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    res.json({ symbol, rows });
  } catch (e) {
    console.error('Error fetching historical:', e.message);
    res.status(500).json({ error: e.message || 'Could not fetch data from NSE.' });
  }
});

// ── Intraday (minute-level) ─────────────────────────────────────────────────
app.get('/api/intraday', async (req, res) => {
  try {
    const rawSymbol = String(req.query.symbol || '');
    const symbol = resolveSymbol(rawSymbol);
    if (!validSymbol(symbol))
      return res.status(400).json({ error: 'Enter a valid NSE symbol, e.g. RELIANCE, TCS, or NIFTY 50.' });

    let pts = [];
    if (isIndex(symbol)) {
      const data = await nse.getIndexIntradayData(symbol);
      pts = data.grapthData || data.graphData || [];
    } else {
      const data = await nse.getEquityIntradayData(symbol);
      pts = data.grapthData || data.graphData || [];
    }

    // Normalise IST clock time if returned in UTC shifted format
    if (pts.length && new Date(pts[0][0]).getUTCHours() >= 8) {
      pts = pts.map(([t, p]) => [t - 5.5 * 3600 * 1000, p]);
    }

    res.json({ symbol, points: pts.map(([t, p]) => ({ t, price: p })) });
  } catch (e) {
    console.error('Error fetching intraday:', e.message);
    res.status(500).json({ error: e.message || 'Could not fetch data from NSE.' });
  }
});

// ── Quote (live / last-traded price) ───────────────────────────────────────
app.get('/api/quote', async (req, res) => {
  try {
    const rawSymbol = String(req.query.symbol || '');
    const symbol = resolveSymbol(rawSymbol);
    if (!validSymbol(symbol))
      return res.status(400).json({ error: 'Invalid symbol.' });

    if (isIndex(symbol)) {
      const allIndices = await nse.getAllIndices();
      const match = (allIndices?.data || []).find(
        x => (x.indexSymbol || '').toUpperCase() === symbol || (x.index || '').toUpperCase() === symbol
      );
      if (match) {
        return res.json({
          symbol,
          lastPrice:     match.last,
          change:        match.variation,
          pChange:       match.percentChange,
          open:          match.open,
          high:          match.high,
          low:           match.low,
          previousClose: match.previousClose,
          weekHigh52:    match.yearHigh,
          weekLow52:     match.yearLow,
        });
      }
    }

    // Equity quote
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
    console.error('Error fetching quote for', req.query.symbol, ':', e.message);
    res.status(500).json({ error: e.message || 'Could not fetch quote.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`NSE Chart running at http://localhost:${port}`));


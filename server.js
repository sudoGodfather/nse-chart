// NSE Chart Backend — wraps stock-nse-india with Yahoo Finance fallback for Vercel/Cloud hosting
const express = require('express');
const path = require('path');
const https = require('https');
const { NseIndia } = require('stock-nse-india');

const nse = new NseIndia();
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory cache for historical data (5 min TTL)
const historicalCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

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

// Synchronously load bundled master stock list for instant search on Vercel
let stockDirectory = [];
try {
  stockDirectory = require('./stocks.json');
  console.log(`Loaded ${stockDirectory.length} NSE stocks from local stocks.json.`);
} catch (e) {
  console.warn('Local stocks.json not found, initializing empty array.');
  stockDirectory = [];
}

// Yahoo Finance mappings for cloud environments (Vercel) where NSE blocks IPs
const YAHOO_INDEX_MAP = {
  'NIFTY 50': '^NSEI',
  'NIFTY BANK': '^NSEBANK',
  'BANKNIFTY': '^NSEBANK',
  'NIFTY IT': '^CNXIT',
  'NIFTY 500': '^CRSLDX',
  'NIFTY 100': '^CNX100',
  'NIFTY MIDCAP 100': '^NSEMDCP50',
  'NIFTY NEXT 50': '^NSMIDCP',
};

function getYahooTicker(symbol) {
  const s = symbol.toUpperCase().trim();
  if (YAHOO_INDEX_MAP[s]) return YAHOO_INDEX_MAP[s];
  if (s === 'TATAMOTORS' || s === 'TMPV' || s === 'TMCV') return 'TATAMOTORS.NS';
  return s.replace('&', '%26') + '.NS';
}

async function fetchYahooHistorical(symbol, startDate, endDate) {
  const ticker = getYahooTicker(symbol);
  const fromSec = Math.floor(startDate.getTime() / 1000);
  const toSec = Math.floor(endDate.getTime() / 1000) + 86400; // include end date

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${fromSec}&period2=${toSec}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!res.ok) throw new Error(`Yahoo Finance returned HTTP ${res.status}`);
  const json = await res.json();
  const res0 = json.chart?.result?.[0];
  if (!res0) throw new Error('No historical data available on Yahoo Finance.');

  const timestamps = res0.timestamp || [];
  const quote = res0.indicators?.quote?.[0] || {};
  const rows = [];
  const startIso = startDate.toISOString().slice(0, 10);
  const endIso = endDate.toISOString().slice(0, 10);

  for (let i = 0; i < timestamps.length; i++) {
    if (quote.close[i] == null) continue;
    const dateStr = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    if (dateStr >= startIso && dateStr <= endIso) {
      rows.push({
        date: dateStr,
        open: Number((quote.open[i] ?? quote.close[i]).toFixed(2)),
        high: Number((quote.high[i] ?? quote.close[i]).toFixed(2)),
        low: Number((quote.low[i] ?? quote.close[i]).toFixed(2)),
        close: Number(quote.close[i].toFixed(2)),
        volume: Number(quote.volume[i] ?? 0),
      });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchYahooIntraday(symbol) {
  const ticker = getYahooTicker(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!res.ok) throw new Error(`Yahoo Finance intraday returned HTTP ${res.status}`);
  const json = await res.json();
  const res0 = json.chart?.result?.[0];
  if (!res0) throw new Error('No intraday data available on Yahoo Finance.');

  const timestamps = res0.timestamp || [];
  const quotes = res0.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (quotes[i] != null) {
      points.push({
        t: timestamps[i] * 1000,
        price: Number(quotes[i].toFixed(2)),
      });
    }
  }
  return points;
}

async function fetchYahooQuote(symbol) {
  const ticker = getYahooTicker(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!res.ok) throw new Error(`Yahoo Finance quote returned HTTP ${res.status}`);
  const json = await res.json();
  const res0 = json.chart?.result?.[0];
  if (!res0) throw new Error('No quote data available on Yahoo Finance.');

  const meta = res0.meta || {};
  const lastPrice = meta.regularMarketPrice ?? meta.chartPreviousClose;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? lastPrice;
  const change = lastPrice != null && prevClose != null ? lastPrice - prevClose : 0;
  const pChange = prevClose ? (change / prevClose) * 100 : 0;

  return {
    symbol,
    lastPrice: Number(lastPrice.toFixed(2)),
    change: Number(change.toFixed(2)),
    pChange: Number(pChange.toFixed(2)),
    open: meta.regularMarketOpen ? Number(meta.regularMarketOpen.toFixed(2)) : undefined,
    high: meta.regularMarketDayHigh ? Number(meta.regularMarketDayHigh.toFixed(2)) : undefined,
    low: meta.regularMarketDayLow ? Number(meta.regularMarketDayLow.toFixed(2)) : undefined,
    previousClose: Number(prevClose.toFixed(2)),
    weekHigh52: meta.fiftyTwoWeekHigh ? Number(meta.fiftyTwoWeekHigh.toFixed(2)) : undefined,
    weekLow52: meta.fiftyTwoWeekLow ? Number(meta.fiftyTwoWeekLow.toFixed(2)) : undefined,
  };
}

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

    const cacheKey = `${symbol}:${req.query.start}:${req.query.end}`;
    const cached = historicalCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return res.json({ symbol, rows: cached.rows });
    }

    const byDate = new Map();

    // 1. Try NSE Official endpoints
    let nseSuccess = false;
    try {
      if (isIndex(symbol)) {
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
        if (byDate.size > 0) nseSuccess = true;
      } else {
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
        if (byDate.size > 0) nseSuccess = true;
      }
    } catch (nseErr) {
      console.warn(`NSE official historical failed for ${symbol} (${nseErr.message}), falling back to Yahoo Finance.`);
    }

    // 2. Fallback to Yahoo Finance if NSE was blocked (e.g. 403 on Vercel) or returned 0 rows
    let rows = [];
    if (nseSuccess && byDate.size > 0) {
      rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    } else {
      rows = await fetchYahooHistorical(symbol, start, end);
    }

    if (!rows.length) {
      return res.status(404).json({ error: `No trading data found for ${symbol} in this range.` });
    }

    historicalCache.set(cacheKey, { ts: Date.now(), rows });
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

    // 1. Try NSE Intraday
    try {
      if (isIndex(symbol)) {
        const data = await nse.getIndexIntradayData(symbol);
        pts = data.grapthData || data.graphData || [];
      } else {
        const data = await nse.getEquityIntradayData(symbol);
        pts = data.grapthData || data.graphData || [];
      }

      if (pts.length && new Date(pts[0][0]).getUTCHours() >= 8) {
        pts = pts.map(([t, p]) => [t - 5.5 * 3600 * 1000, p]);
      }
    } catch (nseErr) {
      console.warn(`NSE official intraday failed for ${symbol} (${nseErr.message}), falling back to Yahoo Finance.`);
    }

    // 2. Fallback to Yahoo Finance intraday if NSE was blocked on cloud/Vercel
    if (pts && pts.length > 0) {
      res.json({ symbol, points: pts.map(([t, p]) => ({ t, price: p })) });
    } else {
      const yahooPoints = await fetchYahooIntraday(symbol);
      res.json({ symbol, points: yahooPoints });
    }
  } catch (e) {
    console.error('Error fetching intraday:', e.message);
    res.status(500).json({ error: e.message || 'Could not fetch intraday data.' });
  }
});

// ── Quote (live / last-traded price) ───────────────────────────────────────
app.get('/api/quote', async (req, res) => {
  try {
    const rawSymbol = String(req.query.symbol || '');
    const symbol = resolveSymbol(rawSymbol);
    if (!validSymbol(symbol))
      return res.status(400).json({ error: 'Invalid symbol.' });

    // 1. Try NSE official quote
    try {
      if (isIndex(symbol)) {
        const allIndices = await nse.getAllIndices();
        const match = (allIndices?.data || []).find(
          x => (x.indexSymbol || '').toUpperCase() === symbol || (x.index || '').toUpperCase() === symbol
        );
        if (match && match.last != null) {
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
      } else {
        const data = await nse.getEquityDetails(symbol);
        const info = data?.priceInfo || {};
        if (info.lastPrice != null) {
          return res.json({
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
        }
      }
    } catch (nseErr) {
      console.warn(`NSE official quote failed for ${symbol} (${nseErr.message}), falling back to Yahoo Finance.`);
    }

    // 2. Fallback to Yahoo Finance quote if NSE blocked/errored on Vercel
    const yQuote = await fetchYahooQuote(symbol);
    res.json(yQuote);
  } catch (e) {
    console.error('Error fetching quote for', req.query.symbol, ':', e.message);
    res.status(500).json({ error: e.message || 'Could not fetch quote.' });
  }
});

const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`NSE Chart running at http://localhost:${port}`));
}

module.exports = app;

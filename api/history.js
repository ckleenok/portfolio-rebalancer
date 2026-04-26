const HISTORY_TICKERS = new Set(["GLD", "SCHD", "SPY", "QQQ"]);
const historyCache = new Map();

function parseYahooMonthlyHistory(payload) {
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose || quote.close || [];

  return timestamps
    .map((timestamp, index) => {
      const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
      return { date, close: Number(adjusted[index]) };
    })
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function calculateMovingAverageCagr(monthlyCloses, months = 120) {
  const slice = monthlyCloses.slice(-(months + 1));
  const returns = [];

  for (let index = 1; index < slice.length; index += 1) {
    returns.push(slice[index].close / slice[index - 1].close - 1);
  }

  if (returns.length === 0) {
    throw new Error("Not enough monthly history");
  }

  const averageMonthlyReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  return {
    cagr: Math.pow(1 + averageMonthlyReturn, 12) - 1,
    monthsUsed: returns.length,
    startDate: slice[0].date,
    endDate: slice[slice.length - 1].date,
  };
}

async function fetchYahooMonthlyHistory(ticker) {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=11y&interval=1mo&events=history&includeAdjustedClose=true`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=11y&interval=1mo&events=history&includeAdjustedClose=true`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=max&interval=1mo&events=history&includeAdjustedClose=true`,
  ];
  let lastError = null;

  for (const url of urls) {
    try {
      const historyResponse = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 portfolio-rebalancer",
          accept: "application/json",
        },
      });
      if (!historyResponse.ok) throw new Error(`History returned ${historyResponse.status}`);
      const payload = await historyResponse.json();
      const monthlyCloses = parseYahooMonthlyHistory(payload);
      const stats = calculateMovingAverageCagr(monthlyCloses, 120);
      return {
        ticker,
        ...stats,
        source: "Yahoo Finance monthly adjusted close",
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("History unavailable");
}

module.exports = async function handler(request, response) {
  const ticker = String(request.query?.ticker || "").toUpperCase();
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");

  if (!HISTORY_TICKERS.has(ticker)) {
    response.status(400).send(JSON.stringify({ error: "Unsupported ticker" }));
    return;
  }

  try {
    const cached = historyCache.get(ticker);
    const cacheAge = cached ? Date.now() - cached.cachedAt : Infinity;
    if (cached && cacheAge < 6 * 60 * 60 * 1000) {
      response.status(200).send(JSON.stringify({ ...cached.data, cached: true }));
      return;
    }

    const data = await fetchYahooMonthlyHistory(ticker);
    historyCache.set(ticker, { data, cachedAt: Date.now() });
    response.status(200).send(JSON.stringify(data));
  } catch (error) {
    const cached = historyCache.get(ticker);
    if (cached) {
      response.status(200).send(JSON.stringify({ ...cached.data, cached: true, warning: error.message }));
      return;
    }

    response.status(502).send(JSON.stringify({ error: error.message }));
  }
};

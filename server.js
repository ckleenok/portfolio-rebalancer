const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const STATIC_ROOT = path.join(__dirname, "public");
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1HM_Jxv6zQzr-O5Spt06uq2HTyX1yFTVju2jzVjneL5M/export?format=csv&gid=172728277";
const HISTORY_TICKERS = new Set(["GLD", "SCHD", "SPY", "QQQ"]);
const historyCache = new Map();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

function send(response, status, body, type = "text/plain; charset=utf-8") {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

function safeFilePath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  const target = cleanPath === "/" ? "/index.html" : cleanPath;
  const resolved = path.resolve(STATIC_ROOT, `.${target}`);
  return resolved.startsWith(STATIC_ROOT) ? resolved : null;
}

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

function parseYahooDailyHistory(payload) {
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

async function fetchYahooTrend30(ticker) {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2mo&interval=1d&events=history&includeAdjustedClose=true`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=2mo&interval=1d&events=history&includeAdjustedClose=true`,
  ];
  let lastError = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 portfolio-rebalancer",
          accept: "application/json",
        },
      });
      if (!response.ok) throw new Error(`Trend returned ${response.status}`);
      const payload = await response.json();
      const daily = parseYahooDailyHistory(payload).slice(-30);
      if (daily.length < 2) throw new Error("Not enough daily history");
      const first = daily[0].close;
      const last = daily[daily.length - 1].close;
      return {
        ticker,
        mode: "trend30",
        points: daily,
        startDate: daily[0].date,
        endDate: daily[daily.length - 1].date,
        change: first > 0 ? last / first - 1 : 0,
        source: "Yahoo Finance daily adjusted close",
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Trend unavailable");
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.url.startsWith("/api/sheet")) {
    try {
      const sheetResponse = await fetch(SHEET_CSV_URL);
      if (!sheetResponse.ok) throw new Error(`Google Sheet returned ${sheetResponse.status}`);
      const csv = await sheetResponse.text();
      send(response, 200, csv, "text/csv; charset=utf-8");
    } catch (error) {
      send(response, 502, `Google Sheet을 불러오지 못했습니다: ${error.message}`);
    }
    return;
  }

  if (requestUrl.pathname === "/api/history") {
    const ticker = (requestUrl.searchParams.get("ticker") || "").toUpperCase();
    const mode = (requestUrl.searchParams.get("mode") || "cagr").toLowerCase();
    if (!HISTORY_TICKERS.has(ticker)) {
      send(response, 400, JSON.stringify({ error: "Unsupported ticker" }), "application/json; charset=utf-8");
      return;
    }
    if (!["cagr", "trend30"].includes(mode)) {
      send(response, 400, JSON.stringify({ error: "Unsupported mode" }), "application/json; charset=utf-8");
      return;
    }

    try {
      const cacheKey = `${ticker}:${mode}`;
      const cached = historyCache.get(cacheKey);
      const cacheAge = cached ? Date.now() - cached.cachedAt : Infinity;
      if (cached && cacheAge < 6 * 60 * 60 * 1000) {
        send(response, 200, JSON.stringify({ ...cached.data, cached: true }), "application/json; charset=utf-8");
        return;
      }

      const data = mode === "trend30" ? await fetchYahooTrend30(ticker) : await fetchYahooMonthlyHistory(ticker);
      historyCache.set(cacheKey, { data, cachedAt: Date.now() });
      send(response, 200, JSON.stringify(data), "application/json; charset=utf-8");
    } catch (error) {
      const cacheKey = `${ticker}:${mode}`;
      const cached = historyCache.get(cacheKey);
      if (cached) {
        send(
          response,
          200,
          JSON.stringify({ ...cached.data, cached: true, warning: error.message }),
          "application/json; charset=utf-8",
        );
        return;
      }

      send(response, 502, JSON.stringify({ error: error.message }), "application/json; charset=utf-8");
    }
    return;
  }

  const filePath = safeFilePath(request.url);
  if (!filePath) {
    send(response, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(response, 404, "Not found");
      return;
    }

    send(response, 200, data, TYPES[path.extname(filePath)] || "application/octet-stream");
  });
});

server.listen(PORT, () => {
  console.log(`Portfolio rebalancer: http://localhost:${PORT}`);
});

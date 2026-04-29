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
const marketPulseCache = { data: null, cachedAt: 0 };

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

function parseFredCsv(csvText) {
  return String(csvText || "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(","))
    .map(([date, value]) => ({ date, value: Number(value) }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.value) && row.value > 0);
}

function toUtcDay(dateText) {
  return new Date(`${dateText}T00:00:00Z`).getTime();
}

function buildDailyTrend60(points) {
  const normalized = (points || [])
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (normalized.length === 0) return [];

  const dayMs = 24 * 60 * 60 * 1000;
  const endDay = toUtcDay(normalized[normalized.length - 1].date);
  const startDay = endDay - dayMs * 59;

  let index = 0;
  let currentValue = normalized[0].value;
  const series = [];

  for (let day = startDay; day <= endDay; day += dayMs) {
    while (index < normalized.length && toUtcDay(normalized[index].date) <= day) {
      currentValue = normalized[index].value;
      index += 1;
    }
    series.push({
      date: new Date(day).toISOString().slice(0, 10),
      value: currentValue,
    });
  }

  return series;
}

function extractFearGreedTrend(payload) {
  const historical =
    payload?.fear_and_greed_historical?.data ||
    payload?.fear_and_greed_historical?.historical ||
    payload?.fear_and_greed_historical ||
    [];
  if (!Array.isArray(historical)) return [];
  return buildDailyTrend60(
    historical
    .map((point) => {
      const rawDate = point?.x ?? point?.timestamp ?? point?.date ?? null;
      const date =
        typeof rawDate === "number"
          ? new Date(rawDate > 1e12 ? rawDate : rawDate * 1000).toISOString().slice(0, 10)
          : String(rawDate || "").slice(0, 10);
      const value = Number(point?.y ?? point?.value ?? point?.score);
      return { date, value };
    })
  );
}

function classifyBuffettIndicator(value) {
  if (!Number.isFinite(value)) return "Unknown";
  if (value < 75) return "Undervalued";
  if (value < 90) return "Fair";
  if (value < 115) return "Slightly Overvalued";
  if (value < 140) return "Overvalued";
  return "Significantly Overvalued";
}

async function fetchFearGreedIndex() {
  const response = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
    headers: {
      "user-agent": "Mozilla/5.0 portfolio-rebalancer",
      accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`Fear & Greed returned ${response.status}`);
  const payload = await response.json();
  const root = payload?.fear_and_greed || {};
  const trend60 = extractFearGreedTrend(payload);
  const value = Number(
    root?.value ?? root?.score ?? payload?.now?.value ?? payload?.score ?? payload?.fear_and_greed_historical?.data?.at?.(-1)?.y,
  );
  if (!Number.isFinite(value)) throw new Error("Fear & Greed value missing");
  const avg60 = trend60.length > 0 ? trend60.reduce((sum, point) => sum + point.value, 0) / trend60.length : value;
  return {
    value,
    label: root?.rating || root?.status || "N/A",
    trend60,
    avg60,
    updatedAt: root?.timestamp || payload?.timestamp || null,
    source: "CNN Fear & Greed Index",
  };
}

async function fetchYahooDailyProxyTrend(ticker, latestValue, days = 60) {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6mo&interval=1d&events=history&includeAdjustedClose=true`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=6mo&interval=1d&events=history&includeAdjustedClose=true`,
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
      if (!response.ok) throw new Error(`Proxy trend returned ${response.status}`);
      const payload = await response.json();
      const daily = parseYahooDailyHistory(payload).slice(-days);
      if (daily.length < 10) throw new Error("Not enough proxy history");
      const lastClose = daily[daily.length - 1].close;
      if (!Number.isFinite(lastClose) || lastClose <= 0) throw new Error("Proxy close missing");
      return daily.map((point) => ({
        date: point.date,
        value: latestValue * (point.close / lastClose),
      }));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Proxy trend unavailable");
}

async function fetchBuffettIndicator() {
  const response = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DDDM01USA156NWDB");
  if (!response.ok) throw new Error(`FRED returned ${response.status}`);
  const rows = parseFredCsv(await response.text());
  const latest = rows.at(-1);
  if (!latest) throw new Error("Insufficient FRED data");
  const value = latest.value;
  let trend60;
  let source = "FRED DDDM01USA156NWDB (Market Cap to GDP)";
  try {
    trend60 = await fetchYahooDailyProxyTrend("VTI", value, 60);
    source = "FRED DDDM01USA156NWDB + Yahoo VTI 60-day proxy trend";
  } catch {
    trend60 = buildDailyTrend60(rows.map((row) => ({ date: row.date, value: row.value })));
  }
  const avg60 = trend60.length > 0 ? trend60.reduce((sum, point) => sum + point.value, 0) / trend60.length : value;
  return {
    value,
    label: classifyBuffettIndicator(value),
    trend60,
    avg60,
    updatedAt: latest.date,
    source,
  };
}

function classifyVix(value) {
  if (!Number.isFinite(value)) return "N/A";
  if (value < 15) return "Low Volatility";
  if (value < 25) return "Normal Volatility";
  if (value < 35) return "Elevated Volatility";
  return "High Volatility";
}

async function fetchVixIndicator() {
  const urls = [
    "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=6mo&interval=1d&events=history&includeAdjustedClose=true",
    "https://query2.finance.yahoo.com/v8/finance/chart/%5EVIX?range=6mo&interval=1d&events=history&includeAdjustedClose=true",
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
      if (!response.ok) throw new Error(`VIX returned ${response.status}`);
      const payload = await response.json();
      const daily = parseYahooDailyHistory(payload).slice(-60);
      if (daily.length < 2) throw new Error("Not enough VIX history");
      const value = Number(daily[daily.length - 1].close);
      const trend60 = daily.map((point) => ({ date: point.date, value: Number(point.close) }));
      const avg60 = trend60.reduce((sum, point) => sum + point.value, 0) / trend60.length;
      return {
        value,
        label: classifyVix(value),
        trend60,
        avg60,
        updatedAt: daily[daily.length - 1].date,
        source: "Yahoo Finance ^VIX",
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("VIX unavailable");
}

async function fetchMarketPulse() {
  const [fearGreed, buffett, vix] = await Promise.all([fetchFearGreedIndex(), fetchBuffettIndicator(), fetchVixIndicator()]);
  return { fearGreed, buffett, vix };
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

async function fetchYahooTrend(ticker, days = 30) {
  const safeDays = Math.max(30, Math.min(365, Number(days) || 30));
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d&events=history&includeAdjustedClose=true`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d&events=history&includeAdjustedClose=true`,
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
      const daily = parseYahooDailyHistory(payload).slice(-safeDays);
      if (daily.length < 2) throw new Error("Not enough daily history");
      const first = daily[0].close;
      const last = daily[daily.length - 1].close;
      return {
        ticker,
        mode: "trend",
        days: safeDays,
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
    const days = Number(requestUrl.searchParams.get("days") || 30);
    if (!HISTORY_TICKERS.has(ticker)) {
      send(response, 400, JSON.stringify({ error: "Unsupported ticker" }), "application/json; charset=utf-8");
      return;
    }
    if (!["cagr", "trend30", "trend"].includes(mode)) {
      send(response, 400, JSON.stringify({ error: "Unsupported mode" }), "application/json; charset=utf-8");
      return;
    }

    try {
      const cacheKey = mode === "trend" ? `${ticker}:${mode}:${days}` : `${ticker}:${mode}`;
      const cached = historyCache.get(cacheKey);
      const cacheAge = cached ? Date.now() - cached.cachedAt : Infinity;
      if (cached && cacheAge < 6 * 60 * 60 * 1000) {
        send(response, 200, JSON.stringify({ ...cached.data, cached: true }), "application/json; charset=utf-8");
        return;
      }

      const data =
        mode === "cagr"
          ? await fetchYahooMonthlyHistory(ticker)
          : await fetchYahooTrend(ticker, mode === "trend30" ? 30 : days);
      historyCache.set(cacheKey, { data, cachedAt: Date.now() });
      send(response, 200, JSON.stringify(data), "application/json; charset=utf-8");
    } catch (error) {
      const cacheKey = mode === "trend" ? `${ticker}:${mode}:${days}` : `${ticker}:${mode}`;
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

  if (requestUrl.pathname === "/api/market-pulse") {
    try {
      const cacheAge = Date.now() - marketPulseCache.cachedAt;
      if (marketPulseCache.data && cacheAge < 60 * 60 * 1000) {
        send(
          response,
          200,
          JSON.stringify({ ...marketPulseCache.data, cached: true }),
          "application/json; charset=utf-8",
        );
        return;
      }

      const data = await fetchMarketPulse();
      marketPulseCache.data = data;
      marketPulseCache.cachedAt = Date.now();
      send(response, 200, JSON.stringify(data), "application/json; charset=utf-8");
    } catch (error) {
      if (marketPulseCache.data) {
        send(
          response,
          200,
          JSON.stringify({ ...marketPulseCache.data, cached: true, warning: error.message }),
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

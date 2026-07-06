const marketPulseCache = { data: null, cachedAt: 0 };
const MARKET_PULSE_TIMEOUT_MS = 8000;
const BUFFETT_FALLBACK = {
  value: 194.889,
  updatedAt: "2020-01-01",
  source: "FRED DDDM01USA156NWDB fallback",
};

async function fetchWithTimeout(url, options = {}, timeoutMs = MARKET_PULSE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
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

function buildFlatTrend60(value) {
  const today = new Date();
  const points = [];
  for (let index = 59; index >= 0; index -= 1) {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - index);
    points.push({ date: day.toISOString().slice(0, 10), value });
  }
  return points;
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
  if (!Number.isFinite(value)) return "알 수 없음";
  if (value < 75) return "저평가";
  if (value < 90) return "적정";
  if (value < 115) return "약간 고평가";
  if (value < 140) return "고평가";
  return "매우 고평가";
}

function normalizeFearGreedLabel(label) {
  const key = String(label || "").trim().toLowerCase();
  if (key.includes("extreme fear")) return "극단적 공포";
  if (key === "fear" || key.includes("fear")) return "공포";
  if (key === "neutral" || key.includes("neutral")) return "중립";
  if (key.includes("extreme greed")) return "극단적 탐욕";
  if (key === "greed" || key.includes("greed")) return "탐욕";
  return label || "N/A";
}

async function fetchFearGreedIndex() {
  const response = await fetchWithTimeout("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
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
    label: normalizeFearGreedLabel(root?.rating || root?.status || "N/A"),
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
      const response = await fetchWithTimeout(url, {
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
  const response = await fetchWithTimeout("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DDDM01USA156NWDB");
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
  if (value < 15) return "낮은 변동성";
  if (value < 25) return "보통 변동성";
  if (value < 35) return "높아진 변동성";
  return "높은 변동성";
}

async function fetchVixIndicator() {
  const urls = [
    "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=6mo&interval=1d&events=history&includeAdjustedClose=true",
    "https://query2.finance.yahoo.com/v8/finance/chart/%5EVIX?range=6mo&interval=1d&events=history&includeAdjustedClose=true",
  ];
  let lastError = null;

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, {
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
  const entries = await Promise.allSettled([fetchFearGreedIndex(), fetchBuffettIndicator(), fetchVixIndicator()]);
  const fallback = (name, result) => ({
    value: null,
    label: "불러오기 실패",
    trend60: [],
    avg60: null,
    updatedAt: null,
    source: name,
    error: result.reason?.message || "Unavailable",
  });
  return {
    fearGreed: entries[0].status === "fulfilled" ? entries[0].value : fallback("CNN Fear & Greed Index", entries[0]),
    buffett:
      entries[1].status === "fulfilled"
        ? entries[1].value
        : {
            value: BUFFETT_FALLBACK.value,
            label: `${classifyBuffettIndicator(BUFFETT_FALLBACK.value)} (최근 확인값)`,
            trend60: buildFlatTrend60(BUFFETT_FALLBACK.value),
            avg60: BUFFETT_FALLBACK.value,
            updatedAt: BUFFETT_FALLBACK.updatedAt,
            source: BUFFETT_FALLBACK.source,
            warning: entries[1].reason?.message || "Live Buffett Indicator unavailable",
          },
    vix: entries[2].status === "fulfilled" ? entries[2].value : fallback("Yahoo Finance VIX", entries[2]),
  };
}

module.exports = async function handler(request, response) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");

  try {
    const cacheAge = Date.now() - marketPulseCache.cachedAt;
    if (marketPulseCache.data && cacheAge < 60 * 60 * 1000) {
      response.status(200).send(JSON.stringify({ ...marketPulseCache.data, cached: true }));
      return;
    }
    const data = await fetchMarketPulse();
    marketPulseCache.data = data;
    marketPulseCache.cachedAt = Date.now();
    response.status(200).send(JSON.stringify(data));
  } catch (error) {
    if (marketPulseCache.data) {
      response.status(200).send(JSON.stringify({ ...marketPulseCache.data, cached: true, warning: error.message }));
      return;
    }
    response.status(502).send(JSON.stringify({ error: error.message }));
  }
};

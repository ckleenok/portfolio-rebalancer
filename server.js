const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const STATIC_ROOT = path.join(__dirname, "public");
const DATA_ROOT = path.join(__dirname, "data");
const ACTUAL_TRADES_FILE = path.join(DATA_ROOT, "actual-trades.json");
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1HM_Jxv6zQzr-O5Spt06uq2HTyX1yFTVju2jzVjneL5M/export?format=csv&gid=172728277";
const HISTORY_TICKERS = new Set(["GLD", "SCHD", "SPY", "QQQ"]);
const historyCache = new Map();
const marketPulseCache = { data: null, cachedAt: 0 };
const institutionalCache = { data: null, cachedAt: 0 };
let actualTradesMemoryRecord = null;
const INSTITUTIONS = [
  { name: "Berkshire Hathaway", cik: "1067983" },
  { name: "Bridgewater Associates", cik: "1350694" },
  { name: "BlackRock", cik: "2012383" },
];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

function loadLocalEnv() {
  const envPath = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return;
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]]) return;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    });
  } catch {
    // keep environment-only configuration
  }
}

loadLocalEnv();

function send(response, status, body, type = "text/plain; charset=utf-8") {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

function readActualTradesRecord() {
  try {
    if (!fs.existsSync(ACTUAL_TRADES_FILE)) return null;
    const raw = fs.readFileSync(ACTUAL_TRADES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeActualTradesRecord(payload) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.writeFileSync(ACTUAL_TRADES_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function currentYearMonth() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function normalizeActualTrades(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    GLD: Number(source.GLD) || 0,
    SCHD: Number(source.SCHD) || 0,
    SPY: Number(source.SPY) || 0,
    QQQ: Number(source.QQQ) || 0,
  };
}

function parseMonth(month) {
  const value = String(month || "");
  return /^\d{4}-\d{2}$/.test(value) ? value : currentYearMonth();
}

async function readKvActualTradesRecord() {
  const baseUrl = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!baseUrl || !token) return null;
  const response = await fetch(`${baseUrl}/get/portfolio:actual-trades`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`KV GET ${response.status}`);
  const payload = await response.json();
  if (!payload?.result) return null;
  try {
    return JSON.parse(payload.result);
  } catch {
    return null;
  }
}

async function writeKvActualTradesRecord(record) {
  const baseUrl = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!baseUrl || !token) return false;
  const value = encodeURIComponent(JSON.stringify(record));
  const response = await fetch(`${baseUrl}/set/portfolio:actual-trades/${value}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`KV SET ${response.status}`);
  return true;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk || "");
      if (body.length > 1024 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
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

function buildSecHeaders() {
  return {
    "user-agent": "portfolio-rebalancer/1.0 (contact: ckleenok@gmail.com)",
    accept: "application/json, text/plain, */*",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetries(url, responseType = "json", attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: buildSecHeaders() });
      if (!response.ok) {
        const retriable = response.status === 403 || response.status === 429 || response.status >= 500;
        if (retriable && attempt < attempts) {
          await sleep(300 * attempt);
          continue;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      return responseType === "text" ? response.text() : response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(300 * attempt);
      }
    }
  }
  throw lastError || new Error("Fetch failed");
}

async function fetchJson(url) {
  return fetchWithRetries(url, "json", 3);
}

async function fetchText(url) {
  return fetchWithRetries(url, "text", 3);
}

function parse13fInfoTable(xmlText) {
  const entries = [];
  const text = String(xmlText || "");
  const blocks =
    text.match(/<(?:\w+:)?infoTable\b[\s\S]*?<\/(?:\w+:)?infoTable>/gi) ||
    text.match(/<infotable\b[\s\S]*?<\/infotable>/gi) ||
    [];
  blocks.forEach((block) => {
    const issuer = (block.match(/<(?:\w+:)?nameOfIssuer>([\s\S]*?)<\/(?:\w+:)?nameOfIssuer>/i)?.[1] || "").trim();
    const valueRaw = (block.match(/<(?:\w+:)?value>([\s\S]*?)<\/(?:\w+:)?value>/i)?.[1] || "").trim();
    const sharesRaw = (block.match(/<(?:\w+:)?sshPrnamt>([\s\S]*?)<\/(?:\w+:)?sshPrnamt>/i)?.[1] || "").trim();
    const cusip = (block.match(/<(?:\w+:)?cusip>([\s\S]*?)<\/(?:\w+:)?cusip>/i)?.[1] || "").trim();
    const putCall = (block.match(/<(?:\w+:)?putCall>([\s\S]*?)<\/(?:\w+:)?putCall>/i)?.[1] || "").trim();
    const value = Number(valueRaw.replace(/[^\d.-]/g, ""));
    const shares = Number(sharesRaw.replace(/[^\d.-]/g, ""));
    if (!issuer || !Number.isFinite(value)) return;
    entries.push({
      issuer,
      value,
      shares: Number.isFinite(shares) ? shares : null,
      cusip,
      putCall,
    });
  });
  return entries;
}

function aggregateHoldingsByIssuer(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    if (String(row.putCall || "").trim()) return;
    const key = String(row.issuer || "").trim().toUpperCase();
    if (!key) return;
    const prev = map.get(key) || {
      issuer: String(row.issuer || "").trim(),
      value: 0,
      shares: 0,
      cusip: row.cusip || "",
      hasShares: false,
    };
    prev.value += Number(row.value) || 0;
    if (Number.isFinite(Number(row.shares))) {
      prev.shares += Number(row.shares);
      prev.hasShares = true;
    }
    map.set(key, prev);
  });
  return Array.from(map.values()).map((row) => ({
    issuer: row.issuer,
    value: row.value,
    shares: row.hasShares ? row.shares : null,
    cusip: row.cusip,
  }));
}

async function fetch13fByIndex({ cikPadded, recent, index }) {
  const forms = Array.isArray(recent.form) ? recent.form : [];
  const accessions = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
  const primaryDocs = Array.isArray(recent.primaryDocument) ? recent.primaryDocument : [];
  const reportDates = Array.isArray(recent.reportDate) ? recent.reportDate : [];
  const filingDates = Array.isArray(recent.filingDate) ? recent.filingDate : [];
  const accession = accessions[index];
  const accessionNoDash = String(accession || "").replace(/-/g, "");
  const cikNoPad = String(Number(cikPadded));
  const base = `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${accessionNoDash}`;
  try {
    const directInfoTable = await fetchText(`${base}/infotable.xml`);
    const directParsed = parse13fInfoTable(directInfoTable);
    if (directParsed.length > 0) {
      return {
        holdings: directParsed,
        form: forms[index],
        accession,
        reportDate: reportDates[index] || null,
        filingDate: filingDates[index] || null,
      };
    }
  } catch {
    // fallback to index-based file discovery below
  }
  const indexJson = await fetchJson(`${base}/index.json`);
  const files = Array.isArray(indexJson?.directory?.item) ? indexJson.directory.item : [];
  let xmlName =
    files.find((item) => /infotable.*\.(xml|txt)$/i.test(item?.name || ""))?.name ||
    files.find((item) => /\.(xml|txt)$/i.test(item?.name || ""))?.name ||
    null;
  if (!xmlName) {
    xmlName = String(primaryDocs[index] || "");
  }
  if (!xmlName) throw new Error("No XML/TXT info table found");
  const xmlText = await fetchText(`${base}/${xmlName}`);
  const parsed = parse13fInfoTable(xmlText);
  if (parsed.length === 0) throw new Error("Unable to parse holdings");
  return {
    holdings: parsed,
    form: forms[index],
    accession,
    reportDate: reportDates[index] || null,
    filingDate: filingDates[index] || null,
  };
}

async function fetchInstitutionTopHoldings({ name, cik }) {
  const cikPadded = String(cik).padStart(10, "0");
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPadded}.json`;
  const submissions = await fetchJson(submissionsUrl);
  const recent = submissions?.filings?.recent || {};
  const forms = Array.isArray(recent.form) ? recent.form : [];
  const filingIndexes = forms
    .map((form, index) => ({ form: String(form || ""), index }))
    .filter((row) => row.form.startsWith("13F-HR"))
    .map((row) => row.index);
  if (filingIndexes.length === 0) throw new Error("No 13F-HR filing found");

  const currentFiling = await fetch13fByIndex({ cikPadded, recent, index: filingIndexes[0] });
  let previousFiling = null;
  if (filingIndexes.length > 1) {
    try {
      previousFiling = await fetch13fByIndex({ cikPadded, recent, index: filingIndexes[1] });
    } catch {
      previousFiling = null;
    }
  }

  const aggregatedCurrent = aggregateHoldingsByIssuer(currentFiling.holdings);
  const aggregatedPrevious = aggregateHoldingsByIssuer(previousFiling?.holdings || []);
  const previousMap = new Map(aggregatedPrevious.map((row) => [String(row.issuer || "").toUpperCase(), Number(row.value)]));

  const top5 = aggregatedCurrent
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .map((row) => ({
      issuer: row.issuer,
      valueUsdM: row.value / 1000,
      prevValueUsdM: Number.isFinite(previousMap.get(String(row.issuer || "").toUpperCase()))
        ? previousMap.get(String(row.issuer || "").toUpperCase()) / 1000
        : null,
      deltaPct:
        Number.isFinite(previousMap.get(String(row.issuer || "").toUpperCase())) &&
        previousMap.get(String(row.issuer || "").toUpperCase()) > 0
          ? row.value / previousMap.get(String(row.issuer || "").toUpperCase()) - 1
          : null,
      shares: row.shares,
      cusip: row.cusip,
    }));
  return {
    institution: name,
    cik: cikPadded,
    form: currentFiling.form,
    accession: currentFiling.accession,
    reportDate: currentFiling.reportDate,
    filingDate: currentFiling.filingDate,
    previousReportDate: previousFiling?.reportDate || null,
    latestUnderCik: true,
    top5,
  };
}

async function fetchInstitutionalHoldings() {
  const rows = [];
  for (const institution of INSTITUTIONS) {
    try {
      rows.push(await fetchInstitutionTopHoldings(institution));
    } catch (error) {
      rows.push({
        institution: institution.name,
        cik: String(institution.cik).padStart(10, "0"),
        error: error.message,
        top5: [],
      });
    }
  }
  return { asOf: new Date().toISOString(), institutions: rows, source: "SEC EDGAR 13F-HR" };
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

const TRANSACTION_RECORD_SUPABASE_URL =
  process.env.TRANSACTION_RECORD_SUPABASE_URL || "https://gicmktddjxjqzxojkwtf.supabase.co";
const TRANSACTION_RECORD_SUPABASE_KEY =
  process.env.TRANSACTION_RECORD_SUPABASE_KEY || "sb_publishable_uvd-5R9n45gwlSiGdUfCSg_3ruaOIyf";

// Korean fund name -> US ticker (category tag, mirrors transaction-record/dashboard/src/config/securityMappings.js)
const SECURITY_TICKER_MAP = {
  "ACE KRX금현물": "GLD",
  "TIGER 미국테크TOP10 INDXX": "QQQ",
  "KODEX 미국S&P500": "SPY",
  "KODEX 미국나스닥100": "QQQ",
  "KODEX 미국AI반도체TOP3플러스": "QQQ",
  "TIGER 구글밸류체인": "QQQ",
  "TIGER 미국배당다우존스": "SCHD",
};

function actualTradesSyncCutoffDate(now) {
  const day = now.getUTCDate();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const cutoff = day >= 26 ? new Date(Date.UTC(year, month, 26)) : new Date(Date.UTC(year, month - 1, 26));
  return cutoff.toISOString().slice(0, 10);
}

async function fetchActualTradesSync() {
  const from = actualTradesSyncCutoffDate(new Date());
  const to = new Date().toISOString().slice(0, 10);

  const url = new URL(`${TRANSACTION_RECORD_SUPABASE_URL}/rest/v1/trade_orders`);
  url.searchParams.set("select", "trade_date,security_name,side,status,quantity,unit_price");
  url.searchParams.set("trade_date", `gte.${from}`);
  url.searchParams.set("status", "eq.completed");

  const supaResponse = await fetch(url, {
    headers: {
      apikey: TRANSACTION_RECORD_SUPABASE_KEY,
      authorization: `Bearer ${TRANSACTION_RECORD_SUPABASE_KEY}`,
    },
  });
  if (!supaResponse.ok) throw new Error(`Supabase ${supaResponse.status}`);
  const rows = await supaResponse.json();

  const tickerTotals = {};
  for (const row of rows) {
    const ticker = SECURITY_TICKER_MAP[row.security_name];
    if (!ticker) continue;
    const amountKrw = Number(row.quantity || 0) * Number(row.unit_price || 0);
    const signedAmount = row.side === "sell" ? -amountKrw : amountKrw;
    tickerTotals[ticker] = (tickerTotals[ticker] || 0) + signedAmount;
  }

  const tickers = Object.fromEntries(
    Object.entries(tickerTotals).map(([ticker, krw]) => [ticker, Math.round(krw / 10000)]),
  );

  return { from, to, tickers };
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

  if (requestUrl.pathname === "/api/institutional-holdings") {
    try {
      const cacheAge = Date.now() - institutionalCache.cachedAt;
      if (institutionalCache.data && cacheAge < 6 * 60 * 60 * 1000) {
        send(response, 200, JSON.stringify({ ...institutionalCache.data, cached: true }), "application/json; charset=utf-8");
        return;
      }
      const data = await fetchInstitutionalHoldings();
      const hasErrors = (data.institutions || []).some((row) => row.error);
      if (!hasErrors) {
        institutionalCache.data = data;
        institutionalCache.cachedAt = Date.now();
      } else {
        institutionalCache.data = null;
        institutionalCache.cachedAt = 0;
      }
      send(response, 200, JSON.stringify(data), "application/json; charset=utf-8");
    } catch (error) {
      if (institutionalCache.data) {
        send(
          response,
          200,
          JSON.stringify({ ...institutionalCache.data, cached: true, warning: error.message }),
          "application/json; charset=utf-8",
        );
        return;
      }
      send(response, 502, JSON.stringify({ error: error.message }), "application/json; charset=utf-8");
    }
    return;
  }

  if (requestUrl.pathname === "/api/actual-trades-sync") {
    if (request.method !== "GET") {
      send(response, 405, JSON.stringify({ error: "Method not allowed" }), "application/json; charset=utf-8");
      return;
    }
    try {
      const result = await fetchActualTradesSync();
      send(response, 200, JSON.stringify(result), "application/json; charset=utf-8");
    } catch (error) {
      send(
        response,
        200,
        JSON.stringify({ from: "", to: "", tickers: {}, warning: error.message }),
        "application/json; charset=utf-8",
      );
    }
    return;
  }

  if (requestUrl.pathname === "/api/actual-trades") {
    if (request.method === "GET") {
      let saved = null;
      let storage = "none";
      try {
        const kv = await readKvActualTradesRecord();
        if (kv) {
          saved = kv;
          storage = "kv";
        }
      } catch {
        // ignore and fall back
      }
      if (!saved) {
        saved = actualTradesMemoryRecord || readActualTradesRecord();
        storage = saved ? "tmp" : "none";
      }
      send(
        response,
        200,
        JSON.stringify(
          saved
            ? { ...saved, storage }
            : {
                month: "",
                trades: { GLD: 0, SCHD: 0, SPY: 0, QQQ: 0 },
                manualTrades: { GLD: 0, SCHD: 0, SPY: 0, QQQ: 0 },
                updatedAt: null,
                storage: process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN ? "kv" : "none",
              },
        ),
        "application/json; charset=utf-8",
      );
      return;
    }

    if (request.method === "POST") {
      try {
        const payload = await readJsonBody(request);
        const month = parseMonth(payload?.month);
        const trades = normalizeActualTrades(payload?.trades);
        const manualTrades = normalizeActualTrades(payload?.manualTrades);
        const record = {
          month,
          trades,
          manualTrades,
          updatedAt: new Date().toISOString(),
        };
        let storage = "tmp";
        try {
          const kvSaved = await writeKvActualTradesRecord(record);
          if (kvSaved) {
            storage = "kv";
          } else {
            actualTradesMemoryRecord = record;
          }
        } catch {
          actualTradesMemoryRecord = record;
          try {
            writeActualTradesRecord(record);
          } catch {
            // ignore fs failure on serverless
          }
        }
        send(response, 200, JSON.stringify({ ...record, storage }), "application/json; charset=utf-8");
      } catch (error) {
        send(response, 400, JSON.stringify({ error: error.message }), "application/json; charset=utf-8");
      }
      return;
    }

    send(response, 405, JSON.stringify({ error: "Method not allowed" }), "application/json; charset=utf-8");
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

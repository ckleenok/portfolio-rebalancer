const fs = require("fs");
const path = require("path");

const TMP_FILE = "/tmp/portfolio-rebalancer-actual-trades.json";
const TICKERS = ["GLD", "SCHD", "SPY", "QQQ"];

function normalizeTrades(input) {
  const source = input && typeof input === "object" ? input : {};
  return Object.fromEntries(TICKERS.map((ticker) => [ticker, Number(source[ticker]) || 0]));
}

function parseMonth(month) {
  const value = String(month || "");
  return /^\d{4}-\d{2}$/.test(value) ? value : null;
}

function currentYearMonth() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function readTmpRecord() {
  try {
    if (!fs.existsSync(TMP_FILE)) return null;
    const raw = fs.readFileSync(TMP_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeTmpRecord(record) {
  fs.writeFileSync(TMP_FILE, JSON.stringify(record, null, 2), "utf8");
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk || "");
      if (body.length > 1024 * 1024) reject(new Error("Payload too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function parseRequestBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") {
    const text = request.body.trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  const raw = await readRawBody(request);
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function readKvRecord() {
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

async function writeKvRecord(record) {
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

module.exports = async function handler(request, response) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");

  if (request.method === "GET") {
    try {
      const kv = await readKvRecord();
      const saved = kv || readTmpRecord();
      response.status(200).send(
        JSON.stringify(
          saved || {
            month: "",
            trades: { GLD: 0, SCHD: 0, SPY: 0, QQQ: 0 },
            updatedAt: null,
          },
        ),
      );
    } catch (error) {
      response.status(200).send(
        JSON.stringify({
          month: "",
          trades: { GLD: 0, SCHD: 0, SPY: 0, QQQ: 0 },
          updatedAt: null,
          warning: error.message,
        }),
      );
    }
    return;
  }

  if (request.method === "POST") {
    try {
      const body = await parseRequestBody(request);
      const month = parseMonth(body?.month) || currentYearMonth();

      const record = {
        month,
        trades: normalizeTrades(body?.trades),
        updatedAt: new Date().toISOString(),
      };

      let storage = "tmp";
      try {
        const kvSaved = await writeKvRecord(record);
        if (kvSaved) storage = "kv";
      } catch {
        writeTmpRecord(record);
      }

      response.status(200).send(JSON.stringify({ ...record, storage }));
    } catch (error) {
      response.status(400).send(JSON.stringify({ error: error.message }));
    }
    return;
  }

  response.status(405).send(JSON.stringify({ error: "Method not allowed" }));
};

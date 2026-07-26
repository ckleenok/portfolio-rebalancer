const SUPABASE_URL = process.env.TRANSACTION_RECORD_SUPABASE_URL || "https://gicmktddjxjqzxojkwtf.supabase.co";
const SUPABASE_KEY =
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

const TRADE_TIME_ZONE = process.env.ACTUAL_TRADES_TIME_ZONE || "Asia/Seoul";

function dateParts(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TRADE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
  };
}

function dateText(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function cycleBounds(now) {
  const { year, month, day } = dateParts(now);
  const cutoff = day >= 26 ? new Date(Date.UTC(year, month - 1, 26)) : new Date(Date.UTC(year, month - 2, 26));
  return {
    from: cutoff.toISOString().slice(0, 10),
    to: dateText(year, month, day),
  };
}

module.exports = async function handler(request, response) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");

  if (request.method !== "GET") {
    response.status(405).send(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const { from, to } = cycleBounds(new Date());

  try {
    const url = new URL(`${SUPABASE_URL}/rest/v1/trade_orders`);
    url.searchParams.set("select", "trade_date,security_name,side,status,quantity,unit_price");
    url.searchParams.append("trade_date", `gte.${from}`);
    url.searchParams.append("trade_date", `lte.${to}`);
    url.searchParams.set("status", "eq.completed");

    const supaResponse = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
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

    response.status(200).send(JSON.stringify({ from, to, tickers }));
  } catch (error) {
    response.status(200).send(JSON.stringify({ from, to, tickers: {}, warning: error.message }));
  }
};

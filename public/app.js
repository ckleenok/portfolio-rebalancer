(function () {
  const TARGETS = [
    { ticker: "GLD", target: 0.41, current: 7730 },
    { ticker: "SCHD", target: 0.07, current: 3289 },
    { ticker: "SPY", target: 0.22, current: 5918 },
    { ticker: "QQQ", target: 0.30, current: 6431 },
  ];

  const SHEET_CSV_URL =
    typeof location !== "undefined" && location.protocol.startsWith("http")
      ? "/api/sheet"
      : "https://docs.google.com/spreadsheets/d/1HM_Jxv6zQzr-O5Spt06uq2HTyX1yFTVju2jzVjneL5M/export?format=csv&gid=172728277";
  const HISTORY_URL =
    typeof location !== "undefined" && location.protocol.startsWith("http") ? "/api/history" : null;
  const MARKET_PULSE_URL =
    typeof location !== "undefined" && location.protocol.startsWith("http") ? "/api/market-pulse" : null;
  const INSTITUTIONAL_HOLDINGS_URL =
    typeof location !== "undefined" && location.protocol.startsWith("http") ? "/api/institutional-holdings" : null;
  const ACTUAL_TRADES_URL =
    typeof location !== "undefined" && location.protocol.startsWith("http") ? "/api/actual-trades" : null;

  const state = {
    contribution: 400,
    planMonths: 6,
    trendWindow: 30,
    recentCurrentTotals: [],
    assets: TARGETS.map((asset) => ({ ...asset })),
    draftTargets: Object.fromEntries(TARGETS.map((asset) => [asset.ticker, asset.target * 100])),
    trend30: {},
    expectedReturns: {
      GLD: 0.04,
      SCHD: 0.07,
      SPY: 0.08,
      QQQ: 0.1,
    },
    actualTrades: {},
  };

  const ASSET_COLORS = {
    GLD: "#d09b2c",
    SCHD: "#147c72",
    SPY: "#2f6fbb",
    QQQ: "#7b5d3a",
  };
  const TARGET_STORAGE_KEY = "portfolio-rebalancer-targets-v1";
  const CALENDAR_VISIBLE_STORAGE_KEY = "portfolio-rebalancer-calendar-visible-v1";
  const INSTITUTIONAL_VISIBLE_STORAGE_KEY = "portfolio-rebalancer-institutional-visible-v1";
  const PLAN_MONTHS_STORAGE_KEY = "portfolio-rebalancer-plan-months-v1";
  const ACTUAL_TRADES_STORAGE_KEY = "portfolio-rebalancer-actual-trades-v1";
  const ACTUAL_TRADES_MONTH_KEY = "portfolio-rebalancer-actual-trades-month-v1";
  const ACTUAL_TRADE_TICKERS = ["GLD", "SCHD", "SPY", "QQQ"];

  function parseMoney(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const cleaned = String(value || "")
      .replace(/[^\d.-]/g, "")
      .trim();
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeAssetsByTarget(assets) {
    const totalTarget = assets.reduce((sum, asset) => sum + (Number.isFinite(asset.target) ? asset.target : 0), 0);
    if (totalTarget <= 0) {
      const equalWeight = 1 / Math.max(assets.length, 1);
      return assets.map((asset) => ({ ...asset, target: equalWeight }));
    }
    return assets.map((asset) => ({ ...asset, target: asset.target / totalTarget }));
  }

  function formatMoney(value) {
    return `${Math.round(value).toLocaleString("ko-KR")}만원`;
  }

  function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
  }

  function getContrastTextColor(hex) {
    const normalized = String(hex || "").replace("#", "");
    if (normalized.length !== 6) return "#111111";
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return "#111111";
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance < 0.55 ? "#ffffff" : "#111111";
  }

  function formatPulsePercent(value) {
    if (!Number.isFinite(value)) return "--";
    return `${value.toFixed(1)}%`;
  }

  function formatShortDate(dateText) {
    const parsed = new Date(`${String(dateText || "").slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return "--";
    return `${parsed.getUTCMonth() + 1}/${parsed.getUTCDate()}`;
  }

  function buildMiniTrendModel(points, width = 280, height = 42, pad = 3) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const values = points.map((point) => Number(point?.value)).filter((value) => Number.isFinite(value));
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    const coords = values.map((value, index) => {
      const x = pad + (index / Math.max(values.length - 1, 1)) * (width - pad * 2);
      const y = pad + ((max - value) / span) * (height - pad * 2);
      return { x, y, value };
    });
    const avgY = pad + ((max - avg) / span) * (height - pad * 2);
    return { coords, avg, avgY, width, pad };
  }

  function renderPulseTrend(svgId, avgId, points, color, axisIds) {
    const svg = document.getElementById(svgId);
    const avgLabel = document.getElementById(avgId);
    const startLabel = axisIds?.start ? document.getElementById(axisIds.start) : null;
    const midLabel = axisIds?.mid ? document.getElementById(axisIds.mid) : null;
    const endLabel = axisIds?.end ? document.getElementById(axisIds.end) : null;
    if (!svg || !avgLabel) return;
    const model = buildMiniTrendModel(points);
    if (!model) {
      svg.innerHTML = "";
      avgLabel.textContent = "60-day avg --";
      if (startLabel) startLabel.textContent = "--";
      if (midLabel) midLabel.textContent = "--";
      if (endLabel) endLabel.textContent = "--";
      return;
    }
    const { coords, avg, avgY, width, pad } = model;
    const pathData = coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
    const avgLine = `<line x1="${pad}" y1="${avgY.toFixed(1)}" x2="${(width - pad).toFixed(1)}" y2="${avgY.toFixed(1)}" stroke="#8a95a6" stroke-width="1.1" stroke-dasharray="4 3"></line>`;
    svg.innerHTML = `${avgLine}<path d="${pathData}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"></path>`;
    avgLabel.textContent = `60-day avg ${avg.toFixed(2)}`;
    if (Array.isArray(points) && points.length > 0) {
      const midIndex = Math.floor((points.length - 1) / 2);
      if (startLabel) startLabel.textContent = formatShortDate(points[0]?.date);
      if (midLabel) midLabel.textContent = formatShortDate(points[midIndex]?.date);
      if (endLabel) endLabel.textContent = formatShortDate(points[points.length - 1]?.date);
    }
  }

  function calculateExpectedCagr(assets, expectedReturns = state.expectedReturns) {
    const total = assets.reduce((sum, asset) => sum + asset.current, 0);
    if (total <= 0) return 0;
    return assets.reduce((sum, asset) => {
      const weight = asset.current / total;
      return sum + weight * (expectedReturns[asset.ticker] ?? 0);
    }, 0);
  }

  function calculateTargetExpectedCagr(assets, expectedReturns = state.expectedReturns) {
    return assets.reduce((sum, asset) => sum + asset.target * (expectedReturns[asset.ticker] ?? 0), 0);
  }

  function calculateMovingAverageCagr(monthlyCloses, months = 120) {
    const closes = monthlyCloses
      .filter((row) => Number.isFinite(row.close) && row.close > 0)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-(months + 1));
    const returns = [];

    for (let index = 1; index < closes.length; index += 1) {
      returns.push(closes[index].close / closes[index - 1].close - 1);
    }

    if (returns.length === 0) return null;

    const averageMonthlyReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    return {
      cagr: Math.pow(1 + averageMonthlyReturn, 12) - 1,
      monthsUsed: returns.length,
      startDate: closes[0].date,
      endDate: closes[closes.length - 1].date,
    };
  }

  function buildSixMonthPlan(assets, contribution, planMonths = state.planMonths) {
    const currentTotal = assets.reduce((sum, asset) => sum + asset.current, 0);
    const finalTotal = currentTotal + contribution * planMonths;
    const finalTargets = assets.map((asset) => asset.target * finalTotal);
    let previousAmounts = assets.map((asset) => asset.current);

    return Array.from({ length: planMonths }, (_, index) => {
      const month = index + 1;
      const beforeTotal = currentTotal + contribution * index;
      const afterTotal = currentTotal + contribution * month;

      const rows = assets.map((asset, assetIndex) => {
        const targetAmount = asset.current + (finalTargets[assetIndex] - asset.current) * (month / planMonths);
        const trade = targetAmount - previousAmounts[assetIndex];
        const after = targetAmount;

        return {
          ...asset,
          trade,
          buy: Math.max(0, trade),
          sell: Math.max(0, -trade),
          after,
          current: previousAmounts[assetIndex],
          currentWeight: beforeTotal > 0 ? previousAmounts[assetIndex] / beforeTotal : 0,
          afterWeight: afterTotal > 0 ? after / afterTotal : 0,
          gapAfter: afterTotal > 0 ? after / afterTotal - asset.target : 0,
        };
      });

      previousAmounts = rows.map((row) => row.after);
      const totalBuy = rows.reduce((sum, row) => sum + row.buy, 0);
      const totalSell = rows.reduce((sum, row) => sum + row.sell, 0);
      const maxGap = Math.max(...rows.map((row) => Math.abs(row.gapAfter)));

      return {
        month,
        rows,
        total: afterTotal,
        totalBuy,
        totalSell,
        maxGap,
        reached: month === planMonths,
      };
    });
  }

  function allocateBuyOnly(assets, contribution) {
    const currentTotal = assets.reduce((sum, asset) => sum + asset.current, 0);
    const plan = buildSixMonthPlan(assets, contribution, state.planMonths);
    const firstMonth = plan[0];
    return {
      currentTotal,
      futureTotal: firstMonth.total,
      rows: firstMonth.rows,
      allocated: firstMonth.totalBuy,
      unallocated: 0,
      totalSell: firstMonth.totalSell,
      plan,
    };
  }

  function simulateRebalancing(assets, contribution, options = {}) {
    return buildSixMonthPlan(assets, contribution, options.planMonths ?? state.planMonths);
  }

  function splitCsvLine(line) {
    const cells = [];
    let cell = "";
    let quoted = false;

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (char === '"' && quoted && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += char;
      }
    }

    cells.push(cell.trim());
    return cells;
  }

  function extractRecentCurrentTotals(row) {
    if (!Array.isArray(row)) return [];
    const values = [];
    for (let index = 14; index <= 20; index += 1) {
      const parsed = parseMoney(row[index]);
      if (parsed > 0) values.push(parsed);
    }
    return values.slice(-6);
  }

  function normalizeCell(value) {
    return String(value || "")
      .replace(/^\uFEFF/, "")
      .trim();
  }

  function parseLatestSheetRow(csvText) {
    const lines = String(csvText || "")
      .split(/\r?\n/)
      .map((line) => splitCsvLine(line))
      .filter((row) => row.length >= 5);

    const header = lines.find((row) => {
      const normalized = row.map(normalizeCell);
      const tickers = ["DATE", "SPY", "QQQ", "SCHD", "GLD"];
      return tickers.every((ticker) => normalized.includes(ticker));
    });
    const normalizedHeader = header ? header.map(normalizeCell) : null;
    const dateColumn = normalizedHeader?.indexOf("DATE") ?? -1;
    const columns =
      dateColumn >= 0
        ? {
            date: dateColumn,
            SPY: normalizedHeader.indexOf("SPY", dateColumn),
            QQQ: normalizedHeader.indexOf("QQQ", dateColumn),
            SCHD: normalizedHeader.indexOf("SCHD", dateColumn),
            GLD: normalizedHeader.indexOf("GLD", dateColumn),
          }
        : null;

    let latest = null;
    let latestRawRow = null;

    if (columns && Object.values(columns).every((index) => index >= 0)) {
      const totalsHistory = [];
      for (const row of lines) {
        const date = normalizeCell(row[columns.date]);
        const looksLikeDate = /^\d{2,4}\s*[.\/-]\s*\d{1,2}\s*[.\/-]?\s*\d{0,2}\.?$/.test(date);
        const values = [row[columns.SPY], row[columns.QQQ], row[columns.SCHD], row[columns.GLD]].map(parseMoney);
        if (looksLikeDate && values.every((value) => value > 0)) {
          latest = { date, SPY: values[0], QQQ: values[1], SCHD: values[2], GLD: values[3] };
          latestRawRow = row;
          totalsHistory.push(values.reduce((sum, value) => sum + value, 0));
        }
      }
      const recentCurrentTotals =
        totalsHistory.length > 0
          ? totalsHistory.slice(-6)
          : findRecentTotalsFromSheet(lines);
      return latest ? { ...latest, recentCurrentTotals } : null;
    }

    for (const row of lines) {
      for (let index = 0; index <= row.length - 5; index += 1) {
        const [date, spy, qqq, schd, gld] = row.slice(index, index + 5);
        const looksLikeDate = /^\d{2,4}\s*[.\/-]\s*\d{1,2}\s*[.\/-]?\s*\d{0,2}\.?$/.test(date);
        const values = [spy, qqq, schd, gld].map(parseMoney);
        if (looksLikeDate && values.every((value) => value > 0)) {
          latest = { date, SPY: values[0], QQQ: values[1], SCHD: values[2], GLD: values[3] };
          latestRawRow = row;
        }
      }
    }

    const recentCurrentTotals = findRecentTotalsFromSheet(lines);
    return latest ? { ...latest, recentCurrentTotals } : null;
  }

  function findRecentTotalsFromSheet(lines) {
    const totals = [];
    for (const row of lines) {
      const date = normalizeCell(row[16]);
      const looksLikeDate = /^\d{2,4}\s*[.\/-]\s*\d{1,2}\s*[.\/-]?\s*\d{0,2}\.?$/.test(date);
      if (!looksLikeDate) continue;
      const values = [row[17], row[18], row[19], row[20]].map(parseMoney);
      if (values.every((value) => value > 0)) {
        totals.push(values.reduce((sum, value) => sum + value, 0));
      }
    }
    return totals.slice(-6);
  }

  function renderInputs() {
    const container = document.getElementById("assetInputs");
    if (!container) return;
    container.innerHTML = "";

    state.assets.forEach((asset) => {
      const label = document.createElement("label");
      label.className = "asset-card";
      label.innerHTML = `
        <span class="ticker">${asset.ticker}</span>
        <div class="input-unit">
          <input data-ticker="${asset.ticker}" type="text" inputmode="numeric" value="${Math.round(asset.current).toLocaleString("ko-KR")}" aria-label="${asset.ticker} 현재 보유금액" />
          <span>만원</span>
        </div>
        <span class="target-pill">${formatPercent(asset.target)}</span>
      `;
      container.appendChild(label);
    });
  }

  function renderHoldingsChart() {
    const donut = document.getElementById("holdingsDonut");
    const donutTotal = document.getElementById("holdingsDonutTotal");
    const legend = document.getElementById("holdingsLegend");
    if (!donut || !donutTotal || !legend) return;

    const total = state.assets.reduce((sum, asset) => sum + asset.current, 0);
    let cursor = 0;
    const segments = state.assets.map((asset) => {
      const percent = total > 0 ? asset.current / total : 0;
      const start = cursor;
      cursor += percent * 100;
      const color = ASSET_COLORS[asset.ticker] || "#8190a3";
      return `${color} ${start}% ${cursor}%`;
    });

    donut.style.background =
      total > 0 ? `conic-gradient(${segments.join(", ")})` : "conic-gradient(#e8edf2 0% 100%)";
    donutTotal.textContent = `${Math.round(total).toLocaleString("ko-KR")}`;

    let sliceLabels = donut.querySelector(".donut-slice-labels");
    if (!sliceLabels) {
      sliceLabels = document.createElement("div");
      sliceLabels.className = "donut-slice-labels";
      donut.appendChild(sliceLabels);
    }
    sliceLabels.innerHTML = "";

    if (total > 0) {
      const center = 75;
      const baseRadius = 58;
      let angleCursor = -90;
      state.assets.forEach((asset) => {
        const percent = total > 0 ? asset.current / total : 0;
        const sweep = percent * 360;
        const midAngle = angleCursor + sweep / 2;
        const radians = (midAngle * Math.PI) / 180;
        const radius = percent < 0.18 ? baseRadius + 3 : baseRadius;
        const x = center + Math.cos(radians) * radius;
        const y = center + Math.sin(radians) * radius;
        const label = document.createElement("span");
        label.className = "donut-slice-label";
        label.textContent = `${(percent * 100).toFixed(1)}%`;
        label.style.color = "#111111";
        label.style.left = `${x}px`;
        label.style.top = `${y}px`;
        sliceLabels.appendChild(label);
        angleCursor += sweep;
      });
    }

    legend.innerHTML = "";
    state.assets.forEach((asset) => {
      const row = document.createElement("div");
      row.className = "legend-row";
      row.innerHTML = `
          <span class="legend-swatch" style="background: ${ASSET_COLORS[asset.ticker] || "#8190a3"}"></span>
          <strong>${asset.ticker}</strong>
          <span class="legend-value">${formatMoney(asset.current)}</span>
        `;
      legend.appendChild(row);
    });
  }

  function renderCurrentMetric(totalFromAssets) {
    const metric = document.getElementById("currentMetric");
    const history = document.getElementById("currentHistory");
    if (!metric || !history) return;

    const values =
      state.recentCurrentTotals.length > 0 ? state.recentCurrentTotals.slice(-6) : [Math.max(0, totalFromAssets)];
    metric.textContent = formatMoney(totalFromAssets);
    const maxValue = Math.max(...values, 1);
    history.innerHTML = "";
    history.setAttribute("aria-label", "현재 평가금 최근 6개 값");

    values.forEach((value, index) => {
      const bar = document.createElement("div");
      bar.className = `history-bar ${index === values.length - 1 ? "latest" : ""}`.trim();
      bar.style.height = `${Math.max(14, Math.round((value / maxValue) * 100))}%`;
      const prev = index > 0 ? values[index - 1] : null;
      const delta = Number.isFinite(prev) ? value - prev : null;
      const deltaLabel =
        delta === null ? "-" : `${delta >= 0 ? "+" : "-"}${Math.abs(Math.round(delta)).toLocaleString("ko-KR")}`;
      bar.title = `${formatMoney(value)} / 직전 대비 ${deltaLabel}만원`;
      const label = document.createElement("span");
      label.className = "history-delta";
      label.textContent = deltaLabel;
      bar.appendChild(label);
      history.appendChild(bar);
    });
  }

  function formatUsdMillions(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return `$${Math.round(n).toLocaleString("en-US")}M`;
  }

  function formatDeltaPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "N/A";
    return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
  }

  function daysSince(dateText) {
    const d = new Date(`${String(dateText || "").slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    const now = Date.now();
    return Math.floor((now - d.getTime()) / (24 * 60 * 60 * 1000));
  }

  function render() {
    const normalizedAssets = normalizeAssetsByTarget(state.assets);
    const result = allocateBuyOnly(normalizedAssets, state.contribution);
    const maxTrade = Math.max(...result.rows.map((row) => Math.abs(row.trade)), 1);

    syncContributionInputs();
    renderHoldingsChart();
    syncTargetInputs();
    renderTargetSummary();
    renderCurrentMetric(result.currentTotal);
    document.getElementById("shortMetric").textContent = `${state.planMonths}개월`;
    const tradeHorizonText = document.getElementById("tradeHorizonText");
    if (tradeHorizonText) {
      tradeHorizonText.textContent = `${state.planMonths}개월에 걸쳐 점진 조정`;
    }

    const planMonthsInput = document.getElementById("planMonthsInput");
    if (planMonthsInput && document.activeElement !== planMonthsInput) {
      planMonthsInput.value = String(state.planMonths);
    }

    const buyList = document.getElementById("buyList");
    buyList.innerHTML = "";
    result.rows
      .slice()
      .sort((a, b) => Math.abs(b.trade) - Math.abs(a.trade))
      .forEach((row) => {
        const isSell = row.trade < 0;
        const actualTrade = Number(state.actualTrades[row.ticker] ?? 0);
        const card = document.createElement("div");
        card.className = `buy-card ${isSell ? "sell-card" : ""}`;
        card.innerHTML = `
          <span class="ticker">${row.ticker}</span>
          <div>
            <div class="bar-track"><div class="bar-fill ${isSell ? "sell-fill" : ""}" style="width: ${(Math.abs(row.trade) / maxTrade) * 100}%"></div></div>
            <div class="buy-note">${isSell ? "축소 후" : "매수 후"} ${formatPercent(row.afterWeight)}<br>목표 ${formatPercent(row.target)}</div>
            <label class="actual-trade-entry">
              <span>실제 조정</span>
              <input data-actual-ticker="${row.ticker}" type="text" inputmode="numeric" value="${Math.round(actualTrade).toLocaleString("ko-KR")}" />
              <em>만원</em>
            </label>
          </div>
          <strong>${isSell ? "-" : "+"}${formatMoney(Math.abs(row.trade))}</strong>
        `;
        buyList.appendChild(card);
      });
    bindActualTradeInputs(result);
    renderTradeSummary(result);

    const allocationRows = document.getElementById("allocationRows");
    allocationRows.innerHTML = "";
    result.rows.forEach((row) => {
      const beforeWidth = Math.min(row.currentWeight / 0.5, 1) * 100;
      const afterWidth = Math.min(row.afterWeight / 0.5, 1) * 100;
      const gapClass = row.gapAfter < -0.001 ? "negative" : "";
      const line = document.createElement("div");
      line.className = "allocation-row";
      line.innerHTML = `
        <strong>${row.ticker}</strong>
        <div class="dual-bars">
          <div class="bar-track"><div class="bar-fill before" style="width: ${beforeWidth}%"></div></div>
          <div class="bar-track"><div class="bar-fill after" style="width: ${afterWidth}%"></div></div>
        </div>
        <span class="hide-mobile">${formatPercent(row.currentWeight)}</span>
        <span>${formatPercent(row.afterWeight)}</span>
        <span class="${gapClass}">${formatPercent(row.gapAfter)}</span>
      `;
      allocationRows.appendChild(line);
    });

    renderSimulation();
    renderCagr();
    renderTrendPanel();
    renderWindowToggle();
  }

  function saveActualTrades() {
    try {
      const now = new Date();
      const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      localStorage.setItem(ACTUAL_TRADES_STORAGE_KEY, JSON.stringify(state.actualTrades));
      localStorage.setItem(ACTUAL_TRADES_MONTH_KEY, ym);
    } catch {
      // ignore storage errors
    }
  }

  function currentYearMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  function normalizeActualTrades(input) {
    return Object.fromEntries(ACTUAL_TRADE_TICKERS.map((ticker) => [ticker, parseMoney(input?.[ticker] ?? 0)]));
  }

  function loadSavedActualTrades() {
    try {
      const currentYm = currentYearMonth();
      const savedYm = localStorage.getItem(ACTUAL_TRADES_MONTH_KEY);
      if (savedYm !== currentYm) {
        state.actualTrades = Object.fromEntries(ACTUAL_TRADE_TICKERS.map((ticker) => [ticker, 0]));
        localStorage.setItem(ACTUAL_TRADES_STORAGE_KEY, JSON.stringify(state.actualTrades));
        localStorage.setItem(ACTUAL_TRADES_MONTH_KEY, currentYm);
        return;
      }
      const raw = localStorage.getItem(ACTUAL_TRADES_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      state.actualTrades = normalizeActualTrades(parsed);
    } catch {
      // ignore parse/storage errors
    }
  }

  async function loadActualTradesFromServer() {
    if (!ACTUAL_TRADES_URL) return;
    try {
      const response = await fetch(ACTUAL_TRADES_URL, { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      const storage = String(payload?.storage || "");
      if (storage && storage !== "kv") {
        const status = document.getElementById("actualTradesSaveStatus");
        if (status) status.textContent = "서버 영구저장 미연결: 현재 브라우저 값 사용";
        return;
      }
      const currentYm = currentYearMonth();
      const serverMonth = String(payload?.month || "");
      if (!serverMonth) return;
      if (serverMonth !== currentYm) {
        state.actualTrades = Object.fromEntries(ACTUAL_TRADE_TICKERS.map((ticker) => [ticker, 0]));
        saveActualTrades();
        render();
        return;
      }
      state.actualTrades = normalizeActualTrades(payload?.trades || {});
      saveActualTrades();
      render();
    } catch {
      // keep local fallback
    }
  }

  async function saveActualTradesToServer() {
    const status = document.getElementById("actualTradesSaveStatus");
    if (!ACTUAL_TRADES_URL) {
      if (status) status.textContent = "로컬 환경에서는 브라우저에만 저장됩니다.";
      return;
    }
    const payload = {
      month: currentYearMonth(),
      trades: normalizeActualTrades(state.actualTrades),
      updatedAt: new Date().toISOString(),
    };
    try {
      if (status) status.textContent = "저장 중...";
      const response = await fetch(ACTUAL_TRADES_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      let responsePayload = null;
      try {
        responsePayload = await response.clone().json();
      } catch {
        responsePayload = null;
      }
      if (!response.ok) {
        const params = new URLSearchParams({
          mode: "save",
          month: payload.month,
          GLD: String(payload.trades.GLD ?? 0),
          SCHD: String(payload.trades.SCHD ?? 0),
          SPY: String(payload.trades.SPY ?? 0),
          QQQ: String(payload.trades.QQQ ?? 0),
        });
        const fallback = await fetch(`${ACTUAL_TRADES_URL}?${params.toString()}`, { method: "GET" });
        if (!fallback.ok) throw new Error(`HTTP ${response.status}`);
        try {
          responsePayload = await fallback.clone().json();
        } catch {
          responsePayload = null;
        }
      }
      const storage = String(responsePayload?.storage || "");
      if (status) status.textContent = storage === "kv" ? "저장됨" : "저장됨 (현재 브라우저 위주)";
    } catch (error) {
      if (status) status.textContent = `저장 실패: ${error.message}`;
    }
  }

  function bindActualTradeInputs(result) {
    document.querySelectorAll("[data-actual-ticker]").forEach((input) => {
      input.addEventListener("input", (event) => {
        const ticker = event.target.dataset.actualTicker;
        state.actualTrades[ticker] = parseMoney(event.target.value);
        saveActualTrades();
        renderTradeSummary(result);
      });
    });
  }

  function renderTradeSummary(result) {
    const warning = document.getElementById("warningBox");
    if (!warning) return;
    const plannedBuy = result.rows.reduce((sum, row) => sum + Math.max(0, row.trade), 0);
    const plannedSell = result.rows.reduce((sum, row) => sum + Math.max(0, -row.trade), 0);
    const actualBuy = result.rows.reduce((sum, row) => sum + Math.max(0, Number(state.actualTrades[row.ticker] || 0)), 0);
    const actualSell = result.rows.reduce((sum, row) => sum + Math.max(0, -Number(state.actualTrades[row.ticker] || 0)), 0);
    warning.hidden = false;
    warning.textContent =
      `계획: 총 매수 ${formatMoney(plannedBuy)}, 총 축소 ${formatMoney(plannedSell)}, 순투입 ${formatMoney(state.contribution)} | ` +
      `실제: 총 매수 ${formatMoney(actualBuy)}, 총 축소 ${formatMoney(actualSell)}, 순투입 ${formatMoney(actualBuy - actualSell)}`;
  }

  function renderCagr() {
    const normalizedAssets = normalizeAssetsByTarget(state.assets);
    const result = allocateBuyOnly(normalizedAssets, state.contribution);
    const currentCagr = calculateExpectedCagr(normalizedAssets);
    const firstMonthAssets = result.rows.map((row) => ({
      ticker: row.ticker,
      target: row.target,
      current: row.after,
    }));
    const firstMonthCagr = calculateExpectedCagr(firstMonthAssets);
    const targetCagr = calculateTargetExpectedCagr(normalizedAssets);

    document.getElementById("currentCagr").textContent = formatPercent(currentCagr);
    document.getElementById("monthOneCagr").textContent = formatPercent(firstMonthCagr);
    document.getElementById("targetCagr").textContent = formatPercent(targetCagr);
    const topCurrent = document.getElementById("topCurrentCagr");
    const topMonthOne = document.getElementById("topMonthOneCagr");
    const topTarget = document.getElementById("topTargetCagr");
    if (topCurrent) topCurrent.textContent = formatPercent(currentCagr);
    if (topMonthOne) topMonthOne.textContent = formatPercent(firstMonthCagr);
    if (topTarget) topTarget.textContent = formatPercent(targetCagr);

    const currentTotal = normalizedAssets.reduce((sum, asset) => sum + asset.current, 0);
    const currentWeights = Object.fromEntries(
      normalizedAssets.map((asset) => [asset.ticker, currentTotal > 0 ? asset.current / currentTotal : 0]),
    );
    const targetWeights = Object.fromEntries(normalizedAssets.map((asset) => [asset.ticker, asset.target]));
    renderCagrTrend("currentCagrTrend", "currentCagrTrendMeta", buildPortfolioTrendSeries(currentWeights), "#147c72");
    renderCagrTrend("targetCagrTrend", "targetCagrTrendMeta", buildPortfolioTrendSeries(targetWeights), "#2f6fbb");

    const currentRisk = calculateRiskMetrics(buildPortfolioIndexSeries(currentWeights));
    const targetRisk = calculateRiskMetrics(buildPortfolioIndexSeries(targetWeights));
    const topCurrentMdd = document.getElementById("topCurrentMdd");
    const topCurrentSharpe = document.getElementById("topCurrentSharpe");
    const topTargetMdd = document.getElementById("topTargetMdd");
    const topTargetSharpe = document.getElementById("topTargetSharpe");
    if (topCurrentMdd) topCurrentMdd.textContent = `${(currentRisk.mdd * 100).toFixed(1)}%`;
    if (topCurrentSharpe) topCurrentSharpe.textContent = currentRisk.sharpe.toFixed(3);
    if (topTargetMdd) topTargetMdd.textContent = `${(targetRisk.mdd * 100).toFixed(1)}%`;
    if (topTargetSharpe) topTargetSharpe.textContent = targetRisk.sharpe.toFixed(3);
    renderCorrelationGrid();
  }

  function renderSimulation() {
    const normalizedAssets = normalizeAssetsByTarget(state.assets);
    const months = simulateRebalancing(normalizedAssets, state.contribution);
    const summary = document.getElementById("simulationSummary");
    const list = document.getElementById("simulationList");

    if (!summary || !list) return;

    summary.textContent = `${state.planMonths}개월차에 목표 비중 도달`;

    list.innerHTML = "";
    months.forEach((month) => {
      const item = document.createElement("details");
      item.className = "simulation-step";
      item.open = true;

      const trades = month.rows
        .filter((row) => Math.abs(row.trade) > 0.4)
        .sort((a, b) => Math.abs(b.trade) - Math.abs(a.trade))
        .map((row) => `${row.ticker} ${row.trade < 0 ? "축소" : "매수"} ${formatMoney(Math.abs(row.trade))}`)
        .join(" · ");

      const weights = month.rows
        .map((row) => `${row.ticker} ${formatPercent(row.afterWeight)}`)
        .join(" / ");

      item.innerHTML = `
        <summary>
          <strong>${month.month}개월차</strong>
          <span>${trades || "거래 없음"}</span>
          <em>최대 차이 ${(month.maxGap * 100).toFixed(2)}%p</em>
        </summary>
        <div class="simulation-detail">${weights}</div>
      `;
      list.appendChild(item);
    });
  }

  function applyLatestRow(row, sourceLabel) {
    if (!row) return false;
    state.assets = state.assets.map((asset) => ({ ...asset, current: row[asset.ticker] ?? asset.current }));
    state.recentCurrentTotals = Array.isArray(row.recentCurrentTotals) ? row.recentCurrentTotals.slice(-6) : [];
    renderInputs();
    bindAssetInputs();
    render();
    document.getElementById("sheetStatus").textContent = `${sourceLabel}: ${row.date}`;
    return true;
  }

  function bindAssetInputs() {
    document.querySelectorAll("[data-ticker]").forEach((input) => {
      input.addEventListener("input", (event) => {
        const ticker = event.target.dataset.ticker;
        const asset = state.assets.find((item) => item.ticker === ticker);
        if (asset) asset.current = parseMoney(event.target.value);
        render();
      });
    });
  }

  function syncContributionInputs() {
    const input = document.getElementById("contributionInput");
    if (input && document.activeElement !== input) {
      input.value = Math.round(state.contribution).toLocaleString("ko-KR");
    }
  }

  function updateContribution(value) {
    state.contribution = parseMoney(value);
    render();
  }

  function syncTargetInputs() {
    let totalPercent = 0;
    state.assets.forEach((asset) => {
      const draftValue = Number(state.draftTargets[asset.ticker] ?? asset.target * 100);
      totalPercent += Number.isFinite(draftValue) ? draftValue : 0;
      const input = document.getElementById(`target-${asset.ticker}`);
      if (input && document.activeElement !== input) {
        input.value = String(draftValue.toFixed(1).replace(/\.0$/, ""));
      }
    });
    const totalLabel = document.getElementById("targetTotalDisplay");
    if (totalLabel) {
      totalLabel.textContent = `${totalPercent.toFixed(1)}%`;
    }
  }

  function renderTargetSummary() {
    const summary = document.getElementById("allocationTargetSummary");
    if (!summary) return;
    const parts = state.assets.map((asset) => {
      const percent = (asset.target * 100).toFixed(1).replace(/\.0$/, "");
      return `${asset.ticker} ${percent}`;
    });
    summary.textContent = `목표 ${parts.join(" / ")}`;
  }

  function renderWindowToggle() {
    [30, 90, 180].forEach((days) => {
      const button = document.getElementById(`window${days}Button`);
      if (!button) return;
      button.classList.toggle("active", state.trendWindow === days);
    });
  }

  function updateTargetPercent(ticker, value) {
    const percent = parseMoney(value);
    state.draftTargets[ticker] = Math.max(0, percent);
    syncTargetInputs();
  }

  function setSaveStatus(message) {
    const status = document.getElementById("targetSaveStatus");
    if (!status) return;
    status.textContent = message;
  }

  function saveTargets() {
    state.assets = state.assets.map((asset) => {
      const percent = Number(state.draftTargets[asset.ticker] ?? asset.target * 100);
      return { ...asset, target: Math.max(0, percent / 100) };
    });
    try {
      const payload = Object.fromEntries(state.assets.map((asset) => [asset.ticker, asset.target * 100]));
      localStorage.setItem(TARGET_STORAGE_KEY, JSON.stringify(payload));
      setSaveStatus("저장됨");
    } catch {
      setSaveStatus("저장됨");
    }
    render();
  }

  function loadSavedTargets() {
    try {
      const raw = localStorage.getItem(TARGET_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      state.assets = state.assets.map((asset) => {
        const percent = Number(parsed?.[asset.ticker]);
        if (!Number.isFinite(percent)) return asset;
        return { ...asset, target: Math.max(0, percent / 100) };
      });
      state.assets.forEach((asset) => {
        state.draftTargets[asset.ticker] = asset.target * 100;
      });
    } catch {
      // ignore parse/storage errors
    }
  }

  function loadSavedPlanMonths() {
    try {
      const raw = localStorage.getItem(PLAN_MONTHS_STORAGE_KEY);
      if (raw == null) return;
      const parsed = Math.round(Number(raw));
      if (!Number.isFinite(parsed)) return;
      state.planMonths = Math.max(1, Math.min(24, parsed));
    } catch {
      // ignore parse/storage errors
    }
  }

  function updatePlanMonths(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    state.planMonths = Math.max(1, Math.min(24, Math.round(parsed)));
    try {
      localStorage.setItem(PLAN_MONTHS_STORAGE_KEY, String(state.planMonths));
    } catch {
      // ignore storage errors
    }
    render();
  }

  function normalizeSummaryLayout() {
    const futureMetrics = Array.from(document.querySelectorAll("#futureMetric"));
    if (futureMetrics.length <= 1) return;
    futureMetrics.slice(1).forEach((node) => {
      const metricCard = node.closest(".metric");
      if (metricCard) metricCard.remove();
    });
  }

  function buildTrendCoordinates(points, width = 280, height = 44, pad = 4) {
    if (!Array.isArray(points) || points.length === 0) return null;
    const values = points.map((point) => Number(point.close)).filter((value) => Number.isFinite(value));
    if (values.length === 0) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    const coords = values.map((value, index) => {
      const x = pad + (index / Math.max(values.length - 1, 1)) * (width - pad * 2);
      const y = pad + ((max - value) / span) * (height - pad * 2);
      return { x, y, value };
    });
    return { coords, min, max, span, avg, width, height, pad };
  }

  function buildPortfolioTrendSeries(weightsByTicker) {
    const tickers = Object.keys(weightsByTicker || {}).filter((ticker) => Number(weightsByTicker[ticker]) > 0);
    if (tickers.length === 0) return [];
    if (tickers.some((ticker) => !Array.isArray(state.trend30[ticker]?.points) || state.trend30[ticker].points.length < 2)) {
      return [];
    }

    const baseByTicker = {};
    const mapByTicker = {};
    tickers.forEach((ticker) => {
      const points = state.trend30[ticker].points;
      baseByTicker[ticker] = Number(points[0].close);
      mapByTicker[ticker] = new Map(
        points
          .filter((point) => Number.isFinite(Number(point.close)))
          .map((point) => [String(point.date), Number(point.close)]),
      );
    });

    const baseDates = state.trend30[tickers[0]].points.map((point) => String(point.date));
    const commonDates = baseDates.filter((date) => tickers.every((ticker) => mapByTicker[ticker].has(date)));
    if (commonDates.length < 2) return [];

    const indexedSeries = commonDates.map((date) =>
      tickers.map((ticker) => {
        const base = baseByTicker[ticker];
        const close = mapByTicker[ticker].get(date);
        const ratio = Number.isFinite(base) && base > 0 && Number.isFinite(close) ? close / base : 0;
        return { ticker, ratio };
      }),
    );

    return indexedSeries.map((rows, dateIndex) => {
      const date = commonDates[dateIndex];
      const weightedValues = rows.map((row) => ({
        ticker: row.ticker,
        value: (Number(weightsByTicker[row.ticker]) || 0) * row.ratio,
      }));
      const totalValue = weightedValues.reduce((sum, row) => sum + row.value, 0);
      const liveWeights = Object.fromEntries(
        weightedValues.map((row) => [row.ticker, totalValue > 0 ? row.value / totalValue : 0]),
      );
      const cagr = tickers.reduce((sum, ticker) => {
        const w = Number(liveWeights[ticker]) || 0;
        const r = Number(state.expectedReturns[ticker]) || 0;
        return sum + w * r;
      }, 0);
      return { date, close: cagr * 100 };
    });
  }

  function buildPortfolioIndexSeries(weightsByTicker) {
    const tickers = Object.keys(weightsByTicker || {}).filter((ticker) => Number(weightsByTicker[ticker]) > 0);
    if (tickers.length === 0) return [];
    if (tickers.some((ticker) => !Array.isArray(state.trend30[ticker]?.points) || state.trend30[ticker].points.length < 2)) {
      return [];
    }

    const baseByTicker = {};
    const mapByTicker = {};
    tickers.forEach((ticker) => {
      const points = state.trend30[ticker].points;
      baseByTicker[ticker] = Number(points[0].close);
      mapByTicker[ticker] = new Map(
        points
          .filter((point) => Number.isFinite(Number(point.close)))
          .map((point) => [String(point.date), Number(point.close)]),
      );
    });

    const baseDates = state.trend30[tickers[0]].points.map((point) => String(point.date));
    const commonDates = baseDates.filter((date) => tickers.every((ticker) => mapByTicker[ticker].has(date)));
    if (commonDates.length < 2) return [];

    return commonDates.map((date) => {
      const value = tickers.reduce((sum, ticker) => {
        const base = baseByTicker[ticker];
        const close = mapByTicker[ticker].get(date);
        const ratio = Number.isFinite(base) && base > 0 && Number.isFinite(close) ? close / base : 0;
        return sum + (Number(weightsByTicker[ticker]) || 0) * ratio;
      }, 0);
      return { date, close: value * 100 };
    });
  }

  function calculateRiskMetrics(series) {
    if (!Array.isArray(series) || series.length < 2) return { mdd: 0, sharpe: 0 };
    const values = series.map((point) => Number(point.close)).filter((v) => Number.isFinite(v) && v > 0);
    if (values.length < 2) return { mdd: 0, sharpe: 0 };

    let peak = values[0];
    let mdd = 0;
    for (const value of values) {
      peak = Math.max(peak, value);
      const drawdown = peak > 0 ? value / peak - 1 : 0;
      mdd = Math.min(mdd, drawdown);
    }

    const dailyReturns = [];
    for (let index = 1; index < values.length; index += 1) {
      dailyReturns.push(values[index] / values[index - 1] - 1);
    }
    const mean = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / Math.max(1, dailyReturns.length - 1);
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

    return { mdd, sharpe };
  }

  function applyCalendarVisibility(visible) {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("calendar-hidden", !visible);
    const button = document.getElementById("toggleCalendarButton");
    if (button) {
      button.textContent = visible ? "◀" : "▶";
      button.title = visible ? "Hide Calendar" : "Show Calendar";
      button.setAttribute("aria-label", visible ? "Hide Calendar" : "Show Calendar");
    }
  }

  function loadSavedCalendarVisibility() {
    let visible = true;
    try {
      const raw = localStorage.getItem(CALENDAR_VISIBLE_STORAGE_KEY);
      if (raw === "0") visible = false;
      if (raw === "1") visible = true;
    } catch {
      // ignore storage errors
    }
    applyCalendarVisibility(visible);
  }

  function toggleCalendarVisibility() {
    const nextVisible = document.body.classList.contains("calendar-hidden");
    applyCalendarVisibility(nextVisible);
    try {
      localStorage.setItem(CALENDAR_VISIBLE_STORAGE_KEY, nextVisible ? "1" : "0");
    } catch {
      // ignore storage errors
    }
  }

  function applyInstitutionalVisibility(visible) {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("institutional-hidden", !visible);
    const button = document.getElementById("toggleInstitutionalButton");
    if (button) {
      button.textContent = visible ? "13F" : "+13F";
      button.title = visible ? "Hide 13F Panel" : "Show 13F Panel";
      button.setAttribute("aria-label", visible ? "Hide 13F Panel" : "Show 13F Panel");
    }
  }

  function loadSavedInstitutionalVisibility() {
    let visible = true;
    try {
      const raw = localStorage.getItem(INSTITUTIONAL_VISIBLE_STORAGE_KEY);
      if (raw === "0") visible = false;
      if (raw === "1") visible = true;
    } catch {
      // ignore storage errors
    }
    applyInstitutionalVisibility(visible);
  }

  function toggleInstitutionalVisibility() {
    const nextVisible = document.body.classList.contains("institutional-hidden");
    applyInstitutionalVisibility(nextVisible);
    try {
      localStorage.setItem(INSTITUTIONAL_VISIBLE_STORAGE_KEY, nextVisible ? "1" : "0");
    } catch {
      // ignore storage errors
    }
  }

  function pearsonCorrelation(valuesA, valuesB) {
    if (!Array.isArray(valuesA) || !Array.isArray(valuesB)) return null;
    const length = Math.min(valuesA.length, valuesB.length);
    if (length < 2) return null;
    const a = valuesA.slice(0, length);
    const b = valuesB.slice(0, length);
    const meanA = a.reduce((sum, v) => sum + v, 0) / length;
    const meanB = b.reduce((sum, v) => sum + v, 0) / length;
    let cov = 0;
    let varA = 0;
    let varB = 0;
    for (let index = 0; index < length; index += 1) {
      const da = a[index] - meanA;
      const db = b[index] - meanB;
      cov += da * db;
      varA += da * da;
      varB += db * db;
    }
    if (varA <= 0 || varB <= 0) return null;
    return cov / Math.sqrt(varA * varB);
  }

  function computePairCorrelations() {
    const tickers = ["GLD", "SCHD", "SPY", "QQQ"];
    const returnsByTicker = {};

    for (const ticker of tickers) {
      const points = state.trend30[ticker]?.points;
      if (!Array.isArray(points) || points.length < 2) return [];
      const byDate = new Map(
        points
          .filter((point) => Number.isFinite(Number(point.close)))
          .map((point) => [String(point.date), Number(point.close)]),
      );
      returnsByTicker[ticker] = byDate;
    }

    const baseDates = state.trend30[tickers[0]].points.map((point) => String(point.date));
    const commonDates = baseDates.filter((date) => tickers.every((ticker) => returnsByTicker[ticker].has(date)));
    if (commonDates.length < 3) return [];

    const dailyReturns = {};
    for (const ticker of tickers) {
      const closes = commonDates.map((date) => returnsByTicker[ticker].get(date));
      const rets = [];
      for (let index = 1; index < closes.length; index += 1) {
        rets.push(closes[index] / closes[index - 1] - 1);
      }
      dailyReturns[ticker] = rets;
    }

    const pairs = [
      ["GLD", "SCHD"],
      ["GLD", "SPY"],
      ["GLD", "QQQ"],
      ["SCHD", "SPY"],
      ["SCHD", "QQQ"],
      ["SPY", "QQQ"],
    ];

    const returnDates = commonDates.slice(1);
    return pairs.map(([left, right]) => {
      const leftReturns = dailyReturns[left];
      const rightReturns = dailyReturns[right];
      const corrWindow = Math.max(2, Math.min(state.trendWindow, leftReturns.length, rightReturns.length));
      const periodLeft = leftReturns.slice(-corrWindow);
      const periodRight = rightReturns.slice(-corrWindow);
      const periodCorr = pearsonCorrelation(periodLeft, periodRight);
      const rollingWindow = Math.max(6, Math.min(Math.round(corrWindow / 2), leftReturns.length, rightReturns.length));
      const series = [];
      for (let index = rollingWindow - 1; index < leftReturns.length; index += 1) {
        const leftSlice = leftReturns.slice(index - rollingWindow + 1, index + 1);
        const rightSlice = rightReturns.slice(index - rollingWindow + 1, index + 1);
        const corr = pearsonCorrelation(leftSlice, rightSlice);
        if (!Number.isFinite(corr)) continue;
        series.push({ date: returnDates[index], value: corr });
      }
      const first = series[0]?.value;
      const last = series[series.length - 1]?.value;
      const delta = Number.isFinite(first) && Number.isFinite(last) ? last - first : null;
      const latest = Number.isFinite(periodCorr) ? periodCorr : Number.isFinite(last) ? last : pearsonCorrelation(leftReturns, rightReturns);
      return {
        pair: `${left}-${right}`,
        value: latest,
        series,
        delta,
        corrWindow,
        rollingWindow,
      };
    });
  }

  function buildCorrelationTrendSvg(series, width = 120, height = 44, pad = 4) {
    if (!Array.isArray(series) || series.length < 2) return "";
    const yFromCorr = (corr) => pad + ((1 - corr) / 2) * (height - pad * 2);
    const coords = series.map((point, index) => {
      const x = pad + (index / Math.max(series.length - 1, 1)) * (width - pad * 2);
      const clamped = Math.max(-1, Math.min(1, Number(point.value)));
      const y = yFromCorr(clamped);
      return { x, y, value: clamped, date: point.date };
    });
    const path = coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
    const x1 = pad.toFixed(1);
    const x2 = (width - pad).toFixed(1);
    const topY = yFromCorr(1).toFixed(1);
    const midY = yFromCorr(0).toFixed(1);
    const bottomY = yFromCorr(-1).toFixed(1);
    const guides = `<line x1="${x1}" y1="${topY}" x2="${x2}" y2="${topY}" class="corr-guide"></line>
      <line x1="${x1}" y1="${midY}" x2="${x2}" y2="${midY}" class="corr-guide corr-guide-mid"></line>
      <line x1="${x1}" y1="${bottomY}" x2="${x2}" y2="${bottomY}" class="corr-guide"></line>`;
    const circles = coords
      .map(
        (point) =>
          `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.8" fill="transparent"><title>${String(
            point.date || "",
          )} / corr ${point.value.toFixed(3)}</title></circle>`,
      )
      .join("");
    return `${guides}<path d="${path}" fill="none" stroke="#2f6fbb" stroke-width="1.8" stroke-linecap="round"></path>${circles}`;
  }

  function renderCorrelationGrid() {
    const container = document.getElementById("corrGrid");
    if (!container) return;
    const rows = computePairCorrelations();
    if (rows.length === 0) {
      container.innerHTML = '<div class="corr-item"><span>Correlation</span><strong>Loading...</strong></div>';
      return;
    }
    container.innerHTML = rows
      .map((row) => {
        const value = Number.isFinite(row.value) ? row.value.toFixed(3) : "N/A";
        const trendSvg = buildCorrelationTrendSvg(row.series);
        const trendDelta = Number.isFinite(row.delta) ? `${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(3)}` : "N/A";
        return `<div class="corr-item">
          <span>${row.pair}</span>
          <strong>${value}</strong>
          <svg class="corr-trend-svg" viewBox="0 0 120 44" preserveAspectRatio="none">${trendSvg}</svg>
          <small class="corr-meta">${row.corrWindow}D corr / ${row.rollingWindow}D trend ${trendDelta}</small>
        </div>`;
      })
      .join("");
  }

  function renderCagrTrend(svgId, metaId, points, color) {
    const svg = document.getElementById(svgId);
    const meta = document.getElementById(metaId);
    if (!svg || !meta) return;
    const model = buildTrendCoordinates(points, 280, 42, 3);
    if (!model) {
      svg.innerHTML = "";
      meta.textContent = "최근 30일 추세 데이터 없음";
      return;
    }
    const { coords, max, span, avg, width, height, pad } = model;
    const path = coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
    const circles = coords
      .map((point, index) => {
        const raw = points[index];
        return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4.2" fill="transparent"><title>${String(
          raw?.date || "",
        )} / CAGR ${Number(raw?.close).toFixed(2)}%</title></circle>`;
      })
      .join("");
    const avgY = pad + ((max - avg) / span) * (height - pad * 2);
    const avgLine = `<line x1="${pad}" y1="${avgY.toFixed(1)}" x2="${(width - pad).toFixed(1)}" y2="${avgY.toFixed(
      1,
    )}" stroke="#8a95a6" stroke-width="1.1" stroke-dasharray="4 3"></line>`;
    svg.innerHTML = `${avgLine}<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"></path>${circles}`;
    const first = Number(points[0].close);
    const last = Number(points[points.length - 1].close);
    const change = Number.isFinite(first) && Number.isFinite(last) ? last - first : 0;
    meta.textContent = `${formatShortDate(points[0].date)} ~ ${formatShortDate(points[points.length - 1].date)} / ${
      change >= 0 ? "+" : ""
    }${change.toFixed(2)}%p`;
  }

  function renderTrendPanel() {
    const grid = document.getElementById("trendGrid");
    const status = document.getElementById("trendStatus");
    if (!grid || !status) return;

    const rows = state.assets
      .map((asset) => ({ ticker: asset.ticker, trend: state.trend30[asset.ticker] }))
      .filter((item) => item.trend && Array.isArray(item.trend.points) && item.trend.points.length > 1);

    if (rows.length === 0) {
      grid.innerHTML = "";
      status.textContent = "No trend data";
      return;
    }

    status.textContent = `Recent ${state.trendWindow} trading days`;
    grid.innerHTML = "";
    rows.forEach(({ ticker, trend }) => {
      const change = Number(trend.change || 0);
      const direction = change >= 0 ? "up" : "down";
      const model = buildTrendCoordinates(trend.points);
      if (!model) return;
      const { coords, max, span, avg, width, height, pad } = model;
      const path = coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
      const circles = coords
        .map(
          (point) =>
            `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.8" fill="transparent"><title>${Number(point.value).toFixed(2)}</title></circle>`,
        )
        .join("");
      const avgY = pad + ((max - avg) / span) * (height - pad * 2);
      const avgLine = `<line x1="${pad}" y1="${avgY.toFixed(1)}" x2="${(width - pad).toFixed(1)}" y2="${avgY.toFixed(1)}" stroke="#8a95a6" stroke-width="1.2" stroke-dasharray="4 3"><title>${state.trendWindow}d avg ${avg.toFixed(2)}</title></line>`;
      const last = trend.points[trend.points.length - 1];
      const card = document.createElement("div");
      card.className = "trend-card";
      card.innerHTML = `
        <div class="trend-head">
          <strong>${ticker}</strong>
          <span class="trend-change ${direction}">${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%</span>
        </div>
        <svg class="trend-svg" viewBox="0 0 280 44" preserveAspectRatio="none" role="img" aria-label="${ticker} recent ${state.trendWindow}-day trend">
          ${avgLine}
          <path d="${path}" fill="none" stroke="${ASSET_COLORS[ticker] || "#8190a3"}" stroke-width="2" stroke-linecap="round"></path>
          ${circles}
        </svg>
        <div class="trend-footer">${trend.startDate} ~ ${trend.endDate} / Last ${Number(last.close).toFixed(2)} / ${state.trendWindow}d avg ${avg.toFixed(2)}</div>
      `;
      grid.appendChild(card);
    });
  }

  async function loadTrendWindow() {
    if (!HISTORY_URL) return;
    const status = document.getElementById("trendStatus");
    if (status) status.textContent = "데이터 불러오는 중...";
    const next = {};
    const failures = [];

    for (const asset of state.assets) {
      try {
        const response = await fetch(`${HISTORY_URL}?ticker=${encodeURIComponent(asset.ticker)}&mode=trend&days=${state.trendWindow}`);
        if (!response.ok) throw new Error(`${asset.ticker} HTTP ${response.status}`);
        next[asset.ticker] = await response.json();
      } catch (error) {
        failures.push(`${asset.ticker}: ${error.message}`);
      }
    }

    state.trend30 = { ...state.trend30, ...next };
    if (status) {
      status.textContent = failures.length === 0 ? `Recent ${state.trendWindow} trading days` : `Partial failure: ${failures.join(", ")}`;
    }
    renderTrendPanel();
    renderCagr();
  }

  function setTrendWindow(days) {
    const next = Number(days);
    if (!Number.isFinite(next) || next === state.trendWindow) return;
    state.trendWindow = next;
    renderWindowToggle();
    loadTrendWindow();
  }

  async function loadMarketPulse() {
    if (!MARKET_PULSE_URL) return;
    const fearValue = document.getElementById("fearGreedValue");
    const fearLabel = document.getElementById("fearGreedLabel");
    const buffettValue = document.getElementById("buffettValue");
    const buffettLabel = document.getElementById("buffettLabel");
    const vixValue = document.getElementById("vixValue");
    const vixLabel = document.getElementById("vixLabel");
    if (!fearValue || !fearLabel || !buffettValue || !buffettLabel || !vixValue || !vixLabel) return;

    fearValue.textContent = "--";
    buffettValue.textContent = "--";
    vixValue.textContent = "--";
    fearLabel.textContent = "Loading...";
    buffettLabel.textContent = "Loading...";
    vixLabel.textContent = "Loading...";

    try {
      const response = await fetch(MARKET_PULSE_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const fg = payload?.fearGreed || {};
      const bi = payload?.buffett || {};
      const vx = payload?.vix || {};

      fearValue.textContent = Number.isFinite(Number(fg.value)) ? Math.round(Number(fg.value)).toString() : "--";
      fearLabel.textContent = fg.label || "N/A";
      renderPulseTrend("fearGreedTrend", "fearGreedAvg", fg.trend60, "#147c72", {
        start: "fearGreedDateStart",
        mid: "fearGreedDateMid",
        end: "fearGreedDateEnd",
      });

      buffettValue.textContent = formatPulsePercent(Number(bi.value));
      buffettLabel.textContent = bi.label || "N/A";
      renderPulseTrend("buffettTrend", "buffettAvg", bi.trend60, "#2f6fbb", {
        start: "buffettDateStart",
        mid: "buffettDateMid",
        end: "buffettDateEnd",
      });

      vixValue.textContent = Number.isFinite(Number(vx.value)) ? Number(vx.value).toFixed(1) : "--";
      vixLabel.textContent = vx.label || "N/A";
      renderPulseTrend("vixTrend", "vixAvg", vx.trend60, "#7b5d3a", {
        start: "vixDateStart",
        mid: "vixDateMid",
        end: "vixDateEnd",
      });
    } catch {
      fearLabel.textContent = "Unavailable";
      buffettLabel.textContent = "Unavailable";
      vixLabel.textContent = "Unavailable";
      renderPulseTrend("fearGreedTrend", "fearGreedAvg", [], "#147c72", {
        start: "fearGreedDateStart",
        mid: "fearGreedDateMid",
        end: "fearGreedDateEnd",
      });
      renderPulseTrend("buffettTrend", "buffettAvg", [], "#2f6fbb", {
        start: "buffettDateStart",
        mid: "buffettDateMid",
        end: "buffettDateEnd",
      });
      renderPulseTrend("vixTrend", "vixAvg", [], "#7b5d3a", {
        start: "vixDateStart",
        mid: "vixDateMid",
        end: "vixDateEnd",
      });
    }
  }

  function renderInstitutionalWidget(payload) {
    const root = document.getElementById("institutionalGrid");
    const status = document.getElementById("institutionalStatus");
    if (!root || !status) return;
    const rows = Array.isArray(payload?.institutions) ? payload.institutions : [];
    if (rows.length === 0) {
      status.textContent = "No data";
      root.innerHTML = "";
      return;
    }
    const asOf = String(payload?.asOf || "").slice(0, 10);
    status.textContent = `${payload?.source || "SEC 13F"}${asOf ? ` · as of ${asOf}` : ""}`;
    root.innerHTML = rows
      .map((inst) => {
        const items =
          Array.isArray(inst.top5) && inst.top5.length > 0
            ? inst.top5
                .map(
                  (row, index) =>
                    `<li>
                      <span>${index + 1}. ${row.issuer}</span>
                      <strong>${formatUsdMillions(row.valueUsdM)}</strong>
                      <em class="delta ${Number(row.deltaPct) >= 0 ? "up" : "down"}">${formatDeltaPercent(row.deltaPct)}</em>
                    </li>`,
                )
                .join("")
            : `<li class="institution-empty">${inst.error || "No holdings parsed"}</li>`;
        const dateLabel = inst.reportDate || inst.filingDate || "-";
        const ageDays = daysSince(inst.reportDate || inst.filingDate);
        const stale = Number.isFinite(ageDays) && ageDays > 180;
        return `<article class="institution-card">
          <div class="institution-head">
            <h3>${inst.institution}</h3>
            <span>${dateLabel}</span>
          </div>
          ${stale ? `<div class="institution-note">Latest available under current CIK (${ageDays}d old)</div>` : ""}
          <ol>${items}</ol>
        </article>`;
      })
      .join("");
  }

  async function loadInstitutionalHoldings() {
    const status = document.getElementById("institutionalStatus");
    if (!INSTITUTIONAL_HOLDINGS_URL || !status) return;
    status.textContent = "Loading latest filings...";
    try {
      const response = await fetch(INSTITUTIONAL_HOLDINGS_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      renderInstitutionalWidget(payload);
    } catch (error) {
      status.textContent = `Failed: ${error.message}`;
    }
  }

  async function loadSheet() {
    const status = document.getElementById("sheetStatus");
    status.textContent = "시트 불러오는 중...";
    try {
      const response = await fetch(SHEET_CSV_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const latest = parseLatestSheetRow(text);
      if (!applyLatestRow(latest, "시트 최신값")) throw new Error("최신 행을 찾지 못했습니다.");
    } catch (error) {
      status.textContent = "시트 자동 불러오기 실패. 잠시 후 다시 시도해 주세요.";
    }
  }

  async function loadHistoricalReturns() {
    const status = document.getElementById("historyStatus");
    if (!HISTORY_URL || !status) return;

    status.textContent = "최근 120개월 데이터 반영 중...";
    try {
      const results = [];
      const failures = [];

      for (const asset of state.assets) {
        try {
          const response = await fetch(`${HISTORY_URL}?ticker=${encodeURIComponent(asset.ticker)}`);
          if (!response.ok) throw new Error(`${asset.ticker} HTTP ${response.status}`);
          results.push(await response.json());
        } catch (error) {
          failures.push(`${asset.ticker}: ${error.message}`);
        }
      }

      if (results.length === 0) {
        throw new Error(failures.join(", "));
      }

      results.forEach((result) => {
        state.expectedReturns[result.ticker] = result.cagr;
      });

      render();
      const minMonths = Math.min(...results.map((result) => result.monthsUsed));
      const latestDate = results.map((result) => result.endDate).sort().at(-1);
      status.textContent =
        failures.length > 0
          ? `일부 반영 완료 (${results.map((result) => result.ticker).join(", ")}). 실패: ${failures.join(", ")}`
          : `실제 월말 종가 ${minMonths}개월 이동평균 반영 (${latestDate})`;
    } catch (error) {
      status.textContent = `실제 데이터 반영 실패: ${error.message}`;
    }
  }

  function init() {
    normalizeSummaryLayout();
    loadSavedPlanMonths();
    loadSavedTargets();
    loadSavedActualTrades();
    renderInputs();
    bindAssetInputs();
    render();

    document.getElementById("contributionInput").addEventListener("input", (event) => updateContribution(event.target.value));
    document.getElementById("planMonthsInput").addEventListener("input", (event) => updatePlanMonths(event.target.value));
    ["GLD", "SCHD", "SPY", "QQQ"].forEach((ticker) => {
      const input = document.getElementById(`target-${ticker}`);
      if (input) {
        input.addEventListener("input", (event) => updateTargetPercent(ticker, event.target.value));
      }
    });
    const saveButton = document.getElementById("saveTargetsButton");
    if (saveButton) {
      saveButton.addEventListener("click", saveTargets);
    }
    [30, 90, 180].forEach((days) => {
      const button = document.getElementById(`window${days}Button`);
      if (button) button.addEventListener("click", () => setTrendWindow(days));
    });
    const toggleCalendarButton = document.getElementById("toggleCalendarButton");
    if (toggleCalendarButton) {
      toggleCalendarButton.addEventListener("click", toggleCalendarVisibility);
    }
    const toggleInstitutionalButton = document.getElementById("toggleInstitutionalButton");
    if (toggleInstitutionalButton) {
      toggleInstitutionalButton.addEventListener("click", toggleInstitutionalVisibility);
    }
    const saveActualTradesButton = document.getElementById("saveActualTradesButton");
    if (saveActualTradesButton) {
      saveActualTradesButton.addEventListener("click", saveActualTradesToServer);
    }
    loadSavedCalendarVisibility();
    loadSavedInstitutionalVisibility();

    document.getElementById("loadSheetButton").addEventListener("click", loadSheet);
    document.getElementById("loadHistoryButton").addEventListener("click", loadHistoricalReturns);
    loadSheet();
    loadHistoricalReturns();
    loadTrendWindow();
    loadMarketPulse();
    loadInstitutionalHoldings();
    loadActualTradesFromServer();
  }

  if (typeof module !== "undefined") {
    module.exports = {
      allocateBuyOnly,
      calculateExpectedCagr,
      calculateMovingAverageCagr,
      calculateTargetExpectedCagr,
      parseLatestSheetRow,
      parseMoney,
      simulateRebalancing,
    };
  }

  if (typeof document !== "undefined") {
    init();
  }
})();

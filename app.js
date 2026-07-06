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
  const ACTUAL_TRADES_SYNC_URL =
    typeof location !== "undefined" && location.protocol.startsWith("http") ? "/api/actual-trades-sync" : null;
  const AI_ADVICE_URL =
    typeof location !== "undefined" && location.protocol.startsWith("http") ? "/api/insights" : null;
  const state = {
    contribution: 400,
    planMonths: 6,
    trendWindow: 30,
    recentCurrentTotals: [],
    assets: TARGETS.map((asset) => ({ ...asset })),
    draftTargets: Object.fromEntries(TARGETS.map((asset) => [asset.ticker, asset.target * 100])),
    trend30: {},
    sourceRiskHistory: {},
    expectedReturns: {
      GLD: 0.04,
      SCHD: 0.07,
      SPY: 0.08,
      QQQ: 0.1,
    },
    actualTrades: {},
    manualTrades: {},
    sourceSnapshots: [],
    aiAdvice: null,
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
  const MANUAL_TRADES_STORAGE_KEY = "portfolio-rebalancer-manual-trades-v1";
  const ACTUAL_TRADES_MONTH_KEY = "portfolio-rebalancer-actual-trades-month-v1";
  const ACTUAL_TRADE_TICKERS = ["GLD", "SCHD", "SPY", "QQQ"];
  const ADVICE_POLICY = {
    SCHD: { target: 0.1, min: 0.08, max: 0.12 },
    GLD: { target: 0.2, min: 0.18, max: 0.25 },
    SPY: { target: 0.3, min: 0.27, max: 0.33 },
    QQQ: { target: 0.4, min: 0.37, max: 0.43 },
  };

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

  function parseOptionalNumber(value) {
    if (value === null || value === undefined || value === "") return NaN;
    return Number(value);
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

  function parseSheetDate(value) {
    const text = normalizeCell(value).replace(/\.$/, "");
    const parts = text.split(/[.\/-]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const rawYear = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2] || 1);
    if (!Number.isFinite(rawYear) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  function parseSourcePortfolioSnapshots(lines) {
    const snapshots = [];
    for (const row of lines) {
      const preferredDate = parseSheetDate(row[16]);
      const preferredValues = [row[17], row[18], row[19], row[20]].map(parseMoney);
      if (preferredDate && preferredValues.every((value) => value > 0)) {
        const cash = parseMoney(row[21]);
        const invested = preferredValues.reduce((sum, value) => sum + value, 0);
        snapshots.push({
          date: preferredDate,
          dateLabel: normalizeCell(row[16]),
          SPY: preferredValues[0],
          QQQ: preferredValues[1],
          SCHD: preferredValues[2],
          GLD: preferredValues[3],
          cash: cash > 0 ? cash : 0,
          total: invested + (cash > 0 ? cash : 0),
          invested,
        });
        continue;
      }
      for (let index = 0; index <= row.length - 5; index += 1) {
        const date = parseSheetDate(row[index]);
        if (!date) continue;
        const values = [row[index + 1], row[index + 2], row[index + 3], row[index + 4]].map(parseMoney);
        if (!values.every((value) => value > 0)) continue;
        const cash = parseMoney(row[index + 5]);
        const invested = values.reduce((sum, value) => sum + value, 0);
        snapshots.push({
          date,
          dateLabel: normalizeCell(row[index]),
          SPY: values[0],
          QQQ: values[1],
          SCHD: values[2],
          GLD: values[3],
          cash: cash > 0 ? cash : 0,
          total: invested + (cash > 0 ? cash : 0),
          invested,
        });
        break;
      }
    }
    return snapshots
      .filter((row) => Number.isFinite(row.total) && row.total > 0)
      .sort((a, b) => a.date - b.date);
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

    const sourceSnapshots = parseSourcePortfolioSnapshots(lines);

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
      return latest ? { ...latest, recentCurrentTotals, sourceSnapshots } : null;
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
    return latest ? { ...latest, recentCurrentTotals, sourceSnapshots } : null;
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
    renderCurrentMetric(result.currentTotal);
    renderTargetContributionBreakdown(normalizedAssets);
    renderBandAdvice(normalizedAssets);
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
        const manualTrade = Number(state.manualTrades[row.ticker] ?? 0);
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
            <label class="actual-trade-entry">
              <span>다른 소스</span>
              <input data-manual-ticker="${row.ticker}" type="text" inputmode="numeric" value="${Math.round(manualTrade).toLocaleString("ko-KR")}" />
              <em>만원</em>
            </label>
          </div>
          <strong>${isSell ? "-" : "+"}${formatMoney(Math.abs(row.trade))}</strong>
        `;
        buyList.appendChild(card);
      });
    bindActualTradeInputs(result);
    renderTradeSummary(result);

    renderSimulation();
    renderCagr();
    renderMonthlyReport(result, normalizedAssets);
    renderTrendPanel();
    renderWindowToggle();
  }

  function combinedActualTrade(ticker) {
    return Number(state.actualTrades[ticker] || 0) + Number(state.manualTrades[ticker] || 0);
  }

  function saveActualTrades() {
    try {
      const now = new Date();
      const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      localStorage.setItem(ACTUAL_TRADES_STORAGE_KEY, JSON.stringify(state.actualTrades));
      localStorage.setItem(MANUAL_TRADES_STORAGE_KEY, JSON.stringify(state.manualTrades));
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
        state.manualTrades = Object.fromEntries(ACTUAL_TRADE_TICKERS.map((ticker) => [ticker, 0]));
        localStorage.setItem(ACTUAL_TRADES_STORAGE_KEY, JSON.stringify(state.actualTrades));
        localStorage.setItem(MANUAL_TRADES_STORAGE_KEY, JSON.stringify(state.manualTrades));
        localStorage.setItem(ACTUAL_TRADES_MONTH_KEY, currentYm);
        return;
      }
      const raw = localStorage.getItem(ACTUAL_TRADES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          state.actualTrades = normalizeActualTrades(parsed);
        }
      }
      const manualRaw = localStorage.getItem(MANUAL_TRADES_STORAGE_KEY);
      if (manualRaw) {
        const manualParsed = JSON.parse(manualRaw);
        if (manualParsed && typeof manualParsed === "object") {
          state.manualTrades = normalizeActualTrades(manualParsed);
        }
      }
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
        state.manualTrades = Object.fromEntries(ACTUAL_TRADE_TICKERS.map((ticker) => [ticker, 0]));
        saveActualTrades();
        render();
        return;
      }
      state.actualTrades = normalizeActualTrades(payload?.trades || {});
      state.manualTrades = normalizeActualTrades(payload?.manualTrades || {});
      saveActualTrades();
      render();
    } catch {
      // keep local fallback
    }
  }

  async function syncActualTradesFromTransactionRecord() {
    if (!ACTUAL_TRADES_SYNC_URL) return;
    try {
      const response = await fetch(ACTUAL_TRADES_SYNC_URL, { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      const tickers = payload?.tickers || {};
      let changed = false;
      for (const ticker of ACTUAL_TRADE_TICKERS) {
        if (Object.prototype.hasOwnProperty.call(tickers, ticker)) {
          state.actualTrades[ticker] = Number(tickers[ticker]) || 0;
          changed = true;
        }
      }
      if (changed) {
        saveActualTrades();
        render();
      }
    } catch {
      // keep whatever was already loaded
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
      manualTrades: normalizeActualTrades(state.manualTrades),
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
          manualGLD: String(payload.manualTrades.GLD ?? 0),
          manualSCHD: String(payload.manualTrades.SCHD ?? 0),
          manualSPY: String(payload.manualTrades.SPY ?? 0),
          manualQQQ: String(payload.manualTrades.QQQ ?? 0),
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
    document.querySelectorAll("[data-manual-ticker]").forEach((input) => {
      input.addEventListener("input", (event) => {
        const ticker = event.target.dataset.manualTicker;
        state.manualTrades[ticker] = parseMoney(event.target.value);
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
    const actualBuy = result.rows.reduce((sum, row) => sum + Math.max(0, combinedActualTrade(row.ticker)), 0);
    const actualSell = result.rows.reduce((sum, row) => sum + Math.max(0, -combinedActualTrade(row.ticker)), 0);
    warning.hidden = false;
    warning.textContent =
      `계획: 총 매수 ${formatMoney(plannedBuy)}, 총 축소 ${formatMoney(plannedSell)}, 순투입 ${formatMoney(state.contribution)} | ` +
      `실제: 총 매수 ${formatMoney(actualBuy)}, 총 축소 ${formatMoney(actualSell)}, 순투입 ${formatMoney(actualBuy - actualSell)}`;
  }

  function renderTargetContributionBreakdown(normalizedAssets) {
    const container = document.getElementById("targetContributionBreakdown");
    if (!container) return;

    const total = normalizedAssets.reduce((sum, asset) => sum + Math.max(0, Number(asset.current) || 0), 0);
    const rows = normalizedAssets
      .slice()
      .sort((a, b) => TARGETS.findIndex((asset) => asset.ticker === a.ticker) - TARGETS.findIndex((asset) => asset.ticker === b.ticker));
    container.innerHTML = `
      <div class="target-contribution-title">
        <span>CAGR 티커별 기여도</span>
        <strong>현재 → 목표</strong>
      </div>
      <div class="target-contribution-list">
        ${rows
          .map((asset) => {
            const expectedReturn = Number(state.expectedReturns[asset.ticker]) || 0;
            const currentWeight = total > 0 ? Math.max(0, Number(asset.current) || 0) / total : 0;
            const currentContribution = currentWeight * expectedReturn * 100;
            const targetContribution = Number(asset.target || 0) * expectedReturn * 100;
            return `
              <div class="target-contribution-row">
                <span class="target-contribution-ticker">
                  <i style="background:${ASSET_COLORS[asset.ticker] || "#8190a3"}"></i>${asset.ticker}
                </span>
                <strong>${currentContribution.toFixed(1)}%p</strong>
                <em>${targetContribution.toFixed(1)}%p</em>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function readText(id) {
    return document.getElementById(id)?.textContent?.trim() || "";
  }

  function formatBandPercent(value) {
    return `${(Number(value || 0) * 100).toFixed(0)}%`;
  }

  function getBandStatus(ticker, weight) {
    const band = ADVICE_POLICY[ticker];
    if (!band) return "Within Band";
    if (weight < band.min) return "Underweight";
    if (weight > band.max) return "Overweight";
    return "Within Band";
  }

  function formatBandStatusLabel(status) {
    if (status === "Underweight") return "부족";
    if (status === "Overweight") return "초과";
    return "밴드 안";
  }

  function buildTickerActionRecommendation(ticker, weight, weightsByTicker) {
    const band = ADVICE_POLICY[ticker];
    const percent = formatBandPercent(weight);
    if (!band) return "밴드 정보가 없습니다.";
    if (ticker === "GLD") {
      if (weight > band.max) {
        const needsQqq = (weightsByTicker.QQQ || 0) < ADVICE_POLICY.QQQ.target;
        const needsSpy = (weightsByTicker.SPY || 0) < ADVICE_POLICY.SPY.target;
        if (needsQqq || needsSpy) {
          return `GLD ${percent}는 방어 비중이 높은 상태입니다. 급하게 매도할 필요는 없고, GLD를 조정장에서 주식을 사기 위한 완충 재원으로 보면서 신규 매수/점진 축소 재원을 ${needsQqq ? "QQQ" : "SPY"}에 우선 배정하세요.`;
        }
        return `GLD ${percent}는 상단 밴드 위입니다. 버리는 자산이 아니라 조정장에서 주식을 사기 위한 완충 자산으로 보고, 신규 매수는 다른 저비중 자산에 우선 배정하세요.`;
      }
      if (weight >= ADVICE_POLICY.GLD.target && weight <= band.max) {
        return "GLD는 목표보다 살짝 높아도 방어 버퍼 구간입니다. SPY/QQQ가 크게 부족하지 않다면 강제 리밸런싱은 필요 없습니다.";
      }
      if (weight < band.min) return "GLD가 하단 밴드 아래라 하락장 완충력이 약해질 수 있습니다. 향후 신규 매수금 일부를 GLD에 배정해 20% 근처로 복귀시키세요.";
      return "GLD는 밴드 안입니다. 완충 자산으로 유지하면서 정기분할매수를 계속하세요.";
    }
    if (ticker === "QQQ") {
      if (weight < band.min) return "QQQ가 성장 엔진 대비 부족합니다. 신규 매수금은 우선 QQQ로 배정하세요.";
      if (weight > band.max) return "QQQ 성장 집중도가 높습니다. 큰 과열이 아니라면 매도보다 신규 매수금을 SPY/GLD/SCHD로 돌리세요.";
      return "QQQ는 밴드 안입니다. 장기 성장 엔진으로 정기분할매수를 유지하세요.";
    }
    if (ticker === "SPY") {
      if (weight < band.min) return "SPY가 미국 시장 핵심 비중 대비 부족합니다. QQQ 우선순위를 확인한 뒤 SPY를 보강하세요.";
      if (weight > band.max) return "SPY가 상단 밴드 위입니다. 즉시 매도보다 신규 매수금을 저비중 자산으로 배정하세요.";
      return "SPY는 밴드 안입니다. 미국 시장 코어로 유지하세요.";
    }
    if (ticker === "SCHD") {
      if (weight < band.min) return "SCHD는 부족하지만 성장 엔진은 아닙니다. 배당/방어 선호가 크지 않다면 QQQ/SPY 이후 천천히 보강하세요.";
      if (weight > band.max) return "SCHD가 높아 배당/방어 주식이 성장을 일부 밀어낼 수 있습니다. 신규 매수금은 QQQ/SPY에 우선 배정하세요.";
      return "SCHD는 밴드 안입니다. 인컴/방어 주식 역할로 유지하세요.";
    }
    return "밴드 안에서 정기분할매수를 유지하세요.";
  }

  function buildAllocationAdviceRows(normalizedAssets, weightsByTicker) {
    const order = ["SCHD", "GLD", "SPY", "QQQ"];
    const byTicker = Object.fromEntries(normalizedAssets.map((asset) => [asset.ticker, asset]));
    return order
      .filter((ticker) => byTicker[ticker])
      .map((ticker) => {
        const asset = byTicker[ticker];
        const currentWeight = weightsByTicker[ticker] || 0;
        const policy = ADVICE_POLICY[ticker];
        return {
          ticker,
          currentWeight,
          targetWeight: policy.target,
          bandMin: policy.min,
          bandMax: policy.max,
          differenceFromTarget: currentWeight - policy.target,
          bandStatus: getBandStatus(ticker, currentWeight),
          actionRecommendation: buildTickerActionRecommendation(ticker, currentWeight, weightsByTicker),
          appTargetWeight: asset.target,
        };
      });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatAdvicePercent(value, digits = 1) {
    if (!Number.isFinite(Number(value))) return "N/A";
    return `${(Number(value) * 100).toFixed(digits)}%`;
  }

  function formatSignedAdvicePercent(value) {
    if (!Number.isFinite(Number(value))) return "N/A";
    const points = Number(value) * 100;
    return `${points >= 0 ? "+" : ""}${points.toFixed(1)}%p`;
  }

  function getAdviceSummary(rows) {
    const allWithinBands = rows.every((row) => row.bandStatus === "Within Band");
    if (allWithinBands) {
      return "포트폴리오가 목표 밴드 안에 있습니다. 급한 리밸런싱은 필요 없고, 신규 매수금은 기존 정기분할매수 계획대로 분산 집행하세요.";
    }
    const byTicker = Object.fromEntries(rows.map((row) => [row.ticker, row]));
    const messages = [];
    if (byTicker.QQQ?.bandStatus === "Underweight") {
      messages.push("QQQ가 성장 엔진 대비 부족합니다. 신규 매수금은 우선 QQQ로 배정하세요.");
    }
    if (byTicker.SPY?.bandStatus === "Underweight") {
      messages.push("SPY는 미국 시장 코어입니다. QQQ 우선순위를 확인한 뒤 SPY를 보강하세요.");
    }
    if (byTicker.GLD?.bandStatus === "Overweight") {
      messages.push("GLD는 버리는 자산이 아니라, 조정장에서 주식을 사기 위한 완충 자산입니다. 급하게 매도할 필요는 없습니다.");
    } else if ((byTicker.GLD?.currentWeight || 0) >= ADVICE_POLICY.GLD.target && (byTicker.GLD?.currentWeight || 0) <= ADVICE_POLICY.GLD.max) {
      messages.push("GLD는 목표보다 살짝 높지만 아직 방어 버퍼 구간 안에 있습니다.");
    } else if (byTicker.GLD?.bandStatus === "Underweight") {
      messages.push("GLD가 낮아 하락장 방어력이 약해질 수 있습니다. 향후 신규 매수금 일부를 GLD에 배정하세요.");
    }
    if (byTicker.SCHD?.bandStatus === "Overweight") {
      messages.push("SCHD가 높아 인컴/방어 주식이 성장 자산을 밀어낼 수 있습니다. 신규 매수금은 QQQ/SPY에 우선 배정하세요.");
    } else if (byTicker.SCHD?.bandStatus === "Underweight") {
      messages.push("SCHD는 천천히 보강하되, 인컴 목적이 크지 않다면 QQQ/SPY보다 낮은 우선순위로 두세요.");
    }
    messages.push("현재는 정확히 10/20/30/40을 맞추기보다 밴드 안에서 운용하는 것이 좋습니다.");
    return messages.join(" ");
  }

  function getMarketOverlayNotes() {
    const notes = [];
    const buffettValue = readText("buffettValue");
    const buffettLabel = readText("buffettLabel");
    if (buffettValue && buffettValue !== "--") {
      notes.push(`버핏 지표: ${buffettValue}${buffettLabel && buffettLabel !== "Loading..." ? ` (${buffettLabel})` : ""}.`);
    }
    const diagnostics = computeAdviceRiskDiagnostics();
    const corr = diagnostics.gldSpyCorrelation;
    if (corr?.available) {
      const corr30 = corr.correlations?.["30d"];
      const corr90 = corr.correlations?.["90d"];
      const corr180 = corr.correlations?.["180d"];
      const corr365 = corr.correlations?.["365d"];
      const expansion = corr.expansion30dVs180d;
      notes.push(
        `GLD-SPY 상관계수: 30D ${Number.isFinite(corr30) ? corr30.toFixed(3) : "N/A"}, 90D ${
          Number.isFinite(corr90) ? corr90.toFixed(3) : "N/A"
        }, 180D ${Number.isFinite(corr180) ? corr180.toFixed(3) : "N/A"}, 365D ${
          Number.isFinite(corr365) ? corr365.toFixed(3) : "N/A"
        }.`,
      );
      if (Number.isFinite(expansion) && expansion > 0.3) {
        notes.push("단기 상관관계 급등이 감지됐습니다. 과잉 반응하기보다 90일/180일 흐름을 함께 확인한 뒤 GLD 축소 여부를 판단하세요.");
      } else if (Number.isFinite(expansion) && expansion > 0.2) {
        notes.push("최근 GLD-SPY 분산 효과가 약해졌지만, 단기 국면 변화일 수 있습니다.");
      }
      if (Number.isFinite(corr30) && Number.isFinite(corr180) && corr30 >= 0.55 && corr180 <= 0.45) {
        notes.push("최근 동조화는 높지만, 중기 분산 효과는 아직 살아 있습니다.");
      }
    }
    const betas = diagnostics.betasVsSpy;
    if (betas?.available) {
      const values = betas.values || {};
      notes.push(
        `SPY 대비 베타 (${betas.windowDays}일): GLD ${Number.isFinite(values.GLD) ? values.GLD.toFixed(2) : "N/A"}, QQQ ${
          Number.isFinite(values.QQQ) ? values.QQQ.toFixed(2) : "N/A"
        }, SCHD ${Number.isFinite(values.SCHD) ? values.SCHD.toFixed(2) : "N/A"}. 상관계수는 방향 유사성, 베타는 SPY 움직임 민감도를 보여줍니다.`,
      );
    }
    if (notes.length === 0) {
      notes.push("시장 오버레이 데이터가 아직 로딩 중입니다. 기본 리밸런싱 판단은 목표 밴드를 우선합니다.");
    }
    return notes;
  }

  function buildAdviceContext(normalizedAssets) {
    const total = normalizedAssets.reduce((sum, asset) => sum + Math.max(0, Number(asset.current) || 0), 0);
    const currentWeights = Object.fromEntries(
      normalizedAssets.map((asset) => [asset.ticker, total > 0 ? Math.max(0, Number(asset.current) || 0) / total : 0]),
    );
    const rows = buildAllocationAdviceRows(normalizedAssets, currentWeights);
    const summary = getAdviceSummary(rows);
    const marketNotes = getMarketOverlayNotes();
    return {
      total,
      rows,
      summary,
      marketNotes,
      allWithinBands: rows.every((row) => row.bandStatus === "Within Band"),
    };
  }

  function buildAiAdvicePayload(normalizedAssets) {
    const context = buildAdviceContext(normalizedAssets);
    return {
      generatedFrom: "portfolio-rebalancer-band-advice",
      asOf: new Date().toISOString(),
      contribution: state.contribution,
      planMonths: state.planMonths,
      totalCurrent: Math.round(context.total),
      targetBands: ADVICE_POLICY,
      ruleSummary: context.summary,
      allocationAdvice: context.rows.map((row) => ({
        ticker: row.ticker,
        currentAllocation: formatAdvicePercent(row.currentWeight),
        targetAllocation: formatAdvicePercent(row.targetWeight, 0),
        acceptableBand: `${formatAdvicePercent(row.bandMin, 0)}-${formatAdvicePercent(row.bandMax, 0)}`,
        differenceFromTarget: formatSignedAdvicePercent(row.differenceFromTarget),
        bandStatus: row.bandStatus,
        bandStatusLabel: formatBandStatusLabel(row.bandStatus),
        actionRecommendation: row.actionRecommendation,
      })),
      marketOverlay: context.marketNotes,
      principles: [
        "장기 미국 ETF 투자",
        "시장 타이밍보다 정기분할매수 우선",
        "SPY/QQQ는 성장 엔진",
        "GLD는 리스크 완충 및 리밸런싱 재원",
        "SCHD는 인컴/방어 주식이며 주요 성장 자산은 아님",
        "패닉 매도, 몰빵, 레버리지, 시장 타이밍 금지",
        "정확한 비율보다 목표 밴드 중심 운용",
      ],
    };
  }

  function renderAiAdviceBlock() {
    if (!state.aiAdvice) return "";
    if (state.aiAdvice.status === "loading") {
      return `<div class="ai-advice-block"><strong>AI 해석</strong><p>현재 밴드 계산 결과를 해석하는 중입니다...</p></div>`;
    }
    if (state.aiAdvice.status === "error") {
      return `<div class="ai-advice-block error"><strong>AI 해석 실패</strong><p>${escapeHtml(state.aiAdvice.message)}</p></div>`;
    }
    return `
      <div class="ai-advice-block">
        <strong>AI 해석</strong>
        <p>${escapeHtml(state.aiAdvice.text)}</p>
      </div>
    `;
  }

  function clearAiAdvice() {
    state.aiAdvice = null;
    const status = document.getElementById("aiAdviceStatus");
    if (status) status.textContent = "룰 계산 결과를 AI가 해석합니다";
  }

  function renderBandAdvice(normalizedAssets) {
    const output = document.getElementById("adviceOutput");
    const status = document.getElementById("adviceStatus");
    if (!output) return;
    const context = buildAdviceContext(normalizedAssets);
    const rows = context.rows;
    if (status) status.textContent = context.allWithinBands ? "모든 자산 밴드 안" : "밴드 이탈 자산 있음";
    const summary = context.summary;
    const marketNotes = context.marketNotes;
    const showRuleSummary = state.aiAdvice?.status !== "ready";

    output.innerHTML = `
      ${showRuleSummary ? `<div class="advice-summary">${escapeHtml(summary)}</div>` : ""}
      ${renderAiAdviceBlock()}
      <div class="advice-table-wrap">
        <table class="advice-table">
          <thead>
            <tr>
              <th>티커</th>
              <th>현재</th>
              <th>목표 / 밴드</th>
              <th>차이</th>
              <th>밴드 상태</th>
              <th>추천 액션</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
                  <tr>
                    <th>${escapeHtml(row.ticker)}</th>
                    <td>${escapeHtml(formatAdvicePercent(row.currentWeight))}</td>
                    <td>${escapeHtml(`${formatAdvicePercent(row.targetWeight, 0)} / ${formatAdvicePercent(row.bandMin, 0)}-${formatAdvicePercent(row.bandMax, 0)}`)}</td>
                    <td>${escapeHtml(formatSignedAdvicePercent(row.differenceFromTarget))}</td>
                    <td><span class="band-status ${escapeHtml(row.bandStatus.toLowerCase().replace(/\s+/g, "-"))}">${escapeHtml(formatBandStatusLabel(row.bandStatus))}</span></td>
                    <td>${escapeHtml(row.actionRecommendation)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
      <div class="advice-columns">
        <div>
          <h3>운용 원칙</h3>
          <ul>
            <li>장기 미국 ETF 투자 관점에서 정기분할매수를 우선합니다.</li>
            <li>SPY/QQQ는 성장 엔진, GLD는 리스크 완충 및 리밸런싱 재원입니다.</li>
            <li>SCHD는 인컴/방어 주식이며 주요 성장 자산은 아닙니다.</li>
          </ul>
        </div>
        <div>
          <h3>시장 오버레이</h3>
          <ul>${marketNotes.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </div>
      </div>
    `;
  }

  async function generateAiAdvice() {
    const button = document.getElementById("generateAiAdviceButton");
    const status = document.getElementById("aiAdviceStatus");
    if (!AI_ADVICE_URL || !button) return;
    const normalizedAssets = normalizeAssetsByTarget(state.assets);
    state.aiAdvice = { status: "loading" };
    if (status) status.textContent = "AI 해석 생성 중...";
    button.disabled = true;
    renderBandAdvice(normalizedAssets);
    try {
      const response = await fetch(AI_ADVICE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildAiAdvicePayload(normalizedAssets)),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      state.aiAdvice = {
        status: "ready",
        text: payload?.text || "AI 해석을 받았지만 표시할 문장이 없습니다.",
      };
      if (status) status.textContent = payload?.generatedAt ? new Date(payload.generatedAt).toLocaleString("ko-KR") : "AI 해석 완료";
    } catch (error) {
      const message = /OPENAI_API_KEY|configured|quota|billing/i.test(error.message)
        ? "OpenAI API 키/결제/쿼터 설정을 확인해 주세요. 룰 기반 조언은 계속 사용할 수 있습니다."
        : error.message;
      state.aiAdvice = { status: "error", message };
      if (status) status.textContent = "AI 해석 실패";
    } finally {
      button.disabled = false;
      renderBandAdvice(normalizedAssets);
    }
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function formatSignedMoney(value) {
    const rounded = Math.round(Number(value) || 0);
    const sign = rounded > 0 ? "+" : "";
    return `${sign}${rounded.toLocaleString("ko-KR")}만원`;
  }

  function formatRiskPercent(value) {
    return `${(Number(value || 0) * 100).toFixed(1)}%`;
  }

  function buildWeightsFromAssets(assets) {
    const total = assets.reduce((sum, asset) => sum + Math.max(0, Number(asset.current) || 0), 0);
    return Object.fromEntries(
      assets.map((asset) => [asset.ticker, total > 0 ? Math.max(0, Number(asset.current) || 0) / total : 0]),
    );
  }

  function renderMonthlyReport(result, normalizedAssets) {
    const monthLabel = new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "long" });
    setText("monthlyReportDate", `${monthLabel} 기준`);

    const plannedBuy = result.rows.reduce((sum, row) => sum + Math.max(0, row.trade), 0);
    const plannedSell = result.rows.reduce((sum, row) => sum + Math.max(0, -row.trade), 0);
    const plannedNet = plannedBuy - plannedSell;
    const actualBuy = result.rows.reduce((sum, row) => sum + Math.max(0, combinedActualTrade(row.ticker)), 0);
    const actualSell = result.rows.reduce((sum, row) => sum + Math.max(0, -combinedActualTrade(row.ticker)), 0);
    const actualNet = actualBuy - actualSell;
    const netGap = actualNet - plannedNet;
    const adherence = plannedNet !== 0 ? Math.max(0, Math.min(999, (actualNet / plannedNet) * 100)) : 0;

    setText("reportPlannedNet", formatMoney(plannedNet));
    setText("reportPlanDetail", `매수 ${formatMoney(plannedBuy)} / 축소 ${formatMoney(plannedSell)}`);
    setText("reportActualNet", formatMoney(actualNet));
    setText("reportActualDetail", `매수 ${formatMoney(actualBuy)} / 축소 ${formatMoney(actualSell)}`);
    setText("reportNetGap", formatSignedMoney(netGap));
    setText("reportAdherence", `진행률 ${adherence.toFixed(1)}%`);

    const actualAssets = normalizedAssets.map((asset) => ({
      ...asset,
      current: Math.max(0, asset.current + combinedActualTrade(asset.ticker)),
    }));
    const actualWeights = buildWeightsFromAssets(actualAssets);

    const nextRow = normalizedAssets
      .map((asset) => ({
        ticker: asset.ticker,
        gap: (actualWeights[asset.ticker] || 0) - asset.target,
      }))
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
    setText("reportNextTicker", nextRow?.ticker || "--");
    setText("reportNextDetail", nextRow ? `목표 대비 ${formatPercent(nextRow.gap)}` : "목표 대비 차이 --");

    renderSourceRiskRows();
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
    list.style.setProperty("--simulation-count", String(months.length || 1));
    months.forEach((month) => {
      const item = document.createElement("article");
      item.className = "simulation-step";

      const trades = month.rows
        .filter((row) => Math.abs(row.trade) > 0.4)
        .sort((a, b) => Math.abs(b.trade) - Math.abs(a.trade))
        .map((row) => `${row.ticker} ${row.trade < 0 ? "축소" : "매수"} ${formatMoney(Math.abs(row.trade))}`)
        .join(" · ");

      const weights = month.rows
        .map(
          (row) => `
            <span class="simulation-weight-chip">
              <b>${escapeHtml(row.ticker)}</b>
              ${escapeHtml(formatPercent(row.afterWeight))}
            </span>
          `,
        )
        .join("");

      item.innerHTML = `
        <div class="simulation-step-head">
          <strong>${month.month}개월차</strong>
          <em>최대 차이 ${(month.maxGap * 100).toFixed(2)}%p</em>
        </div>
        <div class="simulation-trades">${escapeHtml(trades || "거래 없음")}</div>
        <div class="simulation-weights">${weights}</div>
      `;
      list.appendChild(item);
    });
  }

  function applyLatestRow(row, sourceLabel) {
    if (!row) return false;
    clearAiAdvice();
    state.assets = state.assets.map((asset) => ({ ...asset, current: row[asset.ticker] ?? asset.current }));
    state.recentCurrentTotals = Array.isArray(row.recentCurrentTotals) ? row.recentCurrentTotals.slice(-6) : [];
    state.sourceSnapshots = Array.isArray(row.sourceSnapshots) ? row.sourceSnapshots : [];
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
        clearAiAdvice();
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
    clearAiAdvice();
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
    clearAiAdvice();
    syncTargetInputs();
  }

  function setSaveStatus(message) {
    const status = document.getElementById("targetSaveStatus");
    if (!status) return;
    status.textContent = message;
  }

  function saveTargets() {
    clearAiAdvice();
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
    clearAiAdvice();
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

  function buildPortfolioIndexSeriesWithCash(weightsByTicker, cashWeight = 0) {
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
      const riskyValue = tickers.reduce((sum, ticker) => {
        const base = baseByTicker[ticker];
        const close = mapByTicker[ticker].get(date);
        const ratio = Number.isFinite(base) && base > 0 && Number.isFinite(close) ? close / base : 0;
        return sum + (Number(weightsByTicker[ticker]) || 0) * ratio;
      }, 0);
      return { date, close: (Math.max(0, Number(cashWeight) || 0) + riskyValue) * 100 };
    });
  }

  function buildPortfolioIndexSeriesUntil(weightsByTicker, endDate, historyByTicker = state.sourceRiskHistory) {
    const tickers = Object.keys(weightsByTicker || {}).filter((ticker) => Number(weightsByTicker[ticker]) > 0);
    if (tickers.length === 0) return [];
    if (tickers.some((ticker) => !Array.isArray(historyByTicker[ticker]?.points) || historyByTicker[ticker].points.length < 2)) {
      return [];
    }

    const endTime = endDate instanceof Date ? endDate.getTime() : new Date(endDate).getTime();
    if (!Number.isFinite(endTime)) return [];

    const mapByTicker = {};
    tickers.forEach((ticker) => {
      mapByTicker[ticker] = new Map(
        historyByTicker[ticker].points
          .filter((point) => {
            const dateTime = new Date(`${String(point.date).slice(0, 10)}T00:00:00Z`).getTime();
            return Number.isFinite(dateTime) && dateTime <= endTime && Number.isFinite(Number(point.close));
          })
          .map((point) => [String(point.date), Number(point.close)]),
      );
    });

    const baseDates = historyByTicker[tickers[0]].points
      .map((point) => String(point.date))
      .filter((date) => mapByTicker[tickers[0]].has(date));
    const commonDates = baseDates.filter((date) => tickers.every((ticker) => mapByTicker[ticker].has(date)));
    if (commonDates.length < 2) return [];

    const baseByTicker = {};
    tickers.forEach((ticker) => {
      baseByTicker[ticker] = mapByTicker[ticker].get(commonDates[0]);
    });

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

  function calculateCagrFromSeries(series) {
    if (!Array.isArray(series) || series.length < 2) return null;
    const first = series[0];
    const last = series[series.length - 1];
    const firstClose = Number(first.close);
    const lastClose = Number(last.close);
    const firstDate = new Date(`${String(first.date).slice(0, 10)}T00:00:00Z`);
    const lastDate = new Date(`${String(last.date).slice(0, 10)}T00:00:00Z`);
    const years = (lastDate - firstDate) / (365.25 * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(firstClose) || firstClose <= 0 || !Number.isFinite(lastClose) || !Number.isFinite(years) || years <= 0) {
      return null;
    }
    const growth = lastClose / firstClose;
    return growth > 0 ? Math.pow(growth, 1 / years) - 1 : null;
  }

  function calculateSourceSnapshotRisk(rows, valueKey = "total") {
    if (!Array.isArray(rows) || rows.length < 2) return null;
    const values = rows.map((row) => Number(row[valueKey])).filter((value) => Number.isFinite(value) && value > 0);
    if (values.length < 2) return null;

    let peak = values[0];
    let mdd = 0;
    values.forEach((value) => {
      peak = Math.max(peak, value);
      mdd = Math.min(mdd, peak > 0 ? value / peak - 1 : 0);
    });

    const returns = [];
    const intervals = [];
    for (let index = 1; index < rows.length; index += 1) {
      const prev = Number(rows[index - 1][valueKey]);
      const next = Number(rows[index][valueKey]);
      if (Number.isFinite(prev) && prev > 0 && Number.isFinite(next) && next > 0) {
        returns.push(next / prev - 1);
      }
      const prevDate = rows[index - 1].date instanceof Date ? rows[index - 1].date : new Date(rows[index - 1].date);
      const nextDate = rows[index].date instanceof Date ? rows[index].date : new Date(rows[index].date);
      const intervalDays = (nextDate - prevDate) / (24 * 60 * 60 * 1000);
      if (Number.isFinite(intervalDays) && intervalDays > 0) intervals.push(intervalDays);
    }
    if (returns.length < 2) return { mdd, sharpe: 0, count: rows.length };

    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
    const std = Math.sqrt(variance);
    const avgInterval = intervals.length > 0 ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : 30;
    const periodsPerYear = Math.max(1, 365 / avgInterval);
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : 0;
    return { mdd, sharpe, count: rows.length };
  }

  function getSourceRiskForWindow(days, endIndex = state.sourceSnapshots.length - 1) {
    const snapshots = state.sourceSnapshots || [];
    if (endIndex < 1 || !snapshots[endIndex]) return null;
    const endDate = snapshots[endIndex].date instanceof Date ? snapshots[endIndex].date : new Date(snapshots[endIndex].date);
    const startTime = endDate.getTime() - days * 24 * 60 * 60 * 1000;
    const rows = snapshots
      .slice(0, endIndex + 1)
      .filter((row) => {
        const date = row.date instanceof Date ? row.date : new Date(row.date);
        return date.getTime() >= startTime && date.getTime() <= endDate.getTime();
      });
    return calculateSourceSnapshotRisk(rows);
  }

  function formatSignedPoint(value) {
    if (!Number.isFinite(value)) return "--";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(1)}%p`;
  }

  function formatSignedNumber(value) {
    if (!Number.isFinite(value)) return "--";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(3)}`;
  }

  function buildSourceRiskTrendPoints() {
    const snapshots = (state.sourceSnapshots || []).filter((snapshot) => Number(snapshot.invested) > 0);
    return snapshots
      .map((snapshot) => {
        const invested = Number(snapshot.invested) || 0;
        const weights = {
          SPY: Number(snapshot.SPY || 0) / invested,
          QQQ: Number(snapshot.QQQ || 0) / invested,
          SCHD: Number(snapshot.SCHD || 0) / invested,
          GLD: Number(snapshot.GLD || 0) / invested,
        };
        const series = buildPortfolioIndexSeriesUntil(weights, snapshot.date);
        const metrics = calculateRiskMetrics(series);
        const cagr = calculateCagrFromSeries(series);
        if (!Number.isFinite(cagr)) return null;
        return {
          date: snapshot.dateLabel || formatShortDate(snapshot.date),
          mdd: metrics.mdd * 100,
          cagr: cagr * 100,
        };
      })
      .filter(Boolean);
  }

  function hasSourceRiskHistory() {
    return ["SPY", "QQQ", "SCHD", "GLD"].every(
      (ticker) => Array.isArray(state.sourceRiskHistory[ticker]?.points) && state.sourceRiskHistory[ticker].points.length >= 2,
    );
  }

  function renderSourceRiskChart(title, points, field, formatter, color) {
    if (!Array.isArray(points) || points.length < 2) {
      return `
        <div class="source-risk-card">
          <div class="source-risk-head"><strong>${title}</strong><span>데이터 부족</span></div>
          <svg class="source-risk-svg" viewBox="0 0 280 64" preserveAspectRatio="none"></svg>
          <div class="source-risk-meta">원본 스냅샷 2개 이상 필요</div>
        </div>
      `;
    }
    const series = points.map((point) => ({ date: point.date, close: Number(point[field]) }));
    const model = buildTrendCoordinates(series, 280, 64, 5);
    if (!model) {
      return `
        <div class="source-risk-card">
          <div class="source-risk-head"><strong>${title}</strong><span>데이터 부족</span></div>
          <svg class="source-risk-svg" viewBox="0 0 280 64" preserveAspectRatio="none"></svg>
          <div class="source-risk-meta">계산 가능한 값 없음</div>
        </div>
      `;
    }
    const pathData = model.coords
      .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(" ");
    const latest = series[series.length - 1].close;
    const first = series[0].close;
    const delta = latest - first;
    const deltaLabel = field === "mdd" || field === "cagr" ? formatSignedPoint(delta) : formatSignedNumber(delta);
    return `
      <div class="source-risk-card">
        <div class="source-risk-head">
          <strong>${title}</strong>
          <span>${formatter(latest)} / ${deltaLabel}</span>
        </div>
        <svg class="source-risk-svg" viewBox="0 0 280 64" preserveAspectRatio="none">
          <line x1="5" y1="${model.coords[0].y.toFixed(1)}" x2="275" y2="${model.coords[0].y.toFixed(1)}" stroke="#c6cfdb" stroke-width="1" stroke-dasharray="4 3"></line>
          <path d="${pathData}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"></path>
        </svg>
        <div class="source-risk-axis">
          <span>${series[0].date}</span>
          <span>${series[series.length - 1].date}</span>
        </div>
      </div>
    `;
  }

  function renderSourceRiskRows() {
    const container = document.getElementById("sourceRiskCharts");
    const status = document.getElementById("sourceRiskStatus");
    if (!container) return;
    const snapshots = state.sourceSnapshots || [];
    if (snapshots.length < 2) {
      container.innerHTML = `<div class="source-risk-empty">시트 원본 스냅샷이 부족합니다.</div>`;
      if (status) status.textContent = "시트 원본 스냅샷 기준";
      return;
    }

    const latest = snapshots[snapshots.length - 1];
    if (!hasSourceRiskHistory()) {
      container.innerHTML = `<div class="source-risk-empty">가격 히스토리 불러오는 중...</div>`;
      if (status) status.textContent = "원본 날짜별 포트폴리오 MDD/CAGR 계산 대기";
      return;
    }
    const points = buildSourceRiskTrendPoints();
    if (status) status.textContent = `원본 날짜별 포트폴리오 MDD/CAGR 기준 (현금 제외) / 최신 ${latest.dateLabel || formatShortDate(latest.date)}`;
    container.innerHTML =
      renderSourceRiskChart("MDD 변화", points, "mdd", (value) => `${value.toFixed(1)}%`, "#b94a48") +
      renderSourceRiskChart("CAGR 변화", points, "cagr", (value) => `${value.toFixed(1)}%`, "#147c72");
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

  function betaAgainstBenchmark(assetReturns, benchmarkReturns) {
    if (!Array.isArray(assetReturns) || !Array.isArray(benchmarkReturns)) return null;
    const length = Math.min(assetReturns.length, benchmarkReturns.length);
    if (length < 2) return null;
    const a = assetReturns.slice(-length);
    const b = benchmarkReturns.slice(-length);
    const meanA = a.reduce((sum, v) => sum + v, 0) / length;
    const meanB = b.reduce((sum, v) => sum + v, 0) / length;
    let cov = 0;
    let varB = 0;
    for (let index = 0; index < length; index += 1) {
      const da = a[index] - meanA;
      const db = b[index] - meanB;
      cov += da * db;
      varB += db * db;
    }
    return varB > 0 ? cov / varB : null;
  }

  function buildAlignedDailyReturns(historyByTicker, tickers) {
    if (tickers.some((ticker) => !Array.isArray(historyByTicker[ticker]?.points) || historyByTicker[ticker].points.length < 2)) {
      return null;
    }
    const closeByTicker = {};
    tickers.forEach((ticker) => {
      closeByTicker[ticker] = new Map(
        historyByTicker[ticker].points
          .filter((point) => Number.isFinite(Number(point.close)))
          .map((point) => [String(point.date), Number(point.close)]),
      );
    });
    const baseDates = historyByTicker[tickers[0]].points.map((point) => String(point.date));
    const commonDates = baseDates.filter((date) => tickers.every((ticker) => closeByTicker[ticker].has(date)));
    if (commonDates.length < 3) return null;
    const returns = {};
    tickers.forEach((ticker) => {
      const closes = commonDates.map((date) => closeByTicker[ticker].get(date));
      returns[ticker] = [];
      for (let index = 1; index < closes.length; index += 1) {
        returns[ticker].push(closes[index] / closes[index - 1] - 1);
      }
    });
    return { dates: commonDates.slice(1), returns };
  }

  function computeAdviceRiskDiagnostics() {
    const tickers = ["GLD", "SCHD", "SPY", "QQQ"];
    const aligned = buildAlignedDailyReturns(state.sourceRiskHistory, tickers);
    if (!aligned) {
      return {
        gldSpyCorrelation: { available: false },
        betasVsSpy: { available: false },
      };
    }
    const gldReturns = aligned.returns.GLD;
    const spyReturns = aligned.returns.SPY;
    const windows = [30, 90, 180, 365];
    const correlations = {};
    windows.forEach((window) => {
      const length = Math.min(window, gldReturns.length, spyReturns.length);
      correlations[`${window}d`] =
        length >= 2 ? pearsonCorrelation(gldReturns.slice(-length), spyReturns.slice(-length)) : null;
    });
    const corr30 = correlations["30d"];
    const corr180 = correlations["180d"];
    const expansion = Number.isFinite(corr30) && Number.isFinite(corr180) ? corr30 - corr180 : null;
    const betaWindow = Math.min(365, spyReturns.length);
    const betas = {};
    ["GLD", "QQQ", "SCHD"].forEach((ticker) => {
      const assetReturns = aligned.returns[ticker] || [];
      betas[ticker] =
        betaWindow >= 2 ? betaAgainstBenchmark(assetReturns.slice(-betaWindow), spyReturns.slice(-betaWindow)) : null;
    });
    return {
      gldSpyCorrelation: {
        available: true,
        correlations,
        expansion30dVs180d: expansion,
        interpretation:
          Number.isFinite(expansion) && expansion > 0.3
            ? "단기 상관관계 급등"
            : Number.isFinite(expansion) && expansion > 0.2
              ? "최근 분산 효과 약화"
              : "뚜렷한 단기 상관관계 확대 없음",
      },
      betasVsSpy: {
        available: true,
        windowDays: betaWindow,
        values: betas,
        note: "상관계수는 방향 유사성, 베타는 SPY 움직임 민감도를 보여줍니다.",
      },
    };
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
          <small class="corr-meta">${row.corrWindow}일 상관 / ${row.rollingWindow}일 추세 ${trendDelta}</small>
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
    const sourceRiskNext = {};
    const failures = [];

    for (const asset of state.assets) {
      try {
        const response = await fetch(`${HISTORY_URL}?ticker=${encodeURIComponent(asset.ticker)}&mode=trend&days=${state.trendWindow}`);
        if (!response.ok) throw new Error(`${asset.ticker} HTTP ${response.status}`);
        next[asset.ticker] = await response.json();
      } catch (error) {
        failures.push(`${asset.ticker}: ${error.message}`);
      }
      try {
        const response = await fetch(`${HISTORY_URL}?ticker=${encodeURIComponent(asset.ticker)}&mode=trend&days=365`);
        if (!response.ok) throw new Error(`${asset.ticker} source HTTP ${response.status}`);
        sourceRiskNext[asset.ticker] = await response.json();
      } catch (error) {
        failures.push(`${asset.ticker} source: ${error.message}`);
      }
    }

    state.trend30 = { ...state.trend30, ...next };
    state.sourceRiskHistory = { ...state.sourceRiskHistory, ...sourceRiskNext };
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
    fearLabel.textContent = "불러오는 중...";
    buffettLabel.textContent = "불러오는 중...";
    vixLabel.textContent = "불러오는 중...";

    try {
      const response = await fetch(MARKET_PULSE_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const fg = payload?.fearGreed || {};
      const bi = payload?.buffett || {};
      const vx = payload?.vix || {};

      const fearNumber = parseOptionalNumber(fg.value);
      const buffettNumber = parseOptionalNumber(bi.value);
      const vixNumber = parseOptionalNumber(vx.value);

      fearValue.textContent = Number.isFinite(fearNumber) ? Math.round(fearNumber).toString() : "--";
      fearLabel.textContent = fg.label || "N/A";
      renderPulseTrend("fearGreedTrend", "fearGreedAvg", fg.trend60, "#147c72", {
        start: "fearGreedDateStart",
        mid: "fearGreedDateMid",
        end: "fearGreedDateEnd",
      });

      buffettValue.textContent = formatPulsePercent(buffettNumber);
      buffettLabel.textContent = bi.label || "N/A";
      renderPulseTrend("buffettTrend", "buffettAvg", bi.trend60, "#2f6fbb", {
        start: "buffettDateStart",
        mid: "buffettDateMid",
        end: "buffettDateEnd",
      });

      vixValue.textContent = Number.isFinite(vixNumber) ? vixNumber.toFixed(1) : "--";
      vixLabel.textContent = vx.label || "N/A";
      renderPulseTrend("vixTrend", "vixAvg", vx.trend60, "#7b5d3a", {
        start: "vixDateStart",
        mid: "vixDateMid",
        end: "vixDateEnd",
      });
    } catch {
      fearLabel.textContent = "불러오기 실패";
      buffettLabel.textContent = "불러오기 실패";
      vixLabel.textContent = "불러오기 실패";
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
    const generateAiAdviceButton = document.getElementById("generateAiAdviceButton");
    if (generateAiAdviceButton) {
      generateAiAdviceButton.addEventListener("click", generateAiAdvice);
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
    loadActualTradesFromServer().then(syncActualTradesFromTransactionRecord);
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

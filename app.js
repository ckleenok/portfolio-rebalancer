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

  const state = {
    contribution: 400,
    assets: TARGETS.map((asset) => ({ ...asset })),
    expectedReturns: {
      GLD: 0.04,
      SCHD: 0.07,
      SPY: 0.08,
      QQQ: 0.1,
    },
  };

  const PLAN_MONTHS = 6;
  const ASSET_COLORS = {
    GLD: "#d09b2c",
    SCHD: "#147c72",
    SPY: "#2f6fbb",
    QQQ: "#7b5d3a",
  };

  function parseMoney(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const cleaned = String(value || "")
      .replace(/[^\d.-]/g, "")
      .trim();
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatMoney(value) {
    return `${Math.round(value).toLocaleString("ko-KR")}만원`;
  }

  function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
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

  function buildSixMonthPlan(assets, contribution, planMonths = PLAN_MONTHS) {
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
    const plan = buildSixMonthPlan(assets, contribution);
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
    return buildSixMonthPlan(assets, contribution, options.planMonths ?? PLAN_MONTHS);
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

  function parseLatestSheetRow(csvText) {
    const lines = String(csvText || "")
      .split(/\r?\n/)
      .map((line) => splitCsvLine(line))
      .filter((row) => row.length >= 5);

    const header = lines.find((row) => {
      const tickers = ["Date", "SPY", "QQQ", "SCHD", "GLD"];
      return tickers.every((ticker) => row.includes(ticker));
    });
    const dateColumn = header?.indexOf("Date") ?? -1;
    const columns =
      dateColumn >= 0
        ? {
            date: dateColumn,
            SPY: header.indexOf("SPY", dateColumn),
            QQQ: header.indexOf("QQQ", dateColumn),
            SCHD: header.indexOf("SCHD", dateColumn),
            GLD: header.indexOf("GLD", dateColumn),
          }
        : null;

    let latest = null;

    if (columns && Object.values(columns).every((index) => index >= 0)) {
      for (const row of lines) {
        const date = row[columns.date];
        const looksLikeDate = /^\d{2,4}\s*[.\/-]\s*\d{1,2}\s*[.\/-]?\s*\d{0,2}\.?$/.test(date);
        const values = [row[columns.SPY], row[columns.QQQ], row[columns.SCHD], row[columns.GLD]].map(parseMoney);
        if (looksLikeDate && values.every((value) => value > 0)) {
          latest = { date, SPY: values[0], QQQ: values[1], SCHD: values[2], GLD: values[3] };
        }
      }
      return latest;
    }

    for (const row of lines) {
      for (let index = 0; index <= row.length - 5; index += 1) {
        const [date, spy, qqq, schd, gld] = row.slice(index, index + 5);
        const looksLikeDate = /^\d{2,4}\s*[.\/-]\s*\d{1,2}\s*[.\/-]?\s*\d{0,2}\.?$/.test(date);
        const values = [spy, qqq, schd, gld].map(parseMoney);
        if (looksLikeDate && values.every((value) => value > 0)) {
          latest = { date, SPY: values[0], QQQ: values[1], SCHD: values[2], GLD: values[3] };
        }
      }
    }

    return latest;
  }

  function renderInputs() {
    const container = document.getElementById("assetInputs");
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
    donutTotal.textContent = formatMoney(total);

    legend.innerHTML = "";
    state.assets.forEach((asset) => {
      const percent = total > 0 ? asset.current / total : 0;
      const row = document.createElement("div");
      row.className = "legend-row";
      row.innerHTML = `
        <span class="legend-swatch" style="background: ${ASSET_COLORS[asset.ticker] || "#8190a3"}"></span>
        <strong>${asset.ticker}</strong>
        <span>${formatMoney(asset.current)}</span>
        <em>${formatPercent(percent)}</em>
      `;
      legend.appendChild(row);
    });
  }

  function render() {
    const result = allocateBuyOnly(state.assets, state.contribution);
    const maxTrade = Math.max(...result.rows.map((row) => Math.abs(row.trade)), 1);

    syncContributionInputs();
    renderHoldingsChart();
    document.getElementById("currentMetric").textContent = formatMoney(result.currentTotal);
    document.getElementById("futureMetric").textContent = formatMoney(result.futureTotal);
    document.getElementById("shortMetric").textContent = `${PLAN_MONTHS}개월`;

    const buyList = document.getElementById("buyList");
    buyList.innerHTML = "";
    result.rows
      .slice()
      .sort((a, b) => Math.abs(b.trade) - Math.abs(a.trade))
      .forEach((row) => {
        const isSell = row.trade < 0;
        const card = document.createElement("div");
        card.className = `buy-card ${isSell ? "sell-card" : ""}`;
        card.innerHTML = `
          <span class="ticker">${row.ticker}</span>
          <div>
            <div class="bar-track"><div class="bar-fill ${isSell ? "sell-fill" : ""}" style="width: ${(Math.abs(row.trade) / maxTrade) * 100}%"></div></div>
            <div class="buy-note">${isSell ? "축소 후" : "매수 후"} ${formatPercent(row.afterWeight)} / 목표 ${formatPercent(row.target)}</div>
          </div>
          <strong>${isSell ? "-" : "+"}${formatMoney(Math.abs(row.trade))}</strong>
        `;
        buyList.appendChild(card);
      });

    const warning = document.getElementById("warningBox");
    warning.hidden = false;
    warning.textContent = `이번 달 총 매수 ${formatMoney(result.allocated)}, 총 축소 ${formatMoney(result.totalSell)}입니다. 매수 금액에서 축소 금액을 뺀 순투입액은 ${formatMoney(state.contribution)}입니다.`;

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
  }

  function renderCagr() {
    const result = allocateBuyOnly(state.assets, state.contribution);
    const currentCagr = calculateExpectedCagr(state.assets);
    const firstMonthAssets = result.rows.map((row) => ({
      ticker: row.ticker,
      target: row.target,
      current: row.after,
    }));
    const firstMonthCagr = calculateExpectedCagr(firstMonthAssets);
    const targetCagr = calculateTargetExpectedCagr(state.assets);

    document.getElementById("currentCagr").textContent = formatPercent(currentCagr);
    document.getElementById("monthOneCagr").textContent = formatPercent(firstMonthCagr);
    document.getElementById("targetCagr").textContent = formatPercent(targetCagr);
  }

  function renderSimulation() {
    const months = simulateRebalancing(state.assets, state.contribution);
    const summary = document.getElementById("simulationSummary");
    const list = document.getElementById("simulationList");

    if (!summary || !list) return;

    summary.textContent = `${PLAN_MONTHS}개월차에 목표 비중 도달`;

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
    ["contributionInput", "contributionMetricInput"].forEach((id) => {
      const input = document.getElementById(id);
      if (input && document.activeElement !== input) {
        input.value = Math.round(state.contribution).toLocaleString("ko-KR");
      }
    });
  }

  function updateContribution(value) {
    state.contribution = parseMoney(value);
    render();
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
    renderInputs();
    bindAssetInputs();
    render();

    document.getElementById("contributionInput").addEventListener("input", (event) => updateContribution(event.target.value));
    document
      .getElementById("contributionMetricInput")
      .addEventListener("input", (event) => updateContribution(event.target.value));

    document.getElementById("loadSheetButton").addEventListener("click", loadSheet);
    document.getElementById("loadHistoryButton").addEventListener("click", loadHistoricalReturns);
    loadHistoricalReturns();
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

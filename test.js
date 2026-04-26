const assert = require("assert");
const {
  allocateBuyOnly,
  calculateExpectedCagr,
  calculateMovingAverageCagr,
  calculateTargetExpectedCagr,
  parseLatestSheetRow,
  parseMoney,
  simulateRebalancing,
} = require("./app.js");

const assets = [
  { ticker: "GLD", target: 0.41, current: 7730 },
  { ticker: "SCHD", target: 0.07, current: 3289 },
  { ticker: "SPY", target: 0.22, current: 5918 },
  { ticker: "QQQ", target: 0.30, current: 6431 },
];

const result = allocateBuyOnly(assets, 400);
const trades = Object.fromEntries(result.rows.map((row) => [row.ticker, Math.round(row.trade)]));

assert.deepStrictEqual(trades, {
  GLD: 472,
  SCHD: -248,
  SPY: -42,
  QQQ: 217,
});
assert.strictEqual(Math.round(result.allocated), 689);
assert.strictEqual(Math.round(result.totalSell), 289);
assert.strictEqual(Math.round(result.allocated - result.totalSell), 400);

const simulation = simulateRebalancing(assets, 400);
assert.strictEqual(simulation.at(-1).month, 6);
assert.strictEqual(simulation.at(-1).reached, true);
assert.strictEqual(simulation.at(-1).maxGap, 0);

const expectedReturns = { GLD: 0.04, SCHD: 0.07, SPY: 0.08, QQQ: 0.1 };
assert.strictEqual(calculateExpectedCagr(assets, expectedReturns).toFixed(4), "0.0709");
assert.strictEqual(calculateTargetExpectedCagr(assets, expectedReturns).toFixed(4), "0.0689");

const movingAverage = calculateMovingAverageCagr([
  { date: "2024-01-31", close: 100 },
  { date: "2024-02-29", close: 101 },
  { date: "2024-03-31", close: 102.01 },
]);
assert.strictEqual(movingAverage.monthsUsed, 2);
assert.strictEqual(movingAverage.cagr.toFixed(4), "0.1268");

const csv = `Date,SPY,QQQ,SCHD,GLD,Cash/Bond
26.3.12,"5,277","5,341","3,270","7,922","2,122"
26.4.16,"5,918","6,431","3,289","7,730","1,420"
3.0%,배당,배당성장,,,,,,,,,,,0,0.0%,,26.4.16,"5,918","6,431","3,289","7,730","1,420",23.87%,25.94%,13.26%,31.18%,5.72%`;
const latest = parseLatestSheetRow(csv);
assert.deepStrictEqual(latest, { date: "26.4.16", SPY: 5918, QQQ: 6431, SCHD: 3289, GLD: 7730 });

assert.strictEqual(parseMoney("₩29,762"), 29762);
assert.strictEqual(parseMoney("400만원"), 400);

console.log("All tests passed");

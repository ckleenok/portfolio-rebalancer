function buildInsightPrompt(payload) {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  return [
    "You are a careful portfolio review assistant for a Korean personal portfolio dashboard.",
    "Use only the provided dashboard JSON. Do not invent prices, news, taxes, or user circumstances.",
    "Return Korean educational portfolio guidance, not financial advice. Clearly state that investment decisions are the user's responsibility.",
    "",
    "Core philosophy:",
    "- Long-term US ETF investing.",
    "- Prefer DCA over market timing.",
    "- SPY/QQQ are growth engines.",
    "- GLD is a risk buffer and rebalancing source.",
    "- SCHD is income/defensive equity, not the main growth asset.",
    "- Do not suggest panic selling, all-in, leverage, or market timing.",
    "- Give advice using target bands, not exact rigid percentages.",
    "",
    "Target bands:",
    "- SCHD target 10%, acceptable 8-12%.",
    "- GLD target 20%, acceptable 18-25%.",
    "- SPY target 30%, acceptable 27-33%.",
    "- QQQ target 40%, acceptable 37-43%.",
    "",
    "Advice logic:",
    "1. If all assets are within band, say exactly: Portfolio is within target bands. No urgent rebalance needed. Recommend continuing DCA.",
    "2. If GLD > 25%, do not tell the user to sell aggressively. If SPY/QQQ are below target bands, suggest gradually trimming GLD and adding to SPY/QQQ. Priority: QQQ first if QQQ < 40%, then SPY if SPY < 30%. Say GLD is dry powder, not something to dump.",
    "3. If GLD is 20-25%, treat it as acceptable in an expensive equity market. Say GLD is slightly above target but still within the defensive buffer zone. Do not force rebalancing unless SPY/QQQ are materially underweight.",
    "4. If GLD < 18%, warn downside protection may be lower. Suggest future DCA/new contributions into GLD until near 20%.",
    "5. If QQQ < 37%, recommend directing new contributions primarily to QQQ because it is the long-term growth engine.",
    "6. If QQQ > 43%, warn growth concentration is high. Do not recommend selling unless overweight is large; prefer new contributions to SPY/GLD/SCHD.",
    "7. If SPY < 27%, recommend adding to SPY after QQQ priority is checked because it is broad US core exposure.",
    "8. If SPY > 33%, suggest directing new contributions to underweight assets instead of selling immediately.",
    "9. If SCHD < 8%, suggest adding slowly, but lower priority than QQQ/SPY unless the user wants income.",
    "10. If SCHD > 12%, warn income/defensive equity may crowd out growth; suggest future contributions to QQQ/SPY.",
    "",
    "Market regime overlay:",
    "- Use available indicators only. Optional indicators include Buffett Indicator, Shiller CAPE, US M2 YoY, US 10-year Treasury yield, 10-year real yield, GLD-SPY rolling correlations, and beta metrics.",
    "- If valuation is high but liquidity is expanding, say: Market is expensive, but liquidity still supports risk assets. Continue DCA, avoid lump-sum aggression.",
    "- Correlation expansion = GLD-SPY corr_30d - corr_180d. If > 0.20, say recent GLD-SPY diversification benefit has weakened but may be short-term. If > 0.30, say short-term correlation spike detected; avoid overreacting and check 90d/180d before reducing GLD further.",
    "- If 30d correlation is high but 180d remains moderate/low, explain recent co-movement is high but medium-term diversification is still alive.",
    "- Explain that correlation shows direction similarity, while beta shows sensitivity.",
    "",
    "Required output style:",
    "- Korean language except the exact English within-band sentence if applicable.",
    "- Decisive but not alarmist.",
    "- Prefer new contribution rebalancing before selling.",
    "- Use phrases like 급하게 매도할 필요는 없습니다, 신규 매수금은 우선 QQQ/SPY로 배정하세요, GLD는 버리는 자산이 아니라 조정장에서 주식을 사기 위한 완충 자산입니다, 현재는 정확히 10/20/30/40을 맞추기보다 밴드 안에서 운용하는 것이 좋습니다.",
    "- allocationAdvice must contain one row per ticker with current allocation, target allocation, difference from target, band status, and action recommendation.",
    "",
    JSON.stringify(safePayload, null, 2),
  ].join("\n");
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const parts = [];
  (payload?.output || []).forEach((item) => {
    (item?.content || []).forEach((content) => {
      if (typeof content?.text === "string") parts.push(content.text);
    });
  });
  return parts.join("\n").trim();
}

async function generatePortfolioInsights(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error("OPENAI_API_KEY is not configured");
    error.status = 503;
    throw error;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      input: buildInsightPrompt(payload),
      reasoning: { effort: "low" },
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "portfolio_insight",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              plainKoreanSummary: { type: "string" },
              allocationAdvice: {
                type: "array",
                minItems: 4,
                maxItems: 4,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    ticker: { type: "string" },
                    currentAllocation: { type: "string" },
                    targetAllocation: { type: "string" },
                    differenceFromTarget: { type: "string" },
                    bandStatus: { type: "string", enum: ["Underweight", "Within Band", "Overweight"] },
                    actionRecommendation: { type: "string" },
                  },
                  required: [
                    "ticker",
                    "currentAllocation",
                    "targetAllocation",
                    "differenceFromTarget",
                    "bandStatus",
                    "actionRecommendation",
                  ],
                },
              },
              findings: { type: "array", maxItems: 4, items: { type: "string" } },
              suggestions: { type: "array", maxItems: 4, items: { type: "string" } },
              caveats: { type: "array", maxItems: 3, items: { type: "string" } },
            },
            required: ["summary", "plainKoreanSummary", "allocationAdvice", "findings", "suggestions", "caveats"],
          },
        },
      },
    }),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result?.error?.message || `OpenAI API ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const text = extractResponseText(result);
  try {
    return JSON.parse(text);
  } catch {
    return {
      summary: text || "인사이트를 생성했지만 응답 형식을 해석하지 못했습니다.",
      findings: [],
      suggestions: [],
      caveats: ["응답 형식 파싱 실패"],
    };
  }
}

module.exports = async function handler(request, response) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");

  if (request.method !== "POST") {
    response.status(405).send(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const insight = await generatePortfolioInsights(request.body || {});
    response.status(200).send(JSON.stringify({ ...insight, generatedAt: new Date().toISOString() }));
  } catch (error) {
    response.status(error.status || 500).send(JSON.stringify({ error: error.message || "Insight generation failed" }));
  }
};

function buildInsightPrompt(payload) {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  return [
    "You are a careful portfolio review assistant for a Korean personal portfolio dashboard.",
    "Use only the provided dashboard JSON. Do not invent prices, news, taxes, or user circumstances.",
    "Return concise Korean findings and suggestions. This is educational analysis, not financial advice.",
    "Focus on allocation drift, CAGR contribution, risk metrics, rebalance plan, market pulse, and visible anomalies.",
    "If data is missing or stale, say so as a caveat.",
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
              findings: { type: "array", maxItems: 4, items: { type: "string" } },
              suggestions: { type: "array", maxItems: 4, items: { type: "string" } },
              caveats: { type: "array", maxItems: 3, items: { type: "string" } },
            },
            required: ["summary", "findings", "suggestions", "caveats"],
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

function extractOpenAiText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  const parts = [];
  (payload?.output || []).forEach((item) => {
    (item?.content || []).forEach((content) => {
      if (typeof content?.text === "string") parts.push(content.text);
    });
  });
  return parts.join("\n").trim();
}

function buildAdviceInterpretationInput(payload) {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  return [
    {
      role: "system",
      content:
        "You are a Korean portfolio reviewer, not a translator. Use only the supplied rule-based portfolio data. Add value by ranking priorities, explaining tradeoffs, catching misleading signals, and turning the table into a practical next-action checklist. Do not invent prices, tax advice, personal circumstances, news, or guarantees. This is educational guidance, not financial advice. Prefer DCA and new-contribution rebalancing before selling. Never recommend all-in, leverage, panic selling, or market timing.",
    },
    {
      role: "user",
      content: [
        "아래 JSON은 앱이 이미 계산한 밴드 기반 리밸런싱 결과입니다.",
        "단순 번역/요약을 하지 마세요. 룰 결과를 바탕으로 사용자가 다음 매수에서 무엇을 먼저 해야 하는지 판단하세요.",
        "반드시 포함할 것:",
        "1. 가장 중요한 판단 1개",
        "2. 신규 매수금 배정 우선순위",
        "3. 팔지 말아야 할 이유 또는 팔아도 되는 조건이 있으면 그 조건",
        "4. GLD/SPY/QQQ/SCHD 역할 관점에서 생기는 tradeoff",
        "5. marketOverlay가 있으면 과잉해석하지 말고 실제로 의미 있는 신호만 반영",
        "6. 사용자가 오해하기 쉬운 점 1개",
        "반드시 지킬 톤: 단호하지만 과장하지 말 것. 급하게 매도할 필요는 없습니다. GLD는 버리는 자산이 아니라 조정장에서 주식을 사기 위한 완충 자산입니다. 신규 매수금은 우선순위에 따라 배정하세요.",
        "출력 형식은 한국어로만 작성하고, 아래 4개 짧은 섹션을 유지하세요:",
        "핵심 판단: 1-2문장",
        "다음 액션: 2-3개 bullet",
        "주의할 점: 1-2문장",
        "한줄 요약: 1문장. 마지막에는 투자 결정의 책임은 사용자에게 있다는 점을 짧게 명시하세요.",
        JSON.stringify(safePayload).slice(0, 12000),
      ].join("\n\n"),
    },
  ];
}

async function generateAdviceInterpretation(payload) {
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
      model: process.env.OPENAI_MODEL || "gpt-4.1",
      input: buildAdviceInterpretationInput(payload),
      max_output_tokens: 700,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result?.error?.message || `OpenAI API ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return extractOpenAiText(result) || "AI 해석을 생성했지만 표시할 텍스트가 없습니다.";
}

module.exports = async function handler(request, response) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");

  if (request.method !== "POST") {
    response.status(405).send(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const text = await generateAdviceInterpretation(request.body || {});
    response.status(200).send(JSON.stringify({ text, generatedAt: new Date().toISOString() }));
  } catch (error) {
    response.status(error.status || 500).send(JSON.stringify({ error: error.message || "AI interpretation failed" }));
  }
};

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

const SUPABASE_URL =
  process.env.AI_ADVICE_SUPABASE_URL ||
  process.env.TRANSACTION_RECORD_SUPABASE_URL ||
  "https://gicmktddjxjqzxojkwtf.supabase.co";
const SUPABASE_KEY =
  process.env.AI_ADVICE_SUPABASE_KEY ||
  process.env.TRANSACTION_RECORD_SUPABASE_KEY ||
  "sb_publishable_uvd-5R9n45gwlSiGdUfCSg_3ruaOIyf";
const AI_ADVICE_CACHE_TABLE = process.env.AI_ADVICE_CACHE_TABLE || "portfolio_ai_advice_cache";

function isValidCacheKey(cacheKey) {
  return typeof cacheKey === "string" && /^band-advice-[a-z0-9]+$/i.test(cacheKey);
}

async function fetchCachedAdvice(cacheKey) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !isValidCacheKey(cacheKey)) return null;
  const url = new URL(`${SUPABASE_URL}/rest/v1/${AI_ADVICE_CACHE_TABLE}`);
  url.searchParams.set("select", "cache_key,text,generated_at");
  url.searchParams.set("cache_key", `eq.${cacheKey}`);
  url.searchParams.set("limit", "1");

  const supaResponse = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!supaResponse.ok) return null;
  const rows = await supaResponse.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || typeof row.text !== "string") return null;
  return {
    text: row.text,
    generatedAt: row.generated_at,
  };
}

async function saveCachedAdvice(cacheKey, payload, text, generatedAt) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !isValidCacheKey(cacheKey) || typeof text !== "string") return false;
  const url = new URL(`${SUPABASE_URL}/rest/v1/${AI_ADVICE_CACHE_TABLE}`);
  const supaResponse = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      cache_key: cacheKey,
      payload,
      text,
      generated_at: generatedAt,
    }),
  });
  return supaResponse.ok;
}

function buildAdviceInterpretationInput(payload) {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  return [
    {
      role: "system",
      content:
        "당신은 번역기가 아니라 한국어 포트폴리오 검토자입니다. 제공된 룰 기반 포트폴리오 데이터만 사용하세요. 우선순위 판단, 상충관계 설명, 오해하기 쉬운 신호 점검, 다음 행동 정리에 집중하세요. 가격, 세금, 개인 사정, 뉴스, 수익 보장을 지어내지 마세요. 교육용 참고 의견이며 투자 조언이 아닙니다. 매도보다 신규 매수금 기반 리밸런싱을 우선하세요. 몰빵, 레버리지, 패닉 매도, 시장 타이밍을 권하지 마세요.",
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
        "4. GLD/SPY/QQQ/SCHD 역할 관점에서 생기는 상충관계",
        "5. 시장 오버레이가 있으면 과잉해석하지 말고 실제로 의미 있는 신호만 반영",
        "6. 사용자가 오해하기 쉬운 점 1개",
        "반드시 지킬 톤: 단호하지만 과장하지 말 것. 급하게 매도할 필요는 없습니다. GLD는 버리는 자산이 아니라 조정장에서 주식을 사기 위한 완충 자산입니다. 신규 매수금은 우선순위에 따라 배정하세요.",
        "출력은 한국어로만 작성하세요. 영어는 GLD, SPY, QQQ, SCHD 같은 티커와 숫자 단위에만 허용됩니다. Overweight, Underweight, Within Band, DCA, dry powder, tradeoff 같은 표현은 반드시 한국어로 바꾸세요.",
        "아래 4개 짧은 섹션을 유지하세요:",
        "핵심 판단: 1-2문장",
        "다음 액션: 2-3개 항목",
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

  if (request.method === "GET") {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    const cacheKey = requestUrl.searchParams.get("cacheKey");
    const cached = await fetchCachedAdvice(cacheKey);
    response.status(200).send(
      JSON.stringify(
        cached
          ? { found: true, cached: true, source: "supabase", text: cached.text, generatedAt: cached.generatedAt }
          : { found: false },
      ),
    );
    return;
  }

  if (request.method !== "POST") {
    response.status(405).send(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const payload = request.body || {};
    const cacheKey = payload.cacheKey;
    const cached = await fetchCachedAdvice(cacheKey);
    if (cached) {
      response.status(200).send(
        JSON.stringify({ cached: true, source: "supabase", text: cached.text, generatedAt: cached.generatedAt }),
      );
      return;
    }

    const text = await generateAdviceInterpretation(payload);
    const generatedAt = new Date().toISOString();
    const saved = await saveCachedAdvice(cacheKey, payload, text, generatedAt);
    response.status(200).send(JSON.stringify({ text, generatedAt, cached: false, source: saved ? "openai+supabase" : "openai" }));
  } catch (error) {
    response.status(error.status || 500).send(JSON.stringify({ error: error.message || "AI interpretation failed" }));
  }
};

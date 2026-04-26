export default function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({
        ok: true,
        message: "API is working. Send POST request to calculate rebalance."
      });
    }

    const { holdings, target } = req.body;

    if (!holdings || !target) {
      return res.status(400).json({
        ok: false,
        error: "Missing holdings or target data"
      });
    }

    const totalValue = holdings.reduce((sum, item) => {
      return sum + Number(item.value || 0);
    }, 0);

    const result = holdings.map((item) => {
      const name = item.name;
      const currentValue = Number(item.value || 0);
      const targetWeight = Number(target[name] || 0);

      const targetValue = totalValue * (targetWeight / 100);
      const difference = targetValue - currentValue;

      return {
        name,
        currentValue,
        targetWeight,
        targetValue: Math.round(targetValue),
        difference: Math.round(difference),
        action: difference > 0 ? "BUY" : difference < 0 ? "SELL" : "HOLD"
      };
    });

    return res.status(200).json({
      ok: true,
      totalValue,
      result
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}

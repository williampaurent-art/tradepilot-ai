const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=UTF-8",
    },
  });
}

function extractPeriods(idea) {
  // Reconnaît par exemple :
  // "moyenne mobile 10 croise moyenne mobile 20"
  // "MM 10 et MM 20"
  // "EMA 10 croise EMA 20"
  const text = idea.toLowerCase();

  const patterns = [
    /(?:moyenne[s]? mobile[s]?|mm|ema|sma|ma)\s*(?:de\s*)?(\d+)[\s\S]{0,100}?(?:moyenne[s]? mobile[s]?|mm|ema|sma|ma)\s*(?:de\s*)?(\d+)/i,
    /(\d+)\s*(?:et|contre|\/|,)\s*(\d+)\s*(?:périodes?|periods?)?/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const fast = Number(match[1]);
      const slow = Number(match[2]);

      if (
        Number.isInteger(fast) &&
        Number.isInteger(slow) &&
        fast >= 1 &&
        slow >= 2 &&
        fast < slow &&
        slow <= 1000
      ) {
        return { fast, slow };
      }
    }
  }

  return null;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return jsonResponse({
        status: "ok",
        application: "TradePilot AI",
        mode: "demo",
        trading_enabled: false,
      });
    }

    if (
      url.pathname === "/api/strategies/drafts" &&
      request.method === "POST"
    ) {
      let body;

      try {
        body = await request.json();
      } catch {
        return jsonResponse(
          { status: "error", message: "Le corps de la requête doit être du JSON valide." },
          400
        );
      }

      const idea = String(body.description || "").trim();
      const symbol = String(body.symbol || "EUR_USD")
        .trim()
        .toUpperCase()
        .slice(0, 30);
      const timeframe = String(body.timeframe || "M15")
        .trim()
        .toUpperCase()
        .slice(0, 10);

      if (!idea) {
        return jsonResponse(
          { status: "error", message: "Décris ta stratégie avant de continuer." },
          400
        );
      }

      const periods = extractPeriods(idea);

      if (!periods) {
        return jsonResponse(
          {
            status: "needs_configuration",
            message:
              "Je n'ai pas pu identifier deux périodes valides. Écris par exemple : moyenne mobile 10 croise moyenne mobile 20.",
            original_idea: idea,
            live_trading: false,
          },
          400
        );
      }

      const strategy = {
        name: String(body.name || "Ma stratégie").slice(0, 100),
        symbol,
        timeframe,
        type: "trend_following",
        entry_rules: {
          buy: `La moyenne mobile rapide ${periods.fast} croise au-dessus de la moyenne mobile lente ${periods.slow}.`,
          sell: `La moyenne mobile rapide ${periods.fast} croise au-dessous de la moyenne mobile lente ${periods.slow}.`,
        },
        parameters: {
          fast_ma_period: periods.fast,
          slow_ma_period: periods.slow,
          ma_type: "EMA",
          stop_loss_pips: 20,
          take_profit_pips: 40,
        },
        risk_management: {
          risk_per_trade_percent: 1,
          max_open_positions: 1,
        },
        original_idea: idea,
        status: "draft",
        backtest_completed: false,
        live_trading: false,
      };

      return jsonResponse({
        status: "draft_created",
        strategy,
        backtest_status: "not_started",
        live_trading: false,
      });
    }

    return jsonResponse(
      { status: "error", message: "Route introuvable." },
      404
    );
  },
};

    

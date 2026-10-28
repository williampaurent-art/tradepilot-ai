const allowedOrigin = "https://williampaurent-art.github.io";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
      "Vary": "Origin"
    }
  });
}

function buildStrategy(idea, name, symbol, timeframe) {
  const text = idea.toLowerCase();

  if (
    text.includes("moyenne mobile") ||
    text.includes("croisement") ||
    text.includes("moving average")
  ) {
    return {
      name: name || "Croisement de moyennes mobiles",
      symbol: symbol || "EURUSD",
      timeframe: timeframe || "M15",
      type: "trend_following",
      entry_rules: {
        buy: "La moyenne mobile rapide croise au-dessus de la lente.",
        sell: "La moyenne mobile rapide croise au-dessous de la lente."
      },
      parameters: {
        fast_ma_period: 20,
        slow_ma_period: 50,
        ma_type: "EMA",
        stop_loss_pips: 20,
        take_profit_pips: 40
      },
      risk_management: {
        risk_per_trade_percent: 1,
        max_open_positions: 1
      },
      original_idea: idea,
      status: "draft",
      backtest_completed: false,
      live_trading: false
    };
  }

  return {
    name: name || "Brouillon de stratégie",
    symbol: symbol || "EURUSD",
    timeframe: timeframe || "M15",
    original_idea: idea,
    status: "needs_configuration",
    message: "Cette idée nécessite des règles de trading plus précises.",
    backtest_completed: false,
    live_trading: false
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Vary": "Origin"
        }
      });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        status: "ok",
        application: "TradePilot AI",
        mode: "demo",
        trading_enabled: false
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
        return json({
          status: "error",
          message: "Le contenu envoyé doit être au format JSON."
        }, 400);
      }

      const idea = typeof body.description === "string"
        ? body.description.trim()
        : "";

      if (idea.length < 5 || idea.length > 2000) {
        return json({
          status: "error",
          message: "La description doit contenir entre 5 et 2000 caractères."
        }, 400);
      }

      const strategy = buildStrategy(
        idea,
        body.name,
        body.symbol,
        body.timeframe
      );

      return json({
        status: "draft_created",
        strategy,
        backtest_status: "not_started",
        live_trading: false
      });
    }

    return json({
      message: "TradePilot AI API",
      trading_enabled: false
    }, 404);
  }
};

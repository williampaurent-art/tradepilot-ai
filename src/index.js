
const allowedOrigin = "https://williampaurent-art.github.io";

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);
    let body;

    if (url.pathname === "/api/health" && request.method === "GET") {
      body = {
        status: "ok",
        application: "TradePilot AI",
        mode: "demo",
        trading_enabled: false
      };
    } else {
      body = {
        message: "TradePilot AI API",
        trading_enabled: false
      };
    }

    return Response.json(body, {
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-store"
      }
    });
  }
};

export default {
async fetch(request, env, ctx) {
const url = new URL(request.url);

if (url.pathname === "/api/health") {
  return Response.json({
    status: "ok",
    application: "TradePilot AI",
    mode: "demo",
    trading_enabled: false
  });
}
return new Response(
  "TradePilot AI est en ligne. Le moteur IA et le trading réel ne sont pas encore activés.",
  {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  }
);

}
};

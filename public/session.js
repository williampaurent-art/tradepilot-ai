(() => {
  const KEY = "tradepilot_auth_session";
  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); }
    catch { return null; }
  };
  const save = value => localStorage.setItem(KEY, JSON.stringify({
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: Date.now() + Number(value.expires_in || 3600) * 1000
  }));
  async function config() {
    const response = await fetch("/api/public-config", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Configuration Supabase indisponible.");
    return data;
  }
  async function accessToken() {
    let session = read();
    if (!session?.access_token) {
      const next = location.pathname.includes("builder") ? "builder" : "bots";
      location.replace("/auth.html?next=" + next);
      throw new Error("Connexion requise.");
    }
    if (Number(session.expires_at || 0) > Date.now() + 60000) return session.access_token;
    if (!session.refresh_token) {
      localStorage.removeItem(KEY);
      location.replace("/auth.html");
      throw new Error("Session expirée. Reconnecte-toi.");
    }
    try {
      const cfg = await config();
      const response = await fetch(cfg.supabaseUrl + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { "content-type": "application/json", apikey: cfg.publishableKey },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      const data = await response.json();
      if (!response.ok || !data.access_token) throw new Error(data.msg || data.message || "Renouvellement de session refusé.");
      save(data);
      session = read();
      return session.access_token;
    } catch (error) {
      localStorage.removeItem(KEY);
      location.replace("/auth.html");
      throw error;
    }
  }
  async function api(path, options = {}) {
    const token = await accessToken();
    const headers = new Headers(options.headers || {});
    headers.set("authorization", "Bearer " + token);
    if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(path, { ...options, headers, cache: "no-store" });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || data.ok === false) throw new Error(data.error || "Requête TradePilot refusée (" + response.status + ").");
    return data;
  }
  window.TradePilotSession = { api, accessToken };
})();
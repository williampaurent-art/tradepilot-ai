import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const factorySource = workerSource.replace("export default {", "const __worker = {");
const engine = new Function(factorySource + "; return { evaluateConfiguredBot, validateBotConfig };")();

function config(overrides = {}) {
  return engine.validateBotConfig({
    name: "Test Gold",
    symbol: "XAUUSD",
    style: "scalping",
    timeframe: "M5",
    capital: 1000,
    riskPercent: 0.5,
    dailyLossPercent: 2,
    maxPositions: 1,
    indicators: ["EMA 9/21", "MACD", "Structure / liquidité", "ATR 14"],
    direction: "Achats et ventes",
    ...overrides
  });
}

function candles(direction = "up") {
  const now = Date.now();
  const interval = 300000;
  const end = Math.floor(now / interval) * interval;
  const rows = [];
  for (let i = 0; i < 240; i++) {
    const drift = direction === "up" ? i * 0.12 : direction === "down" ? -i * 0.12 : 0;
    const close = 4000 + drift;
    const open = close - (direction === "down" ? -0.04 : 0.04);
    rows.push({
      time: end - (240 - i) * interval,
      open,
      high: Math.max(open, close) + 0.16,
      low: Math.min(open, close) - 0.12,
      close,
      isOpen: false
    });
  }
  if (direction === "up") {
    rows.at(-1).close += 1.2;
    rows.at(-1).high = rows.at(-1).close + 0.1;
  }
  if (direction === "down") {
    rows.at(-1).close -= 1.2;
    rows.at(-1).low = rows.at(-1).close - 0.1;
  }
  return rows;
}

const quote = {
  bid: 4000,
  ask: 4000.2,
  mid: 4000.1,
  spread: 0.2,
  timestamp: new Date().toISOString(),
  quoteAgeSeconds: 1,
  source: "test"
};

test("rejects a strategy with fewer than two directional indicators", () => {
  assert.throws(() => config({ indicators: ["EMA 9/21", "ATR 14"] }), /deux indicateurs directionnels/);
});

test("produces a buy setup from aligned bullish indicators", () => {
  const result = engine.evaluateConfiguredBot(config(), candles("up"), quote);
  assert.equal(result.signal, "ACHAT");
  assert.ok(result.score >= result.threshold);
  assert.ok(result.stopLoss < result.entry);
  assert.ok(result.takeProfit > result.entry);
  assert.equal(result.riskReward, 1.8);
  assert.match(result.execution, /AUCUN ORDRE REEL/);
});

test("produces a sell setup from aligned bearish indicators", () => {
  const result = engine.evaluateConfiguredBot(config(), candles("down"), quote);
  assert.equal(result.signal, "VENTE");
  assert.ok(result.score >= result.threshold);
  assert.ok(Array.isArray(result.indicatorDiagnostics));
  assert.deepEqual(result.indicatorDiagnostics.map(x => x.name), config().indicators);
  assert.ok(result.indicatorDiagnostics.every(x => x.status && x.explanation && x.value));
  assert.ok(result.stopLoss > result.entry);
  assert.ok(result.takeProfit < result.entry);
});

test("ATR only blocks entries when the user selected it as a filter", () => {
  const noAtrFilter = config({
    indicators: ["EMA 9/21", "MACD", "Structure / liquidité"]
  });
  const extremeVolatilityQuote = { ...quote, mid: 1 };
  const withoutAtr = engine.evaluateConfiguredBot(noAtrFilter, candles("up"), extremeVolatilityQuote);
  assert.equal(withoutAtr.signal, "ACHAT");

  const withAtrFilter = engine.evaluateConfiguredBot(config(), candles("up"), extremeVolatilityQuote);
  assert.equal(withAtrFilter.signal, "ATTENDRE");
  assert.equal(withAtrFilter.candidateScores.buy, 0);
});

test("respects a buy-only strategy", () => {
  const result = engine.evaluateConfiguredBot(
    config({ direction: "Achats uniquement" }),
    candles("down"),
    quote
  );
  assert.notEqual(result.signal, "VENTE");
  assert.equal(result.side, null);
});

test("does not invent a direction in a flat market", () => {
  const result = engine.evaluateConfiguredBot(config(), candles("flat"), quote);
  assert.equal(result.signal, "ATTENDRE");
  assert.equal(result.stopLoss, null);
  assert.equal(result.takeProfit, null);
});


test("customer bot pages contain syntactically valid browser scripts", async () => {
  for (const path of ["../public/index.html", "../public/bots.html", "../public/builder.html"]) {
    const html = await readFile(new URL(path, import.meta.url), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length > 0, `${path} should contain an inline application script`);
    for (const match of scripts) {
      assert.doesNotThrow(() => new Function(match[1]), `${path} inline script should parse`);
    }
  }
  const sessionSource = await readFile(new URL("../public/session.js", import.meta.url), "utf8");
  assert.doesNotThrow(() => new Function(sessionSource), "shared session helper should parse");
});

test("cloud bot lifecycle endpoints are workspace-scoped and read-only for execution", () => {
  assert.match(workerSource, /handleUpdateBot/);
  assert.match(workerSource, /handleSetBotStatus/);
  assert.match(workerSource, /handleDeleteBot/);
  assert.match(workerSource, /handleAnalyzeStoredBot/);
  assert.match(workerSource, /processActiveCustomerBots/);
  assert.match(workerSource, /customerBotExecution = await processActiveCustomerBots/);
  assert.match(workerSource, /last_evaluated_at/);
  assert.match(workerSource, /LIMIT 20/);
  assert.match(workerSource, /WHERE id = \? AND workspace_id = \?/);
  assert.match(workerSource, /liveTrading:\s*false/);
  assert.match(workerSource, /AUCUN ORDRE RÉEL|AUCUN ORDRE REEL/);
});


const security = new Function(factorySource + "; return { allowedCorsOrigin, withCors, consumeWorkspaceRateLimit, readBoundedJson };")();
test("CORS allows same-origin and explicitly configured origins only", () => {
  const same = new Request("https://tradepilot.example/api/bots", { headers: { Origin: "https://tradepilot.example" } });
  const foreign = new Request("https://tradepilot.example/api/bots", { headers: { Origin: "https://attacker.example" } });
  assert.equal(security.allowedCorsOrigin(same, {}), "https://tradepilot.example");
  assert.equal(security.allowedCorsOrigin(foreign, {}), null);
  const configured = new Request("https://tradepilot.example/api/bots", { headers: { Origin: "https://app.tradepilot.example" } });
  assert.equal(security.allowedCorsOrigin(configured, { CORS_ALLOWED_ORIGINS: "https://app.tradepilot.example" }), "https://app.tradepilot.example");
  assert.equal(security.withCors(new Response("ok"), same, {}).headers.get("access-control-allow-origin"), "https://tradepilot.example");
  assert.equal(security.withCors(new Response("ok"), foreign, {}).headers.get("access-control-allow-origin"), null);
});
test("workspace rate limits are isolated between tenants and fail closed without KV", async () => {
  const values = new Map();
  const env = { TP_STATE: { async get(key) { return values.get(key) ?? null; }, async put(key, value) { values.set(key, value); } } };
  assert.equal((await security.consumeWorkspaceRateLimit(env, "workspace-a", "assistant", 2, 600)).ok, true);
  assert.equal((await security.consumeWorkspaceRateLimit(env, "workspace-a", "assistant", 2, 600)).ok, true);
  const blocked = await security.consumeWorkspaceRateLimit(env, "workspace-a", "assistant", 2, 600);
  assert.equal(blocked.ok, false); assert.equal(blocked.status, 429);
  assert.equal((await security.consumeWorkspaceRateLimit(env, "workspace-b", "assistant", 2, 600)).ok, true);
  const unavailable = await security.consumeWorkspaceRateLimit({}, "workspace-a", "assistant", 2, 600);
  assert.equal(unavailable.ok, false); assert.equal(unavailable.status, 503);
});
test("AI chat and standalone bot analysis require an authenticated workspace", () => {
  const assistant = workerSource.slice(workerSource.indexOf("async function handleAssistantChat"), workerSource.indexOf("async function handleTelegramTest"));
  const botAnalyze = workerSource.slice(workerSource.indexOf("async function handleBotAnalyze"), workerSource.indexOf("async function handleBotMarket"));
  assert.match(assistant, /getAuthenticatedWorkspace\(request, env\)/);
  assert.match(assistant, /consumeWorkspaceRateLimit\(env, access\.workspace\.id/);
  assert.match(botAnalyze, /getAuthenticatedWorkspace\(request, env\)/);
  assert.match(botAnalyze, /consumeWorkspaceRateLimit\(env, access\.workspace\.id/);
});

test("Worker does not emit wildcard CORS", () => {
  assert.doesNotMatch(workerSource, /access-control-allow-origin["']?\\s*:\\s*["']\\*["']/i);
});

test("customer bot write and stored-analysis endpoints use workspace-scoped limits", () => {
  const names = [
    "handleCreateBot", "handleUpdateBot", "handleSetBotStatus",
    "handleDeleteBot", "handleAnalyzeStoredBot"
  ];
  for (const name of names) {
    const start = workerSource.indexOf("async function " + name);
    assert.notEqual(start, -1, name + " should exist");
    const next = workerSource.indexOf("\nasync function ", start + 1);
    const block = workerSource.slice(start, next < 0 ? workerSource.length : next);
    assert.match(block, /getAuthenticatedWorkspace\(request, env\)/, name + " should authenticate");
    assert.match(block, /workspaceRateLimitResponse\(env, access\.workspace\.id/, name + " should rate-limit its workspace");
  }
});
test("assistant API rejects non-POST requests and bounds request bytes", () => {
  const start = workerSource.indexOf("async function handleAssistantChat");
  const end = workerSource.indexOf("async function handleTelegramTest", start);
  const block = workerSource.slice(start, end);
  assert.match(block, /request\.method !== "POST"/);
  assert.match(block, /MAX_ASSISTANT_REQUEST_BYTES = 256_000/);
});

test("customer bot APIs reject oversized and malformed JSON bodies", async () => {
  const tooLarge = await security.readBoundedJson(new Request("https://tradepilot.example", { method: "POST", body: JSON.stringify({ value: "x".repeat(100) }) }), 20);
  assert.equal(tooLarge.ok, false); assert.equal(tooLarge.status, 413);
  const malformed = await security.readBoundedJson(new Request("https://tradepilot.example", { method: "POST", body: "not-json" }), 100);
  assert.equal(malformed.ok, false); assert.equal(malformed.status, 400);
  const valid = await security.readBoundedJson(new Request("https://tradepilot.example", { method: "POST", body: JSON.stringify({ name: "Test" }) }), 100);
  assert.equal(valid.ok, true); assert.equal(valid.value.name, "Test");
});


const ultra = new Function(factorySource + "; return { applyUltraPrecisionPolicy, ULTRA_PRECISION_POLICY };")();
function ultraCandidate(overrides = {}) {
  return {
    ok: true, signal: "ACHAT", alertLevel: "CONFIRMED", score: 92,
    dataQuality: { M1: { ok: true }, M5: { ok: true }, M15: { ok: true } },
    liveQuote: { quoteAgeSeconds: 2, spread: 0.2 },
    riskChecks: { spreadOK: true, entryTriggerConfirmed: true, structuralPlanConfirmed: true },
    entryQuality: { confirmed: true }, tradePlan: { confirmed: true },
    advancedIntelligence: {
      availableTimeframes: ["M1", "M5", "M15", "H1", "H4", "D1"],
      anticipation: { direction: "HAUSSIER", confluenceIndex: 82, alignedHigherTimeframes: 2 },
      confluence: { status: "CONFLUENCE_FORTE_A_VALIDER", bullish: { score: 84 } }
    },
    reversalGuard: { blockConfirmedAlert: false },
    statisticalValidation: {
      status: "QUALIFIED_HISTORICALLY", resolved: 60, winRate: 75,
      confidence95: { lower: 63.2, upper: 84.1 }
    },
    ...overrides
  };
}

test("Ultra Precision approves only a fully validated, statistically qualified setup", () => {
  const result = ultra.applyUltraPrecisionPolicy(ultraCandidate());
  assert.equal(result.ultraPrecision.approved, true);
  assert.equal(result.alertLevel, "CONFIRMED");
  assert.deepEqual(result.ultraPrecision.blockers, []);
});

test("Ultra Precision blocks a setup without a mature historical sample", () => {
  const result = ultra.applyUltraPrecisionPolicy(ultraCandidate({
    statisticalValidation: { status: "WAITING_FOR_SAMPLE", resolved: 8, confidence95: { lower: null } }
  }));
  assert.equal(result.ultraPrecision.approved, false);
  assert.equal(result.alertLevel, "EARLY");
  assert.ok(result.ultraPrecision.blockers.some(x => x.includes("résultats résolus")));
});

test("Ultra Precision blocks missing higher-timeframe data and opposing confluence", () => {
  const result = ultra.applyUltraPrecisionPolicy(ultraCandidate({
    advancedIntelligence: {
      availableTimeframes: ["M1", "M5", "M15", "H1"],
      anticipation: { direction: "BAISSIER", confluenceIndex: 55, alignedHigherTimeframes: 0 },
      confluence: { status: "CONFLUENCE_FAIBLE", bullish: { score: 30 } }
    }
  }));
  assert.equal(result.ultraPrecision.approved, false);
  assert.ok(result.ultraPrecision.blockers.length >= 5);
});

test("Ultra Precision blocks stale quotes and unconfirmed risk checks", () => {
  const result = ultra.applyUltraPrecisionPolicy(ultraCandidate({
    liveQuote: { quoteAgeSeconds: 180, spread: 0.2 },
    riskChecks: { spreadOK: false, entryTriggerConfirmed: false, structuralPlanConfirmed: false }
  }));
  assert.equal(result.ultraPrecision.approved, false);
  assert.ok(result.ultraPrecision.blockers.some(x => x.includes("trop ancienne")));
  assert.ok(result.ultraPrecision.blockers.some(x => x.includes("Spread non validé")));
});



test("partner webhook validates its secret, payload size and signature before persistence", () => {
  const start = workerSource.indexOf("async function handlePartnerWebhook");
  const end = workerSource.indexOf("\\nasync function handlePartnerDashboard", start);
  const block = workerSource.slice(start, end);
  assert.notEqual(start, -1, "partner webhook handler should exist");
  assert.ok(block.includes("env.VT_PARTNER_WEBHOOK_SECRET"));
  assert.ok(block.includes("rawBytes.byteLength > 8000"));
  assert.ok(block.includes('request.headers.get("x-vt-signature")'));
  assert.ok(block.indexOf("if (!valid)") < block.indexOf("JSON.parse(rawBody)"));
  assert.ok(block.indexOf("if (!valid)") < block.indexOf("INSERT OR IGNORE"));
});

test("partner dashboard requires its server key and performs a full character comparison", () => {
  const start = workerSource.indexOf("async function handlePartnerDashboard");
  const end = workerSource.indexOf("\nasync function ", start + 1);
  const block = workerSource.slice(start, end);
  assert.notEqual(start, -1, "partner dashboard handler should exist");
  assert.ok(block.includes("env.PARTNER_DASHBOARD_KEY"));
  assert.ok(block.includes("x-partner-dashboard-key"));
  assert.ok(block.includes("if (supplied.length !== secret.length)"));
  assert.ok(block.includes("for (let i=0;i<secret.length;i++) mismatch |= secret.charCodeAt(i) ^ supplied.charCodeAt(i)"));
});

test("partner webhook and dashboard routes are explicitly registered on the Worker", () => {
  assert.ok(workerSource.includes('path === "/api/partner/webhook" && request.method === "POST"'));
  assert.ok(workerSource.includes('path === "/api/partner/dashboard" && request.method === "GET"'));
});


const authSecurity = new Function(factorySource + "; return { verifySupabaseAccessToken };" )();
function base64url(value) {
  return Buffer.from(value).toString("base64url");
}
async function makeJwt(privateKey, claims, header = { alg: "RS256", kid: "tradepilot-test-key", typ: "JWT" }) {
  const head = base64url(JSON.stringify(header));
  const body = base64url(JSON.stringify(claims));
  const signingInput = head + "." + body;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signingInput)
  );
  return signingInput + "." + Buffer.from(signature).toString("base64url");
}

test("Supabase JWT verification accepts a valid signed token and rejects invalid claims", async () => {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk.kid = "tradepilot-test-key";
  publicJwk.alg = "RS256";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
    status: 200, headers: { "content-type": "application/json" }
  });
  try {
    const env = { SUPABASE_URL: "https://project.example" };
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "https://project.example/auth/v1",
      aud: "authenticated",
      sub: "user-a",
      exp: now + 300,
      email: "a@example.test",
      email_confirmed_at: new Date().toISOString()
    };
    const validToken = await makeJwt(pair.privateKey, claims);
    const valid = await authSecurity.verifySupabaseAccessToken(
      new Request("https://tradepilot.example/api/bots", {
        headers: { authorization: "Bearer " + validToken }
      }), env
    );
    assert.equal(valid.ok, true);
    assert.equal(valid.user.subject, "user-a");
    assert.equal(valid.user.emailVerified, true);

    const expiredToken = await makeJwt(pair.privateKey, { ...claims, exp: now - 1 });
    const expired = await authSecurity.verifySupabaseAccessToken(
      new Request("https://tradepilot.example/api/bots", {
        headers: { authorization: "Bearer " + expiredToken }
      }), env
    );
    assert.equal(expired.ok, false);
    assert.equal(expired.status, 401);

    const wrongIssuerToken = await makeJwt(pair.privateKey, { ...claims, iss: "https://attacker.example/auth/v1" });
    const wrongIssuer = await authSecurity.verifySupabaseAccessToken(
      new Request("https://tradepilot.example/api/bots", {
        headers: { authorization: "Bearer " + wrongIssuerToken }
      }), env
    );
    assert.equal(wrongIssuer.ok, false);
    assert.equal(wrongIssuer.status, 401);

    const wrongAudienceToken = await makeJwt(pair.privateKey, { ...claims, aud: "anon" });
    const wrongAudience = await authSecurity.verifySupabaseAccessToken(
      new Request("https://tradepilot.example/api/bots", {
        headers: { authorization: "Bearer " + wrongAudienceToken }
      }), env
    );
    assert.equal(wrongAudience.ok, false);
    assert.equal(wrongAudience.status, 401);

    const unknownKeyToken = await makeJwt(pair.privateKey, claims, {
      alg: "RS256", kid: "attacker-key", typ: "JWT"
    });
    const unknownKey = await authSecurity.verifySupabaseAccessToken(
      new Request("https://tradepilot.example/api/bots", {
        headers: { authorization: "Bearer " + unknownKeyToken }
      }), env
    );
    assert.equal(unknownKey.ok, false);
    assert.equal(unknownKey.status, 401);

    const missingBearer = await authSecurity.verifySupabaseAccessToken(
      new Request("https://tradepilot.example/api/bots"), env
    );
    assert.equal(missingBearer.ok, false);
    assert.equal(missingBearer.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("every customer bot read and mutation is scoped by workspace_id", () => {
  const handlers = [
    ["handleListBots", "workspace_id = ?"],
    ["handleCreateBot", "workspace_id"],
    ["handleUpdateBot", "id = ? AND workspace_id = ?"],
    ["handleSetBotStatus", "id = ? AND workspace_id = ?"],
    ["handleDeleteBot", "id = ? AND workspace_id = ?"],
    ["handleAnalyzeStoredBot", "id = ? AND workspace_id = ?"]
  ];
  for (const [name, requiredScope] of handlers) {
    const start = workerSource.indexOf("async function " + name);
    assert.notEqual(start, -1, name + " must exist");
    const next = workerSource.indexOf("\\nasync function ", start + 1);
    const block = workerSource.slice(start, next < 0 ? workerSource.length : next);
    assert.match(block, /getAuthenticatedWorkspace\(request, env\)/, name + " must authenticate");
    assert.ok(block.includes(requiredScope), name + " must include a workspace predicate/column");
    assert.match(block, /access\.workspace\.id/, name + " must bind the authenticated workspace");
  }
});

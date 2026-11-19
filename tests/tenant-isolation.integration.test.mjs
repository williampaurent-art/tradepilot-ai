import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const workerFactorySource = workerSource.replace("export default {", "const __worker = {");
const worker = new Function(workerFactorySource + "; return __worker;")();

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function makeJwt(privateKey, subject, now) {
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "tenant-isolation-test", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: "https://tradepilot-test.supabase.co/auth/v1",
    aud: "authenticated",
    sub: subject,
    exp: now + 300,
    email: subject + "@example.test",
    email_confirmed_at: new Date().toISOString()
  }));
  const signingInput = header + "." + claims;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signingInput)
  );
  return signingInput + "." + Buffer.from(signature).toString("base64url");
}

function d1FromSqlite(db) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() {
          return db.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...values) };
        },
        async run() {
          const result = db.prepare(sql).run(...values);
          return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } };
        }
      };
    }
  };
}

test("D1 migrations apply and authenticated customers cannot read or mutate another workspace", async () => {
  const db = new DatabaseSync(":memory:");
  const originalFetch = globalThis.fetch;
  const originalCrypto = globalThis.crypto;
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = "tenant-isolation-test";
  publicJwk.alg = "RS256";

  try {
    for (const name of [
      "0001_saas_core.sql",
      "0002_customer_bots.sql",
      "0003_bot_cron_rotation.sql",
      "0004_client_portal.sql",
      "0005_broker_promotions.sql",
      "0006_partner_conversions.sql"
    ]) {
      const sql = await readFile(new URL("../migrations/" + name, import.meta.url), "utf8");
      db.exec(sql);
    }

    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200, headers: { "content-type": "application/json" }
    });

    const values = new Map();
    const env = {
      SUPABASE_URL: "https://tradepilot-test.supabase.co",
      DB: d1FromSqlite(db),
      TP_STATE: {
        async get(key) { return values.get(key) ?? null; },
        async put(key, value) { values.set(key, value); }
      }
    };
    const now = Math.floor(Date.now() / 1000);
    const tokenA = await makeJwt(keyPair.privateKey, "tenant-a", now);
    const tokenB = await makeJwt(keyPair.privateKey, "tenant-b", now);

    async function request(path, token, method = "GET", body) {
      const headers = { authorization: "Bearer " + token };
      if (body !== undefined) headers["content-type"] = "application/json";
      return worker.fetch(new Request("https://tradepilot.test" + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
      }), env);
    }

    const accountAResponse = await request("/api/bots", tokenA);
    const accountBResponse = await request("/api/bots", tokenB);
    assert.equal(accountAResponse.status, 200);
    assert.equal(accountBResponse.status, 200);
    const accountA = await accountAResponse.json();
    const accountB = await accountBResponse.json();
    assert.notEqual(accountA.workspace.id, accountB.workspace.id);

    const userA = db.prepare("SELECT id FROM users WHERE auth_subject = ?").get("tenant-a");
    const userB = db.prepare("SELECT id FROM users WHERE auth_subject = ?").get("tenant-b");
    db.prepare("INSERT INTO trading_bots (id,workspace_id,created_by_user_id,name,instrument,timeframe,style,status,strategy_json) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("bot-tenant-a", accountA.workspace.id, userA.id, "Bot A", "XAUUSD", "M5", "scalping", "active", JSON.stringify({ name: "Bot A" }));
    db.prepare("INSERT INTO trading_bots (id,workspace_id,created_by_user_id,name,instrument,timeframe,style,status,strategy_json) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("bot-tenant-b", accountB.workspace.id, userB.id, "Bot B", "XAUUSD", "M5", "scalping", "active", JSON.stringify({ name: "Bot B" }));
    db.prepare("INSERT INTO bot_signal_events (id,bot_id,workspace_id,instrument,side,timeframe,entry,market_timestamp) VALUES (?,?,?,?,?,?,?,?)")
      .run("signal-tenant-b", "bot-tenant-b", accountB.workspace.id, "XAUUSD", "ACHAT", "M5", 4000, new Date().toISOString());

    const listA = await (await request("/api/bots", tokenA)).json();
    const listB = await (await request("/api/bots", tokenB)).json();
    assert.deepEqual(listA.bots.map(bot => bot.id), ["bot-tenant-a"]);
    assert.deepEqual(listB.bots.map(bot => bot.id), ["bot-tenant-b"]);

    const foreignSignals = await request("/api/bots/bot-tenant-b/signals", tokenA);
    assert.equal(foreignSignals.status, 404);
    const ownSignals = await request("/api/bots/bot-tenant-b/signals", tokenB);
    assert.equal(ownSignals.status, 200);
    assert.equal((await ownSignals.json()).signals.length, 1);

    const foreignStatus = await request("/api/bots/bot-tenant-b/status", tokenA, "POST", { status: "paused" });
    assert.equal(foreignStatus.status, 404);
    assert.equal(db.prepare("SELECT status FROM trading_bots WHERE id = ?").get("bot-tenant-b").status, "active");

    const foreignDelete = await request("/api/bots/bot-tenant-b/delete", tokenA, "POST");
    assert.equal(foreignDelete.status, 404);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM trading_bots WHERE id = ?").get("bot-tenant-b").total, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto !== undefined) globalThis.crypto = originalCrypto;
    db.close();
  }
});

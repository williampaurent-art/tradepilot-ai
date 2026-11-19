const apiBase = "https://api.cloudflare.com/client/v4";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const workerName = process.env.CLOUDFLARE_WORKER_NAME || "tradepilot-ai";

if (!accountId || !apiToken) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
}

const expectedNamespaces = [
  { name: "PUBLIC_API_LIMITER", namespaceId: "912341001" },
  { name: "UPSTREAM_API_LIMITER", namespaceId: "912341002" }
];

async function cloudflareGet(path) {
  const response = await fetch(apiBase + path, {
    headers: { authorization: "Bearer " + apiToken, accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const messages = (payload?.errors || []).map(item => item.message).filter(Boolean).join("; ");
    throw new Error("Cloudflare API GET " + path + " failed (" + response.status + "): " + (messages || "unknown API error"));
  }
  return payload;
}

const scripts = [];
let page = 1;
let totalPages = 1;
do {
  const payload = await cloudflareGet(
    "/accounts/" + encodeURIComponent(accountId) + "/workers/scripts?page=" + page + "&per_page=100"
  );
  scripts.push(...(payload.result || []));
  totalPages = Number(payload.result_info?.total_pages || 1);
  page++;
} while (page <= totalPages);

if (!scripts.some(script => script.id === workerName)) {
  throw new Error("Expected Cloudflare Worker '" + workerName + "' was not found in this account.");
}

const settings = await Promise.all(scripts.map(async script => {
  const payload = await cloudflareGet(
    "/accounts/" + encodeURIComponent(accountId) + "/workers/scripts/" +
    encodeURIComponent(script.id) + "/settings"
  );
  return { worker: script.id, bindings: payload.result?.bindings || [] };
}));

const collisions = [];
for (const item of settings) {
  for (const binding of item.bindings) {
    if (binding.type !== "ratelimit") continue;
    const expected = expectedNamespaces.find(entry => entry.namespaceId === String(binding.namespace_id));
    if (!expected) continue;
    const isExpectedBinding = item.worker === workerName && binding.name === expected.name;
    if (!isExpectedBinding) {
      collisions.push({
        namespaceId: String(binding.namespace_id),
        existingWorker: item.worker,
        existingBinding: binding.name
      });
    }
  }
}

if (collisions.length) {
  for (const item of collisions) {
    console.error(
      "Rate-limit namespace collision: " + item.namespaceId +
      " is already used by " + item.existingWorker + "/" + item.existingBinding
    );
  }
  throw new Error("Refusing deployment: configured rate-limit namespace IDs are not unique to the expected bindings.");
}

console.log("Cloudflare preflight passed.");
console.log("Worker found: " + workerName);
for (const item of expectedNamespaces) {
  console.log("Rate-limit namespace available for " + item.name + ": " + item.namespaceId);
}

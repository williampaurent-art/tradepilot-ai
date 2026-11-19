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

const expectedBindingMatches = new Map(expectedNamespaces.map(item => [item.namespaceId, []]));
for (const item of settings) {
  for (const binding of item.bindings) {
    if (binding.type !== "ratelimit") continue;
    const expected = expectedBindingMatches.get(String(binding.namespace_id));
    if (expected) expected.push({ worker: item.worker, name: binding.name });
  }
}

const problems = [];
for (const item of expectedNamespaces) {
  const matches = expectedBindingMatches.get(item.namespaceId);
  if (matches.length === 0) {
    problems.push("Namespace " + item.namespaceId + " (" + item.name + ") is not currently bound to any Worker.");
  } else if (matches.length > 1) {
    problems.push("Namespace " + item.namespaceId + " is bound more than once: " + JSON.stringify(matches));
  } else if (matches[0].worker !== workerName || matches[0].name !== item.name) {
    problems.push("Namespace " + item.namespaceId + " is bound to " + matches[0].worker + "/" + matches[0].name +
      " instead of " + workerName + "/" + item.name + ".");
  }
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  throw new Error("Cloudflare rate-limit namespace preflight failed; deployment must not continue.");
}

console.log("Cloudflare preflight passed.");
console.log("Worker found: " + workerName);
for (const item of expectedNamespaces) {
  console.log("Rate-limit namespace available for " + item.name + ": " + item.namespaceId);
}

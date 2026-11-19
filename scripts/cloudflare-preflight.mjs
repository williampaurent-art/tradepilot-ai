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

const failedBuildId = process.env.CLOUDFLARE_FAILED_BUILD_ID;
if (failedBuildId) {
  const buildPath = "/accounts/" + encodeURIComponent(accountId) + "/builds/builds/" + encodeURIComponent(failedBuildId);
  try {
    const build = await cloudflareGet(buildPath);
    const item = build.result || {};
    console.log("Historical Cloudflare build: " + JSON.stringify({
      build_uuid: item.build_uuid,
      build_outcome: item.build_outcome,
      created_on: item.created_on,
      modified_on: item.modified_on,
      commit_hash: item.build_trigger_metadata?.commit_hash,
      branch: item.build_trigger_metadata?.branch,
      build_command: item.build_trigger_metadata?.build_command,
      deploy_command: item.build_trigger_metadata?.deploy_command
    }));
    const logs = await cloudflareGet(buildPath + "/logs");
    const rows = logs.result?.lines || [];
    const messages = rows.map(row => Array.isArray(row) ? row[row.length - 1] : row).map(String);
    const diagnostics = messages.filter(line => /error|failed|failure|exception|not found|invalid|denied|unauthorized/i.test(line)).slice(-30);
    console.log("Historical Cloudflare build diagnostic lines:");
    for (const line of diagnostics) console.log(line.slice(0, 1200));
    if (!diagnostics.length) console.log("No error-like log lines returned; inspect the full build in Cloudflare if needed.");
  } catch (error) {
    console.warn("Historical Cloudflare build logs unavailable with this token: " + error.message);
  }
}

console.log("Cloudflare preflight passed.");
console.log("Worker found: " + workerName);
for (const item of expectedNamespaces) {
  console.log("Rate-limit namespace available for " + item.name + ": " + item.namespaceId);
}

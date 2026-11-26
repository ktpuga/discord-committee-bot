import { config } from "./config.js";

async function request(path, options = {}) {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Bot-Secret": config.apiSecret,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API ${options.method ?? "GET"} ${path} failed (${response.status}): ${body}`);
  }

  return response.status === 204 ? null : response.json();
}
// These endpoints are the bot's API contract with ktp-api.
export function getPendingJobs() {
  return request("/discord/role-sync/jobs?status=pending");
}

// Desired members for every committee role the API explicitly manages. This
// does not include unrelated server roles, so reconciliation cannot touch them.
export function getRoleAssignments() {
  return request("/discord/role-sync/assignments");
}

export function completeJob(jobId) {
  return request(`/discord/role-sync/jobs/${jobId}/complete`, { method: "POST", body: "{}" });
}

export function failJob(jobId, error) {
  return request(`/discord/role-sync/jobs/${jobId}/fail`, {
    method: "POST",
    body: JSON.stringify({ error: String(error).slice(0, 500) }),
  });
}

import test from "node:test";
import assert from "node:assert/strict";

// sync.js loads the bot config at import time. These are deliberately fake
// values: the test exercises a supplied guild object and makes no network call.
process.env.DISCORD_BOT_TOKEN = "test-token";
process.env.DISCORD_GUILD_ID = "123456789012345678";
process.env.API_BASE_URL = "http://api.test";
process.env.BOT_API_SECRET = "test-secret";

const { reconcileRoleAssignments, syncPendingJobs } = await import("../discord-bot/src/sync.js");

// Every call the worker makes on a member is recorded in one ordered log, so a
// test can assert what did NOT happen as well as what did.
function member(id, log) {
  return {
    id,
    roles: {
      remove: async () => { log.push(`remove:${id}`); },
      add: async () => { log.push(`add:${id}`); },
    },
  };
}

function guildOf(roles, presentMembers) {
  return {
    members: { fetch: async () => new Map(presentMembers.map((m) => [m.id, m])) },
    roles: { fetch: async (id) => roles.get(id) ?? null },
  };
}

test("reconciliation removes only unapproved holders of a configured committee role", async () => {
  const log = [];
  const pledgeRole = {
    id: "234567890123456789",
    managed: false,
    members: new Map([
      ["allowed", member("allowed", log)],
      ["unlinked", member("unlinked", log)],
    ]),
  };
  const unrelatedRole = {
    id: "345678901234567890",
    managed: false,
    members: new Map([["unlinked", member("unlinked", log)]]),
  };
  const guild = {
    members: { fetch: async () => new Map() },
    roles: { fetch: async (id) => id === pledgeRole.id ? pledgeRole : unrelatedRole },
  };

  const counts = await reconcileRoleAssignments(guild, [{
    discord_role_id: pledgeRole.id,
    discord_user_ids: ["allowed"],
  }]);

  assert.deepEqual(counts, { added: 0, removed: 1 });
  assert.deepEqual(log, ["remove:unlinked"]);
});

// The half that did not exist before 2026-09-23. Granting was driven ENTIRELY
// by one-shot rows in discord_role_sync_jobs, so a grant that was never
// enqueued or that failed after its job was marked completed left the member
// without the role permanently -- nothing in the system repaired it. Reported
// by a member whose Discord was linked and who still had no role.
test("an approved member who does not hold the role is granted it", async () => {
  const log = [];
  const linked = member("linked", log);
  const role = { id: "234567890123456789", managed: false, members: new Map() };
  const guild = guildOf(new Map([[role.id, role]]), [linked]);

  const counts = await reconcileRoleAssignments(guild, [{
    discord_role_id: role.id,
    discord_user_ids: ["linked"],
  }]);

  assert.deepEqual(counts, { added: 1, removed: 0 });
  assert.deepEqual(log, ["add:linked"]);
});

test("a member who already holds the role is left alone", async () => {
  const log = [];
  const holder = member("holder", log);
  const role = {
    id: "234567890123456789",
    managed: false,
    members: new Map([["holder", holder]]),
  };
  const guild = guildOf(new Map([[role.id, role]]), [holder]);

  const counts = await reconcileRoleAssignments(guild, [{
    discord_role_id: role.id,
    discord_user_ids: ["holder"],
  }]);

  assert.deepEqual(counts, { added: 0, removed: 0 });
  assert.deepEqual(log, [], "an unchanged member must not be touched at all");
});

// Approved on the website, not in the Discord server. Retrying would never fix
// it, and it must not stop the rest of the role being reconciled.
test("an approved member missing from the server is skipped, not an error", async () => {
  const log = [];
  const present = member("present", log);
  const role = { id: "234567890123456789", managed: false, members: new Map() };
  const guild = guildOf(new Map([[role.id, role]]), [present]);

  const counts = await reconcileRoleAssignments(guild, [{
    discord_role_id: role.id,
    discord_user_ids: ["absent", "present"],
  }]);

  assert.deepEqual(counts, { added: 1, removed: 0 });
  assert.deepEqual(log, ["add:present"]);
});

test("granting and removing happen together on the same role", async () => {
  const log = [];
  const joiner = member("joiner", log);
  const leaver = member("leaver", log);
  const role = {
    id: "234567890123456789",
    managed: false,
    members: new Map([["leaver", leaver]]),
  };
  const guild = guildOf(new Map([[role.id, role]]), [joiner, leaver]);

  const counts = await reconcileRoleAssignments(guild, [{
    discord_role_id: role.id,
    discord_user_ids: ["joiner"],
  }]);

  assert.deepEqual(counts, { added: 1, removed: 1 });
  assert.deepEqual(log.slice().sort(), ["add:joiner", "remove:leaver"]);
});

// A managed role belongs to an integration and cannot be assigned. The throw
// is caught per role so the others still reconcile -- asserted here because a
// grant loop that ran before the guard would hand out a role Discord refuses.
test("a managed or missing role is skipped without stopping the other roles", async () => {
  const log = [];
  const joiner = member("joiner", log);
  const managed = { id: "234567890123456789", managed: true, members: new Map() };
  const healthy = { id: "345678901234567890", managed: false, members: new Map() };
  const guild = guildOf(new Map([[managed.id, managed], [healthy.id, healthy]]), [joiner]);

  const counts = await reconcileRoleAssignments(guild, [
    { discord_role_id: managed.id, discord_user_ids: ["joiner"] },
    { discord_role_id: healthy.id, discord_user_ids: ["joiner"] },
  ]);

  assert.deepEqual(counts, { added: 1, removed: 0 });
  assert.deepEqual(log, ["add:joiner"], "the managed role must not have been granted");
});

// The desired state MUST be read after the grant jobs have been applied.
// Reading both up front (the original code did, in one Promise.all) let a
// membership committing between the two reads hand reconciliation a picture
// older than the grant it then undid -- and the job was already marked
// completed, so nothing ever retried it. The role was lost for good.
test("the desired state is read after the grant jobs are applied, not alongside them", async () => {
  const calls = [];
  const role = { id: "234567890123456789", managed: false, members: new Map() };
  const joiner = member("joiner", []);
  const guild = {
    members: {
      fetch: async (id) => (id === undefined ? new Map([[joiner.id, joiner]]) : joiner),
    },
    roles: { fetch: async () => role },
  };
  const client = { guilds: { fetch: async () => guild } };

  const api = {
    getPendingJobs: async () => {
      calls.push("getPendingJobs");
      return [{ id: "job-1", action: "grant", discord_user_id: "joiner", discord_role_id: role.id }];
    },
    getRoleAssignments: async () => {
      calls.push("getRoleAssignments");
      return [{ discord_role_id: role.id, discord_user_ids: ["joiner"] }];
    },
    completeJob: async (id) => { calls.push(`completeJob:${id}`); },
    failJob: async (id, err) => { calls.push(`failJob:${id}:${err}`); },
  };

  await syncPendingJobs(client, api);

  assert.deepEqual(calls, ["getPendingJobs", "completeJob:job-1", "getRoleAssignments"]);
  assert.ok(
    calls.indexOf("getRoleAssignments") > calls.indexOf("completeJob:job-1"),
    "reconciliation must not work from a snapshot older than the grants it follows",
  );
});

import { config } from "./config.js";
import { completeJob, failJob, getPendingJobs, getRoleAssignments } from "./api-client.js";

// Converges every role configured in the API to the desired state the API
// reports, IN BOTH DIRECTIONS: it grants the role to approved members who lack
// it as well as taking it from holders who are not approved.
//
// Removal used to be all this did, which meant drift could only ever resolve
// toward "nobody holds the role". A grant that was never enqueued, or whose job
// was marked completed without the role surviving, was repaired by nothing --
// the jobs queue is one-shot, so this loop is the only self-healing part of the
// system. It still never kicks a Discord member, and it still never inspects or
// changes a role that is absent from `assignments`.
export async function reconcileRoleAssignments(guild, assignments) {
  // role.members is cache-backed. Fetching the full guild membership first is
  // what makes it a complete answer rather than merely "members seen recently".
  // It is also the only way to reach an approved member who does not yet hold
  // the role: by definition they appear in no role's member list.
  const guildMembers = await guild.members.fetch();
  let added = 0;
  let removed = 0;

  for (const assignment of assignments) {
    if (!assignment?.discord_role_id || !Array.isArray(assignment.discord_user_ids)) {
      throw new Error("API returned an invalid Discord role assignment");
    }

    try {
      const role = await guild.roles.fetch(assignment.discord_role_id);
      if (!role) throw new Error("The mapped Discord role no longer exists");
      if (role.managed) throw new Error("The mapped role is managed by an integration and cannot be assigned");

      const allowed = new Set(assignment.discord_user_ids.map(String));
      for (const member of role.members.values()) {
        if (allowed.has(member.id)) continue;
        await member.roles.remove(role, "No linked, approved KTP committee membership");
        removed += 1;
      }

      for (const id of allowed) {
        if (role.members.has(id)) continue;
        // Approved on the website but not in the Discord server. Expected, not
        // a failure, and not something retrying would ever resolve -- skipping
        // quietly is what keeps one absent member from aborting the role.
        const member = guildMembers.get(id);
        if (!member) continue;
        await member.roles.add(role, "Approved KTP committee membership");
        added += 1;
      }
    } catch (error) {
      // One incorrectly positioned/deleted role must not prevent reconciliation
      // of the other committee roles. The next polling pass retries it.
      console.error(`[sync] reconciliation failed for role ${assignment.discord_role_id}`, error);
    }
  }

  return { added, removed };
}

// Expected job shape from the API:
// { id, action: "grant" | "revoke", discord_user_id, discord_role_id }
// The API decides who is approved and which committee maps to which role.
// `api` is injectable for one reason: the ORDER of the two reads below is
// load-bearing, and a test cannot observe an order it cannot intercept. The
// default is the real client, so nothing about the deployed call changes.
export async function syncPendingJobs(client, api = { getPendingJobs, getRoleAssignments, completeJob, failJob }) {
  const jobs = await api.getPendingJobs();
  const guild = await client.guilds.fetch(config.guildId);

  for (const job of jobs) {
    try {
      if (!job?.id || !["grant", "revoke"].includes(job.action) || !job.discord_user_id || !job.discord_role_id) {
        throw new Error("API returned an invalid role-sync job");
      }

      const member = await guild.members.fetch(job.discord_user_id);
      const role = await guild.roles.fetch(job.discord_role_id);
      if (!role) throw new Error("The mapped Discord role no longer exists");
      if (role.managed) throw new Error("The mapped role is managed by an integration and cannot be assigned");

      if (job.action === "grant") await member.roles.add(role, "Approved committee membership on KTP website");
      else await member.roles.remove(role, "Committee membership removed on KTP website");

      await api.completeJob(job.id);
      console.log(`[sync] ${job.action} completed for job ${job.id}`);
    } catch (error) {
      console.error(`[sync] job ${job?.id ?? "unknown"} failed`, error);
      if (job?.id) {
        try {
          await api.failJob(job.id, error instanceof Error ? error.message : error);
        } catch (reportError) {
          console.error(`[sync] could not report failure for job ${job.id}`, reportError);
        }
      }
    }
  }

  // Read AFTER the jobs above have been applied, never alongside them. A
  // membership committing between the two reads would otherwise hand
  // reconciliation a desired state older than the grant it is about to undo --
  // and because that job is already marked completed, nothing would retry it.
  // One extra round trip per poll is cheap next to a role lost for good.
  const assignments = await api.getRoleAssignments();

  const { added, removed } = await reconcileRoleAssignments(guild, assignments);
  if (added) console.log(`[sync] granted ${added} missing committee role assignment${added === 1 ? "" : "s"}`);
  if (removed) console.log(`[sync] removed ${removed} stale committee role assignment${removed === 1 ? "" : "s"}`);
}

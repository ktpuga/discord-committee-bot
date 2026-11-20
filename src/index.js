import { Client, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { syncPendingJobs } from "./sync.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
let syncing = false;

async function runSync() {
  if (syncing) return;
  syncing = true;
  try {
    await syncPendingJobs(client);
  } catch (error) {
    console.error("[sync] polling failed", error);
  } finally {
    syncing = false;
  }
}

client.once("ready", async (readyClient) => {
  console.log(`Connected to Discord as ${readyClient.user.tag}`);
  await runSync();
  setInterval(runSync, config.syncIntervalMs);
});

client.login(config.discordToken);

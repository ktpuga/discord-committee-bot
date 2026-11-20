import "dotenv/config";

const required = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "API_BASE_URL", "BOT_API_SECRET"];

for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const interval = Number.parseInt(process.env.SYNC_INTERVAL_MS ?? "30000", 10);

export const config = {
  discordToken: process.env.DISCORD_BOT_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID,
  apiBaseUrl: process.env.API_BASE_URL.replace(/\/$/, ""),
  apiSecret: process.env.BOT_API_SECRET,
  syncIntervalMs: Number.isFinite(interval) && interval >= 5_000 ? interval : 30_000,
};

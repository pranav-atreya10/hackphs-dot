// Applies db/schema.sql to DATABASE_URL. Safe to re-run: every statement is IF NOT EXISTS.
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

try {
  process.loadEnvFile(path.join(__dirname, "..", ".env"));
} catch {}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (put it in PRANAV/.env)");
  process.exit(1);
}

// Run statements one by one: a multi-statement string is an implicit transaction,
// and TimescaleDB refuses to create continuous aggregates inside one.
const statements = fs
  .readFileSync(path.join(__dirname, "schema.sql"), "utf8")
  .replace(/^\s*--.*$/gm, "")
  .split(/;\s*$/m)
  .map((s) => s.trim())
  .filter(Boolean);

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const sql of statements) {
      console.log(`> ${sql.split("\n")[0]}`);
      await client.query(sql);
    }
    console.log("schema ready");
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error("setup failed:", err.message);
  process.exit(1);
});

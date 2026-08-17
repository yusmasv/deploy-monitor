import { defineConfig } from "drizzle-kit";

// drizzle-kit does not auto-load .env.local — inject it explicitly.
for (const file of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // absent in containers, where DATABASE_URL comes from the environment
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set.");
}

export default defineConfig({
  schema: ["./lib/schema.ts"],

  // MUST be committed to git and MUST end up inside the image — this folder,
  // plus meta/_journal.json, is what `drizzle-kit migrate` reads at deploy time.
  out: "./drizzle",

  dialect: "turso",
  dbCredentials: { url, authToken: process.env.DATABASE_AUTH_TOKEN?.trim() || undefined },
});

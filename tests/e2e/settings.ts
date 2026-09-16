import path from "node:path";
import { fileURLToPath } from "node:url";

// The browser tests drive the real server, so they read the same .env the server reads.
const root = fileURLToPath(new URL("../../", import.meta.url));
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const password = process.env.HOST_UPLOAD_PASSWORD;
if (!password) throw new Error("HOST_UPLOAD_PASSWORD must be set in .env before the browser tests can run");

export const PASSWORD = password;

import { fileURLToPath } from "node:url";
import path from "node:path";

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Settings live in .env at the project root so nothing has to be edited in code.
// Existing process variables win, which keeps one-off launches and process managers in charge.
export function loadProjectEnv(file = path.join(PROJECT_ROOT, ".env")) {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    // A missing file is allowed: a deployment may supply every setting through its environment.
    if (error.code !== "ENOENT") throw error;
  }
}

// Resolved against the project root, so the library does not move when the process starts elsewhere.
export function storageDirectory(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("HOST_UPLOAD_DIR must be a non-empty path; set it in .env or the process environment.");
  }
  return path.resolve(PROJECT_ROOT, value.trim());
}

export function uploadPassword(value) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error("HOST_UPLOAD_PASSWORD must be a non-empty single-line password; set it in .env or the process environment.");
  }
  return value;
}

export function passwordRetryMilliseconds(value) {
  // Digits only: "1e3", "0x10" and "+3" are typos in a settings file, not longer waits.
  const text = typeof value === "string" ? value.trim() : value;
  const seconds = typeof text === "number" ? text : /^\d+$/.test(String(text)) ? Number(text) : NaN;
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(seconds) || seconds <= 0
    || !Number.isSafeInteger(milliseconds) || !Number.isSafeInteger(Date.now() + milliseconds)) {
    throw new Error("HOST_PASSWORD_RETRY_SECONDS must be a positive whole number of seconds; set it in .env or the process environment.");
  }
  return { seconds, milliseconds };
}

// Optional TLS material: both files or neither, so a half-configured server never starts in the clear.
export function tlsFiles(certFile, keyFile) {
  if (!!certFile !== !!keyFile) throw new Error("Set both TLS_CERT_FILE and TLS_KEY_FILE");
  return { certFile, keyFile, secure: !!certFile };
}

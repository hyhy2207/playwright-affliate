"use strict";

const fs = require("fs");
const path = require("path");

loadDotEnv();

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`ENV ${name} phai la so duong hop le`);
  }

  return parsed;
}

function readStringEnv(name, fallback) {
  const raw = process.env[name];
  return raw == null || raw === "" ? fallback : raw;
}

function loadDotEnv() {
  const envPath = path.resolve(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

const config = {
  port: readNumberEnv("PORT", 8080),
  logDir: readStringEnv("LOG_DIR", "logs"),
  taskLogFile: readStringEnv("TASK_LOG_FILE", "tasks.jsonl"),
  taskRetentionMs: readNumberEnv("TASK_RETENTION_MS", 30 * 60 * 1000),
  workerWaitTimeoutMs: readNumberEnv("WORKER_WAIT_TIMEOUT_MS", 30 * 1000),
  workerWaitPollMs: readNumberEnv("WORKER_WAIT_POLL_MS", 2000),
  workerSocketUrl: readStringEnv("WORKER_SOCKET_URL", "ws://127.0.0.1:8080"),
  browserProfileDir: readStringEnv("BROWSER_PROFILE_DIR", ".browser-profile"),
  browserCdpUrl: readStringEnv("BROWSER_CDP_URL", ""),
  browserChannel: readStringEnv("BROWSER_CHANNEL", "chrome"),
  browserExecutablePath: readStringEnv("BROWSER_EXECUTABLE_PATH", ""),
  headless: readStringEnv("HEADLESS", "false").toLowerCase() === "true",
  scrapeTimeoutMs: readNumberEnv("SCRAPE_TIMEOUT_MS", 20 * 1000),
  pageSettleMs: readNumberEnv("PAGE_SETTLE_MS", 600),
  blockingDetectTimeoutMs: readNumberEnv("BLOCKING_DETECT_TIMEOUT_MS", 1200),
  affiliateBaseUrl: readStringEnv("AFFILIATE_BASE_URL", "https://affiliate.shopee.vn"),
};

module.exports = {
  config,
};

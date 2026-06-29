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

function readCsvEnv(name, fallback = []) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallback;
  }

  return String(raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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
  logMaxBytes: readNumberEnv("LOG_MAX_BYTES", 10 * 1024 * 1024),
  taskRetentionMs: readNumberEnv("TASK_RETENTION_MS", 30 * 60 * 1000),
  taskQueueTimeoutMs: readNumberEnv("TASK_QUEUE_TIMEOUT_MS", 10 * 1000),
  taskTimeoutMs: readNumberEnv("TASK_TIMEOUT_MS", 15 * 1000),
  productCacheTtlMs: readNumberEnv("PRODUCT_CACHE_TTL_MS", 5 * 60 * 1000),
  productRequestTimeoutMs: readNumberEnv(
    "PRODUCT_REQUEST_TIMEOUT_MS",
    10 * 1000,
  ),
  productBatchLimit: readNumberEnv("PRODUCT_BATCH_LIMIT", 20),
  productStoreDriver: readStringEnv(
    "PRODUCT_STORE_DRIVER",
    "postgres",
  ).toLowerCase(),
  productDataDir: readStringEnv("PRODUCT_DATA_DIR", "data"),
  productStoreFile: readStringEnv("PRODUCT_STORE_FILE", "products.json"),
  productHistoryFile: readStringEnv(
    "PRODUCT_HISTORY_FILE",
    "price-history.jsonl",
  ),
  productStoreFlushMs: readNumberEnv("PRODUCT_STORE_FLUSH_MS", 250),
  databaseUrl: readStringEnv("DATABASE_URL", ""),
  databaseSsl: readStringEnv("DATABASE_SSL", "false").toLowerCase() === "true",
  workerWaitTimeoutMs: readNumberEnv("WORKER_WAIT_TIMEOUT_MS", 30 * 1000),
  workerWaitPollMs: readNumberEnv("WORKER_WAIT_POLL_MS", 500),
  serviceAutoRestart:
    readStringEnv("SERVICE_AUTO_RESTART", "true").toLowerCase() !== "false",
  serviceRestartDelayMs: readNumberEnv("SERVICE_RESTART_DELAY_MS", 2000),
  taskPollMs: readNumberEnv("TASK_POLL_MS", 200),
  taskMaxRetries: readNumberEnv("TASK_MAX_RETRIES", 2),
  taskRetryDelayMs: readNumberEnv("TASK_RETRY_DELAY_MS", 1500),
  taskHistoryPerItemLimit: readNumberEnv("TASK_HISTORY_PER_ITEM_LIMIT", 3),
  queueDriver: readStringEnv("QUEUE_DRIVER", "memory").toLowerCase(),
  queueDriverFallback: readStringEnv(
    "QUEUE_DRIVER_FALLBACK",
    "memory",
  ).toLowerCase(),
  queueName: readStringEnv("QUEUE_NAME", "shopee-task-queue"),
  queuePrefix: readStringEnv("QUEUE_PREFIX", "playwright-shopee"),
  queueDispatchConcurrency: readNumberEnv("QUEUE_DISPATCH_CONCURRENCY", 1),
  redisUrl: readStringEnv("REDIS_URL", "redis://127.0.0.1:6379/0"),
  workerSocketUrl: readStringEnv("WORKER_SOCKET_URL", "ws://127.0.0.1:8080"),
  browserProfileDir: readStringEnv("BROWSER_PROFILE_DIR", ".profiles/default"),
  browserCdpUrl: readStringEnv("BROWSER_CDP_URL", ""),
  browserChannel: readStringEnv("BROWSER_CHANNEL", "chrome"),
  browserExecutablePath: readStringEnv("BROWSER_EXECUTABLE_PATH", ""),
  profileCooldownMs: readNumberEnv("PROFILE_COOLDOWN_MS", 20 * 60 * 1000),
  profileCooldownMaxMs: readNumberEnv(
    "PROFILE_COOLDOWN_MAX_MS",
    6 * 60 * 60 * 1000,
  ),
  profileMinTaskGapMs: readNumberEnv("PROFILE_MIN_TASK_GAP_MS", 1200),
  profileSwitchDebounceMs: readNumberEnv("PROFILE_SWITCH_DEBOUNCE_MS", 5000),
  profileWarmupEnabled:
    readStringEnv("PROFILE_WARMUP_ENABLED", "true").toLowerCase() !== "false",
  profileWarmupDelayMs: readNumberEnv("PROFILE_WARMUP_DELAY_MS", 4000),
  profileWarmupDeepEnabled:
    readStringEnv("PROFILE_WARMUP_DEEP_ENABLED", "true").toLowerCase() !==
    "false",
  profileWarmupKeywords: readCsvEnv("PROFILE_WARMUP_KEYWORDS", [
    "dep",
    "dien thoai",
    "giay",
  ]),
  headless: readStringEnv("HEADLESS", "false").toLowerCase() === "true",
  scrapeTimeoutMs: readNumberEnv("SCRAPE_TIMEOUT_MS", 8 * 1000),
  pageSettleMs: readNumberEnv("PAGE_SETTLE_MS", 120),
  blockingDetectTimeoutMs: readNumberEnv("BLOCKING_DETECT_TIMEOUT_MS", 250),
  affiliateBaseUrl: readStringEnv(
    "AFFILIATE_BASE_URL",
    "https://affiliate.shopee.vn",
  ),
};

module.exports = {
  config,
};

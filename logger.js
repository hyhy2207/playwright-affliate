"use strict";

const fs = require("fs");
const path = require("path");

const { config } = require("./config");

const logDirectory = path.resolve(__dirname, config.logDir);
const taskLogPath = path.join(logDirectory, config.taskLogFile);
let hasWarnedAboutFileLogging = false;

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString("vi-VN", {
    hour12: false,
  });
}

function shorten(value, max = 96) {
  if (typeof value !== "string") return String(value);
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function formatConsoleLine(entry) {
  const prefix = `[${formatTime(entry.timestamp)}] ${entry.level.toUpperCase()}`;

  switch (entry.event) {
    case "server.started":
      return `${prefix} Server dang chay tai :${entry.port}`;
    case "server.error":
      return `${prefix} Server error: ${entry.message}`;
    case "product_store.ready":
      return `${prefix} Product store san sang (${entry.driver}) | products=${entry.productCount ?? "-"}`;
    case "product_store.init_failed":
      return `${prefix} Product store loi (${entry.driver}): ${entry.message}`;
    case "product_store.upsert_failed":
      return `${prefix} Luu product ${entry.itemId || "-"} vao store loi: ${entry.message}`;
    case "socket.connected":
      return `${prefix} Client #${entry.clientId} ket noi (${entry.role})`;
    case "socket.closed":
      return `${prefix} Client #${entry.clientId} dong ket noi (${entry.role})`;
    case "socket.error":
      return `${prefix} Socket error client #${entry.clientId}: ${entry.message}`;
    case "worker.registered":
      return `${prefix} Playwright worker #${entry.clientId || "-"} da dang ky`;
    case "task.registered":
      return `${prefix} Task ${entry.taskId} duoc tao cho ${shorten(entry.requestUrl)}`;
    case "task.queued":
      return `${prefix} Task ${entry.taskId} queued -> worker #${entry.workerClientId}`;
    case "task.cache_hit":
      return `${prefix} Task ${entry.taskId} tra ve tu cache item ${entry.itemId}`;
    case "task.started":
      return `${prefix} Task ${entry.taskId} dang chay`;
    case "task.succeeded":
      return `${prefix} Task ${entry.taskId} thanh cong | ${entry.productName} | ${entry.price} | parse ${entry.parseMs ?? "-"}ms`;
    case "task.failed":
      return `${prefix} Task ${entry.taskId} that bai${entry.errorCode ? ` (${entry.errorCode})` : ""}: ${entry.message}`;
    case "task.retry_scheduled":
      return `${prefix} Task ${entry.taskId} se retry lan ${entry.retryCount} | worker #${entry.workerClientId || "-"} | ${shorten(entry.reason || "")}`;
    case "task.history_upsert_failed":
      return `${prefix} Luu task history ${entry.taskId || "-"} vao store loi: ${entry.message}`;
    case "task.store_restored":
      return `${prefix} Da phuc hoi ${entry.restored} task active tu ${entry.driver}`;
    case "task.store_restore_failed":
      return `${prefix} Phuc hoi task active tu ${entry.driver} loi: ${entry.message}`;
    case "task.queue_driver_ready":
      return `${prefix} Queue driver san sang (${entry.driver}) | ${entry.queuePrefix || "-"}:${entry.queueName || "-"}`;
    case "task.queue_driver_fallback":
      return `${prefix} Queue driver fallback ${entry.requestedDriver} -> ${entry.fallbackDriver}: ${entry.message}`;
    case "task.queue_job_enqueued":
      return `${prefix} Queue job ${entry.taskId} duoc dua vao ${entry.driver} | delay=${entry.delayMs ?? 0}ms`;
    case "task.queue_job_activated":
      return `${prefix} Queue job ${entry.taskId} da san sang dispatch tu ${entry.driver}`;
    case "task.queue_job_removed":
      return `${prefix} Queue job ${entry.taskId} da bi xoa khoi ${entry.driver}`;
    case "task.queue_refresh_failed":
      return `${prefix} Queue refresh loi (${entry.driver}): ${entry.message}`;
    case "task.queue_enqueue_failed":
      return `${prefix} Queue enqueue loi task ${entry.taskId} (${entry.driver}): ${entry.message}`;
    case "task.queue_remove_failed":
      return `${prefix} Queue remove loi task ${entry.taskId} (${entry.driver}): ${entry.message}`;
    case "task.queue_worker_error":
      return `${prefix} Queue worker loi (${entry.driver}): ${entry.message}`;
    case "task.queue_job_failed":
      return `${prefix} Queue job ${entry.taskId || "-"} that bai (${entry.driver}): ${entry.message}`;
    case "task.cancelled":
      return `${prefix} Task ${entry.taskId} da huy`;
    case "task.timed_out":
      return `${prefix} Task ${entry.taskId} timeout: ${entry.message}`;
    case "task.late_result_ignored":
      return `${prefix} Bo qua ket qua muon cua task ${entry.taskId} (${entry.currentStatus})`;
    case "task.success_parse_failed":
      return `${prefix} Task ${entry.taskId} thanh cong nhung parse loi: ${entry.message}`;
    case "task.requester_disconnected":
      return `${prefix} Requester cua task ${entry.taskId} da mat ket noi`;
    case "task.cleanup":
      return `${prefix} Da don ${entry.removed} task cu | con lai ${entry.activeTaskCount}`;
    case "task.rejected":
    case "http.task_rejected":
      return `${prefix} Tu choi task ${entry.taskId || "-"}: ${entry.reason}`;
    case "http.invalid_request":
      return `${prefix} HTTP request khong hop le: ${entry.message}`;
    case "socket.invalid_json":
      return `${prefix} Message khong hop le: ${shorten(entry.preview || "", 72)}`;
    case "worker.invalid_result":
      return `${prefix} Worker gui ket qua khong hop le cho task ${entry.taskId || "-"}: ${entry.reason}`;
    case "worker.socket_connected":
      return `${prefix} Worker socket da ket noi ${entry.socketUrl}`;
    case "worker.socket_closed":
      return `${prefix} Worker socket da dong`;
    case "worker.socket_error":
      return `${prefix} Worker socket loi: ${entry.message}`;
    case "worker.invalid_message":
      return `${prefix} Worker nhan message khong hop le: ${entry.message}`;
    case "worker.profile_ready":
      return `${prefix} Profile Playwright san sang${entry.profileName ? ` (${entry.profileName})` : ""} | ${shorten(entry.currentUrl)}`;
    case "profile.auto_switch":
      return `${prefix} Auto switch profile ${entry.fromProfile || "-"} -> ${entry.toProfile || "-"}: ${shorten(entry.reason || "")}`;
    case "worker.login_required":
      return `${prefix} Profile Playwright chua login affiliate: ${entry.message}`;
    case "worker.session_status":
      return `${prefix} Session worker${entry.profileName ? ` (${entry.profileName})` : ""} | ready=${entry.workerReady} | login=${entry.affiliateLoggedIn} | ${shorten(entry.currentUrl || entry.message || "")}`;
    case "worker.fast_api_hit":
      return `${prefix} Fast API hit task ${entry.taskId} | ${entry.apiFetchMs}ms`;
    case "worker.fast_api_fallback":
      return `${prefix} Fast API fallback task ${entry.taskId} | ${entry.apiFetchMs}ms | ${entry.reason}`;
    case "worker.fallback_goto":
      return `${prefix} Fallback goto task ${entry.taskId} | ${entry.gotoMs}ms`;
    case "task.orphan_success":
      return `${prefix} Nhan SUCCESS cho task khong ton tai: ${entry.taskId}`;
    case "task.journal_restored":
      return `${prefix} Da phuc hoi ${entry.restored} task pending tu journal`;
    case "logger.file_logging_disabled":
      return `${prefix} Khong ghi duoc file log: ${entry.message}`;
    default: {
      const extra = { ...entry };
      delete extra.timestamp;
      delete extra.level;
      delete extra.event;
      const suffix = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
      return `${prefix} ${entry.event}${suffix}`;
    }
  }
}

function ensureLogDirectory() {
  fs.mkdirSync(logDirectory, { recursive: true });
}

function rotateTaskLogIfNeeded() {
  if (!config.logMaxBytes) return;
  if (!fs.existsSync(taskLogPath)) return;

  const stat = fs.statSync(taskLogPath);
  if (stat.size < config.logMaxBytes) return;

  const rotatedPath = `${taskLogPath}.1`;
  if (fs.existsSync(rotatedPath)) {
    fs.unlinkSync(rotatedPath);
  }
  fs.renameSync(taskLogPath, rotatedPath);
}

function createEntry(level, event, data) {
  return {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  };
}

function writeTaskLog(entry) {
  try {
    ensureLogDirectory();
    rotateTaskLogIfNeeded();
    fs.appendFileSync(taskLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    if (!hasWarnedAboutFileLogging) {
      hasWarnedAboutFileLogging = true;
      console.warn(
        JSON.stringify(
          createEntry("warn", "logger.file_logging_disabled", {
            taskLogPath,
            message: error.message,
          })
        )
      );
    }
  }
}

function emit(level, event, data = {}) {
  const entry = createEntry(level, event, data);
  const line = formatConsoleLine(entry);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  writeTaskLog(entry);
  return entry;
}

const logger = {
  info(event, data) {
    return emit("info", event, data);
  },
  warn(event, data) {
    return emit("warn", event, data);
  },
  error(event, data) {
    return emit("error", event, data);
  },
  paths: {
    taskLogPath,
  },
};

module.exports = {
  logger,
};

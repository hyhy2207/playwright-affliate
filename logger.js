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
    case "task.started":
      return `${prefix} Task ${entry.taskId} dang chay`;
    case "task.succeeded":
      return `${prefix} Task ${entry.taskId} thanh cong | ${entry.productName} | ${entry.price}`;
    case "task.failed":
      return `${prefix} Task ${entry.taskId} that bai: ${entry.message}`;
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
      return `${prefix} Profile Playwright san sang | ${shorten(entry.currentUrl)}`;
    case "worker.login_required":
      return `${prefix} Profile Playwright chua login affiliate: ${entry.message}`;
    case "task.orphan_success":
      return `${prefix} Nhan SUCCESS cho task khong ton tai: ${entry.taskId}`;
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

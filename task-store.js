"use strict";

const { config } = require("./config");

const TASK_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  SUCCESS: "success",
  ERROR: "error",
};

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function toTimeMs(value) {
  return value ? new Date(value).getTime() : 0;
}

function createTaskStore() {
  const tasks = new Map();

  function cleanupExpiredTasks() {
    const cutoff = nowMs() - config.taskRetentionMs;
    let removed = 0;

    for (const [taskId, task] of tasks.entries()) {
      const isCompleted = task.status === TASK_STATUS.SUCCESS || task.status === TASK_STATUS.ERROR;
      if (!isCompleted) continue;

      if (toTimeMs(task.updatedAt) <= cutoff) {
        tasks.delete(taskId);
        removed++;
      }
    }

    return removed;
  }

  function timeoutStuckTasks() {
    const now = nowMs();
    const timedOut = [];

    for (const [taskId, task] of tasks.entries()) {
      if (task.status === TASK_STATUS.QUEUED) {
        const createdAtMs = toTimeMs(task.createdAt);
        if (createdAtMs > 0 && now - createdAtMs >= config.taskQueueTimeoutMs) {
          const timestamp = nowIso();
          const nextTask = {
            ...task,
            status: TASK_STATUS.ERROR,
            errorCode: "TASK_QUEUE_TIMEOUT",
            error: `Task queued qua ${config.taskQueueTimeoutMs}ms ma worker chua bat dau`,
            endedAt: timestamp,
            updatedAt: timestamp,
          };
          tasks.set(taskId, nextTask);
          timedOut.push(nextTask);
        }
      }

      if (task.status === TASK_STATUS.RUNNING) {
        const startedAtMs = toTimeMs(task.startedAt || task.updatedAt);
        if (startedAtMs > 0 && now - startedAtMs >= config.taskTimeoutMs) {
          const timestamp = nowIso();
          const nextTask = {
            ...task,
            status: TASK_STATUS.ERROR,
            errorCode: "TASK_TIMEOUT",
            error: `Task running qua ${config.taskTimeoutMs}ms ma chua co ket qua`,
            endedAt: timestamp,
            updatedAt: timestamp,
          };
          tasks.set(taskId, nextTask);
          timedOut.push(nextTask);
        }
      }
    }

    return timedOut;
  }

  function createTask({ taskId, requestUrl, requesterClientId = null, status = TASK_STATUS.QUEUED }) {
    cleanupExpiredTasks();

    const timestamp = nowIso();
    const task = {
      taskId,
      requestUrl,
      requesterClientId,
      status,
      affiliateUrl: null,
      result: null,
      raw: null,
      error: null,
      errorCode: null,
      parseError: null,
      startedAt: null,
      endedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    tasks.set(taskId, task);
    return task;
  }

  function getTask(taskId) {
    cleanupExpiredTasks();
    return tasks.get(taskId) || null;
  }

  function hasTask(taskId) {
    cleanupExpiredTasks();
    return tasks.has(taskId);
  }

  function updateTask(taskId, patch) {
    cleanupExpiredTasks();

    const current = getTask(taskId);
    if (!current) return null;

    const nextTask = {
      ...current,
      ...patch,
      updatedAt: nowIso(),
    };

    if (
      patch.status === TASK_STATUS.RUNNING &&
      !current.startedAt &&
      !patch.startedAt
    ) {
      nextTask.startedAt = nowIso();
    }

    if (
      (patch.status === TASK_STATUS.SUCCESS || patch.status === TASK_STATUS.ERROR) &&
      !patch.endedAt
    ) {
      nextTask.endedAt = nowIso();
    }

    tasks.set(taskId, nextTask);
    return nextTask;
  }

  function removeTask(taskId) {
    cleanupExpiredTasks();
    const current = getTask(taskId);
    tasks.delete(taskId);
    return current;
  }

  function listTasks(options = {}) {
    cleanupExpiredTasks();

    const { status } = options;
    const items = Array.from(tasks.values());

    if (!status) return items;
    return items.filter((task) => task.status === status);
  }

  return {
    TASK_STATUS,
    createTask,
    getTask,
    hasTask,
    updateTask,
    removeTask,
    listTasks,
    cleanupExpiredTasks,
    timeoutStuckTasks,
    size() {
      cleanupExpiredTasks();
      return tasks.size;
    },
  };
}

const taskStore = createTaskStore();

module.exports = {
  TASK_STATUS,
  createTaskStore,
  taskStore,
};

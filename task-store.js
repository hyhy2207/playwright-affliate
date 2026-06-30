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
  const taskListeners = new Map();

  function notifyTaskListeners(taskId, task) {
    const listeners = taskListeners.get(taskId);
    if (!listeners || listeners.size === 0) return;

    for (const listener of listeners) {
      try {
        listener(task);
      } catch {}
    }
  }

  function subscribeTask(taskId, listener) {
    if (!taskId || typeof listener !== "function") {
      return () => {};
    }

    const listeners = taskListeners.get(taskId) || new Set();
    listeners.add(listener);
    taskListeners.set(taskId, listeners);

    return () => {
      const current = taskListeners.get(taskId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        taskListeners.delete(taskId);
      }
    };
  }

  function cleanupExpiredTasks() {
    const cutoff = nowMs() - config.taskRetentionMs;
    let removed = 0;

    for (const [taskId, task] of tasks.entries()) {
      const isCompleted = task.status === TASK_STATUS.SUCCESS || task.status === TASK_STATUS.ERROR;
      if (!isCompleted) continue;

      if (toTimeMs(task.updatedAt) <= cutoff) {
        tasks.delete(taskId);
        notifyTaskListeners(taskId, null);
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
          notifyTaskListeners(taskId, nextTask);
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
          notifyTaskListeners(taskId, nextTask);
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
      assignedWorkerClientId: null,
      queueTracked: false,
      status,
      itemId: null,
      requestPayload: null,
      retryCount: 0,
      maxRetries: config.taskMaxRetries,
      nextAttemptAt: null,
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
    notifyTaskListeners(taskId, task);
    return task;
  }

  function hydrateTask(snapshot) {
    if (!snapshot?.taskId) return null;

    cleanupExpiredTasks();

    const timestamp = nowIso();
    const baseTask = {
      taskId: snapshot.taskId,
      requestUrl: snapshot.requestUrl || snapshot.itemId || "",
      requesterClientId: snapshot.requesterClientId ?? null,
      assignedWorkerClientId: snapshot.assignedWorkerClientId ?? null,
      queueTracked: Boolean(snapshot.queueTracked),
      status: snapshot.status || TASK_STATUS.QUEUED,
      itemId: snapshot.itemId || null,
      requestPayload: snapshot.requestPayload || null,
      retryCount: Number(snapshot.retryCount || 0),
      maxRetries: Number(snapshot.maxRetries || config.taskMaxRetries),
      nextAttemptAt: snapshot.nextAttemptAt || null,
      affiliateUrl: snapshot.affiliateUrl || null,
      result: snapshot.result ?? null,
      raw: snapshot.raw ?? null,
      error: snapshot.error || null,
      errorCode: snapshot.errorCode || null,
      parseError: snapshot.parseError || null,
      startedAt: snapshot.startedAt || null,
      endedAt: snapshot.endedAt || null,
      createdAt: snapshot.createdAt || timestamp,
      updatedAt: snapshot.updatedAt || timestamp,
    };

    tasks.set(baseTask.taskId, baseTask);
    notifyTaskListeners(baseTask.taskId, baseTask);
    return baseTask;
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
    notifyTaskListeners(taskId, nextTask);
    return nextTask;
  }

  function removeTask(taskId) {
    cleanupExpiredTasks();
    const current = getTask(taskId);
    tasks.delete(taskId);
    notifyTaskListeners(taskId, null);
    return current;
  }

  function waitForTaskCompletion(taskId, timeoutMs) {
    const current = getTask(taskId);
    if (!current || current.status === TASK_STATUS.SUCCESS || current.status === TASK_STATUS.ERROR) {
      return Promise.resolve(current);
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeout = null;
      let unsubscribe = () => {};

      function finish(task) {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(task);
      }

      unsubscribe = subscribeTask(taskId, (task) => {
        if (!task || task.status === TASK_STATUS.SUCCESS || task.status === TASK_STATUS.ERROR) {
          finish(task);
        }
      });

      if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
        timeout = setTimeout(() => {
          finish(getTask(taskId));
        }, timeoutMs);

        if (typeof timeout.unref === "function") {
          timeout.unref();
        }
      }
    });
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
    hydrateTask,
    getTask,
    hasTask,
    updateTask,
    removeTask,
    listTasks,
    subscribeTask,
    waitForTaskCompletion,
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

"use strict";

const QUEUED_STATUS = "queued";

function nowMs() {
  return Date.now();
}

function toTimeMs(value) {
  return value ? new Date(value).getTime() : 0;
}

function createMemoryTaskQueue({ taskStore, logger }) {
  const queuedTaskIds = [];
  const queuedTaskIdSet = new Set();
  const delayedTaskTimers = new Map();
  let readyHandler = null;

  function toTaskId(taskOrTaskId) {
    return typeof taskOrTaskId === "object" && taskOrTaskId?.taskId
      ? taskOrTaskId.taskId
      : taskOrTaskId;
  }

  function notifyReady() {
    if (typeof readyHandler === "function") {
      readyHandler();
    }
  }

  function clearDelayedTimer(taskId) {
    const timer = delayedTaskTimers.get(taskId);
    if (!timer) return;

    clearTimeout(timer);
    delayedTaskTimers.delete(taskId);
  }

  function remove(taskOrTaskId) {
    const taskId = toTaskId(taskOrTaskId);
    if (!taskId) return false;

    clearDelayedTimer(taskId);

    const hadTask = queuedTaskIdSet.delete(taskId);
    if (!hadTask) return false;

    const index = queuedTaskIds.indexOf(taskId);
    if (index >= 0) {
      queuedTaskIds.splice(index, 1);
    }

    return true;
  }

  function enqueue(taskOrTaskId) {
    const taskId = toTaskId(taskOrTaskId);
    if (!taskId) return false;

    clearDelayedTimer(taskId);

    if (queuedTaskIdSet.has(taskId)) {
      return false;
    }

    queuedTaskIdSet.add(taskId);
    queuedTaskIds.push(taskId);
    notifyReady();
    return true;
  }

  function schedule(taskOrTaskId, delayMs) {
    const taskId = toTaskId(taskOrTaskId);
    if (!taskId) return false;

    remove(taskId);

    const normalizedDelayMs = Math.max(0, Number(delayMs || 0));
    if (normalizedDelayMs === 0) {
      return enqueue(taskId);
    }

    const timer = setTimeout(() => {
      delayedTaskTimers.delete(taskId);
      enqueue(taskId);
    }, normalizedDelayMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

    delayedTaskTimers.set(taskId, timer);
    return true;
  }

  function dequeueReadyTask() {
    while (queuedTaskIds.length > 0) {
      const taskId = queuedTaskIds.shift();
      queuedTaskIdSet.delete(taskId);

      const task = taskStore.getTask(taskId);
      if (!task) continue;
      if (task.status !== QUEUED_STATUS) continue;

      const nextAttemptAtMs = toTimeMs(task.nextAttemptAt);
      if (nextAttemptAtMs > nowMs()) {
        schedule(taskId, nextAttemptAtMs - nowMs());
        continue;
      }

      return task;
    }

    return null;
  }

  function restore(tasks) {
    if (!Array.isArray(tasks)) return 0;

    let restored = 0;
    for (const task of tasks) {
      if (!task?.taskId || task.status !== QUEUED_STATUS) {
        continue;
      }

      const nextAttemptAtMs = toTimeMs(task.nextAttemptAt);
      if (nextAttemptAtMs > nowMs()) {
        schedule(task.taskId, nextAttemptAtMs - nowMs());
      } else {
        enqueue(task.taskId);
      }
      restored += 1;
    }

    logger?.info?.("task.queue_restored", {
      driver: "memory",
      restored,
      queued: queuedTaskIds.length,
      delayed: delayedTaskTimers.size,
    });

    return restored;
  }

  return {
    driver: "memory",
    async init() {},
    async close() {},
    enqueue,
    schedule,
    remove,
    dequeueReadyTask,
    restore,
    setReadyHandler(handler) {
      readyHandler = typeof handler === "function" ? handler : null;
    },
    has(taskId) {
      return queuedTaskIdSet.has(taskId) || delayedTaskTimers.has(taskId);
    },
    async hasPersistedJob(taskId) {
      return queuedTaskIdSet.has(taskId) || delayedTaskTimers.has(taskId);
    },
    size() {
      return queuedTaskIds.length;
    },
    delayedSize() {
      return delayedTaskTimers.size;
    },
    async stats() {
      return {
        driver: "memory",
        waiting: queuedTaskIds.length,
        delayed: delayedTaskTimers.size,
        readyBuffer: queuedTaskIds.length,
      };
    },
  };
}

module.exports = {
  createMemoryTaskQueue,
};

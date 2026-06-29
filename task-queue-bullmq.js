"use strict";

const QUEUED_STATUS = "queued";

function nowMs() {
  return Date.now();
}

function toTimeMs(value) {
  return value ? new Date(value).getTime() : 0;
}

function parseRedisConnection(redisUrl) {
  const parsed = new URL(redisUrl);
  const connection = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    db: parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) || 0 : 0,
    maxRetriesPerRequest: null,
  };

  if (parsed.username) {
    connection.username = decodeURIComponent(parsed.username);
  }

  if (parsed.password) {
    connection.password = decodeURIComponent(parsed.password);
  }

  if (parsed.protocol === "rediss:") {
    connection.tls = {};
  }

  return connection;
}

function createBullMqTaskQueue({ taskStore, logger, config }) {
  const readyTaskIds = [];
  const readyTaskIdSet = new Set();
  let readyHandler = null;
  let queue = null;
  let worker = null;
  let counts = { waiting: 0, delayed: 0 };
  let refreshTimer = null;
  let initPromise = null;

  function normalizeTaskSnapshot(taskOrTaskId) {
    if (taskOrTaskId && typeof taskOrTaskId === "object" && taskOrTaskId.taskId) {
      return taskOrTaskId;
    }

    const taskId = String(taskOrTaskId || "").trim();
    if (!taskId) return null;

    return taskStore.getTask(taskId);
  }

  function notifyReady() {
    if (typeof readyHandler === "function") {
      readyHandler();
    }
  }

  function pushReadyTaskId(taskId) {
    if (!taskId || readyTaskIdSet.has(taskId)) {
      return false;
    }

    readyTaskIdSet.add(taskId);
    readyTaskIds.push(taskId);
    notifyReady();
    return true;
  }

  function removeReadyTaskId(taskId) {
    if (!taskId) return false;

    const existed = readyTaskIdSet.delete(taskId);
    if (!existed) return false;

    const index = readyTaskIds.indexOf(taskId);
    if (index >= 0) {
      readyTaskIds.splice(index, 1);
    }

    return true;
  }

  async function refreshCounts() {
    if (!queue) return counts;

    try {
      const jobCounts = await queue.getJobCounts("wait", "prioritized", "delayed");
      counts = {
        waiting: Number(jobCounts.wait || 0) + Number(jobCounts.prioritized || 0),
        delayed: Number(jobCounts.delayed || 0),
      };
    } catch (error) {
      logger.warn("task.queue_refresh_failed", {
        driver: "bullmq",
        message: error.message,
      });
    }

    return counts;
  }

  function scheduleRefreshCounts() {
    void refreshCounts();
  }

  function addJob(taskOrTaskId, delayMs = 0) {
    const taskSnapshot = normalizeTaskSnapshot(taskOrTaskId);
    const taskId = taskSnapshot?.taskId || String(taskOrTaskId || "").trim();
    if (!queue) {
      logger.warn("task.queue_not_ready", {
        driver: "bullmq",
        taskId,
      });
      return false;
    }

    void queue
      .add(
        "dispatch-task",
        { taskId, task: taskSnapshot },
        {
          jobId: String(taskId),
          delay: Math.max(0, Number(delayMs || 0)),
          removeOnComplete: true,
          removeOnFail: true,
        },
      )
      .then(() => {
          logger.info("task.queue_job_enqueued", {
            driver: "bullmq",
            taskId,
          delayMs: Math.max(0, Number(delayMs || 0)),
        });
        scheduleRefreshCounts();
      })
      .catch((error) => {
        logger.error("task.queue_enqueue_failed", {
          driver: "bullmq",
          taskId,
          message: error.message,
        });
      });

    return true;
  }

  function remove(taskOrTaskId) {
    const taskId =
      typeof taskOrTaskId === "object" && taskOrTaskId?.taskId
        ? taskOrTaskId.taskId
        : taskOrTaskId;
    removeReadyTaskId(taskId);

    if (!queue || !taskId) return false;

    void queue
      .getJob(String(taskId))
      .then((job) => (job ? job.remove() : null))
      .then(() => {
        logger.info("task.queue_job_removed", {
          driver: "bullmq",
          taskId,
        });
        scheduleRefreshCounts();
      })
      .catch((error) => {
        logger.warn("task.queue_remove_failed", {
          driver: "bullmq",
          taskId,
          message: error.message,
        });
      });

    return true;
  }

  function enqueue(taskOrTaskId) {
    const taskSnapshot = normalizeTaskSnapshot(taskOrTaskId);
    removeReadyTaskId(taskSnapshot?.taskId || taskOrTaskId);
    return addJob(taskSnapshot || taskOrTaskId, 0);
  }

  function schedule(taskOrTaskId, delayMs) {
    const taskSnapshot = normalizeTaskSnapshot(taskOrTaskId);
    remove(taskSnapshot || taskOrTaskId);
    return addJob(taskSnapshot || taskOrTaskId, delayMs);
  }

  function dequeueReadyTask() {
    while (readyTaskIds.length > 0) {
      const taskId = readyTaskIds.shift();
      readyTaskIdSet.delete(taskId);

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

    const restored = tasks.filter(
      (task) => task?.taskId && task.status === QUEUED_STATUS,
    ).length;

    // BullMQ/Redis la source of truth cho pending/delayed jobs,
    // nen startup khong duoc enqueue lai job tu RAM/DB snapshot.
    scheduleRefreshCounts();

    logger?.info?.("task.queue_restored", {
      driver: "bullmq",
      restored,
      queued: readyTaskIds.length,
      delayed: counts.delayed,
    });

    return restored;
  }

  async function init() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      let Queue;
      let Worker;

      try {
        ({ Queue, Worker } = require("bullmq"));
      } catch (error) {
        throw new Error(
          `QUEUE_DRIVER=bullmq nhung chua co dependency bullmq/ioredis. Chi tiet: ${error.message}`,
        );
      }

      const connection = parseRedisConnection(config.redisUrl);
      queue = new Queue(config.queueName, {
        connection,
        prefix: config.queuePrefix,
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: true,
        },
      });

      worker = new Worker(
        config.queueName,
        async (job) => {
          if (!taskStore.getTask(job.data?.taskId) && job.data?.task?.taskId) {
            taskStore.hydrateTask(job.data.task);
          }
          logger.info("task.queue_job_activated", {
            driver: "bullmq",
            taskId: job.data?.taskId || null,
          });
          pushReadyTaskId(job.data?.taskId || null);
          return {
            acceptedAt: new Date().toISOString(),
            taskId: job.data?.taskId || null,
          };
        },
        {
          connection,
          prefix: config.queuePrefix,
          concurrency: config.queueDispatchConcurrency,
        },
      );

      worker.on("error", (error) => {
        logger.error("task.queue_worker_error", {
          driver: "bullmq",
          message: error.message,
        });
      });

      worker.on("failed", (job, error) => {
        logger.warn("task.queue_job_failed", {
          driver: "bullmq",
          taskId: job?.data?.taskId || null,
          message: error.message,
        });
      });

      refreshTimer = setInterval(() => {
        void refreshCounts();
      }, 5000);
      if (typeof refreshTimer.unref === "function") {
        refreshTimer.unref();
      }

      await refreshCounts();
      logger.info("task.queue_driver_ready", {
        driver: "bullmq",
        queueName: config.queueName,
        queuePrefix: config.queuePrefix,
        redisUrl: config.redisUrl,
      });
    })();

    return initPromise;
  }

  async function close() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }

    await Promise.allSettled([
      worker ? worker.close() : Promise.resolve(),
      queue ? queue.close() : Promise.resolve(),
    ]);
  }

  return {
    driver: "bullmq",
    init,
    close,
    enqueue,
    schedule,
    remove,
    dequeueReadyTask,
    restore,
    setReadyHandler(handler) {
      readyHandler = typeof handler === "function" ? handler : null;
    },
    has(taskId) {
      return readyTaskIdSet.has(taskId);
    },
    async hasPersistedJob(taskId) {
      if (!queue || !taskId) return false;

      const job = await queue.getJob(String(taskId));
      if (!job) return false;

      const state = await job.getState();
      return state === "waiting" || state === "delayed" || state === "prioritized" || state === "active";
    },
    size() {
      return readyTaskIds.length + counts.waiting;
    },
    delayedSize() {
      return counts.delayed;
    },
    async stats() {
      const currentCounts = await refreshCounts();
      return {
        driver: "bullmq",
        waiting: currentCounts.waiting,
        delayed: currentCounts.delayed,
        readyBuffer: readyTaskIds.length,
        queueName: config.queueName,
        queuePrefix: config.queuePrefix,
      };
    },
  };
}

module.exports = {
  createBullMqTaskQueue,
};

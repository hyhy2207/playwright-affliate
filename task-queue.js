"use strict";

const { createBullMqTaskQueue } = require("./task-queue-bullmq");
const { createMemoryTaskQueue } = require("./task-queue-memory");

function createTaskQueue(options) {
  const driver = String(options?.config?.queueDriver || "memory").trim().toLowerCase();

  if (driver === "bullmq") {
    return createBullMqTaskQueue(options);
  }

  return createMemoryTaskQueue(options);
}

async function createTaskQueueWithFallback(options) {
  const primaryDriver = String(options?.config?.queueDriver || "memory").trim().toLowerCase();
  const fallbackDriver = String(
    options?.config?.queueDriverFallback || "memory",
  ).trim().toLowerCase();

  let queue = createTaskQueue(options);
  try {
    await queue.init();
    return queue;
  } catch (error) {
    if (primaryDriver === fallbackDriver) {
      throw error;
    }

    options?.logger?.warn?.("task.queue_driver_fallback", {
      requestedDriver: primaryDriver,
      fallbackDriver,
      message: error.message,
    });

    const fallbackQueue = createTaskQueue({
      ...options,
      config: {
        ...options.config,
        queueDriver: fallbackDriver,
      },
    });
    await fallbackQueue.init();
    return fallbackQueue;
  }
}

module.exports = {
  createTaskQueue,
  createTaskQueueWithFallback,
};

// =========================================
// server.js
// HTTP + WebSocket relay for Playwright worker
// =========================================

const crypto = require("crypto");
const http = require("http");
const WebSocket = require("ws");

const { config } = require("./config");
const { logger } = require("./logger");
const shopeeProvider = require("./providers/shopee");
const {
  buildErrorMessage,
  normalizeHttpPayload,
  normalizeListQueryValue,
  readBooleanQuery,
  readJsonBody,
  sendHttpJson,
} = require("./http-utils");
const {
  disableProfile,
  findProfileByNameOrId,
  loadProfiles,
  recoverProfile,
  setDefaultProfile,
  summarizeProfiles,
  updateProfileState,
} = require("./profile-manager");
const { productStore } = require("./product-store");
const { buildTaskResponse } = require("./task-presenter");
const { createTaskQueue, createTaskQueueWithFallback } = require("./task-queue");
const { taskStore, TASK_STATUS } = require("./task-store");
const {
  isValidItemId,
  validateExtensionResult,
  validateScrapeRequest,
} = require("./validation");

let nextClientId = 1;

const requesterSockets = new Map();
const productCache = new Map();
const inFlightProductRequests = new Map();
let taskQueue = createTaskQueue({ taskStore, logger, config });

let latestWorkerSession = {
  workerReady: false,
  affiliateLoggedIn: false,
  currentUrl: null,
  mode: null,
  profileName: null,
  profileDir: null,
  message: null,
  updatedAt: null,
};

const RETRYABLE_ERROR_CODES = new Set([
  "WORKER_ERROR",
  "CDP_DISCONNECTED",
]);

function normalizeOutputMode(value) {
  return shopeeProvider.normalizeOutputMode(value);
}

function isProductCacheEnabled() {
  return config.productCacheTtlMs > 0;
}

function getCachedProduct(itemId) {
  if (!isProductCacheEnabled()) return null;

  const cached = productCache.get(String(itemId || ""));
  if (!cached) return null;

  if (Date.now() - cached.cachedAtMs > config.productCacheTtlMs) {
    productCache.delete(String(itemId));
    return null;
  }

  return cached;
}

function setCachedProduct(product, raw, affiliateUrl) {
  if (!isProductCacheEnabled() || !product?.productID) return;

  productCache.set(String(product.productID), {
    itemId: String(product.productID),
    result: product,
    raw,
    affiliateUrl,
    cachedAt: new Date().toISOString(),
    cachedAtMs: Date.now(),
  });
}

async function persistProduct(product, raw, affiliateUrl, source = "worker") {
  try {
    await productStore.upsertProduct({
      product,
      raw,
      affiliateUrl,
      source,
    });
  } catch (error) {
    logger.warn("product_store.upsert_failed", {
      itemId: product?.productID || null,
      message: error.message,
    });
  }
}

async function persistTaskRecord(task) {
  if (!task?.taskId || typeof productStore.upsertTaskRecord !== "function") {
    return;
  }

  try {
    await productStore.upsertTaskRecord(task);
  } catch (error) {
    logger.warn("task.history_upsert_failed", {
      taskId: task.taskId,
      message: error.message,
    });
  }
}

async function markTaskHistoryStale(task, errorCode, errorMessage) {
  if (!task?.taskId) return null;

  const staleTask = {
    ...task,
    status: TASK_STATUS.ERROR,
    errorCode,
    error: errorMessage,
    endedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await persistTaskRecord(staleTask);
  return staleTask;
}

function waitForTaskDone(taskId, timeoutMs) {
  return taskStore.waitForTaskCompletion(taskId, timeoutMs);
}

async function readProductStoreSize() {
  try {
    return await productStore.size();
  } catch {
    return null;
  }
}

function shouldBackgroundRevalidate(stored, options = {}) {
  if (!options.staleWhileRevalidate || !stored?.updatedAt) {
    return false;
  }

  const updatedAtMs = new Date(stored.updatedAt).getTime();
  if (!Number.isFinite(updatedAtMs)) {
    return true;
  }

  return Date.now() - updatedAtMs >= config.productCacheTtlMs;
}

function triggerBackgroundProductRefresh(itemId, mode, source = "store") {
  const refreshMode = normalizeOutputMode(mode || "compact");
  const refreshKey = `${String(itemId)}:${refreshMode}:refresh`;
  if (inFlightProductRequests.has(refreshKey)) {
    return;
  }

  logger.info("product.revalidate_scheduled", {
    itemId,
    mode: refreshMode,
    source,
  });

  void fetchProductByItemId(itemId, refreshMode, {
    refresh: true,
    staleWhileRevalidate: false,
  }).catch((error) => {
    logger.warn("product_store.upsert_failed", {
      itemId,
      message: `Background refresh loi: ${error.message}`,
    });
  });
}

async function fetchProductByItemIdDirect(itemId, mode, options = {}) {
  const startedAt = Date.now();
  const refresh = Boolean(options.refresh);

  if (!refresh) {
    const cached = getCachedProduct(itemId);
    if (cached) {
      const product = shopeeProvider.buildProductPayload(cached, mode, {
        productCacheTtlMs: config.productCacheTtlMs,
      });
      return {
        statusCode: 200,
        payload: {
          data: {
            type: "SUCCESS",
            ...product,
          },
        },
      };
    }

    const stored = await productStore.getProduct(itemId);
    if (stored) {
      const entry = shopeeProvider.buildStoreProductEntry(stored);
      const product = shopeeProvider.buildProductPayload(entry, mode, {
        productCacheTtlMs: config.productCacheTtlMs,
      });
      setCachedProduct(stored.result, stored.raw, stored.affiliateUrl);
      const staleWhileRevalidate = shouldBackgroundRevalidate(stored, options);
      if (staleWhileRevalidate) {
        triggerBackgroundProductRefresh(itemId, mode, "store");
      }
      return {
        statusCode: 200,
        payload: {
          data: {
            type: "SUCCESS",
            ...product,
          },
        },
      };
    }
  }

  const payload = {
    taskId: crypto.randomUUID(),
    itemId,
    skipCache: refresh,
  };
  const queued = enqueueTaskForWorker(payload, null);
  if (!queued.ok) {
    return {
      statusCode: queued.statusCode,
      payload: queued.error,
    };
  }

  const task = await waitForTaskDone(payload.taskId, config.productRequestTimeoutMs);
  if (task?.status === TASK_STATUS.SUCCESS) {
    const product = shopeeProvider.buildTaskProductPayload(task, mode, {
      productCacheTtlMs: config.productCacheTtlMs,
    });
    return {
      statusCode: 200,
      payload: {
        data: {
          type: "SUCCESS",
          ...product,
        },
      },
    };
  }

  if (task?.status === TASK_STATUS.ERROR) {
    return {
      statusCode: 502,
      payload: {
        type: "ERROR",
        itemId,
        error: task.error,
        errorCode: task.errorCode,
        task: buildTaskResponse(task, { defaultMaxRetries: config.taskMaxRetries }),
        durationMs: Date.now() - startedAt,
      },
    };
  }

  return {
    statusCode: 202,
    payload: {
      type: "QUEUED",
      message: "Task dang xu ly, lay ket qua bang /tasks/:taskId",
      itemId,
      task: task
        ? buildTaskResponse(task, { defaultMaxRetries: config.taskMaxRetries })
        : buildTaskResponse(queued.task, { defaultMaxRetries: config.taskMaxRetries }),
      durationMs: Date.now() - startedAt,
    },
  };
}

async function fetchProductByItemId(itemId, mode, options = {}) {
  const refresh = Boolean(options.refresh);
  const inFlightKey = `${String(itemId)}:${String(mode || "compact")}:${refresh ? "refresh" : "default"}`;

  if (inFlightProductRequests.has(inFlightKey)) {
    return inFlightProductRequests.get(inFlightKey);
  }

  const requestPromise = fetchProductByItemIdDirect(itemId, mode, options)
    .finally(() => {
      if (inFlightProductRequests.get(inFlightKey) === requestPromise) {
        inFlightProductRequests.delete(inFlightKey);
      }
    });

  inFlightProductRequests.set(inFlightKey, requestPromise);
  return requestPromise;
}

function sendJson(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function getRequesterSocket(taskId) {
  return requesterSockets.get(taskId) || null;
}

function clearRequesterSocket(taskId) {
  requesterSockets.delete(taskId);
}

function sendTaskUpdate(taskId, patch) {
  const task = taskStore.getTask(taskId);
  if (!task) return;

  const requester = getRequesterSocket(taskId);
  if (!requester) return;

  const payload = {
    type: patch.type,
    status: patch.status || task.status,
    taskId: task.taskId,
    requestUrl: task.requestUrl,
  };

  if (patch.message) payload.message = patch.message;
  if (patch.error) payload.error = patch.error;
  if (patch.errorCode) payload.errorCode = patch.errorCode;
  if (patch.affiliateUrl) payload.affiliateUrl = patch.affiliateUrl;
  if ("result" in patch) payload.result = patch.result;
  if (patch.parseError) payload.parseError = patch.parseError;

  sendJson(requester, payload);
}

function getWorkerClients(wss) {
  return Array.from(wss.clients).filter(
    (client) => client.readyState === WebSocket.OPEN && client.meta?.role === "worker"
  );
}

function registerTask(payload, requester) {
  const requestUrl = payload.url || payload.itemId;
  const task = taskStore.createTask({
    taskId: payload.taskId,
    requestUrl,
    requesterClientId: requester?.meta?.clientId ?? null,
    status: TASK_STATUS.QUEUED,
  });

  task.itemId = shopeeProvider.getRequestItemId(payload) || null;
  task.requestPayload = {
    taskId: payload.taskId,
    url: payload.url || "",
    itemId:
      typeof payload.itemId === "string" && payload.itemId.trim()
        ? payload.itemId.trim()
        : "",
  };
  task.retryCount = Number(payload.retryCount || 0);
  task.maxRetries = Number(payload.maxRetries || config.taskMaxRetries);
  void persistTaskRecord(task);

  if (requester) {
    requesterSockets.set(payload.taskId, requester);
  }

  logger.info("task.registered", {
    taskId: task.taskId,
    requestUrl: task.requestUrl,
    requesterClientId: task.requesterClientId,
    activeTaskCount: taskStore.size(),
  });

  return task;
}

function clearTasksForSocket(ws) {
  for (const task of taskStore.listTasks()) {
    const requester = requesterSockets.get(task.taskId);

    if (requester === ws) {
      logger.warn("task.requester_disconnected", {
        taskId: task.taskId,
        clientId: ws.meta?.clientId,
        requestUrl: task.requestUrl,
      });
      clearRequesterSocket(task.taskId);
    }
  }

  if (ws.meta?.role === "worker") {
    requeueTasksForWorker(ws.meta.clientId);
  }
}

function parseIncomingMessage(raw) {
  try {
    return { ok: true, payload: JSON.parse(raw.toString()) };
  } catch {
    return { ok: false, rawText: raw.toString() };
  }
}

function parseWsCommand(rawText) {
  const parsed = shopeeProvider.parseWsCommand(rawText);
  if (!parsed?.payload) return null;

  return {
    payload: {
      taskId: crypto.randomUUID(),
      ...parsed.payload,
    },
  };
}

function getProfileIdFromPath(pathname, suffix = "") {
  const prefix = "/profiles/";
  if (!pathname.startsWith(prefix)) return "";

  const raw = suffix && pathname.endsWith(suffix)
    ? pathname.slice(prefix.length, -suffix.length)
    : pathname.slice(prefix.length);
  return decodeURIComponent(raw).trim();
}

function isCompletedTask(task) {
  return task?.status === TASK_STATUS.SUCCESS || task?.status === TASK_STATUS.ERROR;
}

function updateTask(taskId, patch) {
  const task = taskStore.updateTask(taskId, patch);
  if (!task) return null;

  if (isCompletedTask(task)) {
    if (task.queueTracked) {
      taskQueue.remove(task.taskId);
    }
  }

  void persistTaskRecord(task);

  return task;
}

function drainTaskQueue() {
  const workers = getWorkerClients(wss);
  if (workers.length === 0) return 0;

  let dispatched = 0;

  while (true) {
    const task = taskQueue.dequeueReadyTask();
    if (!task) break;

    const worker = workers[dispatched % workers.length];
    if (!worker) {
      taskQueue.enqueue(task.taskId);
      break;
    }

    dispatchTaskToWorker(task, worker, task.retryCount);
    dispatched += 1;
  }

  return dispatched;
}

function requeueTasksForWorker(workerClientId) {
  if (!workerClientId) return 0;

  let requeued = 0;

  for (const task of taskStore.listTasks()) {
    if (task.assignedWorkerClientId !== workerClientId) continue;
    if (isCompletedTask(task)) continue;

    const nextTask = updateTask(task.taskId, {
      status: TASK_STATUS.QUEUED,
      assignedWorkerClientId: null,
      queueTracked: true,
      startedAt: null,
      endedAt: null,
      error: null,
      errorCode: null,
    });
    if (!nextTask) continue;

    taskQueue.enqueue(task.taskId);
    requeued += 1;
  }

  if (requeued > 0) {
    logger.warn("task.requeued_after_worker_disconnect", {
      workerClientId,
      requeued,
    });
  }

  return requeued;
}

function attachTaskQueueReadyHandler() {
  taskQueue.setReadyHandler(() => {
    drainTaskQueue();
  });
}

attachTaskQueueReadyHandler();

function cleanupExpiredTasks() {
  const timedOutTasks = taskStore.timeoutStuckTasks();
  for (const task of timedOutTasks) {
    logger.warn("task.timed_out", {
      taskId: task.taskId,
      requestUrl: task.requestUrl,
      status: task.status,
      message: task.error,
    });
    sendTaskUpdate(task.taskId, {
      type: "ERROR",
      status: TASK_STATUS.ERROR,
      error: task.error,
      errorCode: task.errorCode,
      result: null,
    });
    clearRequesterSocket(task.taskId);
  }

  const removed = taskStore.cleanupExpiredTasks();
  if (removed > 0) {
    logger.info("task.cleanup", {
      removed,
      activeTaskCount: taskStore.size(),
    });
  }
}

async function listTaskHistory(options = {}) {
  if (typeof productStore.listTaskRecords !== "function") {
    return taskStore
      .listTasks(options)
      .map((task) => buildTaskResponse(task, { defaultMaxRetries: config.taskMaxRetries }));
  }

  const statuses = options.status ? [options.status] : [];
  const rows = await productStore.listTaskRecords({
    statuses,
    limit: 500,
  });
  return rows.map((task) => buildTaskResponse(task, { defaultMaxRetries: config.taskMaxRetries }));
}

async function getTaskById(taskId) {
  const current = taskStore.getTask(taskId);
  if (current) return current;

  if (typeof productStore.getTaskRecord !== "function") {
    return null;
  }

  return productStore.getTaskRecord(taskId);
}

function enqueueTaskForWorker(payload, requester) {
  const validation = validateScrapeRequest(payload);
  if (!validation.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: buildErrorMessage(validation.message, { taskId: payload.taskId || null }),
    };
  }

  if (taskStore.hasTask(payload.taskId)) {
    return {
      ok: false,
      statusCode: 409,
      error: buildErrorMessage("taskId da ton tai va dang duoc xu ly", { taskId: payload.taskId }),
    };
  }

  const itemId = shopeeProvider.getRequestItemId(payload);
  const cached = itemId && !payload.skipCache ? getCachedProduct(itemId) : null;
  if (cached) {
    const task = registerTask(payload, requester);
    const completedTask = updateTask(task.taskId, {
      status: TASK_STATUS.SUCCESS,
      affiliateUrl: cached.affiliateUrl,
      result: cached.result,
      raw: cached.raw,
      error: null,
      errorCode: null,
      parseError: null,
    });

    logger.info("task.cache_hit", {
      taskId: task.taskId,
      itemId,
      requestUrl: task.requestUrl,
      cachedAt: cached.cachedAt,
    });

    if (requester) {
      sendTaskUpdate(task.taskId, {
        type: "SUCCESS",
        status: TASK_STATUS.SUCCESS,
        affiliateUrl: cached.affiliateUrl,
        result: cached.result,
      });
      clearRequesterSocket(task.taskId);
    }

    return {
      ok: true,
      task: completedTask,
      workerClientId: null,
      fromCache: true,
    };
  }

  const task = registerTask(payload, requester);
  task.queueTracked = true;
  taskQueue.enqueue(task.taskId);
  const workers = getWorkerClients(wss);
  const worker = workers[0] || null;

  logger.info("task.queued", {
    taskId: task.taskId,
    requestUrl: task.requestUrl,
    workerClientId: worker?.meta?.clientId ?? null,
    trigger: requester ? "ws" : "http",
  });

  drainTaskQueue();

  if (requester) {
    sendTaskUpdate(task.taskId, {
      type: "QUEUED",
      status: TASK_STATUS.QUEUED,
      message: worker
        ? `Task da duoc dua sang worker #${worker.meta?.clientId}`
        : "Task da vao queue, dang cho worker ket noi",
    });
  }

  return {
    ok: true,
    task,
    workerClientId: worker?.meta?.clientId ?? null,
  };
}

function dispatchTaskToWorker(task, worker, retryCount) {
  if (!task || !worker) return;

  updateTask(task.taskId, {
    assignedWorkerClientId: worker.meta?.clientId ?? null,
    queueTracked: true,
    nextAttemptAt: null,
  });

  sendJson(worker, {
    ...(task.requestPayload || {}),
    taskId: task.taskId,
    retryCount: Number(retryCount ?? task.retryCount ?? 0),
    maxRetries: Number(task.maxRetries ?? config.taskMaxRetries),
  });
}

function retryTaskWithWorker(task, reason) {
  if (!task) return false;
  if (Number(task.retryCount || 0) >= Number(task.maxRetries || config.taskMaxRetries)) {
    return false;
  }

  const nextRetryCount = Number(task.retryCount || 0) + 1;
  const previousWorkerClientId = task.assignedWorkerClientId ?? null;

  updateTask(task.taskId, {
    status: TASK_STATUS.QUEUED,
    assignedWorkerClientId: null,
    queueTracked: true,
    retryCount: nextRetryCount,
    nextAttemptAt: new Date(Date.now() + config.taskRetryDelayMs).toISOString(),
    error: null,
    errorCode: null,
  });

  taskQueue.schedule(task.taskId, config.taskRetryDelayMs);

  logger.warn("task.retry_scheduled", {
    taskId: task.taskId,
    requestUrl: task.requestUrl,
    retryCount: nextRetryCount,
    workerClientId: previousWorkerClientId,
    reason,
  });

  return true;
}

async function restoreActiveTasksFromStore() {
  if (typeof productStore.listTaskRecords !== "function") return 0;

  let restored = 0;
  let skippedQueued = 0;
  let markedStale = 0;

  try {
    const entries = await productStore.listTaskRecords({
      statuses: [TASK_STATUS.QUEUED, TASK_STATUS.RUNNING],
      limit: 1000,
    });

    for (const entry of entries) {
      if (!entry?.taskId || taskStore.hasTask(entry.taskId)) continue;

      if (taskQueue.driver === "bullmq" && entry.status === TASK_STATUS.QUEUED) {
        const hasPersistedJob =
          typeof taskQueue.hasPersistedJob === "function"
            ? await taskQueue.hasPersistedJob(entry.taskId)
            : false;

        if (hasPersistedJob) {
          skippedQueued += 1;
          continue;
        }

        await markTaskHistoryStale(
          entry,
          "TASK_RESTORE_STALE",
          "Task queued cu khong con ton tai trong BullMQ",
        );
        markedStale += 1;
        continue;
      }

      taskStore.hydrateTask(entry);
      restored += 1;
    }

    if (restored > 0 || skippedQueued > 0 || markedStale > 0) {
      logger.info("task.store_restored", {
        restored,
        skippedQueued,
        markedStale,
        driver: productStore.driver,
      });
    }

    return restored;
  } catch (error) {
    logger.warn("task.store_restore_failed", {
      driver: productStore.driver,
      message: error.message,
    });
    return 0;
  }
}

async function readQueueSnapshot() {
  const stats = typeof taskQueue.stats === "function"
    ? await taskQueue.stats()
    : {
        driver: taskQueue.driver,
        waiting: taskQueue.size(),
        delayed: taskQueue.delayedSize(),
        readyBuffer: taskQueue.size(),
      };

  return {
    driver: stats.driver || taskQueue.driver,
    waiting: Number(stats.waiting || 0),
    delayed: Number(stats.delayed || 0),
    readyBuffer: Number(stats.readyBuffer || 0),
    queueName: stats.queueName || null,
    queuePrefix: stats.queuePrefix || null,
  };
}

const httpServer = http.createServer(async (req, res) => {
  cleanupExpiredTasks();

  const method = req.method || "GET";
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `localhost:${config.port}`}`);

  if (method === "GET" && requestUrl.pathname === "/health") {
    const queueSnapshot = await readQueueSnapshot();
    sendHttpJson(res, 200, {
      port: config.port,
      workerClients: getWorkerClients(wss).length,
      taskCount: taskStore.size(),
      pendingTaskCount: queueSnapshot.waiting + queueSnapshot.delayed,
      queueDriver: queueSnapshot.driver,
      queueSize: queueSnapshot.waiting,
      delayedQueueSize: queueSnapshot.delayed,
      productStoreDriver: productStore.driver,
      productCount: await readProductStoreSize(),
      meta: {
        endpoint: "/health",
      },
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/session") {
    const profileSummary = summarizeProfiles(loadProfiles());
    const queueSnapshot = await readQueueSnapshot();
    sendHttpJson(res, 200, {
      chromeCdpUrl: config.browserCdpUrl || null,
      workerClients: getWorkerClients(wss).length,
      taskCount: taskStore.size(),
      pendingTaskCount: queueSnapshot.waiting + queueSnapshot.delayed,
      queueDriver: queueSnapshot.driver,
      queueSize: queueSnapshot.waiting,
      delayedQueueSize: queueSnapshot.delayed,
      cacheSize: productCache.size,
      productCount: await readProductStoreSize(),
      productStoreDriver: productStore.driver,
      productCacheTtlMs: config.productCacheTtlMs,
      profiles: profileSummary,
      session: latestWorkerSession,
      meta: {
        endpoint: "/session",
      },
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/queue") {
    const queuedTasks = taskStore
      .listTasks()
      .filter((task) => task.status === TASK_STATUS.QUEUED || task.status === TASK_STATUS.RUNNING)
      .map(buildTaskResponse);
    const queueStats = await readQueueSnapshot();

    sendHttpJson(res, 200, {
      queue: queueStats,
      tasks: queuedTasks,
      total: queuedTasks.length,
      meta: {
        endpoint: "/queue",
      },
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/profiles") {
    sendHttpJson(res, 200, {
      ...summarizeProfiles(loadProfiles()),
      meta: {
        endpoint: "/profiles",
      },
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname.startsWith("/profiles/") && requestUrl.pathname.endsWith("/recover")) {
    const profileId = getProfileIdFromPath(requestUrl.pathname, "/recover");
    const registry = loadProfiles();
    const target = findProfileByNameOrId(registry, profileId);
    if (!target) {
      sendHttpJson(res, 404, buildErrorMessage("Khong tim thay profile", { profileId }));
      return;
    }

    const result = recoverProfile(registry, target.id);
    sendHttpJson(res, 200, {
      profile: result.profile,
      profiles: summarizeProfiles(result.registry),
      meta: {
        action: "recover",
        profileId: target.id,
      },
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname.startsWith("/profiles/") && requestUrl.pathname.endsWith("/disable")) {
    const profileId = getProfileIdFromPath(requestUrl.pathname, "/disable");
    const registry = loadProfiles();
    const target = findProfileByNameOrId(registry, profileId);
    if (!target) {
      sendHttpJson(res, 404, buildErrorMessage("Khong tim thay profile", { profileId }));
      return;
    }

    const result = disableProfile(registry, target.id);
    sendHttpJson(res, 200, {
      profile: result.profile,
      profiles: summarizeProfiles(result.registry),
      meta: {
        action: "disable",
        profileId: target.id,
      },
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname.startsWith("/profiles/") && requestUrl.pathname.endsWith("/enable")) {
    const profileId = getProfileIdFromPath(requestUrl.pathname, "/enable");
    const registry = loadProfiles();
    const target = findProfileByNameOrId(registry, profileId);
    if (!target) {
      sendHttpJson(res, 404, buildErrorMessage("Khong tim thay profile", { profileId }));
      return;
    }

    const result = updateProfileState(registry, target.id, {
      status: "ready",
      blockedUntil: null,
      lastRecoveredAt: new Date().toISOString(),
    });
    sendHttpJson(res, 200, {
      profile: result.profile,
      profiles: summarizeProfiles(result.registry),
      meta: {
        action: "enable",
        profileId: target.id,
      },
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname.startsWith("/profiles/") && requestUrl.pathname.endsWith("/default")) {
    const profileId = getProfileIdFromPath(requestUrl.pathname, "/default");
    const registry = loadProfiles();
    const target = findProfileByNameOrId(registry, profileId);
    if (!target) {
      sendHttpJson(res, 404, buildErrorMessage("Khong tim thay profile", { profileId }));
      return;
    }

    const result = setDefaultProfile(registry, target.id);
    sendHttpJson(res, 200, {
      profile: result.profile,
      profiles: summarizeProfiles(result.registry),
      meta: {
        action: "set-default",
        profileId: target.id,
      },
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname.startsWith("/profiles/") && requestUrl.pathname.endsWith("/cooldown")) {
    const profileId = getProfileIdFromPath(requestUrl.pathname, "/cooldown");
    const registry = loadProfiles();
    const target = findProfileByNameOrId(registry, profileId);
    if (!target) {
      sendHttpJson(res, 404, buildErrorMessage("Khong tim thay profile", { profileId }));
      return;
    }

    try {
      const body = await readJsonBody(req);
      const durationMs = Math.max(
        1000,
        Number(body.durationMs || config.profileCooldownMs),
      );
      const result = updateProfileState(registry, target.id, {
        status: "cooldown",
        blockedUntil: new Date(Date.now() + durationMs).toISOString(),
        lastErrorCode: "MANUAL_COOLDOWN",
        lastErrorMessage: "Dat cooldown thu cong",
      });
      sendHttpJson(res, 200, {
        profile: result.profile,
        profiles: summarizeProfiles(result.registry),
        meta: {
          action: "cooldown",
          profileId: target.id,
          durationMs,
        },
      });
    } catch (error) {
      sendHttpJson(res, 400, buildErrorMessage(error.message, { profileId }));
    }
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/products") {
    const limit = normalizeListQueryValue(
      requestUrl.searchParams.get("limit"),
      50,
      200,
    );
    const offset = normalizeListQueryValue(
      requestUrl.searchParams.get("offset"),
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const q = requestUrl.searchParams.get("q") || "";
    const mode = normalizeOutputMode(requestUrl.searchParams.get("mode"));
    const payload = await productStore.listProducts({ limit, offset, q });

    sendHttpJson(res, 200, {
      total: payload.total,
      limit: payload.limit,
      offset: payload.offset,
      mode,
      source: productStore.driver,
      products: payload.items.map((record) =>
        shopeeProvider.buildProductPayload(shopeeProvider.buildStoreProductEntry(record), mode, {
          productCacheTtlMs: config.productCacheTtlMs,
        }),
      ),
      meta: {
        endpoint: "/products",
        q,
      },
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname.startsWith("/products/") && requestUrl.pathname.endsWith("/history")) {
    const itemId = decodeURIComponent(
      requestUrl.pathname.slice("/products/".length, -"/history".length),
    ).trim();

    if (!isValidItemId(itemId)) {
      sendHttpJson(res, 400, buildErrorMessage("itemId khong hop le", { itemId }));
      return;
    }

    const limit = normalizeListQueryValue(
      requestUrl.searchParams.get("limit"),
      100,
      1000,
    );
    const history = await productStore.getPriceHistory(itemId, { limit });

    sendHttpJson(res, 200, {
      itemId,
      source: productStore.driver,
      total: history.length,
      history,
      meta: {
        endpoint: "/products/:itemId/history",
        limit,
      },
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/products/batch") {
    try {
      const body = await readJsonBody(req);
      const mode = normalizeOutputMode(body.mode || requestUrl.searchParams.get("mode"));
      const refresh = Boolean(body.refresh) || readBooleanQuery(requestUrl.searchParams.get("refresh"));
      const staleWhileRevalidate =
        Boolean(body.stale) || readBooleanQuery(requestUrl.searchParams.get("stale"));
      const rawItems = Array.isArray(body.itemIds)
        ? body.itemIds
        : Array.isArray(body.items)
          ? body.items
          : Array.isArray(body.urls)
            ? body.urls
            : [];
      const itemIds = Array.from(
        new Set(rawItems.map(shopeeProvider.extractItemIdFromInput).filter(isValidItemId)),
      );
      const invalidItems = rawItems
        .map((item) => String(item || "").trim())
        .filter((item) => item && !isValidItemId(shopeeProvider.extractItemIdFromInput(item)));

      if (itemIds.length === 0) {
        sendHttpJson(res, 400, buildErrorMessage("Thieu itemIds/items/urls hop le"));
        return;
      }

      if (itemIds.length > config.productBatchLimit) {
        sendHttpJson(res, 400, buildErrorMessage(
          `Batch toi da ${config.productBatchLimit} san pham moi request`,
          { limit: config.productBatchLimit },
        ));
        return;
      }

      const results = await Promise.all(
        itemIds.map(async (itemId) => {
          const result = await fetchProductByItemId(itemId, mode, {
            refresh,
            staleWhileRevalidate,
          });
          return normalizeHttpPayload(result.statusCode, {
            itemId,
            statusCode: result.statusCode,
            ...result.payload,
          });
        }),
      );

      sendHttpJson(res, 200, {
        type: "BATCH",
        mode,
        refresh,
        staleWhileRevalidate,
        total: results.length,
        invalidItems,
        results,
        meta: {
          endpoint: "/products/batch",
          requested: rawItems.length,
        },
      });
    } catch (error) {
      logger.warn("http.invalid_request", {
        method,
        path: requestUrl.pathname,
        message: error.message,
      });
      sendHttpJson(res, 400, buildErrorMessage(error.message));
    }

    return;
  }

  if (method === "GET" && requestUrl.pathname.startsWith("/product/")) {
    const itemId = decodeURIComponent(requestUrl.pathname.slice("/product/".length)).trim();
    const mode = normalizeOutputMode(requestUrl.searchParams.get("mode"));
    const refresh = readBooleanQuery(requestUrl.searchParams.get("refresh"));
    const staleWhileRevalidate = readBooleanQuery(requestUrl.searchParams.get("stale"));

    if (!isValidItemId(itemId)) {
      sendHttpJson(res, 400, buildErrorMessage("itemId khong hop le", { itemId }));
      return;
    }

    const result = await fetchProductByItemId(itemId, mode, {
      refresh,
      staleWhileRevalidate,
    });
    sendHttpJson(res, result.statusCode, result.payload);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/scrape") {
    try {
      const startedAt = Date.now();
      const body = await readJsonBody(req);
      const waitQueryRaw = requestUrl.searchParams.get("wait");
      const waitForResult =
        body.wait == null
          ? waitQueryRaw == null
            ? true
            : readBooleanQuery(waitQueryRaw)
          : Boolean(body.wait);
      const payload = {
        taskId: typeof body.taskId === "string" && body.taskId.trim() ? body.taskId.trim() : crypto.randomUUID(),
        url: body.url,
        itemId:
          typeof body.itemId === "string" && body.itemId.trim()
            ? body.itemId.trim()
            : "",
      };

      const result = enqueueTaskForWorker(payload, null);
      if (!result.ok) {
        logger.warn("http.task_rejected", {
          taskId: payload.taskId,
          requestUrl: payload.url || payload.itemId || null,
          reason: result.error.message,
          statusCode: result.statusCode,
        });
        sendHttpJson(res, result.statusCode, result.error);
        return;
      }

      if (!waitForResult || result.fromCache) {
        sendHttpJson(res, result.fromCache ? 200 : 202, {
          type: result.fromCache ? "SUCCESS" : "QUEUED",
          message: result.fromCache
            ? "Task tra ve tu cache"
            : `Task da duoc dua sang worker #${result.workerClientId}`,
          cacheHit: Boolean(result.fromCache),
          task: buildTaskResponse(result.task, { defaultMaxRetries: config.taskMaxRetries }),
          meta: {
            endpoint: "/scrape",
            workerClientId: result.workerClientId || null,
            waited: false,
          },
        });
        return;
      }

      const task = await waitForTaskDone(payload.taskId, config.productRequestTimeoutMs);

      if (task?.status === TASK_STATUS.SUCCESS) {
        sendHttpJson(res, 200, {
          type: "SUCCESS",
          message: "Crawl thanh cong",
          cacheHit: false,
          result: task.result,
          task: buildTaskResponse(task, { defaultMaxRetries: config.taskMaxRetries }),
          durationMs: Date.now() - startedAt,
          meta: {
            endpoint: "/scrape",
            workerClientId: result.workerClientId || null,
            waited: true,
          },
        });
        return;
      }

      if (task?.status === TASK_STATUS.ERROR) {
        sendHttpJson(res, 502, {
          type: "ERROR",
          message: task.error || "Crawl that bai",
          error: task.error,
          errorCode: task.errorCode,
          task: buildTaskResponse(task, { defaultMaxRetries: config.taskMaxRetries }),
          durationMs: Date.now() - startedAt,
          meta: {
            endpoint: "/scrape",
            workerClientId: result.workerClientId || null,
            waited: true,
          },
        });
        return;
      }

      sendHttpJson(res, 202, {
        type: "QUEUED",
        message: "Task dang xu ly, lay ket qua bang /tasks/:taskId",
        cacheHit: false,
        task: task
          ? buildTaskResponse(task, { defaultMaxRetries: config.taskMaxRetries })
          : buildTaskResponse(result.task, { defaultMaxRetries: config.taskMaxRetries }),
        durationMs: Date.now() - startedAt,
        meta: {
          endpoint: "/scrape",
          workerClientId: result.workerClientId || null,
          waited: true,
        },
      });
    } catch (error) {
      logger.warn("http.invalid_request", {
        method,
        path: requestUrl.pathname,
        message: error.message,
      });
      sendHttpJson(res, 400, buildErrorMessage(error.message));
    }

    return;
  }

  if (method === "GET" && requestUrl.pathname === "/tasks") {
    const status = requestUrl.searchParams.get("status") || undefined;
    const tasks = await listTaskHistory({ status });

    sendHttpJson(res, 200, {
      tasks,
      total: tasks.length,
      filters: { status: status || null },
      meta: {
        endpoint: "/tasks",
      },
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname.startsWith("/tasks/")) {
    const taskId = decodeURIComponent(requestUrl.pathname.slice("/tasks/".length));
    const task = await getTaskById(taskId);

    if (!task) {
      sendHttpJson(res, 404, buildErrorMessage("Khong tim thay task", { taskId }));
      return;
    }

    sendHttpJson(res, 200, {
      task: buildTaskResponse(task, { defaultMaxRetries: config.taskMaxRetries }),
      meta: {
        endpoint: "/tasks/:taskId",
      },
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname.startsWith("/tasks/") && requestUrl.pathname.endsWith("/cancel")) {
    const taskId = decodeURIComponent(
      requestUrl.pathname.slice("/tasks/".length, -"/cancel".length)
    );
    const existingTask = taskStore.getTask(taskId);

    if (!existingTask) {
      sendHttpJson(res, 404, buildErrorMessage("Khong tim thay task", { taskId }));
      return;
    }

    if (isCompletedTask(existingTask)) {
      sendHttpJson(res, 409, buildErrorMessage("Task da ket thuc, khong can cancel", {
        taskId,
        task: buildTaskResponse(existingTask, { defaultMaxRetries: config.taskMaxRetries }),
      }));
      return;
    }

    const task = updateTask(taskId, {
      status: TASK_STATUS.ERROR,
      errorCode: "TASK_CANCELLED",
      error: "Task da bi huy",
    });

    logger.warn("task.cancelled", {
      taskId,
      requestUrl: task.requestUrl,
    });
    sendTaskUpdate(taskId, {
      type: "ERROR",
      status: TASK_STATUS.ERROR,
      errorCode: "TASK_CANCELLED",
      error: "Task da bi huy",
      result: null,
    });
    clearRequesterSocket(taskId);

    sendHttpJson(res, 200, {
      task: buildTaskResponse(task, { defaultMaxRetries: config.taskMaxRetries }),
      meta: {
        endpoint: "/tasks/:taskId/cancel",
      },
    });
    return;
  }

  if (method === "DELETE" && requestUrl.pathname.startsWith("/tasks/")) {
    const taskId = decodeURIComponent(requestUrl.pathname.slice("/tasks/".length));
    const task = taskStore.removeTask(taskId);
    taskQueue.remove(taskId);
    clearRequesterSocket(taskId);

    if (!task) {
      sendHttpJson(res, 404, buildErrorMessage("Khong tim thay task", { taskId }));
      return;
    }

    sendHttpJson(res, 200, {
      removed: true,
      task: buildTaskResponse(task, { defaultMaxRetries: config.taskMaxRetries }),
      meta: {
        endpoint: "/tasks/:taskId",
        action: "delete",
      },
    });
    return;
  }

  sendHttpJson(res, 404, buildErrorMessage("Route khong ton tai"));
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws) => {
  ws.meta = { clientId: nextClientId++, role: "client" };

  logger.info("socket.connected", {
    clientId: ws.meta.clientId,
    role: ws.meta.role,
  });

  ws.on("error", (err) => {
    logger.error("socket.error", {
      clientId: ws.meta?.clientId,
      role: ws.meta?.role,
      message: err.message,
    });
  });

  ws.on("close", () => {
    clearTasksForSocket(ws);
    logger.info("socket.closed", {
      clientId: ws.meta?.clientId,
      role: ws.meta?.role,
    });
  });

  ws.on("message", (raw) => {
    const message = parseIncomingMessage(raw);

    if (!message.ok) {
      const command = parseWsCommand(message.rawText);
      if (!command) {
        logger.warn("socket.invalid_json", {
          clientId: ws.meta?.clientId,
          preview: String(message.rawText || "").slice(0, 100),
        });
        sendJson(ws, buildErrorMessage("Message khong hop le. Hay gui JSON, paste link Shopee, itemId, hoac dung: scrape <link|itemId>"));
        return;
      }

      const result = enqueueTaskForWorker(command.payload, ws);
      if (!result.ok) {
        sendJson(ws, result.error);
        logger.warn("task.rejected", {
          clientId: ws.meta?.clientId,
          reason: result.error.message,
          taskId: command.payload.taskId,
          requestUrl: command.payload.url || command.payload.itemId,
          statusCode: result.statusCode,
          inputMode: "ws-command",
        });
        return;
      }

      if (!result.fromCache) {
        sendJson(ws, {
          type: "ACCEPTED",
          taskId: result.task.taskId,
          requestUrl: result.task.requestUrl,
          status: result.task.status,
          message: "Da nhan lenh tu raw link/command",
        });
      }
      return;
    }

    const { payload } = message;

    if (payload.type === "REGISTER_WORKER") {
      ws.meta.role = "worker";
      logger.info("worker.registered", {
        clientId: ws.meta.clientId,
      });
      sendJson(ws, { type: "REGISTERED", role: "worker" });
      drainTaskQueue();
      return;
    }

    if (payload.type === "SESSION_STATUS") {
      const { type, ...sessionPatch } = payload;
      latestWorkerSession = {
        ...latestWorkerSession,
        ...sessionPatch,
        updatedAt: new Date().toISOString(),
      };
      logger.info("worker.session_status", latestWorkerSession);
      return;
    }

    const normalizedItemId =
      typeof payload.itemId === "string" && payload.itemId.trim()
        ? payload.itemId.trim()
        : "";

    if ((payload.url || normalizedItemId) && !payload.data) {
      payload.itemId = normalizedItemId;
      const result = enqueueTaskForWorker(payload, ws);
      if (!result.ok) {
        sendJson(ws, result.error);
        logger.warn("task.rejected", {
          clientId: ws.meta?.clientId,
          reason: result.error.message,
          taskId: payload.taskId || null,
          requestUrl: payload.url || normalizedItemId || null,
          statusCode: result.statusCode,
        });
      }
      return;
    }

    if (payload.type === "STARTED") {
      const task = updateTask(payload.taskId, { status: TASK_STATUS.RUNNING });
      if (!task) return;

      logger.info("task.started", {
        taskId: task.taskId,
        requestUrl: task.requestUrl,
        workerMessage: payload.message || null,
      });

      sendTaskUpdate(task.taskId, {
        type: "STARTED",
        status: TASK_STATUS.RUNNING,
        message: payload.message || "Worker da bat dau xu ly task",
      });
      return;
    }

    if (payload.type === "SUCCESS" || payload.type === "ERROR") {
      const validation = validateExtensionResult(payload);
      if (!validation.ok) {
        logger.warn("worker.invalid_result", {
          clientId: ws.meta?.clientId,
          type: payload.type,
          reason: validation.message,
          taskId: payload.taskId || null,
        });
        return;
      }
    }

    if (payload.type === "SUCCESS") {
      const existingTask = taskStore.getTask(payload.taskId);
      if (!existingTask) {
        logger.warn("task.orphan_success", { taskId: payload.taskId });
        return;
      }
      if (isCompletedTask(existingTask)) {
        logger.warn("task.late_result_ignored", {
          taskId: payload.taskId,
          currentStatus: existingTask.status,
          workerResultType: payload.type,
        });
        return;
      }

      try {
        const parseStartedAt = Date.now();
        const product = shopeeProvider.normalizeProduct(payload.data);
        const parseMs = Date.now() - parseStartedAt;
        setCachedProduct(product, payload.data, payload.url);
        void persistProduct(product, payload.data, payload.url, "worker");
        const task = updateTask(payload.taskId, {
          status: TASK_STATUS.SUCCESS,
          affiliateUrl: payload.url,
          result: product,
          raw: payload.data,
          error: null,
          errorCode: null,
          parseError: null,
        });

        logger.info("task.succeeded", {
          taskId: payload.taskId,
          requestUrl: task.requestUrl,
          affiliateUrl: payload.url,
          productName: product.productName,
          shopName: product.shopName,
          price: product.price,
          commission: product.commission,
          parseMs,
        });

        sendTaskUpdate(payload.taskId, {
          type: "SUCCESS",
          status: TASK_STATUS.SUCCESS,
          affiliateUrl: payload.url,
          result: product,
        });
      } catch (err) {
        const task = updateTask(payload.taskId, {
          status: TASK_STATUS.ERROR,
          affiliateUrl: payload.url,
          result: null,
          raw: payload.data,
          error: err.message,
          errorCode: "PARSE_ERROR",
          parseError: err.message,
        });

        logger.error("task.success_parse_failed", {
          taskId: payload.taskId,
          requestUrl: task?.requestUrl || existingTask.requestUrl,
          affiliateUrl: payload.url,
          message: err.message,
        });

        sendTaskUpdate(payload.taskId, {
          type: "ERROR",
          status: TASK_STATUS.ERROR,
          affiliateUrl: payload.url,
          error: err.message,
          errorCode: "PARSE_ERROR",
          parseError: err.message,
        });
      } finally {
        clearRequesterSocket(payload.taskId);
      }
      return;
    }

    if (payload.type === "ERROR") {
      const existingTask = taskStore.getTask(payload.taskId);
      if (isCompletedTask(existingTask)) {
        logger.warn("task.late_result_ignored", {
          taskId: payload.taskId,
          currentStatus: existingTask.status,
          workerResultType: payload.type,
        });
        return;
      }

      const task = updateTask(payload.taskId, {
        status: TASK_STATUS.ERROR,
        affiliateUrl: payload.url || null,
        error: payload.message || "Worker tra ve loi khong ro nguyen nhan",
        errorCode: payload.code || "WORKER_ERROR",
      });

      if (
        task &&
        RETRYABLE_ERROR_CODES.has(payload.code || "WORKER_ERROR") &&
        retryTaskWithWorker(task, payload.message || payload.code || "WORKER_ERROR")
      ) {
        return;
      }

      logger.warn("task.failed", {
        taskId: payload.taskId,
        requestUrl: task?.requestUrl || null,
        affiliateUrl: payload.url || null,
        message: payload.message,
        errorCode: payload.code || "WORKER_ERROR",
      });

      if (task) {
        sendTaskUpdate(payload.taskId, {
          type: "ERROR",
          status: TASK_STATUS.ERROR,
          affiliateUrl: payload.url,
          error: payload.message || "Worker tra ve loi khong ro nguyen nhan",
          errorCode: payload.code || "WORKER_ERROR",
          result: null,
        });
        clearRequesterSocket(payload.taskId);
      }
    }
  });
});

httpServer.on("listening", () => {
  logger.info("server.started", {
    port: config.port,
    taskLogPath: logger.paths.taskLogPath,
  });
});

httpServer.on("error", (err) => {
  logger.error("server.error", { message: err.message });
});

async function startServer() {
  await productStore.init();
  taskQueue = await createTaskQueueWithFallback({ taskStore, logger, config });
  attachTaskQueueReadyHandler();
  await restoreActiveTasksFromStore();
  taskQueue.restore(taskStore.listTasks());
  logger.info("product_store.ready", {
    driver: productStore.driver,
    productCount: await readProductStoreSize(),
  });
  httpServer.listen(config.port);
}

startServer().catch((error) => {
  logger.error("product_store.init_failed", {
    driver: productStore.driver,
    message: error.message,
  });
  process.exitCode = 1;
});

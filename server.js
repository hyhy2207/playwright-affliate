// =========================================
// server.js
// HTTP + WebSocket relay for Playwright worker
// =========================================

const crypto = require("crypto");
const http = require("http");
const WebSocket = require("ws");

const { config } = require("./config");
const { logger } = require("./logger");
const { productStore } = require("./product-store");
const { taskStore, TASK_STATUS } = require("./task-store");
const {
  isValidItemId,
  validateExtensionResult,
  validateScrapeRequest,
} = require("./validation");

let nextClientId = 1;

const requesterSockets = new Map();
const productCache = new Map();

let latestWorkerSession = {
  workerReady: false,
  affiliateLoggedIn: false,
  currentUrl: null,
  mode: null,
  profileDir: null,
  message: null,
  updatedAt: null,
};

const PRODUCT_OUTPUT_MODES = new Set(["compact", "full", "raw"]);

function toNumber(value, fallback = 0) {
  const numeric =
    typeof value === "number"
      ? value
      : Number(String(value ?? "").replace(/[^\d.-]/g, ""));

  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeMoneyValue(value, fallback = 0) {
  const numeric = toNumber(value, fallback);
  return numeric > 100000 ? Math.round(numeric / 100000) : numeric;
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

function buildShopeeImageUrl(image) {
  const value = String(image || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://cf.shopee.vn/file/${value}`;
}

function normalizeCommissionFallback(rawCommission, fallbackCommission) {
  const commission = toNumber(rawCommission, fallbackCommission);
  if (commission <= 0) return fallbackCommission;

  const rawValue = String(rawCommission ?? "").trim();
  const hasDecimalPart = rawValue.includes(".") && !rawValue.includes(",");

  // Some affiliate responses return commission in "thousand VND" format
  // (for example 12.75 -> 12,750 VND) when final commission fields are absent.
  if (hasDecimalPart && commission < 1000) {
    return Math.round(commission * 1000);
  }

  return commission;
}

function normalizeCommissionValue(value, fallback = 0) {
  return normalizeCommissionFallback(value, fallback);
}

function normalizeShopeeProduct(rawData) {
  const raw = typeof rawData === "string" ? JSON.parse(rawData) : rawData;

  const data = raw?.data || {};
  const item =
    data?.batch_item_for_item_card_full ||
    data?.item ||
    data?.product ||
    data?.itemCard ||
    {};

  if (!data || !item) {
    throw new Error("Response khong dung dinh dang Shopee Affiliate API");
  }

  const rawPrice =
    item.price ??
    item.price_info?.price ??
    item.priceMin ??
    item.current_price ??
    0;
  const price = normalizeMoneyValue(rawPrice);
  const minPrice = normalizeMoneyValue(
    item.price_min ?? item.priceMin ?? rawPrice
  );
  const maxPrice = normalizeMoneyValue(
    item.price_max ?? item.priceMax ?? rawPrice
  );
  const sellerComFinal = toNumber(
    data.seller_com_final ??
      data.sellerComFinal ??
      data.sellerCommissionFinal ??
      data.sellerCommission ??
      data.seller_comission
  );
  const shopeeComFinal = toNumber(
    data.shopee_com_final ??
      data.shopeeComFinal ??
      data.shopeeCommissionFinal ??
      data.shopeeCommission ??
      data.platformCommission
  );
  const extraCommission = sellerComFinal || normalizeCommissionValue(
    data.commission_rate?.seller_commission ??
      data.commissionRate?.seller_commission ??
      data.commissionRate?.sellerCommission,
    0
  );
  const shopeeCommission = shopeeComFinal || normalizeCommissionValue(
    data.commission_rate?.shopee_commission ??
      data.commissionRate?.shopee_commission ??
      data.commissionRate?.shopeeCommission,
    0
  );
  const fallbackCommission = sellerComFinal + shopeeComFinal;
  const finalCommissionValue =
    data.commission_final ??
    data.commissionFinal ??
    data.total_commission ??
    data.totalCommission ??
    data.finalCommission;
  const commission =
    finalCommissionValue != null
      ? toNumber(finalCommissionValue, fallbackCommission)
      : fallbackCommission > 0
        ? fallbackCommission
        : normalizeCommissionFallback(data.commission, fallbackCommission);
  const productLink =
    data.product_link ||
    data.productLink ||
    item.product_link ||
    item.offerLink ||
    "";

  const product = {
    productID: String(item.itemid ?? item.item_id ?? data.item_id ?? data.itemId ?? ""),
    price,
    minPrice,
    maxPrice,
    sales: toNumber(item.sold ?? item.sales ?? item.historical_sold),
    totalSales: toNumber(item.historical_sold ?? item.sold ?? item.sales),
    rating: Number(
      item.item_rating?.rating_star || item.rating_star || item.rating || 0
    ).toFixed(2),
    imageUrl: buildShopeeImageUrl(item.image || item.imageUrl || item.image_url),
    shopName: item.shop_name || item.shopName || data.shop_name || "",
    commission,
    hasExtraCommission: extraCommission > 0,
    extraCommission,
    hasShopeeCommission: shopeeCommission > 0,
    shopeeCommission,
    productLink,
    productName: item.name || item.productName || "",
  };

  if (!product.productID || !product.productName || !product.productLink) {
    throw new Error("Response khong dung dinh dang Shopee Affiliate API");
  }

  return product;
}

function parseRawJson(rawData) {
  if (typeof rawData !== "string") return rawData;

  try {
    return JSON.parse(rawData);
  } catch {
    return rawData;
  }
}

function normalizeOutputMode(value) {
  const mode = String(value || "compact").trim().toLowerCase();
  return PRODUCT_OUTPUT_MODES.has(mode) ? mode : "compact";
}

function extractItemIdFromInput(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  if (isValidItemId(input)) return input;

  const pathMatch = input.match(/\/product\/\d+\/(\d+)/);
  if (pathMatch?.[1]) return pathMatch[1];

  const seoMatch = input.match(/i\.\d+\.(\d+)/);
  if (seoMatch?.[1]) return seoMatch[1];

  try {
    const parsed = new URL(input);
    return parsed.searchParams.get("item_id") || "";
  } catch {
    return "";
  }
}

function getRequestItemId(payload) {
  return extractItemIdFromInput(payload.itemId || payload.url || "");
}

function getCachedProduct(itemId) {
  const cached = productCache.get(String(itemId || ""));
  if (!cached) return null;

  if (Date.now() - cached.cachedAtMs > config.productCacheTtlMs) {
    productCache.delete(String(itemId));
    return null;
  }

  return cached;
}

function buildStoreProductEntry(record) {
  if (!record) return null;

  return {
    itemId: String(record.itemId),
    result: record.result,
    raw: record.raw,
    affiliateUrl: record.affiliateUrl,
    cachedAt: record.updatedAt,
    cachedAtMs: record.updatedAt ? new Date(record.updatedAt).getTime() : Date.now(),
  };
}

function setCachedProduct(product, raw, affiliateUrl) {
  if (!product?.productID) return;

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

function buildProductPayload(entry, mode = "compact") {
  const normalizedMode = normalizeOutputMode(mode);

  if (normalizedMode === "raw") {
    return parseRawJson(entry.raw);
  }

  if (normalizedMode === "full") {
    return {
      ...entry.result,
      raw: parseRawJson(entry.raw),
      cache: entry.cachedAt
        ? {
            itemId: entry.itemId,
            cachedAt: entry.cachedAt,
            ttlMs: config.productCacheTtlMs,
          }
        : null,
    };
  }

  return entry.result;
}

function createTaskCacheEntry(task) {
  if (!task?.result?.productID) return null;

  return {
    itemId: String(task.result.productID),
    result: task.result,
    raw: task.raw,
    affiliateUrl: task.affiliateUrl,
    cachedAt: null,
    cachedAtMs: Date.now(),
  };
}

function buildTaskProductPayload(task, mode = "compact") {
  const entry = createTaskCacheEntry(task);
  return entry ? buildProductPayload(entry, mode) : task?.result || null;
}

function waitForTaskDone(taskId, timeoutMs) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const tick = () => {
      const task = taskStore.getTask(taskId);
      if (!task || isCompletedTask(task)) {
        resolve(task);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        resolve(task);
        return;
      }

      setTimeout(tick, Math.min(config.taskPollMs, 100));
    };

    tick();
  });
}

function readBooleanQuery(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeListQueryValue(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(Math.floor(parsed), max));
}

async function readProductStoreSize() {
  try {
    return await productStore.size();
  } catch {
    return null;
  }
}

async function fetchProductByItemId(itemId, mode, options = {}) {
  const startedAt = Date.now();
  const refresh = Boolean(options.refresh);

  if (!refresh) {
    const cached = getCachedProduct(itemId);
    if (cached) {
      return {
        statusCode: 200,
        payload: {
          type: "SUCCESS",
          cacheHit: true,
          storeHit: false,
          source: "memory",
          itemId,
          mode,
          result: buildProductPayload(cached, mode),
          cachedAt: cached.cachedAt,
          durationMs: Date.now() - startedAt,
        },
      };
    }

    const stored = await productStore.getProduct(itemId);
    if (stored) {
      const entry = buildStoreProductEntry(stored);
      setCachedProduct(stored.result, stored.raw, stored.affiliateUrl);
      return {
        statusCode: 200,
        payload: {
          type: "SUCCESS",
          cacheHit: false,
          storeHit: true,
          source: productStore.driver,
          itemId,
          mode,
          result: buildProductPayload(entry, mode),
          cachedAt: stored.updatedAt,
          durationMs: Date.now() - startedAt,
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
    return {
      statusCode: 200,
      payload: {
        type: "SUCCESS",
        cacheHit: Boolean(queued.fromCache),
        storeHit: false,
        source: queued.fromCache ? "memory" : "worker",
        itemId,
        mode,
        result: buildTaskProductPayload(task, mode),
        task: buildTaskResponse(task),
        durationMs: Date.now() - startedAt,
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
        task: buildTaskResponse(task),
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
      task: task ? buildTaskResponse(task) : buildTaskResponse(queued.task),
      durationMs: Date.now() - startedAt,
    },
  };
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
}

function parseIncomingMessage(raw) {
  try {
    return { ok: true, payload: JSON.parse(raw.toString()) };
  } catch {
    return { ok: false, rawText: raw.toString() };
  }
}

function isLikelyShopeeUrl(value) {
  return typeof value === "string" && /^https?:\/\/([a-z0-9-]+\.)?shopee\.vn\//i.test(value.trim());
}

function isLikelyItemId(value) {
  return isValidItemId(typeof value === "string" ? value.trim() : value);
}

function parseWsCommand(rawText) {
  const input = String(rawText || "").trim();
  if (!input) return null;

  if (isLikelyItemId(input)) {
    return {
      payload: {
        taskId: crypto.randomUUID(),
        itemId: input,
      },
    };
  }

  if (isLikelyShopeeUrl(input)) {
    return {
      payload: {
        taskId: crypto.randomUUID(),
        url: input,
      },
    };
  }

  const scrapeMatch = input.match(/^scrape\s+(.+)$/i);
  if (scrapeMatch && isLikelyShopeeUrl(scrapeMatch[1])) {
    return {
      payload: {
        taskId: crypto.randomUUID(),
        url: scrapeMatch[1].trim(),
      },
    };
  }

  if (scrapeMatch && isLikelyItemId(scrapeMatch[1])) {
    return {
      payload: {
        taskId: crypto.randomUUID(),
        itemId: scrapeMatch[1].trim(),
      },
    };
  }

  return null;
}

function buildErrorMessage(message, extra = {}) {
  return {
    type: "ERROR",
    status: TASK_STATUS.ERROR,
    message,
    ...extra,
  };
}

function isCompletedTask(task) {
  return task?.status === TASK_STATUS.SUCCESS || task?.status === TASK_STATUS.ERROR;
}

function updateTask(taskId, patch) {
  return taskStore.updateTask(taskId, patch);
}

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

function toTimeMs(value) {
  return value ? new Date(value).getTime() : 0;
}

function buildTaskResponse(task) {
  const createdAtMs = toTimeMs(task.createdAt);
  const startedAtMs = toTimeMs(task.startedAt);
  const endedAtMs = toTimeMs(task.endedAt);
  const updatedAtMs = toTimeMs(task.updatedAt);
  const finishMs = endedAtMs || updatedAtMs;
  const durationMs =
    createdAtMs > 0 && finishMs >= createdAtMs ? finishMs - createdAtMs : null;
  const queueMs =
    createdAtMs > 0 && startedAtMs >= createdAtMs ? startedAtMs - createdAtMs : null;
  const processingMs =
    startedAtMs > 0 && finishMs >= startedAtMs ? finishMs - startedAtMs : null;

  return {
    taskId: task.taskId,
    itemId: /^\d+$/.test(String(task.requestUrl || "")) ? String(task.requestUrl) : null,
    status: task.status,
    requestUrl: task.requestUrl,
    affiliateUrl: task.affiliateUrl,
    result: task.result,
    raw: task.raw,
    error: task.error,
    errorCode: task.errorCode,
    parseError: task.parseError,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    durationMs,
    queueMs,
    processingMs,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function sendHttpJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body qua lon"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body khong phai JSON hop le"));
      }
    });

    req.on("error", reject);
  });
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

  const itemId = getRequestItemId(payload);
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

  const workers = getWorkerClients(wss);
  if (workers.length === 0) {
    return {
      ok: false,
      statusCode: 503,
      error: buildErrorMessage("Khong co Playwright worker dang ket noi", { taskId: payload.taskId }),
    };
  }

  const worker = workers[0];
  const task = registerTask(payload, requester);

  logger.info("task.queued", {
    taskId: task.taskId,
    requestUrl: task.requestUrl,
    workerClientId: worker.meta?.clientId,
    trigger: requester ? "ws" : "http",
  });

  sendJson(worker, payload);

  if (requester) {
    sendTaskUpdate(task.taskId, {
      type: "QUEUED",
      status: TASK_STATUS.QUEUED,
      message: `Task da duoc dua sang worker #${worker.meta?.clientId}`,
    });
  }

  return {
    ok: true,
    task,
    workerClientId: worker.meta?.clientId,
  };
}

const httpServer = http.createServer(async (req, res) => {
  cleanupExpiredTasks();

  const method = req.method || "GET";
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `localhost:${config.port}`}`);

  if (method === "GET" && requestUrl.pathname === "/health") {
    sendHttpJson(res, 200, {
      ok: true,
      port: config.port,
      workerClients: getWorkerClients(wss).length,
      taskCount: taskStore.size(),
      productStoreDriver: productStore.driver,
      productCount: await readProductStoreSize(),
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/session") {
    sendHttpJson(res, 200, {
      ok: true,
      chromeCdpUrl: config.browserCdpUrl || null,
      workerClients: getWorkerClients(wss).length,
      taskCount: taskStore.size(),
      cacheSize: productCache.size,
      productCount: await readProductStoreSize(),
      productStoreDriver: productStore.driver,
      productCacheTtlMs: config.productCacheTtlMs,
      session: latestWorkerSession,
    });
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
        buildProductPayload(buildStoreProductEntry(record), mode),
      ),
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
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/products/batch") {
    try {
      const body = await readJsonBody(req);
      const mode = normalizeOutputMode(body.mode || requestUrl.searchParams.get("mode"));
      const refresh = Boolean(body.refresh) || readBooleanQuery(requestUrl.searchParams.get("refresh"));
      const rawItems = Array.isArray(body.itemIds)
        ? body.itemIds
        : Array.isArray(body.items)
          ? body.items
          : Array.isArray(body.urls)
            ? body.urls
            : [];
      const itemIds = Array.from(
        new Set(rawItems.map(extractItemIdFromInput).filter(isValidItemId)),
      );
      const invalidItems = rawItems
        .map((item) => String(item || "").trim())
        .filter((item) => item && !isValidItemId(extractItemIdFromInput(item)));

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
          const result = await fetchProductByItemId(itemId, mode, { refresh });
          return {
            itemId,
            statusCode: result.statusCode,
            ...result.payload,
          };
        }),
      );

      sendHttpJson(res, 200, {
        type: "BATCH",
        mode,
        refresh,
        total: results.length,
        invalidItems,
        results,
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

    if (!isValidItemId(itemId)) {
      sendHttpJson(res, 400, buildErrorMessage("itemId khong hop le", { itemId }));
      return;
    }

    const result = await fetchProductByItemId(itemId, mode, { refresh });
    sendHttpJson(res, result.statusCode, result.payload);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/scrape") {
    try {
      const body = await readJsonBody(req);
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

      sendHttpJson(res, result.fromCache ? 200 : 202, {
        type: result.fromCache ? "SUCCESS" : "QUEUED",
        message: result.fromCache
          ? "Task tra ve tu cache"
          : `Task da duoc dua sang worker #${result.workerClientId}`,
        cacheHit: Boolean(result.fromCache),
        task: buildTaskResponse(result.task),
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
    const tasks = taskStore.listTasks({ status }).map(buildTaskResponse);

    sendHttpJson(res, 200, {
      tasks,
      total: tasks.length,
      filters: { status: status || null },
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname.startsWith("/tasks/")) {
    const taskId = decodeURIComponent(requestUrl.pathname.slice("/tasks/".length));
    const task = taskStore.getTask(taskId);

    if (!task) {
      sendHttpJson(res, 404, buildErrorMessage("Khong tim thay task", { taskId }));
      return;
    }

    sendHttpJson(res, 200, { task: buildTaskResponse(task) });
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
        task: buildTaskResponse(existingTask),
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

    sendHttpJson(res, 200, { task: buildTaskResponse(task) });
    return;
  }

  if (method === "DELETE" && requestUrl.pathname.startsWith("/tasks/")) {
    const taskId = decodeURIComponent(requestUrl.pathname.slice("/tasks/".length));
    const task = taskStore.removeTask(taskId);
    clearRequesterSocket(taskId);

    if (!task) {
      sendHttpJson(res, 404, buildErrorMessage("Khong tim thay task", { taskId }));
      return;
    }

    sendHttpJson(res, 200, {
      removed: true,
      task: buildTaskResponse(task),
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
        const product = normalizeShopeeProduct(payload.data);
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
          status: TASK_STATUS.SUCCESS,
          affiliateUrl: payload.url,
          result: null,
          raw: payload.data,
          error: null,
          parseError: err.message,
        });

        logger.error("task.success_parse_failed", {
          taskId: payload.taskId,
          requestUrl: task?.requestUrl || existingTask.requestUrl,
          affiliateUrl: payload.url,
          message: err.message,
        });

        sendTaskUpdate(payload.taskId, {
          type: "SUCCESS",
          status: TASK_STATUS.SUCCESS,
          affiliateUrl: payload.url,
          result: null,
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

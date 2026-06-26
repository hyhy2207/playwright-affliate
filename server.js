// =========================================
// server.js
// HTTP + WebSocket relay for Playwright worker
// =========================================

const crypto = require("crypto");
const http = require("http");
const WebSocket = require("ws");

const { config } = require("./config");
const { logger } = require("./logger");
const { taskStore, TASK_STATUS } = require("./task-store");
const {
  isValidItemId,
  validateExtensionResult,
  validateScrapeRequest,
} = require("./validation");

let nextClientId = 1;

const requesterSockets = new Map();

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

function updateTask(taskId, patch) {
  return taskStore.updateTask(taskId, patch);
}

function cleanupExpiredTasks() {
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
    });
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
            : typeof body.item_id === "string" && body.item_id.trim()
              ? body.item_id.trim()
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

      sendHttpJson(res, 202, {
        type: "QUEUED",
        message: `Task da duoc dua sang worker #${result.workerClientId}`,
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
        sendJson(ws, buildErrorMessage("Message khong hop le. Hay gui JSON, paste link Shopee, item_id, hoac dung: scrape <link|item_id>"));
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

      sendJson(ws, {
        type: "ACCEPTED",
        taskId: result.task.taskId,
        requestUrl: result.task.requestUrl,
        status: result.task.status,
        message: "Da nhan lenh tu raw link/command",
      });
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

    const normalizedItemId =
      typeof payload.itemId === "string" && payload.itemId.trim()
        ? payload.itemId.trim()
        : typeof payload.item_id === "string" && payload.item_id.trim()
          ? payload.item_id.trim()
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

      try {
        const product = normalizeShopeeProduct(payload.data);
        const task = updateTask(payload.taskId, {
          status: TASK_STATUS.SUCCESS,
          affiliateUrl: payload.url,
          result: product,
          raw: payload.data,
          error: null,
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
      const task = updateTask(payload.taskId, {
        status: TASK_STATUS.ERROR,
        affiliateUrl: payload.url || null,
        error: payload.message || "Worker tra ve loi khong ro nguyen nhan",
      });

      logger.warn("task.failed", {
        taskId: payload.taskId,
        requestUrl: task?.requestUrl || null,
        affiliateUrl: payload.url || null,
        message: payload.message,
      });

      if (task) {
        sendTaskUpdate(payload.taskId, {
          type: "ERROR",
          status: TASK_STATUS.ERROR,
          affiliateUrl: payload.url,
          error: payload.message || "Worker tra ve loi khong ro nguyen nhan",
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

httpServer.listen(config.port);

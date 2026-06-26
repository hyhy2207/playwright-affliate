"use strict";

const WebSocket = require("ws");

const { config } = require("./config");
const { logger } = require("./logger");
const {
  detectBlockingIssue,
  findAffiliatePageInSession,
  launchBrowserContext,
  listSessionPageUrls,
  looksLikeLoggedOutUrl,
  waitForAffiliatePageSettled,
  waitForAffiliatePageInSession,
} = require("./browser-context");

const TARGET_API_PATH = "affiliate.shopee.vn/api/v3/offer/product";

let socket;
let reconnectTimer = null;
let browserSessionPromise = null;
let hasValidatedProfile = false;
let registerRetryTimer = null;
let isRegisteringWorker = false;
let activeTaskPagePromise = null;

const taskQueue = [];
let isProcessingTask = false;

function extractItemId(shopeeUrl) {
  const match1 = shopeeUrl.match(/i\.(\d+)\.(\d+)/);
  if (match1 && match1[2]) return match1[2];

  const match2 = shopeeUrl.match(/\/product\/\d+\/(\d+)/);
  if (match2 && match2[1]) return match2[1];

  try {
    const urlObj = new URL(shopeeUrl);
    const itemId = urlObj.searchParams.get("item_id");
    if (itemId) return itemId;
  } catch {}

  return null;
}

function sendSocketMessage(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

async function getBrowserContext() {
  if (!browserSessionPromise) {
    browserSessionPromise = launchBrowserContext();
  }

  const browserSession = await browserSessionPromise;
  return browserSession.context;
}

async function getBrowserSession() {
  if (!browserSessionPromise) {
    browserSessionPromise = launchBrowserContext();
  }

  return browserSessionPromise;
}

async function getActiveTaskPage(browserSession) {
  if (!activeTaskPagePromise) {
    activeTaskPagePromise = (async () => {
      const found = await findAffiliatePageInSession(browserSession);
      if (found.page && !found.page.isClosed()) {
        return found.page;
      }

      const page = await found.context.newPage();
      page.on("close", () => {
        if (activeTaskPagePromise) {
          activeTaskPagePromise = null;
        }
      });
      return page;
    })().catch((error) => {
      activeTaskPagePromise = null;
      throw error;
    });
  }

  const page = await activeTaskPagePromise;
  if (page.isClosed()) {
    activeTaskPagePromise = null;
    return getActiveTaskPage(browserSession);
  }

  return page;
}

async function ensureProfileLoggedIn() {
  if (hasValidatedProfile) return;

  const browserSession = await getBrowserSession();
  let { context, page } = await waitForAffiliatePageInSession(
    browserSession,
    config.workerWaitTimeoutMs
  );
  let shouldClosePage = false;

  try {
    if (!page) {
      throw new Error(
        `Chua tim thay tab affiliate/dashboard dang mo san trong thoi gian cho. Cac tab hien tai: ${listSessionPageUrls(browserSession).join(" | ") || "khong co tab nao"}`
      );
    }

    await waitForAffiliatePageSettled(page);

    const currentUrl = page.url();
    if (looksLikeLoggedOutUrl(currentUrl)) {
      throw new Error(
        `Profile chua login affiliate. Hien tai dang o: ${currentUrl}`
      );
    }

    const blockingIssue = await detectBlockingIssue(page);
    if (blockingIssue) {
      throw new Error(
        `Shopee dang chan profile/browser sau login (${blockingIssue.currentUrl || "unknown"}). Thu login lai bang Chrome that hoac doi session/profile khac.`
      );
    }

    hasValidatedProfile = true;
    logger.info("worker.profile_ready", {
      currentUrl,
      mode: browserSession.mode,
      profileDir: config.browserProfileDir,
    });
  } finally {
    if (shouldClosePage) {
      await page.close().catch(() => {});
    }
  }
}

function buildAffiliateUrl(itemId) {
  const base = config.affiliateBaseUrl.replace(/\/$/, "");
  return `${base}/offer/product_offer/${itemId}`;
}

async function tryFetchAffiliateProductApi(page, itemId) {
  const base = config.affiliateBaseUrl.replace(/\/$/, "");
  const candidates = [
    {
      url: `${base}/api/v3/offer/product?item_id=${encodeURIComponent(itemId)}`,
      options: {
        method: "GET",
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*",
        },
      },
    },
    {
      url: `${base}/api/v3/offer/product`,
      options: {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/json",
        },
        body: JSON.stringify({ item_id: itemId }),
      },
    },
  ];

  for (const candidate of candidates) {
    const result = await page
      .evaluate(async ({ url, options }) => {
        try {
          const response = await fetch(url, options);
          const text = await response.text();
          return {
            ok: response.ok,
            status: response.status,
            text,
            url,
          };
        } catch (error) {
          return {
            ok: false,
            status: 0,
            text: "",
            url,
            error: error?.message || String(error),
          };
        }
      }, candidate)
      .catch((error) => ({
        ok: false,
        status: 0,
        text: "",
        url: candidate.url,
        error: error.message,
      }));

    if (!result.ok || !result.text) {
      continue;
    }

    try {
      const parsed = JSON.parse(result.text);
      const responseItemId = String(
        parsed?.data?.item_id ??
          parsed?.data?.itemId ??
          parsed?.data?.batch_item_for_item_card_full?.itemid ??
          ""
      );

      if (parsed?.code === 0 && responseItemId === String(itemId)) {
        return result.text;
      }
    } catch {}
  }

  return null;
}

async function handleTask(payload) {
  const {
    taskId,
    url: requestUrl,
    itemId: payloadItemId,
    item_id: payloadItemIdSnake,
  } = payload;
  const itemId =
    (typeof payloadItemId === "string" && payloadItemId.trim()) ||
    (typeof payloadItemIdSnake === "string" && payloadItemIdSnake.trim()) ||
    extractItemId(requestUrl);
  const requestRef = requestUrl || itemId;

  if (!itemId) {
    sendSocketMessage({
      type: "ERROR",
      taskId,
      requestUrl: requestRef,
      message: "Khong tim thay item_id trong URL",
    });
    return;
  }

  const affiliateUrl = buildAffiliateUrl(itemId);
  sendSocketMessage({
    type: "STARTED",
    taskId,
    requestUrl: requestRef,
    message: `Dang xu ly item_id ${itemId}`,
  });

  try {
    const browserSession = await getBrowserSession();
    const page = await getActiveTaskPage(browserSession);

    try {
      const requestFailedHandler = (request) => {
        if (!request.url().includes("affiliate.shopee.vn")) return;
        logger.warn("worker.request_failed", {
          taskId,
          url: request.url(),
          errorText: request.failure()?.errorText || "unknown",
        });
      };
      page.on("requestfailed", requestFailedHandler);

      const fastApiBody = await tryFetchAffiliateProductApi(page, itemId);
      if (fastApiBody) {
        sendSocketMessage({
          type: "SUCCESS",
          taskId,
          url: affiliateUrl,
          data: fastApiBody,
        });
        return;
      }

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes(TARGET_API_PATH) && response.status() < 500,
        { timeout: config.scrapeTimeoutMs }
      );

      await page.goto(affiliateUrl, {
        waitUntil: "commit",
        timeout: config.scrapeTimeoutMs,
      });
      await waitForAffiliatePageSettled(page);
      if (looksLikeLoggedOutUrl(page.url())) {
        throw new Error(
          `Profile da mat session affiliate. Hien tai dang o: ${page.url()}`
        );
      }

      const blockingIssue = await detectBlockingIssue(page);
      if (blockingIssue) {
        throw new Error(
          `Shopee tra ve trang block thay vi data affiliate (${blockingIssue.currentUrl || "unknown"}). Profile hien tai da bi chan hoac session chua on dinh.`
        );
      }

      const response = await responsePromise;
      if (!response.ok()) {
        throw new Error(
          `Affiliate API tra ve HTTP ${response.status()} cho item_id ${itemId}`
        );
      }
      const body = await response.text();

      sendSocketMessage({
        type: "SUCCESS",
        taskId,
        url: affiliateUrl,
        data: body,
      });
    } finally {
      page.off("requestfailed", requestFailedHandler);
    }
  } catch (error) {
    sendSocketMessage({
      type: "ERROR",
      taskId,
      url: affiliateUrl,
      requestUrl: requestRef,
      message: error.message,
    });
  }
}

async function processQueue() {
  if (isProcessingTask || taskQueue.length === 0) return;

  isProcessingTask = true;
  const task = taskQueue.shift();

  try {
    await handleTask(task);
  } finally {
    isProcessingTask = false;
    processQueue();
  }
}

function enqueueTask(payload) {
  taskQueue.push(payload);
  processQueue();
}

function scheduleWorkerRegistration() {
  if (registerRetryTimer) return;

  registerRetryTimer = setTimeout(() => {
    registerRetryTimer = null;
    tryRegisterWorker();
  }, config.workerWaitPollMs);
}

function tryRegisterWorker() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (isRegisteringWorker || hasValidatedProfile) return;

  isRegisteringWorker = true;
  ensureProfileLoggedIn()
    .then(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      sendSocketMessage({ type: "REGISTER_WORKER" });
    })
    .catch((error) => {
      logger.error("worker.login_required", {
        message: error.message,
      });
      scheduleWorkerRegistration();
    })
    .finally(() => {
      isRegisteringWorker = false;
    });
}

function connectSocket() {
  socket = new WebSocket(config.workerSocketUrl);

  socket.on("open", () => {
    logger.info("worker.socket_connected", {
      socketUrl: config.workerSocketUrl,
    });
    tryRegisterWorker();
  });

  socket.on("close", () => {
    logger.warn("worker.socket_closed", {
      socketUrl: config.workerSocketUrl,
    });

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    if (registerRetryTimer) {
      clearTimeout(registerRetryTimer);
      registerRetryTimer = null;
    }
    isRegisteringWorker = false;

    reconnectTimer = setTimeout(connectSocket, config.workerWaitPollMs);
  });

  socket.on("error", (error) => {
    logger.warn("worker.socket_error", {
      message: error.message,
    });
  });

  socket.on("message", (raw) => {
    try {
      const payload = JSON.parse(raw.toString());

      if (payload.type === "REGISTERED") {
        hasValidatedProfile = true;
        logger.info("worker.registered", {
          role: payload.role,
        });
        return;
      }

      if (
        payload.taskId &&
        (payload.url || payload.itemId || payload.item_id)
      ) {
        enqueueTask(payload);
      }
    } catch (error) {
      logger.warn("worker.invalid_message", {
        message: error.message,
      });
    }
  });
}

connectSocket();

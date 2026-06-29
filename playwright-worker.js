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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyWorkerError(error) {
  const message = String(error?.message || error || "").toLowerCase();

  if (
    message.includes("econnrefused") ||
    message.includes("connectovercdp") ||
    message.includes("browser has been closed") ||
    message.includes("target page, context or browser has been closed")
  ) {
    return "CDP_DISCONNECTED";
  }

  if (message.includes("loading issue") || message.includes("loi tai") || message.includes("lỗi tải")) {
    return "LOADING_ISSUE";
  }

  if (
    message.includes("captcha") ||
    message.includes("verify/captcha") ||
    message.includes("dang chan") ||
    message.includes("bị chặn") ||
    message.includes("bi chan") ||
    message.includes("block")
  ) {
    return "CAPTCHA_REQUIRED";
  }

  if (
    message.includes("chua login") ||
    message.includes("chưa login") ||
    message.includes("login affiliate") ||
    message.includes("mat session") ||
    message.includes("mất session") ||
    message.includes("logged out")
  ) {
    return "LOGIN_REQUIRED";
  }

  return "WORKER_ERROR";
}

function sendSessionStatus(patch) {
  sendSocketMessage({
    type: "SESSION_STATUS",
    workerReady: false,
    affiliateLoggedIn: false,
    currentUrl: null,
    mode: null,
    profileDir: config.browserProfileDir,
    message: null,
    ...patch,
  });
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
    sendSessionStatus({
      workerReady: true,
      affiliateLoggedIn: true,
      currentUrl,
      mode: browserSession.mode,
      message: "Profile affiliate san sang",
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
  const startedAt = Date.now();
  const base = config.affiliateBaseUrl.replace(/\/$/, "");
  const attempts = [];
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

  for (let round = 1; round <= 2; round++) {
    for (const candidate of candidates) {
      const attemptStartedAt = Date.now();
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

      attempts.push({
        round,
        method: candidate.options.method,
        status: result.status,
        ok: result.ok,
        ms: Date.now() - attemptStartedAt,
        error: result.error || null,
      });

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
          return {
            ok: true,
            body: result.text,
            apiFetchMs: Date.now() - startedAt,
            attempts,
          };
        }
      } catch (error) {
        attempts[attempts.length - 1].error = error.message;
      }
    }

    if (round === 1) {
      await sleep(120);
    }
  }

  return {
    ok: false,
    body: null,
    apiFetchMs: Date.now() - startedAt,
    attempts,
    reason: attempts.length > 0 ? "no_valid_api_response" : "no_attempt",
  };
}

async function handleTask(payload) {
  const {
    taskId,
    url: requestUrl,
    itemId: payloadItemId,
  } = payload;
  const itemId =
    (typeof payloadItemId === "string" && payloadItemId.trim()) ||
    extractItemId(requestUrl);
  const requestRef = requestUrl || itemId;

  if (!itemId) {
    sendSocketMessage({
      type: "ERROR",
      taskId,
      requestUrl: requestRef,
      code: "INVALID_ITEM_ID",
      message: "Khong tim thay itemId trong URL/input",
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
    let requestFailedHandler = null;

    try {
      requestFailedHandler = (request) => {
        if (!request.url().includes("affiliate.shopee.vn")) return;
        logger.warn("worker.request_failed", {
          taskId,
          url: request.url(),
          errorText: request.failure()?.errorText || "unknown",
        });
      };
      page.on("requestfailed", requestFailedHandler);

      const fastApiResult = await tryFetchAffiliateProductApi(page, itemId);
      if (fastApiResult.ok) {
        logger.info("worker.fast_api_hit", {
          taskId,
          itemId,
          apiFetchMs: fastApiResult.apiFetchMs,
          attempts: fastApiResult.attempts,
        });
        sendSocketMessage({
          type: "SUCCESS",
          taskId,
          url: affiliateUrl,
          data: fastApiResult.body,
        });
        return;
      }

      logger.warn("worker.fast_api_fallback", {
        taskId,
        itemId,
        apiFetchMs: fastApiResult.apiFetchMs,
        reason: fastApiResult.reason,
        attempts: fastApiResult.attempts,
      });

      const gotoStartedAt = Date.now();
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
      const gotoMs = Date.now() - gotoStartedAt;

      logger.info("worker.fallback_goto", {
        taskId,
        itemId,
        gotoMs,
        responseStatus: response.status(),
      });

      sendSocketMessage({
        type: "SUCCESS",
        taskId,
        url: affiliateUrl,
        data: body,
      });
    } finally {
      if (requestFailedHandler) {
        page.off("requestfailed", requestFailedHandler);
      }
    }
  } catch (error) {
    const code = classifyWorkerError(error);
    sendSocketMessage({
      type: "ERROR",
      taskId,
      url: affiliateUrl,
      requestUrl: requestRef,
      code,
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
  if (isRegisteringWorker) return;

  if (hasValidatedProfile) {
    sendSocketMessage({ type: "REGISTER_WORKER" });
    sendSessionStatus({
      workerReady: true,
      affiliateLoggedIn: true,
      message: "Profile affiliate da validate truoc do",
    });
    return;
  }

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
      sendSessionStatus({
        workerReady: false,
        affiliateLoggedIn: false,
        message: error.message,
        errorCode: classifyWorkerError(error),
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
        (payload.url || payload.itemId)
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

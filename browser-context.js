"use strict";

const { chromium } = require("playwright");
const path = require("path");

const { config } = require("./config");

const BLOCKING_PAGE_PATTERNS = [
  /loading issue/i,
  /please try again/i,
  /unusual activity/i,
  /access denied/i,
  /captcha/i,
];

const BLOCKING_URL_PATTERNS = [
  /\/verify\/traffic/i,
  /anti_bot_tracking_id=/i,
  /scene=crawler_item/i,
];

function buildLaunchOptions(overrides = {}) {
  const launchOptions = {
    headless: config.headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
    ],
    ...overrides,
  };

  if (config.browserExecutablePath) {
    launchOptions.executablePath = config.browserExecutablePath;
  } else if (config.browserChannel) {
    launchOptions.channel = config.browserChannel;
  }

  return launchOptions;
}

async function applyStealth(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });

    Object.defineProperty(navigator, "languages", {
      get: () => ["vi-VN", "vi", "en-US", "en"],
    });

    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });

    window.chrome = window.chrome || { runtime: {} };
  });

  await context.setExtraHTTPHeaders({
    "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  });
}

async function connectToChromeOverCdp() {
  const browser = await chromium.connectOverCDP(config.browserCdpUrl);
  const context = browser.contexts()[0];

  if (!context) {
    await browser.close().catch(() => {});
    throw new Error(
      `Khong tim thay browser context tu Chrome CDP: ${config.browserCdpUrl}`
    );
  }

  return {
    cdpUrl: config.browserCdpUrl,
    browser,
    close: async () => {
      await browser.close().catch(() => {});
    },
    context,
    mode: "chrome_cdp",
  };
}

async function launchPersistentBrowserContext(overrides = {}) {
  const context = await chromium.launchPersistentContext(
    path.resolve(__dirname, config.browserProfileDir),
    buildLaunchOptions(overrides)
  );

  await applyStealth(context);

  return {
    close: async () => {
      await context.close().catch(() => {});
    },
    context,
    cdpUrl: "",
    mode: "persistent",
  };
}

async function launchBrowserContext(overrides = {}) {
  if (config.browserProvider === "chrome_cdp" || config.browserCdpUrl) {
    return connectToChromeOverCdp();
  }

  return launchPersistentBrowserContext(overrides);
}

function looksLikeLoggedOutUrl(url) {
  const value = String(url || "").toLowerCase();
  return (
    value.includes("/login") ||
    value.includes("dang-nhap") ||
    value.includes("signin")
  );
}

async function readBodyText(page) {
  try {
    return await page
      .locator("body")
      .innerText({ timeout: config.blockingDetectTimeoutMs });
  } catch {
    return "";
  }
}

async function detectBlockingIssue(page) {
  const currentUrl = page.url();
  const blockedUrlPattern = BLOCKING_URL_PATTERNS.find((pattern) =>
    pattern.test(currentUrl)
  );

  if (blockedUrlPattern) {
    return {
      message: blockedUrlPattern.source,
      bodyText: "",
      currentUrl,
    };
  }

  const bodyText = await readBodyText(page);
  const matchedPattern = BLOCKING_PAGE_PATTERNS.find((pattern) =>
    pattern.test(bodyText)
  );

  if (!matchedPattern) return null;

  return {
    message: matchedPattern.source,
    bodyText,
    currentUrl,
  };
}

async function waitForAffiliatePageSettled(page, timeoutMs = config.pageSettleMs) {
  const settleMs = Math.max(0, Math.min(timeoutMs, config.pageSettleMs));

  if (settleMs > 0) {
    await page.waitForTimeout(settleMs);
  }

  try {
    await page.waitForLoadState("networkidle", {
      timeout: settleMs,
    });
  } catch {}
}

async function warmUpShopeeSession(page, options = {}) {
  if (!config.profileWarmupEnabled) {
    return {
      warmed: false,
      skipped: true,
      reason: "disabled",
    };
  }

  const targetUrl = String(options.targetUrl || "https://shopee.vn").trim();
  const waitMs = Math.max(
    config.pageSettleMs,
    Number(options.waitMs || config.profileWarmupDelayMs),
  );
  const keywordUrls = config.profileWarmupKeywords.map(
    (keyword) =>
      `https://shopee.vn/search?keyword=${encodeURIComponent(keyword)}`,
  );
  const warmupUrls =
    Array.isArray(options.warmupUrls) && options.warmupUrls.length > 0
      ? options.warmupUrls
      : [
          targetUrl,
          "https://shopee.vn/mall",
          ...keywordUrls,
        ];

  for (const url of warmupUrls) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(waitMs);
    await waitForAffiliatePageSettled(page, waitMs);

    const blockingIssue = await detectBlockingIssue(page);
    if (blockingIssue) {
      return {
        warmed: false,
        skipped: false,
        blockingIssue,
        currentUrl: page.url(),
        visitedUrls: warmupUrls,
      };
    }

    if (!config.profileWarmupDeepEnabled) {
      break;
    }
  }

  return {
    warmed: true,
    skipped: false,
    blockingIssue: null,
    currentUrl: page.url(),
    visitedUrls: warmupUrls,
  };
}

function isAffiliateRelatedUrl(url) {
  const value = String(url || "").toLowerCase();
  return (
    value.includes("affiliate.shopee.vn") ||
    value.includes("shopee.vn/verify/traffic") ||
    value.includes("shopee.vn/verify/captcha")
  );
}

async function findExistingAffiliatePage(context) {
  const pages = context.pages().slice().reverse();

  for (const page of pages) {
    if (isAffiliateRelatedUrl(page.url())) {
      return page;
    }
  }

  return null;
}

async function findAffiliatePageInSession(browserSession) {
  const contexts = browserSession.browser
    ? browserSession.browser.contexts().slice().reverse()
    : [browserSession.context];

  for (const context of contexts) {
    const page = await findExistingAffiliatePage(context);
    if (page) {
      return { context, page };
    }
  }

  return { context: browserSession.context, page: null };
}

function listSessionPageUrls(browserSession) {
  const contexts = browserSession.browser
    ? browserSession.browser.contexts()
    : [browserSession.context];
  const urls = [];

  for (const context of contexts) {
    for (const page of context.pages()) {
      urls.push(page.url() || "about:blank");
    }
  }

  return urls;
}

async function waitForAffiliatePageInSession(browserSession, timeoutMs = 30000) {
  const startedAt = Date.now();

  for (;;) {
    const found = await findAffiliatePageInSession(browserSession);
    if (found.page) {
      return found;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      return found;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

module.exports = {
  detectBlockingIssue,
  findExistingAffiliatePage,
  findAffiliatePageInSession,
  launchBrowserContext,
  listSessionPageUrls,
  looksLikeLoggedOutUrl,
  warmUpShopeeSession,
  waitForAffiliatePageSettled,
  waitForAffiliatePageInSession,
};

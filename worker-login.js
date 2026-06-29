"use strict";

const { config } = require("./config");
const { ensureChromeCdpReady } = require("./chrome-launcher");
const {
  detectBlockingIssue,
  findAffiliatePageInSession,
  launchBrowserContext,
  looksLikeLoggedOutUrl,
  warmUpShopeeSession,
  waitForAffiliatePageSettled,
  waitForAffiliatePageInSession,
} = require("./browser-context");

async function ensureBrowserReady() {
  if (!config.browserCdpUrl) return;

  await ensureChromeCdpReady({
    browserCdpUrl: config.browserCdpUrl,
    browserProfileDir: config.browserProfileDir,
    cwd: __dirname,
    timeoutMs: config.workerWaitTimeoutMs,
    logPrefix: "[login] ",
  });
}

async function ensureAffiliatePage(browserSession, targetUrl) {
  let found = await waitForAffiliatePageInSession(
    browserSession,
    config.workerWaitTimeoutMs
  );

  if (found.page) {
    return found.page;
  }

  const page = await found.context.newPage();
  const warmup = await warmUpShopeeSession(page, {
    targetUrl: "https://shopee.vn",
    waitMs: config.profileWarmupDelayMs,
  });
  if (warmup?.blockingIssue) {
    console.log(
      `Warm-up Shopee gap block/captcha (${warmup.blockingIssue.currentUrl || "unknown"}). Hay xu ly bang tay o tab nay truoc khi vao Affiliate.`
    );
    await page.bringToFront().catch(() => {});
    return page;
  }
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront().catch(() => {});
  console.log(`Da mo san tab affiliate: ${targetUrl}`);
  return page;
}

async function main() {
  await ensureBrowserReady();

  const browserSession = await launchBrowserContext({
    headless: false,
  });
  const { mode } = browserSession;
  const targetUrl = `${config.affiliateBaseUrl.replace(/\/$/, "")}/`;
  const page = await ensureAffiliatePage(browserSession, targetUrl);

  if (mode === "chrome_cdp") {
    console.log(`Dang attach vao Chrome that qua CDP: ${config.browserCdpUrl}`);
  } else {
    console.log(`Mo browser profile tai ${config.browserProfileDir}`);
  }
  if (process.env.PROFILE_NAME) {
    console.log(`Profile dang dung: ${process.env.PROFILE_NAME}`);
  }
  console.log(`Hay mo bang tay va login tai: ${targetUrl}`);

  page.on("response", (response) => {
    if (!response.url().includes("affiliate.shopee.vn")) return;
    console.log(`[affiliate] ${response.status()} ${response.url()}`);
  });

  page.on("requestfailed", (request) => {
    if (!request.url().includes("affiliate.shopee.vn")) return;
    console.log(
      `[affiliate-failed] ${request.failure()?.errorText || "unknown"} ${request.url()}`
    );
  });

  await waitForAffiliatePageSettled(page, 6000);

  const blockingIssue = await detectBlockingIssue(page);
  if (blockingIssue) {
    console.log(
      `Shopee dang tra trang loi/chong bot (${blockingIssue.currentUrl || "unknown"}). Neu login xong van thay verify/traffic hoac Loading Issue, nen dung Chrome that roi copy lai profile/session.`
    );
  } else if (looksLikeLoggedOutUrl(page.url())) {
    console.log("Trang hien tai cho thay profile chua login. Hay dang nhap truoc khi chay worker.");
  } else {
    console.log(`Profile co ve da login san. Dang o: ${page.url()}`);
  }

  console.log("Nhan Ctrl+C sau khi login xong de thoat. Profile se duoc giu lai.");
  console.log("Neu login thanh cong, hay mo duoc dashboard affiliate that su, khong phai trang Loading Issue.");

  process.on("SIGINT", async () => {
    await browserSession.close().catch(() => {});
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(`Loi worker-login: ${error.message}`);
  process.exit(1);
});

"use strict";

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const { chromium } = require("playwright");
const readline = require("readline");

const { config } = require("./config");
const { ensureChromeCdpReady: ensureChromeCdpReadyExternal } = require("./chrome-launcher");
const { warmUpShopeeSession } = require("./browser-context");
const {
  buildProfileEnv,
  findDefaultProfile,
  findProfileByNameOrId,
  formatProfileLine,
  getNextProfile,
  loadProfiles,
  markProfileFailure,
  markProfileHealthy,
  markProfileSelected,
  summarizeProfiles,
  touchProfileTask,
} = require("./profile-manager");

const children = new Set();
let shuttingDown = false;
let workerMonitorTimer = null;
let currentWorkerProfile = null;
let switchInFlight = false;
let lastAutoSwitchAt = 0;
const AUTO_SWITCH_ERROR_CODES = new Set([
  "CAPTCHA_REQUIRED",
  "LOGIN_REQUIRED",
  "LOADING_ISSUE",
  "CDP_DISCONNECTED",
]);

function prefixStream(stream, prefix) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    process.stdout.write(`${prefix} ${line}\n`);
  });
  return rl;
}

function spawnService(label, scriptName, options = {}) {
  const env = options.envFactory ? options.envFactory() : { ...process.env, ...(options.env || {}) };
  const child = spawn(process.execPath, [scriptName], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  children.add(child);
  const stdoutRl = prefixStream(child.stdout, `[${label}]`);
  const stderrRl = prefixStream(child.stderr, `[${label}]`);

  child.on("exit", (code, signal) => {
    stdoutRl.close();
    stderrRl.close();
    children.delete(child);

    if (!shuttingDown) {
      process.stdout.write(
        `[${label}] exited code=${code ?? "null"} signal=${signal ?? "null"}\n`
      );
      if (options.restart !== false) {
        setTimeout(() => {
          if (!shuttingDown) {
            spawnService(label, scriptName, options);
          }
        }, config.serviceRestartDelayMs).unref();
      }
    }
  });

  return child;
}

function requestHealth() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: config.port,
        path: "/health",
        method: "GET",
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

async function ensureChromeCdpReady(timeoutMs) {
  return ensureChromeCdpReadyInternal(timeoutMs);
}

async function ensureChromeCdpReadyInternal(timeoutMs) {
  await ensureChromeCdpReadyExternal({
    browserCdpUrl: config.browserCdpUrl,
    browserProfileDir: config.browserProfileDir,
    cwd: __dirname,
    timeoutMs,
  });
}

function requestJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: config.port,
        path: pathname,
        method: "GET",
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

function isAffiliateRelatedUrl(url) {
  const value = String(url || "").toLowerCase();
  return (
    value.includes("affiliate.shopee.vn") ||
    value.includes("shopee.vn/verify/traffic") ||
    value.includes("shopee.vn/verify/captcha")
  );
}

async function openAffiliatePageInChrome() {
  if (!config.browserCdpUrl) return;

  const browser = await chromium.connectOverCDP(config.browserCdpUrl);

  try {
    const contexts = browser.contexts();
    const context = contexts[0];

    if (!context) {
      throw new Error(
        `Khong tim thay browser context tu Chrome CDP: ${config.browserCdpUrl}`
      );
    }

    const existingPage = context
      .pages()
      .find((page) => isAffiliateRelatedUrl(page.url()));

    if (existingPage) {
      await existingPage.bringToFront().catch(() => {});
      process.stdout.write(
        `Da tim thay tab affiliate san: ${existingPage.url()}\n`
      );
      return;
    }

    const page = await context.newPage();
    const warmup = await warmUpShopeeSession(page, {
      targetUrl: "https://shopee.vn",
      waitMs: config.profileWarmupDelayMs,
    }).catch((error) => ({
      warmed: false,
      skipped: false,
      error,
    }));
    if (warmup?.blockingIssue) {
      process.stdout.write(
        `Warm-up Shopee gap block/captcha (${warmup.blockingIssue.currentUrl || "unknown"}). Hay xu ly bang tay truoc khi crawl affiliate.\n`
      );
      await page.bringToFront().catch(() => {});
      return;
    }

    const targetUrl = `${config.affiliateBaseUrl.replace(/\/$/, "")}/`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.bringToFront().catch(() => {});
    process.stdout.write(`Da mo san tab affiliate: ${targetUrl}\n`);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function openAffiliatePageForProfile(profile) {
  const env = buildProfileEnv(profile);
  if (!env.BROWSER_CDP_URL) return;

  await ensureChromeCdpReadyExternal({
    browserCdpUrl: env.BROWSER_CDP_URL,
    browserProfileDir: env.BROWSER_PROFILE_DIR,
    cwd: __dirname,
    timeoutMs: config.workerWaitTimeoutMs,
    logPrefix: `[profile:${profile.name}] `,
  });

  const browser = await chromium.connectOverCDP(env.BROWSER_CDP_URL);
  try {
    const context = browser.contexts()[0];
    if (!context) return;

    const existingPage = context.pages().find((page) => isAffiliateRelatedUrl(page.url()));
    if (existingPage) {
      await existingPage.bringToFront().catch(() => {});
      return;
    }

    const page = await context.newPage();
    const warmup = await warmUpShopeeSession(page, {
      targetUrl: "https://shopee.vn",
      waitMs: config.profileWarmupDelayMs,
    }).catch((error) => ({
      warmed: false,
      skipped: false,
      error,
    }));
    if (warmup?.blockingIssue) {
      process.stdout.write(
        `[profile:${profile.name}] Warm-up Shopee gap block/captcha (${warmup.blockingIssue.currentUrl || "unknown"}).\n`
      );
      await page.bringToFront().catch(() => {});
      return;
    }

    const targetUrl = `${config.affiliateBaseUrl.replace(/\/$/, "")}/`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.bringToFront().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
}

function getWorkerChild() {
  for (const child of children) {
    if (child.spawnargs?.includes("playwright-worker.js")) {
      return child;
    }
  }
  return null;
}

async function fetchWorkerSession() {
  const payload = await requestJson("/session");
  return payload?.session || null;
}

async function rotateWorkerProfile(reason, session) {
  if (switchInFlight || shuttingDown) return;
  if (Date.now() - lastAutoSwitchAt < config.profileSwitchDebounceMs) return;
  switchInFlight = true;

  try {
    const registry = loadProfiles();
    const currentRef =
      session?.profileName || currentWorkerProfile?.name || process.env.PROFILE_NAME || registry.defaultProfileId;
    const failureState = markProfileFailure(
      registry,
      currentRef,
      session?.errorCode || "PROFILE_BLOCKED",
      reason,
    );
    const nextProfile = getNextProfile(failureState.registry, currentRef, []);

    if (!nextProfile) {
      process.stdout.write(
        `[switch] Khong con profile khac de doi. Profile hien tai: ${currentRef}. Loi: ${reason}\n`
      );
      return;
    }

    currentWorkerProfile = markProfileSelected(failureState.registry, nextProfile);
    lastAutoSwitchAt = Date.now();
    process.stdout.write(
      `[switch] Shopee phat hien profile ${currentRef}. Dang doi sang ${formatProfileLine(currentWorkerProfile, true)}\n`
    );
    await openAffiliatePageForProfile(currentWorkerProfile).catch((error) => {
      process.stdout.write(`[switch] Khong mo san duoc tab affiliate cho ${currentWorkerProfile.name}: ${error.message}\n`);
    });

    const workerChild = getWorkerChild();
    if (workerChild) {
      workerChild.kill("SIGTERM");
    } else {
      spawnService("worker", "playwright-worker.js", {
        envFactory: () => ({
          ...process.env,
          ...buildProfileEnv(currentWorkerProfile),
        }),
      });
    }
  } finally {
    switchInFlight = false;
  }
}

function startWorkerSessionMonitor() {
  if (workerMonitorTimer) return;

  workerMonitorTimer = setInterval(async () => {
    try {
      const session = await fetchWorkerSession();
      if (!session) return;
      if (!session.profileName) return;
      if (session.workerReady) {
        const state = markProfileHealthy(loadProfiles(), session.profileName);
        touchProfileTask(state.registry, session.profileName);
        return;
      }
      if (!AUTO_SWITCH_ERROR_CODES.has(session.errorCode)) return;

      await rotateWorkerProfile(session.message || session.errorCode, session);
    } catch {}
  }, 3000);
  workerMonitorTimer.unref();
}

function printProfileSummary() {
  const summary = summarizeProfiles(loadProfiles());
  process.stdout.write(
    `[profiles] total=${summary.total} ready=${summary.ready} cooldown=${summary.cooldown} disabled=${summary.disabled} default=${summary.defaultProfileId || "-"}\n`
  );
}

async function waitForWorkerReady(timeoutMs) {
  const startedAt = Date.now();

  for (;;) {
    try {
      const health = await requestHealth();
      if (health.workerClients > 0) {
        return;
      }
    } catch {}

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Het ${Math.round(timeoutMs / 1000)}s ma worker van chua san sang`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    child.kill("SIGTERM");
  }
  if (workerMonitorTimer) {
    clearInterval(workerMonitorTimer);
    workerMonitorTimer = null;
  }

  setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 1000).unref();
}

async function main() {
  process.stdout.write(
    `Starting stack on port ${config.port} from ${path.basename(__dirname)}\n`
  );
  printProfileSummary();

  await ensureChromeCdpReady(config.workerWaitTimeoutMs);
  await openAffiliatePageInChrome();
  spawnService("server", "server.js");
  const registry = loadProfiles();
  currentWorkerProfile =
    findProfileByNameOrId(registry, process.env.PROFILE_NAME) ||
    findDefaultProfile(registry);
  spawnService("worker", "playwright-worker.js", {
    envFactory: () => ({
      ...process.env,
      ...(currentWorkerProfile ? buildProfileEnv(currentWorkerProfile) : {}),
    }),
  });
  startWorkerSessionMonitor();
  try {
    await waitForWorkerReady(config.workerWaitTimeoutMs);
    process.stdout.write(
      "Server va worker da san sang. Mo CLI trong cung terminal nay...\n"
    );
  } catch (error) {
    process.stdout.write(
      `${error.message}. Van tiep tuc mo CLI; worker se tu retry khi ban mo dashboard/login xong.\n`
    );
  }

  const cli = spawn(process.execPath, ["cli.js"], {
    cwd: __dirname,
    stdio: "inherit",
  });

  cli.on("exit", (code) => {
    shutdown(code ?? 0);
  });
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

main().catch((error) => {
  process.stderr.write(`stack error: ${error.message}\n`);
  shutdown(1);
});

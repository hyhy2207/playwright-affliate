"use strict";

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const { chromium } = require("playwright");
const readline = require("readline");

const { config } = require("./config");

const children = new Set();
let shuttingDown = false;

function prefixStream(stream, prefix) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    process.stdout.write(`${prefix} ${line}\n`);
  });
  return rl;
}

function spawnService(label, scriptName) {
  const child = spawn(process.execPath, [scriptName], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
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

function requestJson(urlString) {
  const url = new URL(urlString);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
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

function spawnChromeCdp() {
  const userDataDir =
    config.browserProfileDir && config.browserProfileDir !== ".browser-profile"
      ? config.browserProfileDir
      : "/tmp/shopee-cdp-profile";

  const chromeArgs = [
    "--remote-debugging-port=9222",
    `--user-data-dir=${userDataDir}`,
  ];

  const child = spawn("google-chrome", chromeArgs, {
    cwd: __dirname,
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  process.stdout.write(
    `Chrome CDP chua mo. Dang thu mo tu dong voi profile ${userDataDir}\n`
  );
}

async function ensureChromeCdpReady(timeoutMs) {
  if (!config.browserCdpUrl) return;

  const startedAt = Date.now();
  let hasSpawnedChrome = false;

  for (;;) {
    try {
      await requestJson(new URL("/json/version", config.browserCdpUrl).toString());
      process.stdout.write(`Chrome CDP da san sang tai ${config.browserCdpUrl}\n`);
      return;
    } catch (error) {
      if (!hasSpawnedChrome) {
        hasSpawnedChrome = true;
        spawnChromeCdp();
      }
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Khong ket noi duoc Chrome CDP tai ${config.browserCdpUrl}. Hay mo Chrome thu cong truoc.`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
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
    const targetUrl = `${config.affiliateBaseUrl.replace(/\/$/, "")}/`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.bringToFront().catch(() => {});
    process.stdout.write(`Da mo san tab affiliate: ${targetUrl}\n`);
  } finally {
    await browser.close().catch(() => {});
  }
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

  await ensureChromeCdpReady(config.workerWaitTimeoutMs);
  await openAffiliatePageInChrome();
  spawnService("server", "server.js");
  spawnService("worker", "playwright-worker.js");
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

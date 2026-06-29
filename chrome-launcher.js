"use strict";

const http = require("http");
const { spawn } = require("child_process");

function parseCdpUrl(cdpUrl) {
  const parsed = new URL(cdpUrl || "http://127.0.0.1:9222");
  return {
    host: parsed.hostname || "127.0.0.1",
    origin: parsed.origin,
    port: Number(parsed.port || 80),
    url: parsed.toString(),
  };
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
      },
    );

    req.on("error", reject);
    req.end();
  });
}

function spawnChromeCdp(options) {
  const {
    browserCdpUrl,
    browserProfileDir,
    cwd,
    logPrefix = "",
  } = options;
  const cdp = parseCdpUrl(browserCdpUrl);
  const chromeArgs = [
    `--remote-debugging-port=${cdp.port}`,
    `--user-data-dir=${browserProfileDir}`,
  ];

  const child = spawn("google-chrome", chromeArgs, {
    cwd,
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  process.stdout.write(
    `${logPrefix}Chrome CDP chua mo. Dang thu mo tu dong voi profile ${browserProfileDir} tai ${cdp.origin}\n`,
  );
}

async function ensureChromeCdpReady(options) {
  const {
    browserCdpUrl,
    browserProfileDir,
    cwd,
    timeoutMs,
    logPrefix = "",
  } = options;

  if (!browserCdpUrl) return;

  const startedAt = Date.now();
  let hasSpawnedChrome = false;

  for (;;) {
    try {
      await requestJson(new URL("/json/version", browserCdpUrl).toString());
      process.stdout.write(`${logPrefix}Chrome CDP da san sang tai ${browserCdpUrl}\n`);
      return;
    } catch {
      if (!hasSpawnedChrome) {
        hasSpawnedChrome = true;
        spawnChromeCdp({
          browserCdpUrl,
          browserProfileDir,
          cwd,
          logPrefix,
        });
      }
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Khong ket noi duoc Chrome CDP tai ${browserCdpUrl}. Hay mo Chrome thu cong truoc.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

module.exports = {
  ensureChromeCdpReady,
  parseCdpUrl,
  requestJson,
  spawnChromeCdp,
};

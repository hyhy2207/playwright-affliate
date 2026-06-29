"use strict";

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

const { config } = require("./config");

const children = new Map();
let shuttingDown = false;

function prefixStream(stream, prefix) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    process.stdout.write(`${prefix} ${line}\n`);
  });
  return rl;
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
      },
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
      },
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
    `[api] Chrome CDP chua mo. Dang thu mo tu dong voi profile ${userDataDir}\n`,
  );
}

async function ensureChromeCdpReady(timeoutMs) {
  if (!config.browserCdpUrl) return;

  const startedAt = Date.now();
  let hasSpawnedChrome = false;

  for (;;) {
    try {
      await requestJson(new URL("/json/version", config.browserCdpUrl).toString());
      process.stdout.write(`[api] Chrome CDP da san sang tai ${config.browserCdpUrl}\n`);
      return;
    } catch {
      if (!hasSpawnedChrome) {
        hasSpawnedChrome = true;
        spawnChromeCdp();
      }
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Khong ket noi duoc Chrome CDP tai ${config.browserCdpUrl}. Hay mo Chrome thu cong truoc.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function waitForServerReady(timeoutMs) {
  const startedAt = Date.now();

  for (;;) {
    try {
      await requestHealth();
      return;
    } catch {}

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Het ${Math.round(timeoutMs / 1000)}s ma server van chua san sang`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
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
        `Het ${Math.round(timeoutMs / 1000)}s ma worker van chua san sang`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function spawnService(label, scriptName, options = {}) {
  const child = spawn(process.execPath, [scriptName], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutRl = prefixStream(child.stdout, `[${label}]`);
  const stderrRl = prefixStream(child.stderr, `[${label}]`);
  children.set(label, { child, scriptName, options });

  process.stdout.write(
    `[api] started ${label} pid=${child.pid} script=${scriptName}\n`,
  );

  child.on("exit", (code, signal) => {
    stdoutRl.close();
    stderrRl.close();
    children.delete(label);

    const suffix = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    if (shuttingDown) {
      process.stdout.write(`[api] ${label} stopped ${suffix}\n`);
      return;
    }

    process.stdout.write(`[api] ${label} exited ${suffix}\n`);

    if (!config.serviceAutoRestart || options.restart === false) {
      shutdown(code || 1);
      return;
    }

    process.stdout.write(
      `[api] restarting ${label} in ${config.serviceRestartDelayMs}ms\n`,
    );
    setTimeout(() => {
      if (!shuttingDown) {
        spawnService(label, scriptName, options);
      }
    }, config.serviceRestartDelayMs).unref();
  });

  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const { child } of children.values()) {
    child.kill("SIGTERM");
  }

  setTimeout(() => {
    for (const { child } of children.values()) {
      child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 1000).unref();
}

async function main() {
  process.stdout.write(
    `Starting API stack on port ${config.port} from ${path.basename(__dirname)}\n`,
  );

  await ensureChromeCdpReady(config.workerWaitTimeoutMs);
  spawnService("server", "server.js");
  await waitForServerReady(config.workerWaitTimeoutMs);

  spawnService("worker", "playwright-worker.js");
  try {
    await waitForWorkerReady(config.workerWaitTimeoutMs);
    process.stdout.write("[api] server + worker ready\n");
  } catch (error) {
    process.stdout.write(
      `[api] ${error.message}. API van tiep tuc chay; worker se retry neu session/CDP san sang.\n`,
    );
  }
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

main().catch((error) => {
  process.stderr.write(`api-stack error: ${error.message}\n`);
  shutdown(1);
});

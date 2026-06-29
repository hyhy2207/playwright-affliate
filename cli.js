"use strict";

const http = require("http");
const readline = require("readline");

const { config } = require("./config");

const DONE_STATUSES = new Set(["success", "error"]);

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(2)}s`;
}

function requestJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: config.port,
        path,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let raw = "";

        res.on("data", (chunk) => {
          raw += chunk;
        });

        res.on("end", () => {
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            resolve({
              statusCode: res.statusCode || 0,
              body: parsed,
            });
          } catch (error) {
            reject(
              new Error(`Khong parse duoc response JSON: ${error.message}`),
            );
          }
        });
      },
    );

    req.on("error", (error) => {
      reject(error);
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

async function submitScrape(url) {
  const body =
    /^\d+$/.test(String(url).trim())
      ? { itemId: String(url).trim() }
      : { url };
  const response = await requestJson("POST", "/scrape", body);

  if (response.statusCode >= 400) {
    throw new Error(
      response.body?.message || `POST /scrape loi ${response.statusCode}`,
    );
  }

  return response.body.task;
}

async function fetchTask(taskId) {
  const response = await requestJson(
    "GET",
    `/tasks/${encodeURIComponent(taskId)}`,
  );

  if (response.statusCode >= 400) {
    throw new Error(
      response.body?.message ||
        `GET /tasks/${taskId} loi ${response.statusCode}`,
    );
  }

  return response.body.task;
}

async function fetchHealth() {
  const response = await requestJson("GET", "/health");

  if (response.statusCode >= 400) {
    throw new Error(
      response.body?.message || `GET /health loi ${response.statusCode}`,
    );
  }

  return response.body;
}

async function fetchTasks(status) {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const response = await requestJson("GET", `/tasks${query}`);

  if (response.statusCode >= 400) {
    throw new Error(response.body?.message || `GET /tasks loi ${response.statusCode}`);
  }

  return response.body;
}

function printTaskSummary(task) {
  console.log(`[${task.status}] ${task.taskId}`);

  const durationText = formatDurationMs(task.durationMs);
  const queueText = formatDurationMs(task.queueMs);
  const processingText = formatDurationMs(task.processingMs);

  if (durationText) {
    console.log(`- Tong thoi gian: ${durationText}`);
  }
  if (queueText) {
    console.log(`- Cho worker: ${queueText}`);
  }
  if (processingText) {
    console.log(`- Xu ly + lay JSON: ${processingText}`);
  }

  if (task.result) {
    // console.log(`- Product: ${task.result.productName}`);
    // console.log(`- Shop: ${task.result.shopName}`);
    // console.log(`- Price: ${task.result.price}`);
    // console.log(`- Sales: ${task.result.sales}`);
    // console.log(`- Rating: ${task.result.rating}`);
    // console.log(`- Commission: ${task.result.commission}`);
    // console.log(`- Product link: ${task.result.productLink}`);
    // console.log(`- Image: ${task.result.imageUrl}`);
    console.log("- JSON:");
    console.log(JSON.stringify(task.result, null, 2));
  }

  if (task.error) {
    console.log(`- Error: ${task.error}`);
  }

  if (task.parseError) {
    console.log(`- Parse error: ${task.parseError}`);
  }
}

function printTaskStatus(task) {
  console.log(`[${task.status}] ${task.taskId}`);
}

function printHealth(health) {
  console.log(`- Server port: ${health.port}`);
  console.log(`- Worker clients: ${health.workerClients}`);
  console.log(`- Tasks in store: ${health.taskCount}`);
}

async function ensureWorkerReady() {
  const deadline = Date.now() + config.workerWaitTimeoutMs;
  let hasPrintedWaitingMessage = false;

  for (;;) {
    const health = await fetchHealth();
    if (health.workerClients > 0) {
      if (hasPrintedWaitingMessage) {
        console.log(`Playwright worker da quay lai (${health.workerClients} connected).`);
      }
      return health;
    }

    if (!hasPrintedWaitingMessage) {
      console.log(
        `Dang cho worker reconnect... timeout ${Math.round(config.workerWaitTimeoutMs / 1000)}s`,
      );
      hasPrintedWaitingMessage = true;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        "Khong co Playwright worker nao dang ket noi. Hay chay npm run worker hoac npm run login.",
      );
    }

    await new Promise((resolve) => setTimeout(resolve, config.workerWaitPollMs));
  }
}

function printTasksList(payload) {
  console.log(`- Total tasks: ${payload.total}`);
  if (payload.filters?.status) {
    console.log(`- Filter status: ${payload.filters.status}`);
  }

  if (!payload.tasks || payload.tasks.length === 0) {
    console.log("- Khong co task nao.");
    return;
  }

  for (const task of payload.tasks) {
    console.log(`[${task.status}] ${task.taskId} - ${task.requestUrl}`);
  }
}

async function pollTaskUntilDone(taskId) {
  let lastStatus = null;

  for (;;) {
    const task = await fetchTask(taskId);

    if (task.status !== lastStatus) {
      printTaskStatus(task);
      lastStatus = task.status;
    }

    if (DONE_STATUSES.has(task.status)) {
      return task;
    }

    await new Promise((resolve) => setTimeout(resolve, config.taskPollMs));
  }
}

async function handleInput(line) {
  const input = line.trim();

  if (!input) {
    return;
  }

  if (input === "exit" || input === "quit") {
    process.exit(0);
  }

  if (input === "help") {
    console.log("Paste link Shopee hoac itemId de crawl.");
    console.log("Commands:");
    console.log("- health");
    console.log("- tasks [status]");
    console.log("- status <taskId>");
    console.log("- exit | quit");
    return;
  }

  if (input === "health") {
    try {
      const health = await fetchHealth();
      printHealth(health);
    } catch (error) {
      console.log(`Loi: ${error.message}`);
    }
    return;
  }

  if (input === "tasks" || input.startsWith("tasks ")) {
    const status = input === "tasks" ? "" : input.slice("tasks ".length).trim();

    try {
      const payload = await fetchTasks(status || undefined);
      printTasksList(payload);
    } catch (error) {
      console.log(`Loi: ${error.message}`);
    }
    return;
  }

  if (input.startsWith("status ")) {
    const taskId = input.slice("status ".length).trim();

    if (!taskId) {
      console.log("Hay dung: status <taskId>");
      return;
    }

    try {
      const task = await fetchTask(taskId);
      printTaskSummary(task);
    } catch (error) {
      console.log(`Loi: ${error.message}`);
    }
    return;
  }

  if (!input.startsWith("http://") && !input.startsWith("https://")) {
    if (!/^\d+$/.test(input)) {
      console.log(
        "Chi can paste link Shopee day du hoac itemId, vi du: https://shopee.vn/product/344837665/57458114650 hoac 57458114650",
      );
      console.log("Go 'help' de xem cac lenh ho tro.");
      return;
    }
  }

  try {
    const startedAtMs = Date.now();
    await ensureWorkerReady();
    const queuedTask = await submitScrape(input);
    console.log(`Da gui task: ${queuedTask.taskId}`);
    printTaskStatus(queuedTask);

    const finalTask = await pollTaskUntilDone(queuedTask.taskId);
    const observedDurationMs = Date.now() - startedAtMs;
    finalTask.durationMs =
      Number.isFinite(finalTask.durationMs) && finalTask.durationMs > 0
        ? finalTask.durationMs
        : observedDurationMs;
    printTaskSummary(finalTask);
  } catch (error) {
    console.log(`Loi: ${error.message}`);
  }
}

async function startCli() {
  console.log(`Shopee CLI dang noi toi http://127.0.0.1:${config.port}`);
  console.log(
    "Paste link Shopee hoac itemId vao dau > . Go 'help' de xem lenh, 'exit' de thoat.",
  );

  try {
    const health = await fetchHealth();
    printHealth(health);

    if (health.workerClients === 0) {
      console.log("Canh bao: chua co Playwright worker nao dang ket noi.");
    }
  } catch (error) {
    console.log(`Khong goi duoc server: ${error.message}`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    rl.pause();
    await handleInput(line);
    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

startCli().catch((error) => {
  console.error(`Loi khoi dong CLI: ${error.message}`);
  process.exit(1);
});

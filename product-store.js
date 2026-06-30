"use strict";

const fs = require("fs");
const path = require("path");

const { config } = require("./config");

function nowIso() {
  return new Date().toISOString();
}

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeReadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parseRawJson(raw) {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;

  try {
    return JSON.parse(raw);
  } catch {
    return { rawText: raw };
  }
}



function normalizeTaskHistoryLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function shouldPruneTaskHistoryRecord(task, perItemLimit) {
  const normalizedLimit = normalizeTaskHistoryLimit(perItemLimit);
  if (normalizedLimit <= 0) return false;
  if (!task?.itemId) return false;

  return task.status === "success" || task.status === "error";
}


function createNoopStore() {
  return {
    driver: "none",
    async init() {},
    async getProduct() {
      return null;
    },
    async listProducts({ limit = 50, offset = 0 } = {}) {
      return {
        items: [],
        total: 0,
        limit,
        offset,
      };
    },
    async getPriceHistory() {
      return [];
    },
    async upsertProduct() {
      return null;
    },
    async size() {
      return 0;
    },
    async upsertTaskRecord() {
      return null;
    },
    async getTaskRecord() {
      return null;
    },
    async listTaskRecords() {
      return [];
    },
    async close() {},
  };
}

function createFileStore() {
  const dataDir = path.resolve(__dirname, config.productDataDir);
  const productFile = path.join(dataDir, config.productStoreFile);
  const historyFile = path.join(dataDir, config.productHistoryFile);
  const taskFile = path.join(dataDir, "task-history.json");
  const products = new Map();
  const tasks = new Map();
  let persistTimer = null;
  let isDirty = false;

  function load() {
    const raw = safeReadJson(productFile, { products: [] });
    const items = Array.isArray(raw.products) ? raw.products : [];

    products.clear();
    for (const item of items) {
      if (!item?.itemId || !item?.result) continue;
      products.set(String(item.itemId), item);
    }

    const rawTasks = safeReadJson(taskFile, { tasks: [] });
    const taskItems = Array.isArray(rawTasks.tasks) ? rawTasks.tasks : [];
    tasks.clear();
    for (const task of taskItems) {
      if (!task?.taskId) continue;
      tasks.set(String(task.taskId), task);
    }
  }

  function persist() {
    ensureDirectory(productFile);
    const payload = {
      version: 1,
      updatedAt: nowIso(),
      products: Array.from(products.values()).sort((a, b) =>
        String(a.itemId).localeCompare(String(b.itemId)),
      ),
    };
    fs.writeFileSync(productFile, JSON.stringify(payload, null, 2), "utf8");

    ensureDirectory(taskFile);
    fs.writeFileSync(
      taskFile,
      JSON.stringify({
        version: 1,
        updatedAt: nowIso(),
        tasks: Array.from(tasks.values()).sort((a, b) =>
          String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
        ),
      }, null, 2),
      "utf8",
    );
    isDirty = false;
  }

  function flushPersistTimer() {
    if (!persistTimer) return;
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  function schedulePersist() {
    isDirty = true;
    if (persistTimer) return;

    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!isDirty) return;
      persist();
    }, config.productStoreFlushMs);

    if (typeof persistTimer.unref === "function") {
      persistTimer.unref();
    }
  }

  function persistNow() {
    flushPersistTimer();
    if (!isDirty) return;
    persist();
  }

  function appendHistory(record) {
    ensureDirectory(historyFile);
    fs.appendFileSync(historyFile, `${JSON.stringify(record)}\n`, "utf8");
  }

  load();

  return {
    driver: "file",
    async init() {},
    async getProduct(itemId) {
      return products.get(String(itemId || "")) || null;
    },
    async listProducts({ limit = 50, offset = 0, q = "" } = {}) {
      const needle = String(q || "").trim().toLowerCase();
      const all = Array.from(products.values())
        .filter((record) => {
          if (!needle) return true;
          const result = record.result || {};
          return (
            String(record.itemId).includes(needle) ||
            String(result.productName || "").toLowerCase().includes(needle) ||
            String(result.shopName || "").toLowerCase().includes(needle)
          );
        })
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

      return {
        items: all.slice(offset, offset + limit),
        total: all.length,
        limit,
        offset,
      };
    },
    async getPriceHistory(itemId, { limit = 100 } = {}) {
      if (!fs.existsSync(historyFile)) return [];

      const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
      return fs
        .readFileSync(historyFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((record) => record?.itemId === String(itemId))
        .slice(-safeLimit)
        .reverse();
    },
    async upsertProduct({ product, raw, affiliateUrl, source = "worker" }) {
      if (!product?.productID) return null;

      const itemId = String(product.productID);
      const current = products.get(itemId);
      const timestamp = nowIso();
      const record = {
        itemId,
        result: product,
        raw: parseRawJson(raw),
        affiliateUrl: affiliateUrl || product.productLink || null,
        source,
        createdAt: current?.createdAt || timestamp,
        updatedAt: timestamp,
      };

      products.set(itemId, record);
      schedulePersist();
      appendHistory({
        itemId,
        price: product.price,
        minPrice: product.minPrice,
        maxPrice: product.maxPrice,
        commission: product.commission,
        extraCommission: product.extraCommission,
        shopeeCommission: product.shopeeCommission,
        sales: product.sales,
        totalSales: product.totalSales,
        rating: product.rating,
        recordedAt: timestamp,
        source,
      });

      return record;
    },
    async size() {
      return products.size;
    },
    async upsertTaskRecord(task) {
      if (!task?.taskId) return null;
      tasks.set(String(task.taskId), {
        ...task,
        updatedAt: task.updatedAt || nowIso(),
      });
      schedulePersist();
      return tasks.get(String(task.taskId));
    },
    async getTaskRecord(taskId) {
      return tasks.get(String(taskId || "")) || null;
    },
    async listTaskRecords({ statuses = [], limit = 200 } = {}) {
      const statusSet = new Set(
        Array.isArray(statuses) ? statuses.map((status) => String(status)) : [],
      );
      return Array.from(tasks.values())
        .filter((task) => statusSet.size === 0 || statusSet.has(String(task.status || "")))
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
        .slice(0, Math.max(1, Number(limit) || 200));
    },
    async close() {
      persistNow();
    },
  };
}

function createProductStore() {
  if (config.productStoreDriver === "none") {
    return createNoopStore();
  }

  if (config.productStoreDriver === "file") {
    return createFileStore();
  }


  throw new Error(`PRODUCT_STORE_DRIVER khong ho tro: ${config.productStoreDriver}`);
}

const productStore = createProductStore();

module.exports = {
  normalizeTaskHistoryLimit,
  shouldPruneTaskHistoryRecord,
  createProductStore,
  productStore,
};

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

function toRecord(row) {
  if (!row) return null;

  return {
    itemId: String(row.item_id),
    result: row.result,
    raw: row.raw_json,
    affiliateUrl: row.affiliate_url,
    source: row.source,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function toTaskRecord(row) {
  if (!row) return null;

  return {
    taskId: row.task_id,
    itemId: row.item_id,
    requestUrl: row.request_url,
    requesterClientId: row.requester_client_id,
    assignedWorkerClientId: row.assigned_worker_client_id,
    status: row.status,
    requestPayload: row.request_payload,
    retryCount: Number(row.retry_count || 0),
    maxRetries: Number(row.max_retries || 0),
    nextAttemptAt: row.next_attempt_at instanceof Date ? row.next_attempt_at.toISOString() : row.next_attempt_at,
    affiliateUrl: row.affiliate_url,
    result: row.result,
    raw: row.raw_json,
    error: row.error_message,
    errorCode: row.error_code,
    parseError: row.parse_error,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    endedAt: row.ended_at instanceof Date ? row.ended_at.toISOString() : row.ended_at,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
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

function isUndefinedTableError(error, relationName) {
  return error?.code === "42P01" && String(error?.message || "").includes(`"${relationName}"`);
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

function createPostgresStore() {
  let pool = null;
  let taskHistorySchemaReadyPromise = null;

  function getPool() {
    if (pool) return pool;
    if (!config.databaseUrl) {
      throw new Error("Thieu DATABASE_URL cho PRODUCT_STORE_DRIVER=postgres");
    }

    let Pool;
    try {
      ({ Pool } = require("pg"));
    } catch (error) {
      throw new Error("Chua cai package pg. Hay chay: npm install");
    }

    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
    });
    return pool;
  }

  async function query(sql, params = []) {
    return getPool().query(sql, params);
  }

  async function ensureTaskHistorySchema() {
    if (!taskHistorySchemaReadyPromise) {
      taskHistorySchemaReadyPromise = (async () => {
        await query(`
          CREATE TABLE IF NOT EXISTS task_history (
            task_id TEXT PRIMARY KEY,
            item_id TEXT,
            request_url TEXT NOT NULL,
            requester_client_id BIGINT,
            assigned_worker_client_id BIGINT,
            status TEXT NOT NULL,
            request_payload JSONB,
            retry_count INT NOT NULL DEFAULT 0,
            max_retries INT NOT NULL DEFAULT 0,
            next_attempt_at TIMESTAMPTZ,
            affiliate_url TEXT,
            result JSONB,
            raw_json JSONB,
            error_message TEXT,
            error_code TEXT,
            parse_error TEXT,
            started_at TIMESTAMPTZ,
            ended_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await query("CREATE INDEX IF NOT EXISTS idx_task_history_status_updated_at ON task_history(status, updated_at DESC)");
        await query("CREATE INDEX IF NOT EXISTS idx_task_history_item_id ON task_history(item_id)");
      })().catch((error) => {
        taskHistorySchemaReadyPromise = null;
        throw error;
      });
    }

    return taskHistorySchemaReadyPromise;
  }

  async function withTaskHistoryRecovery(run) {
    try {
      return await run();
    } catch (error) {
      if (!isUndefinedTableError(error, "task_history")) {
        throw error;
      }

      taskHistorySchemaReadyPromise = null;
      await ensureTaskHistorySchema();
      return run();
    }
  }

  async function pruneTaskHistory(task) {
    const perItemLimit = normalizeTaskHistoryLimit(config.taskHistoryPerItemLimit);
    if (!shouldPruneTaskHistoryRecord(task, perItemLimit)) {
      return 0;
    }

    const result = await withTaskHistoryRecovery(() => query(
      `
        DELETE FROM task_history
        WHERE task_id IN (
          SELECT task_id
          FROM task_history
          WHERE item_id = $1
            AND status IN ('success', 'error')
          ORDER BY updated_at DESC, created_at DESC, task_id DESC
          OFFSET $2
        )
      `,
      [String(task.itemId), perItemLimit],
    ));

    return Number(result.rowCount || 0);
  }

  return {
    driver: "postgres",
    async init() {
      await query(`
        CREATE TABLE IF NOT EXISTS products (
          item_id TEXT PRIMARY KEY,
          result JSONB NOT NULL,
          raw_json JSONB,
          affiliate_url TEXT,
          source TEXT NOT NULL DEFAULT 'worker',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS price_history (
          id BIGSERIAL PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES products(item_id) ON DELETE CASCADE,
          price BIGINT,
          min_price BIGINT,
          max_price BIGINT,
          commission BIGINT,
          extra_commission BIGINT,
          shopee_commission BIGINT,
          sales BIGINT,
          total_sales BIGINT,
          rating TEXT,
          source TEXT NOT NULL DEFAULT 'worker',
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query("CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at DESC)");
      await query("CREATE INDEX IF NOT EXISTS idx_price_history_item_time ON price_history(item_id, recorded_at DESC)");
      await ensureTaskHistorySchema();
    },
    async getProduct(itemId) {
      const result = await query(
        "SELECT * FROM products WHERE item_id = $1",
        [String(itemId || "")],
      );
      return toRecord(result.rows[0]);
    },
    async listProducts({ limit = 50, offset = 0, q = "" } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
      const safeOffset = Math.max(0, Number(offset) || 0);
      const needle = String(q || "").trim();
      const params = [];
      let where = "";

      if (needle) {
        params.push(`%${needle.toLowerCase()}%`);
        where = `
          WHERE item_id ILIKE $1
             OR LOWER(result->>'productName') LIKE $1
             OR LOWER(result->>'shopName') LIKE $1
        `;
      }

      const countResult = await query(
        `SELECT COUNT(*)::INT AS total FROM products ${where}`,
        params,
      );
      params.push(safeLimit, safeOffset);
      const listResult = await query(
        `
          SELECT *
          FROM products
          ${where}
          ORDER BY updated_at DESC
          LIMIT $${params.length - 1}
          OFFSET $${params.length}
        `,
        params,
      );

      return {
        items: listResult.rows.map(toRecord),
        total: countResult.rows[0]?.total || 0,
        limit: safeLimit,
        offset: safeOffset,
      };
    },
    async getPriceHistory(itemId, { limit = 100 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
      const result = await query(
        `
          SELECT
            item_id,
            price,
            min_price,
            max_price,
            commission,
            extra_commission,
            shopee_commission,
            sales,
            total_sales,
            rating,
            source,
            recorded_at
          FROM price_history
          WHERE item_id = $1
          ORDER BY recorded_at DESC
          LIMIT $2
        `,
        [String(itemId || ""), safeLimit],
      );

      return result.rows.map((row) => ({
        itemId: row.item_id,
        price: row.price == null ? null : Number(row.price),
        minPrice: row.min_price == null ? null : Number(row.min_price),
        maxPrice: row.max_price == null ? null : Number(row.max_price),
        commission: row.commission == null ? null : Number(row.commission),
        extraCommission: row.extra_commission == null ? null : Number(row.extra_commission),
        shopeeCommission: row.shopee_commission == null ? null : Number(row.shopee_commission),
        sales: row.sales == null ? null : Number(row.sales),
        totalSales: row.total_sales == null ? null : Number(row.total_sales),
        rating: row.rating,
        source: row.source,
        recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
      }));
    },
    async upsertProduct({ product, raw, affiliateUrl, source = "worker" }) {
      if (!product?.productID) return null;

      const itemId = String(product.productID);
      const rawJson = parseRawJson(raw);
      const result = await query(
        `
          INSERT INTO products (
            item_id,
            result,
            raw_json,
            affiliate_url,
            source,
            created_at,
            updated_at
          )
          VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, NOW(), NOW())
          ON CONFLICT (item_id) DO UPDATE SET
            result = EXCLUDED.result,
            raw_json = EXCLUDED.raw_json,
            affiliate_url = EXCLUDED.affiliate_url,
            source = EXCLUDED.source,
            updated_at = NOW()
          RETURNING *
        `,
        [
          itemId,
          JSON.stringify(product),
          JSON.stringify(rawJson),
          affiliateUrl || product.productLink || null,
          source,
        ],
      );

      await query(
        `
          INSERT INTO price_history (
            item_id,
            price,
            min_price,
            max_price,
            commission,
            extra_commission,
            shopee_commission,
            sales,
            total_sales,
            rating,
            source
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          itemId,
          product.price,
          product.minPrice,
          product.maxPrice,
          product.commission,
          product.extraCommission,
          product.shopeeCommission,
          product.sales,
          product.totalSales,
          product.rating,
          source,
        ],
      );

      return toRecord(result.rows[0]);
    },
    async size() {
      const result = await query("SELECT COUNT(*)::INT AS total FROM products");
      return result.rows[0]?.total || 0;
    },
    async upsertTaskRecord(task) {
      if (!task?.taskId) return null;

      const result = await withTaskHistoryRecovery(() => query(
        `
          INSERT INTO task_history (
            task_id,
            item_id,
            request_url,
            requester_client_id,
            assigned_worker_client_id,
            status,
            request_payload,
            retry_count,
            max_retries,
            next_attempt_at,
            affiliate_url,
            result,
            raw_json,
            error_message,
            error_code,
            parse_error,
            started_at,
            ended_at,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13::jsonb,
            $14, $15, $16, $17, $18, COALESCE($19::timestamptz, NOW()), NOW()
          )
          ON CONFLICT (task_id) DO UPDATE SET
            item_id = EXCLUDED.item_id,
            request_url = EXCLUDED.request_url,
            requester_client_id = EXCLUDED.requester_client_id,
            assigned_worker_client_id = EXCLUDED.assigned_worker_client_id,
            status = EXCLUDED.status,
            request_payload = EXCLUDED.request_payload,
            retry_count = EXCLUDED.retry_count,
            max_retries = EXCLUDED.max_retries,
            next_attempt_at = EXCLUDED.next_attempt_at,
            affiliate_url = EXCLUDED.affiliate_url,
            result = EXCLUDED.result,
            raw_json = EXCLUDED.raw_json,
            error_message = EXCLUDED.error_message,
            error_code = EXCLUDED.error_code,
            parse_error = EXCLUDED.parse_error,
            started_at = EXCLUDED.started_at,
            ended_at = EXCLUDED.ended_at,
            updated_at = NOW()
          RETURNING *
        `,
        [
          task.taskId,
          task.itemId || null,
          task.requestUrl || task.itemId || "",
          task.requesterClientId ?? null,
          task.assignedWorkerClientId ?? null,
          task.status || "queued",
          JSON.stringify(task.requestPayload || null),
          Number(task.retryCount || 0),
          Number(task.maxRetries || 0),
          task.nextAttemptAt || null,
          task.affiliateUrl || null,
          JSON.stringify(task.result ?? null),
          JSON.stringify(parseRawJson(task.raw)),
          task.error || null,
          task.errorCode || null,
          task.parseError || null,
          task.startedAt || null,
          task.endedAt || null,
          task.createdAt || null,
        ],
      ));

      await pruneTaskHistory(task);

      return toTaskRecord(result.rows[0]);
    },
    async getTaskRecord(taskId) {
      const result = await withTaskHistoryRecovery(() => query("SELECT * FROM task_history WHERE task_id = $1", [
        String(taskId || ""),
      ]));
      return toTaskRecord(result.rows[0]);
    },
    async listTaskRecords({ statuses = [], limit = 200 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 1000));
      const statusValues = Array.isArray(statuses)
        ? statuses.map((status) => String(status || "").trim()).filter(Boolean)
        : [];
      const params = [];
      let where = "";

      if (statusValues.length > 0) {
        params.push(statusValues);
        where = "WHERE status = ANY($1::text[])";
      }

      params.push(safeLimit);
      const result = await withTaskHistoryRecovery(() => query(
        `
          SELECT *
          FROM task_history
          ${where}
          ORDER BY updated_at DESC
          LIMIT $${params.length}
        `,
        params,
      ));
      return result.rows.map(toTaskRecord);
    },
  };
}

function createProductStore() {
  if (config.productStoreDriver === "file") {
    return createFileStore();
  }

  if (config.productStoreDriver === "postgres") {
    return createPostgresStore();
  }

  throw new Error(`PRODUCT_STORE_DRIVER khong ho tro: ${config.productStoreDriver}`);
}

const productStore = createProductStore();

module.exports = {
  isUndefinedTableError,
  normalizeTaskHistoryLimit,
  shouldPruneTaskHistoryRecord,
  createProductStore,
  productStore,
};

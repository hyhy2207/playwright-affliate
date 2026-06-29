"use strict";

const PRODUCT_OUTPUT_MODES = new Set(["compact", "full", "raw"]);

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

function parseRawJson(rawData) {
  if (typeof rawData !== "string") return rawData;

  try {
    return JSON.parse(rawData);
  } catch {
    return rawData;
  }
}

function normalizeOutputMode(value) {
  const mode = String(value || "compact").trim().toLowerCase();
  return PRODUCT_OUTPUT_MODES.has(mode) ? mode : "compact";
}

function buildStoreProductEntry(record) {
  if (!record) return null;

  return {
    itemId: String(record.itemId),
    result: record.result,
    raw: record.raw,
    affiliateUrl: record.affiliateUrl,
    cachedAt: record.updatedAt,
    cachedAtMs: record.updatedAt ? new Date(record.updatedAt).getTime() : Date.now(),
  };
}

function buildProductPayload(entry, mode = "compact", options = {}) {
  const normalizedMode = normalizeOutputMode(mode);
  const productCacheTtlMs = Number(options.productCacheTtlMs || 0);

  if (normalizedMode === "raw") {
    return parseRawJson(entry.raw);
  }

  if (normalizedMode === "full") {
    return {
      ...entry.result,
      raw: parseRawJson(entry.raw),
      cache: entry.cachedAt
        ? {
            itemId: entry.itemId,
            cachedAt: entry.cachedAt,
            ttlMs: productCacheTtlMs,
          }
        : null,
    };
  }

  return entry.result;
}

function createTaskCacheEntry(task) {
  if (!task?.result?.productID) return null;

  return {
    itemId: String(task.result.productID),
    result: task.result,
    raw: task.raw,
    affiliateUrl: task.affiliateUrl,
    cachedAt: null,
    cachedAtMs: Date.now(),
  };
}

function buildTaskProductPayload(task, mode = "compact", options = {}) {
  const entry = createTaskCacheEntry(task);
  return entry ? buildProductPayload(entry, mode, options) : task?.result || null;
}

module.exports = {
  buildProductPayload,
  buildStoreProductEntry,
  buildTaskProductPayload,
  normalizeOutputMode,
  toBoolean,
};

"use strict";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidItemId(value) {
  return typeof value === "string" && /^\d+$/.test(value.trim());
}

function isValidShopeeHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  return normalized === "shopee.vn" || normalized.endsWith(".shopee.vn");
}

function validateScrapeRequest(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, message: "Payload phai la object JSON" };
  }

  if (!isNonEmptyString(payload.taskId)) {
    return { ok: false, message: "Thieu taskId hop le" };
  }

  if (isValidItemId(payload.itemId)) {
    return { ok: true };
  }

  if (!isNonEmptyString(payload.url)) {
    return { ok: false, message: "Thieu url hoac itemId hop le" };
  }

  try {
    const parsed = new URL(payload.url);
    if (!isValidShopeeHostname(parsed.hostname)) {
      return { ok: false, message: "url phai tro toi shopee.vn" };
    }
  } catch {
    return { ok: false, message: "url khong dung dinh dang URL hop le" };
  }

  return { ok: true };
}

function validateExtensionResult(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, message: "Payload extension khong hop le" };
  }

  if (!isNonEmptyString(payload.taskId)) {
    return { ok: false, message: "Payload extension thieu taskId" };
  }

  if (payload.type === "SUCCESS" && !isNonEmptyString(payload.data)) {
    return { ok: false, message: "Payload SUCCESS thieu data" };
  }

  if (payload.type === "ERROR" && !isNonEmptyString(payload.message)) {
    return { ok: false, message: "Payload ERROR thieu message" };
  }

  return { ok: true };
}

module.exports = {
  isValidItemId,
  isValidShopeeHostname,
  validateScrapeRequest,
  validateExtensionResult,
};

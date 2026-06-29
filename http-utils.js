"use strict";

function readBooleanQuery(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeListQueryValue(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(Math.floor(parsed), max));
}

function buildErrorMessage(message, extra = {}) {
  return {
    type: "ERROR",
    status: "error",
    message,
    ...extra,
  };
}

function buildHttpSuccessEnvelope(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const { ok, ...rest } = payload;
    if ("data" in rest) {
      return {
        ok: true,
        ...rest,
      };
    }

    return {
      ok: true,
      data: rest,
      ...rest,
    };
  }

  return {
    ok: true,
    data: payload,
  };
}

function buildHttpErrorEnvelope(payload) {
  const raw = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : { message: String(payload || "Request failed") };
  const {
    ok,
    error,
    message,
    errorCode,
    type,
    status,
    ...rest
  } = raw;
  const normalizedMessage =
    message ||
    error?.message ||
    "Request failed";
  const normalizedCode =
    errorCode ||
    error?.code ||
    type ||
    "ERROR";
  const details = error?.details && typeof error.details === "object"
    ? {
        ...error.details,
        ...rest,
      }
    : rest;

  return {
    ok: false,
    error: {
      code: normalizedCode,
      message: normalizedMessage,
      details,
    },
    type: type || "ERROR",
    status: status || "error",
    message: normalizedMessage,
    errorCode: normalizedCode,
    ...rest,
  };
}

function normalizeHttpPayload(statusCode, payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (payload.ok === true) {
      return buildHttpSuccessEnvelope(payload);
    }

    if (payload.ok === false) {
      return buildHttpErrorEnvelope(payload);
    }
  }

  if (statusCode >= 400) {
    return buildHttpErrorEnvelope(payload);
  }

  return buildHttpSuccessEnvelope(payload);
}

function sendHttpJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(normalizeHttpPayload(statusCode, payload)));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body qua lon"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body khong phai JSON hop le"));
      }
    });

    req.on("error", reject);
  });
}

module.exports = {
  buildErrorMessage,
  normalizeHttpPayload,
  normalizeListQueryValue,
  readBooleanQuery,
  readJsonBody,
  sendHttpJson,
};

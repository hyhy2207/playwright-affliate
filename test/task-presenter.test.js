"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTaskResponse } = require("../task-presenter");

test("buildTaskResponse keeps explicit itemId for url-based tasks", () => {
  const task = {
    taskId: "task-1",
    itemId: "987654321",
    requestUrl: "https://shopee.vn/product/123/987654321",
    status: "error",
    assignedWorkerClientId: 2,
    retryCount: 1,
    maxRetries: 2,
    nextAttemptAt: null,
    affiliateUrl: "https://affiliate.shopee.vn/offer/product_offer/987654321",
    result: null,
    raw: "{\"bad\":true}",
    error: "Response khong dung dinh dang Shopee Affiliate API",
    errorCode: "PARSE_ERROR",
    parseError: "Response khong dung dinh dang Shopee Affiliate API",
    startedAt: "2026-06-29T10:00:01.000Z",
    endedAt: "2026-06-29T10:00:02.000Z",
    createdAt: "2026-06-29T10:00:00.000Z",
    updatedAt: "2026-06-29T10:00:02.000Z",
  };

  const response = buildTaskResponse(task, { defaultMaxRetries: 2 });

  assert.equal(response.itemId, "987654321");
  assert.equal(response.status, "error");
  assert.equal(response.errorCode, "PARSE_ERROR");
  assert.equal(response.parseError, "Response khong dung dinh dang Shopee Affiliate API");
  assert.equal(response.queueMs, 1000);
  assert.equal(response.processingMs, 1000);
  assert.equal(response.durationMs, 2000);
});

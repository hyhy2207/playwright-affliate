"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isValidShopeeHostname,
  validateScrapeRequest,
} = require("../validation");

test("isValidShopeeHostname accepts root domain and subdomains", () => {
  assert.equal(isValidShopeeHostname("shopee.vn"), true);
  assert.equal(isValidShopeeHostname("affiliate.shopee.vn"), true);
  assert.equal(isValidShopeeHostname("mall.shopee.vn"), true);
});

test("isValidShopeeHostname rejects lookalike hosts", () => {
  assert.equal(isValidShopeeHostname("shopee.vn.evil.com"), false);
  assert.equal(isValidShopeeHostname("evilshopee.vn"), false);
  assert.equal(isValidShopeeHostname(""), false);
});

test("validateScrapeRequest accepts valid shopee url and numeric itemId", () => {
  assert.deepEqual(
    validateScrapeRequest({
      taskId: "task-1",
      url: "https://shopee.vn/product/123/456",
    }),
    { ok: true },
  );

  assert.deepEqual(
    validateScrapeRequest({
      taskId: "task-2",
      itemId: "456",
    }),
    { ok: true },
  );
});

test("validateScrapeRequest rejects non-shopee and lookalike urls", () => {
  assert.deepEqual(
    validateScrapeRequest({
      taskId: "task-3",
      url: "https://shopee.vn.evil.com/product/123/456",
    }),
    { ok: false, message: "url phai tro toi shopee.vn" },
  );

  assert.deepEqual(
    validateScrapeRequest({
      taskId: "task-4",
      url: "https://example.com/product/123/456",
    }),
    { ok: false, message: "url phai tro toi shopee.vn" },
  );
});

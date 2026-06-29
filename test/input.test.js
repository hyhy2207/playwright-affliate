"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractItemIdFromInput,
  isLikelyShopeeUrl,
  parseWsCommand,
} = require("../providers/shopee/input");

test("extractItemIdFromInput reads known shopee formats", () => {
  assert.equal(
    extractItemIdFromInput("https://shopee.vn/product/123456/987654321"),
    "987654321",
  );
  assert.equal(
    extractItemIdFromInput("https://shopee.vn/abc-i.123456.987654321"),
    "987654321",
  );
  assert.equal(
    extractItemIdFromInput("https://affiliate.shopee.vn/offer/product_offer/1?item_id=987654321"),
    "987654321",
  );
});

test("extractItemIdFromInput ignores lookalike hosts", () => {
  assert.equal(
    extractItemIdFromInput("https://shopee.vn.evil.com/?item_id=987654321"),
    "",
  );
});

test("isLikelyShopeeUrl only accepts valid shopee hosts", () => {
  assert.equal(isLikelyShopeeUrl("https://shopee.vn/product/1/2"), true);
  assert.equal(isLikelyShopeeUrl("https://sub.shopee.vn/product/1/2"), true);
  assert.equal(isLikelyShopeeUrl("https://shopee.vn.evil.com/product/1/2"), false);
});

test("parseWsCommand supports direct itemId and scrape command", () => {
  assert.deepEqual(parseWsCommand("987654321"), {
    payload: { itemId: "987654321" },
  });

  assert.deepEqual(parseWsCommand("scrape https://shopee.vn/product/1/987654321"), {
    payload: { url: "https://shopee.vn/product/1/987654321" },
  });
});

"use strict";

const {
  extractItemIdFromInput,
  getRequestItemId,
  parseWsCommand,
} = require("./input");
const { normalizeShopeeProduct } = require("./normalize-product");
const {
  buildProductPayload,
  buildStoreProductEntry,
  buildTaskProductPayload,
  normalizeOutputMode,
} = require("./output");

module.exports = {
  name: "shopee",
  extractItemIdFromInput,
  getRequestItemId,
  parseWsCommand,
  normalizeProduct: normalizeShopeeProduct,
  buildProductPayload,
  buildStoreProductEntry,
  buildTaskProductPayload,
  normalizeOutputMode,
};

"use strict";

const TARGET_API_PATH = "affiliate.shopee.vn/api/v3/offer/product";

function buildAffiliateUrl(baseUrl, itemId) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  return `${base}/offer/product_offer/${itemId}`;
}

module.exports = {
  TARGET_API_PATH,
  buildAffiliateUrl,
};

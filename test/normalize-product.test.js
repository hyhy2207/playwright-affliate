"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeShopeeProduct } = require("../providers/shopee/normalize-product");

test("normalizeShopeeProduct maps affiliate payload to storefront product", () => {
  const product = normalizeShopeeProduct({
    data: {
      item_id: 987654321,
      product_link: "https://shopee.vn/product/123/987654321",
      seller_com_final: 1200,
      shopee_com_final: 300,
      batch_item_for_item_card_full: {
        itemid: 987654321,
        shopid: 123,
        name: "Test Product",
        shop_name: "Test Shop",
        image: "abc123",
        price: 2500000,
        price_min: 2000000,
        price_max: 3000000,
        sold: 12,
        historical_sold: 34,
        item_rating: {
          rating_star: 4.8,
        },
      },
    },
  });

  assert.equal(product.productID, "987654321");
  assert.equal(product.productName, "Test Product");
  assert.equal(product.shopId, "123");
  assert.equal(product.shopName, "Test Shop");
  assert.equal(product.price, 25);
  assert.equal(product.minPrice, 20);
  assert.equal(product.maxPrice, 30);
  assert.equal(product.sales, 12);
  assert.equal(product.totalSales, 34);
  assert.equal(product.rating, "4.80");
  assert.equal(product.commission, 1500);
  assert.equal(product.extraCommission, 1200);
  assert.equal(product.shopeeCommission, 300);
  assert.equal(product.productLink, "https://shopee.vn/product/123/987654321");
  assert.equal(product.imageUrl, "https://cf.shopee.vn/file/abc123");
});

test("normalizeShopeeProduct throws for malformed payload", () => {
  assert.throws(
    () => normalizeShopeeProduct({ data: {} }),
    /Response khong dung dinh dang Shopee Affiliate API/,
  );
});

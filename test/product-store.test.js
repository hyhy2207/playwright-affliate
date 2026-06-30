"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.PRODUCT_STORE_DRIVER = "none";

const {
  normalizeTaskHistoryLimit,
  shouldPruneTaskHistoryRecord,
} = require("../product-store");

test("normalizeTaskHistoryLimit sanitizes env values", () => {
  assert.equal(normalizeTaskHistoryLimit(3), 3);
  assert.equal(normalizeTaskHistoryLimit("7"), 7);
  assert.equal(normalizeTaskHistoryLimit("0"), 0);
  assert.equal(normalizeTaskHistoryLimit(-5), 0);
  assert.equal(normalizeTaskHistoryLimit("abc"), 0);
});

test("shouldPruneTaskHistoryRecord only prunes completed item tasks", () => {
  assert.equal(
    shouldPruneTaskHistoryRecord({ itemId: "123", status: "success" }, 3),
    true,
  );
  assert.equal(
    shouldPruneTaskHistoryRecord({ itemId: "123", status: "error" }, 3),
    true,
  );
  assert.equal(
    shouldPruneTaskHistoryRecord({ itemId: "123", status: "queued" }, 3),
    false,
  );
  assert.equal(
    shouldPruneTaskHistoryRecord({ itemId: null, status: "success" }, 3),
    false,
  );
  assert.equal(
    shouldPruneTaskHistoryRecord({ itemId: "123", status: "success" }, 0),
    false,
  );
});


test("createProductStore supports none driver", async () => {
  process.env.PRODUCT_STORE_DRIVER = "none";
  delete require.cache[require.resolve("../config")];
  delete require.cache[require.resolve("../product-store")];

  const { createProductStore } = require("../product-store");
  const store = createProductStore();

  assert.equal(store.driver, "none");
  assert.equal(await store.getProduct("123"), null);
  assert.deepEqual(await store.listProducts(), {
    items: [],
    total: 0,
    limit: 50,
    offset: 0,
  });
});

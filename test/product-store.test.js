"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isUndefinedTableError,
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

test("isUndefinedTableError detects missing task_history relation", () => {
  assert.equal(
    isUndefinedTableError(
      { code: "42P01", message: 'relation "task_history" does not exist' },
      "task_history",
    ),
    true,
  );

  assert.equal(
    isUndefinedTableError(
      { code: "42P01", message: 'relation "products" does not exist' },
      "task_history",
    ),
    false,
  );

  assert.equal(
    isUndefinedTableError(
      { code: "23505", message: "duplicate key value violates unique constraint" },
      "task_history",
    ),
    false,
  );
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createTaskStore, TASK_STATUS } = require("../task-store");

test("waitForTaskCompletion resolves when task becomes completed", async () => {
  const store = createTaskStore();
  store.createTask({
    taskId: "task-1",
    requestUrl: "123",
    status: TASK_STATUS.QUEUED,
  });

  const waiting = store.waitForTaskCompletion("task-1", 1000);
  store.updateTask("task-1", {
    status: TASK_STATUS.SUCCESS,
    result: { productID: "123" },
  });

  const task = await waiting;
  assert.equal(task?.status, TASK_STATUS.SUCCESS);
  assert.deepEqual(task?.result, { productID: "123" });
});

test("waitForTaskCompletion resolves immediately for completed task", async () => {
  const store = createTaskStore();
  store.createTask({
    taskId: "task-2",
    requestUrl: "456",
    status: TASK_STATUS.QUEUED,
  });
  store.updateTask("task-2", {
    status: TASK_STATUS.ERROR,
    errorCode: "WORKER_ERROR",
  });

  const task = await store.waitForTaskCompletion("task-2", 1000);
  assert.equal(task?.status, TASK_STATUS.ERROR);
  assert.equal(task?.errorCode, "WORKER_ERROR");
});

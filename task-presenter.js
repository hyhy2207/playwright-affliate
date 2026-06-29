"use strict";

function toTimeMs(value) {
  return value ? new Date(value).getTime() : 0;
}

function buildTaskResponse(task, options = {}) {
  const defaultMaxRetries = Number(options.defaultMaxRetries || 0);
  const createdAtMs = toTimeMs(task.createdAt);
  const startedAtMs = toTimeMs(task.startedAt);
  const endedAtMs = toTimeMs(task.endedAt);
  const updatedAtMs = toTimeMs(task.updatedAt);
  const finishMs = endedAtMs || updatedAtMs;
  const durationMs =
    createdAtMs > 0 && finishMs >= createdAtMs ? finishMs - createdAtMs : null;
  const queueMs =
    createdAtMs > 0 && startedAtMs >= createdAtMs ? startedAtMs - createdAtMs : null;
  const processingMs =
    startedAtMs > 0 && finishMs >= startedAtMs ? finishMs - startedAtMs : null;

  return {
    taskId: task.taskId,
    itemId: task.itemId || (/^\d+$/.test(String(task.requestUrl || "")) ? String(task.requestUrl) : null),
    status: task.status,
    assignedWorkerClientId: task.assignedWorkerClientId ?? null,
    retryCount: Number(task.retryCount || 0),
    maxRetries: Number(task.maxRetries || defaultMaxRetries),
    nextAttemptAt: task.nextAttemptAt || null,
    requestUrl: task.requestUrl,
    affiliateUrl: task.affiliateUrl,
    result: task.result,
    raw: task.raw,
    error: task.error,
    errorCode: task.errorCode,
    parseError: task.parseError,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    durationMs,
    queueMs,
    processingMs,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

module.exports = {
  buildTaskResponse,
};

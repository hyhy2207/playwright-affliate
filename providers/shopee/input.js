"use strict";

const { isValidItemId, isValidShopeeHostname } = require("../../validation");

function extractItemIdFromInput(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  if (isValidItemId(input)) return input;

  const pathMatch = input.match(/\/product\/\d+\/(\d+)/);
  if (pathMatch?.[1]) return pathMatch[1];

  const seoMatch = input.match(/i\.\d+\.(\d+)/);
  if (seoMatch?.[1]) return seoMatch[1];

  try {
    const parsed = new URL(input);
    if (!isValidShopeeHostname(parsed.hostname)) {
      return "";
    }
    return parsed.searchParams.get("item_id") || "";
  } catch {
    return "";
  }
}

function getRequestItemId(payload) {
  return extractItemIdFromInput(payload.itemId || payload.url || "");
}

function isLikelyShopeeUrl(value) {
  if (typeof value !== "string") return false;

  try {
    const parsed = new URL(value.trim());
    return /^https?:$/i.test(parsed.protocol) && isValidShopeeHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function isLikelyItemId(value) {
  return isValidItemId(typeof value === "string" ? value.trim() : value);
}

function parseWsCommand(rawText) {
  const input = String(rawText || "").trim();
  if (!input) return null;

  if (isLikelyItemId(input)) {
    return {
      payload: {
        itemId: input,
      },
    };
  }

  if (isLikelyShopeeUrl(input)) {
    return {
      payload: {
        url: input,
      },
    };
  }

  const scrapeMatch = input.match(/^scrape\s+(.+)$/i);
  if (scrapeMatch && isLikelyShopeeUrl(scrapeMatch[1])) {
    return {
      payload: {
        url: scrapeMatch[1].trim(),
      },
    };
  }

  if (scrapeMatch && isLikelyItemId(scrapeMatch[1])) {
    return {
      payload: {
        itemId: scrapeMatch[1].trim(),
      },
    };
  }

  return null;
}

module.exports = {
  extractItemIdFromInput,
  getRequestItemId,
  isLikelyShopeeUrl,
  isLikelyItemId,
  parseWsCommand,
};

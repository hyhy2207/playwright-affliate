"use strict";

function toNumber(value, fallback = 0) {
  const numeric =
    typeof value === "number"
      ? value
      : Number(String(value ?? "").replace(/[^\d.-]/g, ""));

  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeMoneyValue(value, fallback = 0) {
  const numeric = toNumber(value, fallback);
  return numeric > 100000 ? Math.round(numeric / 100000) : numeric;
}

function buildShopeeImageUrl(image) {
  const value = String(image || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://cf.shopee.vn/file/${value}`;
}

function normalizeCommissionFallback(rawCommission, fallbackCommission) {
  const commission = toNumber(rawCommission, fallbackCommission);
  if (commission <= 0) return fallbackCommission;

  const rawValue = String(rawCommission ?? "").trim();
  const hasDecimalPart = rawValue.includes(".") && !rawValue.includes(",");

  if (hasDecimalPart && commission < 1000) {
    return Math.round(commission * 1000);
  }

  return commission;
}

function normalizeCommissionValue(value, fallback = 0) {
  return normalizeCommissionFallback(value, fallback);
}

function normalizeShopeeProduct(rawData) {
  const raw = typeof rawData === "string" ? JSON.parse(rawData) : rawData;

  const data = raw?.data || {};
  const item =
    data?.batch_item_for_item_card_full ||
    data?.item ||
    data?.product ||
    data?.itemCard ||
    {};

  if (!data || !item) {
    throw new Error("Response khong dung dinh dang Shopee Affiliate API");
  }

  const rawPrice =
    item.price ??
    item.price_info?.price ??
    item.priceMin ??
    item.current_price ??
    0;
  const price = normalizeMoneyValue(rawPrice);
  const minPrice = normalizeMoneyValue(
    item.price_min ?? item.priceMin ?? rawPrice,
  );
  const maxPrice = normalizeMoneyValue(
    item.price_max ?? item.priceMax ?? rawPrice,
  );
  const sellerComFinal = toNumber(
    data.seller_com_final ??
      data.sellerComFinal ??
      data.sellerCommissionFinal ??
      data.sellerCommission ??
      data.seller_comission,
  );
  const shopeeComFinal = toNumber(
    data.shopee_com_final ??
      data.shopeeComFinal ??
      data.shopeeCommissionFinal ??
      data.shopeeCommission ??
      data.platformCommission,
  );
  const extraCommission =
    sellerComFinal ||
    normalizeCommissionValue(
      data.commission_rate?.seller_commission ??
        data.commissionRate?.seller_commission ??
        data.commissionRate?.sellerCommission,
      0,
    );
  const shopeeCommission =
    shopeeComFinal ||
    normalizeCommissionValue(
      data.commission_rate?.shopee_commission ??
        data.commissionRate?.shopee_commission ??
        data.commissionRate?.shopeeCommission,
      0,
    );
  const fallbackCommission = sellerComFinal + shopeeComFinal;
  const finalCommissionValue =
    data.commission_final ??
    data.commissionFinal ??
    data.total_commission ??
    data.totalCommission ??
    data.finalCommission;
  const commission =
    finalCommissionValue != null
      ? toNumber(finalCommissionValue, fallbackCommission)
      : fallbackCommission > 0
        ? fallbackCommission
        : normalizeCommissionFallback(data.commission, fallbackCommission);
  const productLink =
    data.product_link ||
    data.productLink ||
    item.product_link ||
    item.offerLink ||
    "";

  const product = {
    productID: String(
      item.itemid ?? item.item_id ?? data.item_id ?? data.itemId ?? "",
    ),
    price,
    minPrice,
    maxPrice,
    sales: toNumber(item.sold ?? item.sales ?? item.historical_sold),
    totalSales: toNumber(item.historical_sold ?? item.sold ?? item.sales),
    rating: Number(
      item.item_rating?.rating_star || item.rating_star || item.rating || 0,
    ).toFixed(2),
    imageUrl: buildShopeeImageUrl(
      item.image || item.imageUrl || item.image_url,
    ),
    shopName: item.shop_name || item.shopName || data.shop_name || "",
    commission,
    hasExtraCommission: extraCommission > 0,
    extraCommission,
    hasShopeeCommission: shopeeCommission > 0,
    shopeeCommission,
    productLink,
    productName: item.name || item.productName || "",
  };

  if (!product.productID || !product.productName || !product.productLink) {
    throw new Error("Response khong dung dinh dang Shopee Affiliate API");
  }

  return product;
}

module.exports = {
  normalizeShopeeProduct,
};

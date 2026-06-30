# Playwright Shopee

`playwright-shopee` la crawler Shopee Affiliate dung `Playwright + Chrome profile that`, khong phu thuoc vao extension worker.

Repo hien tai tap trung vao 4 viec:

- giu session Shopee/Affiliate tren browser profile co dinh
- crawl qua Chrome CDP hoac persistent profile
- expose HTTP API de tool khac goi theo `itemId` hoac link Shopee
- co queue, retry, profile registry, auto switch profile khi bi block/captcha

## Thanh phan chinh

- `server.js`: HTTP API + WebSocket relay + task queue + parse result
- `playwright-worker.js`: attach browser, nhan task, goi API affiliate, fallback `goto`
- `stack.js`: chay server + worker trong 1 terminal
- `api-stack.js`: mode chay nen, tu restart child process, theo doi worker session
- `worker-login.js`: mo browser va giup login session affiliate
- `profile-launcher.js`: chon profile truoc khi chay `login`, `stack`, `api`, `worker`
- `profile-manager.js`: luu registry profile trong `.profiles/profiles.json`
- `browser-context.js`: attach CDP/persistent context, detect block/captcha, warm-up session
- `product-store.js`: store local bang file khi can
- `providers/shopee/`: parse input, build affiliate URL, normalize output JSON

## Cai dat

```bash
cd /home/thanhhuy/dev/crawler/playwright-shopee
npm install
cp .env.example .env
```

Scripts:

```bash
npm run profiles
npm run login
npm run stack
npm run api
npm run worker
npm run test
npm run check
```

## Config quan trong

Gia tri mac dinh dang nam trong `.env.example`:

```env
PORT=8080
TASK_QUEUE_TIMEOUT_MS=10000
TASK_TIMEOUT_MS=15000
TASK_MAX_RETRIES=2
TASK_RETRY_DELAY_MS=1500
PRODUCT_CACHE_TTL_MS=0
PRODUCT_REQUEST_TIMEOUT_MS=10000
PRODUCT_BATCH_LIMIT=20
PRODUCT_STORE_DRIVER=none
PRODUCT_STORE_FLUSH_MS=250
QUEUE_DRIVER=memory
QUEUE_DRIVER_FALLBACK=memory
REDIS_URL=redis://127.0.0.1:6379/0
WORKER_SOCKET_URL=ws://127.0.0.1:8080
BROWSER_PROFILE_DIR=.profiles/default
BROWSER_CDP_URL=http://127.0.0.1:9222
BROWSER_CHANNEL=chrome
BROWSER_EXECUTABLE_PATH=
PROFILE_COOLDOWN_MS=1200000
PROFILE_COOLDOWN_MAX_MS=21600000
PROFILE_MIN_TASK_GAP_MS=1200
PROFILE_SWITCH_DEBOUNCE_MS=5000
PROFILE_WARMUP_ENABLED=true
PROFILE_WARMUP_DELAY_MS=4000
PROFILE_WARMUP_DEEP_ENABLED=true
PROFILE_WARMUP_KEYWORDS=dien thoai
HEADLESS=false
SCRAPE_TIMEOUT_MS=8000
PAGE_SETTLE_MS=120
BLOCKING_DETECT_TIMEOUT_MS=250
AFFILIATE_BASE_URL=https://affiliate.shopee.vn
```

Ghi chu:

- `PRODUCT_STORE_DRIVER=none` la mac dinh, nen repo khong luu product persistence.
- `PRODUCT_CACHE_TTL_MS=0` la mac dinh, nen tat RAM cache.
- `QUEUE_DRIVER=memory` la mac dinh.
- `BROWSER_CDP_URL` la cach on dinh nhat de attach vao Chrome that da login.

## Cach chay on dinh nhat

### 1. Chon hoac tao profile

```bash
npm run profiles
```

Moi profile duoc luu rieng trong `.profiles/`.

- Neu co `.browser-profile` cu thi lan chay dau se migrate sang `.profiles/default`.
- Moi profile co the co `cdpPort` rieng neu dang dung `BROWSER_CDP_URL`.
- Registry profile nam trong `.profiles/profiles.json`.

Co the chon profile truc tiep:

```bash
npm run login -- --profile=seller-a
npm run stack -- --profile=seller-a
npm run api -- --profile=seller-a
```

### 2. Mo Chrome CDP

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=.profiles/default
```

Vi du profile rieng:

```bash
google-chrome --remote-debugging-port=9223 --user-data-dir=.profiles/thanhhuy2
```

### 3. Dang nhap Shopee va Affiliate

Trong cua so Chrome do:

- dang nhap `https://shopee.vn`
- xu ly captcha, `verify/traffic`, `loading issue` neu co
- sau do chay:

```bash
npm run login
```

`npm run login` se warm-up session va mo san tab `https://affiliate.shopee.vn/`.

### 4. Chay he thong

Mode thuong dung:

```bash
npm run stack
```

Lenh nay se:

- bao dam Chrome CDP dang san sang
- mo/warm-up tab affiliate neu can
- start `server.js`
- start `playwright-worker.js`
- theo doi `/session` de auto switch profile neu worker gap captcha/login/block

Mode chay nen:

```bash
npm run api
```

Neu dung PM2:

```bash
pm2 start ecosystem.config.js
pm2 logs playwright-shopee-api
pm2 restart playwright-shopee-api
```

## Profile va auto switch

Moi profile luu:

- `name`, `profileDir`, `cdpPort`
- `status`: `ready`, `cooldown`, `disabled`
- `blockedUntil`
- `failureCount`, `successCount`, `switchCount`
- `lastErrorCode`, `lastErrorMessage`
- `lastUsedAt`, `lastTaskAt`

Khi worker gap cac loi sau, `stack.js` va `api-stack.js` co the auto doi profile:

- `CAPTCHA_REQUIRED`
- `LOGIN_REQUIRED`
- `LOADING_ISSUE`
- `CDP_DISCONNECTED`

HTTP API quan ly profile:

```bash
curl http://127.0.0.1:8080/profiles
curl -X POST http://127.0.0.1:8080/profiles/thanhhuy/recover
curl -X POST http://127.0.0.1:8080/profiles/thanhhuy/default
curl -X POST http://127.0.0.1:8080/profiles/thanhhuy/disable
curl -X POST http://127.0.0.1:8080/profiles/thanhhuy/enable
curl -X POST http://127.0.0.1:8080/profiles/thanhhuy/cooldown \
  -H "Content-Type: application/json" \
  -d '{"durationMs":600000}'
```

Xoa profile:

```bash
npm run profiles
npm run profiles -- --delete-profile=seller-a
```

## Crawl flow hien tai

Server nhan request bang `url` hoac `itemId`, tao task, day vao queue, roi worker xu ly.

Worker uu tien flow nhanh:

1. tach `itemId` tu input
2. goi thang affiliate API trong browser context qua `fetch(...)`
3. neu khong lay duoc response hop le thi fallback sang `goto https://affiliate.shopee.vn/offer/product_offer/<itemId>`
4. cho response `api/v3/offer/product`
5. gui raw JSON ve `server.js`
6. `server.js` normalize thanh output gon

Format input hop le:

- `57458114650`
- `https://shopee.vn/product/<shop_id>/<item_id>`
- SEO URL kieu `...-i.<shop_id>.<item_id>`
- URL co query `item_id=<item_id>`

## HTTP API

### Health va session

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/session
curl http://127.0.0.1:8080/queue
```

- `/health`: worker count, queue size, product store driver
- `/session`: them `latestWorkerSession`, profile summary, cache size
- `/queue`: thong tin queue driver + task dang `queued/running`

### Scrape task API

Theo link:

```bash
curl -X POST http://127.0.0.1:8080/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://shopee.vn/product/344837665/57458114650"}'
```

Theo `itemId`:

```bash
curl -X POST http://127.0.0.1:8080/scrape \
  -H "Content-Type: application/json" \
  -d '{"itemId":"57458114650"}'
```

Chi queue task:

```bash
curl -X POST "http://127.0.0.1:8080/scrape?wait=0" \
  -H "Content-Type: application/json" \
  -d '{"itemId":"57458114650"}'
```

Task API:

```bash
curl http://127.0.0.1:8080/tasks
curl http://127.0.0.1:8080/tasks/<task-id>
curl -X POST http://127.0.0.1:8080/tasks/<task-id>/cancel
curl -X DELETE http://127.0.0.1:8080/tasks/<task-id>
```

### Product API

```bash
curl http://127.0.0.1:8080/product/57458114650
curl "http://127.0.0.1:8080/product/57458114650?mode=compact"
curl "http://127.0.0.1:8080/product/57458114650?mode=full"
curl "http://127.0.0.1:8080/product/57458114650?mode=raw"
curl "http://127.0.0.1:8080/product/57458114650?refresh=1"
curl "http://127.0.0.1:8080/product/57458114650?stale=1"
```

Batch:

```bash
curl -X POST http://127.0.0.1:8080/products/batch \
  -H "Content-Type: application/json" \
  -d '{"itemIds":["57458114650","20300919760"],"mode":"compact"}'
```

Batch co the nhan `itemIds`, `items`, hoac `urls`.

### Product store API

Chi co y nghia khi:

```env
PRODUCT_STORE_DRIVER=file
```

Khi do co them:

```bash
curl http://127.0.0.1:8080/products
curl http://127.0.0.1:8080/products/57458114650/history
```

File store local:

- `data/products.json`
- `data/price-history.jsonl`
- `data/task-history.json`

## Response shape

HTTP response success hien tai duoc normalize boi `sendHttpJson()`:

- success thuong co dang `{ "data": { ... } }`
- error co dang `{ "ok": false, "error": { "code", "message", "details" }, ... }`

Vi du success:

```json
{
  "data": {
    "type": "SUCCESS",
    "message": "Crawl thanh cong"
  }
}
```

Vi du error:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR",
    "message": "Khong tim thay task",
    "details": {
      "taskId": "abc"
    }
  }
}
```

## Output JSON sau khi normalize

Raw response Shopee Affiliate se duoc map thanh object gon:

```json
{
  "productID": "20300919760",
  "price": 2186000,
  "minPrice": 2186000,
  "maxPrice": 4097000,
  "sales": 623,
  "totalSales": 1200,
  "rating": "4.85",
  "imageUrl": "https://cf.shopee.vn/file/...",
  "shopId": "174420235",
  "shopName": "HONALIFE VN",
  "commission": 196740,
  "hasExtraCommission": true,
  "extraCommission": 109300,
  "hasShopeeCommission": true,
  "shopeeCommission": 40000,
  "productLink": "https://shopee.vn/product/174420235/20300919760",
  "productName": "..."
}
```

Parser se fail neu thieu `productID`, `productName`, hoac `productLink`.

## Queue, retry, cache, store

### Queue

- `memory`: default, queue nam trong process
- `bullmq`: queue persistence tren Redis

Neu `QUEUE_DRIVER=bullmq` ma init loi, server co the fallback ve `QUEUE_DRIVER_FALLBACK`.

### Retry

Retry tu dong khi worker tra ve:

- `WORKER_ERROR`
- `CDP_DISCONNECTED`

Task response co `retryCount`, `maxRetries`, `nextAttemptAt`.

### Cache

RAM cache chi hoat dong khi:

```env
PRODUCT_CACHE_TTL_MS > 0
```

### Store local

Chi luu khi:

```env
PRODUCT_STORE_DRIVER=file
```

Store local phu hop de debug output, xem lich su gia/commission, va giu task history sau restart.

## Loi hay gap

### Worker khong len

```bash
curl http://127.0.0.1:8080/health
```

Neu `workerClients = 0` thi thu mo lai Chrome CDP, chay lai `npm run stack`, va mo san dashboard affiliate.

### `connect ECONNREFUSED`

Chrome chua mo hoac sai port:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=.profiles/default
```

### Bi captcha / loading issue / verify traffic

Repo khong bypass captcha. Can quay lai cua so Chrome that, xu ly bang tay, vao lai affiliate, roi neu can thi restart `npm run stack`.

### Task dung o `queued`

Thuong do worker chua connect, queue dang cho retry, hoac server vua khoi dong lai.

```bash
curl http://127.0.0.1:8080/queue
curl http://127.0.0.1:8080/session
```

## Kiem tra source

```bash
npm run check
npm run test
```

`npm run check` se parse syntax cac file JS chinh. `npm run test` chay test cho `validation`, `input`, `normalize-product`, `task-store`, `task-presenter`, `product-store`.

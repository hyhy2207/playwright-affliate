# Tong quan

Doc này đang bao gồm:

- Kiến trúc tổng thể của source hiện tại.

- Vai trò từng file chính: server.js, playwright-worker.js, browser-context.js, stack.js, task-store.js, cli.js.

- Luồng chạy từ Chrome CDP, login Shopee/Affiliate, npm run stack, nhập link hoặc itemId.

- Vòng đời task: queued -> running -> success/error.

- Logic worker: fast API path, fallback goto, detect captcha/loading issue.

- Logic parse JSON, tiền, commission, sales, totalSales.

- Config quan trọng trong .env.

- Các lỗi hay gặp và cách xử lý.

- Phương án phát triển tiếp cho src hiện tại (26/06/2026): log tốc độ, cache theo itemId, timeout chống kẹt, endpoint nhanh, output mode, session health check, chạy nền.

# Playwright Shopee - Source Guide

Tai lieu nay mo ta source hien tai cua `playwright-shopee`: kien truc, cach cac module noi voi nhau, logic xu ly task, cach lay data bang item id/link Shopee, va cac huong phat trien tiep theo.

## 1. Muc tieu he thong

`playwright-shopee` dung Playwright de attach vao mot Chrome that da login Shopee Affiliate. Muc tieu la lay thong tin san pham va commission tu Shopee Affiliate nhanh hon extension cu, dong thoi van giu duoc session that trong browser.

He thong hien tai tap trung vao 4 viec:

- Giu session Shopee/Affiliate trong Chrome CDP profile.
- Nhan input tu CLI hoac HTTP API bang Shopee URL hoac `itemId`.
- Gui task tu server sang worker qua WebSocket.
- Worker lay raw affiliate response roi server parse thanh JSON gon.

## 2. Cau truc file chinh

```text
playwright-shopee/
  browser-context.js      Quan ly Chrome/Playwright context, detect captcha/block.
  api-stack.js            Chay nen server + worker, khong mo CLI, co auto restart child process.
  cli.js                  CLI nhap link hoac item id, poll task, in JSON va thoi gian.
  config.js               Doc .env va expose config dung chung.
  ecosystem.config.js     Cau hinh PM2 mau neu muon chay lau dai.
  logger.js               Ghi log ra console va logs/tasks.jsonl.
  playwright-worker.js    Worker attach Chrome, nhan task, lay data tu Shopee Affiliate.
  product-store.js        Adapter luu product/raw/history vao PostgreSQL hoac file fallback.
  server.js               HTTP API + WebSocket relay + parse JSON response.
  stack.js                Chay server + worker + cli trong 1 terminal.
  task-store.js           Luu task trong RAM, status, duration.
  validation.js           Validate request/worker payload.
  worker-login.js         Kiem tra profile Chrome da login Affiliate.
```

## 3. Luong chay tong quat

### 3.1. Khoi dong

1. Mo Chrome CDP:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/shopee-cdp-profile
```

2. Dang nhap Shopee truoc, xu ly captcha.

3. Dang nhap Shopee Affiliate, vao dashboard va cho on dinh.

4. Chay stack:

```bash
npm run stack
```

`stack.js` se:

- Kiem tra Chrome CDP tai `BROWSER_CDP_URL`.
- Neu Chrome CDP chua mo, thu mo Chrome tu dong.
- Khoi dong `server.js`.
- Khoi dong `playwright-worker.js`.
- Doi worker san sang.
- Mo `cli.js`.

Neu chay API nen:

```bash
npm run api
```

`api-stack.js` se:

- Khoi dong `server.js`.
- Doi server ready qua `/health`.
- Khoi dong `playwright-worker.js`.
- Doi worker ready neu co the.
- Khong mo CLI.
- Tu restart server/worker neu process con bi crash va `SERVICE_AUTO_RESTART=true`.

### 3.2. Tao task

Nguoi dung co the nhap:

```text
https://shopee.vn/product/174420235/20300919760
```

Hoac nhap truc tiep:

```text
20300919760
```

CLI goi:

```http
POST /scrape
```

Payload co the la:

```json
{ "url": "https://shopee.vn/product/174420235/20300919760" }
```

Hoac:

```json
{ "itemId": "20300919760" }
```

Server tao `taskId` rieng bang UUID. `taskId` khong phai product id. Mot product id co the tao nhieu task khac nhau khi test nhieu lan.

## 4. Task lifecycle

Task di qua cac trang thai:

```text
queued -> running -> success
queued -> running -> error
```

Trong `task-store.js`, moi task co:

- `taskId`: id cua task.
- `requestUrl`: URL goc hoac item id neu nhap bang so.
- `status`: `queued`, `running`, `success`, `error`.
- `affiliateUrl`: URL affiliate da mo/call.
- `result`: JSON da parse.
- `raw`: raw response tu Shopee Affiliate.
- `error`: loi worker neu co.
- `parseError`: loi parse raw response neu co.
- `createdAt`: luc server tao task.
- `startedAt`: luc worker bat dau xu ly.
- `endedAt`: luc task ket thuc.
- `durationMs`: tong thoi gian.
- `queueMs`: thoi gian cho worker.
- `processingMs`: thoi gian worker xu ly va lay JSON.

CLI se in:

```text
- Tong thoi gian: 1.24s
- Cho worker: 120ms
- Xu ly + lay JSON: 1.12s
```

## 5. Vai tro cua server.js

`server.js` la trung tam relay:

- Nhan HTTP request tu CLI/API.
- Validate payload bang `validation.js`.
- Tao task trong `task-store.js`.
- Tim worker WebSocket dang online.
- Gui task sang worker.
- Nhan `STARTED`, `SUCCESS`, `ERROR` tu worker.
- Parse raw response thanh JSON cuoi cung.
- Luu result/raw/error vao task.
- Push update ve CLI neu CLI dang ket noi.

### 5.1. HTTP API

`GET /health`

Tra ve trang thai server:

```json
{
  "ok": true,
  "port": 8080,
  "workerClients": 1,
  "taskCount": 0
}
```

`POST /scrape`

Nhan `url` hoac `itemId`.

`GET /tasks`

Lay danh sach task.

`GET /tasks/<taskId>`

Lay chi tiet task, bao gom timing va result.

`GET /product/<itemId>`

Lay nhanh theo item id. Endpoint nay se check cache RAM truoc, tiep theo PostgreSQL, neu miss moi tao task sang worker va doi toi da `PRODUCT_REQUEST_TIMEOUT_MS`.

Query `mode`:

- `compact`: tra JSON gon dang dung cho CLI/API.
- `full`: tra JSON gon kem raw Shopee response va thong tin cache.
- `raw`: tra raw Shopee Affiliate response.

Query `refresh=1` se bo qua cache/DB va ep worker crawl lai.

`GET /products`

Lay danh sach product da luu trong PostgreSQL. Query ho tro:

- `limit`: mac dinh 50, toi da 200.
- `offset`: phan trang.
- `q`: search theo `itemId`, `productName`, `shopName`.
- `mode`: `compact`, `full`, `raw`.

`GET /products/<itemId>/history`

Lay lich su gia/commission/sales/rating tu bang `price_history`, dung cho chart tren web affiliate.

`POST /products/batch`

Lay nhieu product mot lan:

```json
{
  "itemIds": ["57458114650", "20300919760"],
  "mode": "compact",
  "refresh": false
}
```

Server se uu tien cache/DB cho tung item, item nao miss moi dua sang worker. Gioi han moi request la `PRODUCT_BATCH_LIMIT`.

`GET /session`

Tra trang thai worker/CDP/cache gan nhat: so worker dang ket noi, cache size, session da login hay dang loi.

`POST /tasks/<taskId>/cancel`

Huy task dang `queued` hoac `running`, set status ve `error` voi `errorCode = TASK_CANCELLED`.

`DELETE /tasks/<taskId>`

Xoa task khoi RAM task store.

### 5.2. WebSocket

Worker ket noi server qua:

```text
WORKER_SOCKET_URL=ws://127.0.0.1:8080
```

Worker gui:

```json
{ "type": "REGISTER_WORKER" }
```

Server danh dau socket do la worker.

Khi co task, server gui payload cho worker. Worker xu ly roi tra:

```json
{
  "type": "SUCCESS",
  "taskId": "...",
  "url": "https://affiliate.shopee.vn/offer/product_offer/20300919760",
  "data": "{...raw json...}"
}
```

## 6. Vai tro cua playwright-worker.js

`playwright-worker.js` la noi thuc su lay data tu Shopee Affiliate.

Worker lam cac viec:

1. Ket noi WebSocket server.
2. Attach Chrome CDP hoac mo persistent context.
3. Kiem tra profile da login Affiliate.
4. Dang ky voi server.
5. Nhan task.
6. Lay `itemId` tu `payload.itemId` hoac URL Shopee.
7. Thu lay data bang fast API.
8. Neu fast API fail, fallback sang mo trang Affiliate.
9. Gui raw response ve server.

### 6.1. Extract item id

Worker co the tach item id tu cac dang:

```text
https://shopee.vn/product/<shop_id>/<item_id>
https://shopee.vn/...-i.<shop_id>.<item_id>
...?item_id=<item_id>
```

Neu user nhap `itemId` truc tiep thi worker bo qua buoc parse URL.

### 6.2. Fast path

Ham `tryFetchAffiliateProductApi(page, itemId)` thu goi thang API affiliate trong session Chrome da login:

```text
GET  /api/v3/offer/product?item_id=<itemId>
POST /api/v3/offer/product
```

No chay bang `page.evaluate(fetch(...))`, nen request di trong browser context that, co cookie/session cua Chrome.

Neu API tra ve `code = 0` va `data.item_id` dung voi task thi worker tra raw response ve server ngay. Day la duong nhanh nhat.

### 6.3. Fallback goto

Neu fast path fail, worker mo:

```text
https://affiliate.shopee.vn/offer/product_offer/<itemId>
```

Sau do wait response co path:

```text
affiliate.shopee.vn/api/v3/offer/product
```

Neu thanh cong, worker lay response text va gui ve server.

Fallback nay cham hon fast path vi phai navigate page. Tuy nhien no giup cuu cac case fast API khong an.

### 6.4. Detect login/captcha/block

`browser-context.js` co cac pattern detect:

- `loading issue`
- `please try again`
- `unusual activity`
- `access denied`
- `captcha`
- `/verify/traffic`
- `anti_bot_tracking_id=`
- `scene=crawler_item`

Neu gap cac pattern nay, worker tra loi de user login/solve captcha lai bang Chrome that.

## 7. Vai tro cua browser-context.js

File nay gom cac helper cho Chrome/Playwright:

- `launchBrowserContext()`: chon CDP hoac persistent context.
- `connectToChromeOverCdp()`: connect vao `BROWSER_CDP_URL`.
- `launchPersistentBrowserContext()`: mo profile `.browser-profile`.
- `findAffiliatePageInSession()`: tim tab Affiliate dang mo.
- `waitForAffiliatePageInSession()`: cho den khi co tab Affiliate.
- `detectBlockingIssue()`: doc URL/body de phat hien captcha/block.
- `waitForAffiliatePageSettled()`: doi page on dinh theo `PAGE_SETTLE_MS`.

Trong thuc te, CDP voi Chrome that dang on dinh hon persistent context rieng.

## 8. Vai tro cua stack.js

`stack.js` giup giam so terminal phai mo.

Nhiem vu:

- Doc config.
- Kiem tra Chrome CDP.
- Neu CDP chua ready thi thu mo Chrome.
- Mo tab Affiliate neu can.
- Start server.
- Start worker.
- Doi worker ready.
- Start CLI.

Lenh thuong dung:

```bash
npm run stack
```

Van can giu cua so Chrome CDP dang login. Neu Chrome bi dong, worker se mat context.

## 8.1. Vai tro cua api-stack.js

`api-stack.js` dung khi muon chay nen, cho tool/API khac goi vao ma khong can CLI prompt.

Lenh:

```bash
npm run api
```

Khac voi `npm run stack`:

- Khong mo CLI.
- Khong tu mo tab Affiliate.
- Chay `server.js` va `playwright-worker.js`.
- Tu restart child process neu server/worker crash.
- Phu hop chay bang PM2/systemd hoac terminal nen.

Neu co PM2:

```bash
pm2 start ecosystem.config.js
pm2 logs playwright-shopee-api
pm2 restart playwright-shopee-api
```

## 9. Output JSON hien tai

Server parse raw Shopee Affiliate response thanh JSON gon:

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

Y nghia field:

- `productID`: item id Shopee.
- `price`: gia hien tai.
- `minPrice`: gia thap nhat trong cac phan loai.
- `maxPrice`: gia cao nhat trong cac phan loai.
- `sales`: field ban hien tai, uu tien `sold`.
- `totalSales`: tong da ban, uu tien `historical_sold`.
- `rating`: diem danh gia, lam tron 2 chu so.
- `imageUrl`: link anh day du.
- `shopName`: ten shop.
- `commission`: tong commission Shopee Affiliate tra ve.
- `hasExtraCommission`: co commission seller/extra khong.
- `extraCommission`: so tien commission seller/extra.
- `hasShopeeCommission`: co commission Shopee/platform khong.
- `shopeeCommission`: so tien commission Shopee/platform.
- `productLink`: link san pham Shopee.
- `productName`: ten san pham.

## 10. Logic parse tien va commission

Shopee co nhieu kieu format tien:

```text
25200
"₫25.200"
"42000000000"
```

Server xu ly bang:

- `toNumber()`: strip ky tu khong phai so.
- `normalizeMoneyValue()`: neu so qua lon thi chia `100000`.
- `normalizeCommissionFallback()`: neu commission dang la `12.75` thi doi thanh `12750`.

Commission duoc lay theo thu tu:

1. `commission_final`, `commissionFinal`, `total_commission`, `totalCommission`, `finalCommission`.
2. Tong `sellerComFinal + shopeeComFinal`.
3. Fallback `data.commission`.

Extra/Shopee commission lay theo thu tu:

- Field final neu co.
- `data.commission_rate.seller_commission`.
- `data.commission_rate.shopee_commission`.

## 10.1. PostgreSQL product store

Giai doan 1 da chot PostgreSQL lam store chinh:

```env
PRODUCT_STORE_DRIVER=postgres
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/playwright_shopee
DATABASE_SSL=false
```

Khi server start, `product-store.js` tu tao schema:

- `products`: luu product JSON moi nhat theo `item_id`, raw response, affiliate URL, source, created/updated time.
- `price_history`: append mot dong moi moi lan crawl thanh cong, dung de ve bieu do gia/commission/sold sau nay.

Luon ghi product vao PostgreSQL sau khi worker tra `SUCCESS` va server parse thanh cong. Neu PostgreSQL loi, task van success nhung log se co `product_store.upsert_failed` de debug.

Neu can dev tam khong DB, co the set:

```env
PRODUCT_STORE_DRIVER=file
```

File fallback chi de dev, khong nen dung cho web production.

## 11. Config quan trong

```env
BROWSER_CDP_URL=http://127.0.0.1:9222
PRODUCT_CACHE_TTL_MS=300000
PRODUCT_REQUEST_TIMEOUT_MS=10000
PRODUCT_BATCH_LIMIT=20
PRODUCT_STORE_DRIVER=postgres
PRODUCT_DATA_DIR=data
PRODUCT_STORE_FILE=products.json
PRODUCT_HISTORY_FILE=price-history.jsonl
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/playwright_shopee
DATABASE_SSL=false
TASK_QUEUE_TIMEOUT_MS=10000
TASK_TIMEOUT_MS=15000
LOG_MAX_BYTES=10485760
SCRAPE_TIMEOUT_MS=8000
PAGE_SETTLE_MS=120
BLOCKING_DETECT_TIMEOUT_MS=250
WORKER_WAIT_POLL_MS=500
SERVICE_AUTO_RESTART=true
SERVICE_RESTART_DELAY_MS=2000
TASK_POLL_MS=200
```

Y nghia:

- `BROWSER_CDP_URL`: Chrome that de Playwright attach vao.
- `PRODUCT_CACHE_TTL_MS`: thoi gian giu cache theo `itemId`.
- `PRODUCT_REQUEST_TIMEOUT_MS`: thoi gian endpoint `/product/:itemId` doi task hoan tat truoc khi tra `202`.
- `PRODUCT_BATCH_LIMIT`: so product toi da cho `POST /products/batch`.
- `PRODUCT_STORE_DRIVER`: `postgres` cho production, `file` cho dev tam.
- `PRODUCT_DATA_DIR`, `PRODUCT_STORE_FILE`, `PRODUCT_HISTORY_FILE`: file fallback khi `PRODUCT_STORE_DRIVER=file`.
- `DATABASE_URL`: PostgreSQL connection string.
- `DATABASE_SSL`: bat SSL khi ket noi database hosted.
- `TASK_QUEUE_TIMEOUT_MS`: queued qua moc nay se thanh error.
- `TASK_TIMEOUT_MS`: running qua moc nay se thanh error.
- `LOG_MAX_BYTES`: dung luong toi da cua `logs/tasks.jsonl` truoc khi rotate sang `.1`.
- `SCRAPE_TIMEOUT_MS`: timeout lay data/fallback.
- `PAGE_SETTLE_MS`: thoi gian doi page on dinh sau navigate.
- `BLOCKING_DETECT_TIMEOUT_MS`: timeout doc body de detect captcha/block.
- `WORKER_WAIT_POLL_MS`: khoang retry worker/socket.
- `SERVICE_AUTO_RESTART`: `npm run api` co tu restart child process khong.
- `SERVICE_RESTART_DELAY_MS`: thoi gian doi truoc khi restart child process.
- `TASK_POLL_MS`: CLI poll task nhanh/cham.

Muon nhanh hon co the giam:

```env
TASK_POLL_MS=100
PAGE_SETTLE_MS=50
BLOCKING_DETECT_TIMEOUT_MS=150
```

Gia tri cang thap thi phan hoi nhanh hon, nhung de false negative khi detect block/captcha hon.

## 12. Cac loi hay gap

### Task dung o queued

Nguyen nhan thuong gap:

- Worker chua ket noi.
- Worker dang chay code cu, can restart `npm run stack`.
- Worker socket loi.
- Server da queue task nhung worker khong nhan duoc payload.

Kiem tra:

```bash
curl http://localhost:8080/health
```

Neu `workerClients` bang `0`, can restart stack/worker.

### Task dung o running

Nguyen nhan:

- Shopee API cham.
- Fallback goto bi treo.
- Session Chrome bi mat login.
- Captcha/loading issue.

Xem log:

```bash
tail -f logs/tasks.jsonl
```

### Loi captcha/loading issue

Can quay lai Chrome CDP:

1. Mo `https://shopee.vn`.
2. Dang nhap va xu ly captcha.
3. Mo `https://affiliate.shopee.vn/dashboard`.
4. Cho dashboard on dinh.
5. Restart `npm run stack`.

### connect ECONNREFUSED 127.0.0.1:9222

Chrome CDP chua chay hoac sai port.

Chay lai:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/shopee-cdp-profile
```

## 13. Huong phat trien tiep theo

### 13.1. Quan sat toc do ro hon

Hien tai worker da co cac log:

- `worker.fast_api_hit`
- `worker.fast_api_fallback`
- `worker.fallback_goto`

Moi log co cac field timing:

- `apiFetchMs`: thoi gian thu fast API.
- `gotoMs`: thoi gian fallback goto va cho API response.
- `attempts`: danh sach GET/POST fast API da thu, status va thoi gian moi lan.

Muc tieu la biet request cham do API, do fallback, do server parse, hay do CLI poll. Server cung log `parseMs` trong event `task.succeeded`.

### 13.2. Cache item id

Hien tai server da co cache RAM theo `itemId`:

```text
itemId -> result + raw + cachedAt
```

TTL goi y:

- 1 phut neu can data gan real-time.
- 5-10 phut neu uu tien toc do.

Neu cache hit, `POST /scrape` va `GET /product/:itemId` tra ket qua gan nhu tuc thi, khong gui task sang worker.

### 13.3. Timeout chong ket

Hien tai da co auto timeout cho task:

- `TASK_QUEUE_TIMEOUT_MS`: neu `queued` qua moc nay thi task thanh `error`.
- `TASK_TIMEOUT_MS`: neu `running` qua moc nay thi task thanh `error`.

Server cung bo qua ket qua worker tra ve muon sau khi task da timeout, tranh viec task bi lat lai tu `error` sang `success`.

### 13.4. Endpoint nhanh hon

Endpoint da co:

```http
GET /product/:itemId
```

Cho tool khac goi gon hon:

```bash
curl http://localhost:8080/product/20300919760
```

### 13.5. Output mode

Endpoint `/product/:itemId` ho tro query:

```http
GET /product/20300919760?mode=compact
```

Mode goi y:

- `compact`: JSON gon hien tai.
- `full`: JSON gon kem `raw` va thong tin cache.
- `raw`: tra raw response Shopee Affiliate.

### 13.6. Session health check

Endpoint da co:

```http
GET /session
```

Tra:

```json
{
  "chromeCdpReady": true,
  "workerReady": true,
  "affiliateLoggedIn": true,
  "currentUrl": "https://affiliate.shopee.vn/dashboard"
}
```

Nhu vay UI/API goi ngoai biet khi nao can user vao Chrome xu ly captcha.

### 13.7. Chay nen

Hien tai da co:

- `npm run api`: chi chay server + worker, khong mo CLI.
- `ecosystem.config.js`: PM2 config mau.
- Log rotation 1 file: khi `logs/tasks.jsonl` qua `LOG_MAX_BYTES`, file cu duoc doi thanh `logs/tasks.jsonl.1`.
- Auto restart child process trong `api-stack.js` khi server/worker crash.

Lenh PM2 goi y:

```bash
pm2 start ecosystem.config.js
pm2 logs playwright-shopee-api
pm2 restart playwright-shopee-api
```

## 14. Nguyen tac khi sua source

- Uu tien `itemId` truc tiep vi nhanh va it loi hon URL.
- Giu fast path truoc, fallback goto sau.
- Khong tu dong bypass captcha. Captcha xu ly bang tay trong Chrome CDP.
- Khi sua parser, giu raw response trong task de debug.
- Khi them field JSON, ghi ro field lay tu raw key nao.
- Khi toi uu toc do, do bang `durationMs`, `queueMs`, `processingMs`.

# Playwright Shopee

Ban nay la huong di song song voi `extension-shopee`, nhung thay worker Chrome Extension bang
**Playwright + persistent Chrome profile**.

## Muc tieu

- Giu session affiliate tren 1 browser profile co dinh
- Crawl bang browser that, khong can MV3 extension
- Tiep tuc dung lai `server`, `task-store`, `cli`, `HTTP API`

## Cau truc

- `server.js`: HTTP + WebSocket relay
- `playwright-worker.js`: worker nhan task va mo Playwright
- `worker-login.js`: mo profile de login thu cong
- `cli.js`: prompt `>` de paste link Shopee

Tai lieu source chi tiet:

- `docs/source-guide.md`: kien truc, logic xu ly, parser JSON, timing, loi hay gap, phuong an phat trien.

## Cai dat

```bash
cd /home/thanhhuy/dev/crawler/playwright-shopee
npm install
cp .env.example .env
```

## PostgreSQL

Giai doan 1 dung PostgreSQL de luu product/raw/history. Tao database local:

```bash
createdb playwright_shopee
```

Hoac neu dung user/password rieng, sua trong `.env`:

```bash
PRODUCT_STORE_DRIVER=postgres
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/playwright_shopee
DATABASE_SSL=false
```

Khi `npm run api` hoac `npm run stack`, server se tu tao bang:

- `products`: product JSON moi nhat theo `itemId`.
- `price_history`: lich su gia/commission moi lan crawl thanh cong.

## Config quan trong

```bash
PORT=8080
LOG_DIR=logs
TASK_LOG_FILE=tasks.jsonl
LOG_MAX_BYTES=10485760
TASK_RETENTION_MS=1800000
TASK_QUEUE_TIMEOUT_MS=10000
TASK_TIMEOUT_MS=15000
PRODUCT_CACHE_TTL_MS=300000
PRODUCT_REQUEST_TIMEOUT_MS=10000
PRODUCT_BATCH_LIMIT=20
PRODUCT_STORE_DRIVER=postgres
PRODUCT_DATA_DIR=data
PRODUCT_STORE_FILE=products.json
PRODUCT_HISTORY_FILE=price-history.jsonl
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/playwright_shopee
DATABASE_SSL=false
WORKER_WAIT_TIMEOUT_MS=30000
WORKER_WAIT_POLL_MS=500
SERVICE_AUTO_RESTART=true
SERVICE_RESTART_DELAY_MS=2000
TASK_POLL_MS=200
WORKER_SOCKET_URL=ws://127.0.0.1:8080
BROWSER_PROFILE_DIR=.browser-profile
BROWSER_CDP_URL=http://127.0.0.1:9222
BROWSER_CHANNEL=chrome
BROWSER_EXECUTABLE_PATH=
HEADLESS=false
SCRAPE_TIMEOUT_MS=8000
PAGE_SETTLE_MS=120
BLOCKING_DETECT_TIMEOUT_MS=250
AFFILIATE_BASE_URL=https://affiliate.shopee.vn
```

Neu ban dung Chrome system binh thuong thi giu:

```bash
BROWSER_CHANNEL=chrome
```

Neu can binary rieng thi set:

```bash
BROWSER_EXECUTABLE_PATH=/path/to/chrome
```

Neu Shopee thuong chuyen sang `verify/traffic` hoac `verify/captcha`, uu tien attach vao Chrome that qua CDP:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/shopee-cdp-profile
```

Sau do set:

```bash
BROWSER_CDP_URL=http://127.0.0.1:9222
```

---

# Chay lan dau

Nen dung Chrome that qua CDP de giam loi captcha/loading issue.

## 1. Mo Chrome CDP

Mo terminal rieng va chay:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/shopee-cdp-profile
```

Giu terminal nay dang chay. Chrome mo ra tu lenh nay se dung profile rieng tai:

## 2. Dang nhap profile Chrome

Trong cua so Chrome vua mo:

- Dang nhap tai khoan Google/Chrome profile neu can.
- Khong dung Chrome profile dang mo san o cua so khac.
- Sau khi dang nhap xong, giu nguyen cua so Chrome nay.

## 3. Dang nhap Shopee truoc

Trong cung cua so Chrome do, mo:

```text
https://shopee.vn
```

Sau do:

- Dang nhap tai khoan Shopee.
- Neu co captcha hoac verify thi xu ly bang tay.
- Cho den khi vao Shopee binh thuong, khong con bi day ve trang captcha/loading issue.

Buoc nay rat quan trong vi Shopee hay chan neu vao Affiliate ngay khi session Shopee chua on dinh.

## 4. Dang nhap Shopee Affiliate

Sau khi Shopee da on dinh, mo tiep:

```text
https://affiliate.shopee.vn/dashboard
```

Sau do:

- Dang nhap tai khoan Affiliate neu duoc yeu cau.
- Xu ly captcha neu co.
- Cho dashboard dung yen vai phut, khong bi da lai ve login/captcha/loading issue thi nhan `Ctrl+C`.

## 5. Kiem tra Playwright attach vao Chrome

Trong file `.env`, can co:

```bash
BROWSER_CDP_URL=http://127.0.0.1:9222
```

Sau khi Chrome da login Shopee va Affiliate xong, co the chay:

```bash
npm run login
```

Lenh nay chi dung de kiem tra profile da san sang. Neu da vao duoc dashboard Affiliate thi nhan `Ctrl+C`.

Neu dung CDP thi session se nam trong profile Chrome:

---

# Chay he thong

```bash
npm run stack
```

Lenh nay se tu dong:

- Khoi dong HTTP server
- Khoi dong Playwright worker
- Cho worker san sang
- Mo CLI

Sau do paste link Shopee hoac item id:

```text
https://shopee.vn/product/344837665/57458114650
```

hoac

```text
57458114650
```

Neu muon chay API nen, khong mo CLI:

```bash
npm run api
```

Lenh nay se:

- Kiem tra/mo Chrome CDP neu `BROWSER_CDP_URL` duoc set.
- Khoi dong HTTP server.
- Khoi dong Playwright worker.
- Tu restart server/worker neu process bi crash.
- Khong mo prompt CLI, phu hop de tool khac goi HTTP API.

Neu co PM2:

```bash
pm2 start ecosystem.config.js
pm2 logs playwright-shopee-api
pm2 restart playwright-shopee-api
```

---

# HTTP API

Theo link:

```bash
curl -X POST http://localhost:8080/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://shopee.vn/product/344837665/57458114650"}'
```

Theo item id:

```bash
curl -X POST http://localhost:8080/scrape \
  -H "Content-Type: application/json" \
  -d '{"itemId":"57458114650"}'
```

Lay danh sach task:

```bash
curl http://localhost:8080/tasks
```

Lay chi tiet task:

```bash
curl http://localhost:8080/tasks/<task-id>
```

Lay nhanh theo item id, co cache:

```bash
curl "http://localhost:8080/product/57458114650"
```

Ep crawl lai, bo qua cache/DB:

```bash
curl "http://localhost:8080/product/57458114650?refresh=1"
```

Chon format ket qua:

```bash
curl "http://localhost:8080/product/57458114650?mode=compact"
curl "http://localhost:8080/product/57458114650?mode=full"
curl "http://localhost:8080/product/57458114650?mode=raw"
```

Lay danh sach product da luu trong PostgreSQL:

```bash
curl "http://localhost:8080/products?limit=20&offset=0"
```

Lay lich su gia/commission:

```bash
curl "http://localhost:8080/products/57458114650/history?limit=100"
```

Lay nhieu product mot lan:

```bash
curl -X POST http://localhost:8080/products/batch \
  -H "Content-Type: application/json" \
  -d '{"itemIds":["57458114650","20300919760"],"mode":"compact"}'
```

Kiem tra session worker/CDP/cache:

```bash
curl http://localhost:8080/session
```

Huy task dang queued/running:

```bash
curl -X POST http://localhost:8080/tasks/<task-id>/cancel
```

Xoa task khoi RAM:

```bash
curl -X DELETE http://localhost:8080/tasks/<task-id>
```

---

# CLI commands

- `health`
- `tasks`
- `tasks success`
- `status <taskId>`
- `exit`

---

# Ghi chu

- Chi can chay `npm run login` khi:
  - Chua tung dang nhap.
  - Session Affiliate het han.

- Su dung hang ngay chi can:

```bash
npm run stack
```

- Worker van su dung session Affiliate that.
- Neu session het han, worker se bao loi login va chi can chay lai:

```bash
npm run login
```

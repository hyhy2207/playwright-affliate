# Playwright Shopee

Ban nay la huong di song song voi `extension-shopee`, nhung thay worker Chrome Extension bang
**Playwright + persistent Chrome profile**.

## Muc tieu

- Giu session affiliate tren 1 browser profile co dinh
- Crawl bang browser that, khong can MV3 extension
- Tiep tuc dung lai `server`, `task-store`, `HTTP API`

## Cau truc

- `server.js`: HTTP + WebSocket relay
- `playwright-worker.js`: worker nhan task va mo Playwright
- `worker-login.js`: mo profile de login thu cong
- `profile-launcher.js`: cho chon profile truoc khi chay `login` / `stack` / `api` / `worker`
- `profile-manager.js`: luu danh sach profile va profile mac dinh
- `providers/shopee/`: gom logic dac thu Shopee de sau nay tach them provider khac de hon
- `http-utils.js`: helper cho HTTP response/request body
- `task-presenter.js`: chuan hoa task response cho API

Tai lieu source chi tiet:

- `docs/source-guide.md`: kien truc, logic xu ly, parser JSON, timing, loi hay gap, phuong an phat trien.

## Cai dat

```bash
cd /home/thanhhuy/dev/crawler/playwright-shopee
npm install
cp .env.example .env
```

## Store va cache mac dinh

Ban nay mac dinh khong dung product store DB va khong giu cache RAM product. Moi request product se di qua worker de lay du lieu moi tu Shopee.

```bash
PRODUCT_STORE_DRIVER=none
PRODUCT_CACHE_TTL_MS=0
```

Neu can luu product/raw/history de debug hoac nghien cuu, ban co the bat file store local:

```bash
PRODUCT_STORE_DRIVER=file
```

## Config quan trong

```bash
PORT=8080
LOG_DIR=logs
TASK_LOG_FILE=tasks.jsonl
LOG_MAX_BYTES=10485760
TASK_RETENTION_MS=1800000
TASK_QUEUE_TIMEOUT_MS=10000
TASK_TIMEOUT_MS=15000
TASK_MAX_RETRIES=2
TASK_RETRY_DELAY_MS=1500
TASK_HISTORY_PER_ITEM_LIMIT=3
PRODUCT_CACHE_TTL_MS=0
PRODUCT_REQUEST_TIMEOUT_MS=10000
PRODUCT_BATCH_LIMIT=20
PRODUCT_STORE_DRIVER=none
PRODUCT_DATA_DIR=data
PRODUCT_STORE_FILE=products.json
PRODUCT_HISTORY_FILE=price-history.jsonl
WORKER_WAIT_TIMEOUT_MS=30000
WORKER_WAIT_POLL_MS=500
SERVICE_AUTO_RESTART=true
SERVICE_RESTART_DELAY_MS=2000
TASK_POLL_MS=200
WORKER_SOCKET_URL=ws://127.0.0.1:8080
QUEUE_DRIVER=memory
QUEUE_DRIVER_FALLBACK=memory
QUEUE_NAME=shopee-task-queue
QUEUE_PREFIX=playwright-shopee
QUEUE_DISPATCH_CONCURRENCY=1
REDIS_URL=redis://127.0.0.1:6379/0
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
PROFILE_WARMUP_KEYWORDS=ao,quan,giay
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
google-chrome --remote-debugging-port=<PORT_CUA_PROFILE> --user-data-dir=<THU_MUC_PROFILE>
```

Sau do set:

```bash
BROWSER_CDP_URL=http://127.0.0.1:<PORT_CUA_PROFILE>
```

Vi du voi profile `thanhhuy2` dang dung port `9223`:

```bash
google-chrome --remote-debugging-port=9223 --user-data-dir=.profiles/thanhhuy2
```

## Quan ly nhieu profile

He thong hien tai se luu profile da dang nhap theo tung thu muc rieng trong `.profiles/`.

- Profile cu `.browser-profile` neu co se duoc migrate sang `.profiles/default` o lan chay dau tien.
- Moi profile moi se co `BROWSER_PROFILE_DIR` rieng.
- Neu dang dung `BROWSER_CDP_URL`, moi profile moi se duoc cap 1 CDP port rieng, bat dau tu port trong `.env` (vi du `9222`, `9223`, `9224`...).
- Khi profile bi Shopee chan trong luc crawl, he thong se dua profile do vao cooldown trong `PROFILE_COOLDOWN_MS` va thu doi sang profile khac con san sang.

## On dinh va tu phuc hoi

He thong hien tai co them cac co che:

- `task-queue.js` la queue factory, co the chay bang `memory` hoac `bullmq`.
- `task-queue-memory.js` giu co che queue trong process nhu hien tai.
- `task-queue-bullmq.js` cho phep dua queue len Redis/BullMQ ma khong doi API ben ngoai.
- Khi dung `bullmq`, Redis se giu pending/delayed jobs that su; khong can `tasks-pending.json` de khoi phuc job nua.
- File store local co the giu `task_history` de phuc hoi metadata task active khi server restart khi ban bat `PRODUCT_STORE_DRIVER=file`.
- `task_history` se tu dong prune bot cac ban ghi `success/error` cu theo tung `itemId`; mac dinh giu lai `TASK_HISTORY_PER_ITEM_LIMIT=3` ban ghi moi nhat moi san pham de tranh phinh bang khi cung mot SP bi goi bang URL va `itemId`.
- Retry task tu dong cho loi tam thoi nhu `WORKER_ERROR`, `CDP_DISCONNECTED`.
- Giam toc theo profile bang `PROFILE_MIN_TASK_GAP_MS` de tranh ban request qua sat.
- Auto-switch profile khi dang crawl ma Shopee tra `captcha/loading issue/block`.
- Warm-up sau hon cho profile moi qua `shopee.vn`, `mall`, `search` truoc khi vao Affiliate neu `PROFILE_WARMUP_DEEP_ENABLED=true`.
- Co the doi keyword warm-up qua `PROFILE_WARMUP_KEYWORDS` trong `.env`, vi du `ao,quan,giay,the thao`.
- Neu worker mat ket noi luc dang xu ly, cac task chua xong se duoc dua lai vao queue de cho worker ket noi lai.

Neu muon bat dau chuyen sang BullMQ:

```bash
QUEUE_DRIVER=bullmq
REDIS_URL=redis://127.0.0.1:6379/0
QUEUE_NAME=shopee-task-queue
QUEUE_PREFIX=playwright-shopee
QUEUE_DISPATCH_CONCURRENCY=1
```

Luu y:

- `memory` van la mode mac dinh de an toan.
- `bullmq` can `bullmq` + `ioredis` trong `package.json` va Redis dang chay.
- Neu `QUEUE_DRIVER=bullmq` nhung Redis/chuoi ket noi chua san sang, he thong co the roi ve `QUEUE_DRIVER_FALLBACK=memory`.
- Product store local chi lo phan luu product/history/task data khi can, khong thay the vai tro cua Redis queue.

Luu y:

- `SESSION_STATUS` chi duoc phat khi task dang crawl ma bi Shopee chan.
- Auto-switch se bo qua profile dang cooldown hoac bi disable.
- Task crawl co the thay `retryCount`, `maxRetries`, `nextAttemptAt` trong API `/tasks/:taskId`.

Co 3 cach chon profile:

```bash
npm run profiles
npm run login
npm run stack
```

Co the xoa profile bang menu:

```bash
npm run profiles
```

Hoac xoa thang theo ten:

```bash
npm run profiles -- --delete-profile=seller-a
```

Quan ly profile bang HTTP API:

```bash
curl http://127.0.0.1:8080/profiles
curl -X POST http://127.0.0.1:8080/profiles/thanhhuy/recover
curl -X POST http://127.0.0.1:8080/profiles/thanhhuy/default
curl -X POST http://127.0.0.1:8080/profiles/thanhhuy/disable
curl -X POST http://127.0.0.1:8080/profiles/thanhhuy/enable
curl -X POST http://127.0.0.1:8080/profiles/thanhhuy/cooldown -H "Content-Type: application/json" -d '{"durationMs":600000}'
```

HTTP API da duoc chuan hoa response de frontend de dung hon:

- Thanh cong: luon co `ok: true`, `data`, va co the co them `meta`.
- Loi: luon co `ok: false`, `error.code`, `error.message`, `error.details`.
- De giu tuong thich nguoc, cac field cu nhu `task`, `tasks`, `profiles`, `type`, `message` van duoc giu o top-level.

Toi uu hien tai:

- `GET /product/:itemId?stale=1`: neu DB da co ban ghi cu, API co the tra ngay du lieu store hit va tu revalidate nen.
- `POST /products/batch` ho tro `{"stale": true}` hoac `?stale=1` voi y nghia tuong tu.
- `server.js` da duoc doi sang provider facade (`providers/shopee/index.js`) de giam coupling vao parser/normalizer Shopee.

Vi du:

```json
{
  "ok": true,
  "data": {
    "task": {
      "taskId": "abc",
      "status": "queued"
    }
  },
  "task": {
    "taskId": "abc",
    "status": "queued"
  },
  "meta": {
    "endpoint": "/scrape"
  }
}
```

```json
{
  "ok": false,
  "error": {
    "code": "ERROR",
    "message": "Khong tim thay task",
    "details": {
      "taskId": "abc"
    }
  },
  "message": "Khong tim thay task",
  "errorCode": "ERROR",
  "taskId": "abc"
}
```

Hoac chon thang theo ten:

```bash
npm run login -- --profile=seller-a
npm run stack -- --profile=seller-a
npm run api -- --profile=seller-a
```

---

# Chay lan dau

Nen dung Chrome that qua CDP de giam loi captcha/loading issue.

## 1. Chon profile

Neu muon tao hoac doi profile truoc khi login:

```bash
npm run profiles
```

Hoac chay thang lenh login/stack, script se hoi profile truoc khi mo.

## Lưu ý quan trọng tránh bị khóa acc (quan trọng quan trọng cực quan trọng):

- Sau khi tạo profile mới, uu tien dang nhap Shopee truoc va xu ly captcha cho on dinh.
- Khi chay `npm run stack`, neu Shopee bi day ve captcha/verify thi cu xu ly bang tay tren tab Shopee; khi Shopee da vao binh thuong thi nhan `Enter` de tool mo tiep trang Affiliate.

## 2. Mo Chrome CDP

Mo terminal rieng va chay:

```bash
google-chrome --remote-debugging-port=<PORT_CUA_PROFILE> --user-data-dir=<THU_MUC_PROFILE>
```

Vi du neu profile dang chon la `thanhhuy2` va duoc gan port `9223`:

```bash
google-chrome --remote-debugging-port=9223 --user-data-dir=.profiles/thanhhuy2
```

Giu terminal nay dang chay. Chrome mo ra tu lenh nay se dung profile rieng tai thu muc da chon.

Neu ban chay `npm run login` hoac `npm run stack` sau khi chon profile, tool cung co the tu thu mo Chrome CDP voi dung port/profile cua profile do.
Neu `npm run stack` mo Shopee va gap captcha, tool se dung lai de ban xu ly bang tay. Sau khi Shopee on dinh, nhan `Enter` de tool mo tiep tab Affiliate va start worker.

## 3. Dang nhap profile Chrome

Trong cua so Chrome vua mo:

- Dang nhap tai khoan Google/Chrome profile neu can.
- Khong dung Chrome profile dang mo san o cua so khac.
- Sau khi dang nhap xong, giu nguyen cua so Chrome nay.

## 4. Dang nhap Shopee truoc

Trong cung cua so Chrome do, mo:

```text
https://shopee.vn
```

Sau do:

- Dang nhap tai khoan Shopee.
- Neu co captcha hoac verify thi xu ly bang tay.
- Cho den khi vao Shopee binh thuong, khong con bi day ve trang captcha/loading issue.

Buoc nay rat quan trong vi Shopee hay chan neu vao Affiliate ngay khi session Shopee chua on dinh.

## 5. Dang nhap Shopee Affiliate

Sau khi Shopee da on dinh, tool se mo tiep:

```text
https://affiliate.shopee.vn/dashboard
```

Sau do:

- Dang nhap tai khoan Affiliate neu duoc yeu cau.
- Xu ly captcha neu co.
- Cho dashboard dung yen vai phut, khong bi da lai ve login/captcha/loading issue thi nhan `Ctrl+C`.

## 6. Kiem tra Playwright attach vao Chrome

Trong file `.env`, can co:

```bash
BROWSER_CDP_URL=http://127.0.0.1:9222
```

Gia tri trong `.env` la port goc. Profile dau tien thuong dung `9222`, profile tiep theo co the la `9223`, `9224`... Script se tu doi sang port cua profile dang chon khi chay qua `npm run login`, `npm run stack`, `npm run api`.

## Xoa profile

Xoa bang menu:

```bash
npm run profiles
```

Trong menu, nhan `D` de chon profile can xoa.

Xoa thang bang command:

```bash
npm run profiles -- --delete-profile=thanhhuy2
```

Luu y:

- Lenh xoa se xoa ca thu muc du lieu cua profile trong `.profiles/`.
- Khong the xoa profile cuoi cung.
- Neu xoa profile mac dinh, he thong se tu chon profile con lai dau tien lam mac dinh moi.
- He thong moi se luu profile tap trung trong `.profiles/`.

Sau khi Chrome da login Shopee va Affiliate xong, co the chay:

```bash
npm run login
```

Neu muon login vao profile cu the:

```bash
npm run login -- --profile=seller-a
```

Lenh nay chi dung de kiem tra profile da san sang. Neu da vao duoc dashboard Affiliate thi nhan `Ctrl+C`.

Neu dung CDP thi session se nam trong profile Chrome:

---

# Chay he thong

```bash
npm run stack
```

Neu muon crawl bang profile cu the:

```bash
npm run stack -- --profile=seller-a
```

Lenh nay se tu dong:

- Khoi dong HTTP server
- Khoi dong Playwright worker
- Cho worker san sang

Neu muon chay API nen:

```bash
npm run api
```

Neu muon chay API voi profile cu the:

```bash
npm run api -- --profile=seller-a
```

Lenh nay se:

- Kiem tra/mo Chrome CDP neu `BROWSER_CDP_URL` duoc set.
- Khoi dong HTTP server.
- Khoi dong Playwright worker.
- Tu restart server/worker neu process bi crash.
- Phu hop de tool khac goi HTTP API.

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

Lay nhanh theo item id. Mac dinh van crawl moi qua worker vi cache/store dang tat:

```bash
curl "http://localhost:8080/product/57458114650"
```

Neu sau nay ban bat lai cache/store, co the ep crawl lai bang `refresh=1`:

```bash
curl "http://localhost:8080/product/57458114650?refresh=1"
```

Chon format ket qua:

```bash
curl "http://localhost:8080/product/57458114650?mode=compact"
curl "http://localhost:8080/product/57458114650?mode=full"
curl "http://localhost:8080/product/57458114650?mode=raw"
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

Kiem tra queue driver va task dang cho:

```bash
curl http://localhost:8080/queue
```

Huy task dang queued/running:

```bash
curl -X POST http://localhost:8080/tasks/<task-id>/cancel
```

Xoa task khoi RAM:

```bash
curl -X DELETE http://localhost:8080/tasks/<task-id>
```

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

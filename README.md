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

## Cai dat

```bash
cd /home/thanhhuy/dev/crawler/playwright-shopee
npm install
cp .env.example .env
```

## Config quan trong

```bash
PORT=8080
LOG_DIR=logs
TASK_LOG_FILE=tasks.jsonl
TASK_RETENTION_MS=1800000
WORKER_WAIT_TIMEOUT_MS=30000
WORKER_WAIT_POLL_MS=500
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

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
WORKER_SOCKET_URL=ws://127.0.0.1:8080
BROWSER_PROFILE_DIR=.browser-profile
BROWSER_CDP_URL=
BROWSER_CHANNEL=chrome
HEADLESS=false
SCRAPE_TIMEOUT_MS=20000
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

Dang nhap Affiliate:

```bash
npm run login
```

Browser se mo `affiliate.shopee.vn`.

- Dang nhap tai khoan Affiliate.
- Neu co captcha thi giai captcha.
- Khi da vao dashboard, nhan `Ctrl+C`.

Session se duoc luu trong:

```
.browser-profile/
```

Neu dung CDP thi session se nam trong profile Chrome dang attach.

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

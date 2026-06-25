# 上線部署（mc + Cloudflare Tunnel）

週末上線 runbook。拓樸＝**單一網域、同源**：前端、relay、OAuth 全跑在 `mc` 的 localhost，
Cloudflare Tunnel 對外撥出、終結 TLS、按 path 反代進來。**不需公網 IP／開 port／憑證**。

```
瀏覽器 ──HTTPS/WSS──> Cloudflare edge ──tunnel──> mc(localhost)
   https://DOMAIN/            →  :8080  靜態 (client/dist)
   https://DOMAIN/auth/*      →  :8770  OAuth 登入/回呼
   wss://DOMAIN/ws            →  :8765  lockstep relay
```

`mc` 三個服務由**一個指令** `serve.py` 全部起來（static + ws + auth）。

---

## 1. 註冊 OAuth app（一次性，task #5）

兩家後台各建一個 OAuth app，**redirect URI 填正式網域**：

- **Discord** → Developer Portal → New Application → OAuth2 → Redirects
  `https://DOMAIN/auth/callback/discord` → 複製 Client ID / Client Secret。
- **Google** → Cloud Console → APIs & Services → Credentials → OAuth client ID（Web）
  → Authorized redirect URI `https://DOMAIN/auth/callback/google`；OAuth consent screen
  設好、把自己加進 Test users → 複製 Client ID / Secret。

> dev 想本機測就再各加一條 `http://localhost:8770/auth/callback/{discord,google}`。

## 2. 建前端（prod env）

在 repo 根目錄：

```bash
VITE_WS_URL=/ws VITE_AUTH_BASE= VITE_OAUTH_ENABLED=1 npm run build   # → client/dist/
```

- `VITE_WS_URL=/ws` → 瀏覽器連 `wss://DOMAIN/ws`（Cloudflare 不 proxy :8765）。
- `VITE_AUTH_BASE=`（空）→ 登入走同源 `/auth/...`。
- `VITE_OAUTH_ENABLED=1` → **顯示登入按鈕**。預設關閉（apps 還沒註冊前藏起來）；
  步驟 1 的 app 註冊＋步驟 3 的 creds 都就緒後才開。想先上線、暫不開登入就**省略這個**。

## 3. 在 mc 跑伺服器（一個指令，task #9）

`git checkout` 到要上的 commit、`npm run build`（步驟 2）後：

```bash
CHOCCUS_AUTH_SECRET='<隨機長字串>' \
CHOCCUS_AUTH_BASE='https://DOMAIN' \
CHOCCUS_APP_ORIGIN='https://DOMAIN' \
DISCORD_CLIENT_ID='...' DISCORD_CLIENT_SECRET='...' \
GOOGLE_CLIENT_ID='...' GOOGLE_CLIENT_SECRET='...' \
CHOCCUS_RATINGS_DB='/home/<user>/choccus-ratings.db' \
server/.venv/bin/python server/serve.py
```

起來會印三行：static `:8080`、auth `:8770`（providers: discord, google）、relay `:8765`。
**`CHOCCUS_AUTH_SECRET` 一定要設**（不設＝用不安全 dev 預設，會印 `[INSECURE ...]`）。
用 systemd / `tmux` / `nohup` 常駐。

## 4. Cloudflare Tunnel（task #8）

mc 上裝 `cloudflared`，登入後建 tunnel，DNS 把 `DOMAIN` 指到該 tunnel。
`~/.cloudflared/config.yml` ingress **順序重要**（先 /auth、/ws，最後 catch-all static）：

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/<user>/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: DOMAIN
    path: ^/auth/.*
    service: http://localhost:8770
  - hostname: DOMAIN
    path: ^/ws$
    service: http://localhost:8765      # cloudflared 自動處理 WebSocket upgrade
  - hostname: DOMAIN
    service: http://localhost:8080      # 其餘 → 靜態前端
  - service: http_status:404
```

`cloudflared tunnel run <name>`（或裝成 service）。TLS 由 Cloudflare edge 處理，mc 端純 HTTP。

## 5. 驗收

1. `https://DOMAIN/` → 大廳出現。
2. 點 **Discord 登入 / Google 登入** → 跳轉 → 回來顯示「已登入：<名字>」。
3. **Create Room** + 開第二分頁 Quick Match → 兩人同房、Ready → 對戰（確認 `wss://DOMAIN/ws` 有連上、無 desync）。
4. 打完一場 → 回大廳看 **🏆 天梯** 有資料（含 bot）。
5. 大廳掛 ~2 分鐘不動 → 仍連著（server ping 保活，task #7）。

---

## 備忘

- **離線可玩**：`🍫 開房間 (vs Bot)` 完全在瀏覽器跑、不碰 relay/auth，所以就算後端掛了也能單機練。
- **無 relay 的純靜態部署**（GitHub Pages）：設 `VITE_DEFAULT_MODE=solo` build，落地直接進單機（線上/天梯/登入都不會有）。
- mc 的 host / ssh alias / 路徑見 `CLAUDE.local.md`。
- 之後要 rotate `CHOCCUS_AUTH_SECRET` 會讓所有已發 session token 失效（使用者需重登）—— 正常。

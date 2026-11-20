# 幸運 777 老虎機（Lucky 777 Slots）

一款**零依賴、無建置步驟**的輕量級 HTML5 老虎機演示遊戲，附完整 SEO / GEO 優化，可直接部署到任意靜態託管平台。

**正式環境**：https://vip-4.github.io/lucky-777-slots/ （GitHub Pages，已上線）

### 以 Maton 自動部署

`scripts/deploy_maton.ps1` 會透過 Maton 的 GitHub 連線自動建立 repo、逐一上傳檔案並啟用 GitHub Pages：

```powershell
$env:MATON_API_KEY='你的_Maton_金鑰'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy_maton.ps1
```

- 金鑰**只從環境變數讀取**，不會寫入指令碼或 repo。
- 部署流程：建立 `vip-4/lucky-777-slots` → 上傳 15 個檔案 → 啟用 Pages（legacy / `main`）。
- 若 repo 已存在會直接更新檔案（自動帶入 sha），可重複執行。

## 目錄結構

```
.
├── index.html               # 語意化首頁 + SEO meta + JSON-LD 結構化資料
├── assets/
│   ├── css/style.css        # 響應式樣式、無障礙、reduced-motion
│   ├── js/game.js           # 遊戲 FSM、Canvas 渲染、粒子池、Web Audio
│   ├── favicon.svg
│   └── og-image.jpg         # 1200×630社群分享圖
├── manifest.webmanifest     # PWA manifest
├── robots.txt               # 允許一般與 AI 爬蟲
├── sitemap.xml
├── llms.txt                 # GEO：給LLM讀取的站點摘要
├── netlify.toml             # Netlify 標頭設定
├── vercel.json              # Vercel 標頭設定
├── _headers                 # Cloudflare Pages 標頭設定
└── .nojekyll                # 讓 GitHub Pages 不忽略底線開頭檔案
```

## 本機運行

```bash
# 直接雙擊 index.html，或啟動任何靜態伺服器：
npx serve .
# 或
python -m http.server 8080
```

## 部署

上線前**務必**把以下檔案中的 `https://vip-4.github.io/lucky-777-slots` 換成你的正式網域：

- `index.html`（canonical、og:url、og:image、JSON-LD @id）
- `sitemap.xml`
- `robots.txt`
- `llms.txt`

平台選擇：

| 平台 | 設定檔 | 備註 |
| --- | --- | --- |
| Netlify | `netlify.toml` | 直接拖曳整個資料夾即可 |
| Cloudflare Pages | `_headers` | 建置指令留空，輸出目錄為根目錄 |
| Vercel | `vercel.json` | Framework 選 Other |
| GitHub Pages | `.github/workflows/deploy-pages.yml` | Settings → Pages → Source 選 **GitHub Actions**，推到 `main` 即自動部署 |

### CI/CD 注意事項

- Workflow 使用 `actions/deploy-pages`，依賴 OIDC（`id-token: write`），**不需要存放任何 API 金鑰**。
- 若改用 Netlify / Cloudflare Pages / Vercel，直接在平台後台連結 repo 即可，可刪除或不使用此 workflow。
- 部署網域改變時，記得同步更新 `index.html`、`sitemap.xml`、`robots.txt`、`llms.txt` 中的正式網域。

### 資安警告：不要把 API 金鑰放進這個專案

本專案是**純靜態前端**，所有檔案都會被瀏覽器下載。任何 API key、token、secret 寫進 `index.html`、`game.js`、manifest、repo 或 CI 變數（前端可見處）都會被任何人讀取。

- Maton / 任何第三方 API key 只能放在**伺服器端或 serverless function**（Cloudflare Workers、Netlify Functions、Vercel Functions 等），再透過自己的後端代理呼叫。
- 一旦金鑰曾經出現在聊天、issue、commit 或前端程式碼中，請視為已外洩並**立即到服務商後台撤銷／輪替**。
- 本遊戲不需要任何外部 API 即可運作；若你要串接 Maton（例如取得外部資料），請先說明用途，我會以 serverless proxy 方式實作。

## SEO / GEO 設計重點

1. **完整 meta**：title、description、keywords、canonical、hreflang、robots、Open Graph、Twitter Card。
2. **結構化資料**：單一 `@graph` 包含 Organization、WebSite、VideoGame、BreadcrumbList、FAQPage。
3. **FAQ 可見內容與 JSON-LD 完全一致**，避免被判定為結構化資料濫用。
4. **條列式玩法 + 表格化賠率**，標題使用 question 形式，方便 AI 摘要與引用。
5. **llms.txt + robots.txt 明確允許 GPTBot / ClaudeBot / PerplexityBot / Google-Extended**。
6. **語意化標籤**：header / nav / main / section / article / figure / table / footer，搭配 skip link 與 ARIA live region。

## 注意事項（上線前必讀）

- 本遊戲**僅供娛樂演示**，使用瀏覽器端加權隨機，並非經稽核的 RTP 模型。
- 正式博弈系統必須：伺服器端 RNG、伺服器端結算、公開 RTP、取得合法執照、加入年齡與地區限制。
- CSP 已鎖定資源來源；若日後加入外部字型或 CDN，請同步調整 `Content-Security-Policy`。
- OG 圖片為 1200×630 JPEG（約 61 KB）；LINE 對快取較積極，更換圖片後可加查詢字串（例：`og-image.jpg?v=2`）強制更新。
- iOS Safari 音訊需使用者手勢解鎖，已於 `spin()` 中處理；若靜音，確認裝置未在靜音模式。

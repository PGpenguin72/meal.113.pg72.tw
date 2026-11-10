# 🍢 壹參壹參｜一閃一閃 小食部

> 2025 校慶園遊會（2025-11-01）班級攤位使用的點餐系統：收銀 POS、廚房顯示螢幕（KDS）、叫號大螢幕（OCS）、取餐櫃台，全部跑在 **Google Apps Script + Google Sheets** 上。
>
> A school-fair food stall ordering system (POS · KDS · call-out board · pickup counter) built on Google Apps Script with Google Sheets as the database.

© ArcantStudio｜極區工作室 2025 製作

---

## 這個倉庫裡有什麼

| 路徑 | 內容 | 狀態 |
|---|---|---|
| [`apps-script/`](apps-script/) | **當天實際上線的版本（v6.22）**：`Code.js` 後端 ＋ 5 個由 Apps Script 直接提供的頁面 | ✅ 正式使用 |
| [`cloudflare/`](cloudflare/) | 園遊會前一晚嘗試的「v7 外部 API 版」：頁面搬到 Cloudflare Pages，透過 `/api` 轉接 Apps Script | ⚠️ 未完成、未上線 |
| [`docs/`](docs/) | 架構、API、試算表結構、現場操作、已知問題 | 📄 |
| [當天的收銀資料庫](https://docs.google.com/spreadsheets/d/10L4bqqWCrQ6Pg7V77s9D2CnnGREZXjdDYWMLO1psx5E/edit?usp=sharing) | 園遊會當天實際使用的 Google 試算表（菜單、訂單總表、164 張 `Order#N`），唯讀公開；人員信箱已替換為 `hi@pg72.tw` | 🔗 唯讀 |
| `legacy` branch | 原本 `113.arcantstudio.com` 倉庫的完整 git 歷史（3 筆 commit，未經任何修改） | 🗄 |

> 程式碼都維持當時的原樣，整理時只有搬資料夾和補文件，沒有改任何一行程式。

## 系統一覽

```
         ┌──────────── 顧客 ────────────┐
         │ 點餐、付現                     │ 看螢幕等叫號、取餐
         ▼                              ▲
  ┌─────────────┐                ┌─────────────┐   ┌─────────────┐
  │  POS 收銀    │                │  OCS 叫號    │   │ Pickup 取餐  │
  │ (平板，?page=)│                │ (電視，語音)  │   │ (取餐櫃台)    │
  └──────┬──────┘                └──────▲──────┘   └──────┬──────┘
         │ submitOrder                  │ getOcsOrders       │ markOrderPickedUp
         ▼                              │                    ▼
  ┌──────────────────────────────────────────────────────────────┐
  │            Google Apps Script  (Code.js v6.22)               │
  │   LockService 排隊寫入 ・ CacheService 快取 KDS/OCS 查詢         │
  └──────┬───────────────────────────────▲───────────────────────┘
         │ 讀寫                           │ getKitchenOrders / updateOrderStatus
         ▼                               │
  ┌─────────────────────┐        ┌───────┴───────┐  ┌───────────────┐
  │ Google Sheets 收銀資料庫│        │ KDS 關東煮/套餐 │  │   KDS 飲料     │
  │ 菜單・訂單・Order#N    │        │  (?page=kds)   │  │(?page=kds_drinks)│
  └─────────────────────┘        └───────────────┘  └───────────────┘
```

| 頁面 | 網址參數 | 檔案 | 用途 |
|---|---|---|---|
| **POS 收銀** | （無） | `index.html` | 依分類點餐、即時顯示有效庫存、套餐選配、現金找零、送出後顯示取餐號碼 |
| **KDS 關東煮／套餐** | `?page=kds` | `kds_oden.html` | 廚房看單：「接單 → 完成」，每 5 秒刷新，FIFO 排序 |
| **KDS 飲料** | `?page=kds_drinks` | `kds_drinks.html` | 飲料區看單，流程同上 |
| **OCS 叫號** | `?page=ocs` | `ocs.html` | 電視大螢幕：左「準備中」、右「待取餐」，新號碼會語音播報「N 號，請取餐」 |
| **Pickup 取餐** | `?page=pickup` | `pickup.html` | 取餐櫃台：顧客取走後按下確認，訂單結案 |

## 菜單與套餐邏輯

- **一般品項**（關東煮、飲料）：直接扣「菜單」工作表的庫存。
- **固定套餐**（A／B／C／D／F 餐）：配方寫在「菜單」工作表右側的欄位，送單時依配方逐項扣庫存；套餐的可售數量＝配方中各品項庫存的最小值。
- **E 餐 1+1+1**：顧客從 $15、$20、$25 三個價位區各選一樣；可售數量＝三個價位區總庫存的最小值。
- **G 餐 內用吃到飽**：不扣庫存、不進 KDS，送單後直接結案。

詳細的計算方式見 [`docs/architecture.md`](docs/architecture.md)。

## 訂單狀態流程

```
 POS 送單 ──► pending ──(KDS 接單)──► preparing ──(各站都完成)──► ready_for_pickup ──(Pickup 確認)──► completed
                │                                                       ▲
                └──────────────── 沒有需要製作的品項 ──────────────────────┘
 G 餐訂單：POS 送單後直接 completed
```

有關東煮和飲料兩站時，**兩站都按「完成」**才會進入「待取餐」。

## 快速開始（重建一套）

1. 建立一份新的 Google 試算表 → **擴充功能 → Apps Script**。
2. 把 [`apps-script/`](apps-script/) 裡的檔案貼進去（或用 [clasp](https://github.com/google/clasp)：複製 `.clasp.json.example` 為 `.clasp.json`、填入 Script ID 後 `clasp push`）。
3. 回到試算表重新整理，選單列會出現「**壹參壹參 小食部 → 執行初始設定 (Setup)**」，執行後會建立「菜單」「訂單」「Order#0」三個工作表與範例資料。
4. 依實際菜單修改「菜單」工作表（格式見 [`docs/sheets.md`](docs/sheets.md)）。
5. Apps Script → **部署 → 新增部署作業 → 網頁應用程式**，取得 `/exec` 網址。
6. 各裝置開啟對應網址（加上 `?page=...`），細節見 [`docs/operations.md`](docs/operations.md)。

## 文件

| 文件 | 內容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | 系統架構、資料流、庫存計算、快取與鎖、取餐號碼規則 |
| [`docs/api.md`](docs/api.md) | 後端函式（`google.script.run`）與 v7 外部 API（`?action=`）規格 |
| [`docs/sheets.md`](docs/sheets.md) | 「菜單」「訂單」「Order#N」工作表欄位結構與當天菜單 |
| [`docs/operations.md`](docs/operations.md) | 現場設備配置、開店前檢查、營業中操作、收攤 |
| [`docs/known-issues.md`](docs/known-issues.md) | 已知問題、限制與日後改進方向 |

## 技術

Google Apps Script（V8）・Google Sheets・HtmlService・LockService・CacheService・Tailwind CSS（CDN）・Web Speech API（語音叫號）・Cloudflare Pages Functions（v7 嘗試）

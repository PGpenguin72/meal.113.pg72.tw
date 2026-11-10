# 系統架構

> ✍️ 本文件由 Claude 撰寫（2026-11），內容依據原始程式碼與試算表整理；系統本身由 PG企鵝 設計、Gemini 產生程式碼。

## 兩個版本

| | v6.22（`apps-script/`） | v7.x（`cloudflare/`） |
|---|---|---|
| 頁面由誰提供 | Apps Script `doGet` + `HtmlService` | Cloudflare Pages（靜態 HTML） |
| 前端呼叫後端 | `google.script.run.<函式>()` | `fetch('/api?action=...')` 經 Pages Function 轉接，或直接 `fetch` Apps Script `/exec` |
| 後端 | `Code.js` v6.22（本倉庫） | 註解中提到的「Code.gs v7.0」，**不在此 Apps Script 專案中**，已無法取得 |
| 收銀員身分 | `Session.getActiveUser()` 取得 Google 帳號 | 無 |
| 狀態 | **2025-11-01 當天正式使用** | 前一晚 00:42–01:24 的搬遷嘗試，未上線 |

判斷依據：「訂單」工作表第一筆訂單時間為 2025/11/1 08:03，且「點餐人員」欄位有 Google 帳號；Apps Script 專案的 48 個版本皆為 v6.x，沒有任何處理 `?action=` 或 `doPost` 的程式；Cloudflare 版 POS 寫死的部署網址目前回應 403。

以下說明皆以 **v6.22** 為準。

## 元件

```
Google Sheets「收銀資料庫」
├── 菜單       品項、價格、庫存、套餐配方（資料來源）
├── 訂單       訂單總表，一列一張訂單（KDS / OCS 查詢的來源）
├── Order#0    隱藏的訂單範本
└── Order#N    每張訂單複製一份範本，記錄明細與各站狀態旗標

Apps Script（綁定在上面的試算表，Code.js）
├── doGet(e)           依 ?page= 回傳對應 HTML
├── onOpen / setup     試算表選單與初始化
├── getMenuItems       POS 讀菜單（含計算後的有效庫存）
├── submitOrder        POS 送單（鎖定 → 檢查庫存 → 扣庫存 → 建 Order#N → 寫總表 → 重建快取）
├── getKitchenOrders   KDS 讀單（快取優先）
├── updateOrderStatus  KDS 接單／完成（鎖定 → 更新旗標 → 推導總表狀態 → 重建快取）
├── getOcsOrders       OCS / Pickup 讀單（快取優先）
└── markOrderPickedUp  Pickup 結案（鎖定 → 更新 → 重建 OCS 快取）
```

## 一張訂單的生命週期

1. **POS** 呼叫 `getMenuItems()` 取得菜單，前端在本地維護購物車，並即時計算「有效庫存＝後端庫存－購物車已佔用」。
2. 收銀員按「結帳」→ 輸入實收金額 → 「確認送出訂單」，前端呼叫 `submitOrder(JSON.stringify(orderData))`。
3. **後端 `submitOrder`**：
   1. `LockService.getScriptLock().waitLock(10000)`：所有寫入動作排隊執行，避免兩台 POS 同時扣到同一份庫存。
   2. 讀「菜單」，依品項類型展開需要扣的庫存（一般品項、固定套餐配方、E 餐三選一）。
   3. 任一品項不足就整張訂單退回，不會扣到一半。
   4. 寫回「菜單」D 欄的新庫存。
   5. `getNewOrderInfo()` 算出新的訂單編號 `Order#N` 與取餐號碼。
   6. 複製 `Order#0` 為 `Order#N`，寫入時間、取餐號碼、總金額、收銀員、各站旗標與品項數量。
   7. 在「訂單」總表新增一列，初始狀態為 `pending`（有需要製作的品項）、`ready_for_pickup`（沒有）或 `completed`（G 餐）。
   8. `rebuildAllCaches()` 重建兩個 KDS 與 OCS 的快取，然後釋放鎖。
4. **KDS** 每 5 秒呼叫 `getKitchenOrders(type)`，只會看到自己那一站的品項。
5. 廚房按「接單」→ `updateOrderStatus(orderName, 'preparing', type)`；做完按「完成」→ `'ready'`。
6. 後端更新 `Order#N` 的站別旗標，再依兩站的旗標推導出總表狀態（見下方），寫回「訂單」F 欄。
7. **OCS** 每 5 秒呼叫 `getOcsOrders()`，偵測到新的「待取餐」號碼就用 Web Speech API 播報。
8. **Pickup** 櫃台確認顧客取餐 → `markOrderPickedUp(orderName)` → 總表狀態變為 `completed`，從 OCS 消失。

## 站別旗標與總表狀態

每張 `Order#N` 的 B7–B13 是旗標，值為 `1` 或空白：

| 儲存格 | 意義 |
|---|---|
| B7 / B8 | 關東煮 / 飲料：待接單 |
| B9 / B10 | 關東煮 / 飲料：準備中 |
| B11 / B12 | 關東煮 / 飲料：完成 |
| B13 | 已取餐 |

`updateOrderStatus` 推導總表狀態的規則：

- 某一站「需要處理」＝該站的待接單、準備中、完成任一為 1。
- 所有需要處理的站都「完成」→ `ready_for_pickup`
- 否則任一站「準備中」→ `preparing`
- 否則任一站「待接單」→ `pending`

「關東煮」與「套餐」都歸關東煮站，「飲料」歸飲料站。

## 庫存計算

`getMenuItems()`（後端）與 POS 的 `getEffectiveStock()`（前端）使用相同規則：

| 類型 | 判斷方式 | 可售數量 |
|---|---|---|
| 一般品項 | 類別不是「套餐」 | 「菜單」D 欄庫存 |
| 固定套餐 | 類別是「套餐」，配方欄有品名 | `min(配方中每個品項的庫存)` |
| E 餐 | 配方欄第一格是 `"15"` | `min(所有 $15 品項庫存總和, $20 總和, $25 總和)` |
| G 餐 | 品名等於 `G餐-內用吃到飽` | 固定回傳 999，不扣庫存 |

E 餐的三個位置是依**價格**分組（15 / 20 / 25 元），所以調整單品價格會直接改變它能不能被選進 E 餐。

## 取餐號碼

`getNewOrderInfo()`：

- 訂單編號：掃描所有工作表，找出最大的 `Order#N`，新訂單為 `N+1`（全期間不重置）。
- 取餐號碼：讀最後一張訂單 `B2` 的日期，若是**今天**就接續 `B3 + 1`，否則從 **1** 重新開始（每天重置）。

## 併發與效能

- **LockService**：`submitOrder`、`updateOrderStatus`、`markOrderPickedUp` 都在 script lock 內執行，最多等 10 秒。
- **CacheService**（v6.21 起）：多台 KDS 與 OCS 每幾秒輪詢一次，直接讀試算表會撞到 Apps Script 的呼叫上限（429）。讀取 API 改成「快取優先」，快取保存 120 秒。
- **主動重建快取**（v6.22）：每次寫入都在鎖內呼叫 `rebuildAllCaches()`，讓輪詢端拿到的永遠是最新資料，不用等快取過期。

## 版本演進（摘自 `Code.js` 註解與 Apps Script 版本紀錄）

| 版本 | 重點 |
|---|---|
| v6.8 | KDS 接單系統 |
| v6.14 | 拆成關東煮 / 飲料雙 KDS |
| v6.15 | OCS 叫號、Pickup 取餐、站別旗標 |
| v6.17 | G 餐（吃到飽）、系統命名、KDS 排序 |
| v6.18 | KDS 改為 FIFO（先來先做） |
| v6.21 | 加入 CacheService，解決 429 |
| v6.22 | 寫入時主動重建快取（當天使用的最終版，Apps Script 版本 48） |
| v7.x | 前端搬到 Cloudflare Pages 的嘗試（`cloudflare/`） |

# 已知問題與改進方向

> ✍️ 本文件由 Claude 撰寫（2026-11），內容依據原始程式碼與試算表整理；系統本身由 PG企鵝 設計、Gemini 產生程式碼。

整理時發現的問題。程式碼維持原樣，這份文件只記錄問題，沒有修。

## 🔒 安全性

### 1. 網頁應用程式對匿名使用者開放，並以擁有者身分執行
`appsscript.json` 的設定是 `"access": "ANYONE_ANONYMOUS"`、`"executeAs": "USER_DEPLOYING"`。只要知道 `/exec` 網址，任何人都能打開 POS 送單、改 KDS 狀態，寫入的都是擁有者的試算表。這個 Apps Script 專案目前有 **49 個部署**，其中最新版仍可正常存取。
**建議**：活動結束後封存所有部署；下次活動改成「同網域的使用者」或至少只開放在活動期間。

### 2. 後端相信前端送來的金額
`submitOrder` 直接記錄 `orderData.total`，沒有用菜單價格重新計算。改過前端或直接呼叫函式，就能送出金額不對的訂單。
**建議**：後端依「菜單」價格與數量重算總額，不一致就拒絕。

### 3. v7 前端寫死了 Apps Script 部署網址
`cloudflare/POS.html` 直接寫死 `/exec` 網址，沒有走 `/api` 代理。該部署目前已失效（回應 403）。

### 4. 用 `innerHTML` 插入品名
POS、KDS 都把品名直接組進 HTML 字串，購物車按鈕還用 `onclick="updateCartItemQuantity('${name}', …)"`。品名只由管理者在試算表中輸入，風險不高；但品名只要有單引號 `'` 就會讓按鈕失效，有 `<` 也可能破壞畫面。

## 🐛 邏輯

### 5. 含 G 餐的訂單，其他品項不會送到廚房
`submitOrder` 只要訂單裡有 G 餐（`isGPillOrder`），**整張訂單**都不設定 KDS 旗標，狀態直接變成 `completed`。如果顧客把 G 餐和飲料或關東煮一起點，那些品項不會出現在任何 KDS，也不會叫號。
**建議**：只略過 G 餐那一項，其他品項照常分流。
線上試玩（`site/demo/mock-gas.js`）已照這個方式修正；`apps-script/Code.js` 維持當天原樣。

### 6. 套餐品名寫死在程式裡
`G餐-內用吃到飽`、`E餐-1+1+1` 直接寫在 `Code.js` 和 POS 裡，E 餐的分組也寫死為 15 / 20 / 25 元。改菜單名稱或價格就可能讓套餐邏輯失效（例如魚板 35 元就永遠不能選進 E 餐）。
v7 的 `cloudflare/POS.html` 判斷 G 餐用的是 `"G餐 (內用吃到飽)"`，跟後端的 `"G餐-內用吃到飽"` 對不起來。

### 7. 明細表只記錄範本上已有的品項
`Order#N` 的數量只寫進範本 D 欄找得到的品名。菜單新增品項卻沒更新 `Order#0`，明細表就會漏記（總表的 JSON 仍然完整）。`setup()` 產生的範例菜單和當天實際菜單也不一樣（例如 `A餐-輕享款` 與 `A餐-輕享`）。

### 8. 沒有作廢、退款功能
送錯單只能手動改試算表：加回庫存、改狀態。

### 9. 失敗時鎖的釋放不一致
`submitOrder` 在「找不到範本」這條路徑先呼叫了 `lock.releaseLock()` 再 `return`，其他路徑則在 `catch` 裡釋放。目前沒有重複釋放造成錯誤，但流程容易在修改時出錯，建議改成 `try … finally { lock.releaseLock() }`。

## ⚡ 效能與擴充性

### 10. 一張訂單一個工作表
每張訂單都複製一份 `Order#0`，當天累積到 `Order#164`。`getNewOrderInfo()` 每次送單都要掃描**所有工作表**找最大編號，`copyTo` 也很慢，工作表越多送單越慢。
**建議**：明細改成同一張表、每個品項一列，訂單編號改存在 `PropertiesService` 或總表最後一列。

### 11. 寫入時重建所有快取
`submitOrder` 和 `updateOrderStatus` 在鎖內同步重讀整張「訂單」表三次（兩個 KDS 加 OCS）。尖峰時段這會延長每一筆送單的鎖定時間。
**建議**：快取只存最近 N 筆未完成的訂單，或改成增量更新。

### 12. 每次查詢都 `JSON.parse` 整張總表
KDS 慢速查詢會逐列解析 D 欄 JSON，只是為了挑出未完成的訂單。可以先用 F 欄狀態篩選，再解析需要的那幾列。

## 🧩 v7（`cloudflare/`）未完成的部分

| 問題 | 說明 |
|---|---|
| 後端不存在 | 前端預期的「Code.gs v7.0」（`?action=` 路由與 `doPost`）不在 Apps Script 專案中 |
| 三種串接方式混用 | KDS 與 Pickup 走 `/api` 代理；POS 直接呼叫寫死的網址；OCS 的網址還是佔位字串 `YOUR_DEPLOYED_WEB_APP_URL_HERE`，無法運作 |
| KDS 更新狀態缺少站別 | v7 KDS 送出 `{ orderName, newStatus }`，沒有 v6.22 `updateOrderStatus` 需要的 `type` |
| 沒有收銀員身分 | 外部 API 拿不到 `Session.getActiveUser()` |
| 大量重複程式 | `ODEN.html` 與 `DRINKS.html` 只差 3 行；`apiGet`／`apiPost`、錯誤視窗在每個頁面各複製一份 |
| `index.html` | 內容只有 `:D` |

## 改進方向（如果還有下一次）

1. 把設定（套餐名稱、E 餐分組價格、KDS 分站規則）搬到試算表的「設定」工作表。
2. 明細改用單一工作表，訂單編號與取餐號碼用 `PropertiesService` 管理。
3. 前端共用一份 `api.js`，KDS 合併成一頁、用 `?station=` 切換。
4. 存取權限限制在登入的帳號，後端重算金額。
5. 加上作廢、退款與營業報表。

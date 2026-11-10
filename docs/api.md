# API 規格

## v6.22：`google.script.run`（當天使用）

頁面由 Apps Script 提供，前端以 `google.script.run.withSuccessHandler(...).withFailureHandler(...).<函式>(...)` 呼叫 `Code.js` 中的公開函式。

| 函式 | 呼叫端 | 寫入 | 鎖 |
|---|---|---|---|
| `getMenuItems()` | POS | — | — |
| `submitOrder(orderDataJSON)` | POS | ✅ | ✅ |
| `getKitchenOrders(type)` | KDS ×2 | — | — |
| `updateOrderStatus(orderName, newStatus, type)` | KDS ×2 | ✅ | ✅ |
| `getOcsOrders()` | OCS、Pickup | — | — |
| `markOrderPickedUp(orderName)` | Pickup | ✅ | ✅ |

### `getMenuItems()`

回傳菜單陣列，每個品項：

```jsonc
{
  "category": "關東煮",        // 「套餐」「關東煮」「飲料」
  "name": "海帶",
  "price": 15,
  "stock": 27,                 // 套餐為計算後的可售數量，G 餐固定 999
  "components": null           // 固定套餐：["蘿蔔","王子麵","玉米"]；E 餐：["15","20","25"]
}
```

價格不是數字或為 0 的列會被略過；讀取失敗時回傳 `[]`（不丟錯）。

### `submitOrder(orderDataJSON)`

參數是 **JSON 字串**：

```jsonc
{
  "items": [
    { "name": "海帶", "quantity": 2, "price": 15, "type": "simple", "components": null, "category": "關東煮" },
    { "name": "A餐-輕享", "quantity": 1, "price": 50, "type": "fixed_combo", "components": null, "category": "套餐" },
    {
      "name": "E餐-1+1+1 (海帶 + 蘿蔔 + 百頁豆腐)",
      "quantity": 1, "price": 55, "type": "combo", "category": "套餐",
      "components": [                       // E 餐才有，依 price 對應 15 / 20 / 25 區
        { "name": "海帶", "price": 15 }, { "name": "蘿蔔", "price": 20 }, { "name": "百頁豆腐", "price": 25 }
      ]
    }
  ],
  "total": 135
}
```

| `type` | 意義 | 扣庫存方式 |
|---|---|---|
| `simple` | 一般品項 | 品項本身 |
| `fixed_combo` | 固定套餐（A–D、F 餐），G 餐也標成這個 | 依「菜單」配方 |
| `combo` | E 餐 | `components` 中的三個品項 |

回傳：

```jsonc
{ "success": true, "pickupNumber": 12 }
{ "success": false, "message": "\"蘿蔔\" 庫存不足！ (需要: 3, 僅剩: 1)" }
```

### `getKitchenOrders(type)`

`type`：`"oden"`（關東煮＋套餐）或 `"drinks"`（飲料）。回傳狀態為 `pending` / `preparing` 的訂單，依建立順序（FIFO）排列，且只包含該站的品項：

```jsonc
[
  {
    "orderName": "Order#42",
    "pickupNumber": 12,
    "status": "pending",
    "items": [
      { "name": "海帶", "quantity": 2, "isCombo": false, "components": [] },
      { "name": "A餐-輕享", "quantity": 1, "isCombo": true, "components": ["蘿蔔", "王子麵", "玉米"] },
      { "name": "E餐-1+1+1 (…)", "quantity": 2, "isCombo": true,
        "components": [["海帶", "蘿蔔", "百頁豆腐"], ["米血", "玉米", "魚蛋"]] }  // E 餐：每份一組
    ]
  }
]
```

含 G 餐的訂單不會出現在 KDS。

### `updateOrderStatus(orderName, newStatus, type)`

- `newStatus`：`"preparing"`（接單）或 `"ready"`（完成）
- `type`：`"oden"` 或 `"drinks"`

更新 `Order#N` 的站別旗標，再推導總表狀態（規則見 [architecture.md](architecture.md#站別旗標與總表狀態)）。回傳 `{ success, message }`；失敗時**丟出例外**，由前端的 failure handler 處理。

### `getOcsOrders()`

```jsonc
{
  "preparingOrders": [{ "orderName": "Order#45", "pickupNumber": 15 }],  // 最新的在前
  "readyOrders":     [{ "orderName": "Order#41", "pickupNumber": 11 }]   // 最舊的在前
}
```

### `markOrderPickedUp(orderName)`

設定 `Order#N!B13 = 1`、總表狀態改為 `completed`，並重建 OCS 快取。回傳 `{ success, message }`；失敗時丟出例外。

### 網頁路由 `doGet(e)`

| `?page=` | 檔案 |
|---|---|
| （無） | `index.html`（POS） |
| `kds` | `kds_oden.html` |
| `kds_drinks` | `kds_drinks.html` |
| `ocs` | `ocs.html` |
| `pickup` | `pickup.html` |

部署設定（`appsscript.json`）：以**部署者身分執行**、**任何人（含匿名）**皆可存取、時區 `Asia/Taipei`。

---

## v7.x：外部 HTTP API（未完成）

`cloudflare/` 中的頁面改用 HTTP 呼叫，預期後端（Code.gs v7.0）提供以下介面。**該後端不在此 Apps Script 專案中**，以下規格是從前端程式碼整理出來的。

### 傳輸

| 方法 | 格式 |
|---|---|
| GET | `/api?action=<action>&<參數>`，由 `functions/api.js` 把 query string 原封不動轉給 `GAS_WEB_APP_URL` |
| POST | `/api`，body 為 `{"action": "<action>", "data": { ... }}`，原封不動轉給 `GAS_WEB_APP_URL` |

回應一律包成：

```jsonc
{ "success": true,  "data": <各 action 的回傳> }
{ "success": false, "message": "錯誤說明" }
```

### Actions

| action | 方法 | 參數 / data | `data` 回傳 | 對應 v6.22 函式 |
|---|---|---|---|---|
| `getMenuItems` | GET | — | 菜單陣列 | `getMenuItems()` |
| `submitOrder` | POST | `{ items, total }`（物件，不是字串） | `{ pickupNumber }` | `submitOrder()` |
| `getKitchenOrders` | GET | `type=oden\|drinks` | `{ orders: [...] }` | `getKitchenOrders()` |
| `updateOrderStatus` | POST | `{ orderName, newStatus }` | — | `updateOrderStatus()`（v7 前端**沒有傳 `type`**） |
| `getOcsOrders` | GET | — | `{ preparingOrders, readyOrders }` | `getOcsOrders()` |
| `markOrderPickedUp` | POST | `{ orderName }` | — | `markOrderPickedUp()` |

### Cloudflare Pages Function（`functions/api.js`）

- 需要環境變數 `GAS_WEB_APP_URL`（Apps Script 網頁應用程式的 `/exec` 網址）。
- GET 與 POST 都使用 `redirect: 'follow'`，因為 Apps Script 會先回 302 轉到 `script.googleusercontent.com`。
- 讓瀏覽器只跟同網域的 `/api` 溝通，避開 Apps Script 的 CORS 限制，也不需要把部署網址寫在前端。

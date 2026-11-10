# apps-script/ — v6.22（2025-11-01 正式使用）

綁定在「收銀資料庫」試算表上的 Apps Script 專案，從 Apps Script 版本 48 原樣匯出（`clasp clone`）。

| 檔案 | 說明 |
|---|---|
| `Code.js` | 後端：網頁路由、選單／初始設定、POS／KDS／OCS／Pickup 的所有函式 |
| `appsscript.json` | 專案設定：V8、`Asia/Taipei`、網頁應用程式以部署者身分執行、任何人皆可存取 |
| `index.html` | POS 收銀（預設頁面） |
| `kds_oden.html` | KDS 關東煮／套餐（`?page=kds`） |
| `kds_drinks.html` | KDS 飲料（`?page=kds_drinks`） |
| `ocs.html` | 叫號大螢幕（`?page=ocs`） |
| `pickup.html` | 取餐櫃台（`?page=pickup`） |

## 用 clasp 部署

```bash
cp .clasp.json.example .clasp.json   # 填入你自己的 Script ID
clasp push
clasp deploy --description "v6.22"
```

規格見 [`../docs/api.md`](../docs/api.md)，資料結構見 [`../docs/sheets.md`](../docs/sheets.md)。

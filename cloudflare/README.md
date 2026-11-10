# cloudflare/ — v7.x 外部 API 版（未完成，未上線）

園遊會前一晚（2025-11-01 00:42–01:24）嘗試把頁面搬到 Cloudflare Pages 的版本，原本部署在 `113.arcantstudio.com`。完整歷史在本倉庫的 `legacy` branch。

| 檔案 | 對應 v6.22 | 串接方式 |
|---|---|---|
| `POS.html` | `index.html` | 直接 `fetch` 寫死的 Apps Script 網址 |
| `ODEN.html` | `kds_oden.html` | `/api` 代理 |
| `DRINKS.html` | `kds_drinks.html` | `/api` 代理 |
| `OCS.html` | `ocs.html` | 網址是佔位字串，無法運作 |
| `PICKUP.html` | `pickup.html` | `/api` 代理 |
| `functions/api.js` | — | Pages Function：把 `/api` 轉發到環境變數 `GAS_WEB_APP_URL` |
| `index.html` | — | 內容只有 `:D` |

這些頁面需要的後端「Code.gs v7.0」不在 Apps Script 專案中，所以這個版本目前無法單獨運作。介面規格與未完成的部分見 [`../docs/api.md`](../docs/api.md#v7x外部-http-api未完成) 和 [`../docs/known-issues.md`](../docs/known-issues.md#-v7cloudflare未完成的部分)。

部署到 Cloudflare Pages 時，請把專案的 **Root directory** 設成 `cloudflare`。

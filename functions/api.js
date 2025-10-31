/**
 * [v7.2] Cloudflare Pages Function (Proxy Worker)
 * * 100% 檔案路徑： /functions/api.js
 * 這 100% 會自動攔截所有 /api 的請求 (GET & POST)
 * * 100% 環境變數：
 * 你 100% 必須在 Cloudflare Pages 的「設定」->「環境變數」中
 * 100% 新增一個叫做 "GAS_WEB_APP_URL" 的變數，
 * 它的值 100% 必須是 Code.gs (v7.0) 部署後的「Web 應用程式」網址！
 */

/**
 * [v7.2] 處理 GET 請求
 * (例如：/api?action=getMenuItems)
 */
export async function onRequestGet({ request, env }) {
  // 1. [v7.2] 100% 從 Cloudflare 環境變數讀取 GAS 網址
  const gasUrl = env.GAS_WEB_APP_URL;
  
  if (!gasUrl) {
    return new Response(JSON.stringify({ 
      success: false, 
      message: '伺服器端錯誤：Cloudflare 代理 100% 找不到 GAS_WEB_APP_URL 環境變數。' 
    }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 2. [v7.2] 100% 組合新的 Google 網址 (包含 ?action=...)
  const url = new URL(request.url); // (e.g., /api?action=...)
  const gasTargetUrl = new URL(gasUrl); // (e.g., .../exec)
  
  // [v7.2] 100% 把 /api?action=... 的 "action" 搬到 .../exec?action=...
  gasTargetUrl.search = url.search; 

  try {
    // 3. [v7.2] 100% (Proxy) 呼叫真正的 Google 網址
    const response = await fetch(gasTargetUrl.toString(), {
      method: 'GET',
      redirect: 'follow' // [v7.2] 100% (Proxy) 呼叫 Google 100% 需要 "follow"
    });
    
    // 4. [v7.2] 100% (Proxy) 把 Google 回傳的 JSON 100% 回傳給前端
    return new Response(response.body, response);
    
  } catch (err) {
    return new Response(JSON.stringify({ 
      success: false, 
      message: `Cloudflare 代理 GET 請求失敗: ${err.message}` 
    }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * [v7.2] 處理 POST 請求
 * (例如：/api，附帶 { action: 'submitOrder', ... } 的 JSON body)
 */
export async function onRequestPost({ request, env }) {
  // 1. [v7.2] 100% 從 Cloudflare 環境變數讀取 GAS 網址
  const gasUrl = env.GAS_WEB_APP_URL;
  
  if (!gasUrl) {
    return new Response(JSON.stringify({ 
      success: false, 
      message: '伺服器端錯誤：Cloudflare 代理 100% 找不到 GAS_WEB_APP_URL 環境變數。' 
    }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    // 2. [v7.2] 100% (Proxy) 呼叫真正的 Google 網址
    const response = await fetch(gasUrl, {
      method: 'POST',
      redirect: 'follow', // [v7.2] 100% (Proxy) 呼叫 Google 100% 需要 "follow"
      body: request.body, // [v7.2] 100% 傳遞前端傳來的 JSON
      headers: { 'Content-Type': 'application/json' }
    });
    
    // 3. [v7.2] 100% (Proxy) 把 Google 回傳的 JSON 100% 回傳給前端
    return new Response(response.body, response);
    
  } catch (err) {
    return new Response(JSON.stringify({ 
      success: false, 
      message: `Cloudflare 代理 POST 請求失敗: ${err.message}` 
    }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

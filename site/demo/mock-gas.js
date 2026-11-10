/**
 * mock-gas.js — 在瀏覽器裡模擬 Google Apps Script 後端（Demo 專用）
 *
 * 原本的頁面（apps-script/*.html）透過 google.script.run 呼叫 Code.js。
 * 這支檔案提供一個相容的 google.script.run，並把 Code.js v6.22 的
 * 六個函式照原邏輯移植過來，資料存在 localStorage：
 *
 *   getMenuItems / submitOrder / getKitchenOrders /
 *   updateOrderStatus / getOcsOrders / markOrderPickedUp
 *
 * 同一個瀏覽器裡的所有分頁、iframe 共用同一份資料，所以 POS 送出的訂單
 * 會出現在 KDS、OCS 與 Pickup 上。不會連線到任何真實的試算表。
 */
(function () {
  'use strict';

  const STORE_KEY = 'meal113-demo-v1';
  const G_PILL_COMBO_NAME = 'G餐-內用吃到飽';
  const LATENCY_MS = 180; // 模擬 Apps Script 的網路延遲

  // --- 初始資料：2025-11-01 當天的菜單（庫存為當天備料量） ---
  function seed() {
    return {
      menu: [
        // [類別, 品名, 價格, 庫存]
        ['套餐', 'A餐-輕享', 50, ''], ['套餐', 'B餐-輕享', 35, ''], ['套餐', 'C餐-小豐盛', 60, ''],
        ['套餐', 'D餐-小豐盛', 55, ''], ['套餐', 'E餐-1+1+1', 55, ''], ['套餐', 'F餐-大豐盛', 75, ''],
        ['套餐', G_PILL_COMBO_NAME, 799, ''],
        ['關東煮', '海帶', 15, 60], ['關東煮', '米血', 15, 55], ['關東煮', '魚板', 35, 60],
        ['關東煮', '蘿蔔', 20, 80], ['關東煮', '玉米', 20, 60], ['關東煮', '王子麵', 20, 80],
        ['關東煮', '油豆腐', 20, 60], ['關東煮', '百頁豆腐', 25, 60], ['關東煮', '魚蛋', 25, 50],
        ['飲料', '冬瓜檸檬', 40, 60], ['飲料', '藍柑汽水', 45, 60], ['飲料', '冬瓜茶', 30, 60], ['飲料', '果汁', 30, 60]
      ],
      // 「菜單」工作表右側的配方欄
      recipes: {
        'A餐-輕享': ['蘿蔔', '王子麵', '玉米'],
        'B餐-輕享': ['百頁豆腐'],
        'C餐-小豐盛': ['蘿蔔', '玉米', '海帶', '王子麵'],
        'D餐-小豐盛': ['蘿蔔', '王子麵'],
        'E餐-1+1+1': ['15', '20', '25'],
        'F餐-大豐盛': ['蘿蔔', '玉米', '米血', '海帶', '王子麵']
      },
      // 「訂單」總表 + 各 Order#N 的 B7–B13 旗標
      orders: [],
      lastOrderNum: 0
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* 無法讀取就重新開始 */ }
    return seed();
  }
  function save(db) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) { /* 隱私模式等情況下僅存在記憶體 */ }
  }

  // 簡易的跨分頁鎖（對應 LockService）：同一個 JS 執行緒內是原子的，
  // 每次呼叫都重新 load → 修改 → save，避免分頁間互相覆蓋舊資料。
  function withDb(fn) {
    const db = load();
    const result = fn(db);
    save(db);
    return result;
  }

  const today = () => new Date().toISOString().slice(0, 10);

  // ===== Code.js: getMenuItems =====
  function getMenuItems() {
    const db = load();
    const itemStockMap = {};
    const simpleItems = [];
    db.menu.forEach(([category, name, price, stock]) => {
      if (category !== '套餐') {
        const s = parseInt(stock, 10);
        const item = { category, name, price, stock: isNaN(s) ? 0 : s };
        itemStockMap[name] = item.stock;
        simpleItems.push(item);
      }
    });

    return db.menu.map(([category, name, price]) => {
      if (name === G_PILL_COMBO_NAME) return { category, name, price, stock: 999, components: null };
      let trueStock = 0;
      let componentParts = null;
      if (category === '套餐') {
        componentParts = db.recipes[name] || null;
        if (!componentParts) {
          trueStock = 0;
        } else if (componentParts[0] === '15') {
          let t15 = 0, t20 = 0, t25 = 0;
          simpleItems.forEach(item => {
            if (item.price === 15) t15 += item.stock;
            else if (item.price === 20) t20 += item.stock;
            else if (item.price === 25) t25 += item.stock;
          });
          trueStock = Math.min(t15, t20, t25);
        } else {
          trueStock = Math.min(...componentParts.map(p => itemStockMap[p] || 0));
        }
      } else {
        trueStock = itemStockMap[name] || 0;
      }
      return { category, name, price, stock: trueStock, components: componentParts };
    }).filter(item => item.price > 0);
  }

  // ===== Code.js: submitOrder =====
  function submitOrder(orderDataJSON) {
    return withDb(db => {
      const orderData = JSON.parse(orderDataJSON);
      const isGPillOrder = orderData.items.some(item => item.name === G_PILL_COMBO_NAME);

      const stockMap = {};
      const rowOf = {};
      db.menu.forEach((row, i) => {
        if (row[0] !== '套餐') { stockMap[row[1]] = parseInt(row[3], 10) || 0; rowOf[row[1]] = i; }
      });

      const stockUpdates = {};
      let hasOdenOrCombo = false;
      let hasDrinks = false;

      for (const item of orderData.items) {
        if (!isGPillOrder) {
          if (item.category === '關東煮' || item.category === '套餐') hasOdenOrCombo = true;
          else if (item.category === '飲料') hasDrinks = true;
        }
        if (item.name === G_PILL_COMBO_NAME) continue;

        if (item.type === 'simple') {
          stockUpdates[item.name] = (stockUpdates[item.name] || 0) + item.quantity;
        } else if (item.type === 'combo') {
          (item.components || []).forEach(c => {
            if (c && c.name) stockUpdates[c.name.trim()] = (stockUpdates[c.name.trim()] || 0) + item.quantity;
          });
        } else if (item.type === 'fixed_combo') {
          (db.recipes[item.name] || []).forEach(p => { stockUpdates[p] = (stockUpdates[p] || 0) + item.quantity; });
        }
      }

      for (const name in stockUpdates) {
        if (stockMap[name] === undefined) return { success: false, message: `"${name}" 在菜單庫存中找不到！(請檢查配方)` };
        if (stockUpdates[name] > stockMap[name]) {
          return { success: false, message: `"${name}" 庫存不足！ (需要: ${stockUpdates[name]}, 僅剩: ${stockMap[name]})` };
        }
      }
      for (const name in stockUpdates) db.menu[rowOf[name]][3] = stockMap[name] - stockUpdates[name];

      // getNewOrderInfo：訂單編號持續遞增，取餐號碼每天從 1 開始
      const last = db.orders[db.orders.length - 1];
      const pickupNumber = last && last.date === today() ? last.pickupNumber + 1 : 1;
      db.lastOrderNum += 1;

      const flags = { b7: '', b8: '', b9: '', b10: '', b11: '', b12: '', b13: '' };
      if (hasOdenOrCombo) flags.b7 = 1;
      if (hasDrinks) flags.b8 = 1;
      if (isGPillOrder) flags.b13 = 1;

      const status = isGPillOrder ? 'completed' : (hasOdenOrCombo || hasDrinks) ? 'pending' : 'ready_for_pickup';

      db.orders.push({
        orderName: 'Order#' + db.lastOrderNum,
        pickupNumber,
        date: today(),
        timestamp: new Date().toISOString(),
        json: orderDataJSON,
        total: orderData.total,
        status,
        flags
      });
      return { success: true, pickupNumber };
    });
  }

  // ===== Code.js: getKitchenOrders =====
  function getKitchenOrders(type) {
    if (type !== 'oden' && type !== 'drinks') return [];
    const db = load();
    const out = [];
    for (const o of db.orders) {
      if (o.status !== 'pending' && o.status !== 'preparing') continue;
      const orderData = JSON.parse(o.json);
      if (orderData.items.some(item => item.name === G_PILL_COMBO_NAME)) continue;
      const filtered = orderData.items.filter(item =>
        type === 'oden' ? (item.category === '關東煮' || item.category === '套餐') : item.category === '飲料');
      if (filtered.length === 0) continue;
      out.push({
        orderName: o.orderName,
        pickupNumber: o.pickupNumber,
        status: o.status,
        items: filtered.map(item => {
          let components = [];
          let isCombo = false;
          if (item.type === 'combo') {
            isCombo = true;
            const pick = p => (item.components || []).find(c => c.price == p)?.name || '';
            for (let q = 0; q < item.quantity; q++) components.push([pick(15), pick(20), pick(25)]);
          } else if (item.type === 'fixed_combo') {
            isCombo = true;
            components = db.recipes[item.name] || [];
          }
          return { name: item.name, quantity: item.quantity, isCombo, components };
        })
      });
    }
    return out;
  }

  // ===== Code.js: updateOrderStatus =====
  function updateOrderStatus(orderName, newStatus, type) {
    return withDb(db => {
      const o = db.orders.find(x => x.orderName === orderName);
      if (!o) return { success: false, message: `找不到工作表 ${orderName}` };
      const f = o.flags;
      if (type === 'oden') {
        if (newStatus === 'preparing') { f.b7 = ''; f.b9 = 1; } else if (newStatus === 'ready') { f.b9 = ''; f.b11 = 1; }
      } else if (type === 'drinks') {
        if (newStatus === 'preparing') { f.b8 = ''; f.b10 = 1; } else if (newStatus === 'ready') { f.b10 = ''; f.b12 = 1; }
      }
      const odenNeeded = f.b7 || f.b9 || f.b11;
      const drinksNeeded = f.b8 || f.b10 || f.b12;
      let ready = false;
      if (odenNeeded && drinksNeeded) ready = f.b11 && f.b12;
      else if (odenNeeded) ready = f.b11;
      else if (drinksNeeded) ready = f.b12;

      if (ready) o.status = 'ready_for_pickup';
      else if (f.b9 || f.b10) o.status = 'preparing';
      else if (f.b7 || f.b8) o.status = 'pending';
      return { success: true, message: `${orderName} 狀態已更新為 ${newStatus} (${type})` };
    });
  }

  // ===== Code.js: getOcsOrders =====
  function getOcsOrders() {
    const db = load();
    const preparingOrders = [];
    const readyOrders = [];
    for (const o of db.orders) {
      const info = { orderName: o.orderName, pickupNumber: o.pickupNumber };
      if (o.status === 'preparing') preparingOrders.push(info);
      else if (o.status === 'ready_for_pickup') readyOrders.push(info);
    }
    preparingOrders.reverse();
    return { preparingOrders, readyOrders };
  }

  // ===== Code.js: markOrderPickedUp =====
  function markOrderPickedUp(orderName) {
    return withDb(db => {
      const o = db.orders.find(x => x.orderName === orderName);
      if (o) { o.flags.b13 = 1; o.status = 'completed'; }
      return { success: true, message: `${orderName} 已標記為 "completed"` };
    });
  }

  const API = { getMenuItems, submitOrder, getKitchenOrders, updateOrderStatus, getOcsOrders, markOrderPickedUp };

  // --- google.script.run 相容層 ---
  function makeRunner(onSuccess, onFailure) {
    return new Proxy({}, {
      get(_, prop) {
        if (prop === 'withSuccessHandler') return fn => makeRunner(fn, onFailure);
        if (prop === 'withFailureHandler') return fn => makeRunner(onSuccess, fn);
        if (prop === 'withUserObject') return () => makeRunner(onSuccess, onFailure);
        return (...args) => {
          setTimeout(() => {
            try {
              if (!API[prop]) throw new Error(`Demo 後端沒有函式 ${String(prop)}`);
              const result = API[prop](...args);
              if (onSuccess) onSuccess(result);
            } catch (err) {
              if (onFailure) onFailure(err); else console.error(err);
            }
          }, LATENCY_MS);
        };
      }
    });
  }
  window.google = window.google || {};
  window.google.script = window.google.script || {};
  Object.defineProperty(window.google.script, 'run', { get: () => makeRunner(null, null) });

  // 給 Demo 入口頁用
  window.MealDemo = { reset() { localStorage.removeItem(STORE_KEY); }, STORE_KEY };

  // --- Demo 標示（嵌在 iframe 時隱藏） ---
  const noBadge = document.currentScript && document.currentScript.hasAttribute('data-no-badge');
  if (window.self === window.top && !noBadge) {
    document.addEventListener('DOMContentLoaded', () => {
      const tag = document.createElement('a');
      tag.href = './';
      tag.textContent = 'DEMO・資料只存在你的瀏覽器 ↩';
      tag.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:99999;padding:6px 12px;border-radius:999px;' +
        'background:#e0562b;color:#fff;font:600 12px/1.4 system-ui,sans-serif;text-decoration:none;box-shadow:0 4px 12px rgba(0,0,0,.25)');
      document.body.appendChild(tag);
    });
  }
})();

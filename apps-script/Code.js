/**
 * @OnlyCurrentDoc
 * * Google Apps Script (Code.gs)
 * 後端主程式：「壹參壹參 | 一閃一閃 小食部」
 *
 * * [v6.22 更新 - Cache Rebuild (快取重建)] (*** 關鍵修復 ***)
 * - (新函式) `_runAndCacheKitchenQuery_SLOW`: 提取 KDS 慢速邏輯。
 * - (新函式) `_runAndCacheOcsQuery_SLOW`: 提取 OCS 慢速邏輯。
 * - (新函式) `rebuildAllCaches`: 負責「重建」所有快取。
 * - `getKitchenOrders()`: (重構) 簡化為「快取優先」，失敗則呼叫 `_run..._SLOW`。
 * - `getOcsOrders()`: (重構) 簡化為「快取優先」，失敗則呼叫 `_run..._SLOW`。
 * - `submitOrder()`: (修正) 不再清除快取，改為在 Lock 內呼叫 `rebuildAllCaches()`。
 * - `updateOrderStatus()`: (修正) 不再清除快取，改為在 Lock 內呼叫 `rebuildAllCaches()`。
 * - `markOrderPickedUp()`: (修正) 不再清除快取，改為在 Lock 內呼叫 `_runAndCacheOcsQuery_SLOW()`。
 * - `clearAllCaches()`: (已刪除)
 *
 * * [v6.21 更新 - CacheService (快取)]
 * - `getKitchenOrders()`: (快取) 新增 CacheService 邏輯，避免 429 錯誤。
 * ... (v6.21 其餘註解) ...
 *
 * * [v6.18 更新 - KDS 排序修復 (FIFO)]
 * ... (v6.18 其餘註解) ...
 *
 * * [v6.17 更新 - KDS排序/命名/G餐/捲動]
 * ... (v6.17 其餘註解) ...
 */

// --- 全域設定 ---
const SPREADSHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();
const MENU_SHEET = "菜單";
const TEMPLATE_SHEET = "Order#0";
const ORDER_SUMMARY_SHEET = "訂單";
const G_PILL_COMBO_NAME = "G餐-內用吃到飽"; // [v6.17] G餐

// [v6.21] CacheService (快取) 鍵值
const CACHE_KEY_ODEN = 'kds_oden_cache';
const CACHE_KEY_DRINKS = 'kds_drinks_cache';
const CACHE_KEY_OCS = 'ocs_cache';
const CACHE_EXPIRATION_SECONDS = 120; // 快取 2 分鐘 (KDS 仍會 5-10 秒刷新)

// --- 網頁服務 ---

/**
 * [v6.17] 路由：
 */
function doGet(e) {
  let template;
  
  if (e.parameter.page === 'kds_drinks') {
    // --- 顯示 飲料 KDS 廚房介面 ---
    template = HtmlService.createTemplateFromFile('kds_drinks');
    // [v6.17] 系統命名
    return template.evaluate().setTitle('KDS (飲料) | 壹參壹參 小食部').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    
  } else if (e.parameter.page === 'kds') {
    // --- 顯示 關東煮/套餐 KDS 廚房介面 ---
    template = HtmlService.createTemplateFromFile('kds_oden');
    // [v6.17] 系統命名
    return template.evaluate().setTitle('KDS (關東煮) | 壹參壹參 小食部').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    
  } else if (e.parameter.page === 'ocs') {
    // --- [v6.15] 顯示 OCS (TV 叫號) 介面 ---
    template = HtmlService.createTemplateFromFile('ocs');
    // [v6.17] 系統命名
    return template.evaluate().setTitle('OCS (叫號) | 壹參壹參 小食部').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    
  } else if (e.parameter.page === 'pickup') {
    // --- [v6.15] 顯示 Pickup (內部取餐) 介面 ---
    template = HtmlService.createTemplateFromFile('pickup');
    // [v6.17] 系統命名
    return template.evaluate().setTitle('Pickup (取餐) | 壹參壹參 小食部').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    
  } else {
    // --- 顯示 POS 收銀介面 (預設) ---
    template = HtmlService.createTemplateFromFile('index');
    // [v6.17] 系統命名
    return template.evaluate().setTitle('壹參壹參 | 一閃一閃 小食部').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
}

/**
 * (公開函式) 允許 HTML 介面呼叫此函式。
 */
function getHtmlContent(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


// --- 選單功能 (In Google Sheet) ---

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  // [v6.17] 系統命名
  ui.createMenu('壹參壹參 小食部')
    .addItem('執行初始設定 (Setup)', 'setup')
    .addToUi();
}

/**
 * 執行初始設定：
 * [v6.17] "Order#0" 範本新增 G餐 範例
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  // 1. 建立菜單 (A-D 品項, E-K 配方) 
  let menuSheet = ss.getSheetByName(MENU_SHEET);
  if (!menuSheet) {
    menuSheet = ss.insertSheet(MENU_SHEET);
    
    const headers = [
      '類別', '品名', '價格', '庫存', 
      'A餐-輕享款', 'B餐-輕享款', 'C餐-小豐盛', 'D餐-小豐盛', 'E餐-1+1+1', '', 'F餐-大滿足'
    ];
    menuSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    menuSheet.setFrozenRows(1);
    
    const sampleMenu = [
      ['套餐', 'A餐-輕享款', 50, 999], ['套餐', 'B餐-輕享款', 55, 999], ['套餐', 'C餐-小豐盛', 75, 999],
      ['套餐', 'D餐-小豐盛', 85, 999], ['套餐', 'E餐-1+1+1', 55, 999], ['套餐', 'F餐-大滿足', 140, 999],
      ['套餐', G_PILL_COMBO_NAME, 349, 999], // [v6.17] G餐
      ['關東煮', '海帶', 15, 20], ['關東煮', '米血', 15, 20], ['關東煮', '魚板', 15, 20],
      ['關東煮', '蘿蔔', 20, 20], ['關東煮', '玉米', 20, 20], ['關東煮', '油豆腐', 20, 20],
      ['關東煮', '百頁豆腐', 25, 20], ['關東煮', '貢丸', 25, 20], ['關東煮', '王子麵', 20, 20],
      ['飲料', '可樂', 25, 30], ['飲料', '雪碧', 25, 30], ['飲料', '檸檬紅茶', 30, 20],
      ['飲料', '藍柑汽水', 45, 20], ['飲料', '冬瓜茶', 35, 20], ['飲料', '果汁', 30, 20]
    ];
    menuSheet.getRange(2, 1, sampleMenu.length, 4).setValues(sampleMenu); 
    
    const recipeData = [
      ['蘿蔔', '蘿蔔', '蘿蔔', '蘿蔔', '15', '', '蘿蔔'],
      ['油豆腐', '百頁豆腐', '油豆腐', '百頁豆腐', '20', '', '玉米'],
      ['玉米', '貢丸', '玉米', '貢丸', '25', '', '百頁豆腐'],
      ['', '', '海帶', '魚板', '', '', '貢丸'],
      ['', '', '王子麵', '王子麵', '', '', '米血'],
      ['', '', '', '', '', '', '魚板'],
      ['', '', '', '', '', '', '油豆腐'],
      ['', '', '', '', '', '', '海帶'],
      ['', '', '', '', '', '', '王子麵'],
    ];
    menuSheet.getRange(2, 5, recipeData.length, 7).setValues(recipeData); 
    menuSheet.getRange("A:K").setHorizontalAlignment("center");
  }

  // 2. 建立訂單 (總表) - KDS & OCS 需要此表
  let orderSheet = ss.getSheetByName(ORDER_SUMMARY_SHEET);
  if (!orderSheet) {
    orderSheet = ss.insertSheet(ORDER_SUMMARY_SHEET);
    orderSheet.appendRow(['訂單ID', '取餐號碼', '時間戳記', '項目 (JSON)', '總金額', '狀態', '收銀員']);
    orderSheet.setFrozenRows(1);
    orderSheet.getRange("A:A").setNumberFormat('@'); 
    orderSheet.getRange("E:E").setNumberFormat('$#,##0'); 
  }
  
  // 3. 建立 "Order#0" 範本工作表
  let templateSheet = ss.getSheetByName(TEMPLATE_SHEET);
  if (!templateSheet) {
    templateSheet = ss.insertSheet(TEMPLATE_SHEET);
    
    // [v6.15] A/B 欄 (訂單資訊)
    const infoHeaders = [
      ["訂單資訊標題", "參數"],
      ["訂單確認時間", ""],
      ["取餐號碼", ""],
      ["時間", ""],
      ["總金額", ""],
      ["收銀員", ""],
      ["關東煮接單", ""],  // B7
      ["飲料接單", ""],    // B8
      ["關東煮準備中", ""], // B9
      ["飲料準備中", ""], // B10
      ["關東煮完成", ""],  // B11
      ["飲料完成", ""],    // B12
      ["已取餐", ""]       // B13
    ];
    templateSheet.getRange("A1:B13").setValues(infoHeaders);
    templateSheet.getRange("A1, B1").setFontWeight("bold");
    
    // C/D/E/F 欄 (品項)
    templateSheet.getRange("C1").setValue("類別").setFontWeight("bold");
    templateSheet.getRange("D1").setValue("品名").setFontWeight("bold");
    templateSheet.getRange("E1").setValue("數量").setFontWeight("bold");
    templateSheet.getRange("F1").setValue("價格").setFontWeight("bold");
    
    // [v6.17] 更新範本以包含 G餐
    const itemTemplateRows = sampleMenu.map(item => [item[0], item[1], '', item[2]]); 
    templateSheet.getRange(2, 3, itemTemplateRows.length, 4).setValues(itemTemplateRows); 
    
    // G/H/I 欄 (E套餐)
    templateSheet.getRange("G1").setValue("套餐E-15").setFontWeight("bold");
    templateSheet.getRange("H1").setValue("套餐E-20").setFontWeight("bold");
    templateSheet.getRange("I1").setValue("套餐E-25").setFontWeight("bold");
    
    // 設定格式
    templateSheet.getRange("A1:I1").setBackground("#f3f4f6").setHorizontalAlignment("center");
    const maxDataRow = Math.max(itemTemplateRows.length + 1, infoHeaders.length);
    templateSheet.getRange("A2:A" + maxDataRow).setBackground("#f9fafb");
    
    templateSheet.getRange("C:I").setHorizontalAlignment("center");
    templateSheet.getRange("B5").setNumberFormat('$#,##0');
    templateSheet.getRange("F:F").setNumberFormat('$#,##0');
    
    // [v6.15] 狀態欄
    templateSheet.getRange("B7:B13").setHorizontalAlignment("center");

    // 隱藏範本
    templateSheet.hideSheet();
  }

  // [v6.17] 系統命名
  ui.alert('壹參壹參 小食部', '系統設定完成！ (v6.17)', ui.ButtonSet.OK);
}


// --- 網頁後端 API (POS 收銀機) ---

function getMenuItems() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const menuSheet = ss.getSheetByName(MENU_SHEET);
    if (!menuSheet) throw new Error('找不到 "' + MENU_SHEET + '" 工作表分頁。');
    
    const lastRow = menuSheet.getLastRow();
    const lastCol = menuSheet.getLastColumn();
    
    if (lastRow <= 1) return []; 
    
    const menuData = menuSheet.getRange(2, 1, lastRow - 1, 4).getValues(); 
    let recipeData;
    if (lastCol <= 4) recipeData = [[]]; 
    else recipeData = menuSheet.getRange(1, 5, lastRow, (lastCol - 4)).getValues(); 

    const itemStockMap = {};
    const simpleItems = []; 

    menuData.forEach(row => {
      const category = row[0];
      const name = row[1].toString().trim();
      const price = parseFloat(row[2]);
      const stock = parseInt(row[3]);
      
      if (!name || isNaN(price)) return; 

      if (category !== '套餐') {
        const item = { category, name, price, stock: isNaN(stock) ? 0 : stock };
        itemStockMap[name] = item.stock;
        simpleItems.push(item);
      }
    });
    
    const recipeMap = {};
    const recipeHeaders = recipeData[0]; 
    
    for (let col = 0; col < recipeHeaders.length; col++) {
      const comboName = recipeHeaders[col].toString().trim(); 
      if (!comboName) continue; 
      
      const components = [];
      for (let row = 1; row < recipeData.length; row++) {
        const componentName = recipeData[row][col];
        if (componentName) components.push(componentName.toString().trim()); 
      }
      recipeMap[comboName] = components;
    }

    const menuItems = menuData.map(row => {
      const category = row[0];
      const name = row[1].toString().trim(); 
      const price = parseFloat(row[2]);
      
      if (!name || isNaN(price)) return null; 

      // [v6.17] G餐
      if (name === G_PILL_COMBO_NAME) {
         return { category, name, price, stock: 999, components: null };
      }

      let trueStock = 0;
      let componentParts = null;
      
      if (category === '套餐') {
        componentParts = recipeMap[name]; 
        if (!componentParts) {
          trueStock = 0; 
        } else if (componentParts[0] === "15") { 
          // --- E餐 (彈性套餐) ---
          let total15Stock = 0, total20Stock = 0, total25Stock = 0;
          simpleItems.forEach(item => {
            if (item.price === 15) total15Stock += item.stock;
            else if (item.price === 20) total20Stock += item.stock;
            else if (item.price === 25) total25Stock += item.stock;
          });
          trueStock = Math.min(total15Stock, total20Stock, total25Stock);
        } else {
          // --- A餐 (固定套餐) ---
          const componentStocks = componentParts.map(partName => itemStockMap[partName] || 0);
          trueStock = Math.min(...componentStocks);
        }
      } else {
        // --- 一般品項 ---
        trueStock = itemStockMap[name] || 0; 
      }
      return { category, name, price, stock: trueStock, components: componentParts };
    }).filter(item => item !== null && item.price > 0); 
    
    return menuItems;
    
  } catch (e) {
    Logger.log('讀取菜單失敗 (getMenuItems): ' + e.message);
    return []; 
  }
}

/**
 * [v6.22] 提交訂單 (G餐邏輯 + "重建"快取)
 */
function submitOrder(orderDataJSON) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); 
  
  let newSheetName = 'Order#Error'; 
  
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const menuSheet = ss.getSheetByName(MENU_SHEET);
    const orderSheet = ss.getSheetByName(ORDER_SUMMARY_SHEET); 
    
    const lastRow = menuSheet.getLastRow();
    const lastCol = menuSheet.getLastColumn();
    
    if (lastRow <= 1) {
      lock.releaseLock();
      return { success: false, message: '"菜單" 工作表是空的！' };
    }
    
    const orderData = JSON.parse(orderDataJSON);
    
    // [v6.17] G餐 檢查
    const isGPillOrder = orderData.items.some(item => item.name === G_PILL_COMBO_NAME);
    
    const menuData = menuSheet.getRange(2, 1, lastRow - 1, 4).getValues();
    const stockMap = {};  
    const itemRowMap = {}; 

    menuData.forEach((row, index) => {
      const name = row[1].toString().trim(); 
      const stock = parseInt(row[3]);
      if (name && row[0] !== '套餐') { 
        stockMap[name] = isNaN(stock) ? 0 : stock;
        itemRowMap[name] = index + 2; 
      }
    });

    let recipeData;
    if (lastCol <= 4) recipeData = [[]]; 
    else recipeData = menuSheet.getRange(1, 5, lastRow, (lastCol - 4)).getValues(); 
    
    const recipeMap = {}; 
    const recipeHeaders = recipeData[0]; 
    
    for (let col = 0; col < recipeHeaders.length; col++) {
      const comboName = recipeHeaders[col].toString().trim(); 
      if (!comboName) continue; 
      
      const components = [];
      for (let row = 1; row < recipeData.length; row++) {
        const componentName = recipeData[row][col];
        if (componentName) components.push(componentName.toString().trim()); 
      }
      recipeMap[comboName] = components;
    }

    const stockUpdates = {}; 
    let hasOdenOrCombo = false;
    let hasDrinks = false;
    
    for (const item of orderData.items) {
      const itemName = item.name;
      const quantity = item.quantity;
      
      // [v6.17] G餐 不參與 KDS 
      if (isGPillOrder) {
         // (G餐 訂單) 不設定 hasOdenOrCombo / hasDrinks
      } else {
        if (item.category === '關東煮' || item.category === '套餐') {
          hasOdenOrCombo = true;
        } else if (item.category === '飲料') {
          hasDrinks = true;
        }
      }
      
      // [v6.17] G餐 不扣庫存
      if (item.name === G_PILL_COMBO_NAME) {
        continue;
      }
      
      if (item.type === 'simple') {
        stockUpdates[itemName] = (stockUpdates[itemName] || 0) + quantity;
      } else if (item.type === 'combo') { // E餐
        if (item.components) {
          item.components.forEach(component => {
            if (component && component.name) {
              const componentName = component.name.trim();
              stockUpdates[componentName] = (stockUpdates[componentName] || 0) + quantity;
            }
          });
        }
      } else if (item.type === 'fixed_combo') { // A餐
        const recipe = recipeMap[itemName]; 
        if (recipe) {
          recipe.forEach(partName => {
            stockUpdates[partName] = (stockUpdates[partName] || 0) + quantity;
          });
        }
      }
    }
    
    for (const itemName in stockUpdates) {
      const required = stockUpdates[itemName];
      const available = stockMap[itemName];
      if (available === undefined) {
        lock.releaseLock();
        return { success: false, message: `"${itemName}" 在菜單庫存中找不到！(請檢查配方)` };
      }
      if (required > available) {
        lock.releaseLock();
        return { success: false, message: `"${itemName}" 庫存不足！ (需要: ${required}, 僅剩: ${available})` };
      }
    }
    
    for (const itemName in stockUpdates) {
      const sheetRow = itemRowMap[itemName]; 
      if (sheetRow) {
        const required = stockUpdates[itemName];
        const currentStock = stockMap[itemName] || 0;
        const newStock = currentStock - required;
        menuSheet.getRange(sheetRow, 4).setValue(newStock); // D欄
      }
    }
    
    SpreadsheetApp.flush(); 
    
    const { newSheetName: generatedSheetName, newPickupNumber } = getNewOrderInfo(ss);
    newSheetName = generatedSheetName; 
    const pickupNumber = newPickupNumber;
    
    const timestamp = new Date();
    const user = Session.getActiveUser().getEmail() || '未知使用者';
    const orderId = newSheetName; 
    
    const templateSheet = ss.getSheetByName(TEMPLATE_SHEET);
    if (templateSheet) {
      
      const newOrderSheet = templateSheet.copyTo(ss);
      newOrderSheet.setName(newSheetName);
      
      newOrderSheet.getRange("B2").setValue(timestamp); 
      newOrderSheet.getRange("B3").setValue(pickupNumber); 
      newOrderSheet.getRange("B4").setValue(Utilities.formatDate(timestamp, Session.getScriptTimeZone(), "HH:mm:ss")); 
      newOrderSheet.getRange("B5").setValue(orderData.total); 
      newOrderSheet.getRange("B6").setValue(user); 
      
      // [v6.17] 狀態邏輯 (B7 / B8) - G餐 除外
      if (hasOdenOrCombo) {
        newOrderSheet.getRange("B7").setValue(1); // "關東煮接單" = 1
      }
      if (hasDrinks) {
        newOrderSheet.getRange("B8").setValue(1); // "飲料接單" = 1
      }
      
      // [v6.17] G餐 直接設為 "已取餐"
      if (isGPillOrder) {
        newOrderSheet.getRange("B13").setValue(1); // "已取餐" = 1
      }
      
      const templateItemRange = newOrderSheet.getRange("D2:D" + newOrderSheet.getLastRow()).getValues();
      const itemRowMapInTemplate = {};
      templateItemRange.forEach((row, index) => {
        const name = row[0].toString().trim();
        if (name) itemRowMapInTemplate[name] = index + 2; 
      });
      
      let eComboWriteRow = 2; 
      let totalEComboQuantity = 0; 

      for (const item of orderData.items) {
        
        if (item.type === 'combo') {
          totalEComboQuantity += item.quantity; 

          if (item.components) {
            const e15 = item.components.find(c => c.price == 15)?.name || '';
            const e20 = item.components.find(c => c.price == 20)?.name || '';
            const e25 = item.components.find(c => c.price == 25)?.name || '';
            
            for (let i = 0; i < item.quantity; i++) {
              newOrderSheet.getRange(eComboWriteRow, 7, 1, 3).setValues([[e15, e20, e25]]);
              eComboWriteRow++; 
            }
          }
        } else {
          // [v6.17] G餐 也需要寫入數量
          const rowNum = itemRowMapInTemplate[item.name];
          if (rowNum) {
            newOrderSheet.getRange(rowNum, 5).setValue(item.quantity); 
          }
        }
      } 
      
      const eComboRowNum = itemRowMapInTemplate["E餐-1+1+1"]; 
      if (eComboRowNum && totalEComboQuantity > 0) {
        newOrderSheet.getRange(eComboRowNum, 5).setValue(totalEComboQuantity);
      }
      
      newOrderSheet.showSheet();
      newOrderSheet.activate();
      
    } else {
      Logger.log('[submitOrder Error] 找不到範本工作表 "Order#0"！');
      lock.releaseLock();
      return { success: false, message: '伺服器錯誤: 找不到 Order#0 範本！' };
    }
    
    if (orderSheet) {
      // [v6.17] G餐 邏輯
      let initialStatus;
      if (isGPillOrder) {
        initialStatus = 'completed'; // G餐 直接完成
      } else {
        initialStatus = (hasOdenOrCombo || hasDrinks) ? 'pending' : 'ready_for_pickup'; 
      }
      
      orderSheet.appendRow([
        orderId, 
        pickupNumber, 
        timestamp, 
        orderDataJSON, 
        orderData.total, 
        initialStatus, 
        user
      ]);
    }

    // [v6.22] *** 重建快取 (關鍵修正) ***
    // 成功送出訂單，強制「重建」所有 KDS 和 OCS 快取
    // (注意：這必須在 lock.releaseLock() 之前執行！)
    rebuildAllCaches();
    
    lock.releaseLock();
    
    Logger.log("訂單成功: " + pickupNumber + " (已建立 " + newSheetName + ")");
    return { success: true, pickupNumber: pickupNumber };

  } catch (e) {
    lock.releaseLock(); 
    Logger.log('submitOrder 失敗: ' + e.message + "\n" + e.stack);
    return { success: false, message: '伺服器錯誤: ' + e.message };
  }
}


// --- 網頁後端 API (KDS 廚房) ---

/**
 * [v6.22] (新) KDS 慢速邏輯：
 * 執行 Google Sheet 查詢，並將結果存入快取。
 */
function _runAndCacheKitchenQuery_SLOW(type, cacheKey, cache) {
  Logger.log(`Cache MISS (快取失效): ${cacheKey}. 正在從 Google Sheet 讀取...`);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const orderSheet = ss.getSheetByName(ORDER_SUMMARY_SHEET);
    if (!orderSheet) throw new Error("找不到 '訂單' 總表！");
    
    const lastRow = orderSheet.getLastRow();
    if (lastRow <= 1) return []; 

    const data = orderSheet.getRange(2, 1, lastRow - 1, 7).getValues(); // A:G
    
    // (讀取配方 - KDS 需要顯示 E餐/A餐 子項)
    const menuSheet = ss.getSheetByName(MENU_SHEET);
    const lastMenuRow = menuSheet.getLastRow();
    const lastMenuCol = menuSheet.getLastColumn();
    let recipeData;
    if (lastMenuCol <= 4) recipeData = [[]];
    else recipeData = menuSheet.getRange(1, 5, lastMenuRow, (lastMenuCol - 4)).getValues(); 
    
    const recipeMap = {};
    const recipeHeaders = recipeData[0];
    for (let col = 0; col < recipeHeaders.length; col++) {
      const comboName = recipeHeaders[col].toString().trim();
      if (!comboName) continue;
      const components = [];
      for (let row = 1; row < recipeData.length; row++) {
        if (recipeData[row][col]) components.push(recipeData[row][col].toString().trim());
      }
      recipeMap[comboName] = components;
    }

    const pendingOrders = [];
    
    // [v6.18] KDS 排序 (升冪/FIFO)
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const orderName = row[0]; 
      const pickupNumber = row[1]; 
      const orderJSON = row[3]; 
      const status = row[5]; 
      
      // KDS 抓取 pending / preparing
      if (status === 'pending' || status === 'preparing') {
        const orderData = JSON.parse(orderJSON);
        
        // (v6.17 G餐安全網) 排除 G餐 (G餐 不應出現在 KDS)
        const hasGPill = orderData.items.some(item => item.name === G_PILL_COMBO_NAME);
        if (hasGPill) {
           continue; 
        }
        
        const filteredItems = orderData.items.filter(item => {
          if (type === 'oden') {
            return item.category === '關東煮' || item.category === '套餐';
          } else if (type === 'drinks') {
            return item.category === '飲料';
          }
          return false;
        });
        
        // 如果這個 KDS 類別沒有品項，就跳過
        if (filteredItems.length === 0) {
          continue; 
        }

        const kdsItems = filteredItems.map(item => {
          let componentsForKDS = [];
          let isCombo = false;
          
          if (item.type === 'combo') { // E餐
            isCombo = true;
            if (item.components) {
              const e15 = item.components.find(c => c.price == 15)?.name || '';
              const e20 = item.components.find(c => c.price == 20)?.name || '';
              const e25 = item.components.find(c => c.price == 25)?.name || '';
              for (let q = 0; q < item.quantity; q++) {
                componentsForKDS.push([e15, e20, e25]);
              }
            }
          } else if (item.type === 'fixed_combo') { // A餐
            isCombo = true;
            const recipe = recipeMap[item.name]; 
            if (recipe) {
              componentsForKDS = recipe; 
            }
          }
          
          return {
            name: item.name,
            quantity: item.quantity,
            isCombo: isCombo,
            components: componentsForKDS
          };
        });
        
        pendingOrders.push({
          orderName: orderName,
          pickupNumber: pickupNumber,
          items: kdsItems,
          status: status // KDS 仍需 "總表" 狀態 (pending/preparing) 來決定按鈕
        });
      }
    }
    
    // [v6.22] *** 4. 寫入快取 (慢車道結束) ***
    try {
      cache.put(cacheKey, JSON.stringify(pendingOrders), CACHE_EXPIRATION_SECONDS);
      Logger.log(`Cache SET (快取建立): ${cacheKey}`);
    } catch (e) {
      Logger.log(`Cache (寫入) 失敗: ${e}`);
    }
    
    return pendingOrders; // [v6.18] 這裡現在是 FIFO (升冪)

  } catch (e) {
    Logger.log('[_runAndCacheKitchenQuery_SLOW] 失敗: ' + e.message);
    // [v6.22] 發生錯誤時，回傳空陣列，並*不*快取 (避免快取錯誤的空資料)
    return []; 
  }
}

/**
 * [v6.22] 獲取 KDS 訂單 (依類別) (FIFO 排序 + CacheService)
 * (此函數已重構為僅處理快取邏輯)
 */
function getKitchenOrders(type) {
  
  // [v6.21] *** 1. 決定 Cache Key ***
  let cacheKey;
  if (type === 'oden') {
    cacheKey = CACHE_KEY_ODEN;
  } else if (type === 'drinks') {
    cacheKey = CACHE_KEY_DRINKS;
  } else {
    return []; // 未知類型
  }
  
  const cache = CacheService.getScriptCache();
  
  // [v6.21] *** 2. 檢查快取 (快車道) ***
  try {
    const cachedData = cache.get(cacheKey);
    if (cachedData != null) {
      Logger.log(`Cache HIT (快取命中): ${cacheKey}`);
      return JSON.parse(cachedData); // 從記憶體回傳 (超快)
    }
  } catch (e) {
    Logger.log(`Cache (讀取) 失敗: ${e}`);
  }

  // [v6.22] *** 3. 快取不存在 (慢車道)，呼叫私有函數執行讀取和快取 ***
  return _runAndCacheKitchenQuery_SLOW(type, cacheKey, cache);
}

/**
 * [v6.22] KDS 呼叫：更新訂單狀態 (智慧邏輯 + "重建"快取)
 */
function updateOrderStatus(orderName, newStatus, type) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // 1. [v6.15] 更新 "Order#..." 工作表 (B7-B12)
    const orderSheet = ss.getSheetByName(orderName);
    if (!orderSheet) {
      lock.releaseLock();
      return { success: false, message: `找不到工作表 ${orderName}` };
    }
    
    if (type === 'oden') {
      if (newStatus === 'preparing') {
        orderSheet.getRange("B7").setValue(""); // 清除 "接單"
        orderSheet.getRange("B9").setValue(1); // 設定 "準備中"
      } else if (newStatus === 'ready') {
        orderSheet.getRange("B9").setValue(""); // 清除 "準備中"
        orderSheet.getRange("B11").setValue(1); // 設定 "完成"
      }
    } else if (type === 'drinks') {
        if (newStatus === 'preparing') {
        orderSheet.getRange("B8").setValue(""); // 清除 "接單"
        orderSheet.getRange("B10").setValue(1); // 設定 "準備中"
      } else if (newStatus === 'ready') {
        orderSheet.getRange("B10").setValue(""); // 清除 "準備中"
        orderSheet.getRange("B12").setValue(1); // 設定 "完成"
      }
    }
    
    SpreadsheetApp.flush(); // 立即寫入 B11 / B12

    // 2. [v6.15] *** 智慧邏輯：檢查是否需要更新 "訂單" 總表 (F 欄) ***
    const summarySheet = ss.getSheetByName(ORDER_SUMMARY_SHEET);
    if (summarySheet) {
      
      // 2a. 讀取 "Order#..." 工作表的所有狀態 (B7 ~ B12)
      const statusRange = orderSheet.getRange("B7:B12").getValues();
      const odenPending = statusRange[0][0];   // B7
      const drinksPending = statusRange[1][0];  // B8
      const odenPreparing = statusRange[2][0]; // B9
      const drinksPreparing = statusRange[3][0]; // B10
      const odenReady = statusRange[4][0];     // B11
      const drinksReady = statusRange[5][0];     // B12
      
      // 2b. 決定 "總表" 狀態
      let masterStatus = 'unknown'; 
      
      const odenNeeded = (odenPending || odenPreparing || odenReady);
      const drinksNeeded = (drinksPending || drinksPreparing || drinksReady);
      
      let isOrderReady = false;
      
      if (odenNeeded && drinksNeeded) {
        // 情況 A: 兩邊都需要 (B7=1 且 B8=1)
        isOrderReady = (odenReady && drinksReady); // B11=1 且 B12=1
      } else if (odenNeeded) {
        // 情況 B: 僅有關東煮 (B7=1 且 B8=空)
        isOrderReady = odenReady; // B11=1
      } else if (drinksNeeded) {
        // 情況 C: 僅有飲料 (B7=空 且 B8=1)
        isOrderReady = drinksReady; // B12=1
      }
      
      if (isOrderReady) {
        masterStatus = 'ready_for_pickup'; // [v6.15] 新狀態
      } else if (odenPreparing || drinksPreparing) {
        masterStatus = 'preparing'; 
      } else if (odenPending || drinksPending) {
        masterStatus = 'pending'; 
      }
      
      // 2c. 更新 "總表" F 欄
      if (masterStatus !== 'unknown') {
        const data = summarySheet.getRange(2, 1, summarySheet.getLastRow() - 1, 1).getValues(); // A欄 (ID)
        for (let i = 0; i < data.length; i++) {
          if (data[i][0] === orderName) {
            summarySheet.getRange(i + 2, 6).setValue(masterStatus); // F欄 (狀態)
            break;
          }
        }
      }
    }
    
    // [v6.22] *** 重建快取 (關鍵修正) ***
    // KDS 按下按鈕，強制「重建」所有 KDS 和 OCS 快取
    // (注意：這必須在 lock.releaseLock() 之前執行！)
    rebuildAllCaches();
    
    lock.releaseLock();
    
    return { success: true, message: `${orderName} 狀態已更新為 ${newStatus} (${type})` };

  } catch (e) {
    lock.releaseLock();
    Logger.log('updateOrderStatus 失敗: ' + e.message + "\n" + e.stack);
    throw new Error('更新狀態失敗: ' + e.message);
  }
}


// --- 網頁後端 API (OCS & Pickup) ---

/**
 * [v6.22] (新) OCS 慢速邏輯：
 * 執行 Google Sheet 查詢，並將結果存入快取。
 */
function _runAndCacheOcsQuery_SLOW(cacheKey, cache) {
  Logger.log(`Cache MISS (快取失效): ${cacheKey}. 正在從 Google Sheet 讀取...`);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const orderSheet = ss.getSheetByName(ORDER_SUMMARY_SHEET);
    if (!orderSheet) throw new Error("找不到 '訂單' 總表！");
    
    const lastRow = orderSheet.getLastRow();
    if (lastRow <= 1) return { preparingOrders: [], readyOrders: [] }; 

    const data = orderSheet.getRange(2, 1, lastRow - 1, 7).getValues(); // A:G

    const preparingOrders = [];
    const readyOrders = [];
    
    // [v6.15] (Q3 邏輯) 從 "最舊" 的開始往前找 (FIFO)
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const orderName = row[0]; 
      const pickupNumber = row[1]; 
      const status = row[5]; 
      
      const orderInfo = {
        orderName: orderName,
        pickupNumber: pickupNumber,
      };

      if (status === 'preparing') {
        preparingOrders.push(orderInfo); // FIFO
      } else if (status === 'ready_for_pickup') {
        readyOrders.push(orderInfo); // FIFO
      }
    }
    
    // [v6.15] (Q3 邏輯) "準備中" 降冪 (最新) 排列
    preparingOrders.reverse();
    
    const ocsData = { preparingOrders, readyOrders };
    
    // [v6.22] *** 3. 寫入快取 (慢車道結束) ***
    try {
      cache.put(cacheKey, JSON.stringify(ocsData), CACHE_EXPIRATION_SECONDS);
      Logger.log(`Cache SET (快取建立): ${cacheKey}`);
    } catch (e) {
      Logger.log(`Cache (寫入) 失敗: ${e}`);
    }
    
    return ocsData;

  } catch (e) {
    Logger.log('[_runAndCacheOcsQuery_SLOW] 失敗: ' + e.message);
    // [v6.22] 發生錯誤時，回傳空物件，並*不*快取 (避免快取錯誤)
    return { preparingOrders: [], readyOrders: [] }; 
  }
}


/**
 * [v6.22] OCS 讀取 (準備中 LIFO / 待取餐 FIFO + CacheService)
 * (此函數已重構為僅處理快取邏輯)
 */
function getOcsOrders() {
  
  // [v6.21] *** 1. 檢查快取 (快車道) ***
  const cache = CacheService.getScriptCache();
  try {
    const cachedData = cache.get(CACHE_KEY_OCS);
    if (cachedData != null) {
      Logger.log(`Cache HIT (快取命中): ${CACHE_KEY_OCS}`);
      return JSON.parse(cachedData); // 從記憶體回傳 (超快)
    }
  } catch (e) {
    Logger.log(`Cache (讀取) 失敗: ${e}`);
  }

  // [v6.22] *** 2. 快取不存在 (慢車道)，呼叫私有函數執行讀取和快取 ***
  return _runAndCacheOcsQuery_SLOW(CACHE_KEY_OCS, cache);
}

/**
 * [v6.22] (新) Pickup 系統呼叫 ("重建" OCS 快取)
 */
function markOrderPickedUp(orderName) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // 1. 更新 "Order#..." 工作表
    const orderSheet = ss.getSheetByName(orderName);
    if (orderSheet) {
      orderSheet.getRange("B13").setValue(1); // "已取餐" = 1
    } else {
      Logger.log(`[markOrderPickedUp Warn] 找不到工作表: ${orderName}`);
    }
    
    // 2. 更新 "訂單" 總表
    const summarySheet = ss.getSheetByName(ORDER_SUMMARY_SHEET);
    if (summarySheet) {
      const data = summarySheet.getRange(2, 1, summarySheet.getLastRow() - 1, 1).getValues(); 
      for (let i = 0; i < data.length; i++) {
        if (data[i][0] === orderName) {
          summarySheet.getRange(i + 2, 6).setValue('completed'); // F欄 (狀態)
          break;
        }
      }
    }
    
    // [v6.22] *** 重建 OCS 快取 (關鍵修正) ***
    // (只重建 OCS 即可，因為 KDS 不受影響)
    // (注意：這必須在 lock.releaseLock() 之前執行！)
    try {
      _runAndCacheOcsQuery_SLOW(CACHE_KEY_OCS, CacheService.getScriptCache());
    } catch(e) {
      Logger.log(`OCS Cache (重建) 失敗: ${e}`);
    }
    
    lock.releaseLock();
    
    return { success: true, message: `${orderName} 已標記為 "completed"` };

  } catch (e) {
    lock.releaseLock();
    Logger.log('markOrderPickedUp 失敗: ' + e.message);
    throw new Error('更新取餐狀態失敗: ' + e.message);
  }
}


// --- 輔助函式 ---

/**
 * [v6.22] (新) 強制「重建」所有 KDS 和 OCS 快取
 * - POS (submitOrder) 和 KDS (updateOrderStatus) 會呼叫此函式
 * - (注意：此函數應在 Lock 鎖定下呼叫)
 */
function rebuildAllCaches() {
  try {
    const cache = CacheService.getScriptCache();
    
    // 1. 重建 KDS (關東煮)
    _runAndCacheKitchenQuery_SLOW('oden', CACHE_KEY_ODEN, cache);
    
    // 2. 重建 KDS (飲料)
    _runAndCacheKitchenQuery_SLOW('drinks', CACHE_KEY_DRINKS, cache);
    
    // 3. 重建 OCS (叫號)
    _runAndCacheOcsQuery_SLOW(CACHE_KEY_OCS, cache);

    Logger.log(`Cache REBUILT (重建快取): ${[CACHE_KEY_ODEN, CACHE_KEY_DRINKS, CACHE_KEY_OCS].join(', ')}`);
  } catch (e) {
    Logger.log(`Cache (重建全部) 失敗: ${e}`);
  }
}


/**
 * [v6.6] 取得新的訂單編號和取餐號碼
 */
function getNewOrderInfo(ss) {
  const allSheets = ss.getSheets();
  let maxOrderNum = 0;
  let lastOrderSheet = null;
  
  allSheets.forEach(s => {
    const sheetName = s.getName();
    if (sheetName.startsWith("Order#")) {
      const num = parseInt(sheetName.split("#")[1]);
      if (num > maxOrderNum) {
        maxOrderNum = num;
        lastOrderSheet = s; 
      }
    }
  });
  
  const newOrderNum = maxOrderNum + 1;
  const newSheetName = "Order#" + newOrderNum;
  let newPickupNumber = 1;

  if (lastOrderSheet) {
    try {
      const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
      const lastOrderData = lastOrderSheet.getRange("B2:B3").getValues();
      const lastOrderDateValue = lastOrderData[0][0]; 
      const lastPickupNumber = lastOrderData[1][0]; 
      
      if (lastOrderDateValue instanceof Date) {
        const lastOrderDate = Utilities.formatDate(lastOrderDateValue, Session.getScriptTimeZone(), "yyyy-MM-dd");
        if (lastOrderDate === today) newPickupNumber = (parseInt(lastPickupNumber) || 0) + 1;
        else newPickupNumber = 1; 
      } else newPickupNumber = 1;
    } catch (e) {
      newPickupNumber = 1;
    }
  }
  
  return { newSheetName, newPickupNumber };
}



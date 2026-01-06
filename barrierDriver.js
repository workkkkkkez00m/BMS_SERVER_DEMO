const ModbusRTU = require("modbus-serial");
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'barrier_config.json');
// ★ 預設設定(當 config 檔案不存在時)
const DEFAULT_CONFIG = {
    "b1f": [
        {
            "name": "汽車柵欄機控制器", // 用於前端顯示
            "ip": "127.0.0.1",
            "port": 502,
            "slaveId": 1,
            "units": [
                // id: B_IN (汽車入口)
                { "id": "B_IN", "openAddr": 0, "closeAddr": 1, "faultAddr": 4, "locationName": "汽車入口柵欄" },
                // id: B_OUT (汽車出口)
                { "id": "B_OUT", "openAddr": 2, "closeAddr": 3, "faultAddr": 5, "locationName": "汽車出口柵欄" }
            ]
        },
        {
            "name": "機車柵欄機控制器", // 用於前端顯示
            "ip": "127.0.0.2", // 範例：機車使用不同 IP
            "port": 502,
            "slaveId": 1,
            "units": [
                // id: MB_IN (機車入口)
                { "id": "MB_IN", "openAddr": 0, "closeAddr": 1, "faultAddr": 4, "locationName": "機車入口柵欄" },
                // id: MB_OUT (機車出口)
                { "id": "MB_OUT", "openAddr": 2, "closeAddr": 3, "faultAddr": 5, "locationName": "機車出口柵欄" }
            ]
        }
    ]
};

let LIVE_MODBUS_CONFIG = {};

const LIVE_DATA_CACHE = {};

// ★★★ 總開關：切換模擬模式或正式 Modbus 模式 ★★★
// true = 使用下面的 "SIMULATED_DATA" (用於展示/測試)
// false = 使用 "LIVE_MODBUS_CONFIG" (用於正式上線)
const USE_SIMULATION_MODE = false; // 預設先開啟模擬模式

// (A) 模擬模式：使用的資料
const SIMULATED_DATA = {
    "b1f": [
        { id: "B_IN", name: "Barrier_In", locationName: "汽車入口柵欄", status: "fault" },
        { id: "B_OUT", name: "Barrier_Out", locationName: "汽車出口柵欄", status: "closed" },
        { id: "MB_IN", name: "Bike_Barrier_In", locationName: "機車入口柵欄", status: "closed" },
        { id: "MB_OUT", name: "Bike_Barrier_Out", locationName: "機車出口柵欄", status: "closed" }
    ]
    // 如果有其他樓層，可以在這裡新增
};

// (A-2) 模擬模式的輔助邏輯 (例如自動復歸)
// 這裡可以設定是否啟用自動關閉功能
const ENABLE_AUTO_CLOSE_SIMULATION = false; 

if (USE_SIMULATION_MODE && ENABLE_AUTO_CLOSE_SIMULATION) {
    console.log("[Barrier Driver] 模擬模式：已啟用自動關閉功能。");
    // 模擬柵欄開啟一段時間後自動關閉
    setInterval(() => {
        Object.values(SIMULATED_DATA).forEach(floorBarriers => {
            floorBarriers.forEach(barrier => {
                if (barrier.status === 'open') {                    
                    if (!barrier.openTime) {
                        barrier.openTime = Date.now();
                    } else if (Date.now() - barrier.openTime > 10000) { // 10秒後自動關閉
                        barrier.status = 'closed';
                        delete barrier.openTime;
                        console.log(`[Barrier Driver][模擬] ${barrier.locationName} 已自動關閉。`);
                    }
                }
            });
        });
    }, 1000);
}

let wss_broadcast = () => {};

// (B) 正式 Modbus 模式：使用的設定與邏輯

// ★ 正式上線的 Modbus 設定 (請依實際設備修改 IP, Port, SlaveID 和 Address)
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            LIVE_MODBUS_CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH));
            console.log('[Barrier Driver] 成功從 barrier_config.json 載入設定。');
        } else {
            LIVE_MODBUS_CONFIG = DEFAULT_CONFIG;
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 4));
            console.log('[Barrier Driver] barrier_config.json 不存在，已建立預設檔案。');
        }
    } catch (error) {
        console.error('[Barrier Driver] 載入 barrier_config.json 失敗:', error);
        LIVE_MODBUS_CONFIG = DEFAULT_CONFIG;
    }
    
    Object.keys(LIVE_MODBUS_CONFIG).forEach(floor => {
        LIVE_MODBUS_CONFIG[floor].forEach(controller => {
            if (!controller.client) {
                controller.client = new ModbusRTU();
            }
        });
    });
}

//儲存連線設定 (給 API 呼叫)

async function saveFloorConfig(floor, newConfigData) {
    if (!LIVE_MODBUS_CONFIG[floor]) return false;
    
    try {
        // 1. 更新記憶體 (保持不變)
        for (let i = 0; i < LIVE_MODBUS_CONFIG[floor].length; i++) {
            const existingController = LIVE_MODBUS_CONFIG[floor][i]; 
            const newControllerData = newConfigData[i];
            
            existingController.ip = newControllerData.ip;
            existingController.port = parseInt(newControllerData.port, 10);
            existingController.slaveId = parseInt(newControllerData.slaveId, 10);

            if (Array.isArray(newControllerData.units)) {
                newControllerData.units.forEach(newUnit => {
                    const existingUnit = existingController.units.find(u => u.id === newUnit.id);
                    if (existingUnit) {
                        existingUnit.openAddr = parseInt(newUnit.openAddr, 10);
                        existingUnit.closeAddr = parseInt(newUnit.closeAddr, 10);
                        existingUnit.faultAddr = parseInt(newUnit.faultAddr, 10);
                    }
                });
            }
        }
        
        // 2. 準備寫入的設定物件 (移除 client 屬性)
        const configToSave = {};
        Object.keys(LIVE_MODBUS_CONFIG).forEach(f => {            
            configToSave[f] = LIVE_MODBUS_CONFIG[f].map(controller => {
                const { client, ...rest } = controller;
                return rest;
            });
        });
        
        // 3. 寫入檔案
        await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(configToSave, null, 4));
        
        // 4. 銷毀所有舊連線
        LIVE_MODBUS_CONFIG[floor].forEach(controller => {
            if (controller.client) {
                controller.client.close(() => {});
                controller.client = null; 
            }
        });
        
        console.log(`[Barrier Driver] ${floor} 的完整設定已儲存。`);
        return true;
    } catch (error) {
        console.error(`[Barrier Driver] 儲存 barrier_config.json 失敗:`, error);
        return false;
    }
}

//獲取目前設定 (給 API 呼叫)

function getConfig() {    
    const configToReturn = {};
    Object.keys(LIVE_MODBUS_CONFIG).forEach(f => {
        if (Array.isArray(LIVE_MODBUS_CONFIG[f])) {            
            configToReturn[f] = LIVE_MODBUS_CONFIG[f].map(controller => {
                const { client, ...rest } = controller; 
                return rest;
            });
        }
    });
    return configToReturn;
}
// ★ 確保 Modbus 連線的輔助函式
async function ensureConnection(controllerConfig) {
    if (!controllerConfig.client) {
        controllerConfig.client = new ModbusRTU();
    }
    if (controllerConfig.client.isOpen) {
        return true;
    }
    try {
        await controllerConfig.client.connectTCP(controllerConfig.ip, { port: controllerConfig.port });
        controllerConfig.client.setID(controllerConfig.slaveId);
        controllerConfig.client.setTimeout(5000);
        //console.log(`[Barrier Driver] 已連接到 ${controllerConfig.ip}`);
        return true;
    } catch (err) {
        //console.error(`[Barrier Driver] 連接 ${controllerConfig.ip} 失敗:`, err.message);
        if (controllerConfig.client) {
            controllerConfig.client.close(() => {});
            controllerConfig.client = null;
        }
        return false;
    }
}

// ★ 在背景輪詢 Modbus 數據的函式 (讀取柵欄狀態)
async function pollModbusData() {
    for (const floor of Object.keys(LIVE_MODBUS_CONFIG)) {
        // 遍歷該樓層的「所有控制器」(例如 汽車控制器、機車控制器)
        for (const controller of LIVE_MODBUS_CONFIG[floor]) {
            
            let isConnected = false;
            let controllerUnits = controller.units;
            
            try {                
                isConnected = await ensureConnection(controller);

                if (isConnected) {                    
                    for (const unit of controllerUnits) {
                        // 1. 讀取「開啟」訊號 (使用 openAddr)
                        const openResp = await controller.client.readCoils(unit.openAddr + 1, 1);
                        const isOpen = openResp.data[0];

                        // 2. 讀取「故障」訊號 (使用 faultAddr)
                        const faultResp = await controller.client.readCoils(unit.faultAddr + 1, 1);
                        const isFault = faultResp.data[0];

                        // 3. 判斷最終狀態
                        let newStatus = 'closed';
                        if (isFault) {
                            newStatus = 'fault';
                        } else if (isOpen) {
                            newStatus = 'open';
                        }

                        // 4. 檢查快取並廣播
                        const cachedUnit = LIVE_DATA_CACHE[floor].find(u => u.id === unit.id);
                        if (cachedUnit && cachedUnit.status !== newStatus) {
                            cachedUnit.status = newStatus;
                            console.log(`[Barrier Driver][Modbus] ${unit.locationName} 狀態變更為: ${newStatus}`);
                            wss_broadcast({
                                type: 'barrier_update',
                                data: cachedUnit
                            });
                        }
                    }
                }
            } catch (err) {
                console.error(`[Barrier Driver] 輪詢 ${controller.ip} 失敗 (讀取錯誤):`, err.message);
                if (controller.client) {
                    controller.client.close(() => {});
                    controller.client = null;
                }
               
                isConnected = false;
            }
            
            // 5. 如果連線失敗 (或讀取失敗)，廣播 "unknown"
            if (!isConnected) {
                controllerUnits.forEach(unit => {
                    const cachedUnit = LIVE_DATA_CACHE[floor].find(u => u.id === unit.id);
                    // 只有在狀態「不是」unknown 的時候，才更新並廣播
                    if (cachedUnit && cachedUnit.status !== "unknown") {
                        cachedUnit.status = "unknown";
                        console.log(`[Barrier Driver][Modbus] ${unit.locationName} 狀態變更為: unknown (連線失敗)`);
                        wss_broadcast({
                            type: 'barrier_update',
                            data: cachedUnit
                        });
                    }
                });
            }
        }
    }
}

// (C) 導出的公開函式 啟動驅動程式
function start(broadcastFunction) {
        
    if (broadcastFunction) {
        wss_broadcast = broadcastFunction;
        console.log("[Barrier Driver] 廣播函式已註冊。");
    }

    if (USE_SIMULATION_MODE) {
        console.log("[Barrier Driver] 驅動已啟動 (模式: 模擬)。");
        // 模擬模式不需要載入設定
    } else {
        console.log("[Barrier Driver] 驅動已啟動 (模式: 正式 Modbus)。");
        loadConfig();         
        
        LIVE_DATA_CACHE['b1f'] = [];
        for (const floor of Object.keys(LIVE_MODBUS_CONFIG)) {
            LIVE_MODBUS_CONFIG[floor].forEach(controller => {
                controller.units.forEach(unit => {
                    LIVE_DATA_CACHE[floor].push({
                        id: unit.id,
                        locationName: unit.locationName,
                        status: "unknown"
                    });
                });
            });
        }
        setInterval(pollModbusData, 1000);
    }
}

// 根據樓層獲取柵欄機資料
function getDataByFloor(floor) {
    if (USE_SIMULATION_MODE) {
        return SIMULATED_DATA[floor] || [];
    } else {
        return LIVE_DATA_CACHE[floor] || [];
    }
}

//控制柵欄機開關
async function controlBarrier(floor, id, command) {
    if (USE_SIMULATION_MODE) {
        const barrier = (SIMULATED_DATA[floor] || []).find(b => b.id === id);
        if (barrier) {
            barrier.status = command === 'open' ? 'open' : 'closed';            
           
            wss_broadcast({
                type: 'barrier_update',
                data: barrier
            });
        }
        return true;
    }

    // 2. 正式 Modbus 模式
    let targetController = null;
    let targetUnit = null;
    if (LIVE_MODBUS_CONFIG[floor]) {
        for (const controller of LIVE_MODBUS_CONFIG[floor]) {
            const unit = controller.units.find(u => u.id === id);
            if (unit) {
                targetController = controller;
                targetUnit = unit;
                break;
            }
        }
    }

    if (!targetController || !targetUnit) {
        console.error(`[Barrier Driver] 控制失敗：在設定中找不到 ${id}`);
        return false;
    }

    // 2. 執行控制
    try {
        const isConnected = await ensureConnection(targetController);
        if (!isConnected) return false;
        
        // ★★★ 核心控制邏輯變更 ★★★
        if (command === 'open') {
            // 開啟：寫入 Open=true, Close=false
            console.log(`[Barrier Driver] 發送控制: ${targetUnit.locationName} -> OPEN (Coil: ${targetUnit.openAddr + 1})`);
            await targetController.client.writeCoil(targetUnit.openAddr + 1, true);
            await targetController.client.writeCoil(targetUnit.closeAddr + 1, false);
        } else { // command === 'close'
            // 關閉：寫入 Open=false, Close=true
            console.log(`[Barrier Driver] 發送控制: ${targetUnit.locationName} -> CLOSE (Coil: ${targetUnit.closeAddr + 1})`);
            await targetController.client.writeCoil(targetUnit.openAddr + 1, false);
            await targetController.client.writeCoil(targetUnit.closeAddr + 1, true);
        }
        
        // 3. 樂觀更新快取
        const cachedUnit = LIVE_DATA_CACHE[floor].find(u => u.id === id);
        if (cachedUnit) {
            cachedUnit.status = command === 'open' ? 'open' : 'closed';
            console.log(`[Barrier Driver] ${targetUnit.locationName} 狀態快取已更新為: ${cachedUnit.status}`);
            wss_broadcast({
                    type: 'barrier_update',
                    data: cachedUnit
                });
        }
        return true;
    } catch (err) {
        console.error(`[Barrier Driver] 控制失敗:`, err.message);
        return false;
    }
}

// ★ 導出新函式
module.exports = {
    start,
    getDataByFloor,
    controlBarrier,
    getConfig,
    saveFloorConfig
};
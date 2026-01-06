const ModbusRTU = require("modbus-serial");
const fs = require('fs').promises;
const path = require('path');
const CONFIG_OVERRIDES_PATH = path.join(__dirname, 'intercom_config_overrides.json');

// ★★★ 總開關：切換模擬模式或正式 Modbus 模式 ★★★
// true = 使用下面的 "SIMULATED_DATA" (用於展示)
// false = 使用 "LIVE_MODBUS_CONFIG" (用於正式上線)
const USE_SIMULATION_MODE = false;

// (A) 模擬模式：使用的資料與邏輯
const SIMULATED_DATA = {
    "1f": [
        { id: "VI-1F-01", name: "video100_1", household: "A-101", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-1F-02", name: "video101_2", household: "B-102", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-1F-03", name: "video102_1", household: "C-103", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" }
    ],
    "2f": [
        { id: "VI-2F-01", name: "video200_1", household: "A-201", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-2F-02", name: "video201_1", household: "B-202", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-2F-03", name: "video202_2", household: "C-203", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" }
    ],
    "3f": [
        { id: "VI-3F-01", name: "video300_1", household: "A-301", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-3F-02", name: "video301_1", household: "B-302", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-3F-03", name: "video302_2", household: "C-303", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" }
    ],
    "4f": [
        { id: "VI-4F-01", name: "video400_1", household: "A-401", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-4F-02", name: "video401_2", household: "B-402", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-4F-03", name: "video402_2", household: "C-403", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" }
    ],
    "5f": [
        { id: "VI-5F-01", name: "video001_1", household: "A-501", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-5F-02", name: "video002_1", household: "B-502", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-5F-03", name: "video003_1", household: "C-503", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" }
    ]
};

function startSimulationLoop() {
    console.log("[Intercom Driver] 驅動已啟動 (模式: 模擬)。");
    setInterval(() => {
        Object.keys(SIMULATED_DATA).forEach(floor => {
            const units = SIMULATED_DATA[floor];
            if (units && units.length > 0) {
                const randomUnit = units[Math.floor(Math.random() * units.length)];
                if (Math.random() < 0.05 && randomUnit.status === 'idle') {
                    randomUnit.status = 'calling';
                    console.log(`[影像對講][模擬] ${randomUnit.household} 正在呼叫...`);
                }
            }
        });
    }, 3000);
}

// (B) 正式 Modbus 模式：使用的設定與邏輯

// ★ 正式上線的 Modbus 設定 
const LIVE_MODBUS_CONFIG = {
    "1f": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "VI-1F-01", diAddress: 0, name: "video100_1", household: "A-101", streamUrl: "rtsp://admin:admin@169.254.48.251:8554/live" },
            { id: "VI-1F-02", diAddress: 1, name: "video101_2", household: "B-102", streamUrl: "rtsp://admin:admin@169.254.48.251:8554/live" },
            { id: "VI-1F-03", diAddress: 2, name: "video102_1", household: "C-103", streamUrl: "rtsp://admin:admin@169.254.48.251:8554/live" }
        ]
    },
    "2f": {
        ip: "192.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [
            { id: "VI-2F-01", diAddress: 1, name: "video200_1", household: "A-201", streamUrl: "rtsp://... (2F-1)" },
            { id: "VI-2F-02", diAddress: 2, name: "video201_1", household: "B-202", streamUrl: "rtsp://... (2F-2)" },
            { id: "VI-2F-03", diAddress: 3, name: "video202_2", household: "C-203", streamUrl: "rtsp://... (2F-3)" }
        ]
    },
    
};

// ★ 正式 Modbus 模式的「即時狀態快取」
const LIVE_DATA_CACHE = {};

// ★ 確保特定樓層 Modbus 連線的輔助函式
async function ensureConnection(floorConfig) {
    if (floorConfig.client.isOpen) {
        return true;
    }
    try {
        await floorConfig.client.connectTCP(floorConfig.ip, { port: floorConfig.port });
        floorConfig.client.setID(floorConfig.slaveId);
        //console.log(`[Intercom Driver] 已連接到 ${floorConfig.ip}`);
        return true;
    } catch (err) {
        //console.error(`[Intercom Driver] 連接 ${floorConfig.ip} 失敗:`, err.message);
        floorConfig.client.close(() => {});
        return false;
    }
}

// ★ 在背景輪詢 Modbus 數據的函式
async function pollModbusData() {
    for (const floor of Object.keys(LIVE_MODBUS_CONFIG)) {
        const config = LIVE_MODBUS_CONFIG[floor];

        try {
            const isConnected = await ensureConnection(config);
            if (!isConnected) {
                // 如果連線失敗，將該樓層所有設備標記為 "offline"
                config.units.forEach(unit => {
                    const cachedUnit = LIVE_DATA_CACHE[floor].find(u => u.id === unit.id);
                    if (cachedUnit) cachedUnit.status = "offline";
                });
                continue; // 換下一個樓層
            }

            if (!config.units || config.units.length === 0) {
                continue; // 如果這個樓層沒有設定 units，就跳過
            }
            
            const addresses = config.units.map(u => u.diAddress);
            const minAddr = Math.min(...addresses); // 範例(1F): 0
            const maxAddr = Math.max(...addresses); // 範例(1F): 2

            
            const libraryStartAddr = minAddr + 1;          // ★ ★ ★ ★★ ★  函式庫 0-based需+1 / 1-based則移除 ★ ★ ★ ★ ★ ★ 
            const inputsToRead = maxAddr - minAddr + 1; // 總共要讀的點數 (2-0+1 = 3)

            // 執行動態讀取
            //const response = await config.client.readDiscreteInputs(libraryStartAddr, inputsToRead); 
            const response = await config.client.readCoils(libraryStartAddr, inputsToRead);
            const statuses = response.data;
            
            config.units.forEach(unit => {
                const index_in_statuses = unit.diAddress - minAddr;
                const isAlarmActive = statuses[index_in_statuses];
                
                const cachedUnit = LIVE_DATA_CACHE[floor].find(u => u.id === unit.id);
                
                if (cachedUnit) {
                    const currentStatus = cachedUnit.status;
                    const newStatus = isAlarmActive ? "calling" : "idle";
                    
                    if (currentStatus !== newStatus) {
                        cachedUnit.status = newStatus;                        
                        console.log(`[Intercom Driver][Modbus] ${floor} - ${unit.household} (DI: 10000${unit.diAddress + 1}) 狀態變為: ${newStatus}`);
                    }
                }
            });

        } catch (err) {
            console.error(`[Intercom Driver] 讀取 ${config.ip} 失敗:`, err.message);
            config.client.close(() => {});            
            config.units.forEach(unit => {
                const cachedUnit = LIVE_DATA_CACHE[floor].find(u => u.id === unit.id);
                if (cachedUnit) {
                    cachedUnit.status = "offline";
                }
            });
        }
    }
}

//啟動時載入設定檔
async function loadConfigOverrides() {
    try {
        // 檢查檔案是否存在
        await fs.access(CONFIG_OVERRIDES_PATH);
        
        // 讀取並解析
        const data = await fs.readFile(CONFIG_OVERRIDES_PATH, 'utf8');
        const overrides = JSON.parse(data);
        
        console.log(`[Intercom Driver] 發現設定檔，正在套用...`);

        // 套用設定到記憶體中的 LIVE_MODBUS_CONFIG
        for (const floor in overrides) {
            if (LIVE_MODBUS_CONFIG[floor]) {
                const saved = overrides[floor];
                const live = LIVE_MODBUS_CONFIG[floor];

                // 套用控制器設定
                if (saved.ip) live.ip = saved.ip;
                if (saved.port) live.port = saved.port;
                if (saved.slaveId) live.slaveId = saved.slaveId;

                // 套用 RTSP 設定 (比對 ID)
                if (saved.units && Array.isArray(saved.units)) {
                    saved.units.forEach(savedUnit => {
                        const targetUnit = live.units.find(u => u.id === savedUnit.id);
                        if (targetUnit) {
                            targetUnit.streamUrl = savedUnit.streamUrl;
                        }
                    });
                }
            }
        }
    } catch (err) {
        
        if (err.code !== 'ENOENT') {
            console.error("[Intercom Driver] 載入設定失敗:", err.message);
        }
    }
}

// ★ 正式 Modbus 模式的啟動邏輯
async function startModbusLoop() {
    console.log("[Intercom Driver] 驅動已啟動 (模式: 正式 Modbus)。");
    await loadConfigOverrides();

    // 1. 初始化 LIVE_DATA_CACHE
    // (我們複製一份設定檔的結構，但只保留需要動態更新的欄位)
    for (const floor of Object.keys(LIVE_MODBUS_CONFIG)) {
        LIVE_DATA_CACHE[floor] = LIVE_MODBUS_CONFIG[floor].units.map(unit => ({
            id: unit.id,
            name: unit.name,
            household: unit.household,
            status: "idle", // 初始狀態
            streamUrl: unit.streamUrl
        }));
    }
    
    // 2. 啟動背景輪詢 (例如每 2 秒一次)
    setInterval(pollModbusData, 2000);
}

// (C) 導出的公開函式 (給 server.js 使用)
//啟動驅動程式
function start() {
    if (USE_SIMULATION_MODE) {
        startSimulationLoop();
    } else {
        startModbusLoop();
    }
}

//根據樓層獲取對講機資料
function getDataByFloor(floor) {
    if (USE_SIMULATION_MODE) {
        return SIMULATED_DATA[floor] || [];
    } else {        
        return LIVE_DATA_CACHE[floor] || [];
    }
}

//根據 ID 獲取單一對講機資料

function getUnitById(id) {
    const data = USE_SIMULATION_MODE ? SIMULATED_DATA : LIVE_DATA_CACHE;
    for (const floor of Object.keys(data)) {
        const unit = data[floor].find(u => u.id === id);
        if (unit) {
            return unit;
        }
    }
    return null;
}

//解除呼叫

async function resolveCall(id) {
    // 1. 如果是模擬模式，保持舊邏輯
    if (USE_SIMULATION_MODE) {
        let found = false;
        Object.values(SIMULATED_DATA).forEach(units => {
            const unit = units.find(u => u.id === id);
            if (unit && unit.status === 'calling') {
                unit.status = 'idle';
                found = true;
            }
        });
        return found;
    }

    // 2. 如果是正式模式，發送 Modbus 寫入指令
    for (const floor of Object.keys(LIVE_MODBUS_CONFIG)) {
        const config = LIVE_MODBUS_CONFIG[floor];
        const unit = config.units.find(u => u.id === id);
        
        if (unit) {
            try {
                const isConnected = await ensureConnection(config);
                if (!isConnected) return false;

                // 使用 diAddress 作為線圈位址 (0-based)
                // 發送 false (0) 來解除警報
                console.log(`[Intercom Driver] 正在解除 ${unit.household} (Coil: 0000${unit.diAddress + 1})...`);
                await config.client.writeCoil(unit.diAddress + 1, false);
                console.log(`[Intercom Driver] 解除指令已發送成功！`);
                
                // 立即更新快取
                const cachedUnit = LIVE_DATA_CACHE[floor].find(u => u.id === id);
                if (cachedUnit) cachedUnit.status = 'idle';
                
                return true;
            } catch (err) {
                console.error(`[Intercom Driver] 解除失敗:`, err.message);
                return false;
            }
        }
    }
    return false;
}

function getIntercomConfig(floor) {
    const config = LIVE_MODBUS_CONFIG[floor];
    if (!config) throw new Error(`找不到 ${floor} 的設定`);
    
    return {
        ip: config.ip,
        port: config.port,
        slaveId: config.slaveId,        
        units: config.units.map(u => ({
            id: u.id,
            household: u.household,
            name: u.name,
            streamUrl: u.streamUrl
        }))
    };
}

async function setIntercomConfig(floor, newSettings) {
    if (!LIVE_MODBUS_CONFIG[floor]) throw new Error(`找不到 ${floor}`);

    // 1. 更新記憶體
    const config = LIVE_MODBUS_CONFIG[floor];
    config.ip = newSettings.ip;
    config.port = newSettings.port;
    config.slaveId = newSettings.slaveId;

    // 更新 RTSP
    if (newSettings.unitsUpdate) {
        newSettings.unitsUpdate.forEach(update => {
            const unit = config.units.find(u => u.id === update.id);
            if (unit) unit.streamUrl = update.streamUrl;
        });
    }

    // 2. 寫入檔案
    let allOverrides = {};
    try {
        if (require('fs').existsSync(CONFIG_OVERRIDES_PATH)) {
            allOverrides = JSON.parse(await fs.readFile(CONFIG_OVERRIDES_PATH, 'utf8'));
        }
    } catch(e) {}

    // 只更新該樓層的 overrides
    allOverrides[floor] = {
        ip: config.ip,
        port: config.port,
        slaveId: config.slaveId,
        units: config.units.map(u => ({ id: u.id, streamUrl: u.streamUrl }))
    };

    await fs.writeFile(CONFIG_OVERRIDES_PATH, JSON.stringify(allOverrides, null, 4));

    // 3. 重啟連線
    if (config.client.isOpen) config.client.close(()=>{});
}

// 導出函式
module.exports = {
    start,
    getDataByFloor,
    getUnitById,
    resolveCall,
    getIntercomConfig,
    setIntercomConfig
};
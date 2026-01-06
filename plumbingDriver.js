/* plumbingDriver.js */
const ModbusRTU = require("modbus-serial");
const fs = require('fs').promises;
const path = require('path');

// ★★★ 模式設定 ★★★
// true = 純模擬 (展示用)
// false = 正式 Modbus 連線 (混合水位模擬)
const USE_SIMULATION_MODE = false;

const CONFIG_OVERRIDES_PATH = path.join(__dirname, 'plumbing_config_overrides.json');
let broadcastCallback = () => { };

// (A) 初始資料與預設設定
const DEFAULT_PLUMBING_CONFIG = {
    "b3f": {
        ip: "127.0.0.1",
        port: 80,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [
            { id: "PUMP-B3-01", name: "PD", locationName: "廢水泵浦", runAddr: 0, faultAddr: 1, controlAddr: 0 },
            { id: "PUMP-B3-02", name: "PD_1", locationName: "廢水泵浦", runAddr: 2, faultAddr: 3, controlAddr: 2 },
            { id: "PUMP-B3-03", name: "PD_2", locationName: "雨水泵浦", runAddr: 4, faultAddr: 5, controlAddr: 4 },
            { id: "PUMP-B3-04", name: "PD_3", locationName: "污水泵浦", runAddr: 6, faultAddr: 7, controlAddr: 6 },
            { id: "PUMP-B3-05", name: "PD_4", locationName: "污水泵浦", runAddr: 8, faultAddr: 9, controlAddr: 8 },
            { id: "PUMP-B3-06", name: "PD_5", locationName: "雨水泵浦", runAddr: 10, faultAddr: 11, controlAddr: 10 },
            { id: "PUMP-B3-07", name: "PD_6", locationName: "雨水泵浦", runAddr: 12, faultAddr: 13, controlAddr: 12 },
            { id: "PUMP-B3-08", name: "PD_7", locationName: "廢水泵浦", runAddr: 14, faultAddr: 15, controlAddr: 14 },
            { id: "PUMP-B3-09", name: "PD_8", locationName: "雨水泵浦", runAddr: 16, faultAddr: 17, controlAddr: 16 },
            { id: "PUMP-B3-10", name: "PD_9", locationName: "廢水泵浦", runAddr: 18, faultAddr: 19, controlAddr: 18 },
            { id: "PUMP-B3-11", name: "PD_10", locationName: "廢水泵浦", runAddr: 20, faultAddr: 21, controlAddr: 20 }
        ]
    }
    // "1f": { ip: "192.168.1.20", ... units: [...] }
};

// 狀態快取 (依樓層分類)
let LIVE_DATA_CACHE = {};

// 水位列表 (模擬用)
const waterLevels = ["低", "中", "高", "高高"];

// --- 輔助函式：確保 Modbus 連線 ---
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
        controllerConfig.client.setTimeout(5000); // 設定超時
        console.log(`[Plumbing Driver] 已連接到 ${controllerConfig.ip}`);
        return true;
    } catch (err) {
        console.error(`[Plumbing Driver] 連接 ${controllerConfig.ip} 失敗:`, err.message);
        // 連線失敗時清空 client，確保下次重連
        if (controllerConfig.client) {
            controllerConfig.client.close(() => { });
            controllerConfig.client = null;
        }
        return false;
    }
}

// --- 核心函式：計算功耗與模擬水位 ---
function calculateSimulatedValues(pump, isRunning) {
    // 1. 模擬水位 (隨機變化)
    if (!pump.waterLevel || Math.random() > 0.7) {
        pump.waterLevel = waterLevels[Math.floor(Math.random() * waterLevels.length)];
    }

    // 2. 計算功耗
    if (isRunning) {
        pump.powerConsumption = parseFloat((2.5 + Math.random()).toFixed(2));
    } else {
        pump.powerConsumption = 0.0;
    }
}

// --- 輪詢 Modbus 數據 ---
async function pollModbusData() {
    for (const floor of Object.keys(DEFAULT_PLUMBING_CONFIG)) {
        const config = DEFAULT_PLUMBING_CONFIG[floor];

        if (!config || !config.units || config.units.length === 0) continue;

        try {
            const isConnected = await ensureConnection(config);

            // 1. 連線失敗處理
            if (!isConnected) {
                // 如果連不上，把所有設備設為 offline
                if (LIVE_DATA_CACHE[floor]) {
                    config.units.forEach(unit => {
                        const cachedUnit = LIVE_DATA_CACHE[floor].find(u => u.id === unit.id);
                        if (cachedUnit && cachedUnit.status !== "offline") {
                            cachedUnit.status = "offline";
                            if (broadcastCallback) broadcastCallback({ type: 'plumbing_status_update', point: cachedUnit });
                        }
                    });
                }
                continue;
            }

            // 2. 計算讀取範圍
            const allAddrs = config.units.flatMap(u => [u.runAddr, u.faultAddr])
                .filter(addr => typeof addr === 'number' && !isNaN(addr));

            if (allAddrs.length === 0) continue;

            const minAddr = Math.min(...allAddrs);
            const maxAddr = Math.max(...allAddrs);

            // A. 判斷模式
            let currentReadMode = 'input';
            if (config.readType === 'coil') {
                currentReadMode = 'coil';
            } else if (config.units[0] && config.units[0].readType === 'coil') {
                currentReadMode = 'coil';
            }
            const readFunc = (currentReadMode === 'coil') ? 'readCoils' : 'readDiscreteInputs';

            // B. 設定偏移量 (Offset)            
            const startOffset = 1; 

            const libraryStartAddr = minAddr + startOffset;
            const inputsToRead = maxAddr - minAddr + 1;

            // 3. 執行讀取
            config.client.setTimeout(4000); 
            const response = await config.client[readFunc](libraryStartAddr, inputsToRead);
            const statuses = response.data;

            // 4. 更新快取
            if (!LIVE_DATA_CACHE[floor]) LIVE_DATA_CACHE[floor] = [];

            config.units.forEach(unit => {
                const cachedUnit = LIVE_DATA_CACHE[floor].find(u => u.id === unit.id);
                if (!cachedUnit) return;

                cachedUnit.settings = {
                    ip: config.ip,
                    port: config.port,
                    slaveId: config.slaveId,
                    readType: config.readType || 'coil',
                    runAddr: unit.runAddr,
                    faultAddr: unit.faultAddr,
                    controlAddr: (unit.controlAddr !== undefined) ? unit.controlAddr : unit.runAddr,
                    unitReadType: unit.readType
                };

                // 計算索引
                // statuses[0] 對應的是 (min + 1)
                // 當 unit.runAddr == minAddr 時，讀取 statuses[0]
                const runIndex = (typeof unit.runAddr === 'number') ? (unit.runAddr - minAddr) : -1;
                const faultIndex = (typeof unit.faultAddr === 'number') ? (unit.faultAddr - minAddr) : -1;

                const runSignal = (runIndex >= 0 && statuses[runIndex] !== undefined) ? statuses[runIndex] : false;
                const faultSignal = (faultIndex >= 0 && statuses[faultIndex] !== undefined) ? statuses[faultIndex] : false;

                // 狀態判斷
                let newStatus = "停止";
                if (faultSignal) newStatus = "故障";
                else if (runSignal) newStatus = "運轉中";

                if (cachedUnit.status !== newStatus) {
                    cachedUnit.status = newStatus;
                    if (broadcastCallback) broadcastCallback({ type: 'plumbing_status_update', point: cachedUnit });
                }

                calculateSimulatedValues(cachedUnit, newStatus === "運轉中");
            });

        } catch (err) {
            console.error(`[Plumbing Driver] ${floor} 讀取失敗: ${err.message} (Mode: ${config.readType})`);
            
            // 關閉連線
            if (config.client) config.client.close(() => {});

            if (LIVE_DATA_CACHE[floor]) {
                config.units.forEach(unit => {
                    const cachedUnit = LIVE_DATA_CACHE[floor].find(u => u.id === unit.id);
                    if (cachedUnit) {
                        cachedUnit.status = "offline";
                        cachedUnit.settings = {
                            ip: config.ip,
                            port: config.port,
                            slaveId: config.slaveId,
                            readType: config.readType || 'coil',
                            runAddr: unit.runAddr,
                            faultAddr: unit.faultAddr,
                            controlAddr: (unit.controlAddr !== undefined) ? unit.controlAddr : unit.runAddr
                        };
                        if (broadcastCallback) broadcastCallback({ type: 'plumbing_status_update', point: cachedUnit });
                    }
                });
            }
        }
    }
}

// --- 純模擬模式迴圈 ---
function startSimulationLoop() {
    console.log("[Plumbing Driver] 啟動模擬模式");
    setInterval(() => {
        Object.keys(LIVE_DATA_CACHE).forEach(floorKey => {
            LIVE_DATA_CACHE[floorKey].forEach(pump => {
                // 模擬邏輯
                pump.waterLevel = waterLevels[Math.floor(Math.random() * waterLevels.length)];

                const rand = Math.random();
                if (rand < 0.05) pump.status = "故障";
                else if (pump.waterLevel === "高" || pump.waterLevel === "高高") pump.status = "運轉中";
                else pump.status = "停止";

                if (pump.status === '運轉中') {
                    pump.powerConsumption = parseFloat((2.5 + Math.random()).toFixed(2));
                } else {
                    pump.powerConsumption = 0.0;
                }
            });
        });
    }, 4000);
}

// --- 載入設定覆蓋 ---
async function loadConfigOverrides() {
    let overrides = {};
    try {
        if (require('fs').existsSync(CONFIG_OVERRIDES_PATH)) {
            const data = await fs.readFile(CONFIG_OVERRIDES_PATH, 'utf8');
            if (data.trim()) {
                overrides = JSON.parse(data);
            }
        }
    } catch (e) {
        console.warn("[Plumbing Driver] 無法讀取設定檔，將使用預設值");
        return;
    }

    for (const floorKey in DEFAULT_PLUMBING_CONFIG) {
        const savedConfig = overrides[floorKey];
        if (savedConfig) {
            // 1. 載入 PLC 連線設定
            if (savedConfig.ip) DEFAULT_PLUMBING_CONFIG[floorKey].ip = savedConfig.ip;
            if (savedConfig.port) DEFAULT_PLUMBING_CONFIG[floorKey].port = savedConfig.port;
            if (savedConfig.slaveId) DEFAULT_PLUMBING_CONFIG[floorKey].slaveId = savedConfig.slaveId;
            if (savedConfig.readType) DEFAULT_PLUMBING_CONFIG[floorKey].readType = savedConfig.readType;

            // 2. 載入每個泵浦的位址設定
            if (savedConfig.units && Array.isArray(savedConfig.units)) {
                savedConfig.units.forEach(savedUnit => {
                    const targetUnit = DEFAULT_PLUMBING_CONFIG[floorKey].units.find(u => u.id === savedUnit.id);
                    if (targetUnit) {
                        if (savedUnit.runAddr !== undefined) targetUnit.runAddr = savedUnit.runAddr;
                        if (savedUnit.faultAddr !== undefined) targetUnit.faultAddr = savedUnit.faultAddr;
                        if (savedUnit.controlAddr !== undefined) targetUnit.controlAddr = savedUnit.controlAddr;
                        if (savedUnit.readType !== undefined) targetUnit.readType = savedUnit.readType;
                    }
                });
            }

            console.log(`[Plumbing Driver] 已載入 ${floorKey} 設定 (IP: ${savedConfig.ip})`);
        }
    }
}

// --- 初始化與啟動 ---
async function start(broadcast) {
    if (broadcast) broadcastCallback = broadcast;

    // 初始化快取資料結構
    LIVE_DATA_CACHE = {};

    Object.keys(DEFAULT_PLUMBING_CONFIG).forEach(floorKey => {
        const group = DEFAULT_PLUMBING_CONFIG[floorKey];
        LIVE_DATA_CACHE[floorKey] = group.units.map(u => ({
            id: u.id,
            name: u.name,
            locationName: u.locationName,
            status: "停止",
            waterLevel: "低",
            powerConsumption: 0.0,
            // 初始設定資料
            config: {
                ip: group.ip,
                runAddr: u.runAddr,
                faultAddr: u.faultAddr
            }
        }));
    });

    if (USE_SIMULATION_MODE) {
        startSimulationLoop();
    } else {
        await loadConfigOverrides();
        console.log("[Plumbing Driver] 啟動 Modbus 模式");
        setInterval(pollModbusData, 2000);
    }
}

// --- API: 取得特定樓層資料 ---
function getDataByFloor(floor) {
    const floorData = LIVE_DATA_CACHE[floor];
    if (!floorData) return [];

    // 取得該樓層最新的全域設定 (IP/Port)
    const groupConfig = DEFAULT_PLUMBING_CONFIG[floor];

    // 回傳資料時，動態組合最新的設定值給前端
    return floorData.map(item => {
        // 找到該泵浦的靜態設定 (位址)
        const unitConfig = groupConfig.units.find(u => u.id === item.id);

        return {
            ...item,
            settings: {
                ip: groupConfig.ip,
                port: groupConfig.port,
                slaveId: groupConfig.slaveId,
                readType: groupConfig.readType || 'coil',
                runAddr: unitConfig ? unitConfig.runAddr : 0,
                faultAddr: unitConfig ? unitConfig.faultAddr : 0,
                controlAddr: unitConfig ? (unitConfig.controlAddr !== undefined ? unitConfig.controlAddr : unitConfig.runAddr) : 0,
                unitReadType: unitConfig ? unitConfig.readType : undefined
            }
        };
    });
}

// --- API: 取得所有資料 ---
function getAllData() {
    let allData = [];
    Object.keys(LIVE_DATA_CACHE).forEach(floor => {
        allData = allData.concat(getDataByFloor(floor));
    });
    return allData;
}

// --- API: 修改設定 ---
async function updateConfig(floor, newSettings) {
    // 1. 驗證樓層參數
    if (!floor || !DEFAULT_PLUMBING_CONFIG[floor]) {
        throw new Error(`無效的樓層代號: ${floor}`);
    }

    const config = DEFAULT_PLUMBING_CONFIG[floor];

    // 2. 更新記憶體中的 PLC 全域設定 (即時生效)
    if (newSettings.ip) config.ip = newSettings.ip;
    if (newSettings.port) config.port = parseInt(newSettings.port);
    if (newSettings.slaveId) config.slaveId = parseInt(newSettings.slaveId);
    if (newSettings.readType) {
        config.readType = newSettings.readType;
    }
    // 3. 更新記憶體中的泵浦位址 (支援 批次更新 & 單一更新)

    // (A) 情況一：前端送來的是 units 陣列 (Batch Update - saveGlobalSettings)
    if (newSettings.units && Array.isArray(newSettings.units)) {
        newSettings.units.forEach(newUnit => {
            const targetUnit = config.units.find(u => u.id === newUnit.id);
            if (targetUnit) {
                if (newUnit.runAddr !== undefined) targetUnit.runAddr = parseInt(newUnit.runAddr);
                if (newUnit.faultAddr !== undefined) targetUnit.faultAddr = parseInt(newUnit.faultAddr);

                if (newUnit.controlAddr !== undefined) targetUnit.controlAddr = parseInt(newUnit.controlAddr);
                if (newUnit.readType !== undefined) targetUnit.readType = newUnit.readType;
            }
        });
        console.log(`[Plumbing Driver] 已批次更新 ${newSettings.units.length} 個單元設定`);
    }
    // (B) 情況二：前端送來的是單一 targetId 
    else if (newSettings.targetId) {
        const unit = config.units.find(u => u.id === newSettings.targetId);
        if (unit) {
            if (newSettings.runAddr !== undefined) unit.runAddr = parseInt(newSettings.runAddr);
            if (newSettings.faultAddr !== undefined) unit.faultAddr = parseInt(newSettings.faultAddr);
            if (newSettings.controlAddr !== undefined) unit.controlAddr = parseInt(newSettings.controlAddr);
            console.log(`[Plumbing Driver] 已更新單一單元: ${unit.name}`);
        }
    }

    // 4. 重啟 Modbus 連線 (讓新 IP/Port 生效)
    if (config.client && config.client.isOpen) {
        config.client.close(() => {
            console.log(`[Plumbing Driver] ${floor} 連線已關閉，等待下一次輪詢重連...`);
        });
    }

    // 5. 檔案合併邏輯 
    let overrides = {};

    try {
        // (A) 先嘗試讀取現有的設定檔
        if (require('fs').existsSync(CONFIG_OVERRIDES_PATH)) {
            const fileData = await fs.readFile(CONFIG_OVERRIDES_PATH, 'utf8');
            if (fileData.trim()) {
                overrides = JSON.parse(fileData);
            }
        }
    } catch (readErr) {
        console.warn(`[Plumbing Driver] 讀取舊設定檔失敗 (將建立新檔):`, readErr.message);
    }

    // (B) 要儲存的資料
    const floorSettingsToSave = {
        ip: config.ip,
        port: config.port,
        slaveId: config.slaveId,
        readType: config.readType,
        units: config.units.map(u => ({
            id: u.id,
            runAddr: u.runAddr,
            faultAddr: u.faultAddr,
            controlAddr: u.controlAddr,
            readType: u.readType
        }))
    };

    // (C) 合併：更新指定樓層的設定
    overrides[floor] = floorSettingsToSave;

    // (D) 寫回檔案
    try {
        await fs.writeFile(CONFIG_OVERRIDES_PATH, JSON.stringify(overrides, null, 4));
        console.log(`[Plumbing Driver] ${floor} 設定已成功合併並儲存 (包含 readType/controlAddr)`);
        return true;
    } catch (writeErr) {
        console.error(`[Plumbing Driver] 儲存設定檔失敗:`, writeErr.message);
        throw new Error("設定更新成功但存檔失敗");
    }
}

// --- 控制泵浦開關 ---
async function controlPump(targetId, action) {
    console.log(`[Plumbing Driver] 收到控制請求: ID=${targetId}, Action=${action}`);

    // 1. 尋找泵浦
    let targetUnit = null;
    let targetConfig = null;
    let foundFloor = null;

    for (const floorKey of Object.keys(DEFAULT_PLUMBING_CONFIG)) { 
        const config = DEFAULT_PLUMBING_CONFIG[floorKey];
        if (config.units) {
            const unit = config.units.find(u => u.id === targetId);
            if (unit) {
                targetUnit = unit;
                targetConfig = config;
                foundFloor = floorKey;
                break;
            }
        }
    }

    if (!targetUnit || !targetConfig) {
        throw new Error(`找不到泵浦 ID: ${targetId}`);
    }

    // 2. 確保連線
    const isConnected = await ensureConnection(targetConfig);
    if (!isConnected) {
        throw new Error(`PLC 連線失敗 (${foundFloor})`);
    }

    // 優先使用 controlAddr，沒有則用 runAddr
    let baseAddr = targetUnit.controlAddr !== undefined ? targetUnit.controlAddr : targetUnit.runAddr;
    const coilAddr = baseAddr + 1; // ★ 加 1

    const value = (action === 'ON');

    try {
        console.log(`[Plumbing Driver] 執行寫入: Target=${targetUnit.name}, Coil Addr=${coilAddr} (Base ${baseAddr}+1), Val=${value}`);

        // 執行寫入 (FC5)
        await targetConfig.client.writeCoil(coilAddr, value);

        console.log(`[Plumbing Driver] 控制成功`);

        // 3. 樂觀更新快取
        if (LIVE_DATA_CACHE[foundFloor]) {
            const cachedUnit = LIVE_DATA_CACHE[foundFloor].find(u => u.id === targetId);
            if (cachedUnit) {
                cachedUnit.status = value ? "運轉中" : "停止";
                // 如果有廣播函式
                /* wss_broadcast({
                    type: 'plumbing_update',
                    data: cachedUnit
                });
                */
            }
        }
        return true;
    } catch (err) {
        console.error(`[Plumbing Driver] 寫入失敗:`, err.message);
        if (targetConfig.client) {
            targetConfig.client.close(() => { });
            targetConfig.client = null;
        }
        throw err;
    }
}

module.exports = {
    start,
    getDataByFloor,
    getAllData,
    updateConfig,
    controlPump
};
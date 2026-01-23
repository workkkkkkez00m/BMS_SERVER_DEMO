// acDriver.js
const ModbusRTU = require("modbus-serial");
const fs = require('fs').promises;
const path = require('path');
const defaultConfig = require('./ac_config');

// ★★★ 總開關 ★★★
const USE_SIMULATION_MODE = false; 

// ★★★ 分批讀取設定 ★★★
const BATCH_SIZE = 20; 

const CONFIG_OVERRIDES_PATH = path.join(__dirname, 'ac_config_overrides.json');

const client = new ModbusRTU();
let isConnected = false;
let pollingTimer = null;
let activeConfig = JSON.parse(JSON.stringify(defaultConfig));
let isBusy = false;
let LIVE_DATA_CACHE = {};
let updateCallback = null;

// Block Read 參數
let minAddr = 0;
let readStartAddr = 0; 
let readLength = 0;    

// ================= 數值對照表 (Mapping) =================

const MODE_MAP = {
    READ: { 0: "送風", 1: "冷氣", 2: "暖氣", 3: "除濕" },
    WRITE: { "送風": 0, "冷氣": 1, "暖氣": 2, "除濕": 3 }
};

const FAN_MAP = {
    READ: { 0: "自動", 1: "弱", 2: "中", 3: "強" },
    WRITE: { "自動": 0, "弱": 1, "中": 2, "強": 3 }
};

// ================= 初始化邏輯 =================
async function loadConfig() {
    console.log("[AC Driver] 正在載入設定 (loadConfig)...");
    activeConfig = JSON.parse(JSON.stringify(defaultConfig));

    try {
        await fs.access(CONFIG_OVERRIDES_PATH);
        const data = await fs.readFile(CONFIG_OVERRIDES_PATH, 'utf8');
        
        if (data && data.trim() !== "") {
            const overrides = JSON.parse(data);
            console.log("[AC Driver] 讀取到 overrides 檔案，正在合併...");

            if (overrides.connection) activeConfig.connection = { ...activeConfig.connection, ...overrides.connection };
            if (overrides.pollingInterval) activeConfig.pollingInterval = overrides.pollingInterval;
            
            if (overrides.devices && Object.keys(overrides.devices).length > 0) {
                activeConfig.devices = overrides.devices;
            } else {
                console.warn("⚠️ [AC Driver] overrides 檔案中沒有 devices，保留預設值。");
            }
        }
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log("[AC Driver] 無 overrides 檔，使用預設值並建立新檔...");
            try {
                await fs.writeFile(CONFIG_OVERRIDES_PATH, JSON.stringify(activeConfig, null, 4));
            } catch (e) { console.error("建立檔案失敗:", e); }
        } else {
            console.error("[AC Driver] 讀取設定檔錯誤:", err);
        }
    }

    if (!activeConfig.devices || Object.keys(activeConfig.devices).length === 0) {
        console.error("❌ [嚴重警告] activeConfig.devices 遺失！正在強制還原 ac_config.js 預設值！");
        activeConfig.devices = JSON.parse(JSON.stringify(defaultConfig.devices));
    }

    console.log(`✅ [AC Driver] 設定載入完畢。目前設備數 (1f): ${activeConfig.devices['1f'] ? activeConfig.devices['1f'].length : 0}`);
}

async function init() {
    let globalMax = 0;
    let globalMin = 99999;
    LIVE_DATA_CACHE = {}; 

    if (!activeConfig.devices) activeConfig.devices = { "1f": [] };

    for (const floor in activeConfig.devices) {
        const floorDevices = activeConfig.devices[floor];
        const count = floorDevices.length; 
        
        console.log(`[AC Driver] ${floor} 初始化: 共有 ${count} 台設備`);
        
        LIVE_DATA_CACHE[floor] = floorDevices.map(dev => {
            const base = dev.modbusAddress;

            // 自動分配位址 (Offset Logic)
            if (dev.tempModbusAddress === undefined)    dev.tempModbusAddress = base + count;
            if (dev.setTempModbusAddress === undefined) dev.setTempModbusAddress = base + (count * 2);
            if (dev.modeModbusAddress === undefined)    dev.modeModbusAddress = base + (count * 3);
            if (dev.fanModbusAddress === undefined)     dev.fanModbusAddress = base + (count * 4);
            if (dev.swingModbusAddress === undefined)   dev.swingModbusAddress = base + (count * 5);
            if (dev.swingHModbusAddress === undefined)  dev.swingHModbusAddress = base + (count * 6);

            // 更新全域讀取範圍
            const addrs = [
                base, 
                dev.tempModbusAddress, 
                dev.setTempModbusAddress, 
                dev.modeModbusAddress, 
                dev.fanModbusAddress, 
                dev.swingModbusAddress,
                dev.swingHModbusAddress
            ];
            
            addrs.forEach(a => {
                if (a < globalMin) globalMin = a;
                if (a > globalMax) globalMax = a;
            });

            return {
                ...dev,
                status: "停止",
                mode: "送風",
                setTemperature: 25.0,     
                currentTemperature: 26.0,
                fanSpeed: "自動",
                verticalSwing: "auto",
                horizontalSwing: "auto",
                lastUpdate: new Date()
            };
        });
    }

    // 計算總讀取範圍
    if (globalMin > globalMax) {
        minAddr = 0;
        readStartAddr = 0;
        readLength = 0;
    } else {
        minAddr = globalMin;
        // ★★★ 依您的要求保留 +1 ★★★
        readStartAddr = minAddr + 1; 
        readLength = globalMax - globalMin + 1;
    }
    
    console.log(`[AC Driver] 初始化完成`);
    console.log(`   - 總範圍: ${globalMin} ~ ${globalMax} (起始讀取位址: ${readStartAddr}, 長度: ${readLength})`);
    
    // ★ 注意：這裡移除了原本會造成衝突的 client.connectTCP 和 startPolling 呼叫
}

// ================= 正式 Modbus 模式迴圈 =================

async function ensureConnection() {
    if (client.isOpen) return true;
    
    const ip = activeConfig.connection.ip || "127.0.0.1";
    const port = activeConfig.connection.port || 502;
    const slaveId = activeConfig.connection.slaveId || 1;
    const timeout = activeConfig.connection.timeout || 2000;

    try {
        client.setTimeout(timeout);
        // 在連線前先確保關閉舊連線
        client.close(() => {});
        
        await client.connectTCP(ip, { port: port });
        await client.setID(slaveId);
        
        isConnected = true;
        console.log(`[AC Driver] ✅ Modbus 連線成功 (${ip}:${port})`);
        return true;
    } catch (err) {
        console.error(`[AC Driver] 連線失敗: ${err.message}`);
        isConnected = false;
        return false;
    }
}

async function pollModbusData() {
    if (isBusy) return;

    if (!activeConfig.devices || !activeConfig.devices['1f'] || activeConfig.devices['1f'].length === 0) {
         pollingTimer = setTimeout(pollModbusData, 5000);
         return;
    }

    isBusy = true;
    try {
        const connected = await ensureConnection();
        if (connected) {
            
            let minAddr = 99999;
            let maxAddr = 0;

            for (const floor in LIVE_DATA_CACHE) {
                LIVE_DATA_CACHE[floor].forEach(unit => {
                    const addrs = [
                        unit.modbusAddress, 
                        unit.tempModbusAddress, 
                        unit.setTempModbusAddress, 
                        unit.modeModbusAddress, 
                        unit.fanModbusAddress,
                        unit.swingModbusAddress,
                        unit.swingHModbusAddress
                    ];
                    // 過濾無效值
                    const validAddrs = addrs.filter(a => a !== undefined && a !== null);
                    if (validAddrs.length > 0) {
                        minAddr = Math.min(minAddr, ...validAddrs);
                        maxAddr = Math.max(maxAddr, ...validAddrs);
                    }
                });
            }

            // 防呆
            if (minAddr > maxAddr) {
                isBusy = false; 
                return;
            }
            const READ_OFFSET = 1; 
            const startReadAddr = minAddr + READ_OFFSET;
            const endReadAddr = maxAddr + READ_OFFSET;
            const totalLen = endReadAddr - startReadAddr + 1;
            
            const SAFE_BATCH_SIZE = 100; 
            const dataMap = new Map();

            for (let offset = 0; offset < totalLen; offset += SAFE_BATCH_SIZE) {
                const currentStart = startReadAddr + offset;
                const remaining = totalLen - offset;
                const currentLen = Math.min(SAFE_BATCH_SIZE, remaining);

                try {
                    // 發送讀取指令 (無延遲)
                    const res = await client.readHoldingRegisters(currentStart, currentLen);
                    
                    // 存入 Map
                    for (let i = 0; i < res.data.length; i++) {
                        // 還原回設定檔的位址 (0-based)
                        const configAddr = (currentStart + i) - READ_OFFSET;
                        dataMap.set(configAddr, res.data[i]);
                    }

                } catch (batchErr) {
                    console.error(`[AC Driver] 區塊讀取失敗 (${currentStart} ~ ${currentStart + currentLen - 1}):`, batchErr.message);
                }
            }

            // 3. 瞬間更新所有數據
            let hasChange = false; 

            for (const floor in LIVE_DATA_CACHE) {
                LIVE_DATA_CACHE[floor].forEach(unit => {
                    const getVal = (addr) => {
                        return dataMap.has(addr) ? dataMap.get(addr) : null;
                    };

                    const statusVal = getVal(unit.modbusAddress);
                    if (statusVal !== null) unit.status = (statusVal === 256) ? "運轉中" : "停止";

                    const curTemp = getVal(unit.tempModbusAddress);
                    if (curTemp !== null) unit.currentTemperature = curTemp / 10.0;

                    const setTemp = getVal(unit.setTempModbusAddress);
                    if (setTemp !== null) unit.setTemperature = setTemp / 10.0;

                    const modeVal = getVal(unit.modeModbusAddress);
                    if (modeVal !== null) unit.mode = MODE_MAP.READ[modeVal] || "送風";

                    const fanVal = getVal(unit.fanModbusAddress);
                    if (fanVal !== null) unit.fanSpeed = FAN_MAP.READ[fanVal] || "自動";

                    const swingVal = getVal(unit.swingModbusAddress);
                    if (swingVal !== null) unit.verticalSwing = (swingVal === 1) ? "auto" : "0";

                    const swingHVal = getVal(unit.swingHModbusAddress);
                    if (swingHVal !== null) unit.horizontalSwing = (swingHVal === 1) ? "auto" : "0";

                    unit.lastUpdate = new Date();
                });
            }
            
            if (updateCallback) updateCallback(LIVE_DATA_CACHE);
        }
    } catch (err) {
        console.error(`[AC Driver] 輪詢週期錯誤: ${err.message}`);
        client.close(() => { isConnected = false; });
    } finally {
        isBusy = false;
        
        const fastInterval = 1000; 
        
        if (!USE_SIMULATION_MODE) {
            pollingTimer = setTimeout(pollModbusData, fastInterval);
        }
    }
}

function startModbusLoop() {
    console.log("[AC Driver] 啟動正式輪詢迴圈...");
    pollModbusData();
}

// ================= 控制指令 =================

async function handleControl(floor, id, updateFn, modbusFn) {
    let retry = 0;
    while(isBusy && retry < 20) {
        await new Promise(r => setTimeout(r, 100));
        retry++;
    }
    isBusy = true;

    try {
        const unit = getUnitById(floor, id);
        if (!unit) throw new Error("AC unit not found");

        updateFn(unit);

        if (!USE_SIMULATION_MODE) {
            await ensureConnection();
            await modbusFn(client, unit);
            console.log(`[AC Driver] 指令成功 -> ${unit.name}`);
        }
        if (updateCallback) {
            updateCallback(LIVE_DATA_CACHE);
        }
        return unit;
    } catch (err) {
        console.error(`[AC Driver] 指令失敗: ${err.message}`);
        throw err;
    } finally {
        isBusy = false;
    }
}

// 1. 開關
async function setPower(floor, id, status) {
    return handleControl(floor, id, 
        (u) => u.status = status,
        async (c, u) => {
            const val = (status === "運轉中") ? 256 : 0;
            // 控制指令通常也需要 +1 (基於您舊程式碼的邏輯)
            await c.writeRegister(u.modbusAddress + 1, val);
        }
    );
}

// 2. 設定溫度
async function setTemperature(floor, id, temp) {
    return handleControl(floor, id,
        (u) => u.setTemperature = temp,
        async (c, u) => {
            const addr = u.setTempModbusAddress + 1; 
            const val = Math.round(temp * 10);
            await c.writeRegister(addr, val);
        }
    );
}

// 3. 模式控制
async function setMode(floor, id, mode) {
    return handleControl(floor, id,
        (u) => u.mode = mode,
        async (c, u) => {
            const addr = u.modeModbusAddress + 1;
            const val = MODE_MAP.WRITE[mode];
            if (val === undefined) throw new Error("無效的模式");
            await c.writeRegister(addr, val);
        }
    );
}

// 4. 風速控制
async function setFanSpeed(floor, id, speed) {
    return handleControl(floor, id,
        (u) => u.fanSpeed = speed,
        async (c, u) => {
            const addr = u.fanModbusAddress + 1;
            const val = FAN_MAP.WRITE[speed];
            if (val === undefined) throw new Error("無效的風速");
            await c.writeRegister(addr, val);
        }
    );
}

// 5. 風向控制 (包含垂直與水平)
async function setSwing(floor, id, type, value) {
    return handleControl(floor, id,
        (u) => {
            if (type === 'vertical') u.verticalSwing = value;
            if (type === 'horizontal') u.horizontalSwing = value; 
        },
        async (c, u) => {
            if (type === 'vertical') {
                const addr = u.swingModbusAddress + 1;
                const val = (value === 'auto') ? 1 : 0;
                await c.writeRegister(addr, val);
            }
            if (type === 'horizontal') {
                const addr = u.swingHModbusAddress + 1;
                const val = (value === 'auto') ? 1 : 0;
                await c.writeRegister(addr, val);
            }
        }
    );
}

// ================= 設定檔熱更新 & 輔助 =================

async function setAcConfig(newSettings) {
    console.log("[AC Driver] 收到設定變更");
    
    if (pollingTimer) clearTimeout(pollingTimer);

    if (newSettings.connection) activeConfig.connection = { ...activeConfig.connection, ...newSettings.connection };
    if (newSettings.devices) activeConfig.devices = newSettings.devices;

    try {
        const fileContent = await fs.readFile(CONFIG_OVERRIDES_PATH, 'utf8').catch(()=>"{}");
        const currentOverrides = JSON.parse(fileContent);
        if (newSettings.connection) currentOverrides.connection = activeConfig.connection;
        if (newSettings.devices) currentOverrides.devices = activeConfig.devices;
        await fs.writeFile(CONFIG_OVERRIDES_PATH, JSON.stringify(currentOverrides, null, 4));
    } catch (err) { console.error(err); }

    await init(); 
    if (client.isOpen) client.close(() => { isConnected = false; });
    
    if (!USE_SIMULATION_MODE) {
        startModbusLoop();
    }
    
    return { success: true };
}

function getUnitById(floor, id) {
    if (!LIVE_DATA_CACHE[floor]) return null;
    return LIVE_DATA_CACHE[floor].find(u => u.id === id);
}
function getDataByFloor(floor) { return LIVE_DATA_CACHE[floor] || []; }
function getConfig() { return activeConfig; }

async function start(callback) {
    if (callback) {
        updateCallback = callback;
    }

    await loadConfig();
    await init(); // 初始化資料結構

    if (USE_SIMULATION_MODE) {
        console.log("[AC Driver] 啟動模擬模式");
    } else {
        startModbusLoop(); // 統一啟動單一輪詢迴圈
    }
}

module.exports = {
    start,
    getDataByFloor,
    setPower,
    setTemperature,
    setMode,
    setFanSpeed,
    setSwing,
    getConfig,
    setAcConfig,
};
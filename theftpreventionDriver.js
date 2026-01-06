const ModbusRTU = require("modbus-serial");
const fs = require('fs').promises;
const path = require('path');

// ★★★ 總開關：切換模擬模式或正式 Modbus 模式 ★★★
// true = 使用下面的 "SIMULATED_THEFT_DATA" (用於展示)
// false = 使用 "LIVE_THEFT_MODBUS_CONFIG" (用於正式上線)
const USE_SIMULATION_MODE = false;
const CONFIG_OVERRIDES_PATH = path.join(__dirname, 'theft_config_overrides.json');
let broadcastCallback = () => {};

// (A) 模擬模式：使用的資料與邏輯
// 狀態: "關閉" (正常), "開啟" (警報), "offline" (離線)
const SIMULATED_THEFT_DATA = {
    "1f": [
        { id: "TP-1F-01", floor: "1f", name: "A101_DOOR", text: "磁簧", household: "A-101", status: "關閉" },
        { id: "TP-1F-02", floor: "1f", name: "A101_PANIC", text: "緊急求救", household: "A-101", status: "關閉" },
        { id: "TP-1F-03", floor: "1f", name: "B102_DOOR", text: "磁簧", household: "B-102", status: "關閉" }
    ],
    "2f": [
        { id: "TP-2F-01", floor: "2f", name: "A201_DOOR", text: "磁簧", household: "A-201", status: "關閉" },
        { id: "TP-2F-02", floor: "2f", name: "A201_PANIC", text: "緊急求救", household: "A-201", status: "關閉" }
    ],
    "3f": [
        { id: "TP-3F-01", floor: "3f", name: "A301_DOOR", text: "磁簧", household: "A-301", status: "關閉" }
    ],
    "4f": [
        { id: "TP-4F-01", floor: "4f", name: "A401_DOOR", text: "磁簧", household: "A-401", status: "關閉" },
        { id: "TP-4F-02", floor: "4f", name: "A401_PANIC", text: "緊急求救", household: "A-401", status: "關閉" },
        { id: "TP-4F-03", floor: "4f", name: "B402_DOOR", text: "磁簧", household: "B-402", status: "關閉" },
        { id: "TP-4F-04", floor: "4f", name: "B402_PANIC", text: "緊急求救", household: "B-402", status: "關閉" }
    ],
    "5f": [
        { id: "TP-5F-01", floor: "5f", name: "A501_DOOR", text: "磁簧", household: "A-501", status: "關閉" },
        { id: "TP-5F-02", floor: "5f", name: "A501_PANIC", text: "緊急求救", household: "A-501", status: "關閉" }
    ]
};

function startSimulationLoop() {
    console.log("[Theft Driver] 驅動已啟動 (模式: 模擬)。");
    setInterval(() => {
        Object.keys(SIMULATED_THEFT_DATA).forEach(floor => {
            const units = SIMULATED_THEFT_DATA[floor];
            if (units && units.length > 0) {
                // 隨機選一個偵測點
                const randomUnit = units[Math.floor(Math.random() * units.length)];
                
                // 5% 的機率觸發警報 (如果它目前是關閉的)
                if (Math.random() < 0.05 && randomUnit.status === '關閉') {
                    randomUnit.status = '開啟';
                    console.log(`[防盜系統][模擬] ${randomUnit.household} (${randomUnit.text}) 觸發警報！`);
                }
            }
        });
    }, 5000); // 模擬每 5 秒隨機觸發
}


// (B) 正式 Modbus 模式：使用的設定與邏輯

// ★ 正式上線的 Modbus 設定
const LIVE_THEFT_MODBUS_CONFIG = {    
    "1f": {ip: "192.168.1.102", port: 502, slaveId: 1, client: new ModbusRTU(), units: [] },
    "3f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-3F-01", diAddress: 0, floor: "3f", name: "ECB096_1", text: "緊急求救押扣", household: "3F-EP01-A" },
            { id: "TP-3F-02", diAddress: 1, floor: "3f", name: "ECB097_1", text: "緊急求救押扣", household: "3F-EP02-A" },
            { id: "TP-3F-03", diAddress: 2, floor: "3f", name: "ECB098_1", text: "緊急求救押扣", household: "3F-EP03-A" },
            { id: "TP-3F-04", diAddress: 3, floor: "3f", name: "ECB099_1", text: "緊急求救押扣", household: "3F-EP04-A" },                     
        ]
    },
    "3f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-3F-05", diAddress: 0, floor: "3f", name: "ECB0103_1", text: "緊急求救押扣", household: "3F-EP05-B" },
            { id: "TP-3F-06", diAddress: 1, floor: "3f", name: "ECB0100_1", text: "緊急求救押扣", household: "3F-EP06-B" },
            { id: "TP-3F-07", diAddress: 2, floor: "3f", name: "ECB0102_1", text: "緊急求救押扣", household: "3F-EP07-B" },
            { id: "TP-4F-08", diAddress: 3, floor: "3f", name: "ECB0101_1", text: "緊急求救押扣", household: "3F-EP08-B" },                     
        ]
    },
    "4f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [
            { id: "TP-4F-01", diAddress: 0, floor: "4f", name: "ECB095_1", text: "緊急求救押扣", household: "4F-EP01-A" },
            { id: "TP-4F-02", diAddress: 1, floor: "4f", name: "ECB096_1", text: "緊急求救押扣", household: "4F-EP02-A" },
            { id: "TP-4F-03", diAddress: 2, floor: "4f", name: "ECB098_1", text: "緊急求救押扣", household: "4F-EP03-A" },
            { id: "TP-4F-04", diAddress: 3, floor: "4f", name: "ECB097_1", text: "緊急求救押扣", household: "4F-EP04-A" },                     
        ]
    },
    "4f-B": {
        ip: "127.0.0.1",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [
            { id: "TP-4F-05", diAddress: 0, floor: "4f", name: "ECB102_1", text: "緊急求救押扣", household: "4F-EP05-B" },
            { id: "TP-4F-06", diAddress: 1, floor: "4f", name: "ECB099_1", text: "緊急求救押扣", household: "4F-EP06-B" },
            { id: "TP-4F-07", diAddress: 2, floor: "4f", name: "ECB101_1", text: "緊急求救押扣", household: "4F-EP07-B" },
            { id: "TP-4F-08", diAddress: 3, floor: "4f", name: "ECB100_1", text: "緊急求救押扣", household: "4F-EP08-B" },                     
        ]
    },
    "5f-A": {
        ip: "127.0.0.1",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [
            { id: "TP-5F-01", diAddress: 0, floor: "5f", name: "ECB139", text: "緊急求救押扣", household: "5F-EP01-A" },
            { id: "TP-5F-02", diAddress: 1, floor: "5f", name: "ECB140", text: "緊急求救押扣", household: "5F-EP02-A" },
            { id: "TP-5F-03", diAddress: 2, floor: "5f", name: "ECB142", text: "緊急求救押扣", household: "5F-EP03-A" },
            { id: "TP-5F-04", diAddress: 3, floor: "5f", name: "ECB141", text: "緊急求救押扣", household: "5F-EP04-A" },                     
        ]
    },
    "5f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [
            { id: "TP-5F-05", diAddress: 0, floor: "5f", name: "ECB146", text: "緊急求救押扣", household: "5F-EP05-B" },
            { id: "TP-5F-06", diAddress: 1, floor: "5f", name: "ECB143", text: "緊急求救押扣", household: "5F-EP06-B" },
            { id: "TP-5F-07", diAddress: 2, floor: "5f", name: "ECB145", text: "緊急求救押扣", household: "5F-EP07-B" },
            { id: "TP-5F-08", diAddress: 3, floor: "5f", name: "ECB144", text: "緊急求救押扣", household: "5F-EP08-B" },                     
        ]
    },
    "6f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-6F-01", diAddress: 0, floor: "6f", name: "ECB075", text: "緊急求救押扣", household: "6F-EP01-A" },
            { id: "TP-6F-02", diAddress: 1, floor: "6f", name: "ECB076", text: "緊急求救押扣", household: "6F-EP02-A" },
            { id: "TP-6F-03", diAddress: 2, floor: "6f", name: "ECB078", text: "緊急求救押扣", household: "6F-EP03-A" },
            { id: "TP-6F-04", diAddress: 3, floor: "6f", name: "ECB077", text: "緊急求救押扣", household: "6F-EP04-A" },                     
        ]
    },
    "6f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-6F-05", diAddress: 0, floor: "6f", name: "ECB082", text: "緊急求救押扣", household: "6F-EP05-B" },
            { id: "TP-6F-06", diAddress: 1, floor: "6f", name: "ECB079", text: "緊急求救押扣", household: "6F-EP06-B" },
            { id: "TP-6F-07", diAddress: 2, floor: "6f", name: "ECB081", text: "緊急求救押扣", household: "6F-EP07-B" },
            { id: "TP-6F-08", diAddress: 3, floor: "6f", name: "ECB080", text: "緊急求救押扣", household: "6F-EP08-B" },                     
        ]
    },
    "7f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-7F-01", diAddress: 0, floor: "7f", name: "ECB034_1", text: "緊急求救押扣", household: "7F-EP01-A" },
            { id: "TP-7F-02", diAddress: 1, floor: "7f", name: "ECB035_1", text: "緊急求救押扣", household: "7F-EP02-A" },
            { id: "TP-7F-03", diAddress: 2, floor: "7f", name: "ECB037_1", text: "緊急求救押扣", household: "7F-EP03-A" },
            { id: "TP-7F-04", diAddress: 3, floor: "7f", name: "ECB036_1", text: "緊急求救押扣", household: "7F-EP04-A" },                     
        ]
    },
    "7f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-7F-05", diAddress: 0, floor: "7f", name: "ECB041_1", text: "緊急求救押扣", household: "7F-EP05-B" },
            { id: "TP-7F-06", diAddress: 1, floor: "7f", name: "ECB038_1", text: "緊急求救押扣", household: "7F-EP06-B" },
            { id: "TP-7F-07", diAddress: 2, floor: "7f", name: "ECB040_1", text: "緊急求救押扣", household: "7F-EP07-B" },
            { id: "TP-7F-08", diAddress: 3, floor: "7f", name: "ECB039_1", text: "緊急求救押扣", household: "7F-EP08-B" },                     
        ]
    },
    "8f-A": {
        ip: "127.0.0.1",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-8F-01", diAddress: 0, floor: "8f", name: "ECB181_1", text: "緊急求救押扣", household: "8F-EP01-A" },
            { id: "TP-8F-02", diAddress: 1, floor: "8f", name: "ECB182_1", text: "緊急求救押扣", household: "8F-EP02-A" },
            { id: "TP-8F-03", diAddress: 2, floor: "8f", name: "ECB184_1", text: "緊急求救押扣", household: "8F-EP03-A" },
            { id: "TP-8F-04", diAddress: 3, floor: "8f", name: "ECB183_1", text: "緊急求救押扣", household: "8F-EP04-A" },                     
        ]
    },
    "8f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-8F-05", diAddress: 0, floor: "8f", name: "ECB188_1", text: "緊急求救押扣", household: "8F-EP05-B" },
            { id: "TP-8F-06", diAddress: 1, floor: "8f", name: "ECB185_1", text: "緊急求救押扣", household: "8F-EP06-B" },
            { id: "TP-8F-07", diAddress: 2, floor: "8f", name: "ECB187_1", text: "緊急求救押扣", household: "8F-EP07-B" },
            { id: "TP-8F-08", diAddress: 3, floor: "8f", name: "ECB186_1", text: "緊急求救押扣", household: "8F-EP08-B" },                     
        ]
    },
    "9f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-9F-01", diAddress: 0, floor: "9f", name: "ECB034_1", text: "緊急求救押扣", household: "9F-EP01-A" },
            { id: "TP-9F-02", diAddress: 1, floor: "9f", name: "ECB035_1", text: "緊急求救押扣", household: "9F-EP02-A" },
            { id: "TP-9F-03", diAddress: 2, floor: "9f", name: "ECB036_1", text: "緊急求救押扣", household: "9F-EP03-A" },
            { id: "TP-9F-04", diAddress: 3, floor: "9f", name: "ECB037_1", text: "緊急求救押扣", household: "9F-EP04-A" },                     
        ]
    },
    "9f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-9F-05", diAddress: 0, floor: "9f", name: "ECB041_1", text: "緊急求救押扣", household: "9F-EP05-B" },
            { id: "TP-9F-06", diAddress: 1, floor: "9f", name: "ECB038_1", text: "緊急求救押扣", household: "9F-EP06-B" },
            { id: "TP-9F-07", diAddress: 2, floor: "9f", name: "ECB040_1", text: "緊急求救押扣", household: "9F-EP07-B" },
            { id: "TP-9F-08", diAddress: 3, floor: "9f", name: "ECB039_1", text: "緊急求救押扣", household: "9F-EP08-B" },                     
        ]
    },
    "10f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-10F-01", diAddress: 0, floor: "10f", name: "ECB035_1", text: "緊急求救押扣", household: "10F-EP01-A" },
            { id: "TP-10F-02", diAddress: 1, floor: "10f", name: "ECB036_1", text: "緊急求救押扣", household: "10F-EP02-A" },
            { id: "TP-10F-03", diAddress: 2, floor: "10f", name: "ECB038_1", text: "緊急求救押扣", household: "10F-EP03-A" },
            { id: "TP-10F-04", diAddress: 3, floor: "10f", name: "ECB037_1", text: "緊急求救押扣", household: "10F-EP04-A" },                     
        ]
    },
    "10f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-10F-05", diAddress: 0, floor: "10f", name: "ECB042_1", text: "緊急求救押扣", household: "10F-EP05-B" },
            { id: "TP-10F-06", diAddress: 1, floor: "10f", name: "ECB039_1", text: "緊急求救押扣", household: "10F-EP06-B" },
            { id: "TP-10F-07", diAddress: 2, floor: "10f", name: "ECB041_1", text: "緊急求救押扣", household: "10F-EP07-B" },
            { id: "TP-10F-08", diAddress: 3, floor: "10f", name: "ECB040_1", text: "緊急求救押扣", household: "10F-EP08-B" },                     
        ]
    },
    "11f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-11F-01", diAddress: 0, floor: "11f", name: "ECB032_1", text: "緊急求救押扣", household: "11F-EP01-A" },
            { id: "TP-11F-02", diAddress: 1, floor: "11f", name: "ECB033_1", text: "緊急求救押扣", household: "11F-EP02-A" },
            { id: "TP-11F-03", diAddress: 2, floor: "11f", name: "ECB035_1", text: "緊急求救押扣", household: "11F-EP03-A" },
            { id: "TP-11F-04", diAddress: 3, floor: "11f", name: "ECB034_1", text: "緊急求救押扣", household: "11F-EP04-A" },                     
        ]
    },
    "11f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-11F-05", diAddress: 0, floor: "11f", name: "ECB039_1", text: "緊急求救押扣", household: "11F-EP05-B" },
            { id: "TP-11F-06", diAddress: 1, floor: "11f", name: "ECB036_1", text: "緊急求救押扣", household: "11F-EP06-B" },
            { id: "TP-11F-07", diAddress: 2, floor: "11f", name: "ECB038_1", text: "緊急求救押扣", household: "11F-EP07-B" },
            { id: "TP-11F-08", diAddress: 3, floor: "11f", name: "ECB037_1", text: "緊急求救押扣", household: "11F-EP08-B" },                     
        ]
    },
    "12f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-12F-01", diAddress: 0, floor: "12f", name: "ECB034_1", text: "緊急求救押扣", household: "12F-EP01-A" },
            { id: "TP-12F-02", diAddress: 1, floor: "12f", name: "ECB035_1", text: "緊急求救押扣", household: "12F-EP02-A" },
            { id: "TP-12F-03", diAddress: 2, floor: "12f", name: "ECB037_1", text: "緊急求救押扣", household: "12F-EP03-A" },
            { id: "TP-12F-04", diAddress: 3, floor: "12f", name: "ECB036_1", text: "緊急求救押扣", household: "12F-EP04-A" },                     
        ]
    },
    "12f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-12F-05", diAddress: 0, floor: "12f", name: "ECB041_1", text: "緊急求救押扣", household: "12F-EP05-B" },
            { id: "TP-12F-06", diAddress: 1, floor: "12f", name: "ECB038_1", text: "緊急求救押扣", household: "12F-EP06-B" },
            { id: "TP-12F-07", diAddress: 2, floor: "12f", name: "ECB040_1", text: "緊急求救押扣", household: "12F-EP07-B" },
            { id: "TP-12F-08", diAddress: 3, floor: "12f", name: "ECB039_1", text: "緊急求救押扣", household: "12F-EP08-B" },                     
        ]
    },
    "13f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-13F-01", diAddress: 0, floor: "13f", name: "ECB034_1", text: "緊急求救押扣", household: "13F-EP01-A" },
            { id: "TP-13F-02", diAddress: 1, floor: "13f", name: "ECB035_1", text: "緊急求救押扣", household: "13F-EP02-A" },
            { id: "TP-13F-03", diAddress: 2, floor: "13f", name: "ECB037_1", text: "緊急求救押扣", household: "13F-EP03-A" },
            { id: "TP-13F-04", diAddress: 3, floor: "13f", name: "ECB036_1", text: "緊急求救押扣", household: "13F-EP04-A" },                     
        ]
    },
    "13f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-13F-05", diAddress: 0, floor: "13f", name: "ECB041_1", text: "緊急求救押扣", household: "13F-EP05-B" },
            { id: "TP-13F-06", diAddress: 1, floor: "13f", name: "ECB038_1", text: "緊急求救押扣", household: "13F-EP06-B" },
            { id: "TP-13F-07", diAddress: 2, floor: "13f", name: "ECB040_1", text: "緊急求救押扣", household: "13F-EP07-B" },
            { id: "TP-13F-08", diAddress: 3, floor: "13f", name: "ECB039_1", text: "緊急求救押扣", household: "13F-EP08-B" },                     
        ]
    },
    "14f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-14F-01", diAddress: 0, floor: "14f", name: "ECB033_1", text: "緊急求救押扣", household: "14F-EP01-A" },
            { id: "TP-14F-02", diAddress: 1, floor: "14f", name: "ECB034_1", text: "緊急求救押扣", household: "14F-EP02-A" },
            { id: "TP-14F-03", diAddress: 2, floor: "14f", name: "ECB035_1", text: "緊急求救押扣", household: "14F-EP03-A" },
            { id: "TP-14F-04", diAddress: 3, floor: "14f", name: "ECB036_1", text: "緊急求救押扣", household: "14F-EP04-A" },                     
        ]
    },
    "14f-B": {
        ip: "127.0.0.1",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-14F-05", diAddress: 0, floor: "14f", name: "ECB040_1", text: "緊急求救押扣", household: "14F-EP05-B" },
            { id: "TP-14F-06", diAddress: 1, floor: "14f", name: "ECB037_1", text: "緊急求救押扣", household: "14F-EP06-B" },
            { id: "TP-14F-07", diAddress: 2, floor: "14f", name: "ECB038_1", text: "緊急求救押扣", household: "14F-EP07-B" },
            { id: "TP-14F-08", diAddress: 3, floor: "14f", name: "ECB039_1", text: "緊急求救押扣", household: "14F-EP08-B" },                     
        ]
    },
    "15f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-15F-01", diAddress: 0, floor: "15f", name: "ECB028_1", text: "緊急求救押扣", household: "15F-EP01-A" },
            { id: "TP-15F-02", diAddress: 1, floor: "15f", name: "ECB029_1", text: "緊急求救押扣", household: "15F-EP02-A" },
            { id: "TP-15F-03", diAddress: 2, floor: "15f", name: "ECB031_1", text: "緊急求救押扣", household: "15F-EP03-A" },
            { id: "TP-15F-04", diAddress: 3, floor: "15f", name: "ECB030_1", text: "緊急求救押扣", household: "15F-EP04-A" },                     
        ]
    },
    "15f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-15F-05", diAddress: 0, floor: "15f", name: "ECB035_1", text: "緊急求救押扣", household: "15F-EP05-B" },
            { id: "TP-15F-06", diAddress: 1, floor: "15f", name: "ECB032_1", text: "緊急求救押扣", household: "15F-EP06-B" },
            { id: "TP-15F-07", diAddress: 2, floor: "15f", name: "ECB034_1", text: "緊急求救押扣", household: "15F-EP07-B" },
            { id: "TP-15F-08", diAddress: 3, floor: "15f", name: "ECB033_1", text: "緊急求救押扣", household: "15F-EP08-B" },                     
        ]
    },
    "16f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-16F-01", diAddress: 0, floor: "16f", name: "ECB028_1", text: "緊急求救押扣", household: "16F-EP01-A" },
            { id: "TP-16F-02", diAddress: 1, floor: "16f", name: "ECB029_1", text: "緊急求救押扣", household: "16F-EP02-A" },
            { id: "TP-16F-03", diAddress: 2, floor: "16f", name: "ECB031_1", text: "緊急求救押扣", household: "16F-EP03-A" },
            { id: "TP-16F-04", diAddress: 3, floor: "16f", name: "ECB030_1", text: "緊急求救押扣", household: "16F-EP04-A" },                     
        ]
    },
    "16f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-16F-05", diAddress: 0, floor: "16f", name: "ECB035_1", text: "緊急求救押扣", household: "16F-EP05-B" },
            { id: "TP-16F-06", diAddress: 1, floor: "16f", name: "ECB032_1", text: "緊急求救押扣", household: "16F-EP06-B" },
            { id: "TP-16F-07", diAddress: 2, floor: "16f", name: "ECB033_1", text: "緊急求救押扣", household: "16F-EP07-B" },
            { id: "TP-16F-08", diAddress: 3, floor: "16f", name: "ECB034_1", text: "緊急求救押扣", household: "16F-EP08-B" },                     
        ]
    },
    "17f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-17F-01", diAddress: 0, floor: "17f", name: "ECB032_1", text: "緊急求救押扣", household: "17F-EP01-A" },
            { id: "TP-17F-02", diAddress: 1, floor: "17f", name: "ECB033_1", text: "緊急求救押扣", household: "17F-EP02-A" },
            { id: "TP-17F-03", diAddress: 2, floor: "17f", name: "ECB035_1", text: "緊急求救押扣", household: "17F-EP03-A" },
            { id: "TP-17F-04", diAddress: 3, floor: "17f", name: "ECB034_1", text: "緊急求救押扣", household: "17F-EP04-A" },                     
        ]
    },
    "17f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-18F-05", diAddress: 0, floor: "17f", name: "ECB039_1", text: "緊急求救押扣", household: "17F-EP05-B" },
            { id: "TP-18F-06", diAddress: 1, floor: "17f", name: "ECB036_1", text: "緊急求救押扣", household: "17F-EP06-B" },
            { id: "TP-18F-07", diAddress: 2, floor: "17f", name: "ECB038_1", text: "緊急求救押扣", household: "17F-EP07-B" },
            { id: "TP-18F-08", diAddress: 3, floor: "17f", name: "ECB037_1", text: "緊急求救押扣", household: "17F-EP08-B" },                     
        ]
    },    
    "r1f-A": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-R1F-01", diAddress: 0, floor: "r1f", name: "R1F-EP01-A", text: "緊急求救押扣", household: "R1F-EP01-A" },
            { id: "TP-R1F-02", diAddress: 1, floor: "r1f", name: "R1F-EP02-A", text: "緊急求救押扣", household: "R1F-EP02-A" },
            { id: "TP-R1F-03", diAddress: 2, floor: "r1f", name: "R1F-EP03-A", text: "緊急求救押扣", household: "R1F-EP03-A" },
            { id: "TP-R1F-04", diAddress: 3, floor: "r1f", name: "R1F-EP04-A", text: "緊急求救押扣", household: "R1F-EP04-A" },                     
        ]
    },
    "r1f-B": {
        ip: "127.0.0.2",
        port: 80,
        slaveId: 1,        
        client: new ModbusRTU(),
        units: [            
            { id: "TP-R1F-05", diAddress: 0, floor: "r1f", name: "R1F-EP05-B", text: "緊急求救押扣", household: "R1F-EP05-B" },
            { id: "TP-R1F-06", diAddress: 1, floor: "r1f", name: "R1F-EP06-B", text: "緊急求救押扣", household: "R1F-EP06-B" },
            { id: "TP-R1F-07", diAddress: 2, floor: "r1f", name: "R1F-EP07-B", text: "緊急求救押扣", household: "R1F-EP07-B" },
            { id: "TP-R1F-08", diAddress: 3, floor: "r1f", name: "R1F-EP08-B", text: "緊急求救押扣", household: "R1F-EP08-B" },                     
        ]
    },    
};

// ★ 正式 Modbus 模式的「即時狀態快取」
const LIVE_THEFT_DATA_CACHE = {};

// ★ 確保特定樓層 Modbus 連線的輔助函式
async function ensureConnection(floorConfig) {
    if (floorConfig.client.isOpen) {
        return true;
    }
    try {
        await floorConfig.client.connectTCP(floorConfig.ip, { port: floorConfig.port, timeout: 2000 });
        floorConfig.client.setID(floorConfig.slaveId);
        //console.log(`[Theft Driver] 已連接到 ${floorConfig.ip}`);
        return true;
    } catch (err) {
        //console.error(`[Theft Driver] 連接 ${floorConfig.ip} 失敗:`, err.message);
        floorConfig.client.close(() => {});
        return false;
    }
}

// ★ 在背景輪詢 Modbus 數據的函式
async function pollModbusData() {
    for (const floor of Object.keys(LIVE_THEFT_MODBUS_CONFIG)) {
        const config = LIVE_THEFT_MODBUS_CONFIG[floor];

        if (!config.units || config.units.length === 0) {
            continue;
        }
            
        try {
            const isConnected = await ensureConnection(config);

            if (!isConnected) {
                // 如果連線失敗，將該樓層所有設備標記為 "offline"
                config.units.forEach(unit => {
                    const cachedUnit = LIVE_THEFT_DATA_CACHE[floor].find(u => u.id === unit.id);
                    if (cachedUnit && cachedUnit.status !== "offline") {
                        cachedUnit.status = "offline";
                        
                        //console.log(`[Theft Driver] ${floor} - ${unit.household} 已斷線，狀態重置為 offline`);

                        broadcastCallback({
                            type: 'theft_status_update',
                            point: cachedUnit 
                        });
                    }
                });
                continue; // 換下一個樓層
            }

            // 1. 動態計算要讀取的地址範圍
            const addresses = config.units.map(u => u.diAddress);
            const minAddr = Math.min(...addresses);
            const maxAddr = Math.max(...addresses);
            const libraryStartAddr = minAddr + 1; 
            const inputsToRead = maxAddr - minAddr + 1;

            // 2. 安全防護 (如果 readFunction 意外遺失，給予預設值)
            if (!config.readFunction) {
                config.readFunction = 'readDiscreteInputs';
                config.readFunctionAlt = 'readCoils';
            }
            
            // 3. 使用 "目前" 偏好的函式進行讀取
            //console.log(`[Theft Driver] 正在使用 ${config.readFunction} 讀取 ${config.ip}...`);
            const response = await config.client[config.readFunction](libraryStartAddr, inputsToRead);
            const statuses = response.data; 

            // 4. 更新快取
            config.units.forEach(unit => {
                const index_in_statuses = unit.diAddress - minAddr;
                const isAlarmActive = statuses[index_in_statuses];
                const cachedUnit = LIVE_THEFT_DATA_CACHE[floor].find(u => u.id === unit.id);
                
                if (cachedUnit) {
                    const currentStatus = cachedUnit.status;
                    const newStatus = isAlarmActive ? "開啟" : "關閉";
                    
                    if (currentStatus !== newStatus) {
                        cachedUnit.status = newStatus;                        
                        //console.log(`[Theft Driver][Modbus] ${floor} - ${unit.household} (${unit.text}) (DI: ${unit.diAddress + 1}) 狀態變為: ${newStatus}`);
                        
                        // 廣播
                        broadcastCallback({
                            type: 'theft_status_update',
                            point: cachedUnit 
                        });
                    }
                }
            });

        } catch (err) {
            console.error(`[Theft Driver] ${floor} (${config.ip}) 讀取失敗: ${err.message}`);
            // 發生錯誤時，關閉連線並將所有設備標記為 "offline"
            config.client.close(() => {}); 

            config.units.forEach(unit => {
                const cachedUnit = LIVE_THEFT_DATA_CACHE[floor].find(u => u.id === unit.id);
                if (cachedUnit && cachedUnit.status !== "offline") {
                    cachedUnit.status = "offline";
                    
                    broadcastCallback({
                        type: 'theft_status_update',
                        point: cachedUnit 
                    });
                }
            });
        }
    }
}

async function loadConfigOverrides() {
    let overrides = {};
    try {
        if (require('fs').existsSync(CONFIG_OVERRIDES_PATH)) {
            const overridesData = await fs.readFile(CONFIG_OVERRIDES_PATH, 'utf8');
            overrides = JSON.parse(overridesData);
        } else {
             //console.log(`[Theft Driver] ${CONFIG_OVERRIDES_PATH} 不存在，將使用預設設定。`);
        }
    } catch (err) {
        //console.error(`[Theft Driver] 載入 ${CONFIG_OVERRIDES_PATH} 失敗:`, err.message);
    }

    // 遍歷 "所有" 設備，套用設定或預設值
    for (const id in LIVE_THEFT_MODBUS_CONFIG) {
        if (LIVE_THEFT_MODBUS_CONFIG[id].units) { 
            const savedConfig = overrides[id];
            const config = LIVE_THEFT_MODBUS_CONFIG[id];

            if (savedConfig) {                
                config.ip = savedConfig.ip;
                config.port = savedConfig.port;
                config.slaveId = savedConfig.slaveId;

                const func = savedConfig.readFunction;
                config.readFunction = (func === 'readCoils' || func === 'readDiscreteInputs') ? func : 'readDiscreteInputs'; // 預設
                config.readFunctionAlt = (config.readFunction === 'readCoils') ? 'readDiscreteInputs' : 'readCoils';
                //console.log(`[Theft Driver] 成功載入 ${id} 設定 (ReadFunc: ${config.readFunction})`);

            } else {                
                config.readFunction = 'readDiscreteInputs'; // 預設為 Inputs
                config.readFunctionAlt = 'readCoils';
                //console.log(`[Theft Driver] ${id} 使用預設設定 (ReadFunc: ${config.readFunction})`);
            }
        }
    }
}

// ★ 正式 Modbus 模式的啟動邏輯
async function startModbusLoop() {
    console.log("[Theft Driver] 驅動已啟動 (模式: 正式 Modbus)。");

    // 載入 "所有" 設定 
    await loadConfigOverrides();

    // 初始化 LIVE_THEFT_DATA_CACHE 
    for (const floor of Object.keys(LIVE_THEFT_MODBUS_CONFIG)) {
        LIVE_THEFT_DATA_CACHE[floor] = LIVE_THEFT_MODBUS_CONFIG[floor].units.map(unit => ({
            id: unit.id,
            floor: unit.floor,
            name: unit.name,
            text: unit.text,
            household: unit.household,
            status: "關閉" 
        }));
    }
    //啟動背景輪詢
    setInterval(pollModbusData, 2000);
}


// (C) 導出的公開函式 (給 server.js 使用)

//啟動驅動程式
function start(broadcast) { 
    if (typeof broadcast === 'function') {
        broadcastCallback = broadcast;
    }
    if (USE_SIMULATION_MODE) {
        startSimulationLoop();
    } else {
        startModbusLoop();
    }
}

//獲取所有樓層資料
function getAllData() {
    const data = USE_SIMULATION_MODE ? SIMULATED_THEFT_DATA : LIVE_THEFT_DATA_CACHE;
    let allPoints = [];
    for (const floor of Object.keys(data)) {
        allPoints = allPoints.concat(data[floor] || []);
    }
    return allPoints;
}

// 獲取特定樓層資料
function getDataByFloor(floor) {
    const data = USE_SIMULATION_MODE ? SIMULATED_THEFT_DATA : LIVE_THEFT_DATA_CACHE;

    if (USE_SIMULATION_MODE) {
        return data[floor] || [];
    }
    
    let floorPoints = [];    
    for (const key of Object.keys(data)) {        
        if (key.startsWith(floor)) {
            floorPoints = floorPoints.concat(data[key] || []);
        }
    }
    return floorPoints;
}

// 解除警報
async function resolveAlarm(id) {
    // 1. 如果是模擬模式
    if (USE_SIMULATION_MODE) {
        let found = false;
        Object.values(SIMULATED_THEFT_DATA).forEach(units => {
            const unit = units.find(u => u.id === id);
            if (unit && unit.status === '開啟') {
                unit.status = '關閉';
                found = true;
            }
        });
        return found;
    }

    // 2. 如果是正式模式，發送 Modbus 寫入指令
    for (const floor of Object.keys(LIVE_THEFT_MODBUS_CONFIG)) {
        const config = LIVE_THEFT_MODBUS_CONFIG[floor];
        const unit = config.units.find(u => u.id === id); // 找到這個 ID 對應的設定
        
        if (unit) {
            try {
                const isConnected = await ensureConnection(config);
                if (!isConnected) return false;

                // ★ 發送 "false" (0) 到對應的線圈位址 (Coil Address) 來解除警報
                //console.log(`[Theft Driver] 正在解除 ${unit.household} (${unit.text}) (Coil: 0000${unit.diAddress + 1})...`);
                
                // (★ 假設解除警報是寫入 Coil 1-based)
                await config.client.writeCoil(unit.diAddress + 1, false);
                
                //console.log(`[Theft Driver] 解除指令已發送成功！`);
                
                // 立即更新快取，避免延遲
                const cachedUnit = LIVE_THEFT_DATA_CACHE[floor].find(u => u.id === id);
                if (cachedUnit) cachedUnit.status = '關閉';

                broadcastCallback({
                    type: 'theft_status_update',
                    point: cachedUnit
                });
                
                return true;
            } catch (err) {
                console.error(`[Theft Driver] 解除警報失敗:`, err.message);
                return false;
            }
        }
    }
    return false; // 找不到 ID
}

function getTheftConfigById(id) { // e.g., id = '4f-A'
    const config = LIVE_THEFT_MODBUS_CONFIG[id];

    if (config) {
        return {
            id: id,
            ip: config.ip,
            port: config.port,
            slaveId: config.slaveId,
            readFunction: config.readFunction
        };
    } else {
        throw new Error(`在 LIVE_THEFT_MODBUS_CONFIG 中找不到 ID: ${id}`);
    }
}

// 儲存驅動程式狀態到硬碟
async function setTheftConfigById(id, newSetting) { 
    if (!LIVE_THEFT_MODBUS_CONFIG[id]) {
        throw new Error(`在 LIVE_THEFT_MODBUS_CONFIG 中找不到 ID: ${id}`);
    }

    // 1. 讀取現有的 overrides.json
    let overrides = {}; 
    try {
        if (require('fs').existsSync(CONFIG_OVERRIDES_PATH)) {
            const overridesData = await fs.readFile(CONFIG_OVERRIDES_PATH, 'utf8');
            overrides = JSON.parse(overridesData);
        }
    } catch (readErr) {
        console.warn(`[Theft Driver] 讀取 ${CONFIG_OVERRIDES_PATH} 失敗:`, readErr.message);
        overrides = {};
    }

    // 2. 更新 "記憶體"
    const config = LIVE_THEFT_MODBUS_CONFIG[id];
    config.ip = newSetting.ip;
    config.port = newSetting.port;
    config.slaveId = newSetting.slaveId;
    config.readFunction = newSetting.readFunction;
    config.readFunctionAlt = (newSetting.readFunction === 'readCoils') ? 'readDiscreteInputs' : 'readCoils';
    
    //console.log(`[Theft Driver] ${id} 的記憶體設定已更新 (ReadFunc: ${newSetting.readFunction})`);

    // 3. (★ 關鍵修正) 更新 "overrides" 物件 (使用 newSetting)
    overrides[id] = {
        ip: newSetting.ip,
        port: newSetting.port,
        slaveId: newSetting.slaveId,
        readFunction: newSetting.readFunction 
    };

    // 4. 關閉舊連線
    if (config.client.isOpen) {
        config.client.close(() => {});
    }
    
    // 5. 將 "合併" 後的完整 overrides 物件寫回檔案
    await fs.writeFile(CONFIG_OVERRIDES_PATH, JSON.stringify(overrides, null, 4));
    //console.log(`[Theft Driver] ${CONFIG_OVERRIDES_PATH} 已更新。`);
}

// 刪除 state.json 快取檔案
async function clearTheftState() {
    try {
        if (require('fs').existsSync(STATE_FILE_PATH)) {
            await fs.unlink(STATE_FILE_PATH);
            //console.log(`[Theft Driver] ${STATE_FILE_PATH} 已被刪除。`);
        } else {
            //console.log(`[Theft Driver] ${STATE_FILE_PATH} 不存在，無需刪除。`);
        }
    } catch (err) {
        //console.error(`[Theft Driver] 刪除 ${STATE_FILE_PATH} 失敗:`, err.message);
        throw err;
    }
}

// 導出函式
module.exports = {
    start,
    getAllData,
    getDataByFloor,
    resolveAlarm,
    getTheftConfigById,
    setTheftConfigById  
};
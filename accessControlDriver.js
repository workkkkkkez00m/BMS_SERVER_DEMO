const ModbusRTU = require("modbus-serial");
const fs = require('fs').promises;
const path = require('path');
const CONFIG_OVERRIDES_PATH = path.join(__dirname, 'access_control_config_overrides.json');

// ★★★ 總開關：切換模擬模式或正式 Modbus 模式 ★★★
// true = 使用下面的 "SIMULATED_DATA" (用於展示)
// false = 使用 "LIVE_MODBUS_CONFIG" (用於正式上線)
const USE_SIMULATION_MODE = false;

// (A) 模擬模式：使用的資料與邏輯
const SIMULATED_DATA = {
    "1f": [
        { id: "VI-1F-01", name: "video100_1", location: "A-101", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-1F-02", name: "video101_2", location: "B-102", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-1F-03", name: "video102_1", location: "C-103", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" }
    ],
    "2f": [
        { id: "VI-2F-01", name: "video200_1", location: "A-201", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-2F-02", name: "video201_1", location: "B-202", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-2F-03", name: "video202_2", location: "C-203", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" }
    ],
    "3f": [
        { id: "VI-3F-01", name: "video300_1", location: "A-301", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-3F-02", name: "video301_1", location: "B-302", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-3F-03", name: "video302_2", location: "C-303", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" }
    ],
    "4f": [
        { id: "VI-4F-01", name: "video400_1", location: "A-401", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-4F-02", name: "video401_2", location: "B-402", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-4F-03", name: "video402_2", location: "C-403", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" }
    ],
    "5f": [
        { id: "VI-5F-01", name: "video001_1", location: "A-501", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-5F-02", name: "video002_1", location: "B-502", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" },
        { id: "VI-5F-03", name: "video003_1", location: "C-503", status: "idle", streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live" }
    ]
};

function startSimulationLoop() {
    console.log("[Access Control Driver] 驅動已啟動 (模式: 模擬)。");
    setInterval(() => {
        Object.keys(SIMULATED_DATA).forEach(floor => {
            const units = SIMULATED_DATA[floor];
            if (units && units.length > 0) {
                const randomUnit = units[Math.floor(Math.random() * units.length)];                
                if (Math.random() < 0.05) {
                    randomUnit.status = 'unlocked';
                    console.log(`[門禁保全][模擬] ${randomUnit.location} 狀態: 開啟 (Unlocked)`);
                } else {
                    randomUnit.status = 'locked';
                }
            }
        });
    }, 3000);
}

// (B) 正式 Modbus 模式：使用的設定與邏輯

// ★ 正式上線的 Modbus 設定 
const LIVE_MODBUS_CONFIG = {
    "1f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "1F-GBA01-A", diAddress: 0, name: "1F-GBA01-A", location: "門1"},
            { id: "1F-GBA02-A", diAddress: 1, name: "1F-GBA02-A", location: "門2"},
            { id: "1F-GBA03-A", diAddress: 2, name: "1F-GBA03-A", location: "門3"},
            { id: "1F-GBA04-A", diAddress: 3, name: "1F-GBA04-A", location: "門4"},
            { id: "1F-GBA05-A", diAddress: 4, name: "1F-GBA05-A", location: "門5"},
            { id: "1F-GBA06-A", diAddress: 5, name: "1F-GBA06-A", location: "門6"},
            { id: "1F-GBA07-A", diAddress: 6, name: "1F-GBA07-A", location: "門7"}
        ]
    },
    "1f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "1F-GBA08-B", diAddress: 0, name: "1F-GBA08-B", location: "門8"},
            { id: "1F-GBA09-B", diAddress: 1, name: "1F-GBA09-B", location: "門9"},
            { id: "1F-GBA10-B", diAddress: 2, name: "1F-GBA10-B", location: "門10"},
            { id: "1F-GBA11-B", diAddress: 3, name: "1F-GBA11-B", location: "門11"},
            { id: "1F-GBA12-B", diAddress: 4, name: "1F-GBA12-B", location: "門12"},
            { id: "1F-GBA13-B", diAddress: 5, name: "1F-GBA13-B", location: "門13"},
            { id: "1F-GBA14-B", diAddress: 6, name: "1F-GBA14-B", location: "門14"}
        ]
    },
    "2f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "2F-GBA01-A", diAddress: 0, name: "2F-GBA01-A", location: "門1"},
            { id: "2F-GBA02-A", diAddress: 1, name: "2F-GBA02-A", location: "門2"},
            { id: "2F-GBA03-A", diAddress: 2, name: "2F-GBA03-A", location: "門3"},
            { id: "2F-GBA04-A", diAddress: 3, name: "2F-GBA04-A", location: "門4"},
            { id: "2F-GBA05-A", diAddress: 4, name: "2F-GBA05-A", location: "門5"},
            { id: "2F-GBA06-A", diAddress: 5, name: "2F-GBA06-A", location: "門6"},
            { id: "2F-GBA07-A", diAddress: 6, name: "2F-GBA07-A", location: "門7"}
        ]
    },
    "2f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "2F-GBA08-B", diAddress: 0, name: "2F-GBA08-B", location: "門8"},
            { id: "2F-GBA09-B", diAddress: 1, name: "2F-GBA09-B", location: "門9"},
            { id: "2F-GBA10-B", diAddress: 2, name: "2F-GBA10-B", location: "門10"},
            { id: "2F-GBA11-B", diAddress: 3, name: "2F-GBA11-B", location: "門11"},
            { id: "2F-GBA12-B", diAddress: 4, name: "2F-GBA12-B", location: "門12"},
            { id: "2F-GBA13-B", diAddress: 5, name: "2F-GBA13-B", location: "門13"},
            { id: "2F-GBA14-B", diAddress: 6, name: "2F-GBA14-B", location: "門14"},
            { id: "2F-GBA15-B", diAddress: 6, name: "2F-GBA15-B", location: "門15"},
            { id: "2F-GBA16-B", diAddress: 6, name: "2F-GBA16-B", location: "門16"},
            { id: "2F-GBA17-B", diAddress: 6, name: "2F-GBA17-B", location: "門17"},
        ]
    },
    "3f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "3F-GBA01-A", diAddress: 0, name: "3F-GBA01-A", location: "門1"},
            { id: "3F-GBA02-A", diAddress: 1, name: "3F-GBA02-A", location: "門2"},
        ]
    },
    "3f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "3F-GBA03-B", diAddress: 0, name: "3F-GBA03-B", location: "門3"},
            { id: "3F-GBA04-B", diAddress: 1, name: "3F-GBA04-B", location: "門4"}
        ]
    },
    "4f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "4F-GBA01-A", diAddress: 0, name: "4F-GBA01-A", location: "門1"},
            { id: "4F-GBA02-A", diAddress: 1, name: "4F-GBA02-A", location: "門2"},
        ]
    },
    "4f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "4F-GBA03-B", diAddress: 0, name: "4F-GBA03-B", location: "門3"},
            { id: "4F-GBA04-B", diAddress: 1, name: "4F-GBA04-B", location: "門4"}
        ]
    },
    "5f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "5F-GBA01-A", diAddress: 0, name: "5F-GBA01-A", location: "門1"},
            { id: "5F-GBA02-A", diAddress: 1, name: "5F-GBA02-A", location: "門2"},
        ]
    },
    "5f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "5F-GBA03-B", diAddress: 0, name: "5F-GBA03-B", location: "門3"},
            { id: "5F-GBA04-B", diAddress: 1, name: "5F-GBA04-B", location: "門4"}
        ]
    },
    "6f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "6F-GBA01-A", diAddress: 0, name: "6F-GBA01-A", location: "門1"},
            { id: "6F-GBA02-A", diAddress: 1, name: "6F-GBA02-A", location: "門2"},
        ]
    },
    "6f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "6F-GBA03-B", diAddress: 0, name: "6F-GBA03-B", location: "門3"},
            { id: "6F-GBA04-B", diAddress: 1, name: "6F-GBA04-B", location: "門4"}
        ]
    },
    "7f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "7F-GBA01-A", diAddress: 0, name: "7F-GBA01-A", location: "門1"},
            { id: "7F-GBA02-A", diAddress: 1, name: "7F-GBA02-A", location: "門2"},
        ]
    },
    "7f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "7F-GBA03-B", diAddress: 0, name: "7F-GBA03-B", location: "門3"},
            { id: "7F-GBA04-B", diAddress: 1, name: "7F-GBA04-B", location: "門4"}
        ]
    },
    "8f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "8F-GBA01-A", diAddress: 0, name: "8F-GBA01-A", location: "門1"},
            { id: "8F-GBA02-A", diAddress: 1, name: "8F-GBA02-A", location: "門2"},
        ]
    },
    "8f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "8F-GBA03-B", diAddress: 0, name: "8F-GBA03-B", location: "門3"},
            { id: "8F-GBA04-B", diAddress: 1, name: "8F-GBA04-B", location: "門4"}
        ]
    },
    "9f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "9F-GBA01-A", diAddress: 0, name: "9F-GBA01-A", location: "門1"},
            { id: "9F-GBA02-A", diAddress: 1, name: "9F-GBA02-A", location: "門2"},
        ]
    },
    "9f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "9F-GBA03-B", diAddress: 0, name: "9F-GBA03-B", location: "門3"},
            { id: "9F-GBA04-B", diAddress: 1, name: "9F-GBA04-B", location: "門4"}
        ]
    },
    "10f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "10F-GBA01-A", diAddress: 0, name: "10F-GBA01-A", location: "門1"},
            { id: "10F-GBA02-A", diAddress: 1, name: "10F-GBA02-A", location: "門2"},
        ]
    },
    "10f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "10F-GBA03-B", diAddress: 0, name: "10F-GBA03-B", location: "門3"},
            { id: "10F-GBA04-B", diAddress: 1, name: "10F-GBA04-B", location: "門4"}
        ]
    },
    "11f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "11F-GBA01-A", diAddress: 0, name: "11F-GBA01-A", location: "門1"},
            { id: "11F-GBA02-A", diAddress: 1, name: "11F-GBA02-A", location: "門2"},
        ]
    },
    "11f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "11F-GBA03-B", diAddress: 0, name: "11F-GBA03-B", location: "門3"},
            { id: "11F-GBA04-B", diAddress: 1, name: "11F-GBA04-B", location: "門4"}
        ]
    },
    "12f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "12F-GBA01-A", diAddress: 0, name: "12F-GBA01-A", location: "門1"},
            { id: "12F-GBA02-A", diAddress: 1, name: "12F-GBA02-A", location: "門2"},
        ]
    },
    "12f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "12F-GBA03-B", diAddress: 0, name: "12F-GBA03-B", location: "門3"},
            { id: "12F-GBA04-B", diAddress: 1, name: "12F-GBA04-B", location: "門4"}
        ]
    },
    "13f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "13F-GBA01-A", diAddress: 0, name: "13F-GBA01-A", location: "門1"},
            { id: "13F-GBA02-A", diAddress: 1, name: "13F-GBA02-A", location: "門2"},
        ]
    },
    "13f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "13F-GBA03-B", diAddress: 0, name: "13F-GBA03-B", location: "門3"},
            { id: "13F-GBA04-B", diAddress: 1, name: "13F-GBA04-B", location: "門4"}
        ]
    },
    "14f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "14F-GBA01-A", diAddress: 0, name: "14F-GBA01-A", location: "門1"},
            { id: "14F-GBA02-A", diAddress: 1, name: "14F-GBA02-A", location: "門2"},
        ]
    },
    "14f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "14F-GBA03-B", diAddress: 0, name: "14F-GBA03-B", location: "門3"},
            { id: "14F-GBA04-B", diAddress: 1, name: "14F-GBA04-B", location: "門4"}
        ]
    },
    "15f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "15F-GBA01-A", diAddress: 0, name: "15F-GBA01-A", location: "門1"},
            { id: "15F-GBA02-A", diAddress: 1, name: "15F-GBA02-A", location: "門2"},
        ]
    },
    "15f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "15F-GBA03-B", diAddress: 0, name: "15F-GBA03-B", location: "門3"},
            { id: "15F-GBA04-B", diAddress: 1, name: "15F-GBA04-B", location: "門4"}
        ]
    },
    "16f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "16F-GBA01-A", diAddress: 0, name: "16F-GBA01-A", location: "門1"},
            { id: "16F-GBA02-A", diAddress: 1, name: "16F-GBA02-A", location: "門2"},
        ]
    },
    "16f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "16F-GBA03-B", diAddress: 0, name: "16F-GBA03-B", location: "門3"},
            { id: "16F-GBA04-B", diAddress: 1, name: "16F-GBA04-B", location: "門4"}
        ]
    },
    "17f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "17F-GBA01-A", diAddress: 0, name: "17F-GBA01-A", location: "門1"},
            { id: "17F-GBA02-A", diAddress: 1, name: "17F-GBA02-A", location: "門2"},
        ]
    },
    "17f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "17F-GBA03-B", diAddress: 0, name: "17F-GBA03-B", location: "門3"},
            { id: "17F-GBA04-B", diAddress: 1, name: "17F-GBA04-B", location: "門4"}
        ]
    },
    "b1f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "B1F-GBA01-A", diAddress: 0, name: "B1F-GBA01-A", location: "門1"},
        ]
    },
    "b1f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "B1F-GBA02-B", diAddress: 0, name: "B1F-GBA02-B", location: "門2"},
        ]
    },
    "b2f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "B2F-GBA01-A", diAddress: 0, name: "B2F-GBA01-A", location: "門1"},
        ]
    },
    "b2f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "B2F-GBA02-B", diAddress: 0, name: "B2F-GBA02-B", location: "門2"},
        ]
    },
    "b3f-A": {
        ip: "127.0.0.1",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "B3F-GBA01-A", diAddress: 0, name: "B3F-GBA01-A", location: "門1"},
        ]
    },
    "b3f-B": {
        ip: "127.0.0.2",
        port: 502,
        slaveId: 1,
        client: new ModbusRTU(),
        units: [            
            { id: "B3F-GBA02-B", diAddress: 0, name: "B3F-GBA02-B", location: "門2"},
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
            const inputsToRead = maxAddr - minAddr + 1;

            // 執行動態讀取
            //const response = await config.client.readDiscreteInputs(libraryStartAddr, inputsToRead); 
            const response = await config.client.readDiscreteInputs(libraryStartAddr, inputsToRead);
            const statuses = response.data;
            
            config.units.forEach(unit => {
                const index_in_statuses = unit.diAddress - minAddr;
                const isUnlocked = statuses[index_in_statuses];
                
                const cachedUnit = LIVE_DATA_CACHE[floor].find(u => u.id === unit.id);
                
                if (cachedUnit) {
                    const currentStatus = cachedUnit.status;
                    // true (導通/有電) => unlocked (開啟/紅燈)
                    // false (斷開/沒電) => locked (上鎖/綠燈)
                    const newStatus = isUnlocked ? "unlocked" : "locked";
                    
                    if (currentStatus !== newStatus) {
                        cachedUnit.status = newStatus;                        
                        //console.log(`[Access Driver][Modbus] ${floor} - ${unit.location} 狀態變為: ${newStatus}`);
                    }
                }
            });

        } catch (err) {
            console.error(`[Access Driver] 讀取 ${config.ip} 失敗:`, err.message);
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
        
        console.log(`[Access Control Driver] 發現設定檔，正在套用...`);

        // 套用設定到記憶體中的 LIVE_MODBUS_CONFIG
        for (const floor in overrides) {
            if (LIVE_MODBUS_CONFIG[floor]) {
                const saved = overrides[floor];
                const live = LIVE_MODBUS_CONFIG[floor];

                // 套用控制器設定
                if (saved.ip) live.ip = saved.ip;
                if (saved.port) live.port = saved.port;
                if (saved.slaveId) live.slaveId = saved.slaveId;
                
            }
        }
    } catch (err) {
        
        if (err.code !== 'ENOENT') {
            console.error("[Access Control Driver] 載入設定失敗:", err.message);
        }
    }
}

// ★ 正式 Modbus 模式的啟動邏輯
async function startModbusLoop() {
    console.log("[Access Control Driver] 驅動已啟動 (模式: 正式 Modbus)。");
    await loadConfigOverrides();

    // 1. 初始化 LIVE_DATA_CACHE
    for (const floor of Object.keys(LIVE_MODBUS_CONFIG)) {
        LIVE_DATA_CACHE[floor] = LIVE_MODBUS_CONFIG[floor].units.map(unit => ({
            id: unit.id,
            name: unit.name,
            household: unit.household,
            status: "locked",    // 初始狀態
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
function getDataByFloor(floorRequest) {
    if (USE_SIMULATION_MODE) {
        return SIMULATED_DATA[floorRequest] || [];
    } else {
        if (LIVE_DATA_CACHE[floorRequest]) {
            return LIVE_DATA_CACHE[floorRequest];
        }

        let combinedData = [];
        const prefix = floorRequest + "-"; // "1f-"
        
        Object.keys(LIVE_DATA_CACHE).forEach(key => {
            if (key.startsWith(prefix)) {
                combinedData = combinedData.concat(LIVE_DATA_CACHE[key]);
            }
        });

        return combinedData;
    }
}

function getUnitById(id) {
    const data = USE_SIMULATION_MODE ? SIMULATED_DATA : LIVE_DATA_CACHE;
    for (const key of Object.keys(data)) {
        const unit = data[key].find(u => u.id === id);
        if (unit) {
            return unit;
        }
    }
    return null;
}

//解除呼叫
async function resetStatus(id) {
    // 1. 模擬模式
    if (USE_SIMULATION_MODE) {
        let found = false;
        Object.values(SIMULATED_DATA).forEach(units => {
            const unit = units.find(u => u.id === id);
            if (unit) {
                unit.status = 'locked'; // 強制上鎖
                found = true;
            }
        });
        return found;
    }

    // 正式模式
    for (const floor of Object.keys(LIVE_MODBUS_CONFIG)) {
        const config = LIVE_MODBUS_CONFIG[floor];
        const unit = config.units.find(u => u.id === id);
        
        if (unit) {
            try {
                const isConnected = await ensureConnection(config);
                if (!isConnected) return false;

                // 寫入 false (0) 來解除/上鎖
                console.log(`[Access Driver] 正在重置 ${unit.location} (Coil: ${unit.diAddress + 1})...`);
                await config.client.writeCoil(unit.diAddress + 1, false);
                console.log(`[Access Driver] 指令發送成功！`);
                
                const cachedUnit = LIVE_DATA_CACHE[floor].find(u => u.id === id);
                if (cachedUnit) cachedUnit.status = 'locked';
                
                return true;
            } catch (err) {
                console.error(`[Access Driver] 重置失敗:`, err.message);
                return false;
            }
        }
    }
    return false;
}

function getAccessConfig(floorKey) {
    const config = LIVE_MODBUS_CONFIG[floorKey];
    if (!config) throw new Error(`找不到 ${floorKey} 的設定`);
    return {
        ip: config.ip,
        port: config.port,
        slaveId: config.slaveId,        
        units: config.units.map(u => ({
            id: u.id,
            location: u.location,
            name: u.name,
        }))
    };
}


async function setAccessConfig(floorKey, newSettings) {
    if (!LIVE_MODBUS_CONFIG[floorKey]) throw new Error(`找不到 ${floorKey}`);
    
    const config = LIVE_MODBUS_CONFIG[floorKey];
    config.ip = newSettings.ip;
    config.port = newSettings.port;
    config.slaveId = newSettings.slaveId;
    let allOverrides = {};
    try {
        if (require('fs').existsSync(CONFIG_OVERRIDES_PATH)) {
            allOverrides = JSON.parse(await fs.readFile(CONFIG_OVERRIDES_PATH, 'utf8'));
        }
    } catch(e) {}

    allOverrides[floorKey] = {
        ip: config.ip,
        port: config.port,
        slaveId: config.slaveId,
    };
    await fs.writeFile(CONFIG_OVERRIDES_PATH, JSON.stringify(allOverrides, null, 4));

    if (config.client.isOpen) config.client.close(()=>{});
}

// 導出函式
module.exports = {
    start,
    getDataByFloor,
    getUnitById,
    resetStatus,
    getAccessConfig,
    setAccessConfig
};
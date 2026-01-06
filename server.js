// 1. 導入需要的套件
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const ModbusRTU = require("modbus-serial");
const http = require('http');
const { WebSocketServer } = require('ws');
const Stream = require('node-rtsp-stream');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegBin = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
ffmpeg.setFfmpegPath(ffmpegBin); 
const fs = require('fs');
const path = require('path');
const ffmpegProcesses = new Map();
const os = require('os'); 
const bcrypt = require('bcryptjs');
const line = require('@line/bot-sdk');
const lightingDriver = require('./lightingDriver');
const intercomDriver = require('./intercomDriver');
const barrierDriver = require('./barrierDriver');
const theftpreventionDriver = require('./theftpreventionDriver');
const plumbingDriver = require('./plumbingDriver');

const localApp = express();
const PORT = process.env.PORT || 3000;
const HLS_DIR = path.join(os.tmpdir(), 'bms_hls_streams');

const CONFIG_PATH = path.join(__dirname, 'cctv_config.json');
let cctvData = {};

const USERS_CONFIG_PATH = path.join(__dirname, 'users_config.json');
let usersData = {}; 

const SETTINGS_CONFIG_PATH = path.join(__dirname, 'settings_config.json');
let appSettings = {};
let notificationState = {};

//
const REPAIRS_CONFIG_PATH = path.join(__dirname, 'repairs_config.json');
let repairsData = [];
const CLOUD_SERVER_URL = 'https://repair-relay-server.onrender.com';

// ★★★ 登入日誌檔路徑與資料變數 ★★★
const LOGS_PATH = path.join(__dirname, 'login_logs.json');
let loginLogs = [];

// 建立 HTTP 伺服器附加 WebSocket 伺服器
const server = http.createServer(localApp);
// ★ 建立 WSS 並附加到 http 伺服器上
const wss = new WebSocketServer({ server });
//console.log(`[WebSocket] 伺服器已附加到 HTTP 伺服器。`);
function broadcast(data) {
    const message = JSON.stringify(data);
    //console.log(`[WebSocket Server] 正在廣播 (共 ${wss.clients.size} 個客戶端): ${message}`);
    wss.clients.forEach(client => {
        // 檢查連線是否仍然開啟
        if (client.readyState === client.OPEN) {
            client.send(message);
        }
    });
}
    
//console.log(`[HLS] 影像串流檔案將儲存在: ${HLS_DIR}`);

try {
    if (fs.existsSync(HLS_DIR)) {
        // 遞迴刪除整個目錄及其內容
        fs.rmSync(HLS_DIR, { recursive: true, force: true });
        console.log('[HLS] 已成功清除舊的影像快取。');
    }
} catch (error) {
    console.warn('[HLS] 清除舊快取時遇到些問題', error.message);
}

// 重新建立全新的空目錄
if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, { recursive: true });
}

const BACKEND_URL = 'http://localhost:3000';

localApp.use(cors());
localApp.use(express.json());
localApp.use('/hls_streams', express.static(HLS_DIR));

// ★ Modbus 用戶端
const client = new ModbusRTU();
const modbusHost = "192.168.41.223";
const modbusPort = 502;
const modbusSlaveId = 1;

async function ensureModbusConnection() {
    if (client.isOpen) {
        return true; // 如果已連線，直接返回成功
    }
    //console.log(`[Modbus Client] 連線已中斷，正在嘗試重新連接到 ${modbusHost}:${modbusPort}...`);
    try {
        // 在連線前，先關閉可能存在的舊連線
        client.close(() => {});
        // 重新建立 TCP 連線
        await client.connectTCP(modbusHost, { port: modbusPort });
        client.setID(modbusSlaveId);
        console.log("[Modbus Client] 已成功重新連接到 Modbus 模擬器。");
        return true;
    } catch (err) {
        console.error("[Modbus Client] 重新連接失敗:", err.message);
        return false;
    }
}
// ★ 伺服器啟動時，進行第一次連線
ensureModbusConnection();


// 能源數據結構
let energyData = {
    power: {
        total: { realtime: 0, today: 0, month: 0 },
        residential: { realtime: 150.2, today: 2100.5, month: 55100.7 },
        office: { realtime: 100.3, today: 1150.3, month: 30139.5 }
    },
    water: {
        todayTotal: 0, // 總量初始為 0
        monthTotal: 0, // 總量初始為 0
        todayBreakdown: { residential: 80.2, office: 45.3 },
        monthBreakdown: { residential: 2150.4, office: 990.3 }
    },
    hourlyData: {
        residential: Array.from({ length: 24 }, () => Math.random() * 90 + 30),
        office: Array.from({ length: 24 }, () => Math.random() * 60 + 20),
        total: []
    },
    // ★★★耗能分析數據 ★★★
    consumptionAnalysis: {
        power: 1250.5,      // 電力
        ac: 850.2,          // 空調
        lighting: 450.8,    // 照明
        serverRoom: 320.1,  // 機房
        other: 150.9        // 其他
    }
};

// ★★★ 建立一個專門用來計算總量的函式，確保數據同步 ★★★
function calculateTotals() {
    // 計算電力總量 - 確保不會有負值
    energyData.power.total.realtime = Math.max(0, energyData.power.residential.realtime + energyData.power.office.realtime);
    energyData.power.total.today = Math.max(0, energyData.power.residential.today + energyData.power.office.today);
    energyData.power.total.month = Math.max(0, energyData.power.residential.month + energyData.power.office.month);

    // ★★★計算水度數總量 - 確保不會有負值 ★★★
    energyData.water.todayTotal = Math.max(0, energyData.water.todayBreakdown.residential + energyData.water.todayBreakdown.office);
    energyData.water.monthTotal = Math.max(0, energyData.water.monthBreakdown.residential + energyData.water.monthBreakdown.office);

    // 計算每小時用電總量 - 確保不會有負值
    for (let i = 0; i < 24; i++) {
        energyData.hourlyData.total[i] = Math.max(0, energyData.hourlyData.residential[i] + energyData.hourlyData.office[i]);
    }
    
    // 額外保護：確保所有分區數據都不是負值
    energyData.power.residential.realtime = Math.max(0, energyData.power.residential.realtime);
    energyData.power.residential.today = Math.max(0, energyData.power.residential.today);
    energyData.power.residential.month = Math.max(0, energyData.power.residential.month);
    energyData.power.office.realtime = Math.max(0, energyData.power.office.realtime);
    energyData.power.office.today = Math.max(0, energyData.power.office.today);
    energyData.power.office.month = Math.max(0, energyData.power.office.month);
}

// 模擬數據即時變化
setInterval(() => {
    // 1. 獲取當前時間的小時 (0-23)
    const hour = new Date().getHours();

    // 2. 定義一天24小時的住宅大樓用電基礎值 (單位: kW)
    const consumptionCurveKW = [
      // 0:00 - 5:00 (深夜低谷)
      60, 55, 50, 50, 55, 65,
      // 6:00 - 10:00 (早晨小高峰)
      120, 150, 130, 110, 100,
      // 11:00 - 17:00 (白天平穩)
      140, 150, 145, 140, 155, 160, 180,
      // 18:00 - 22:00 (晚間尖峰)
      280, 320, 350, 290, 220,
      // 23:00 (睡前下降)
      150
    ];

    // 3. 根據當前小時，計算住宅和公設的目標用電量
    const targetTotalConsumption = consumptionCurveKW[hour];
    const residentialRatio = 0.85;
    const targetResidential = targetTotalConsumption * residentialRatio;
    const targetOffice = targetTotalConsumption * (1 - residentialRatio);

    // 4. 計算一個“有方向性”的變化量
    const residentialDiff = targetResidential - energyData.power.residential.realtime;
    const officeDiff = targetOffice - energyData.power.office.realtime;
    const residentialChange = (residentialDiff * 0.1) + (Math.random() - 0.5) * 5;
    const officeChange = (officeDiff * 0.1) + (Math.random() - 0.5) * 3;
    
    // 5. 更新即時用電量
    energyData.power.residential.realtime = Math.max(0, energyData.power.residential.realtime + residentialChange);
    energyData.power.office.realtime = Math.max(0, energyData.power.office.realtime + officeChange);
    
    // 更新累積數據
    energyData.power.residential.today += Math.random() * 2;
    energyData.power.residential.month += Math.random() * 2;
    energyData.power.office.today += Math.random() * 2;
    energyData.power.office.month += Math.random() * 2;
    energyData.water.todayBreakdown.residential += Math.random() * 0.2;
    energyData.water.todayBreakdown.office += Math.random() * 0.1;
    energyData.water.monthBreakdown.residential += Math.random() * 0.2;
    energyData.water.monthBreakdown.office += Math.random() * 0.1;
    
    // ★ 關鍵修改：讓 hourlyData 的數據來源於真實的日夜曲線 ★
    // 而不是舊的 Math.random()
    energyData.hourlyData.residential = consumptionCurveKW.map(val => val * residentialRatio);
    energyData.hourlyData.office = consumptionCurveKW.map(val => val * (1 - residentialRatio));
    
    // 7. 在每次更新分區數據後，都重新計算一次總量
    calculateTotals();
    
}, 2000);

// --- ★★★ 歷史紀錄數據生成邏輯 ★★★ ---

// 台灣電力公司 2023 年的電力排碳係數 (公斤 CO2e / 度)
const CARBON_EMISSION_FACTOR = 0.495;

function generateHistoricalData(dateStr) {
    // 根據日期生成一個隨機種子，讓同一天的數據保持一致
    const seed = dateStr.split('-').reduce((acc, val) => acc + parseInt(val), 0);
    const random = (min, max) => {
        const x = Math.sin(seed) * 10000;
        // 簡單的偽隨機數生成
        return min + (x - Math.floor(x)) * (max - min);
    };

    const officeConsumption = {
        power: random(1200, 1500),
        ac: random(800, 1000),
        lighting: random(400, 500),
        serverRoom: random(300, 400),
        other: random(150, 200)
    };
    
    const residentialConsumption = random(2000, 2500);

    const totalOffice = Object.values(officeConsumption).reduce((sum, val) => sum + val, 0);
    const totalConsumption = totalOffice + residentialConsumption;
    const carbonEmission = totalConsumption * CARBON_EMISSION_FACTOR;

    return {
        date: dateStr,
        officeConsumption,
        totalOfficeConsumption: totalOffice,
        residentialConsumption,
        totalConsumption,
        carbonEmission
    };
}

// ★★★ 火警偵測器數據 ★★★
// 我們為不同樓層定義不同的偵測器
const fireAlarmData = {
    "1f": [
        { id: "FA-1-01", name: "??1048_28", locationName: "空間 A", active: true },        
    ],
      
};

// ★★★ 模擬火警隨機發生與解除 ★★★
setInterval(() => {
    // 遍歷所有樓層的所有偵測器
    Object.keys(fireAlarmData).forEach(floor => {
        fireAlarmData[floor].forEach(detector => {
            // 用一個很小的機率來觸發或解除警報
            if (Math.random() < 0.3) {
                detector.active = !detector.active; // 切換狀態 (true/false)
                //console.log(`火警狀態變更: ${floor} - ${detector.locationName} 的警報狀態為 ${detector.active}`);
            }
        });
    });
}, 5000); // 每 5 秒鐘檢查一次

// ★★★ 停車管理系統數據 ★★★
const parkingData = {
    "b3f": [
            // 標準車位 (119個: StandardPK 到 StandardPK_118)
            ...Array.from({ length: 119 }, (_, i) => {
                const id = String(i + 1).padStart(2, '0');
                const name = i === 0 ? "StandardPK" : `StandardPK_${i}`;
                const locationNum = i + 1;
                // 設定一些車位有車的初始狀態
                const hasCarPositions = [3, 6, 9, 13, 16, 19]; // 對應原本有車的位置
                const status = hasCarPositions.includes(i + 1) ? "有車" : "空位";
        
                return {
                    id: `PS-B3-${String(i + 1).padStart(3, '0')}`,
                    name: name,
                    locationName: `車位 #${locationNum}`,
                    status: status
                };
            }),
    
            // 小型車位 (25個: SmallPK 到 SmallPK_24)
            ...Array.from({ length: 25 }, (_, i) => {
                const id = String(i + 120).padStart(3, '0');
                const name = i === 0 ? "SmallPK" : `SmallPK_${i}`;
                const locationNum = i + 120;
                // 設定大部分小型車位有車的初始狀態
                const status = i >= 1 && i <= 24 ? "有車" : "空位";
        
                return {
                    id: `PS-B3-${id}`,
                    name: name,
                    locationName: `車位 #${locationNum}`,
                    status: status
                };
            })
        ],

    "b2f": [
        // 標準車位 (115個: StandardPKB2 到 StandardPKB2_115)
        ...Array.from({ length: 116 }, (_, i) => {
            const id = String(i + 1).padStart(2, '0');
            const name = i === 0 ? "StandardPKB2" : `StandardPKB2_${i}`;
            const locationNum = 143 + i;

            return {
                id: `PS-B2-${id}`,
                name: name,
                locationName: `車位 #${locationNum}`,
                status: "空位"
            };
        }),

        // 小型車位 (22個: SmallPKB2 到 SmallPKB2_22)
        ...Array.from({ length: 23 }, (_, i) => {
            const id = String(i + 117).padStart(2, '0');
            const name = i === 0 ? "SmallPKB2" : `SmallPKB2_${i}`;
            const locationNum = 258 + i;

            return {
                id: `PS-B2-${id}`,
                name: name,
                locationName: `車位 #${locationNum}`,
                status: "空位"
            };
        })
    ],

    "b1f": [
        { id: "PS-B1-01", name: "StandardPKB1", locationName: "車位 #282", status: "空位", type: "car" },
        { id: "PS-B1-02", name: "StandardPKB1_1", locationName: "車位 #283", status: "空位", type: "car"  },
        { id: "PS-B1-03", name: "StandardPKB1_2", locationName: "車位 #284", status: "空位", type: "car"  },
        { id: "PS-B1-04", name: "StandardPKB1_3", locationName: "車位 #285", status: "空位", type: "car"  },
        { id: "PS-B1-05", name: "StandardPKB1_4", locationName: "車位 #286", status: "空位", type: "car"  },
        { id: "PS-B1-06", name: "StandardPKB1_5", locationName: "車位 #287", status: "空位", type: "car"  },
        { id: "PS-B1-07", name: "StandardPKB1_6", locationName: "車位 #288", status: "空位", type: "car"  },
        { id: "PS-B1-08", name: "StandardPKB1_7", locationName: "車位 #289", status: "空位", type: "car"  },
        { id: "PS-B1-09", name: "StandardPKB1_8", locationName: "車位 #290", status: "空位", type: "car"  },
        { id: "PS-B1-10", name: "StandardPKB1_9", locationName: "車位 #291", status: "空位", type: "car"  },
        { id: "PS-B1-11", name: "StandardPKB1_10", locationName: "車位 #292", status: "空位", type: "car"  },
        { id: "PS-B1-12", name: "StandardPKB1_11", locationName: "車位 #293", status: "空位", type: "car"  },
        { id: "PS-B1-13", name: "StandardPKB1_12", locationName: "車位 #294", status: "空位", type: "car"  },
        { id: "PS-B1-14", name: "StandardPKB1_13", locationName: "車位 #295", status: "空位", type: "car"  },
        { id: "PS-B1-15", name: "StandardPKB1_14", locationName: "車位 #296", status: "空位", type: "car"  },
        { id: "PS-B1-16", name: "SmallPKB1", locationName: "車位 #297", status: "空位", type: "car"  },
        { id: "PS-B1-17", name: "SmallPKB1_1", locationName: "車位 #298", status: "空位", type: "car"  },
        { id: "PS-B1-18", name: "SmallPKB1_2", locationName: "車位 #299", status: "空位", type: "car"  },
        { id: "PS-B1-19", name: "DisabledParking_5", locationName: "車位 #300", status: "空位", type: "car"  },
        { id: "PS-B1-20", name: "DisabledParkingB_1", locationName: "車位 #301", status: "空位", type: "car"  },
        { id: "PS-B1-21", name: "DisabledParking_1", locationName: "車位 #302", status: "空位", type: "car"  },
        { id: "PS-B1-22", name: "DisabledParking_3", locationName: "車位 #303", status: "空位", type: "car"  },                    
        // 機車位 (從StandardMPK1008到StandardMPK1492，共485個)
        /*...Array.from({ length: 499 }, (_, i) => {
            const num = i + 1;
            const paddedNum = String(num).padStart(3, '0');
            const mpkNum = 1008 + i;
        
            return {
                id: `PSm-B1-${String(num).padStart(2, '0')}`,
                name: `StandardMPK${mpkNum}`,
                locationName: `機車位 #${paddedNum}`,
                status: "空位",
                type: "motorcycle"
            };
        })*/
    ],
    
};

// ★★★ 模擬停車位狀態隨機變化 ★★★
setInterval(() => {
    Object.keys(parkingData).forEach(floor => {
        parkingData[floor].forEach(space => {
            if (Math.random() < 0.15) { // 15% 的機率改變狀態
                // 根據加權機率來決定新狀態
                const rand = Math.random();
                if (rand < 0.45) {
                    space.status = "空位";      // 45% 機率
                } else if (rand < 0.99) {
                    space.status = "有車";      // 54% 機率
                } else {
                    space.status = "故障";      // 1% 機率
                }
                //console.log(`停車位狀態變更: ${floor} - ${space.locationName} 的狀態為 ${space.status}`);
            }
        });
    });
}, 3000); // 每 3 秒鐘檢查一次

// ★★★ 車道號誌數據 ★★★
let trafficLightData = {
    "b3f": {
        "main_entrance": { 
            id: "TL-B3-01", 
            name: "Lane", // B3F 主入口號誌燈的模型名稱
            locationName: "主車道號誌",
            status: "green" 
        }
    },
    "b2f": {
        "up_lane": {
            id: "TL-B2-UP",
            name: "Laneb2u", // B2F 上行車道號誌燈的模型名稱
            locationName: "上行車道",
            status: "green"
        },
        "down_lane": {
            id: "TL-B2-DOWN",
            name: "Laneb2d", // B2F 下行車道號誌燈的模型名稱
            locationName: "下行車道",
            status: "red"
        }
    },
    "b1f": {
        "up_lane": {
            id: "TL-B1-UP",
            name: "Laneb1u", // B1F 上行車道號誌燈的模型名稱
            locationName: "上行車道",
            status: "green"
        },
        "down_lane": {
            id: "TL-B1-DOWN",
            name: "Laneb1d", // B1F 下行車道號誌燈的模型名稱
            locationName: "下行車道",
            status: "red"
        }
    }
};

// ★★★ 模擬車道號誌狀態隨機變化 ★★★
setInterval(() => {
    Object.keys(trafficLightData).forEach(floor => {
        Object.keys(trafficLightData[floor]).forEach(lightId => {
            if (Math.random() < 0.3) { // 30% 的機率改變狀態
                trafficLightData[floor][lightId].status = (trafficLightData[floor][lightId].status === "green") ? "red" : "green";
                //console.log(`車道號誌狀態變更: ${floor} - ${lightId} 的狀態為 ${trafficLightData[floor][lightId].status}`);
            }
        });
    });
}, 5000); // 每 5 秒鐘檢查一次

// ★★★ 電梯數據結構與模擬邏輯 (V2.0) ★★★
const allFloors = ['RF', '17F', '16F', '15F', '14F', '13F', '12F', '11F', '10F', '9F', '8F', '7F', '6F', '5F', '4F', '3F', '2F', '1F', 'B1F', 'B2F', 'B3F'];
const runStatuses = ["自動運轉", "自動休止", "停電運轉", "電梯故障"];
let powerOutageStartTime = 0; // 記錄停電開始時間
const POWER_OUTAGE_MIN_DURATION = 3000; // 停電最少維持3秒鐘

let elevatorsData = [
    { id: 1, name: "1號昇降梯", serviceFloors: ['RF', '17F', '16F', '15F', '14F', '13F', '12F', '11F', '10F', '9F', '8F', '7F', '6F', '5F', '4F', '3F', '2F', '1F'], currentFloor: '1F', direction: 'idle', doorStatus: 'closed', carCalls: [], hallCalls: [], emergencyCall: false, lastEmergencyTime: 0, runTime: 2, startupCount: 3, manualMode: false, streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live"  },
    { id: 2, name: "2號昇降梯", serviceFloors: ['RF', '17F', '16F', '15F', '14F', '13F', '12F', '11F', '10F', '9F', '8F', '7F', '6F', '5F', '4F', '3F', '2F', '1F'], currentFloor: '1F', direction: 'idle', doorStatus: 'closed', carCalls: [], hallCalls: [], emergencyCall: false, lastEmergencyTime: 0, runTime: 1, startupCount: 4, manualMode: false, streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live"   },
    { id: 3, name: "3號無障礙昇降梯", serviceFloors: allFloors, currentFloor: 'B3F', direction: 'idle', doorStatus: 'closed', carCalls: [], hallCalls: [], emergencyCall: false, lastEmergencyTime: 0, runTime: 21, startupCount: 19, manualMode: false, streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live"   },
    { id: 4, name: "4號無障礙昇降梯", serviceFloors: allFloors, currentFloor: 'B3F', direction: 'idle', doorStatus: 'closed', carCalls: [], hallCalls: [], emergencyCall: false, lastEmergencyTime: 0, runTime: 10, startupCount: 11, manualMode: false, streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live"   },
    { id: 5, name: "5號緊急昇降梯", serviceFloors: allFloors, currentFloor: 'B3F', direction: 'idle', doorStatus: 'closed', carCalls: [], hallCalls: [], emergencyCall: false, lastEmergencyTime: 0, runTime: 25, startupCount: 22, manualMode: false, streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live"   },
    { id: 6, name: "6號昇降梯", serviceFloors: ['RF', '17F', '16F', '15F', '14F', '13F', '12F', '11F', '10F', '9F', '8F', '7F', '6F', '5F', '4F', '3F', '2F', '1F'], currentFloor: '1F', direction: 'idle', doorStatus: 'closed', carCalls: [], hallCalls: [], emergencyCall: false, lastEmergencyTime: 0, runTime: 2, startupCount: 3, manualMode: false, streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live"  },
    { id: 7, name: "7號昇降梯", serviceFloors: ['RF', '17F', '16F', '15F', '14F', '13F', '12F', '11F', '10F', '9F', '8F', '7F', '6F', '5F', '4F', '3F', '2F', '1F'], currentFloor: '1F', direction: 'idle', doorStatus: 'closed', carCalls: [], hallCalls: [], emergencyCall: false, lastEmergencyTime: 0, runTime: 1, startupCount: 4, manualMode: false, streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live"   },
    { id: 8, name: "8號無障礙昇降梯", serviceFloors: allFloors, currentFloor: 'B3F', direction: 'idle', doorStatus: 'closed', carCalls: [], hallCalls: [], emergencyCall: false, lastEmergencyTime: 0, runTime: 21, startupCount: 19, manualMode: false, streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live"   },
    { id: 9, name: "9號無障礙昇降梯", serviceFloors: allFloors, currentFloor: 'B3F', direction: 'idle', doorStatus: 'closed', carCalls: [], hallCalls: [], emergencyCall: false, lastEmergencyTime: 0, runTime: 10, startupCount: 11, manualMode: false, streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live"   },
    { id: 10, name: "10號緊急昇降梯", serviceFloors: allFloors, currentFloor: 'B3F', direction: 'idle', doorStatus: 'closed', carCalls: [], hallCalls: [], emergencyCall: false, lastEmergencyTime: 0, runTime: 25, startupCount: 22, manualMode: false, streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live"   },
];

setInterval(() => {
    // 1. 隨機產生叫車信號 - 修正：只分配給運作中的電梯
    const randomFloor = allFloors[Math.floor(Math.random() * allFloors.length)];
    if (Math.random() < 0.1) {
        const randomDirection = Math.random() > 0.5 ? 'up' : 'down';
        
        // ★ 修正：只有運作中的電梯才能接收樓層呼叫
        const operatingElevators = elevatorsData.filter(e => 
            !e.manualMode && // 非手動模式
            (e.runStatus === "自動運轉" || e.runStatus === "停電運轉") && // 運轉狀態
            e.serviceFloors.includes(randomFloor) // 服務該樓層
        );
        
        // 如果有可用的電梯，隨機選擇一台來接收呼叫
        if (operatingElevators.length > 0) {
            const targetElevator = operatingElevators[Math.floor(Math.random() * operatingElevators.length)];
            if (!targetElevator.hallCalls.some(c => c.floor === randomFloor)) {
                targetElevator.hallCalls.push({ floor: randomFloor, direction: randomDirection });
                //console.log(`樓層呼叫分配: ${randomFloor} -> ${targetElevator.name}`);
            }
        }
    }
    
    // 2. 檢查當前是否有停電狀態
    const currentTime = Date.now();
    const currentPowerOutage = elevatorsData.some(e => e.runStatus === "停電運轉");
    
    // 記錄停電開始時間
    if (currentPowerOutage && powerOutageStartTime === 0) {
        powerOutageStartTime = currentTime;
        console.log("系統進入停電模式");
    }
    
    // 如果目前沒有停電，重置停電開始時間
    if (!currentPowerOutage) {
        powerOutageStartTime = 0;
    }
    
    // 3. 更新每台電梯的狀態（但要考慮停電持續時間）
    elevatorsData.forEach(elevator => {
        // ★ 修正運轉狀態邏輯 - 確保1-4號電梯永遠不會出現"停電運轉"狀態
        if (Math.random() < 0.1) {
            if (elevator.id === 5 || elevator.id === 10) {
                // 如果停電已經持續超過3秒，才允許5號10號電梯離開停電狀態
                if (elevator.runStatus === "停電運轉" && 
                    powerOutageStartTime > 0 && 
                    (currentTime - powerOutageStartTime) < POWER_OUTAGE_MIN_DURATION) {
                    // 停電時間未滿3秒，保持停電狀態
                    elevator.runStatus = "停電運轉";
                } else {
                    // 5號10號電梯可以隨機切換到所有狀態
                    elevator.runStatus = runStatuses[Math.floor(Math.random() * runStatuses.length)];
                }
            } else {
                // ★ 1-4號電梯只能有前三種狀態，永遠不會出現"停電運轉"
                const availableStatuses = ["自動運轉", "自動休止", "電梯故障"]; // 明確排除"停電運轉"
                elevator.runStatus = availableStatuses[Math.floor(Math.random() * availableStatuses.length)];
            }
        }

        // ★ 確保電梯有初始運轉狀態
        if (!elevator.runStatus) {
            elevator.runStatus = "自動運轉";
        }

        // ★ 初始化統計計數器
        elevator.secondsCounter = elevator.secondsCounter || 0;
        elevator.lastDirection = elevator.lastDirection || 'idle';

        // ★ 運轉時間統計 - 只要電梯處於運轉狀態就累積時間
        if (elevator.runStatus === "自動運轉" || elevator.runStatus === "停電運轉") {
            elevator.secondsCounter += 2; // 每2秒累積一次
        
            // 每60秒轉換為1分鐘
            if (elevator.secondsCounter >= 60) {
                elevator.runTime += 1;
                elevator.secondsCounter -= 60;
                console.log(`電梯 ${elevator.name} 運轉時間更新: ${elevator.runTime} 分鐘`);
            }
        }

        // ★ 啟動次數統計 - 偵測方向變化
        if (elevator.lastDirection === 'idle' && elevator.direction !== 'idle') {
            elevator.startupCount++;
            //console.log(`電梯 ${elevator.name} 啟動次數更新: ${elevator.startupCount}`);
        }
    
        // 更新上次方向記錄
        elevator.lastDirection = elevator.direction;
    });

    // ★ 檢查是否有5號10號電梯處於停電運轉狀態（精確檢查）
    const fiveElevator = elevatorsData.find(e => e.id === 5 || e.id === 10);
    const hasPowerOutage = fiveElevator && fiveElevator.runStatus === "停電運轉";
    
    // 4. 根據停電狀態處理電梯邏輯
    elevatorsData.forEach(elevator => {
        // ★ 如果電梯處於手動模式，就跳過所有自動模擬邏輯
        if (elevator.manualMode) {
            return; 
        }
        
        // ★ 停電運轉邏輯 - 只有當5號10號電梯處於「停電運轉」時，其他電梯才進入停電停止
        if (hasPowerOutage) {
            if (elevator.id !== 5 && elevator.id !== 10) {
                // 1-4號電梯在停電時停止運轉且無條件開門
                elevator.carCalls = [];
                elevator.hallCalls = [];
                elevator.direction = 'idle';
                elevator.doorStatus = 'open'; // 無條件開門
                elevator.runStatus = "停電停止"; // 特殊狀態表示因停電而停止
                return; // 跳過所有邏輯
            }
            // 5號電梯在停電時仍可正常運轉（在停電運轉狀態下）
        } else {
            // ★ 停電解除邏輯 - 當5號10號電梯離開停電運轉狀態時，恢復1-4號電梯的正常狀態
            if (elevator.runStatus === "停電停止") {
                elevator.runStatus = "自動運轉"; // 恢復為自動運轉
                elevator.doorStatus = 'closed'; // 關閉門
                console.log(`電梯 ${elevator.name} 停電解除，恢復正常運轉`);
            }
        }

        // ★ 緊急呼叫邏輯優化 - 降低機率並加入冷卻時間
        const timeSinceLastEmergency = currentTime - elevator.lastEmergencyTime;
        const cooldownPeriod = 30000; // 30秒冷卻時間

        if (!elevator.emergencyCall && 
            timeSinceLastEmergency > cooldownPeriod && 
            Math.random() < 0.01) { // 降低到1%機率
            
            elevator.emergencyCall = true; // 只設為 true，不會自動變成 false
            elevator.lastEmergencyTime = currentTime;
            console.log(`電梯 ${elevator.name} 發生緊急呼叫！`);
        }

        // ★ 修正：檢查電梯是否應該停止運作並清除呼叫
        if (elevator.runStatus === "自動休止" || elevator.runStatus === "電梯故障") {
            elevator.carCalls = [];
            elevator.hallCalls = []; // 清除樓層呼叫
            elevator.direction = 'idle';
            elevator.doorStatus = 'closed';
            return; // 跳過所有移動邏輯
        }

        // ★ 停電停止狀態處理 - 無條件開門且不執行任何運轉邏輯
        if (elevator.runStatus === "停電停止") {
            elevator.doorStatus = 'open'; // 確保門始終開啟
            return; // 跳過所有移動邏輯
        }

        // ★ 只有在"自動運轉"或"停電運轉"狀態下才執行正常邏輯
        if (elevator.runStatus === "自動運轉" || elevator.runStatus === "停電運轉") {
            // ★ 優化車廂內叫車生成邏輯
            if (Math.random() < 0.08) { // 提高叫車機率到8%
                const randomCarCallFloor = elevator.serviceFloors[Math.floor(Math.random() * elevator.serviceFloors.length)];
                // 避免重複叫車同一樓層，且不叫車到當前樓層
                if (!elevator.carCalls.includes(randomCarCallFloor) && randomCarCallFloor !== elevator.currentFloor) {
                    elevator.carCalls.push(randomCarCallFloor);
                    //console.log(`電梯 ${elevator.name} 車廂內叫車: ${randomCarCallFloor}`);
                }
            }

            // ★ 限制車廂內叫車數量，避免過多
            if (elevator.carCalls.length > 3) {
                elevator.carCalls = elevator.carCalls.slice(0, 3); // 最多保留3個叫車
            }

            const currentFloorIndex = elevator.serviceFloors.indexOf(elevator.currentFloor);
            const allCalls = [...elevator.carCalls, ...elevator.hallCalls.map(c => c.floor)];
            
            // 判斷是否在當前樓層開門
            if (allCalls.includes(elevator.currentFloor)) {
                elevator.direction = 'idle';
                elevator.doorStatus = 'open';
                // 移除已到達的叫車樓層
                elevator.carCalls = elevator.carCalls.filter(f => f !== elevator.currentFloor);
                elevator.hallCalls = elevator.hallCalls.filter(c => c.floor !== elevator.currentFloor);
                setTimeout(() => elevator.doorStatus = 'closed', 1500);
                return;
            }

            // 判斷移動方向
            if (elevator.direction === 'idle' && allCalls.length > 0) {
                const nextTargetFloor = allCalls[0];
                const nextTargetIndex = elevator.serviceFloors.indexOf(nextTargetFloor);
                elevator.direction = nextTargetIndex > currentFloorIndex ? 'down' : 'up';
            }

            // 執行移動
            if (elevator.direction === 'up' && currentFloorIndex > 0) {
                elevator.currentFloor = elevator.serviceFloors[currentFloorIndex - 1];
            } else if (elevator.direction === 'down' && currentFloorIndex < elevator.serviceFloors.length - 1) {
                elevator.currentFloor = elevator.serviceFloors[currentFloorIndex + 1];
            } else {
                elevator.direction = 'idle';
            }
        }
    });
}, 2000);

// ★★★ 產生電梯月度報告的函式 ★★★
function generateElevatorMonthlyReport(year, month, elevatorId) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const dailySummaries = [];
    const eventLogs = [];
    const elevatorName = elevatorsData.find(e => e.id == elevatorId)?.name || `${elevatorId}號昇降梯`;

    // 修正隨機數生成函式
    const seed = parseInt(year) * 1000 + parseInt(month) * 100 + parseInt(elevatorId);
    const random = (min, max, day = 1) => {
        const x = Math.sin(seed * day * 1.23) * 10000;
        return Math.floor(min + Math.abs(x - Math.floor(x)) * (max - min + 1));
    };

    // 產生每日摘要數據
    for (let day = 1; day <= daysInMonth; day++) {
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        
        dailySummaries.push({
            日期: date,
            運轉時間: random(180, 480, day), // 3-8小時（分鐘）
            啟動次數: random(15, 45, day),
            故障次數: random(0, 2, day * 7) // 較低的故障機率
        });

        // 產生事件紀錄
        const numEvents = random(3, 8, day);
        for (let i = 0; i < numEvents; i++) {
            const hour = random(6, 22, day + i); // 工作時間範圍
            const minute = random(0, 59, day + i * 3);
            const second = random(0, 59, day + i * 5);
            const timestamp = `${date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
            
            const eventType = random(1, 10, day * i);
            let event, floor;
            
            // 根據電梯ID決定服務樓層
            const serviceFloors = elevatorId <= 2 ? 
                ['1F', '2F', '3F', '4F', '5F'] : 
                ['B3F', 'B2F', 'B1F', '1F', '2F', '3F', '4F', '5F'];
            
            floor = serviceFloors[random(0, serviceFloors.length - 1, day + i * 2)];
            
            if (eventType <= 4) {
                event = "啟動";
            } else if (eventType <= 7) {
                event = "到達樓層";
            } else if (eventType <= 8) {
                event = "門開啟";
            } else if (eventType <= 9) {
                event = "門關閉";
            } else {
                event = "緊急呼叫";
            }
            
            eventLogs.push({ 
                時間: timestamp, 
                電梯: elevatorName, 
                事件: event, 
                樓層: floor 
            });
        }
    }

    // 按時間排序事件紀錄
    eventLogs.sort((a, b) => new Date(a.時間) - new Date(b.時間));
    
    return { dailySummaries, eventLogs };
}

// ★★★ 空調控制系統數據  ★★★
const acData = {
    "1f": [
        { id: "AC-1F-01", name: "PEY-SM30JA(L)-TH_1", modbusAddress: 0, locationName: "防災中心空調", status: "未知", mode: "送風", setTemperature: 25, currentTemperature: 26, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-02", name: "PEY-SM30JA(L)-TH002_1", modbusAddress: 1, locationName: "辦公室空調", status: "未知", mode: "冷氣", setTemperature: 24, currentTemperature: 28, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "停止"  },
        { id: "AC-1F-03", name: "PEY-SM30JA(L)-TH001_1", modbusAddress: 2, locationName: "門廳空調", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-04", name: "PEY-SM30JA(L)-TH003_1", modbusAddress: 3, locationName: "閱覽室空調1", status: "未知", mode: "送風", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-05", name: "PEY-SM30JA(L)-TH004_1", modbusAddress: 4, locationName: "閱覽室空調2", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-06", name: "PEY-SM30JA(L)-TH005_1", modbusAddress: 5, locationName: "閱覽室空調3", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-07", name: "PEY-SM30JA(L)-TH006_1", modbusAddress: 6, locationName: "閱覽室空調4", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-08", name: "PEY-SM30JA(L)-TH007_1", modbusAddress: 7, locationName: "閱覽室空調5", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-09", name: "PEY-SM30JA(L)-TH008_1", modbusAddress: 8, locationName: "閱覽室空調6", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-10", name: "PEY-SM30JA(L)-TH009_1", modbusAddress: 9, locationName: "閱覽室空調7", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-11", name: "PEY-SM30JA(L)-TH010_1", modbusAddress: 10, locationName: "閱覽室空調8", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-12", name: "PEY-SM30JA(L)-TH011_1", modbusAddress: 11, locationName: "閱覽室空調9", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-13", name: "PEY-SM30JA(L)-TH012_1", modbusAddress: 12, locationName: "閱覽室空調10", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-14", name: "PEY-SM30JA(L)-TH013_1", modbusAddress: 13, locationName: "閱覽室空調11", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-15", name: "PEY-SM30JA(L)-TH014_1", modbusAddress: 14, locationName: "閱覽室空調12", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-16", name: "PEY-SM30JA(L)-TH015_1", modbusAddress: 15, locationName: "閱覽室空調13", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-17", name: "PEY-SM30JA(L)-TH016_1", modbusAddress: 16, locationName: "店鋪空調1", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-18", name: "PEY-SM30JA(L)-TH017_1", modbusAddress: 17, locationName: "店鋪空調2", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-19", name: "PEY-SM30JA(L)-TH018_1", modbusAddress: 18, locationName: "店鋪空調3", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-20", name: "PEY-SM30JA(L)-TH019_1", modbusAddress: 19, locationName: "店鋪空調4", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
        { id: "AC-1F-21", name: "PEY-SM30JA(L)-TH020_1", modbusAddress: 20, locationName: "店鋪空調5", status: "未知", mode: "冷氣", setTemperature: 22, currentTemperature: 21, fanSpeed: "自動", verticalSwing: "auto", horizontalSwing: "auto", previousStatus: "運轉中"  },
       
    ],    
};
// ★★★ 模擬空調狀態隨機變化  ★★★
const acModes = ["送風", "冷氣", "暖氣", "除濕"];
setInterval(async () => {
    try {
        const isConnected = await ensureModbusConnection();
        if (!isConnected) return;

        for (const floor in acData) {
            for (const unit of acData[floor]) {
                // 1. 讀取開關狀態 (Holding Registers, 位址 0-20)
                const statusResponse = await client.readHoldingRegisters(unit.modbusAddress, 1);
                const newStatus = statusResponse.data[0] === 256 ? "運轉中" : "停止";
                if (unit.status !== newStatus) {
                    unit.status = newStatus;
                }

                // 2. ★ 修正：讀取現在溫度 (根據CSV配置，地址從22開始，每個設備+2)
                const tempReadAddress = 22 + (unit.modbusAddress * 2);
                const currentTempResponse = await client.readHoldingRegisters(tempReadAddress, 1);
                unit.currentTemperature = currentTempResponse.data[0] / 10.0;

                // 3. ★ 修正：讀取設定溫度 (使用相同的溫度地址)
                const setTempResponse = await client.readHoldingRegisters(tempReadAddress, 1);
                unit.setTemperature = setTempResponse.data[0] / 10.0;
                
                console.log(`[溫度監控] ${unit.locationName} (地址:${tempReadAddress}) - 現在溫度: ${unit.currentTemperature}°C, 設定溫度: ${unit.setTemperature}°C`);
            }
        }
    } catch (err) {
        console.error(`[Modbus Client] 讀取 Modbus 數據失敗: ${err.message}`);
        client.close(() => {});
    }
}, 3000);

// ★★★太陽能發電數據結構 ★★★
let solarData = {
    pv: 0,              // 太陽能發電功率 (kW)
    grid: 0,            // 市電功率 (kW, >0 為賣電, <0 為買電)
    load: 0,            // 負載用電功率 (kW)
    batteryPower: 0,    // 電池功率 (kW, >0 為放電, <0 為充電)
    batterySOC: 75.0,   // 電池電量百分比 (%)
    today: {
        totalGeneration: 15.5, // 本日累積發電量 (kWh)
    },
    hourly: {
        generation: Array(24).fill(0),
        consumption: Array(24).fill(0)
    }
};

// ★★★模擬太陽能數據的函式 ★★★
function updateSolarData() {
    const now = new Date();
    const hour = now.getHours();

    // 模擬一天中的太陽能發電曲線 (早上6點到晚上6點)
    const generationCurve = [0, 0, 0, 0, 0, 0.5, 2, 5, 8, 10, 12, 13, 12, 10, 8, 5, 2, 0.5, 0, 0, 0, 0, 0, 0];
    // 確保 pvGeneration 不為負值
    const pvGeneration = Math.max(0, generationCurve[hour] + (Math.random() - 0.5));

    // 模擬住宅用電曲線 (與 energyData 同步)
    const loadConsumption = energyData.power.total.realtime;   
    
    const BATTERY_CHARGE_RESERVATION_RATE = 0.3; // ★ 保留 30% 的太陽能發電優先給電池充電
    const MIN_SOC_FOR_DISCHARGE = 20.0; // ★ 電池電量低於 20% 時，停止放電以保護電池
    const MAX_BATTERY_CHARGE_RATE = 5;
    const MAX_BATTERY_DISCHARGE_RATE = 5;

    // 2. 初始化變數
    let gridPower = 0;
    let batteryPower = 0;
    
    // 3. 計算分配給負載和電池的太陽能電力
    let pvToCharge = pvGeneration * BATTERY_CHARGE_RESERVATION_RATE;
    let pvToLoad = pvGeneration * (1 - BATTERY_CHARGE_RESERVATION_RATE);
    let deficit = loadConsumption - pvToLoad; // 負載還需要多少電

    if (deficit > 0) { // 太陽能不足以供應負載
        // 嘗試從電池放電來補足缺口
        if (solarData.batterySOC > MIN_SOC_FOR_DISCHARGE) {
            const dischargePower = Math.min(deficit, MAX_BATTERY_DISCHARGE_RATE);
            batteryPower = dischargePower; // 正數代表放電
            deficit -= dischargePower;
        }
    } else {
        // 太陽能供應負載後還有剩餘，將剩餘部分也拿去充電
        pvToCharge += Math.abs(deficit);
        deficit = 0;
    }

    // 5. 處理電池充電
    if (pvToCharge > 0 && solarData.batterySOC < 100) {
        const actualChargePower = Math.min(pvToCharge, MAX_BATTERY_CHARGE_RATE);
        // 如果電池同時在放電和充電，這是不可能的，所以要合併
        batteryPower -= actualChargePower; // 負數代表充電
    }

    // 6. 處理與市電的互動
    if (deficit > 0) {
        // 如果經過太陽能和電池供電後，電力仍然不足，則從市電買電
        gridPower = -deficit; // 負數代表買電
    } else {
        // 如果供應完負載和電池充電後，太陽能還有剩餘，則賣給市電
        const surplus = pvGeneration - loadConsumption - Math.abs(batteryPower);
        if (surplus > 0) {
            gridPower = surplus; // 正數代表賣電
        }
    }

    // 7. 更新電池電量 (SOC)
    if (batteryPower !== 0) {
        const socChange = (batteryPower / 50) * (5/3600) * 100; // 假設電池容量為 50kWh
        solarData.batterySOC -= socChange; // 充電為負，所以用減
        solarData.batterySOC = Math.max(0, Math.min(100, solarData.batterySOC));
    }

    // 8. 更新最終的 solarData 物件
    solarData.pv = pvGeneration;
    solarData.load = loadConsumption;
    solarData.grid = gridPower;
    solarData.batteryPower = batteryPower;
    solarData.today.totalGeneration += pvGeneration / (3600 / 5); // 5秒累積一次
    
    // ★ 關鍵修改：讓太陽能儀表板的圖表也使用同步的日夜曲線數據 ★
    solarData.hourly.generation = generationCurve;
    solarData.hourly.consumption = energyData.hourlyData.total; // 直接使用 energyData 計算好的總量曲線
}

// 啟動太陽能數據模擬
setInterval(updateSolarData, 5000);

// ★★★每日太陽能報告的數據生成邏輯 ★★★
function generateDailySolarReport(dateStr) {
    // 根據日期生成一個隨機種子，讓同一天的數據保持一致
    const seed = dateStr.split('-').reduce((acc, val) => acc + parseInt(val), 0);
    const random = (min, max) => {
        const x = Math.sin(seed * 1.23) * 10000;
        return parseFloat((min + (x - Math.floor(x)) * (max - min)).toFixed(2));
    };

    // 1. 模擬基礎數據
    const totalGeneration = random(20, 150); // 每日總發電量 (kWh)
    const totalConsumption = random(180, 350); // 每日總用電量 (kWh)

    // 2. 模擬能源調度
    let netPower = totalGeneration - totalConsumption;
    let batteryCharged = 0, batteryDischarged = 0, gridImport = 0, gridExport = 0;
    
    const maxBatteryThroughput = random(10, 30); // 模擬電池單日可充放電量

    if (netPower > 0) { // 發電 > 用電 (有剩餘)
        batteryCharged = Math.min(netPower, maxBatteryThroughput);
        gridExport = netPower - batteryCharged;
    } else { // 用電 > 發電 (不足)
        const deficit = Math.abs(netPower);
        batteryDischarged = Math.min(deficit, maxBatteryThroughput);
        gridImport = deficit - batteryDischarged;
    }

    // 3. 計算進階指標
    const selfConsumption = totalGeneration - gridExport;
    const selfConsumptionRate = totalGeneration > 0 ? parseFloat((selfConsumption / totalGeneration * 100).toFixed(2)) : 0;
    const carbonReduction = parseFloat((totalGeneration * CARBON_EMISSION_FACTOR).toFixed(2));

    // 4. 回傳符合 Excel 欄位的物件
    return {
        "日期": dateStr,
        "總發電量(kWh)": totalGeneration,
        "總用電量(kWh)": totalConsumption,
        "電池充電量(kWh)": batteryCharged,
        "電池放電量(kWh)": batteryDischarged,
        "市電買入量(kWh)": gridImport,
        "賣給市電量(kWh)": gridExport,
        "綠電自用率(%)": selfConsumptionRate,
        "減碳量(kg)": carbonReduction
    };
}

// ★★★ 初始化CCTV 攝影機數據 (包含串流位址) ★★★
const defaultcctvData = {
    "1f": [
        { 
            id: "CCTV-1F-01", 
            name: "1F-C01-A",    // 3D模型中的物件名稱
            locationName: "一樓攝影機01",  // 顯示在UI上的名稱
            status: "online",
            // ★預留給真實影像串流的位址 (例如 RTSP, HTTP Stream, WebRTC 等)
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "1f"
        },
        { 
            id: "CCTV-1F-02", 
            name: "1F-C02-A", 
            locationName: "一樓攝影機02", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "1f"
        },
        { 
            id: "CCTV-1F-03", 
            name: "1F-C03-A", 
            locationName: "一樓攝影機03", 
            status: "online", // 模擬一台離線的攝影機
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "1f"
        },
        { 
            id: "CCTV-1F-04", 
            name: "1F-C04-A", 
            locationName: "一樓攝影機04", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "1f"
        },
        { 
            id: "CCTV-1F-05", 
            name: "1F-C05-A", 
            locationName: "一樓攝影機05", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "1f"
        },
        { 
            id: "CCTV-1F-06", 
            name: "1F-C06-A", 
            locationName: "一樓攝影機06", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "1f"
        }
    ],
    "2f": [
        { 
            id: "CCTV-2F-01", 
            name: "02CCTV_1",    // 3D模型中的物件名稱
            locationName: "二樓攝影機01",  // 顯示在UI上的名稱
            status: "online",
            // ★預留給真實影像串流的位址 (例如 RTSP, HTTP Stream, WebRTC 等)
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "2f"
        },
        { 
            id: "CCTV-2F-02", 
            name: "02CCTV001_2", 
            locationName: "二樓攝影機02", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "2f"
        },
        { 
            id: "CCTV-2F-03", 
            name: "02CCTV002_1", 
            locationName: "二樓攝影機03", 
            status: "online", // 模擬一台離線的攝影機
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "2f"
        },
        { 
            id: "CCTV-2F-04", 
            name: "02CCTV003_1", 
            locationName: "二樓攝影機04", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "2f"
        },
        { 
            id: "CCTV-2F-05", 
            name: "02CCTV004_1", 
            locationName: "二樓攝影機05", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "2f"
        },
        { 
            id: "CCTV-2F-06", 
            name: "CCTV005_1", 
            locationName: "二樓攝影機06", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "2f"
        }
    ],
    "3f": [
        { 
            id: "CCTV-3F-01", 
            name: "03CCTV_1",    // 3D模型中的物件名稱
            locationName: "三樓攝影機01",  // 顯示在UI上的名稱
            status: "online",
            // ★預留給真實影像串流的位址 (例如 RTSP, HTTP Stream, WebRTC 等)
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "3f"
        },
        { 
            id: "CCTV-3F-02", 
            name: "03CCTV001_2", 
            locationName: "三樓攝影機02", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "3f"
        },
        { 
            id: "CCTV-3F-03", 
            name: "03CCTV002_1", 
            locationName: "三樓攝影機03", 
            status: "online", // 模擬一台離線的攝影機
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "3f"
        },
        { 
            id: "CCTV-3F-04", 
            name: "03CCTV003_1", 
            locationName: "三樓攝影機04", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "3f"
        },
        { 
            id: "CCTV-3F-05", 
            name: "03CCTV004_1", 
            locationName: "三樓攝影機05", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "3f"
        },
        { 
            id: "CCTV-3F-06", 
            name: "03CCTV005_1", 
            locationName: "三樓攝影機06", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "3f"
        }
    ],
    "4f": [
        { 
            id: "CCTV-4F-01", 
            name: "CCTV401_1",    // 3D模型中的物件名稱
            locationName: "四樓攝影機01",  // 顯示在UI上的名稱
            status: "online",
            // ★預留給真實影像串流的位址 (例如 RTSP, HTTP Stream, WebRTC 等)
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "4f"
        },
        { 
            id: "CCTV-4F-02", 
            name: "CCTV402_1", 
            locationName: "四樓攝影機02", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "4f"
        },
        { 
            id: "CCTV-4F-03", 
            name: "CCTV403_1", 
            locationName: "四樓攝影機03", 
            status: "online", // 模擬一台離線的攝影機
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "4f"
        },
        { 
            id: "CCTV-4F-04", 
            name: "CCTV404_1", 
            locationName: "四樓攝影機04", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "4f"
        },
        { 
            id: "CCTV-4F-05", 
            name: "CCTV405_1", 
            locationName: "四樓攝影機05", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "4f"
        },
        { 
            id: "CCTV-4F-06", 
            name: "CCTV406_1", 
            locationName: "四樓攝影機06", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "4f"
        }
    ],
    "5f": [
        { 
            id: "CCTV-5F-01", 
            name: "CCTV_1",    // 3D模型中的物件名稱
            locationName: "五樓攝影機01",  // 顯示在UI上的名稱
            status: "online",
            // ★預留給真實影像串流的位址 (例如 RTSP, HTTP Stream, WebRTC 等)
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "5f"
        },
        { 
            id: "CCTV-5F-02", 
            name: "CCTV001_2", 
            locationName: "五樓攝影機02", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "5f"
        },
        { 
            id: "CCTV-5F-03", 
            name: "CCTV002_1", 
            locationName: "五樓攝影機03", 
            status: "online", // 模擬一台離線的攝影機
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "5f"
        },
        { 
            id: "CCTV-5F-04", 
            name: "CCTV003_1", 
            locationName: "五樓攝影機04", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "5f"
        },
        { 
            id: "CCTV-5F-05", 
            name: "CCTV004_1", 
            locationName: "五樓攝影機05", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "5f"
        },
        { 
            id: "CCTV-5F-06", 
            name: "CCTV005_1", 
            locationName: "五樓攝影機06", 
            status: "online",
            // ★預留串流位址
            streamUrl: "rtsp://admin:admin@10.230.16.74:8554/live",
            floor: "5f"
        }
    ]
};

// ★ 從 JSON 檔案載入攝影機設定
function loadCctvData() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            // 情況 A：檔案存在，直接讀取檔案內容
            const rawData = fs.readFileSync(CONFIG_PATH);
            cctvData = JSON.parse(rawData);
            console.log('[Config] 成功從 cctv_config.json 載入攝影機設定。');
        } else {
            // 情況 B：檔案不存在，使用程式碼中的 defaultcctvData 作為初始值
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultcctvData, null, 4));
            cctvData = defaultcctvData; // 同步更新記憶體中的變數
            console.log('[Config] cctv_config.json 不存在，已使用預設資料建立並載入。');
        }
    } catch (error) {
        console.error('[Config] 載入 cctv_config.json 失敗:', error);        
        cctvData = defaultcctvData; 
    }
}

// ★ 儲存攝影機設定到 JSON 檔案
async function saveCctvData() {
    try {
        await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(cctvData, null, 4));
        //console.log('[Config] 攝影機設定已成功儲存至 cctv_config.json。');
    } catch (error) {
        console.error('[Config] 儲存 cctv_config.json 失敗:', error);
    }
}

function startHlsStream(camera) {
    //if (!camera || !camera.streamUrl || (camera.status !== 'online' && camera.status !== 'calling')) return;
    if (!camera || !camera.streamUrl) return;
    if (ffmpegProcesses.has(camera.id)) return;

    const outputDir = path.join(HLS_DIR, String(camera.id));
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    
    const hlsPath = path.join(outputDir, 'stream.m3u8');
    camera.hlsUrl = `${BACKEND_URL}/hls_streams/${camera.id}/stream.m3u8`;

    const displayName = camera.household || camera.locationName || camera.name;
    //console.log(`[HLS] 正在為 ${displayName} 啟動串流轉碼...`);

    const command = ffmpeg(camera.streamUrl)
        .setFfmpegPath(ffmpegBin)
        .inputOptions([
            '-rtsp_transport', 'tcp', 
            '-timeout', '5000000' 
        ])
        .outputOptions([
            '-c:v copy', 
            '-f hls', 
            '-hls_time 4', 
            '-hls_list_size 3', 
            '-hls_flags delete_segments'
        ])
        .output(hlsPath)
        .on('start', async (commandLine) => {
             //console.log(`[HLS] FFmpeg 開始執行: ${displayName}`);
             if (camera.status !== 'online') {
                 camera.status = 'online';
                 await saveCctvData(); // 寫入 cctv_config.json
                 //console.log(`[Status] ${displayName} 串流啟動成功，狀態已更新為 Online。`);
             }
        })
        .on('error', async (err, stdout, stderr) => { // ★ 改為 async 以便儲存設定
            if (err.message.includes('SIGKILL')) return;
            //console.error(`[HLS Error] ${displayName} 串流中斷:`, err.message);
            
            // ★★★ 核心修改：偵測到錯誤，將狀態改為 offline 並寫入設定檔 ★★★
            if (camera.status !== 'offline') {
                camera.status = 'offline';
                //console.log(`[Status] 更新 ${displayName} 狀態為 offline 並存檔。`);
                await saveCctvData(); // 這會更新 cctv_config.json
            }

            ffmpegProcesses.delete(camera.id);
        })
        .on('end', () => {
            console.log(`[HLS] ${displayName} 串流結束。`);
            ffmpegProcesses.delete(camera.id);
        });

    command.run();
    ffmpegProcesses.set(camera.id, command);
}

// 初始啟動所有
function startAllHlsStreams() {
  Object.keys(cctvData).forEach(floor => {
    cctvData[floor].forEach(camera => startHlsStream(camera));
  });
}

// 定期檢查並重啟缺失的進程（每30秒）
setInterval(async () => {
  console.log('[HLS Monitor] 執行定期狀態檢查...');
  let configChanged = false;

  for (const floor of Object.keys(cctvData)) {
    for (const camera of cctvData[floor]) {
      
      // 情況 A: 狀態顯示 online，但 FFmpeg 沒在跑 -> 重啟
      if (camera.status === 'online' && !ffmpegProcesses.has(camera.id)) {
        console.log(`[Monitor] ${camera.locationName} (Online) 未執行，嘗試重啟...`);
        startHlsStream(camera);
      }
      
      // 情況 B: 狀態顯示 offline ，嘗試自動修復 -> 改回 online 並重啟
      else if (camera.status === 'offline') {
        //console.log(`[Monitor] 嘗試重連離線攝影機: ${camera.locationName}`);
        
        // 先假設它修好了，改回 online
        camera.status = 'online';
        configChanged = true;
        
        // 嘗試啟動 (如果還是壞的，FFmpeg 幾秒後會報錯，再次把它改回 offline)
        startHlsStream(camera);
      }
    }
  }

  // 如果有把 offline 改回 online，統一存檔一次
  if (configChanged) {
      await saveCctvData();
      console.log('[Monitor] 已更新設定檔狀態。');
  }

}, 30000);

// 伺服器關閉時停止所有 FFmpeg
process.on('SIGINT', () => {
  ffmpegProcesses.forEach(proc => proc.kill('SIGINT'));
  process.exit();
});


// ★★★ 模擬攝影機狀態隨機變化 ★★★
/*setInterval(() => {
    Object.keys(cctvData).forEach(floor => {
        cctvData[floor].forEach(camera => {
            // 用一個較小的機率 (例如 5%) 來模擬狀態的隨機切換
            if (Math.random() < 0.05) {
                camera.status = (camera.status === "online") ? "offline" : "online";
                console.log(`CCTV 狀態變更: ${floor} - ${camera.locationName} 的狀態為 ${camera.status}`);
            }
        });
    });
}, 5000);*/ // 每 5 秒鐘檢查一次

// ★啟動所有 RTSP 串流轉碼的函式
/*function startRtspStreams() {
    const SERVER_IP = "172.20.10.5";
    let streamPort = 9990;

    // ★ 偵錯：檢查傳入的 cctvData 是否為有效物件
    if (typeof cctvData !== 'object' || cctvData === null || Object.keys(cctvData).length === 0) {
        console.error("[Debug] Error: cctvData is empty or not an object when startRtspStreams is called.");
        return; // 如果 cctvData 是空的，就直接結束函式
    }
    console.log("[Debug] cctvData has content. Number of floors:", Object.keys(cctvData).length);

    Object.keys(cctvData).forEach(floor => {
        console.log(`[Debug] Processing floor: ${floor}`);
        
        const camerasOnFloor = cctvData[floor];
        if (!Array.isArray(camerasOnFloor)) {
            console.warn(`[Debug] Warning: cctvData for floor '${floor}' is not an array.`);
            return; // 跳過這個無效的樓層
        }

        camerasOnFloor.forEach(camera => {
            console.log(`[Debug] Checking camera: ${camera.locationName}`);
            
            // ★ 偵錯：檢查每一台攝影機的啟動條件
            if (camera.streamUrl && camera.status === 'online') {
                console.log(`[Debug] SUCCESS: Camera '${camera.locationName}' meets the criteria. Starting stream...`);
                
                if (camera.streamInstance) {
                    console.log(`[Debug] Stream for ${camera.locationName} already exists. Skipping.`);
                    return;
                }

                const stream = new Stream({
                    name: camera.id,
                    streamUrl: camera.streamUrl,
                    wsPort: streamPort,
                    ffmpegPath: require('ffmpeg-static'),
                    ffmpegOptions: { '-stats': '', '-r': 30 }
                });
                
                camera.streamInstance = stream;
                camera.websocketUrl = `ws://${SERVER_IP}:${streamPort}`;
                console.log(`[Debug] OK: Websocket URL created for ${camera.locationName}: ${camera.websocketUrl}`);

                streamPort++;
            } else {
                // ★ 偵錯：如果條件不滿足，印出原因
                console.log(`[Debug] SKIPPED: Camera '${camera.locationName}' was skipped. Reason: streamUrl=${!!camera.streamUrl}, status=${camera.status}`);
            }
        });
    });
    console.log("--- [Debug] startRtspStreams function finished ---");
}*/


// ★★★ 從 JSON 檔案載入使用者資料的函式 ★★★
function loadUsersData() {
    try {
        if (fs.existsSync(USERS_CONFIG_PATH)) {
            const rawData = fs.readFileSync(USERS_CONFIG_PATH);
            usersData = JSON.parse(rawData);
            console.log('[Config] 成功從 users_config.json 載入使用者資料。');
        } else {
            // 如果檔案不存在，建立一個包含預設管理員的初始檔案
            const saltRounds = 10;
            const hashedPassword = bcrypt.hashSync('admin123', saltRounds); // 為預設密碼 'admin123' 加密
            const defaultAdmin = {
                "1": { // 使用 ID 作為 key
                    id: 1,
                    username: 'admin',
                    password: hashedPassword,
                    displayName: '系統管理員',
                    role: 'admin',
                    permissions: ['manage_users', 'elevator_control', 'view_history', 'change_settings']
                }
            };
            fs.writeFileSync(USERS_CONFIG_PATH, JSON.stringify(defaultAdmin, null, 4));
            usersData = defaultAdmin;
            console.log('[Config] users_config.json 不存在，已建立並載入預設管理員帳號。');
        }
    } catch (error) {
        console.error('[Config] 載入 users_config.json 失敗:', error);
        usersData = {}; // 發生錯誤時，使用空物件以避免程式崩潰
    }
}

// ★★★ 儲存使用者資料到 JSON 檔案的函式 ★★★
async function saveUsersData() {
    try {
        await fs.promises.writeFile(USERS_CONFIG_PATH, JSON.stringify(usersData, null, 4));
        console.log('[Config] 使用者資料已成功儲存至 users_config.json。');
    } catch (error) {
        console.error('[Config] 儲存 users_config.json 失敗:', error);
    }
}

// ★★★ 從 JSON 檔案載入登入日誌的函式 ★★★
function loadLoginLogs() {
    try {
        if (fs.existsSync(LOGS_PATH)) {
            const rawData = fs.readFileSync(LOGS_PATH);
            loginLogs = JSON.parse(rawData);
            console.log('[Config] 成功從 login_logs.json 載入登入日誌。');
        } else {
            // 如果檔案不存在，建立一個空的陣列檔案
            fs.writeFileSync(LOGS_PATH, JSON.stringify([], null, 4));
            loginLogs = [];
            console.log('[Config] login_logs.json 不存在，已建立空檔案。');
        }
    } catch (error) {
        console.error('[Config] 載入 login_logs.json 失敗:', error);
        loginLogs = [];
    }
}

// ★★★ 儲存登入日誌到 JSON 檔案的函式 ★★★
async function saveLoginLogs() {
    try {
        await fs.promises.writeFile(LOGS_PATH, JSON.stringify(loginLogs, null, 4));
    } catch (error) {
        console.error('[Config] 儲存 login_logs.json 失敗:', error);
    }
}

// ★★★ 載入/儲存通用設定的函式 ★★★
function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_CONFIG_PATH)) {
            const rawData = fs.readFileSync(SETTINGS_CONFIG_PATH);
            appSettings = JSON.parse(rawData);
            
            // 如果設定檔是舊格式 (有 lineUserId 但沒有 lineUserIds)，則自動轉換
            if (appSettings.lineUserId && !appSettings.lineUserIds) {
                console.log('[Config] 偵測到舊版設定檔，正在轉換為新格式...');
                appSettings.lineUserIds = [appSettings.lineUserId]; // 將舊 ID 放入新陣列
                delete appSettings.lineUserId; // 刪除舊的 key
                saveSettings(); // 將轉換後的新格式存檔
            }            

            if (appSettings.isCloudSyncEnabled === undefined) {
                appSettings.isCloudSyncEnabled = false;
            }

            console.log('[Config] 成功從 settings_config.json 載入設定。');
        } else {
            // 使用新的 lineUserIds 陣列作為預設值
            const defaultSettings = {
                isNetworkEnabled: false,
                lineAccessToken: '',
                lineChannelSecret: '',
                lineUserIds: [],
                isCloudSyncEnabled: false
            };
            fs.writeFileSync(SETTINGS_CONFIG_PATH, JSON.stringify(defaultSettings, null, 4));
            appSettings = defaultSettings;
            console.log('[Config] settings_config.json 不存在，已建立預設檔案。');
        }
    } catch (error) {
        console.error('[Config] 載入 settings_config.json 失敗:', error);
        // 錯誤時的預設值也更新
        appSettings = { 
            isNetworkEnabled: false, 
            lineAccessToken: '', 
            lineChannelSecret: '', 
            lineUserIds: [], 
            isCloudSyncEnabled: false 
        };
    }
}

async function saveSettings() {
    try {
        await fs.promises.writeFile(SETTINGS_CONFIG_PATH, JSON.stringify(appSettings, null, 4));
        console.log('[Config] 設定已成功儲存至 settings_config.json。');
    } catch (error) {
        console.error('[Config] 儲存 settings_config.json 失敗:', error);
    }
}

// ★★★ 發送 LINE Push Message 的函式 ★★★
async function sendLinePushMessage(message) {    
    if (!appSettings.isNetworkEnabled || !appSettings.lineAccessToken || !appSettings.lineUserIds || appSettings.lineUserIds.length === 0) {
        console.log('[LINE] 網路功能未啟用或設定不完整，略過發送。');
        return;
    }

    try {
        // 將陣列轉換為字串以便在日誌中顯示
        console.log(`[LINE] 準備發送訊息給 ${appSettings.lineUserIds.join(', ')}`);
        await axios.post(
            'https://api.line.me/v2/bot/message/multicast',
            {                
                to: appSettings.lineUserIds, 
                messages: [{ type: 'text', text: message }]
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${appSettings.lineAccessToken}`
                }
            }
        );
        console.log('[LINE] 訊息發送成功！');
    } catch (error) {
        console.error('[LINE] 呼叫 API 時發生錯誤:', error.response ? error.response.data.message : error.message);
    }
}

// ★★★ 獨立警報監聽與通知函式 ★★★
function checkAlarmsAndNotify() {
    // 1. 如果網路功能未啟用，則直接返回
    if (!appSettings.isNetworkEnabled) {
        return;
    }

    // 2. 遍歷所有電梯
    elevatorsData.forEach(elevator => {
        const elevatorId = elevator.id;

        // 3. 檢查目前是否有緊急呼叫
        if (elevator.emergencyCall) {
            // 4. 如果有呼叫，且我們「尚未」為此電梯發送過通知
            if (!notificationState[elevatorId]) {
                // 發送通知！
                console.log(`[監聽器] 偵測到電梯 ${elevator.name} 的新緊急呼叫，準備發送通知...`);
                sendLinePushMessage(`緊急通知：${elevator.name} 發生緊急呼叫！`);

                // ★ 將此電梯的通知狀態標記為「已發送」，防止重複發送
                notificationState[elevatorId] = true;
            }
        } else {
            // 5. 如果目前「沒有」緊急呼叫，且我們先前「有」標記過它
            if (notificationState[elevatorId]) {
                // 事件已被前端解除，我們需要重置旗標，以便下次可以再次通知
                console.log(`[監聽器] 偵測到電梯 ${elevator.name} 的緊急呼叫已解除，重置通知狀態。`);
                notificationState[elevatorId] = false;
            }
        }
    });

    // 預留功能：遍歷所有監控點（例如緊急求救點）
    /*monitoringPoints.forEach(point => {
        if (point.text === "緊急求救" && point.status === "開啟") {
            const pointId = `point-${point.id}`; 
            if (!notificationState[pointId]) {
                const message = `緊急通知：位於 ${point.floor} 的 ${point.household || point.name} 發生緊急求救！`;
                console.log(`[監聽器] 偵測到新的緊急求救點 ${point.name}，準備發送通知...`);
                sendLinePushMessage(message);
                notificationState[pointId] = true;
            }
        } else {
            const pointId = `point-${point.id}`;
            if (notificationState[pointId]) {
                notificationState[pointId] = false;
            }
        }
    });*/
}

// ★★★ 每隔一段時間就執行一次監聽檢查 ★★★
setInterval(checkAlarmsAndNotify, 3000);

// ★★★ 載入/儲存「社區報修」資料的函式 ★★★
function loadRepairsData() {
    try {
        if (fs.existsSync(REPAIRS_CONFIG_PATH)) {
            const rawData = fs.readFileSync(REPAIRS_CONFIG_PATH);
            repairsData = JSON.parse(rawData);
            console.log('[Config] 成功從本地 repairs_config.json 載入報修資料。');
        } else {
            fs.writeFileSync(REPAIRS_CONFIG_PATH, JSON.stringify([], null, 4));
            repairsData = [];
            console.log('[Config] 本地 repairs_config.json 不存在，已建立空檔案。');
        }
    } catch (error) {
        console.error('[Config] 載入本地 repairs_config.json 失敗:', error);
        repairsData = [];
    }
}

async function saveRepairsData() {
    try {
        await fs.promises.writeFile(REPAIRS_CONFIG_PATH, JSON.stringify(repairsData, null, 4));
        console.log('[Config] 報修資料已成功儲存至本地 repairs_config.json。');
    } catch (error) {
        console.error('[Config] 儲存本地 repairs_config.json 失敗:', error);
    }
}

// ★★★ 從雲端同步報修資料的核心函式 ★★★
async function syncRepairsFromCloud() {
    if (!appSettings.isCloudSyncEnabled) {
        console.log('[Sync] 線上報修同步功能已關閉，略過本次同步。');
        return; // 直接結束函式
    }
    try {
        console.log('[Sync] 開始從雲端同步報修資料...');
        // 1. 從雲端伺服器獲取所有報修案件
        const response = await axios.get(`${CLOUD_SERVER_URL}/api/repairs`);
        const cloudRepairs = response.data;

        if (!cloudRepairs || cloudRepairs.length === 0) {
            console.log('[Sync] 雲端沒有新的報修案件。');
            return;
        }

        let newRepairsCount = 0;
        // 2. 遍歷從雲端抓回來的每一筆資料
        for (const repair of cloudRepairs) {
            // 檢查本地是否已存在該筆資料，避免重複加入
            if (!repairsData.some(localRepair => localRepair.id === repair.id)) {
                repairsData.push(repair); // 將新案件加入到本地的資料陣列中
                newRepairsCount++;

                // 3. 通知雲端伺服器可以刪除這筆已經同步的資料
                await axios.delete(`${CLOUD_SERVER_URL}/api/repairs/${repair.id}`);
                console.log(`[Sync] 已同步並從雲端刪除案件: ${repair.id}`);
            }
        }

        // 4. 如果有新增案件，就將變動儲存到本地檔案
        if (newRepairsCount > 0) {
            await saveRepairsData();
            console.log(`[Sync] 同步完成，共新增 ${newRepairsCount} 筆報修案件。`);
        } else {
            console.log('[Sync] 同步完成，沒有需要更新的案件。');
        }

    } catch (error) {
        console.error('[Sync] 從雲端同步資料時發生錯誤:', error.message);
    }
}


loadCctvData();
loadUsersData(); 
loadLoginLogs();
loadSettings();
loadRepairsData();
intercomDriver.start();
barrierDriver.start(broadcast);
theftpreventionDriver.start(broadcast);
plumbingDriver.start(broadcast);

// --- 建立 API 端點 ---
localApp.get('/api/status', (req, res) => {
    const data = theftpreventionDriver.getAllData();
    res.json(data);
});

localApp.get('/api/energy', (req, res) => {
    res.json(energyData);
});

// ★★★ 給歷史紀錄用的 API 端點 ★★★
localApp.get('/api/historical-power', (req, res) => {
    const { date } = req.query; // 從前端請求的 URL 中獲取 date 參數
    if (!date) {
        return res.status(400).json({ error: '缺少日期參數' });
    }
    const dailySolarReport = generateDailySolarReport(date);
    res.json(dailySolarReport);
});

// ★★★ 專門給「月份匯出」用的 API 端點 ★★★
localApp.get('/api/monthly-power-report', (req, res) => {
    const { year, month } = req.query;
    if (!year || !month) {
        return res.status(400).json({ error: '缺少年份或月份參數' });
    }

    const daysInMonth = new Date(year, month, 0).getDate();
    const reportData = [];

    for (let day = 1; day <= daysInMonth; day++) {
        // 格式化日期字串為 YYYY-MM-DD
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        reportData.push(generateHistoricalData(dateStr));
    }
    
    res.json(reportData);
});

// ★★★ 火警系統 API 端點 ★★★
localApp.get('/api/fire-alarm/:floor', (req, res) => {
    const { floor } = req.params; // 從 URL 路徑中獲取樓層，例如 "1f"
    const data = fireAlarmData[floor] || []; // 如果找不到該樓層數據，就回傳空陣列
    res.json(data);
});

// ★★★ 給排水系統 API ★★★
localApp.get('/api/plumbing/:floor', (req, res) => {
    const { floor } = req.params;
    const data = plumbingDriver.getDataByFloor(floor);
    res.json(data || []);
});

// ★★★ 修改泵浦設定的 API ★★★
localApp.post('/api/plumbing/config', async (req, res) => {
    try {
        const { floor, ...settings } = req.body; 
        
        await plumbingDriver.updateConfig(floor, settings);
        res.json({ success: true, message: "設定已更新" });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ★★★ 泵浦控制 API  ★★★
localApp.post('/api/plumbing/control', async (req, res) => {
    const { targetId, action } = req.body; // 前端傳來 { targetId: "...", action: "ON"/"OFF" }

    if (!targetId || !action) {
        return res.status(400).json({ success: false, message: "缺少參數" });
    }

    try {
        // 呼叫 Driver 執行寫入
        await plumbingDriver.controlPump(targetId, action);
        res.json({ success: true, message: "指令已發送" });
    } catch (e) {
        console.error("控制失敗:", e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// ★★★ 「停車管理系統」用的 API 端點 ★★★
localApp.get('/api/parking/:floor', (req, res) => {
    const { floor } = req.params;
    const data = parkingData[floor] || [];
    res.json(data);
});

// ★★★「車道號誌」用的 API 端點 ★★★
localApp.get('/api/traffic-light/:floor', (req, res) => {
    const { floor } = req.params;
    const data = trafficLightData[floor] || {};
    res.json(data);
});

// ★★★ 「電梯監控系統」用的 API 端點 ★★★
localApp.get('/api/elevators', (req, res) => {
    // 處理電梯數據，確保 carCalls 陣列格式正確
    const processedElevators = elevatorsData.map(elevator => ({
        ...elevator,
        // 確保 carCalls 是陣列格式，方便前端處理
        carCalls: elevator.carCalls || [],
        // 提供額外的車廂叫車資訊
        carCallsCount: elevator.carCalls ? elevator.carCalls.length : 0,
        // 按樓層順序排序叫車樓層（從高到低）
        sortedCarCalls: elevator.carCalls ? 
            [...elevator.carCalls].sort((a, b) => {
                const floorOrder = ['5F', '4F', '3F', '2F', '1F', 'B1F', 'B2F', 'B3F'];
                return floorOrder.indexOf(a) - floorOrder.indexOf(b);
            }) : [],
        // 提供下一個目標樓層資訊
        nextTarget: elevator.carCalls && elevator.carCalls.length > 0 ? elevator.carCalls[0] : null
    }));
    
    res.json(processedElevators);
});

// ★★★ 「電梯紀錄匯出」用的 API 端點 ★★★
localApp.get('/api/elevators/report', (req, res) => {
    try {
        const { year, month, elevatorId } = req.query;
        
        // 參數驗證
        if (!year || !month || !elevatorId) {
            return res.status(400).json({ 
                error: '缺少必要參數',
                required: ['year', 'month', 'elevatorId']
            });
        }

        // 數值驗證
        const yearNum = parseInt(year);
        const monthNum = parseInt(month);
        const elevatorIdNum = parseInt(elevatorId);

        if (isNaN(yearNum) || isNaN(monthNum) || isNaN(elevatorIdNum)) {
            return res.status(400).json({ 
                error: '參數格式錯誤，必須為數字' 
            });
        }

        if (monthNum < 1 || monthNum > 12) {
            return res.status(400).json({ 
                error: '月份必須在 1-12 之間' 
            });
        }

        if (elevatorIdNum < 1 || elevatorIdNum > 5) {
            return res.status(400).json({ 
                error: '電梯ID必須在 1-5 之間' 
            });
        }

        // 產生報告數據
        const reportData = generateElevatorMonthlyReport(yearNum, monthNum, elevatorIdNum);
        
        console.log(`電梯報告生成成功: ${year}-${month}, 電梯ID: ${elevatorId}`);
        res.json(reportData);

    } catch (error) {
        console.error('電梯報告生成錯誤:', error);
        res.status(500).json({ 
            error: '服務器內部錯誤',
            message: error.message 
        });
    }
});

// ★★★ 「解除緊急呼叫」的 POST API 端點 ★★★
localApp.post('/api/elevators/:id/resolve-emergency', (req, res) => {
    const elevatorId = parseInt(req.params.id);
    const elevator = elevatorsData.find(e => e.id === elevatorId);

    if (elevator) {
        elevator.emergencyCall = false; // 手動解除
        console.log(`電梯 #${elevatorId} 的緊急呼叫已由 API 解除。`);
        res.status(200).json({ message: `Elevator ${elevatorId} emergency resolved.` });
    } else {
        res.status(404).json({ error: `Elevator with id ${elevatorId} not found.` });
    }
});

// ★★★ 切換「手動/自動」模式的 POST API ★★★
localApp.post('/api/elevators/:id/toggle-manual', (req, res) => {
    const elevatorId = parseInt(req.params.id);
    const elevator = elevatorsData.find(e => e.id === elevatorId);
    if (elevator) {
        elevator.manualMode = !elevator.manualMode;
        // 進入自動模式時，重設狀態
        if (!elevator.manualMode) {
            elevator.direction = 'idle';
            elevator.runStatus = '自動運轉';
        } else {
            elevator.runStatus = '手動運轉';
        }
        console.log(`電梯 #${elevatorId} 的手動模式已切換為: ${elevator.manualMode}`);
        res.status(200).json(elevator);
    } else {
        res.status(404).json({ error: `Elevator with id ${elevatorId} not found.` });
    }
});

// ★★★ 接收「手動控制指令」的 POST API ★★★
localApp.post('/api/elevators/:id/manual-command', (req, res) => {
    const elevatorId = parseInt(req.params.id);
    const { command } = req.body;
    const elevator = elevatorsData.find(e => e.id === elevatorId);

    if (!elevator) {
        return res.status(404).json({ error: `Elevator with id ${elevatorId} not found.` });
    }

    if (!elevator.manualMode) {
        return res.status(400).json({ error: `Elevator ${elevatorId} is not in manual mode.` });
    }

    const currentFloorIndex = elevator.serviceFloors.indexOf(elevator.currentFloor);
    
    switch (command) {
        case 'up':
            if (currentFloorIndex > 0) {
                elevator.currentFloor = elevator.serviceFloors[currentFloorIndex - 1];
                elevator.direction = 'up';
            } else {
                return res.status(400).json({ error: 'Cannot go up from top floor.' });
            }
            break;
        case 'down':
            if (currentFloorIndex < elevator.serviceFloors.length - 1) {
                elevator.currentFloor = elevator.serviceFloors[currentFloorIndex + 1];
                elevator.direction = 'down';
            } else {
                return res.status(400).json({ error: 'Cannot go down from bottom floor.' });
            }
            break;
        case 'stop':
            elevator.direction = 'idle';
            break;
        case 'open':
            elevator.doorStatus = 'open';
            break;
        case 'close':
            elevator.doorStatus = 'closed';
            break;
        default:
            return res.status(400).json({ error: `Unknown command: ${command}` });
    }
    
    console.log(`收到電梯 #${elevatorId} 的手動指令: ${command}, 當前樓層: ${elevator.currentFloor}`);
    res.status(200).json(elevator);
});
// ★★★ 空調控制系統 API 端點 ★★★
localApp.get('/api/ac/:floor', (req, res) => {
    const { floor } = req.params;
    const data = acData[floor] || [];
    res.json(data);
});
// ★★★ 接收「模式切換指令」的 POST API ★★★
localApp.post('/api/ac/:floor/:id/mode', (req, res) => {
    const { floor, id } = req.params;
    const { mode } = req.body;
    
    if (!acData[floor]) {
        return res.status(404).json({ error: `Floor ${floor} not found.` });
    }

    const unit = acData[floor].find(u => u.id === id);

    if (unit) {
        // 驗證傳入的模式是否有效
        const validModes = ["送風", "冷氣", "暖氣", "除濕"];
        if (validModes.includes(mode)) {
            unit.mode = mode;
            console.log(`空調模式已手動切換: ${floor} - ${unit.locationName} 的模式為 ${unit.mode}`);
            res.status(200).json(unit);
        } else {
            res.status(400).json({ error: `Invalid mode: ${mode}` });
        }
    } else {
        res.status(404).json({ error: `AC unit with id ${id} not found on floor ${floor}.` });
    }
});
// ★★★ 空調開關機 API (寫入到 Modbus) ★★★
localApp.post('/api/ac/:floor/:id/status', async (req, res) => {
    const { floor, id } = req.params;
    const { status } = req.body;
    
    const unit = acData[floor]?.find(u => u.id === id);
    if (!unit) {
        return res.status(404).json({ error: `AC unit not found.` });
    }

    const valueToWrite = (status === "運轉中") ? 256 : 0;

    console.log(`--------------------------------------------------`);
    console.log(`[API] 收到前端請求: ${unit.locationName} -> ${status}`);

    try {
        const isConnected = await ensureModbusConnection();
        if (!isConnected) {
            throw new Error("無法連接到 Modbus 設備。");
        }

        console.log(`[API -> Modbus] 正在發送寫入指令... (位址: ${unit.modbusAddress}, 值: ${valueToWrite})`);        
        client.setID(modbusSlaveId);
        await client.writeRegisters(unit.modbusAddress, [valueToWrite]);
        console.log(`[API -> Modbus] 指令已成功發送！`);
        
        unit.status = status;
        res.status(200).json(unit);

    } catch (err) {
        console.error("[API -> Modbus] 寫入 Modbus 失敗:", err.message);
        res.status(500).json({ error: "寫入 Modbus 設備失敗", details: err.message });
    } finally {
        console.log(`--------------------------------------------------`);
    }
});
// ★★★ 用來接收「溫度調整指令」的 POST API ★★★
localApp.post('/api/ac/:floor/:id/temperature', async (req, res) => {
    const { floor, id } = req.params;
    const { temperature } = req.body;
    
    const unit = acData[floor]?.find(u => u.id === id);
    if (!unit) {
        return res.status(404).json({ error: `AC unit not found.` });
    }

    try {
        const isConnected = await ensureModbusConnection();
        if (!isConnected) {
            throw new Error("無法連接到 Modbus 設備。");
        }

        // ★ 修正：根據CSV配置計算正確的溫度寫入地址
        const tempWriteAddress = 22 + (unit.modbusAddress * 2);
        const valueToWrite = Math.round(temperature * 10); // 乘以 10 轉換為整數
        
        console.log(`[溫度調整] ${unit.locationName} -> ${temperature}°C (地址: ${tempWriteAddress}, 值: ${valueToWrite})`);
        
        client.setID(modbusSlaveId);
        await client.writeRegister(tempWriteAddress, valueToWrite);
        console.log(`[溫度調整] ✓ 溫度設定指令已成功發送到設備！(地址: ${tempWriteAddress}, 值: ${valueToWrite})`);
        
        unit.setTemperature = temperature;
        res.status(200).json(unit);

    } catch (err) {
        console.error("[API -> Modbus] 寫入溫度失敗:", err.message);
        res.status(500).json({ error: "寫入 Modbus 設備失敗", details: err.message });
    }
});
// ★★★ 用來接收「風速調整指令」的 POST API ★★★
localApp.post('/api/ac/:floor/:id/fanspeed', (req, res) => {
    const { floor, id } = req.params;
    const { fanSpeed } = req.body;
    
    if (!acData[floor]) {
        return res.status(404).json({ error: `Floor ${floor} not found.` });
    }

    const unit = acData[floor].find(u => u.id === id);

    if (unit) {
        const validSpeeds = ["自動", "弱", "中", "強"];
        if (validSpeeds.includes(fanSpeed)) {
            unit.fanSpeed = fanSpeed;
            console.log(`空調風速已手動設定: ${floor} - ${unit.locationName} 的風速為 ${unit.fanSpeed}`);
            res.status(200).json(unit);
        } else {
            res.status(400).json({ error: `Invalid fan speed: ${fanSpeed}` });
        }
    } else {
        res.status(404).json({ error: `AC unit with id ${id} not found on floor ${floor}.` });
    }
});
// ★★★ 用來接收「風向調整指令」的 POST API ★★★
localApp.post('/api/ac/:floor/:id/swing', (req, res) => {
    const { floor, id } = req.params;
    const { type, value } = req.body;
    
    if (!acData[floor]) {
        return res.status(404).json({ error: `Floor ${floor} not found.` });
    }

    const unit = acData[floor].find(u => u.id === id);

    if (unit) {
        if (type === 'vertical') {
            unit.verticalSwing = value;
        } else if (type === 'horizontal') {
            unit.horizontalSwing = value;
        } else {
            return res.status(400).json({ error: `Invalid swing type: ${type}` });
        }
        console.log(`空調風向已手動設定: ${floor} - ${unit.locationName} 的 ${type} 風向為 ${value}`);
        res.status(200).json(unit);
    } else {
        res.status(404).json({ error: `AC unit with id ${id} not found on floor ${floor}.` });
    }
});

localApp.get('/api/solar', (req, res) => {
    const carbonReduction = solarData.today.totalGeneration * 0.495;
    const equivalentTrees = carbonReduction / 8.8;

    const responseData = {
        ...solarData,
        environmentalBenefits: {
            carbonReduction: carbonReduction,
            equivalentTrees: equivalentTrees
        }
    };
    res.json(responseData);
});

// ★★★「太陽能月份匯出」用的 API 端點 ★★★
localApp.get('/api/monthly-solar-report', (req, res) => {
    const { year, month } = req.query;
    if (!year || !month) {
        return res.status(400).json({ error: '缺少年份或月份參數' });
    }

    const daysInMonth = new Date(year, month, 0).getDate();
    const reportData = [];

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        reportData.push(generateDailySolarReport(dateStr));
    }
    
    res.json(reportData);
});

// ★★★ 獲取「所有」攝影機的 API 端點 ★★★
localApp.get('/api/cctv/all', (req, res) => {
  try {
    if (cctvData && typeof cctvData === 'object' && Object.keys(cctvData).length > 0) {
      const allCameras = [];
      Object.values(cctvData).forEach(arr => {
        arr.forEach(cam => {
          const cameraWithHls = { ...cam };
          if (cam.status === 'online' && cam.hlsUrl) {
            cameraWithHls.hlsUrl = cam.hlsUrl;  // 已為絕對 URL
          } else {
            cameraWithHls.hlsUrl = null;
          }
          allCameras.push(cameraWithHls);
        });
      });
      res.json(allCameras);
    } else {
      res.json([]);
    }
  } catch (error) {
    res.status(500).json([]);
  }
});

// ★★★「CCTV 系統」用的 API 端點 ★★★
localApp.get('/api/cctv/stream/:id', (req, res) => {
  const { id } = req.params;
  const allCameras = Object.values(cctvData).flat();
  const camera = allCameras.find(c => c.id === id);

  if (!camera || camera.status !== 'online') {
    return res.status(404).json({ error: 'Camera not found or offline' });
  }

  startHlsStream(camera);  // 確保啟動

  // 等待生成（檢查檔案是否存在，最多等10秒）
  const checkInterval = setInterval(() => {
    const m3u8Path = path.join(HLS_DIR, camera.id, 'stream.m3u8');
    if (fs.existsSync(m3u8Path)) {
      clearInterval(checkInterval);
      res.json({ hlsUrl: camera.hlsUrl });
    }
  }, 1000);

  setTimeout(() => {
    clearInterval(checkInterval);
    if (!res.headersSent) res.status(500).json({ error: 'HLS generation timeout' });
  }, 10000);
});

// ★★★「CCTV 系統」單一樓層用的 API 端點 ★★★
localApp.get('/api/cctv/:floor', (req, res) => {
    const { floor } = req.params;
    const data = cctvData[floor] || []; // 如果找不到該樓層數據，就回傳空陣列
    res.json(data);
});

// ★★★ 更新 RTSP 位址的 API 端點 ★★★
localApp.post('/api/cctv/update_stream', async (req, res) => {
    const { id, newStreamUrl } = req.body;
    if (!id || !newStreamUrl) {
        return res.status(400).json({ error: '缺少 camera ID 或新的 stream URL' });
    }

    let cameraToUpdate = null;
    let floorKey = null;

    // 尋找對應的攝影機
    for (const floor in cctvData) {
        const found = cctvData[floor].find(c => c.id === id);
        if (found) {
            cameraToUpdate = found;
            floorKey = floor;
            break;
        }
    }

    if (cameraToUpdate) {
        console.log(`[Config] 正在更新 ${cameraToUpdate.locationName} 的 RTSP 位址...`);
        cameraToUpdate.streamUrl = newStreamUrl;

        // 儲存變更到 JSON 檔案
        await saveCctvData();

        // 重新啟動該攝影機的影像轉碼
        startHlsStream(cameraToUpdate);

        res.json({ success: true, message: 'RTSP 位址已更新並已重啟串流。' });
    } else {
        res.status(404).json({ error: '找不到指定的攝影機 ID' });
    }
});

localApp.get('/api/video-intercom/:floor', (req, res) => {
    const { floor } = req.params;
    const data = intercomDriver.getDataByFloor(floor);
    res.json(data);
});

// ★★★ 「影像對講系統」用的 API 端點 ★★★
localApp.get('/api/video-intercom/stream/:id', (req, res) => {
    const { id } = req.params;
    const unit = intercomDriver.getUnitById(id);

    if (!unit || !unit.streamUrl) {
        return res.status(404).json({ error: 'Intercom unit not found or does not have a stream URL' });
    }    
    startHlsStream(unit);

    // 等待 HLS 檔案生成（最多等 10 秒）
    const checkInterval = setInterval(() => {
        const m3u8Path = path.join(HLS_DIR, unit.id, 'stream.m3u8');
        if (fs.existsSync(m3u8Path)) {
            clearInterval(checkInterval);
            res.json({ hlsUrl: unit.hlsUrl });
        }
    }, 1000);

    setTimeout(() => {
        clearInterval(checkInterval);
        if (!res.headersSent) res.status(500).json({ error: 'HLS generation timeout' });
    }, 10000);
});

// ★★★ 使用者登入 API 端點 ★★★
localApp.post('/api/login', async (req, res) => {
    const { username, password } = req.body;    
    const user = Object.values(usersData).find(u => u.username === username);    
    // 使用 bcrypt.compareSync 來安全地比對密碼 
    if (user && bcrypt.compareSync(password, user.password)) {
        loginLogs.unshift({
            actorId: user.id,
            actorUsername: user.username,
            action: 'login',
            targetId: null,
            targetUsername: null,
            timestamp: new Date().toISOString()
        });
        await saveLoginLogs();
        
        const { password: _, ...userData } = user;
        console.log(`[API] 使用者 ${username} 登入成功。`);
        res.json(userData);
    } else {
        // 登入失敗
        console.log(`[API] 使用者 ${username} 登入失敗。`);
        res.status(401).json({ error: '帳號或密碼錯誤' });
    }
});

// ★★★ 記錄登出事件的 API ★★★
localApp.post('/api/logout', async (req, res) => {
    const { userId, username } = req.body;
    if (userId && username) {
        loginLogs.unshift({
            actorId: userId,
            actorUsername: username,
            action: 'logout',
            targetId: null,
            targetUsername: null,
            timestamp: new Date().toISOString()
        });
        await saveLoginLogs();
        console.log(`[API] 使用者 ${username} 登出成功。`);
        res.status(200).json({ message: 'Logout logged successfully.' });
    } else {
        res.status(400).json({ error: '缺少使用者資訊' });
    }
});

// ★★★ 獲取特定使用者日誌的 API ★★★
localApp.get('/api/users/:id/logs', (req, res) => {
    const userId = parseInt(req.params.id);
    if (!userId) {
        return res.status(400).json({ error: '無效的使用者 ID' });
    }

    const userLogs = loginLogs.filter(log => log.actorId === userId); 
    res.json(userLogs);   
});

// ★★★ 刪除特定使用者日誌的 API ★★★
localApp.delete('/api/users/:id/logs', async (req, res) => {
    const { actorUsername, actorId } = req.body;
    
    const userId = Number(req.params.id); 

    if (!userId || isNaN(userId)) {
        return res.status(400).json({ error: '無效的使用者 ID' });
    }

    const originalLogCount = loginLogs.length;
    
    loginLogs = loginLogs.filter(log => log.actorId != userId);
    
    // 如果有日誌被刪除，則儲存變更並記錄此操作
    if (actorUsername && loginLogs.length < originalLogCount) {       
        const targetUser = Object.values(usersData).find(u => u.id == userId); 
        loginLogs.unshift({
            actorId: actorId,
            actorUsername: actorUsername,
            action: 'deleteLogs',
            targetId: userId,
            targetUsername: targetUser ? targetUser.username : `(ID: ${userId})`, 
            timestamp: new Date().toISOString()
        });
    }

    await saveLoginLogs();
    
    console.log(`[API] ${actorUsername || '未知使用者'} 已刪除使用者 ID ${userId} 的所有紀錄。`);
    res.status(200).json({ message: `Logs for user ${userId} have been cleared.` }); 
});

// ★★★ 使用者管理 API 端點 ★★★
// 1. 取得所有使用者列表
localApp.get('/api/users', (req, res) => {
    // 將物件轉換為陣列，並移除密碼欄位
    const usersArray = Object.values(usersData).map(user => {
        const { password, ...rest } = user;
        return rest;
    });
    res.json(usersArray);
});

// 2. 取得單一使用者資料
localApp.get('/api/users/:id', (req, res) => {
    const userId = req.params.id;
    const user = usersData[userId];

    if (user) {
        const { password, ...rest } = user;
        res.json(rest);
    } else {
        res.status(404).json({ error: `User with id ${userId} not found.` });
    }
});

// 3. 新增使用者
localApp.post('/api/users', async (req, res) => {
    const { username, displayName, password, role, permissions, actorUsername, actorId } = req.body;
    if (!username || !displayName || !password || !role) {
        return res.status(400).json({ error: '缺少必要欄位' });
    }

    const saltRounds = 10;
    const hashedPassword = bcrypt.hashSync(password, saltRounds);

    // 產生一個新的、不會重複的 ID
    const newId = Date.now(); 

    const newUser = {
        id: newId,
        username,
        displayName,
        password: hashedPassword,
        role,
        permissions: permissions || [],
        creationDate: new Date().toISOString()
    };
    usersData[newId] = newUser; // 使用新 ID 作為 key 加入物件

    loginLogs.unshift({
            actorId: actorId,
            actorUsername: actorUsername,
            action: 'logout',
            targetId: null,
            targetUsername: null,
            timestamp: new Date().toISOString()
        });
    await Promise.all([saveUsersData(), saveLoginLogs()]); // ★ 將變動寫入檔案 同時儲存兩個檔案

    console.log(`[API] ${actorUsername} 新增使用者成功:`, newUser.username);
    const { password: _, ...rest } = newUser;
    res.status(201).json(rest);
});

// 4. 更新使用者
localApp.put('/api/users/:id', async (req, res) => {
    const userId = req.params.id;
    if (!usersData[userId]) {
        return res.status(404).json({ error: `User with id ${userId} not found.` });
    }

    const { displayName, password, role, permissions, actorUsername, actorId } = req.body;
    const userToUpdate = usersData[userId];

    // 更新資料
    userToUpdate.displayName = displayName || userToUpdate.displayName;
    userToUpdate.role = role || userToUpdate.role;
    userToUpdate.permissions = permissions || userToUpdate.permissions;
    if (password) {
        const saltRounds = 10;
        userToUpdate.password = bcrypt.hashSync(password, saltRounds);
    }

    loginLogs.unshift({
        actorId: actorId,
        actorUsername: actorUsername,
        action: 'updateUser',
        targetId: userToUpdate.id,
        targetUsername: userToUpdate.username,
        timestamp: new Date().toISOString()
    });

    await Promise.all([saveUsersData(), saveLoginLogs()]); // ★ 將變動寫入檔案 同時儲存兩個檔案

    console.log(`[API] ${actorUsername} 更新使用者成功:`, userToUpdate.username);
    const { password: _, ...rest } = userToUpdate;
    res.json(rest);
});

// 5. 刪除使用者
localApp.delete('/api/users/:id', async (req, res) => {
    const { actorUsername, actorId } = req.body;
    const userId = req.params.id;
    if (!usersData[userId]) {
        return res.status(404).json({ error: `User with id ${userId} not found.` });
    }

    const deletedUser = usersData[userId];
    delete usersData[userId]; // 從物件中刪除
    if (actorUsername) {
        loginLogs.unshift({
            actorId: actorId,
            actorUsername: actorUsername,
            action: 'deleteUser',
            targetId: deletedUser.id,
            targetUsername: deletedUser.username,
            timestamp: new Date().toISOString()
        });
    }

    await Promise.all([saveUsersData(), saveLoginLogs()]);

    console.log(`[API] ${actorUsername} 刪除使用者成功:`, deletedUser.username);
    res.status(200).json({ message: `User with id ${userId} deleted successfully.` });
});

// ★★★ 讀取與儲存通用設定的 API ★★★

localApp.get('/api/settings', (req, res) => {
    // appSettings 是我們之前建立的、用來存放設定的全域變數
    res.json(appSettings);
});

// 接收前端傳來的儲存請求
localApp.post('/api/settings', async (req, res) => {
    // 從請求的主體中，解構出前端傳來的設定資料    
    const { isNetworkEnabled, lineAccessToken, lineUserIds } = req.body;
    
    // 更新記憶體中的 appSettings 物件
    if (typeof isNetworkEnabled === 'boolean') {
        appSettings.isNetworkEnabled = isNetworkEnabled;
    }

    // 當 lineAccessToken 有被傳送過來時才更新
    // 配合前端的 '********' 邏輯，當使用者不修改 Token 時，前端不會傳送這個欄位
    if (lineAccessToken !== undefined) {
        appSettings.lineAccessToken = lineAccessToken;
    }

    // 處理 lineUserIds 陣列
    if (Array.isArray(lineUserIds)) {
        // 確保陣列內的都是字串
        appSettings.lineUserIds = lineUserIds.filter(id => typeof id === 'string' && id.trim() !== '');
    }
    
    // 呼叫 saveSettings() 將更新後的設定寫入檔案
    await saveSettings();
    
    console.log('[API] 通用設定已更新:', appSettings);
    res.status(200).json(appSettings);
});

// ★★★ 社區報修管理 API ★★★

// 1. 取得所有報修列表
localApp.get('/api/repairs', (req, res) => {
    // 讓最新的報修顯示在最上面
    const sortedRepairs = [...repairsData].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(sortedRepairs);
});

// 2. 更新報修案件狀態
localApp.post('/api/repairs/:id/status', async (req, res) => {
    const repairId = req.params.id;
    const { status } = req.body;
    const repair = repairsData.find(r => r.id === repairId);

    if (repair && status) {
        repair.status = status;
        await saveRepairsData(); // 這裡應該是 saveRepairsData()
        console.log(`[API] 報修案件 #${repairId} 狀態已更新為: ${status}`);
        res.status(200).json(repair);
    } else {
        res.status(404).json({ error: '找不到報修案件或未提供狀態' });
    }
});

// 3. 刪除報修案件
localApp.delete('/api/repairs/:id', async (req, res) => {
    const { id } = req.params;
    const initialLength = repairsData.length;
    
    // 過濾掉要刪除的案件，產生一個新的陣列
    repairsData = repairsData.filter(r => String(r.id) !== String(id));

    // 檢查是否有案件真的被刪除
    if (repairsData.length < initialLength) {
        await saveRepairsData(); // 將變動儲存到檔案
        console.log(`[API] 報修案件 #${id} 已被刪除。`);
        res.status(200).json({ message: `Repair with id ${id} deleted successfully.` });
    } else {
        // 如果沒有找到對應 ID 的案件
        res.status(404).json({ error: `Repair with id ${id} not found.` });
    }
});

// ★★★ 線上報修同步開關 API ★★★

// 1. 獲取當前同步狀態
localApp.get('/api/settings/sync-status', (req, res) => {
    res.json({ isEnabled: appSettings.isCloudSyncEnabled });
});

// 2. 切換同步狀態
localApp.post('/api/settings/toggle-sync', async (req, res) => {
    try {
        const wasEnabled = appSettings.isCloudSyncEnabled; // 記錄切換前的狀態
        appSettings.isCloudSyncEnabled = !wasEnabled;// 切換到新狀態
        await saveSettings(); // 將新狀態存檔
        console.log(`[API] 線上報修同步功能已切換為: ${appSettings.isCloudSyncEnabled}`);
        // 如果開關是從「關閉」變成「開啟」，則立即觸發一次同步
        if (!wasEnabled && appSettings.isCloudSyncEnabled) {
            console.log('[API] 偵測到同步功能已開啟，立即觸發一次同步...');
            // 立即執行，但不需要等待它完成才回應前端
            syncRepairsFromCloud(); 
        }
        res.status(200).json({ isEnabled: appSettings.isCloudSyncEnabled });
    } catch (error) {
        console.error('[API] 切換同步狀態失敗:', error);
        res.status(500).json({ error: '儲存設定失敗' });
    }
});

// 從您的設定檔中讀取 LINE Channel Access Token
const lineMiddlewareConfig = {
    channelSecret: appSettings.lineChannelSecret,
};

// ★ 在 middleware 中使用新的設定物件
localApp.post('/api/line-webhook', line.middleware(lineMiddlewareConfig), async (req, res) => {
    try {
        const events = req.body.events;
        if (!events || events.length === 0) {
            return res.status(200).send('OK');
        }
        for (const event of events) {
            if (event.type === 'message' && event.message.type === 'text') {
                // (此處省略 Webhook 內部處理邏輯...)
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error('LINE Webhook 處理失敗:', error);
        res.status(500).send('Error');
    }
});

// ★★★ 「電梯影像」專用的串流 API 端點 ★★★
localApp.get('/api/elevator/stream/:id', (req, res) => {
    const { id } = req.params;
    // 從 elevatorsData 陣列中尋找
    const elevatorUnit = elevatorsData.find(u => u.id == id);

    if (!elevatorUnit || !elevatorUnit.streamUrl) {
        return res.status(404).json({ error: 'Elevator unit not found or does not have a stream URL' });
    }    

    // 呼叫通用的 HLS 啟動函式
    startHlsStream(elevatorUnit);

    // 等待 HLS 檔案生成（最多等 10 秒）
    const checkInterval = setInterval(() => {
        const m3u8Path = path.join(HLS_DIR, String(elevatorUnit.id), 'stream.m3u8');
        if (fs.existsSync(m3u8Path)) {
            clearInterval(checkInterval);
            res.json({ hlsUrl: elevatorUnit.hlsUrl });
        }
    }, 1000);

    setTimeout(() => {
        clearInterval(checkInterval);
        if (!res.headersSent) res.status(500).json({ error: 'HLS generation timeout' });
    }, 10000);
});

// 解除緊急對講機呼叫
localApp.post('/api/video-intercom/:id/resolve', async (req, res) => {
    const id = req.params.id;
    try {        
        const success = await intercomDriver.resolveCall(id);
        
        console.log(`[API] Driver 解除結果: ${success}`); // ★ 建議加入這行除錯

        if (success) {
            res.json({ success: true });
        } else {
            
            res.status(500).json({ success: false, message: 'Driver 回報解除失敗' });
        }
    } catch (error) {
        console.error(`[API] 解除過程發生未預期錯誤:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 獲取設定
localApp.get('/api/intercom/config/:floor', (req, res) => {
    try {
        const config = intercomDriver.getIntercomConfig(req.params.floor);
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 儲存設定
localApp.post('/api/intercom/config/:floor', async (req, res) => {
    try {
        await intercomDriver.setIntercomConfig(req.params.floor, req.body);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ★★★ 獲取「迴路群組」狀態 API (GET) ★★★
localApp.get('/api/lighting/:floor', async (req, res) => { // ★ 改為 async
    try {
        const { floor } = req.params;
        // ★ 改為呼叫驅動
        const data = await lightingDriver.getGroupStatus(floor);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ★★★ 切換「迴路群組」開關 API (POST) ★★★
localApp.post('/api/lighting/group/toggle', async (req, res) => { // ★ 改為 async
    try {
        const { floor, groupId, status } = req.body;
        if (!floor || !groupId || !status) {
            return res.status(400).json({ error: '缺少 floor, groupId 或 status 參數' });
        }

        // ★ 改為呼叫驅動
        const updatedGroup = await lightingDriver.setGroupStatus(floor, groupId, status);
        
        console.log(`[照明 API] ${updatedGroup.locationName} (ID: ${groupId}) 狀態已切換為: ${updatedGroup.status}`);
        res.status(200).json(updatedGroup);
    
    } catch (error) {
        console.error('[照明 API] 錯誤:', error.message);
        res.status(404).json({ error: error.message });
    }
});

localApp.get('/api/barrier/:floor', (req, res) => {
    const { floor } = req.params;
    const data = barrierDriver.getDataByFloor(floor);
    res.json(data);
});

// ★★★ 「柵欄機」控制 API 端點 (接收開關指令) ★★★
localApp.post('/api/barrier/:floor/:id/control', async (req, res) => {
    const { floor, id } = req.params;
    const { command } = req.body;

    if (command !== 'open' && command !== 'close') {
        return res.status(400).json({ error: `無效的指令: ${command}` });
    }

    try {
        const success = await barrierDriver.controlBarrier(floor, id, command);
        if (success) {
            console.log(`[API] 柵欄機控制成功: ${floor}/${id} -> ${command}`);
            // 回傳最新的狀態給前端
            const data = barrierDriver.getDataByFloor(floor);
            const updatedBarrier = data.find(b => b.id === id);
            res.json(updatedBarrier);
        } else {
            res.status(500).json({ error: '柵欄機控制失敗 (驅動程式回報錯誤)' });
        }
    } catch (error) {
        console.error(`[API] 柵欄機控制發生例外錯誤:`, error);
        res.status(500).json({ error: error.message });
    }
});
// ★★★ 「柵欄機設定」讀取 API ★★★
localApp.get('/api/barrier/config/:floor', (req, res) => {
    // 檢查是否處於模擬模式
    if (barrierDriver.USE_SIMULATION_MODE) {
        //return res.status(400).json({ error: '目前處於模擬模式，無法讀取 Modbus 設定' });
    }
    
    const { floor } = req.params;
    const allConfig = barrierDriver.getConfig(); 

    if (allConfig[floor] && Array.isArray(allConfig[floor])) {        
        res.json(allConfig[floor]);
    } else {
        res.status(404).json({ error: `找不到 ${floor} 的設定` });
    }
});

// ★★★ 「柵欄機設定」儲存 API ★★★
localApp.post('/api/barrier/config/:floor', async (req, res) => {
    // 檢查是否處於模擬模式
    if (barrierDriver.USE_SIMULATION_MODE) {
        return res.status(400).json({ error: '目前處於模擬模式，無法儲存 Modbus 設定' });
    }
    
    const { floor } = req.params;
    const controllersArray = req.body;
    
    if (!Array.isArray(controllersArray)) {
        return res.status(400).json({ error: '請求資料必須是一個陣列' });
    }
    
    try {
        // ★ 呼叫新的儲存函式
        const success = await barrierDriver.saveFloorConfig(floor, controllersArray);
        if (success) {
            res.status(200).json({ message: '設定已儲存並套用' });
        } else {
            res.status(404).json({ error: `找不到 ${floor} 的設定` });
        }
    } catch (error) {
        console.error(`[API] 儲存柵欄機設定失敗:`, error);
        res.status(500).json({ error: '儲存設定時發生伺服器錯誤' });
    }
});

/*localApp.listen(PORT, () => {
    console.log(`後端伺服器正在 http://localhost:${PORT} 運行`);      
    
    setTimeout(() => {
        Object.values(cctvData).flat().forEach(startHlsStream);
    }, 1000);   

    console.log('[Sync] 伺服器已啟動，立即進行首次同步...');
    syncRepairsFromCloud();

    // 在首次同步執行後，設定10秒的定時任務
    setInterval(syncRepairsFromCloud, 10000);
    
});*/

// 獲取modbus防盜求救系統設定的API端點
localApp.get('/api/theft/config/:id', (req, res) => {
    try {
        const { id } = req.params; // '4f-A' 或 '4f-B'
        const config = theftpreventionDriver.getTheftConfigById(id);
        res.json(config);
    } catch (error) {
        console.error(`[API Error] /api/theft/config/${req.params.id} (GET):`, error);
        res.status(500).json({ error: error.message });
    }
});
//更新modbus防盜求救系統設定的API端點
localApp.post('/api/theft/config/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const newSetting = req.body;
        await theftpreventionDriver.setTheftConfigById(id, newSetting);
        res.json({ success: true, message: '設定已儲存' });
    } catch (error) {
        console.error(`[API Error] /api/theft/config/${req.params.id} (POST):`, error);
        res.status(500).json({ error: error.message });
    }
});

// 啟動伺服器
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
        
    setTimeout(() => {
        Object.values(cctvData).flat().forEach(startHlsStream);
    }, 1000);   

    console.log('[Sync] 伺服器已啟動，立即進行首次同步...');
    syncRepairsFromCloud();
    setInterval(syncRepairsFromCloud, 10000);
});

let serverInstance = null

console.log('後端伺服器啟動於 port:', PORT);


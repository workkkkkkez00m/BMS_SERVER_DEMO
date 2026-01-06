/*
 * ===================================================================
 * 照明系統驅動程式 (Lighting Driver)
 * ===================================================================
 * 說明：
 * 此檔案負責抽象化所有燈光控制的硬體邏輯。
 * API層只會呼叫這裡匯出的 getGroupStatus 和 setGroupStatus 函式。
 * 透過更改下方的 DRIVER_MODE 變數，來決定要使用哪種驅動。
 *
 * - 'simulate': (預設) 使用記憶體中的模擬資料，由前端API控制。
 * - 'modbus':   (預留) 呼叫 Modbus/TCP 邏輯 (需自行填入)。 
 * ===================================================================
 */

// --- 1. 驅動程式設定 ---
// ★ 修改此處以切換驅動程式 ★
const DRIVER_MODE = 'simulate'; // 可選值: 'simulate', 'modbus'

// --- 2. 驅動程式庫 (未來正式上線時使用) ---
/*
// (未來 Modbus 需要) 將 server.txt 中的 Modbus 連線獨立成一個檔案
// const { modbusClient, ensureModbusConnection } = require('./modbusService'); 

*/


// --- 3. 模擬模式 (simulate) ---
// 這些資料統一由前端控制。
const simulatedGroups = {
    "b3f": [
        { groupId: "B3A", locationName: "B3F-A迴路 (共 22 盞)", status: "off" },
        { groupId: "B3B", locationName: "B3F-B迴路 (共 20 盞)", status: "off" },
        { groupId: "B3C", locationName: "B3F-C迴路 (共 32 盞)", status: "off" },
        { groupId: "B3D", locationName: "B3F-D迴路 (共 34 盞)", status: "off" },
        { groupId: "B3E", locationName: "B3F-E迴路 (共 34 盞)", status: "off" },
        { groupId: "B3F", locationName: "B3F-F迴路 (共 38 盞)", status: "off" },
        { groupId: "B3G", locationName: "B3F-G迴路 (共 19 盞)", status: "off" },
        { groupId: "B3H", locationName: "B3F-H迴路 (共 23 盞)", status: "off" }
    ]
};

async function _getSimulatedStatus(floor) {
    console.log(`[Driver: SIMULATE] 讀取 ${floor} 的模擬狀態...`);
    return simulatedGroups[floor] || [];
}

async function _setSimulatedStatus(floor, groupId, newStatus) {
    console.log(`[Driver: SIMULATE] 正在設定 ${floor}-${groupId} 的狀態為 ${newStatus}`);
    const group = simulatedGroups[floor]?.find(g => g.groupId === groupId);
    if (group) {
        group.status = newStatus; // 狀態被永久更新
        return group;
    } else {
        throw new Error(`[Driver: SIMULATE] 在 ${floor} 找不到 ${groupId} 迴路`);
    }
}


// --- 4. Modbus 驅動 (Modbus) - (預留銜接) ---
// (在此填入真實的 Modbus IP 和暫存器地址)
const modbusConfig = {
    "b3f": [
        { groupId: "B3A", locationName: "B3F-A迴路", modbusAddress: 100 },
        { groupId: "B3B", locationName: "B3F-B迴路", modbusAddress: 101 },
        // ... A-H
    ]
};

async function _getModbusStatus(floor) {
    console.warn(`[Driver: MODBUS] _getModbusStatus 尚未實作。`);
    // ================== TODO: 未來在此填入 Modbus 讀取邏輯 ==================
    // 範例:
    // await ensureModbusConnection();
    // const response = await modbusClient.readCoils(modbusConfig[floor][0].modbusAddress, 8);
    // const formattedData = modbusConfig[floor].map((group, index) => ({
    //     ...group,
    //     status: response.data[index] ? "on" : "off"
    // }));
    // return formattedData;
    // ======================================================================
    
    // (在實作前，暫時回傳模擬資料以防前端出錯)
    return _getSimulatedStatus(floor);
}

async function _setModbusStatus(floor, groupId, newStatus) {
    console.warn(`[Driver: MODBUS] _setModbusStatus 尚未實作 (目標: ${groupId} -> ${newStatus})`);
    // ================== TODO: 未來在此填入 Modbus 寫入邏輯 ==================
    // 範例:
    // const group = modbusConfig[floor].find(g => g.groupId === groupId);
    // if (!group) throw new Error("Modbus Config 找不到 " + groupId);
    // await ensureModbusConnection();
    // await modbusClient.writeCoil(group.modbusAddress, (newStatus === 'on'));
    // return group;
    // ======================================================================

    // (在實作前，暫時寫入模擬資料以防前端出錯)
    return _setSimulatedStatus(floor, groupId, newStatus);
}

// --- 5. 驅動程式路由 (API 會呼叫這裡) ---

/**
 * [API 呼叫] 獲取指定樓層的所有迴路狀態
 */
async function getGroupStatus(floor) {
    switch (DRIVER_MODE) {
        case 'simulate':
            return await _getSimulatedStatus(floor);
        case 'modbus':
            return await _getModbusStatus(floor);        
        default:
            throw new Error(`未知的 DRIVER_MODE: ${DRIVER_MODE}`);
    }
}

/**
 * [API 呼叫] 設定指定迴路的狀態
 */
async function setGroupStatus(floor, groupId, newStatus) {
    switch (DRIVER_MODE) {
        case 'simulate':
            return await _setSimulatedStatus(floor, groupId, newStatus);
        case 'modbus':
            return await _setModbusStatus(floor, groupId, newStatus);        
        default:
            throw new Error(`未知的 DRIVER_MODE: ${DRIVER_MODE}`);
    }
}

// 匯出這兩個函式，讓 server.txt 可以使用
module.exports = {
    getGroupStatus,
    setGroupStatus
};
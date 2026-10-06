// Web Worker for processing high-frequency quote updates off the main thread.

let masterData = [];
let masterDataMap = {};
let masterDataSymbolMap = {};

let futuresData = [];
let futuresDataKeyMap = {};
let futuresDataSymbolExpiryMap = {};

const liveData = {};

let globalExpiry = 'Near';
let activeFilters = [];
let activeFuturesFilters = [];

let sortField = null;
let sortDesc = false;

let futuresSortField = null;
let futuresSortDesc = false;

// Convert to strict float or 0.0 (Phase 4: integrity & type safety)
function castFloat(val) {
    if (val === null || val === undefined || val === '' || val === '-') return 0.0;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? 0.0 : parsed;
}

// Convert to strict int or 0 (Phase 4: integrity & type safety)
function castInt(val) {
    if (val === null || val === undefined || val === '' || val === '-') return 0;
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? 0 : parsed;
}

self.onmessage = function (e) {
    const { type, data } = e.data;

    switch (type) {
        case 'INIT_MASTER':
            masterData = data || [];
            masterDataMap = {};
            masterDataSymbolMap = {};
            masterData.forEach(row => {
                const key = `${row.exchange}|${row.tradingsymbol}`;
                masterDataMap[key] = row;
                masterDataSymbolMap[row.symbol] = row;
                if (!liveData[key]) liveData[key] = {};
                if (row.oi && row.oi !== '-') liveData[key].oi = row.oi;
                if (row.poi && row.poi !== '-') liveData[key].poi = row.poi;
            });
            calculateStocksAndDispatch();
            break;

        case 'INIT_FUTURES':
            futuresData = data.futuresData || [];
            futuresDataKeyMap = {};
            futuresDataSymbolExpiryMap = {};
            futuresData.forEach(f => {
                const key = `${f.exchange}|${f.tradingsymbol}`;
                futuresDataKeyMap[key] = f;
                futuresDataSymbolExpiryMap[`${f.symbol}|${f.expiry_type}`] = f;
            });
            calculateFuturesAndDispatch();
            break;

        case 'SET_EXPIRY':
            globalExpiry = data || 'Near';
            processAndDispatchAll();
            break;

        case 'SET_FILTERS':
            activeFilters = data || [];
            processAndDispatchAll();
            break;

        case 'SET_FUTURES_FILTERS':
            activeFuturesFilters = data || [];
            processAndDispatchAll();
            break;

        case 'SET_SORT':
            sortField = data.field;
            sortDesc = data.desc;
            processAndDispatchAll();
            break;

        case 'SET_FUTURES_SORT':
            futuresSortField = data.field;
            futuresSortDesc = data.desc;
            processAndDispatchAll();
            break;

        case 'TICK_BATCH':
            processTickBatch(data || []);
            break;

        default:
            break;
    }
};

function processTickBatch(ticks) {
    let hasStocksUpdate = false;
    let hasFuturesUpdate = false;

    ticks.forEach(tick => {
        const key = tick.key;
        if (!key) return;

        // Perform Phase 4 Strict Type Validation & Casting on receipt
        const parsedTick = {
            key: key,
            lp: tick.lp !== undefined ? castFloat(tick.lp) : undefined,
            pc: tick.pc !== undefined ? castFloat(tick.pc) : undefined,
            o: tick.o !== undefined ? castFloat(tick.o) : undefined,
            h: tick.h !== undefined ? castFloat(tick.h) : undefined,
            l: tick.l !== undefined ? castFloat(tick.l) : undefined,
            c: tick.c !== undefined ? castFloat(tick.c) : undefined,
            v: tick.v !== undefined ? castInt(tick.v) : undefined,
            oi: tick.oi !== undefined ? castFloat(tick.oi) : undefined,
            poi: tick.poi !== undefined ? castFloat(tick.poi) : undefined,
            bp1: tick.bp1 !== undefined ? castFloat(tick.bp1) : undefined,
            sp1: tick.sp1 !== undefined ? castFloat(tick.sp1) : undefined
        };

        // Merge to accumulated cache
        if (!liveData[key]) {
            liveData[key] = {};
        }
        
        // Only overwrite with defined fields
        Object.keys(parsedTick).forEach(k => {
            if (parsedTick[k] !== undefined) {
                liveData[key][k] = parsedTick[k];
            }
        });

        // Determine which tables this affects
        if (masterDataMap[key]) {
            hasStocksUpdate = true;
        }
        if (futuresDataKeyMap[key]) {
            hasFuturesUpdate = true;
        }

        // If this is a future key, it also updates the corresponding spot row's target expiry metrics (OI change)
        const fut = futuresDataKeyMap[key];
        if (fut) {
            const spotRow = masterDataSymbolMap[fut.symbol];
            if (spotRow) {
                hasStocksUpdate = true;
            }
        }
    });

    // Run batch calculations and dispatch
    if (hasStocksUpdate) {
        calculateStocksAndDispatch();
    }
    if (hasFuturesUpdate) {
        calculateFuturesAndDispatch();
    }
}

function processAndDispatchAll() {
    calculateStocksAndDispatch();
    calculateFuturesAndDispatch();
}

// Evaluate conditional filters locally (Phase 2 & 3 sync)
function evaluateCondition(fieldVal, op, targetVal, targetVal2) {
    if (fieldVal === undefined || fieldVal === null) return false;

    const num = parseFloat(fieldVal);
    const t1 = parseFloat(targetVal);
    const t2 = parseFloat(targetVal2);

    if (op === '=') return String(fieldVal).toLowerCase() === String(targetVal).toLowerCase();
    if (op === '>') return !isNaN(num) && num > t1;
    if (op === '<') return !isNaN(num) && num < t1;
    if (op === 'between') return !isNaN(num) && !isNaN(t1) && !isNaN(t2) && num >= t1 && num <= t2;
    if (op === '!=0') return !isNaN(num) && num !== 0;
    if (op === 'isNum') return !isNaN(num) && Number.isFinite(num);
    if (op === '!=null') {
        const str = String(fieldVal).trim();
        return str !== '' && str !== '-' && str !== 'NaN';
    }
    if (op === 'contains') return String(fieldVal).toLowerCase().includes(String(targetVal).toLowerCase());
    return true;
}

function getFieldValue(row, live, field) {
    if (field === 'symbol') return row.symbol || '';
    if (field === 'lotsize') return castInt(row.lotsize);
    if (field === 'avg_vol') return castFloat(row.avg_vol);
    if (field === 'atr_14') return castFloat(row.atr_14);

    if (!live) return null;

    if (field === 'lp') return live.lp || 0;
    if (field === 'o') return live.o || 0;
    if (field === 'h') return live.h || 0;
    if (field === 'l') return live.l || 0;
    if (field === 'v') return live.v || 0;
    if (field === 'oi') return live.oi || 0;
    if (field === 'poi') return live.poi || 0;

    if (field === 'change') {
        return live.lp && live.pc !== undefined ? (live.lp - (live.lp / (1 + (live.pc / 100)))) : 0;
    }
    if (field === 'pc') return live.pc || 0;

    if (field === 'near_oi_pc') return live.computed_oi_chg || 0;
    if (field === 'rank_vol') return live.computed_rank_vol || 999;
    if (field === 'rank_chg') return live.computed_rank_chg || 999;
    if (field === 'rank_abs_chg') return live.computed_rank_abschg || 999;
    if (field === 'rank_oi') return live.computed_rank_oi || 999;

    if (field === 'chg_vol_pc') return live.computed_chgvolpc || 0;
    if (field === 'ohl') {
        const openVal = live.o;
        if (!openVal) return '';
        if (openVal === live.h) return 'O=H';
        if (openVal === live.l) return 'O=L';
        return '';
    }

    return null;
}

function calculateStocksAndDispatch() {
    if (masterData.length === 0) return;

    // First, enrich all rows with live computations
    const enrichedRows = masterData.map(row => {
        const key = `${row.exchange}|${row.tradingsymbol}`;
        if (!liveData[key]) {
            liveData[key] = {};
        }
        const live = liveData[key];

        // Compute spot metrics
        if (live.lp !== undefined) {
            const lp = live.lp;
            const pc = live.pc || 0.0;
            const chg = lp - (lp / (1 + (pc / 100.0)));
            live.computed_chg = chg;
            live.computed_abschg = Math.abs(pc);
            live.computed_chgpc = pc;

            // Volume Spurt Change %
            const avgVol = castFloat(row.avg_vol);
            if (live.v !== undefined && avgVol > 0) {
                live.computed_chgvolpc = (live.v / avgVol) * 100.0;
            } else {
                live.computed_chgvolpc = 0.0;
            }
        }

        // Target Expiry Future calculations (OI change)
        const targetExpiry = globalExpiry || 'Near';
        const targetFut = futuresDataSymbolExpiryMap ? futuresDataSymbolExpiryMap[`${row.symbol}|${targetExpiry}`] : null;
        const futKey = targetFut ? `${targetFut.exchange}|${targetFut.tradingsymbol}` : null;
        const futLive = futKey ? (liveData[futKey] || {}) : {};
        
        const oiVal = (futLive.oi !== undefined && futLive.oi > 0) ? futLive.oi : ((targetFut && targetFut.oi !== undefined && targetFut.oi > 0) ? targetFut.oi : ((live.oi !== undefined && live.oi > 0) ? live.oi : row.oi));
        const poiVal = (futLive.poi !== undefined && futLive.poi > 0) ? futLive.poi : ((targetFut && targetFut.poi !== undefined && targetFut.poi > 0) ? targetFut.poi : ((live.poi !== undefined && live.poi > 0) ? live.poi : row.poi));

        if (oiVal !== undefined && oiVal !== null && oiVal !== '-') {
            live.computed_oi = oiVal;
            if (poiVal !== undefined && poiVal !== null && poiVal !== '-') {
                live.computed_poi = poiVal;
                if (parseFloat(poiVal) > 0) {
                    live.computed_oi_chg = ((parseFloat(oiVal) - parseFloat(poiVal)) / parseFloat(poiVal)) * 100.0;
                } else {
                    live.computed_oi_chg = null;
                }
            }
        }

        return {
            row: row,
            key: key,
            live: live
        };
    });

    // Filter rows locally (Phase 2 local check)
    let visibleRows = enrichedRows;
    if (activeFilters.length > 0) {
        visibleRows = enrichedRows.filter(item => {
            let result = true;
            let currentResult = null;

            for (const f of activeFilters) {
                const val = getFieldValue(item.row, item.live, f.field);
                const r = evaluateCondition(val, f.op, f.val, f.val2);

                if (currentResult === null) {
                    currentResult = r;
                } else {
                    if (f.logic === 'AND') currentResult = currentResult && r;
                    else currentResult = currentResult || r;
                }
            }
            return currentResult !== null ? currentResult : true;
        });
    }

    // Rank calculations (only for visible rows)
    if (visibleRows.length > 0) {
        // Rank Volume
        const sortedVol = [...visibleRows]
            .filter(d => d.live.computed_chgvolpc !== undefined)
            .sort((a, b) => b.live.computed_chgvolpc - a.live.computed_chgvolpc);
        sortedVol.forEach((item, index) => {
            liveData[item.key].computed_rank_vol = index + 1;
        });

        // Rank Change
        const sortedChg = [...visibleRows]
            .filter(d => d.live.computed_chgpc !== undefined)
            .sort((a, b) => b.live.computed_chgpc - a.live.computed_chgpc);
        sortedChg.forEach((item, index) => {
            liveData[item.key].computed_rank_chg = index + 1;
        });

        // Rank ABS Change
        const sortedAbs = [...visibleRows]
            .filter(d => d.live.computed_abschg !== undefined)
            .sort((a, b) => b.live.computed_abschg - a.live.computed_abschg);
        sortedAbs.forEach((item, index) => {
            liveData[item.key].computed_rank_abschg = index + 1;
        });

        // Rank OI
        const sortedOi = [...visibleRows]
            .filter(d => d.live.computed_oi_chg !== undefined)
            .sort((a, b) => b.live.computed_oi_chg - a.live.computed_oi_chg);
        sortedOi.forEach((item, index) => {
            liveData[item.key].computed_rank_oi = index + 1;
        });
    }

    // Construct final rows to send to UI
    let finalRows = visibleRows.map(item => {
        const live = liveData[item.key] || {};
        
        // Calculate ATM strike
        let atmStrike = '-';
        if (live.lp !== undefined) {
            const targetExpiry = globalExpiry || 'Near';
            const targetFut = futuresDataSymbolExpiryMap[`${item.row.symbol}|${targetExpiry}`];
            if (targetFut && targetFut.strike_difference) {
                const lp = live.lp;
                const sd = parseFloat(targetFut.strike_difference);
                if (lp > 0 && sd > 0) {
                    atmStrike = (Math.round(lp / sd) * sd).toFixed(0);
                }
            }
        }

        return {
            symbol: item.row.symbol,
            exchange: item.row.exchange,
            tradingsymbol: item.row.tradingsymbol,
            lotsize: item.row.lotsize,
            atr_14: item.row.atr_14,
            avg_vol: item.row.avg_vol,
            key: item.key,
            
            // Live fields
            lp: (live.lp !== undefined && live.lp !== null) ? parseFloat(live.lp).toFixed(2) : '-',
            change: (live.computed_chg !== undefined && live.computed_chg !== null) ? parseFloat(live.computed_chg).toFixed(2) : '-',
            pc: (live.pc !== undefined && live.pc !== null) ? parseFloat(live.pc).toFixed(2) : '-',
            o: (live.o !== undefined && live.o !== null) ? parseFloat(live.o).toFixed(2) : '-',
            h: (live.h !== undefined && live.h !== null) ? parseFloat(live.h).toFixed(2) : '-',
            l: (live.l !== undefined && live.l !== null) ? parseFloat(live.l).toFixed(2) : '-',
            v: (live.v !== undefined && live.v !== null) ? live.v : '-',
            chg_vol_pc: (live.computed_chgvolpc !== undefined && live.computed_chgvolpc !== null) ? parseFloat(live.computed_chgvolpc).toFixed(2) + '%' : '-',
            
            // Ranks
            rank_vol: live.computed_rank_vol || '-',
            rank_chg: live.computed_rank_chg || '-',
            rank_abs_chg: live.computed_rank_abschg || '-',
            rank_oi: (live.computed_rank_oi && live.computed_rank_oi !== 9999) ? live.computed_rank_oi : '-',
            
            // OI and ATM
            near_oi_pc: (live.computed_oi_chg !== undefined && live.computed_oi_chg !== null) ? parseFloat(live.computed_oi_chg).toFixed(2) + '%' : '-',
            present_oi: (live.computed_oi !== undefined && live.computed_oi !== null) ? live.computed_oi : '-',
            yest_oi: (live.computed_poi !== undefined && live.computed_poi !== null) ? live.computed_poi : '-',
            atm_strike: atmStrike,
            ohl: getFieldValue(item.row, live, 'ohl') || '-'
        };
    });

    // Apply Sorting
    if (sortField) {
        finalRows.sort((a, b) => {
            let valA = a[sortField];
            let valB = b[sortField];

            // Parse percentages or rankings for proper sorting
            if (typeof valA === 'string' && valA.endsWith('%')) valA = parseFloat(valA);
            if (typeof valB === 'string' && valB.endsWith('%')) valB = parseFloat(valB);
            
            const numA = parseFloat(valA);
            const numB = parseFloat(valB);

            if (!isNaN(numA) && !isNaN(numB)) {
                return sortDesc ? numB - numA : numA - numB;
            }

            // String comparison
            const strA = String(valA).toLowerCase();
            const strB = String(valB).toLowerCase();
            if (strA < strB) return sortDesc ? 1 : -1;
            if (strA > strB) return sortDesc ? -1 : 1;
            return 0;
        });
    }

    self.postMessage({
        type: 'STOCKS_UPDATE',
        rows: finalRows
    });
}

function calculateFuturesAndDispatch() {
    if (futuresData.length === 0) return;

    let filteredFutures = futuresData.map(f => {
        const key = `${f.exchange}|${f.tradingsymbol}`;
        const live = liveData[key] || {};

        const lp = live.lp || 0.0;
        const prevClose = live.o || 0.0;
        const change = lp > 0 && prevClose > 0 ? (lp - prevClose) : 0.0;
        const pc = prevClose > 0 ? ((lp - prevClose) / prevClose) * 100.0 : 0.0;

        return {
            ...f,
            key: key,
            ltp: lp,
            change: change,
            pc: pc,
            prev_close: prevClose,
            open: live.o || 0.0,
            high: live.h || 0.0,
            low: live.l || 0.0,
            volume: live.v || 0,
            oi: live.oi || 0
        };
    });

    // Apply local Futures Filters
    if (activeFuturesFilters.length > 0) {
        filteredFutures = filteredFutures.filter(item => {
            let currentResult = null;
            for (const f of activeFuturesFilters) {
                let val = item[f.field];
                // For nested fields or specific mappings
                if (f.field === 'lotsize') val = item.lotsize;
                if (f.field === 'strike_difference') val = item.strike_difference;
                
                const r = evaluateCondition(val, f.op, f.val, f.val2);
                if (currentResult === null) {
                    currentResult = r;
                } else {
                    if (f.logic === 'AND') currentResult = currentResult && r;
                    else currentResult = currentResult || r;
                }
            }
            return currentResult !== null ? currentResult : true;
        });
    }

    // Apply Futures Sorting
    if (futuresSortField) {
        filteredFutures.sort((a, b) => {
            let valA = a[futuresSortField];
            let valB = b[futuresSortField];

            const numA = parseFloat(valA);
            const numB = parseFloat(valB);

            if (!isNaN(numA) && !isNaN(numB)) {
                return futuresSortDesc ? numB - numA : numA - numB;
            }

            const strA = String(valA).toLowerCase();
            const strB = String(valB).toLowerCase();
            if (strA < strB) return futuresSortDesc ? 1 : -1;
            if (strA > strB) return futuresSortDesc ? -1 : 1;
            return 0;
        });
    }

    self.postMessage({
        type: 'FUTURES_UPDATE',
        rows: filteredFutures
    });
}

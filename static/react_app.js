// React UI Components for WebTrader - loaded via Babel in-browser

const e = React.createElement;

// Global Event Broker for React components
let stocksListeners = [];
let futuresListeners = [];

window.reactState = {
    _stocks: [],
    _futures: [],
    setStocks(rows) {
        this._stocks = rows;
        stocksListeners.forEach(l => l(rows));
    },
    setFutures(rows) {
        this._futures = rows;
        futuresListeners.forEach(l => l(rows));
    },
    subscribeStocks(l) {
        stocksListeners.push(l);
        if (this._stocks && this._stocks.length > 0) {
            l(this._stocks);
        }
        return () => { stocksListeners = stocksListeners.filter(x => x !== l); };
    },
    subscribeFutures(l) {
        futuresListeners.push(l);
        if (this._futures && this._futures.length > 0) {
            l(this._futures);
        }
        return () => { futuresListeners = futuresListeners.filter(x => x !== l); };
    }
};

// ----------------------------------------------------
// 1. CONTROL PANEL (Memoized, 0 dependencies on ticks)
// ----------------------------------------------------
const ControlPanel = React.memo(function ControlPanel({ onFilterChange }) {
    const [filters, setFilters] = React.useState([
        { id: 'f1', logic: '', field: '', op: '', val: '', val2: '' },
        { id: 'f2', logic: '', field: '', op: '', val: '', val2: '' },
        { id: 'f3', logic: '', field: '', op: '', val: '', val2: '' },
        { id: 'f4', logic: '', field: '', op: '', val: '', val2: '' }
    ]);
    const [isFilterActive, setIsFilterActive] = React.useState(false);

    // Debounce filter changes (Phase 2: min 300ms delay)
    const debounceTimerRef = React.useRef(null);

    const handleFilterChange = (index, key, value) => {
        const updated = [...filters];
        updated[index][key] = value;
        setFilters(updated);

        if (isFilterActive) {
            triggerFilterDebounced(updated, true);
        }
    };

    const triggerFilterDebounced = (activeFiltersList, activeState) => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        debounceTimerRef.current = setTimeout(() => {
            const parsedFilters = activeFiltersList.map(f => {
                let isActive = false;
                if (!f.field || !f.op) return null;
                if (f.op === 'between') {
                    isActive = f.val.trim() !== '' && f.val2.trim() !== '';
                } else if (['!=0', 'isNum', '!=null'].includes(f.op)) {
                    isActive = true;
                } else {
                    isActive = f.val.trim() !== '';
                }
                
                if (!isActive) return null;
                return {
                    logic: f.id === 'f1' ? 'AND' : f.logic,
                    field: f.field,
                    op: f.op,
                    val: f.val.trim(),
                    val2: f.val2.trim()
                };
            }).filter(f => f !== null);

            onFilterChange(parsedFilters, activeState);
        }, 300);
    };

    const applyFilters = () => {
        setIsFilterActive(true);
        triggerFilterDebounced(filters, true);
    };

    const clearFilters = () => {
        setIsFilterActive(false);
        const cleared = filters.map(f => ({ ...f, val: '', val2: '', logic: '', field: '', op: '' }));
        setFilters(cleared);
        triggerFilterDebounced(cleared, false);
    };

    return (
        <div className="filter-bar" style={{
            margin: '8px 20px 8px 20px',
            padding: '6px 12px',
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            display: 'flex',
            flexWrap: 'nowrap',
            gap: '6px',
            alignItems: 'center',
            overflowX: 'auto'
        }}>
            <span style={{ fontWeight: '600', fontSize: '0.8rem', color: 'var(--accent)', whiteSpace: 'nowrap' }}>Filters:</span>
            {filters.map((f, i) => (
                <div key={f.id} style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
                    {f.id !== 'f1' && (
                        <select 
                            value={f.logic}
                            onChange={(e) => handleFilterChange(i, 'logic', e.target.value)}
                            style={{ width: '46px', padding: '3px', fontSize: '0.78rem' }}
                        >
                            <option value="" disabled>Select</option>
                            <option value="AND">AND</option>
                            <option value="OR">OR</option>
                        </select>
                    )}
                    <select 
                        value={f.field}
                        onChange={(e) => handleFilterChange(i, 'field', e.target.value)}
                        style={{ width: '80px', padding: '3px', fontSize: '0.78rem' }}
                    >
                        <option value="" disabled>Select</option>
                        <option value="symbol">Name</option>
                        <option value="lotsize">Lot Size</option>
                        <option value="avg_vol">14D Avg Vol</option>
                        <option value="v">Volume</option>
                        <option value="lp">LTP</option>
                        <option value="change">Change</option>
                        <option value="pc">Chg%</option>
                        <option value="atr_14">14D ATR</option>
                        <option value="o">Open</option>
                        <option value="h">High</option>
                        <option value="l">Low</option>
                        <option value="oi">OI Change</option>
                    </select>
                    <select 
                        value={f.op}
                        onChange={(e) => handleFilterChange(i, 'op', e.target.value)}
                        style={{ width: '55px', padding: '3px', fontSize: '0.78rem' }}
                    >
                        <option value="" disabled>Select</option>
                        <option value=">">&gt;</option>
                        <option value="<">&lt;</option>
                        <option value="=">=</option>
                        <option value="between">Betw</option>
                        <option value="!=0">!= 0</option>
                        <option value="isNum">isNum</option>
                        <option value="!=null">!=Null</option>
                        <option value="contains">In</option>
                    </select>
                    {!['!=0', 'isNum', '!=null'].includes(f.op) && (
                        <input 
                            type="text" 
                            value={f.val}
                            placeholder="Value"
                            onChange={(e) => handleFilterChange(i, 'val', e.target.value)}
                            style={{ width: '55px', padding: '3px', fontSize: '0.78rem' }}
                        />
                    )}
                    {f.op === 'between' && (
                        <input 
                            type="text" 
                            value={f.val2}
                            placeholder="To"
                            onChange={(e) => handleFilterChange(i, 'val2', e.target.value)}
                            style={{ width: '55px', padding: '3px', fontSize: '0.78rem' }}
                        />
                    )}
                </div>
            ))}
            <div style={{ display: 'flex', gap: '5px', marginLeft: 'auto', alignItems: 'center', flexShrink: 0 }}>
                <button className="primary" style={{ padding: '3px 10px', fontSize: '0.78rem' }} onClick={applyFilters}>Apply</button>
                <button style={{ padding: '3px 10px', fontSize: '0.78rem' }} onClick={clearFilters}>Clear</button>
            </div>
        </div>
    );
});

// ----------------------------------------------------
// 2. STREAMING GRID (FnO Stocks Table)
// ----------------------------------------------------
function StreamingGrid({ onSortChange }) {
    const [rows, setRows] = React.useState([]);
    const [currentSort, setCurrentSort] = React.useState({ field: null, desc: false });

    React.useEffect(() => {
        return window.reactState.subscribeStocks(setRows);
    }, []);

    const handleSort = (field) => {
        const desc = currentSort.field === field ? !currentSort.desc : false;
        setCurrentSort({ field, desc });
        onSortChange(field, desc);
    };

    const getProfitLossClass = (val) => {
        const floatVal = parseFloat(val);
        if (isNaN(floatVal) || floatVal === 0) return '';
        return floatVal > 0 ? 'text-profit' : 'text-loss';
    };

    const getProfitLossBgClass = (val) => {
        const floatVal = parseFloat(val);
        if (isNaN(floatVal) || floatVal === 0) return '';
        return floatVal > 0 ? 'text-profit bg-profit-light' : 'text-loss bg-loss-light';
    };

    const handleActionT = (e, key) => {
        e.stopPropagation();
        if (window.app && typeof window.app.setOrderContext === 'function') {
            window.app.setOrderContext(key);
        }
    };

    return (
        <table className="excel-grid">
            <thead className="fno-header">
                <tr style={{ cursor: 'pointer' }}>
                    <th>S.No</th>
                    <th onClick={() => handleSort('symbol')}>Name {currentSort.field === 'symbol' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('prev')}>Prev Close {currentSort.field === 'prev' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('o')}>Open {currentSort.field === 'o' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('h')}>High {currentSort.field === 'h' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('l')}>Low {currentSort.field === 'l' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('lp')}>LTP {currentSort.field === 'lp' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('change')}>Change {currentSort.field === 'change' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('pc')}>Chg% {currentSort.field === 'pc' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('atr_14')}>14Day ATR {currentSort.field === 'atr_14' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('avg_vol')}>14Day Avg Vol {currentSort.field === 'avg_vol' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('v')}>Volume {currentSort.field === 'v' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('chg_vol_pc')}>Change in Volume {currentSort.field === 'chg_vol_pc' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('rank_vol')}>Rank of Avg Vol {currentSort.field === 'rank_vol' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('rank_chg')}>Rank of Today's Change {currentSort.field === 'rank_chg' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('rank_abs_chg')}>ABS Change Rank {currentSort.field === 'rank_abs_chg' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('near_oi_pc')}>OI Change % (Near) {currentSort.field === 'near_oi_pc' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('rank_oi')}>OI Change Rank (Near) {currentSort.field === 'rank_oi' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('ohl')}>Open-High/Low {currentSort.field === 'ohl' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('present_oi')}>Present OI {currentSort.field === 'present_oi' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('yest_oi')}>Yesterday's OI {currentSort.field === 'yest_oi' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th onClick={() => handleSort('lotsize')}>Lot Size {currentSort.field === 'lotsize' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody>
                {rows.length === 0 ? (
                    <tr>
                        <td colSpan="23" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '50px' }}>
                            No instruments subscribed. Connect and add symbols.
                        </td>
                    </tr>
                ) : (
                    rows.map((row, i) => (
                        <tr key={row.key} id={`row-${row.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`} data-key={row.key}>
                            <td className="s-no">{i + 1}</td>
                            <td style={{ fontWeight: '600', textAlign: 'left' }} className={getProfitLossClass(row.change)}>{row.symbol}</td>
                            <td>{row.o !== '-' && row.pc !== '-' ? (parseFloat(row.lp) / (1 + (parseFloat(row.pc)/100))).toFixed(2) : '-'}</td>
                            <td>{row.o}</td>
                            <td>{row.h}</td>
                            <td>{row.l}</td>
                            <td style={{ fontWeight: 'bold' }} className={getProfitLossClass(row.change)}>{row.lp}</td>
                            <td className={getProfitLossClass(row.change)}>{row.change}</td>
                            <td className={getProfitLossBgClass(row.pc)}>{row.pc !== '-' ? row.pc + '%' : '-'}</td>
                            <td>{row.atr_14}</td>
                            <td>{row.avg_vol}</td>
                            <td>{row.v}</td>
                            <td>{row.chg_vol_pc}</td>
                            <td style={{ fontWeight: 'bold' }}>{row.rank_vol}</td>
                            <td>{row.rank_chg}</td>
                            <td>{row.rank_abs_chg}</td>
                            <td className={getProfitLossBgClass(row.near_oi_pc)}>{row.near_oi_pc !== '-' ? row.near_oi_pc + '%' : '-'}</td>
                            <td>{row.rank_oi}</td>
                            <td style={{ fontWeight: 'bold', textAlign: 'center' }} className={row.ohl === 'O=H' ? 'text-loss bg-loss-light' : (row.ohl === 'O=L' ? 'text-profit bg-profit-light' : '')}>{row.ohl}</td>
                            <td>{row.present_oi}</td>
                            <td>{row.yest_oi}</td>
                            <td style={{ textAlign: 'right', fontWeight: '600', color: 'var(--accent)' }}>{row.lotsize}</td>
                            <td className="trade-actions">
                                <button className="primary" onClick={(e) => handleActionT(e, row.key)}>T</button>
                            </td>
                        </tr>
                    ))
                )}
            </tbody>
        </table>
    );
}

// ----------------------------------------------------
// 3. FUTURES GRID (Stock Futures Tab + Filters + Advanced)
// ----------------------------------------------------
function FuturesGrid({ onFilterChange, onSortChange }) {
    const [rows, setRows] = React.useState([]);
    const [exch, setExch] = React.useState('');
    const [cat, setCat] = React.useState('');
    const [exp, setExp] = React.useState('');

    const [isAdvOpen, setIsAdvOpen] = React.useState(false);
    const [advFilters, setAdvFilters] = React.useState([
        { id: 'ff1', logic: '', field: '', op: '', val: '' },
        { id: 'ff2', logic: '', field: '', op: '', val: '' },
        { id: 'ff3', logic: '', field: '', op: '', val: '' },
        { id: 'ff4', logic: '', field: '', op: '', val: '' }
    ]);
    const [isFilterActive, setIsFilterActive] = React.useState(false);
    const [currentSort, setCurrentSort] = React.useState({ field: null, desc: false });

    React.useEffect(() => {
        return window.reactState.subscribeFutures(setRows);
    }, []);

    // Push filter changes to worker
    React.useEffect(() => {
        applyCombinedFilters();
    }, [exch, cat, exp]);

    const handleAdvFilterChange = (index, key, value) => {
        const updated = [...advFilters];
        updated[index][key] = value;
        setAdvFilters(updated);

        if (isFilterActive) {
            applyCombinedFilters(updated, true);
        }
    };

    const applyCombinedFilters = (advList = advFilters, advActive = isFilterActive) => {
        const filters = [];

        // Add main category/exchange filters
        if (exch !== 'ALL' && exch !== '') {
            filters.push({ logic: 'AND', field: 'exchange', op: '=', val: exch });
        }
        if (cat !== 'ALL' && cat !== '') {
            filters.push({ logic: 'AND', field: 'category', op: '=', val: cat });
        }
        if (exp !== 'ALL' && exp !== '') {
            filters.push({ logic: 'AND', field: 'expiry_type', op: '=', val: exp });
        }

        // Add advanced filters if active
        if (advActive) {
            advList.forEach(f => {
                if (f.val.trim() !== '' && f.field && f.op) {
                    filters.push({
                        logic: f.logic,
                        field: f.field,
                        op: f.op,
                        val: f.val.trim()
                    });
                }
            });
        }

        onFilterChange(filters);
    };

    const handleApplyAdv = () => {
        setIsFilterActive(true);
        applyCombinedFilters(advFilters, true);
    };

    const handleClearAdv = () => {
        setIsFilterActive(false);
        const cleared = advFilters.map(f => ({ ...f, val: '', logic: '', field: '', op: '' }));
        setAdvFilters(cleared);
        applyCombinedFilters(cleared, false);
    };

    const handleSort = (field) => {
        const desc = currentSort.field === field ? !currentSort.desc : false;
        setCurrentSort({ field, desc });
        onSortChange(field, desc);
    };

    const handleActionT = (e, key) => {
        e.stopPropagation();
        if (window.app && typeof window.app.setOrderContext === 'function') {
            window.app.setOrderContext(key);
        }
    };

    const getProfitLossClass = (val) => {
        const floatVal = parseFloat(val);
        if (isNaN(floatVal) || floatVal === 0) return '';
        return floatVal > 0 ? 'text-profit' : 'text-loss';
    };

    const getProfitLossBgClass = (val) => {
        const floatVal = parseFloat(val);
        if (isNaN(floatVal) || floatVal === 0) return '';
        return floatVal > 0 ? 'text-profit bg-profit-light' : 'text-loss bg-loss-light';
    };

    return (
        <div>
            {/* Toolbar */}
            <div style={{ marginBottom: '10px', padding: '10px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
                <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
                    <span style={{ fontWeight: '600', fontSize: '0.85rem', color: 'var(--accent)' }}>Main Filters:</span>
                    <select value={exch} onChange={(e) => setExch(e.target.value)} style={{ padding: '4px', fontSize: '0.85rem', width: 'auto' }}>
                        <option value="" disabled>Select</option>
                        <option value="ALL">All Exchanges</option>
                        <option value="NFO">NFO</option>
                        <option value="BFO">BFO</option>
                        <option value="MCX">MCX</option>
                        <option value="CDS">CDS</option>
                    </select>
                    <select value={cat} onChange={(e) => setCat(e.target.value)} style={{ padding: '4px', fontSize: '0.85rem', width: 'auto' }}>
                        <option value="" disabled>Select</option>
                        <option value="ALL">All Assets</option>
                        <option value="Index">Index</option>
                        <option value="Stocks">Stocks</option>
                        <option value="Others">Others</option>
                    </select>
                    <select value={exp} onChange={(e) => setExp(e.target.value)} style={{ padding: '4px', fontSize: '0.85rem', width: 'auto' }}>
                        <option value="" disabled>Select</option>
                        <option value="ALL">All Expiries</option>
                        <option value="Near">Near</option>
                        <option value="Next">Next</option>
                        <option value="Far">Far</option>
                    </select>
                    <button 
                        className="primary" 
                        onClick={() => setIsAdvOpen(!isAdvOpen)} 
                        style={{ padding: '6px 15px', fontSize: '0.85rem', width: 'auto', marginLeft: 'auto' }}
                    >
                        {isAdvOpen ? '- Advanced Filters' : '+ Advanced Filters'}
                    </button>
                </div>

                {isAdvOpen && (
                    <div style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '15px',
                        alignItems: 'center',
                        paddingTop: '15px',
                        marginTop: '10px',
                        borderTop: '1px solid var(--border-color)'
                    }}>
                        {advFilters.map((f, i) => (
                            <div key={f.id} style={{ display: 'flex', gap: '8px', alignItems: 'center', whiteSpace: 'nowrap' }}>
                                {f.id === 'ff1' ? (
                                    <span style={{ fontWeight: '600', fontSize: '0.85rem', color: 'var(--accent)' }}>Advanced:</span>
                                ) : (
                                    <select 
                                        value={f.logic}
                                        onChange={(e) => handleAdvFilterChange(i, 'logic', e.target.value)}
                                        style={{ width: '60px', padding: '4px', fontSize: '0.85rem' }}
                                    >
                                        <option value="" disabled>Select</option>
                                        <option value="AND">AND</option>
                                        <option value="OR">OR</option>
                                    </select>
                                )}
                                <select 
                                    value={f.field}
                                    onChange={(e) => handleAdvFilterChange(i, 'field', e.target.value)}
                                    style={{ width: '100px', padding: '4px', fontSize: '0.85rem' }}
                                >
                                    <option value="" disabled>Select</option>
                                    <option value="symbol">Name</option>
                                    <option value="lotsize">Lot Size</option>
                                    <option value="oi">OI</option>
                                    <option value="ltp">LTP</option>
                                    <option value="change">Change</option>
                                    <option value="pc">Chg%</option>
                                    <option value="strike_difference">Strike Diff</option>
                                </select>
                                <select 
                                    value={f.op}
                                    onChange={(e) => handleAdvFilterChange(i, 'op', e.target.value)}
                                    style={{ width: '60px', padding: '4px', fontSize: '0.85rem' }}
                                >
                                    <option value="" disabled>Select</option>
                                    <option value=">">&gt;</option>
                                    <option value="<">&lt;</option>
                                    <option value="=">=</option>
                                    <option value="contains">In</option>
                                </select>
                                <input 
                                    type="text" 
                                    value={f.val}
                                    placeholder="Value"
                                    onChange={(e) => handleAdvFilterChange(i, 'val', e.target.value)}
                                    style={{ width: '80px', padding: '4px', fontSize: '0.85rem' }}
                                />
                            </div>
                        ))}
                        <div style={{ display: 'flex', gap: '10px', marginLeft: 'auto' }}>
                            <button className="primary" style={{ padding: '6px 15px', fontSize: '0.85rem', width: 'auto' }} onClick={handleApplyAdv}>Apply</button>
                            <button style={{ padding: '6px 15px', fontSize: '0.85rem', width: 'auto' }} onClick={handleClearAdv}>Clear</button>
                        </div>
                    </div>
                )}
            </div>

            {/* Table */}
            <table className="excel-grid">
                <thead className="fno-header">
                    <tr style={{ cursor: 'pointer' }}>
                        <th>S.No</th>
                        <th onClick={() => handleSort('symbol')}>Name {currentSort.field === 'symbol' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                        <th onClick={() => handleSort('lotsize')} style={{ textAlign: 'right' }}>Lot Size {currentSort.field === 'lotsize' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                        <th onClick={() => handleSort('strike_difference')} style={{ textAlign: 'right' }}>Strike Diff {currentSort.field === 'strike_difference' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                        <th onClick={() => handleSort('expiry_date')} style={{ textAlign: 'center' }}>Expiry Date {currentSort.field === 'expiry_date' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                        <th onClick={() => handleSort('ltp')} style={{ textAlign: 'right' }}>LTP {currentSort.field === 'ltp' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                        <th onClick={() => handleSort('change')} style={{ textAlign: 'right' }}>Change {currentSort.field === 'change' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                        <th onClick={() => handleSort('pc')} style={{ textAlign: 'right' }}>Chg% {currentSort.field === 'pc' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                        <th onClick={() => handleSort('prev_close')} style={{ textAlign: 'right' }}>PrevClose {currentSort.field === 'prev_close' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                        <th onClick={() => handleSort('open')} style={{ textAlign: 'right' }}>Open {currentSort.field === 'open' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                        <th onClick={() => handleSort('high')} style={{ textAlign: 'right' }}>High {currentSort.field === 'high' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                        <th onClick={() => handleSort('low')} style={{ textAlign: 'right' }}>Low {currentSort.field === 'low' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                        <th onClick={() => handleSort('oi')} style={{ textAlign: 'right' }}>Change in OI in Fut {currentSort.field === 'oi' ? (currentSort.desc ? '↓' : '↑') : '↕'}</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.length === 0 ? (
                        <tr>
                            <td colSpan="14" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '50px' }}>
                                Loading Futures Data...
                            </td>
                        </tr>
                    ) : (
                        rows.map((row, i) => (
                            <tr key={row.key} id={`fut-row-${row.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`}>
                                <td className="s-no">{i + 1}</td>
                                <td style={{ fontWeight: '600', textAlign: 'left' }}>
                                    <div>{row.symbol} {row.expiry_type}</div>
                                    <small style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{row.expiry_date}</small>
                                </td>
                                <td style={{ textAlign: 'right' }}>{row.lotsize}</td>
                                <td style={{ textAlign: 'right' }}>{row.strike_difference ? row.strike_difference.toFixed(2) : '-'}</td>
                                <td style={{ textAlign: 'center' }}>{row.expiry_date}</td>
                                <td style={{ fontWeight: 'bold', textAlign: 'right' }} className={getProfitLossClass(row.change)}>
                                    {row.ltp > 0 ? row.ltp.toFixed(2) : '-'}
                                </td>
                                <td style={{ textAlign: 'right' }} className={getProfitLossBgClass(row.change)}>{row.change > 0 ? `+${row.change.toFixed(2)}` : row.change.toFixed(2)}</td>
                                <td style={{ textAlign: 'right' }} className={getProfitLossBgClass(row.pc)}>{row.pc ? row.pc.toFixed(2) + '%' : '-'}</td>
                                <td style={{ textAlign: 'right' }}>{row.prev_close > 0 ? row.prev_close.toFixed(2) : '-'}</td>
                                <td style={{ textAlign: 'right' }}>{row.open > 0 ? row.open.toFixed(2) : '-'}</td>
                                <td style={{ textAlign: 'right' }}>{row.high > 0 ? row.high.toFixed(2) : '-'}</td>
                                <td style={{ textAlign: 'right' }}>{row.low > 0 ? row.low.toFixed(2) : '-'}</td>
                                <td style={{ textAlign: 'right' }}>{row.oi || '-'}</td>
                                <td className="trade-actions">
                                    <button className="primary" onClick={(e) => handleActionT(e, row.key)}>T</button>
                                </td>
                            </tr>
                        ))
                    )}
                </tbody>
            </table>
        </div>
    );
}

// ----------------------------------------------------
// 4. MAIN WORKSPACE APP INITIALIZATION
// ----------------------------------------------------
window.mountReactApp = function(worker) {
    // Mount Control Panel
    const controlRoot = ReactDOM.createRoot(document.getElementById('react-control-panel-root'));
    controlRoot.render(e(ControlPanel, {
        onFilterChange: (parsedFilters, isFilterActive) => {
            // Update Web Worker filters
            worker.postMessage({ type: 'SET_FILTERS', data: parsedFilters });
            
            // Phase 3 Backend Vectorized Filtering
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({
                    type: 'SET_FILTER',
                    filters: parsedFilters
                }));
            }
        }
    }));

    // Mount Streaming Grid (FnO Stocks Table)
    const gridRoot = ReactDOM.createRoot(document.getElementById('react-streaming-grid-root'));
    gridRoot.render(e(StreamingGrid, {
        onSortChange: (field, desc) => {
            worker.postMessage({ type: 'SET_SORT', data: { field, desc } });
        }
    }));

    // Mount Futures Grid (Stock Futures Table)
    const futuresRoot = ReactDOM.createRoot(document.getElementById('react-futures-root'));
    futuresRoot.render(e(FuturesGrid, {
        onFilterChange: (filters) => {
            worker.postMessage({ type: 'SET_FUTURES_FILTERS', data: filters });
        },
        onSortChange: (field, desc) => {
            worker.postMessage({ type: 'SET_FUTURES_SORT', data: { field, desc } });
        }
    }));
};

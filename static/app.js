const HOST_BASE = (typeof window !== 'undefined' && window.location && window.location.host) ? window.location.host : '127.0.0.1:8095';
const API_BASE = `${(typeof window !== 'undefined' && window.location && window.location.protocol === 'https:') ? 'https:' : 'http:'}//${HOST_BASE}/api`;
let ws = null;

function shortenBrokerMessage(msg) {
    if (!msg) return '';
    let shortMsg = msg.replace(/^RMS:Rule:\s*/i, '').replace(/^RMS:\s*/i, '');
    shortMsg = shortMsg.replace(/for client:?\s*[A-Z0-9]+/i, '').replace(/for client\s*[A-Z0-9]+/i, '');
    shortMsg = shortMsg.replace(/\s+/g, ' ').trim();
    return shortMsg.length > 50 ? shortMsg.slice(0, 47) + '...' : shortMsg;
}

const app = {
    state: {
        liveData: {},
        pendingOrderUpdates: {},
        positions: [],
        orders: [],
        masterData: [],
        activeToken: null, // for fast order placement row selection
        isFilterActive: false,
        cachedActiveFields: [],
        sortField: null,
        sortDesc: false,
        rankSortAsc: true,       // A = ascending (default), D = descending
        tradeReadyRows: [],
        tradeNowRows: [],
        trSortField: null,
        trSortDesc: true,
        tradeExitRows: [],
        terminalRows: [],
        terminalColumns: [
            { id: 'sno', label: 'S.No', width: '45px' },
            { id: 'index_exch', label: 'Index', width: '75px' },
            { id: 'instrument', label: 'Instrument', width: '130px' },
            { id: 'type', label: 'TYPE', width: '70px' },
            { id: 'expiry', label: 'EXPIRY', width: '95px' },
            { id: 'strike', label: 'Strike', width: '80px' },
            { id: 'symbol', label: 'Mapped Symbol', width: '140px' },
            { id: 'best_buy', label: 'Best Buy', width: '85px' },
            { id: 'best_sell', label: 'Best Sell', width: '85px' },
            { id: 'high', label: 'High', width: '80px' },
            { id: 'low', label: 'Low', width: '80px' },
            { id: 'ltp', label: 'LTP', width: '80px' },
            { id: 'change', label: 'Change', width: '75px' },
            { id: 'change_pc', label: '% change', width: '80px' },
            { id: 'volume', label: 'Volume', width: '90px' },
            { id: 'qty', label: 'Qty', width: '65px' },
            { id: 'side', label: 'BUY/SELL', width: '85px' },
            { id: 'signal', label: 'Entry Signal', width: '95px' },
            { id: 'limit_price', label: 'Entry Limit Price', width: '100px' },
            { id: 'entry_done', label: 'Entry Done @', width: '90px' },
            { id: 'order_id', label: 'Entry Order ID', width: '110px' },
            { id: 'remarks', label: 'Entry Remarks', width: '110px' },
            { id: 'entry_at', label: 'Entry @', width: '80px' },
            { id: 'status', label: 'Status', width: '85px' },
            { id: 'chg2entry', label: 'Chg2Etry', width: '80px' },
            { id: 'chg2entry_pc', label: '% Chg2Etry', width: '85px' },
            { id: 'tot_profit', label: 'Tot Profit', width: '90px' },
            { id: 'target', label: 'Target(₹)', width: '80px' },
            { id: 'tgt_price', label: 'Tgt Price', width: '80px' },
            { id: 'sl_type', label: 'SL Type', width: '85px' },
            { id: 'sl_value', label: 'SL Val(₹)', width: '80px' },
            { id: 'tsl', label: 'TSL', width: '55px' },
            { id: 'sl2cost', label: 'SL2Cost(₹)', width: '85px' },
            { id: 'add_exit', label: 'Add/Exit', width: '85px' },
            { id: 'exit_action', label: 'Exit Action', width: '95px' },
            { id: 'exit_limit', label: 'Limit Price', width: '85px' },
            { id: 'initial_sl', label: 'Initial SL', width: '80px' },
            { id: 'latest_sl', label: 'Latest SL', width: '80px' },
            { id: 'exit_at', label: 'Exit @.', width: '80px' },
            { id: 'cancel', label: 'Cancel', width: '60px' },
            { id: 'action', label: 'Action', width: '85px' }
        ],
        masterDataMap: null,
        masterDataSymbolMap: null,
        futuresDataKeyMap: null,
        futuresDataSymbolExpiryMap: null,
        domCache: {}
    },


    async init() {
        this.switchTab('live-data');
        this.setTradeMode('PAPER');
        
        // Always enforce canonical columns starting from 2nd position (Index, Instrument, TYPE, EXPIRY, Strike)
        const savedOrder = localStorage.getItem('terminal_column_order');
        if (savedOrder) {
            try {
                const ids = JSON.parse(savedOrder);
                const canonicalPrefix = ['sno', 'index_exch', 'instrument', 'type', 'expiry', 'strike', 'symbol'];
                const hasCanonical = canonicalPrefix.every(id => ids.includes(id));
                if (!hasCanonical) {
                    localStorage.removeItem('terminal_column_order');
                } else {
                    const columnsMap = {};
                    this.state.terminalColumns.forEach(c => columnsMap[c.id] = c);
                    const orderedCols = [];
                    ids.forEach(id => {
                        if (columnsMap[id]) {
                            orderedCols.push(columnsMap[id]);
                            delete columnsMap[id];
                        }
                    });
                    Object.values(columnsMap).forEach(c => orderedCols.push(c));
                    this.state.terminalColumns = orderedCols;
                }
            } catch (e) {
                console.error("Failed to restore column order", e);
            }
        }
        
        // Restore column widths from localStorage if it exists
        const savedWidths = localStorage.getItem('terminal_column_widths');
        if (savedWidths) {
            try {
                const widthsMap = JSON.parse(savedWidths);
                this.state.terminalColumns.forEach(col => {
                    if (widthsMap[col.id]) {
                        col.width = widthsMap[col.id];
                    }
                });
            } catch (e) {
                console.error("Failed to restore column widths", e);
            }
        }
        
        // Add a default row to terminal if empty
        if (this.state.terminalRows.length === 0) {
            this.addTerminalRow();
        }

        // Always show the landing home page on startup/reload (as requested)
        this.showLandingHome();
    },

    _startLoginPoller() {
        // Show a "waiting" indicator on the login panel
        const panel = document.getElementById('login-panel');
        if (panel) {
            let waiting = panel.querySelector('#login-waiting-msg');
            if (!waiting) {
                waiting = document.createElement('div');
                waiting.id = 'login-waiting-msg';
                waiting.style.cssText = 'margin-top:12px; text-align:center; font-size:0.85rem; color:var(--accent);';
                waiting.innerHTML = '⏳ Auto-login in progress...<br><small style="color:var(--text-secondary)">Waiting for server authentication</small>';
                panel.appendChild(waiting);
            }
        }

        // Each page load gets its own poll timer (no shared state across reloads)
        if (this._loginPollTimer) clearInterval(this._loginPollTimer);
        this._loginPollTimer = setInterval(async () => {
            try {
                const res  = await fetch(`${API_BASE}/status`);
                const data = await res.json();
                if (data.logged_in) {
                    clearInterval(this._loginPollTimer);
                    this._loginPollTimer = null;
                    await this._onLoginSuccess();
                }
            } catch(e) { /* server not up yet, keep polling */ }
        }, 1000); // check every 1 second for faster response
    },

    async _onLoginSuccess() {
        if (this._loginDone) return; // prevent double-init
        this._loginDone = true;

        // ── 1. Hide login panel FIRST (before anything else can fail) ──────────
        const panel = document.getElementById('login-panel');
        if (panel) panel.style.display = 'none';
        const msg = document.getElementById('login-waiting-msg');
        if (msg) msg.remove();

        this.notify('✅ Logged in! Loading trading data...', 'success');

        // Dynamically sync and update active broker badge on startup/login success
        try {
            const resStatus = await fetch(`${API_BASE}/status`);
            const statusData = await resStatus.json();
            if (statusData.active_broker) {
                const actB = statusData.active_broker.toUpperCase();
                this.state.activeBroker = actB;
                sessionStorage.setItem('broker_selected', actB);
                this.updateBrokerBadge(actB, statusData.is_running, statusData.is_running ? 'RUNNING' : 'NOT CONNECTED');
                const sel = document.getElementById('global-broker-select');
                if (sel) sel.value = actB;
            }
        } catch(e) { console.error('Failed to sync broker badge on init:', e); }

        // ── 2. Initialize Web Worker ─────────────────────────────────────────
        try {
            if (!this.worker) {
                this.worker = new Worker('worker.js');
                this.worker.onmessage = (e) => this.handleWorkerMessage(e);
            }
        } catch(e) { console.error('Worker init failed:', e); }

        // ── 3. Mount React components ─────────────────────────────────────────
        try {
            if (window.mountReactApp) {
                window.mountReactApp(this.worker);
            } else {
                const interval = setInterval(() => {
                    if (window.mountReactApp) {
                        window.mountReactApp(this.worker);
                        clearInterval(interval);
                    }
                }, 50);
            }
        } catch(e) { console.error('React mount failed:', e); }

        // ── 4. Connect and load data ──────────────────────────────────────────
        try { this.connectWebSocket(); } catch(e) { console.error('WS connect failed:', e); }
        try { this.loadMasterData(); }   catch(e) { console.error('Master data load failed:', e); }
        try { this.loadFuturesData(); }  catch(e) { console.error('Futures data load failed:', e); }
        try { this.refreshPositions(); } catch(e) { console.error('Positions load failed:', e); }
    },



    async setTradeMode(mode) {
        try {
            const btnPaper = document.getElementById('btn-paper-mode');
            const btnReal  = document.getElementById('btn-real-mode');
            const activeStyle = "background: var(--profit); color: #fff;";
            const inactiveStyle = "background: rgba(255,255,255,0.1); color: var(--text-primary);";

            const res = await fetch(`${API_BASE}/set_trade_mode`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ mode: mode })
            });

            if(res.ok) {
                this.state.tradeMode = mode;
                if(mode === 'PAPER') {
                    if(btnPaper) btnPaper.style.cssText = `padding:4px 12px; border:none; font-size:12px; border-right:1px solid var(--border-color); cursor:pointer; font-weight:bold; ${activeStyle}`;
                    if(btnReal) btnReal.style.cssText = `padding:4px 12px; border:none; font-size:12px; cursor:pointer; font-weight:bold; ${inactiveStyle}`;
                    this.notify("Paper Activated! Trading is in paper mode only.", "success");
                } else {
                    if(btnPaper) btnPaper.style.cssText = `padding:4px 12px; border:none; font-size:12px; border-right:1px solid var(--border-color); cursor:pointer; font-weight:bold; ${inactiveStyle}`;
                    if(btnReal) btnReal.style.cssText = `padding:4px 12px; border:none; font-size:12px; cursor:pointer; font-weight:bold; ${activeStyle}`;
                    this.notify("Real Trade Mode Activated! Placing Real Trades.", "success");
                }
            }
        } catch(e) { console.error("Mode switch failed", e); }
    },

    async changeBroker(brokerName) {
        const targetBroker = (brokerName || 'FLATTRADE').toUpperCase();
        const currentBroker = (this.state.activeBroker || sessionStorage.getItem('broker_selected') || '').toUpperCase();

        try {
            // 1. Notify Previous Broker Logout if switching
            if (currentBroker && currentBroker !== targetBroker) {
                this.notify(`${currentBroker} Logout`, "info");
            }

            // 2. Clear UI data state on broker switch
            this.clearCurrentBrokerData();

            // 3. Notify Connecting
            this.notify(`${targetBroker} Connecting...`, "info");
            this.updateBrokerBadge(targetBroker, false, 'CONNECTING...');

            // 4. Submit broker selection request
            const res = await fetch(`${API_BASE}/select_broker/${brokerName}`, { method: 'POST' });
            const data = await res.json();

            if (data.already_connected) {
                this.state.activeBroker = targetBroker;
                sessionStorage.setItem('broker_selected', targetBroker);
                this.updateBrokerBadge(targetBroker, true, 'RUNNING');
                this.notify(`Already connected to ${targetBroker} Broker`, "info");
                
                const panel = document.getElementById('login-panel');
                if (panel) panel.style.display = 'none';
                await this._onLoginSuccess();
                return;
            }

            if (data.status === 'auth_required' && data.auth_url) {
                this.updateBrokerBadge(targetBroker, false, 'AUTHENTICATING...');
                this.notify(`Automated background authorization for ${targetBroker} in progress...`, 'info');
                sessionStorage.setItem('broker_selected', targetBroker);
                
                let attempts = 0;
                const pollInterval = setInterval(async () => {
                    attempts++;
                    try {
                        const stRes = await fetch(`${API_BASE}/status`);
                        const stData = await stRes.json();
                        if (stData.is_running && (stData.active_broker === targetBroker || stData.active_broker === brokerName)) {
                            clearInterval(pollInterval);
                            this.state.activeBroker = targetBroker;
                            this.updateBrokerBadge(targetBroker, true, 'RUNNING');
                            this.notify(`${targetBroker} Connected & Live!`, "success");
                            const panel = document.getElementById('login-panel');
                            if (panel) panel.style.display = 'none';
                            await this._onLoginSuccess();
                        } else if (attempts > 15) {
                            clearInterval(pollInterval);
                            this.updateBrokerBadge(targetBroker, false, 'AUTH REQUIRED');
                            window.open(data.auth_url, '_blank');
                        }
                    } catch(ex) {
                        console.warn("Status poll info:", ex);
                    }
                }, 2000);
                return;
            }

            if (data.status === 'success' && data.is_running) {
                this.state.activeBroker = data.active || targetBroker;
                sessionStorage.setItem('broker_selected', this.state.activeBroker);
                this.updateBrokerBadge(this.state.activeBroker, true, 'RUNNING');
                this.notify(`${this.state.activeBroker} Running`, "success");

                const panel = document.getElementById('login-panel');
                if (panel) panel.style.display = 'none';
                await this._onLoginSuccess();
            } else {
                this.updateBrokerBadge(targetBroker, false, 'NOT CONNECTED');
                this.notify(`Not Connected - ${data.message || 'Connection failed'}`, "error");
            }
        } catch(e) {
            console.error("Broker switch failed", e);
            this.updateBrokerBadge(targetBroker, false, 'NOT CONNECTED');
            this.notify(`Not Connected - ${e.message}`, "error");
        }
    },

    clearCurrentBrokerData() {
        if (this.state) {
            this.state.positions = [];
            this.state.orders = [];
        }
        if (typeof this.renderPositions === 'function') this.renderPositions();
        if (typeof this.renderOrders === 'function') this.renderOrders();
    },

    updateBrokerBadge(brokerName, isRunning, statusText) {
        const textEl = document.getElementById('broker-badge-text');
        const dotEl = document.getElementById('broker-badge-dot');
        const badgeContainer = document.getElementById('broker-status-badge');

        const bName = (brokerName || 'NOT CONNECTED').toUpperCase();
        let stateStr = statusText;
        if (!stateStr) {
            stateStr = isRunning ? 'RUNNING' : 'NOT CONNECTED';
        }

        if (textEl) textEl.innerText = `${bName}: ${stateStr}`;
        if (dotEl) {
            if (isRunning) {
                dotEl.style.background = '#22c55e'; // Green
            } else if (stateStr.includes('CONNECTING')) {
                dotEl.style.background = '#f59e0b'; // Amber
            } else {
                dotEl.style.background = '#ef4444'; // Red
            }
        }
        if (badgeContainer) {
            if (isRunning) {
                badgeContainer.style.borderColor = 'rgba(34,197,94,0.4)';
                badgeContainer.style.color = '#4ade80';
                badgeContainer.style.background = 'rgba(34,197,94,0.12)';
            } else if (stateStr.includes('CONNECTING')) {
                badgeContainer.style.borderColor = 'rgba(245,158,11,0.4)';
                badgeContainer.style.color = '#f59e0b';
                badgeContainer.style.background = 'rgba(245,158,11,0.12)';
            } else {
                badgeContainer.style.borderColor = 'rgba(239,68,68,0.4)';
                badgeContainer.style.color = '#ef4444';
                badgeContainer.style.background = 'rgba(239,68,68,0.12)';
            }
        }
    },

    selectBrokerModal(brokerName) {
        const modal = document.getElementById('broker-selection-modal');
        if(modal) modal.style.display = 'none';
        
        sessionStorage.setItem('broker_selected', brokerName);
        const sel = document.getElementById('global-broker-select');
        if(sel) sel.value = brokerName;
        
        this.changeBroker(brokerName);
    },

    showLandingHome() {
        const landing = document.getElementById('landing-home-page');
        if (landing) {
            landing.style.display = 'flex';
            landing.style.opacity = '1';
        }
    },

    async launchBroker(brokerName) {
        if (brokerName === 'PAPER') {
            await this.setTradeMode('PAPER');
        } else {
            const sel = document.getElementById('global-broker-select');
            if (sel) sel.value = brokerName;
            await this.changeBroker(brokerName);
        }

        const landing = document.getElementById('landing-home-page');
        if (landing) {
            landing.style.opacity = '0';
            landing.style.transition = 'opacity 0.3s ease';
            setTimeout(() => {
                landing.style.display = 'none';
            }, 300);
        }
    },

    async refreshGoogleData() {
        try {
            this.notify("Refreshing 14D Historical Metrics via Flattrade...", "info");
            const btn = document.getElementById('btn-refresh-google');
            if(btn) {
                btn.disabled = true;
                btn.innerText = "🔄 Refreshing...";
            }
            const res = await fetch(`${API_BASE}/refresh_historical_data`, { method: 'POST' });
            const data = await res.json();
            if(btn) {
                btn.disabled = false;
                btn.innerText = "🔄 Refresh 14D Metrics";
            }
            if(data.status === 'success') {
                this.notify("14D Historical Metrics refreshed. Reloading tables...", "success");
                await this.loadMasterData();
            } else {
                this.notify("Failed to refresh: " + data.message, "error");
            }
        } catch(e) {
            this.notify("Error refreshing historical metrics", "error");
            const btn = document.getElementById('btn-refresh-google');
            if(btn) {
                btn.disabled = false;
                btn.innerText = "🔄 Refresh 14D Metrics";
            }
        }
    },

    async login() {
        const userid     = document.getElementById('userid').value;
        const password   = document.getElementById('password').value;
        const totp_key   = document.getElementById('totp').value;
        const vendor_code= document.getElementById('vendor').value;
        const api_secret = document.getElementById('secret').value;

        if (!userid || !password || !vendor_code) {
            this.notify('Please fill all required credentials', 'error');
            return;
        }

        const btn = document.querySelector('#login-panel button');
        btn.innerText = 'Connecting...';
        btn.disabled = true;

        try {
            const res  = await fetch(`${API_BASE}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userid, password, totp_key, vendor_code, api_secret })
            });
            const data = await res.json();

            if (data.status === 'success') {
                // Stop any polling loop that may be running
                if (this._loginPollTimer) {
                    clearInterval(this._loginPollTimer);
                    this._loginPollTimer = null;
                }
                await this._onLoginSuccess();
            } else {
                this.notify(data.message, 'error');
            }
        } catch (e) {
            this.notify('Connection to backend failed.', 'error');
        } finally {
            btn.innerText = 'Connect to Shoonya';

            btn.disabled = false;
        }
    },

    connectWebSocket() {
        const wsProto = (typeof window !== 'undefined' && window.location && window.location.protocol === 'https:') ? 'wss:' : 'ws:';
        const wsHost = (typeof window !== 'undefined' && window.location && window.location.host) ? window.location.host : '127.0.0.1:8095';
        ws = new WebSocket(`${wsProto}//${wsHost}/ws`);
        
        ws.onopen = () => {
            const dot = document.getElementById('socket-status');
            const txt = document.getElementById('socket-text');
            if(dot) dot.classList.add('connected');
            if(txt) txt.innerText = "Connected";
            
            // Re-subscribe to all active symbols on socket open/reconnect
            try { this.resubscribeAll(); } catch(e) { console.error('Re-subscribe failed:', e); }
        };

        ws.onclose = () => {
            const dot = document.getElementById('socket-status');
            const txt = document.getElementById('socket-text');
            if(dot) dot.classList.remove('connected');
            if(txt) txt.innerText = "Disconnected - Retrying...";
            setTimeout(() => this.connectWebSocket(), 3000);
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if(msg.type === "QUOTE_UPDATE") {
                this.state.liveData[msg.data.key] = msg.data;
                if (this.worker) {
                    this.worker.postMessage({ type: 'TICK_BATCH', data: [msg.data] });
                }
                this.updateQuote(msg.data.key, msg.data);
                this.updateTerminalRowQuotes(msg.data.key, msg.data);
                (this.state.tradeExitRows||[]).forEach((_,i) => this.evaluateTradeExit(i));
                (this.state.terminalRows||[]).forEach((_,i) => this.evaluateTerminalExit(i));
                this.evaluateOverallTarget();
                this.addModalLiveUpdate();  // keep Add modal price strip live
            } else if(msg.type === "BATCH_QUOTE_UPDATE") {
                msg.data.forEach(quote => {
                    this.state.liveData[quote.key] = quote;
                });
                if (this.worker) {
                    this.worker.postMessage({ type: 'TICK_BATCH', data: msg.data });
                }
                msg.data.forEach(quote => {
                    this.updateQuote(quote.key, quote);
                    this.updateTerminalRowQuotes(quote.key, quote);
                });
                (this.state.tradeExitRows||[]).forEach((_,i) => this.evaluateTradeExit(i));
                (this.state.terminalRows||[]).forEach((_,i) => this.evaluateTerminalExit(i));
                this.evaluateOverallTarget();
                this.addModalLiveUpdate();  // keep Add modal price strip live
            } else if (msg.type === "SYSTEM_MSG") {
                this.notify(msg.data, "success");
            } else if (msg.type === "ORDER_UPDATE") {
                const od = msg.data;
                const orderId = od.norenordno || od.ordno;
                this.state.pendingOrderUpdates[orderId] = od;
                this.applyOrderUpdate(od);
                this.refreshOrders();
            }
        };
    },

    resubscribeAll() {
        const subs = [];

        // 1. Spot symbols from masterData
        if (this.state.masterData) {
            this.state.masterData.forEach(d => {
                subs.push(`${d.exchange}|${d.tradingsymbol}`);
            });
        }

        // Index ticker symbols
        ['NSE|26000', 'NSE|26009', 'BSE|1', 'BSE|12', 'NSE|26017'].forEach(idx => {
            if(!subs.includes(idx)) subs.push(idx);
        });

        // 2. Future symbols
        if (this.state.masterData && this.state.futuresData) {
            const targetExpiry = this.state.globalExpiry || 'Near';
            this.state.masterData.forEach(mr => {
                const targetFut = this.state.futuresDataSymbolExpiryMap ? this.state.futuresDataSymbolExpiryMap[`${mr.symbol}|${targetExpiry}`] : null;
                if (targetFut) {
                    const key = `${targetFut.exchange}|${targetFut.tradingsymbol}`;
                    if (!subs.includes(key)) subs.push(key);
                }
            });
        }

        // 3. Option symbols from tradeNowRows (Trade Entry tab)
        if (this.state.tradeNowRows) {
            const hedgeOffset = parseInt(document.getElementById('tn-hedge-offset')?.value) || 1;
            this.state.tradeNowRows.forEach(item => {
                const { exchange, baseSymbol, expiryTag, atmStrike, strikeDiff } = item;
                ['CE','PE'].forEach(type => {
                    const key = `${exchange}|${this.buildOptionSymbol(baseSymbol, expiryTag, type, atmStrike)}`;
                    if (!subs.includes(key)) subs.push(key);
                    if(strikeDiff > 0) {
                        const hStrike = this.getHedgeStrike(item, type, hedgeOffset);
                        const hKey = `${exchange}|${this.buildOptionSymbol(baseSymbol, expiryTag, type, hStrike)}`;
                        if (!subs.includes(hKey)) subs.push(hKey);
                    }
                });
            });
        }

        // 4. Trade Exit position option symbols
        if (this.state.tradeExitRows) {
            this.state.tradeExitRows.forEach(item => {
                if (item.optKey && !subs.includes(item.optKey)) {
                    subs.push(item.optKey);
                }
            });
        }

        // 5. Trade Terminal resolved symbols
        if (this.state.terminalRows) {
            this.state.terminalRows.forEach(item => {
                if (item.resolvedSymbol && item.exchange) {
                    const key = `${item.exchange}|${item.resolvedSymbol}`;
                    if (!subs.includes(key)) subs.push(key);
                }
            });
        }

        if (subs.length > 0) {
            console.log(`Re-subscribing to ${subs.length} symbols on connection open...`);
            fetch(`${API_BASE}/subscribe_bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbols: subs })
            }).catch(e => console.error("Re-subscribe bulk request failed", e));
        }
    },

    applyOrderUpdate(od) {
        if (!od) return;
        const orderId = od.norenordno || od.ordno;
        const status = (od.status || od.nstatus || '').toUpperCase();
        const avgprc = parseFloat(od.avgprc || od.price || 0);
        const tsym = od.tsym || od.symbol || 'order';
        const rejreasonRaw = od.rejreason || od.reason || '';
        const rejreason = shortenBrokerMessage(rejreasonRaw);
        const filledQty = od.filledqty ? parseInt(od.filledqty) : null;

        // Update Trade Entry rows matching this order
        const rowMatch = (this.state.tradeNowRows||[]).find(r => r.mainOrderId === orderId || r.hedgeOrderId === orderId);
        if (rowMatch) {
            const statusStr = status === 'COMPLETE' ? 'Active' : ((status === 'REJECTED' || status === 'REJECT') ? 'Rejected' : ((status === 'CANCELED' || status === 'CANCELLED') ? 'Canceled' : 'Pending'));
            const remarksText = status === 'COMPLETE' ? 'Active @ ' + avgprc : ((status === 'REJECTED' || status === 'REJECT') ? rejreason : status);
            
            if (rowMatch.mainOrderId === orderId) {
                rowMatch.mainStatus = statusStr;
                if (status === 'COMPLETE' && avgprc > 0) {
                    rowMatch.mainDoneAt = avgprc;
                }
                rowMatch.mainRemarks = remarksText;
            } else {
                rowMatch.hedgeStatus = statusStr;
                if (status === 'COMPLETE' && avgprc > 0) {
                    rowMatch.hedgeDoneAt = avgprc;
                }
                rowMatch.hedgeRemarks = remarksText;
            }
            this.renderTradeNowTable();
        }
        
        // Update normal Trade Exit position rows (Entry or Add order matching)
        const idx = (this.state.tradeExitRows||[]).findIndex(r => r.orderId === orderId);
        if(idx !== -1) {
            const row = this.state.tradeExitRows[idx];
            
            if (status === 'COMPLETE' && avgprc > 0) {
                row.status = 'Active';
                
                const isNewPosition = (row.lastAddedQty === 0 || row.entryAt === 0);
                const orderQty = isNewPosition ? row.qty : (row.lastAddedQty || 0);
                const prevQty = isNewPosition ? 0 : (row.qty - orderQty);
                const actualFilled = (filledQty !== null && !isNaN(filledQty)) ? filledQty : orderQty;
                
                row.qty = prevQty + actualFilled;
                row.entryAt = parseFloat(((row.entryAt * prevQty + avgprc * actualFilled) / row.qty).toFixed(2));
                row.lastAddedQty = 0;
                
                // Recompute initialSL now that actual entry price is known
                if (row.slValue !== '' && row.slType !== '' && row.slType !== 'No SL') {
                    row.initialSL = this.computeInitialSLPrice(row);
                    if (row.latestSL === '') row.latestSL = row.initialSL;
                }
            } else if (status === 'REJECTED' || status === 'REJECT' || status === 'CANCELED' || status === 'CANCELLED') {
                // Roll back any pending add-qty first
                if (row.lastAddedQty > 0) {
                    row.qty -= row.lastAddedQty;
                    row.lastAddedQty = 0;
                }
                if (row.qty > 0 && row.entryAt > 0) {
                    // Had a prior fill — restore to Active, don't pollute the table
                    row.status = 'Active';
                } else {
                    // Never filled at all — remove the row entirely so Trade Exit stays clean
                    this.state.tradeExitRows.splice(idx, 1);
                    this.renderTradeExitTable();
                    return;
                }
            } else {
                row.status = 'Pending';
            }
            
            const sk = (row.optKey||'').replace(/[^a-zA-Z0-9_-]/g,'_');
            const prefix = row.isHedge ? 'hedge' : 'main';
            const rem = document.getElementById('te-remarks-' + prefix + '-' + sk);
            if(rem){ 
                if(row.status === 'Active'){
                    rem.innerText = 'Active @ ' + row.entryAt;
                    rem.style.color = 'var(--profit)';
                } else if(row.status === 'Rejected'){
                    rem.innerText = rejreason;
                    rem.style.color = 'var(--loss)';
                } else {
                    rem.innerText = row.status;
                    rem.style.color = 'var(--accent)';
                }
            }
            this.renderTradeExitTable();
        }

        // Update Trade Exit rows when an EXIT order updates
        const exitIdx = (this.state.tradeExitRows||[]).findIndex(r => r.exitOrderId === orderId);
        if(exitIdx !== -1) {
            const row = this.state.tradeExitRows[exitIdx];
            if (status === 'COMPLETE') {
                row.status = 'Closed';
                if (avgprc > 0) row.exitAt = avgprc.toFixed(2);
                this.notify(`${row.symbol} position CLOSED @ ${row.exitAt}`, 'success');
            } else if (status === 'REJECTED' || status === 'REJECT' || status === 'CANCELED' || status === 'CANCELLED') {
                row.status = 'Active';
                row.exitAt = '';
                row.exitOrderId = '';
                this.notify(`${row.symbol} exit order ${status}: ${rejreason || 'Reverted to Active'}`, 'error');
            }
            this.renderTradeExitTable();
        }
        
        // Update Trade Terminal rows matching this order (Entry order matching)
        const tidx = (this.state.terminalRows||[]).findIndex(r => r.entryOrderId === orderId);
        if(tidx !== -1) {
            const row = this.state.terminalRows[tidx];
 
            if (status === 'COMPLETE' && avgprc > 0) {
                row.status = 'Active';
                
                const isNewPosition = (row.lastAddedQty === 0 || row.entryAt === 0);
                const orderQty = isNewPosition ? (parseInt(row.qty) || 0) : (row.lastAddedQty || 0);
                const prevQty = isNewPosition ? 0 : ((parseInt(row.qty) || 0) - orderQty);
                const actualFilled = (filledQty !== null && !isNaN(filledQty)) ? filledQty : orderQty;
                
                row.qty = prevQty + actualFilled;
                row.entryAt = parseFloat(((row.entryAt * prevQty + avgprc * actualFilled) / row.qty).toFixed(2));
                
                row.entryDoneAt = avgprc;
                row.lastAddedQty = 0;
                // Recompute SL from actual fill price (same as Trade Exit)
                if (row.slValue !== '' && row.slType !== '' && row.slType !== 'No SL') {
                    row.initialSL = this.computeInitialSLPrice(row);
                    if (row.latestSL === '') row.latestSL = row.initialSL;
                }
                row.entryRemarks = 'Active @ ' + row.entryAt;
            } else if (status === 'REJECTED' || status === 'REJECT' || status === 'CANCELED' || status === 'CANCELLED') {
                // Roll back any pending add-qty first
                if (row.lastAddedQty > 0) {
                    row.qty = (parseInt(row.qty) || 0) - row.lastAddedQty;
                    row.lastAddedQty = 0;
                }
                if (row.qty > 0 && row.entryAt > 0) {
                    // Had a prior fill — restore to Active
                    row.status = 'Active';
                    row.entryRemarks = 'Active @ ' + row.entryAt;
                } else {
                    // Never filled — remove entirely so Terminal stays clean
                    this.state.terminalRows.splice(tidx, 1);
                    this.renderTerminalTable();
                    return;
                }
            } else {
                row.status = 'Pending';
                row.entryRemarks = status;
            }
            this.renderTerminalTable();
        }

        // Update Trade Terminal rows when an EXIT order updates
        const termExitIdx = (this.state.terminalRows||[]).findIndex(r => r.exitOrderId === orderId);
        if(termExitIdx !== -1) {
            const row = this.state.terminalRows[termExitIdx];
            if (status === 'COMPLETE') {
                row.status = 'Closed';
                if (avgprc > 0) row.exitAt = avgprc.toFixed(2);
                row.entryRemarks = 'Closed @ ' + row.exitAt;
                this.notify(`${row.resolvedSymbol || row.symbol} position CLOSED @ ${row.exitAt}`, 'success');
            } else if (status === 'REJECTED' || status === 'REJECT' || status === 'CANCELED' || status === 'CANCELLED') {
                row.status = 'Active';
                row.exitAt = '';
                row.exitOrderId = '';
                row.entryRemarks = 'Active @ ' + row.entryAt;
                this.notify(`${row.resolvedSymbol || row.symbol} exit order ${status}: ${rejreason || 'Reverted to Active'}`, 'error');
            }
            this.renderTerminalTable();
        }
    },
 
    getDomElement(id) {
        if (!this.state.domCache) this.state.domCache = {};
        // Never cache null — re-query each tick until the element exists in the DOM
        if (!this.state.domCache[id]) {
            const el = document.getElementById(id);
            if (el) this.state.domCache[id] = el;
            return el;
        }
        return this.state.domCache[id];
    },

    clearDomCache() {
        this.state.domCache = {};
    },

    async loadMasterData() {
        try {
            const res = await fetch(`${API_BASE}/fno_master_data`);
            const data = await res.json();
            if(data.status === 'success') {
                this.state.masterData = data.data;
                this.state.masterDataMap = {};
                this.state.masterDataSymbolMap = {};
                this.state.masterData.forEach(row => {
                    this.state.masterDataMap[`${row.exchange}|${row.tradingsymbol}`] = row;
                    this.state.masterDataSymbolMap[row.symbol] = row;
                });
                if (this.worker) {
                    this.worker.postMessage({ type: 'INIT_MASTER', data: data.data });
                }
                
                // Auto subscribe to all spot rows to initiate live feed immediately
                const subs = this.state.masterData.map(d => `${d.exchange}|${d.tradingsymbol}`);
                
                // Ensure index ticker symbols are subscribed
                ['NSE|26000', 'NSE|26009', 'BSE|1', 'BSE|12', 'NSE|26017'].forEach(idx => {
                    if(!subs.includes(idx)) subs.push(idx);
                });

                fetch(`${API_BASE}/subscribe_bulk`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ symbols: subs })
                }).catch(e => console.error("Bulk subscribe error", e));

                // If futuresData is already loaded, subscribe to the target expiry futures now
                if (this.state.futuresData) {
                    this.subscribeTargetFutures();
                }

                // Re-render the master table so ATR and Avg Vol columns reflect fresh Google Sheet data
                this.renderMasterTable();
                // Replay existing live ticks so the LTP/Volume/Change columns stay populated
                if (this.state.liveData) {
                    Object.keys(this.state.liveData).forEach(k => this.updateQuote(k, this.state.liveData[k]));
                }
                // If a filter is active, re-apply it after re-render
                if (this.state.isFilterActive) this.runFilterLogic();
            }
        } catch(e) { console.error("Failed to load master data", e); }
    },

    async loadFuturesData() {
        try {
            const res = await fetch(`${API_BASE}/futures_with_prices`);
            const data = await res.json();
            if(data.status === 'success') {
                this.state.futuresData = data.data;
                this.state.futuresDataKeyMap = {};
                this.state.futuresDataSymbolExpiryMap = {};
                this.state.futuresData.forEach(f => {
                    this.state.futuresDataKeyMap[`${f.exchange}|${f.tradingsymbol}`] = f;
                    this.state.futuresDataSymbolExpiryMap[`${f.symbol}|${f.expiry_type}`] = f;
                });
                if (this.worker) {
                    this.worker.postMessage({ type: 'INIT_FUTURES', data: { futuresData: data.data } });
                }
                
                // If masterData is already loaded, subscribe to the target expiry futures now
                if (this.state.masterData) {
                    this.subscribeTargetFutures();
                    this.state.masterData.forEach(mr => {
                        const key = `${mr.exchange}|${mr.tradingsymbol}`;
                        const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
                        const rowEl = this.getDomElement(`row-${safeKey}`);
                        if (rowEl) {
                            this.updateStockQuoteRow(rowEl, safeKey, {});
                        }
                    });
                }
            }
        } catch(e) { console.error("Failed to load futures data", e); }
    },

    subscribeTargetFutures() {
        if (!this.state.masterData || !this.state.futuresData) return;
        
        const targetExpiry = this.state.globalExpiry || 'Near';
        const futuresSubs = [];
        this.state.masterData.forEach(mr => {
            const targetFut = this.state.futuresDataSymbolExpiryMap ? this.state.futuresDataSymbolExpiryMap[`${mr.symbol}|${targetExpiry}`] : null;
            if (targetFut) {
                futuresSubs.push(`${targetFut.exchange}|${targetFut.tradingsymbol}`);
            }
        });

        if(futuresSubs.length > 0) {
            console.log(`Subscribing to ${futuresSubs.length} target expiry futures for OI tracking...`);
            fetch(`${API_BASE}/subscribe_bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbols: futuresSubs })
            }).catch(e => console.error("Futures subscribe error", e));
        }
    },

    async subscribeQuote() {
        const exchange = document.getElementById('sub-exchange').value.toUpperCase();
        const symbol = document.getElementById('sub-symbol').value.toUpperCase();

        if(!symbol) return;

        try {
            const res = await fetch(`${API_BASE}/subscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ exchange, symbol_or_token: symbol })
            });
            const data = await res.json();
            if(data.status === 'success') {
                this.notify(data.message, "success");
                // Clear initial placeholder if exist
                const tb = document.getElementById('live-data-body');
                if(tb.innerHTML.includes("No instruments")) tb.innerHTML = "";
            } else {
                this.notify(data.message, "error");
            }
        } catch (e) {
            this.notify("Request failed", "error");
        }
    },

    async placeOrder(side) {
        const exchange = document.getElementById('sub-exchange').value.toUpperCase();
        const symbol = document.getElementById('sub-symbol').value.toUpperCase();
        const qty = document.getElementById('order-qty').value;
        let price = document.getElementById('order-price').value;

        if(!symbol || !qty) {
            this.notify("Symbol and Qty required for order", "error");
            return;
        }

        price = parseFloat(price) || 0;
        const type = price === 0 ? "MARKET" : "LIMIT";

        try {
            const res = await fetch(`${API_BASE}/place_order`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    exchange, 
                    symbol, 
                    quantity: parseInt(qty), 
                    buy_or_sell: side === 'B' ? 'BUY' : 'SELL',
                    order_type: type,
                    price: price
                })
            });
            const data = await res.json();
            if(data.status === 'success') {
                this.notify(`Order placed: ${data.order_id}`, "success");
                this.refreshOrders();
            } else {
                this.notify(`Order failed: ${data.message}`, "error");
            }
        } catch (e) {
            this.notify("Request failed", "error");
        }
    },

    async refreshPositions() {
        try {
            const res = await fetch(`${API_BASE}/positions`);
            const data = await res.json();
            if(data.status === 'success') {
                this.state.positions = data.positions;
                this.renderPositions();
            }
        } catch (e) { console.error(e); }
    },

    async refreshOrders() {
        try {
            const res = await fetch(`${API_BASE}/orderbook`);
            const data = await res.json();
            if(data.status === 'success') {
                this.state.orders = data.orderbook;
                this.renderOrders();
            }
        } catch (e) { console.error(e); }
    },

    // Rendering functions
    renderMasterTable() {
        this.clearDomCache();
        const tb = document.getElementById('live-data-body');
        if (!tb) return;
        if(!this.state.masterData || this.state.masterData.length === 0) return;

        let html = '';
        this.state.masterData.forEach((row, i) => {
            const key = `${row.exchange}|${row.tradingsymbol}`;
            const symbol = row.symbol || key; 
            const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
            // Lot size: pull from master data (populated from futures data on backend)
            const lotsize = row.lotsize != null && row.lotsize !== '-' ? row.lotsize : '-';
            const initOiPc = (row.oi_chg_pc != null && row.oi_chg_pc !== '-') ? ((typeof row.oi_chg_pc === 'number') ? row.oi_chg_pc.toFixed(2) + '%' : row.oi_chg_pc.toString().replace(/%/g, '') + '%') : '-';
            const initOi = (row.oi != null && row.oi !== '-') ? row.oi : '-';
            const initPoi = (row.poi != null && row.poi !== '-') ? row.poi : '-';
            
            html += `<tr id="row-${safeKey}" data-key="${key}">
                <td class="s-no">${i + 1}</td>
                <td id="name-${safeKey}" style="font-weight:600; text-align:left; color:var(--text-primary);">${symbol}</td>
                <td id="prev-${safeKey}">-</td> <!-- Prev. Close -->
                <td id="open-${safeKey}">-</td> <!-- Open -->
                <td id="high-${safeKey}">-</td> <!-- High -->
                <td id="low-${safeKey}">-</td>  <!-- Low -->
                <td id="ltp-${safeKey}" style="font-weight:bold;">-</td> <!-- LTP -->
                <td id="change-${safeKey}">-</td> <!-- Change -->
                <td id="chgpc-${safeKey}">-</td> <!-- Chg% -->
                <td>${row.atr_14 || '-'}</td> <!-- 14 ATR -->
                <td>${(row.avg_vol && !isNaN(parseFloat(row.avg_vol))) ? parseFloat(row.avg_vol).toFixed(0) : '-'}</td> <!-- 14 Avg Vol -->
                <td id="v-${safeKey}">-</td> <!-- Volume -->
                <td id="chgvolpc-${safeKey}">-</td> <!-- Change in Volume -->
                <td id="rankvol-${safeKey}" style="font-weight:bold;">-</td> <!-- Rank of Avg Vol -->
                <td id="rankchg-${safeKey}">-</td> <!-- Rank of Today's Change -->
                <td id="rankabschg-${safeKey}">-</td> <!-- ABS Change Rank -->
                <td id="nearoipc-${safeKey}">${initOiPc}</td> <!-- OI Change % -->
                <td id="rankoi-${safeKey}">-</td> <!-- OI Change Rank -->
                <td id="ohl-${safeKey}" style="font-weight:bold; text-align:center;">-</td> <!-- O=H/L -->
                <td id="oi-${safeKey}">${initOi}</td> <!-- Present OI -->
                <td id="poi-${safeKey}">${initPoi}</td> <!-- Yesterday's OI -->
                <td style="text-align:right; font-weight:600; color:var(--accent);">${lotsize}</td> <!-- Lot Size -->
                <td class="trade-actions">
                    <button class="primary" onclick="app.setOrderContext('${key}')">T</button>
                </td>
            </tr>`;
        });
        tb.innerHTML = html;
    },

    renderFuturesTable(data = null) {
        this.clearDomCache();
        const tb = document.getElementById('futures-body');
        if (!tb) return;
        const futuresToRender = data || this.state.futuresData || [];
        
        if(!futuresToRender || futuresToRender.length === 0) {
            tb.innerHTML = '<tr><td colspan="14" style="text-align:center; color: var(--text-secondary); padding: 50px;">Loading Futures Data...</td></tr>';
            return;
        }

        let html = '';
        futuresToRender.forEach((fut, i) => {
            const key = `${fut.exchange}|${fut.tradingsymbol}`;
            const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
            const displayName = `${fut.symbol} ${fut.expiry_type}`;
            
            // Calculate price change
            const prevClose = fut.prev_close || 0;
            const ltp = fut.ltp || 0;
            const priceChange = prevClose > 0 ? (ltp - prevClose).toFixed(2) : '-';
            const pctChange = prevClose > 0 ? (((ltp - prevClose) / prevClose) * 100).toFixed(2) : '-';
            
            const profitLossClass = parseFloat(pctChange) >= 0 ? 'text-profit bg-profit-light' : 'text-loss bg-loss-light';
            
            // Strike difference display
            const strikeDiff = fut.strike_difference ? fut.strike_difference.toFixed(2) : '-';
            
            html += `<tr id="fut-row-${safeKey}">
                <td class="s-no">${i + 1}</td>
                <td style="font-weight:600; text-align:left;">
                    <div>${displayName}</div>
                    <small style="color: var(--text-secondary); font-size: 0.75rem;">${fut.expiry_date}</small>
                </td>
                <td style="text-align:right;">${fut.lotsize || '-'}</td>
                <td style="text-align:right;">${strikeDiff}</td>
                <td style="text-align:center;">${fut.expiry_date || '-'}</td>
                <td id="fut-ltp-${safeKey}" style="font-weight:bold;" class="${parseFloat(pctChange) >= 0 ? 'text-profit' : 'text-loss'}">${ltp > 0 ? ltp.toFixed(2) : '-'}</td>
                <td id="fut-change-${safeKey}" class="${profitLossClass}">${priceChange}</td>
                <td id="fut-pc-${safeKey}" class="${profitLossClass}">${pctChange}%</td>
                <td id="fut-prev-${safeKey}">${prevClose > 0 ? prevClose.toFixed(2) : '-'}</td>
                <td id="fut-open-${safeKey}">${fut.open > 0 ? fut.open.toFixed(2) : '-'}</td>
                <td id="fut-high-${safeKey}">${fut.high > 0 ? fut.high.toFixed(2) : '-'}</td>
                <td id="fut-low-${safeKey}">${fut.low > 0 ? fut.low.toFixed(2) : '-'}</td>
                <td id="fut-oi-${safeKey}">${fut.oi || '-'}</td>
                <td class="trade-actions">
                    <button class="primary" onclick="app.setOrderContext('${key}')">T</button>
                </td>
            </tr>`;
        });
        tb.innerHTML = html;
    },

    updateQuote(key, d) {
        const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
        
        // Update index ticker elements if present in DOM
        const tickLp = this.getDomElement(`ticker-lp-${safeKey}`);
        const tickChange = this.getDomElement(`ticker-change-${safeKey}`);
        const tickPc = this.getDomElement(`ticker-pc-${safeKey}`);

        if (tickLp && d.lp !== undefined) {
            tickLp.innerText = parseFloat(d.lp).toFixed(2);
            
            if (d.pc !== undefined) {
                const lpFloat = parseFloat(d.lp);
                const pcFloat = parseFloat(d.pc);
                const currentChg = lpFloat - (lpFloat / (1 + (pcFloat / 100)));
                const isPositive = pcFloat >= 0;
                
                if (tickChange) {
                    tickChange.innerText = (isPositive ? '+' : '') + currentChg.toFixed(2);
                    tickChange.style.color = isPositive ? 'var(--profit)' : 'var(--loss)';
                }
                if (tickPc) {
                    tickPc.innerText = `(${isPositive ? '+' : ''}${pcFloat.toFixed(2)}%)`;
                    tickPc.style.color = isPositive ? 'var(--profit)' : 'var(--loss)';
                }
            }
        }

        // Update FnO Stocks and Stock Futures rows
        const row = this.getDomElement(`row-${safeKey}`);
        if(row) {
            this.updateStockQuoteRow(row, safeKey, d);
        }
        
        const futRow = this.getDomElement(`fut-row-${safeKey}`);
        if(futRow) {
            this.updateFuturesQuoteRow(futRow, safeKey, d);
        }

        // Update Trade Ready row if present
        const trRow = this.getDomElement(`tr-row-${safeKey}`);
        if(trRow) {
            this.updateTradeReadyRow(trRow, safeKey, d);
        }

        // If this is a future key, also update the corresponding spot row's OI data
        if(this.state.futuresDataKeyMap && this.state.masterDataSymbolMap) {
            const fut = this.state.futuresDataKeyMap[key];
            if(fut) {
                const spotRow = this.state.masterDataSymbolMap[fut.symbol];
                if(spotRow) {
                    const spotKey = `${spotRow.exchange}|${spotRow.tradingsymbol}`;
                    const spotSafeKey = spotKey.replace(/[^a-zA-Z0-9_-]/g, '_');
                    const spotLive = this.state.liveData[spotKey] || {};
                    const spotRowEl = this.getDomElement(`row-${spotSafeKey}`);
                    if(spotRowEl) {
                        this.updateStockQuoteRow(spotRowEl, spotSafeKey, spotLive);
                    }

                    // Also update Trade Ready table's futures columns for this spot symbol
                    const targetExpiry = this.state.globalExpiry || 'Near';
                    if (fut.expiry_type === targetExpiry) {
                        const trFutLtp = this.getDomElement(`tr-futltp-${spotSafeKey}`);
                        const trFutChange = this.getDomElement(`tr-futchange-${spotSafeKey}`);
                        const trFutPc = this.getDomElement(`tr-futpc-${spotSafeKey}`);
                        const trNearOi = this.getDomElement(`tr-nearoipc-${spotSafeKey}`);
                        const trAtm = this.getDomElement(`tr-atmstrike-${spotSafeKey}`);
                        
                        const fLP = d.lp !== undefined ? parseFloat(d.lp) : (fut.ltp ? parseFloat(fut.ltp) : null);
                        const fPC = d.pc !== undefined ? parseFloat(d.pc) : (fut.change || 0);
                        const prevClose = fut.prev_close || (fLP && fPC ? (fLP / (1 + fPC/100)) : 0);
                        
                        const priceChange = prevClose > 0 && fLP !== null ? (fLP - prevClose).toFixed(2) : '-';
                        const pctChange = prevClose > 0 && fLP !== null ? (((fLP - prevClose) / prevClose) * 100).toFixed(2) : '-';
                        const futIsPos = parseFloat(pctChange) >= 0;
                        
                        if(trFutLtp && fLP !== null) {
                            trFutLtp.innerText = fLP.toFixed(2);
                        }
                        if(trFutChange) {
                            trFutChange.innerText = priceChange;
                            trFutChange.className = futIsPos ? 'text-profit bg-profit-light' : 'text-loss bg-loss-light';
                        }
                        if(trFutPc) {
                            trFutPc.innerText = pctChange !== '-' ? pctChange + '%' : '-';
                            trFutPc.className = futIsPos ? 'text-profit bg-profit-light' : 'text-loss bg-loss-light';
                        }

                        // Update OI info in Trade Ready
                        let liveOiInfo = '-';
                        if(d.oi !== undefined) {
                            if(d.poi && d.poi > 0) {
                                liveOiInfo = (((parseFloat(d.oi) - parseFloat(d.poi)) / parseFloat(d.poi)) * 100).toFixed(2);
                            } else {
                                liveOiInfo = '0.00';
                            }
                        }
                        if(trNearOi && liveOiInfo !== '-') {
                            trNearOi.innerText = liveOiInfo + '%';
                            if(parseFloat(liveOiInfo) > 0) trNearOi.className = 'text-profit bg-profit-light';
                            else if(parseFloat(liveOiInfo) < 0) trNearOi.className = 'text-loss bg-loss-light';
                            else trNearOi.className = '';
                        }

                        // Update ATM strike in Trade Ready
                        if(trAtm && spotLive.lp !== undefined) {
                            const spotLtp = parseFloat(spotLive.lp);
                            if (fut.strikes && fut.strikes.length > 0 && spotLtp > 0) {
                                const atmVal = fut.strikes.reduce((prev, curr) => {
                                    return Math.abs(curr - spotLtp) < Math.abs(prev - spotLtp) ? curr : prev;
                                });
                                trAtm.innerText = Number(atmVal.toFixed(2)).toString();
                            } else {
                                const sd = parseFloat(fut.strike_difference);
                                if(spotLtp > 0 && sd > 0) {
                                    trAtm.innerText = (Math.round(spotLtp / sd) * sd).toFixed(0);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Update Trade Entry cells directly if this is an option key
        const cleanKey = key.replace(/^NFO\|/, '').replace(/^NSE\|/, '').replace(/^BSE\|/, '').replace(/^CDS\|/, '');
        const safeCleanKey = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_');
        const ltp  = d.lp  ? parseFloat(d.lp)  : null;
        const bid  = d.bp1 ? parseFloat(d.bp1)  : null;
        const ask  = d.sp1 ? parseFloat(d.sp1)  : null;
        const high = d.h   ? parseFloat(d.h)    : null;
        const low  = d.l   ? parseFloat(d.l)    : null;
        const pc   = d.pc  ? parseFloat(d.pc)   : null;
        const chg  = (ltp !== null && pc !== null) ? (ltp - ltp/(1+pc/100)) : null;
        const oi   = d.oi  || null;
        // Update direct option cells by unique ID (main vs hedge tables)
        const isPos = pc !== null ? pc >= 0 : true;
        const pcCls = isPos ? 'text-profit' : 'text-loss';
        const bgCls = isPos ? 'bg-profit-light' : 'bg-loss-light';

        ['main', 'hedge'].forEach(t => {
            const elBid  = this.getDomElement(`tn-bid-${t}-${safeKey}`) || this.getDomElement(`tn-bid-${t}-${safeCleanKey}`);
            const elAsk  = this.getDomElement(`tn-ask-${t}-${safeKey}`) || this.getDomElement(`tn-ask-${t}-${safeCleanKey}`);
            const elLtp  = this.getDomElement(`tn-ltp-${t}-${safeKey}`) || this.getDomElement(`tn-ltp-${t}-${safeCleanKey}`);
            const elVol  = this.getDomElement(`tn-vol-${t}-${safeKey}`) || this.getDomElement(`tn-vol-${t}-${safeCleanKey}`);
            const elChg  = this.getDomElement(`tn-chg-${t}-${safeKey}`) || this.getDomElement(`tn-chg-${t}-${safeCleanKey}`);
            const elPc   = this.getDomElement(`tn-pc-${t}-${safeKey}`) || this.getDomElement(`tn-pc-${t}-${safeCleanKey}`);
            const elHigh = this.getDomElement(`tn-high-${t}-${safeKey}`) || this.getDomElement(`tn-high-${t}-${safeCleanKey}`);
            const elLow  = this.getDomElement(`tn-low-${t}-${safeKey}`) || this.getDomElement(`tn-low-${t}-${safeCleanKey}`);
            const elOi   = this.getDomElement(`tn-oi-${t}-${safeKey}`) || this.getDomElement(`tn-oi-${t}-${safeCleanKey}`);

            if(elBid && bid!==null) elBid.innerText = bid.toFixed(2);
            if(elAsk && ask!==null) elAsk.innerText = ask.toFixed(2);
            if(elLtp && ltp!==null) elLtp.innerText = ltp.toFixed(2);
            if(elVol && d.v) elVol.innerText = parseInt(d.v);
            if(elChg && chg!==null) { elChg.innerText = chg.toFixed(2); elChg.className = bgCls; }
            if(elPc && pc!==null)   { elPc.innerText = pc.toFixed(2)+'%'; elPc.className = pcCls; }
            if(elHigh && high!==null) elHigh.innerText = high.toFixed(2);
            if(elLow && low!==null) elLow.innerText = low.toFixed(2);
            if(elOi && oi!==null)   elOi.innerText = oi;

            // Keep Entry Limit Price in-sync with LTP or Best Buy/Sell when signal is set to 'LTP' or 'Market'
            const elSignal = this.getDomElement(`te-signal-${t}-${safeKey}`);
            const elLimit = this.getDomElement(`te-limit-${t}-${safeKey}`);
            if (elSignal && elLimit) {
                const signalVal = elSignal.value;
                const elSide = this.getDomElement(`te-side-${t}-${safeKey}`);
                const sideVal = elSide ? elSide.value : 'BUY';
                
                if (signalVal === 'LTP' && ltp !== null) {
                    elLimit.value = ltp.toFixed(2);
                } else if (signalVal === 'Market') {
                    if (sideVal === 'BUY') {
                        const calculated = (bid !== null && bid > 0) ? (bid + 0.05) : (ltp !== null ? ltp : 0);
                        elLimit.value = calculated > 0 ? calculated.toFixed(2) : '';
                    } else {
                        const calculated = (ask !== null && ask > 0) ? (ask - 0.05) : (ltp !== null ? ltp : 0);
                        elLimit.value = calculated > 0 ? calculated.toFixed(2) : '';
                    }
                }
            }
        });

        // Also update any matching Trade Exit row live values directly
        if(this.state.tradeExitRows && this.state.tradeExitRows.length > 0) {
            this.state.tradeExitRows.forEach((item, index) => {
                if(item.optKey === key) {
                    this.updateTradeExitLiveValues(index);
                }
            });
        }
    },

    
    updateStockQuoteRow(row, safeKey, d) {
        const elName = this.getDomElement(`name-${safeKey}`);
        const elLtp = this.getDomElement(`ltp-${safeKey}`);
        const elChange = this.getDomElement(`change-${safeKey}`);
        const elChgpc = this.getDomElement(`chgpc-${safeKey}`);
        
        const tickLp = this.getDomElement(`ticker-lp-${safeKey}`);
        const tickChange = this.getDomElement(`ticker-change-${safeKey}`);
        const tickPc = this.getDomElement(`ticker-pc-${safeKey}`);

        let currentChg = 0;
        let isPositive = true;

        const key = row.dataset.key || row.id.replace('row-', '').replace('_', '|');
        const mr = this.state.masterDataMap ? this.state.masterDataMap[key] : null;
        if (mr) {
            const liveKey = `${mr.exchange}|${mr.tradingsymbol}`;
            if (!this.state.liveData[liveKey]) {
                this.state.liveData[liveKey] = {};
            }
        }

        if (d.lp !== undefined) {
            currentChg = d.pc !== undefined ? (d.lp - (d.lp / (1+(d.pc/100)))) : 0;
            isPositive = currentChg >= 0;

            if(elLtp) {
                elLtp.innerText = d.lp;
                elLtp.className = isPositive ? 'text-profit' : 'text-loss';
            }
            if(elName) {
                elName.className = isPositive ? 'text-profit' : 'text-loss';
            }
            if(tickLp) tickLp.innerText = parseFloat(d.lp).toFixed(2);
            
            if(elChange) {
                elChange.innerText = currentChg.toFixed(2);
                elChange.className = isPositive ? 'text-profit' : 'text-loss';
            }
            if(elChgpc) {
                elChgpc.innerText = d.pc ? d.pc + '%' : '-';
                elChgpc.className = isPositive ? 'text-profit bg-profit-light' : 'text-loss bg-loss-light';
            }

            if(d.pc && tickChange && tickPc) {
                const pcFloat = parseFloat(d.pc);
                tickChange.innerText = currentChg > 0 ? `+${currentChg.toFixed(2)}` : currentChg.toFixed(2);
                tickChange.style.color = currentChg >= 0 ? 'var(--profit)' : 'var(--loss)';
                tickPc.innerText = `(${pcFloat > 0 ? '+' : ''}${pcFloat.toFixed(2)}%)`;
                tickPc.style.color = currentChg >= 0 ? 'var(--profit)' : 'var(--loss)';
            }
        }
        
        // Populate standard columns
        if (d.o !== undefined) {
            const elOpen = this.getDomElement(`open-${safeKey}`);
            if(elOpen) elOpen.innerText = d.o;
        }
        if (d.h !== undefined) {
            const elHigh = this.getDomElement(`high-${safeKey}`);
            if(elHigh) elHigh.innerText = d.h;
        }
        if (d.l !== undefined) {
            const elLow = this.getDomElement(`low-${safeKey}`);
            if(elLow) elLow.innerText = d.l;
            // Infer Prev Close roughly if missing natively, though normally provided as `c` natively.
            const elPrev = this.getDomElement(`prev-${safeKey}`);
            if(elPrev && d.pc !== undefined && d.lp !== undefined) {
                elPrev.innerText = (parseFloat(d.lp) / (1 + (parseFloat(d.pc)/100))).toFixed(2);
            }
        }
        
        // Open=High / Open=Low computation
        const masterKeyStr = row.id.replace('row-', '').replace('_', '|');
        const liveRecord = this.state.liveData[masterKeyStr] || {};
        const openVal = parseFloat(d.o !== undefined ? d.o : liveRecord.o);
        const highVal = parseFloat(d.h !== undefined ? d.h : liveRecord.h);
        const lowVal  = parseFloat(d.l !== undefined ? d.l : liveRecord.l);
        
        if (!isNaN(openVal)) {
            let ohlText = '';
            if (!isNaN(highVal) && openVal === highVal) {
                ohlText = 'O=H';
            } else if (!isNaN(lowVal) && openVal === lowVal) {
                ohlText = 'O=L';
            }
            
            const elOhl = this.getDomElement(`ohl-${safeKey}`);
            if(elOhl) {
                elOhl.innerText = ohlText || '-';
                if(ohlText === 'O=H') elOhl.className = 'text-loss bg-loss-light';
                else if(ohlText === 'O=L') elOhl.className = 'text-profit bg-profit-light';
                else elOhl.className = '';
            }
        }

        // Compute Col 11: Change in Volume %
        // Need to locate original master row to get avg_vol
        // Crude recovery, but key is passed. 
        // Wait, key is safer:
        
        if (d.v !== undefined) {
            const elVolume = this.getDomElement(`v-${safeKey}`);
            if(elVolume) elVolume.innerText = parseFloat(d.v).toFixed(0);
        }

        if (d.v !== undefined && mr && mr.avg_vol) {
            const v = parseFloat(d.v);
            const avgVol = parseFloat(mr.avg_vol);
            if(avgVol > 0) {
                const chgVolPc = ((v / avgVol) * 100).toFixed(2);
                const elChgVol = this.getDomElement(`chgvolpc-${safeKey}`);
                if(elChgVol) elChgVol.innerText = chgVolPc + '%';
                // Store in liveData for calculateRanks to compute
                if(!this.state.liveData[`${mr.exchange}|${mr.tradingsymbol}`]) {
                   this.state.liveData[`${mr.exchange}|${mr.tradingsymbol}`] = d; 
                }
                this.state.liveData[`${mr.exchange}|${mr.tradingsymbol}`].computed_chgvolpc = parseFloat(chgVolPc);
            }
        }

        // Store locally for ranks
        if(d.pc !== undefined && mr) {
            this.state.liveData[`${mr.exchange}|${mr.tradingsymbol}`].computed_abschg = Math.abs(parseFloat(d.pc));
            this.state.liveData[`${mr.exchange}|${mr.tradingsymbol}`].computed_chgpc = parseFloat(d.pc);
        }

        // Fetch Target Expiry OI % from Futures Data or Master Baseline
        if(mr) {
            const targetExpiry = this.state.globalExpiry || 'Near';
            const targetFut = this.state.futuresDataSymbolExpiryMap ? this.state.futuresDataSymbolExpiryMap[`${mr.symbol}|${targetExpiry}`] : null;
            const futSafeKey = targetFut ? `${targetFut.exchange}|${targetFut.tradingsymbol}` : null;
            const futLive = futSafeKey ? this.state.liveData[futSafeKey] : null;
            
            let liveOiInfo = '-';
            let presentOi = '-';
            let yestOi = '-';
            
            const liveOi = (futLive && futLive.oi !== undefined && futLive.oi > 0) ? futLive.oi : ((targetFut && targetFut.oi !== undefined && targetFut.oi > 0) ? targetFut.oi : mr.oi);
            const livePoi = (futLive && futLive.poi !== undefined && futLive.poi > 0) ? futLive.poi : ((targetFut && targetFut.poi !== undefined && targetFut.poi > 0) ? targetFut.poi : mr.poi);
            
            if (liveOi !== undefined && liveOi !== null && liveOi !== '-' && parseFloat(liveOi) > 0) {
                presentOi = liveOi;
                if (livePoi !== undefined && livePoi !== null && livePoi !== '-' && parseFloat(livePoi) > 0) {
                    yestOi = livePoi;
                    liveOiInfo = (((parseFloat(liveOi) - parseFloat(livePoi)) / parseFloat(livePoi)) * 100).toFixed(2);
                } else {
                    liveOiInfo = '0.00';
                }
            }
            
            const elNearOi = this.getDomElement(`nearoipc-${safeKey}`);
            if(elNearOi) {
                const cleanOiInfo = (liveOiInfo || '').toString().replace(/%/g, '');
                elNearOi.innerText = (cleanOiInfo !== '-' && cleanOiInfo !== '') ? cleanOiInfo + '%' : '-';
                if(cleanOiInfo !== '-' && parseFloat(cleanOiInfo) > 0) elNearOi.className = 'text-profit bg-profit-light';
                else if(cleanOiInfo !== '-' && parseFloat(cleanOiInfo) < 0) elNearOi.className = 'text-loss bg-loss-light';
                else elNearOi.className = '';
            }

            const elPresentOi = this.getDomElement(`oi-${safeKey}`);
            if(elPresentOi) elPresentOi.innerText = presentOi;
            
            const elYestOi = this.getDomElement(`poi-${safeKey}`);
            if(elYestOi) elYestOi.innerText = yestOi;
            
            if (this.state.liveData[`${mr.exchange}|${mr.tradingsymbol}`]) {
                this.state.liveData[`${mr.exchange}|${mr.tradingsymbol}`].computed_oi_chg = liveOiInfo === '-' ? null : parseFloat(liveOiInfo);
                this.state.liveData[`${mr.exchange}|${mr.tradingsymbol}`].computed_oi = presentOi !== '-' ? parseFloat(presentOi) : null;
                this.state.liveData[`${mr.exchange}|${mr.tradingsymbol}`].computed_poi = yestOi !== '-' ? parseFloat(yestOi) : null;
            }
        }
    },

    updateTradeReadyRow(row, safeKey, d) {
        const elLtp = this.getDomElement(`tr-ltp-${safeKey}`);
        const elChange = this.getDomElement(`tr-change-${safeKey}`);
        const elChgpc = this.getDomElement(`tr-chgpc-${safeKey}`);
        const elChgVol = this.getDomElement(`tr-chgvolpc-${safeKey}`);
        
        let currentChg = 0;
        let isPositive = true;

        if (d.lp !== undefined) {
            currentChg = d.pc !== undefined ? (d.lp - (d.lp / (1+(d.pc/100)))) : 0;
            isPositive = currentChg >= 0;

            if(elLtp) {
                elLtp.innerText = parseFloat(d.lp).toFixed(2);
                elLtp.className = isPositive ? 'text-profit' : 'text-loss';
            }
            if(elChange) {
                elChange.innerText = currentChg.toFixed(2);
                elChange.className = isPositive ? 'text-profit bg-profit-light' : 'text-loss bg-loss-light';
            }
            if(elChgpc) {
                elChgpc.innerText = d.pc ? parseFloat(d.pc).toFixed(2) + '%' : '0.00%';
                elChgpc.className = isPositive ? 'text-profit bg-profit-light' : 'text-loss bg-loss-light';
            }
        }

        const key = row.dataset.key || row.id.replace('tr-row-', '').replace('_', '|');
        const mr = this.state.masterDataMap ? this.state.masterDataMap[key] : null;

        if (d.v !== undefined && mr && mr.avg_vol) {
            const v = parseFloat(d.v);
            const avgVol = parseFloat(mr.avg_vol);
            if(avgVol > 0) {
                const chgVolPc = ((v / avgVol) * 100).toFixed(2);
                if(elChgVol) elChgVol.innerText = chgVolPc + '%';
            }
        }

        // Also update ATM Strike if Spot LTP changes
        const trAtm = this.getDomElement(`tr-atmstrike-${safeKey}`);
        if(trAtm && mr && d.lp !== undefined) {
            const spotLtp = parseFloat(d.lp);
            const targetExpiry = this.state.globalExpiry || 'Near';
            const fut = this.state.futuresDataSymbolExpiryMap ? this.state.futuresDataSymbolExpiryMap[`${mr.symbol}|${targetExpiry}`] : null;
            if (fut && fut.strikes && fut.strikes.length > 0 && spotLtp > 0) {
                const atmVal = fut.strikes.reduce((prev, curr) => {
                    return Math.abs(curr - spotLtp) < Math.abs(prev - spotLtp) ? curr : prev;
                });
                trAtm.innerText = Number(atmVal.toFixed(2)).toString();
            } else {
                const sd = fut ? parseFloat(fut.strike_difference) : (mr.strike_difference ? parseFloat(mr.strike_difference) : null);
                if(spotLtp > 0 && sd && sd > 0) {
                    trAtm.innerText = (Math.round(spotLtp / sd) * sd).toFixed(0);
                }
            }
        }

        // Update Futures columns in Trade Ready row
        const elFutLtp = this.getDomElement(`tr-futprice-${safeKey}`);
        const elFutChg = this.getDomElement(`tr-futchange-${safeKey}`);
        const elFutPc  = this.getDomElement(`tr-futchgpc-${safeKey}`);
        
        if (mr) {
            const targetExpiry = this.state.globalExpiry || 'Near';
            const symClean = (mr.symbol || '').replace('-', '').toUpperCase();
            const fut = (this.state.futuresData || []).find(f => {
                const fSymClean = (f.symbol || '').replace('-', '').toUpperCase();
                return (f.symbol === mr.symbol || fSymClean === symClean) && 
                       (f.expiry_type === targetExpiry || (f.expiry_type || '').toLowerCase() === targetExpiry.toLowerCase());
            }) || (this.state.futuresDataSymbolExpiryMap ? this.state.futuresDataSymbolExpiryMap[`${mr.symbol}|${targetExpiry}`] : null);
            
            if (fut) {
                const futKey  = `${fut.exchange}|${fut.tradingsymbol}`;
                const futKeyAlt = futKey.endsWith('FUT') ? futKey.slice(0, -3) + 'F' : (futKey.endsWith('F') ? futKey.slice(0, -1) + 'FUT' : futKey);
                const tsym = fut.tradingsymbol || '';
                const altTsym = tsym.endsWith('F') ? tsym.slice(0,-1)+'FUT' : (tsym.endsWith('FUT') ? tsym.slice(0,-3)+'F' : tsym);
                
                const futLive = this.state.liveData[futKey] || 
                                this.state.liveData[futKeyAlt] || 
                                this.state.liveData[tsym] || 
                                this.state.liveData[altTsym] || 
                                this.state.liveData[`NFO|${tsym}`] || 
                                this.state.liveData[`NFO|${altTsym}`] || 
                                {};
                                
                let fLtpVal = null;
                let fPcVal = null;
                let fChgVal = null;

                if (futLive && futLive.lp !== undefined && futLive.lp > 0) {
                    fLtpVal = parseFloat(futLive.lp);
                    if (futLive.pc !== undefined) {
                        fPcVal = parseFloat(futLive.pc);
                        fChgVal = (futLive.lp - (futLive.lp / (1 + (fPcVal / 100)))).toFixed(2);
                    }
                } else if (fut && fut.ltp && fut.ltp > 0) {
                    fLtpVal = parseFloat(fut.ltp);
                    fPcVal = parseFloat(fut.pct_change || fut.change || 0);
                    fChgVal = parseFloat(fut.change || 0).toFixed(2);
                } else if (d && d.lp && d.lp > 0) {
                    fLtpVal = parseFloat(d.lp);
                    fPcVal = parseFloat(d.pc || 0);
                    fChgVal = (d.lp - (d.lp / (1 + (parseFloat(d.pc || 0) / 100)))).toFixed(2);
                } else if (mr && (mr.ltp || mr.last_close || mr.prev_close)) {
                    const sp = parseFloat(mr.ltp || mr.last_close || mr.prev_close || 0);
                    if (sp > 0) {
                        fLtpVal = sp;
                        fPcVal = parseFloat(mr.chgpc || 0);
                        fChgVal = parseFloat(mr.change || 0).toFixed(2);
                    }
                }

                if (fLtpVal !== null && fLtpVal > 0) {
                    if (elFutLtp) elFutLtp.innerText = fLtpVal.toFixed(2);
                    if (fPcVal !== null) {
                        const fIsPos = fPcVal >= 0;
                        const fCls = fIsPos ? 'text-profit bg-profit-light' : 'text-loss bg-loss-light';
                        if (elFutChg) {
                            elFutChg.innerText = fChgVal !== null ? fChgVal : (fLtpVal * (fPcVal / 100)).toFixed(2);
                            elFutChg.className = fCls;
                        }
                        if (elFutPc) {
                            elFutPc.innerText = fPcVal.toFixed(2) + '%';
                            elFutPc.className = fCls;
                        }
                    }
                }
            }
        }
    },


    calculateLiveRanks() {
        if(!this.state.masterData || document.getElementById('tab-live-data').style.display === 'none') return;


        // Collect all visible rows to rank
        const visibleData = [];
        this.state.masterData.forEach(row => {
            const key = `${row.exchange}|${row.tradingsymbol}`;
            const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
            const tr = document.getElementById(`row-${safeKey}`);
            
            // Only rank visible rows that aren't filtered out
            if(tr && tr.style.display !== 'none') {
                const live = this.state.liveData[key] || {};
                visibleData.push({
                    safeKey: safeKey,
                    masterKey: key,
                    computed_chgvolpc: live.computed_chgvolpc !== undefined ? live.computed_chgvolpc : null,
                    computed_chgpc: live.computed_chgpc !== undefined ? live.computed_chgpc : null,
                    computed_abschg: live.computed_abschg !== undefined ? live.computed_abschg : null,
                    computed_oi_chg: live.computed_oi_chg !== undefined ? live.computed_oi_chg : null
                });
            }
        });

        if(visibleData.length === 0) return;

        // Rank Volume Spurt (Col 11 -> Col 12)
        const sortedVol = [...visibleData].filter(d => d.computed_chgvolpc !== null).sort((a,b) => b.computed_chgvolpc - a.computed_chgvolpc);
        sortedVol.forEach((item, index) => {
            const el = document.getElementById(`rankvol-${item.safeKey}`);
            if(el) el.innerText = index + 1;
            this.state.liveData[item.masterKey].computed_rank_vol = index + 1;
        });

        // Rank Today's Change (Col 15)
        const sortedChg = [...visibleData].filter(d => d.computed_chgpc !== null).sort((a,b) => b.computed_chgpc - a.computed_chgpc);
        sortedChg.forEach((item, index) => {
            const el = document.getElementById(`rankchg-${item.safeKey}`);
            if(el) el.innerText = index + 1;
            this.state.liveData[item.masterKey].computed_rank_chg = index + 1;
        });

        // Rank ABS Change (Col 16)
        const sortedAbs = [...visibleData].filter(d => d.computed_abschg !== null).sort((a,b) => b.computed_abschg - a.computed_abschg);
        sortedAbs.forEach((item, index) => {
            const el = document.getElementById(`rankabschg-${item.safeKey}`);
            if(el) el.innerText = index + 1;
            this.state.liveData[item.masterKey].computed_rank_abschg = index + 1;
        });

        // Rank OI Change % (Col 15)
        visibleData.forEach(item => {
            const el = document.getElementById(`rankoi-${item.safeKey}`);
            if(el) el.innerText = '-';
            if(this.state.liveData[item.masterKey]) {
                this.state.liveData[item.masterKey].computed_rank_oi = 9999;
            }
        });
        const sortedOi = [...visibleData].filter(d => d.computed_oi_chg !== null && d.computed_oi_chg !== 0 && !isNaN(d.computed_oi_chg)).sort((a,b) => b.computed_oi_chg - a.computed_oi_chg);
        sortedOi.forEach((item, index) => {
            const el = document.getElementById(`rankoi-${item.safeKey}`);
            if(el) el.innerText = index + 1;
            if(this.state.liveData[item.masterKey]) {
                this.state.liveData[item.masterKey].computed_rank_oi = index + 1;
            }
        });
    },
    
    updateFuturesQuoteRow(futRow, safeKey, d) {
        const elLtp = this.getDomElement(`fut-ltp-${safeKey}`);
        const elChange = this.getDomElement(`fut-change-${safeKey}`);
        const elPc = this.getDomElement(`fut-pc-${safeKey}`);
        
        if (d.lp) {
            if(elLtp) {
                elLtp.innerText = parseFloat(d.lp).toFixed(2);
                const pcClass = parseFloat(d.pc) >= 0 ? 'text-profit' : 'text-loss';
                elLtp.className = pcClass;
            }
            
            if(elChange && elPc && d.pc) {
                const prevClose = parseFloat(d.o) || 0; // Using open as approximation
                const ltp = parseFloat(d.lp);
                const priceChange = prevClose > 0 ? (ltp - prevClose).toFixed(2) : '-';
                const pctChange = prevClose > 0 ? (((ltp - prevClose) / prevClose) * 100).toFixed(2) : '-';
                
                elChange.innerText = priceChange;
                elPc.innerText = pctChange + '%';
                
                const profitLossClass = parseFloat(pctChange) >= 0 ? 'text-profit bg-profit-light' : 'text-loss bg-loss-light';
                elChange.className = profitLossClass;
                elPc.className = profitLossClass;
            }
        }
        
        if (d.o) {
            const elOpen = this.getDomElement(`fut-open-${safeKey}`);
            if(elOpen) elOpen.innerText = parseFloat(d.o).toFixed(2);
        }
        if (d.h) {
            const elHigh = this.getDomElement(`fut-high-${safeKey}`);
            if(elHigh) elHigh.innerText = parseFloat(d.h).toFixed(2);
        }
        if (d.l) {
            const elLow = this.getDomElement(`fut-low-${safeKey}`);
            if(elLow) elLow.innerText = parseFloat(d.l).toFixed(2);
        }
        if (d.oi) {
            const elOi = this.getDomElement(`fut-oi-${safeKey}`);
            if(elOi) elOi.innerText = d.oi;
        }
    },

    renderPositions() {
        const tb = document.getElementById('positions-body');
        if(!this.state.positions || this.state.positions.length === 0) {
            tb.innerHTML = '<tr><td colspan="6" style="text-align:center;">No open positions</td></tr>';
            return;
        }

        let html = '';
        for(const p of this.state.positions) {
            const pnl = parseFloat(p.rpnl || 0) + parseFloat(p.urmtom || 0);
            const pnlClass = pnl >= 0 ? 'text-profit' : 'text-loss';
            html += `<tr>
                <td>${p.tsym}</td>
                <td>${p.prd}</td>
                <td>${p.netqty}</td>
                <td>${p.netavgprc}</td>
                <td>${p.lp || '-'}</td>
                <td class="${pnlClass}" style="font-weight:bold;">${pnl.toFixed(2)}</td>
            </tr>`;
        }
        tb.innerHTML = html;
    },

    renderOrders() {
        const tb = document.getElementById('orders-body');
        if (!tb) return;
        if (!this.state.orders || this.state.orders.length === 0) {
            tb.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-secondary);">No orders</td></tr>';
            return;
        }

        // --- Sort state ---
        if (!this.state.orderSort) this.state.orderSort = { field: 'norentm', desc: true };
        const { field, desc } = this.state.orderSort;

        // Update sort arrow indicators
        const allSortFields = ['norenordno','tsym','trantype','qty','prc','avgprc','status','norentm'];
        allSortFields.forEach(f => {
            const el = document.getElementById('ob-sort-' + f);
            if (el) el.textContent = f === field ? (desc ? '↓' : '↑') : '↕';
        });

        // --- Parse time helper: "DD-MM-YYYY HH:MM:SS" or "HH:MM:SS" or epoch ---
        const parseOrderTime = (tm) => {
            if (!tm) return 0;
            // Broker returns epoch seconds in some APIs
            if (/^\d{9,13}$/.test(String(tm))) return parseInt(tm);
            // "DD-MM-YYYY HH:MM:SS" or "DD-MM-YYYY HH:MM:SS" (Flattrade format)
            const m = String(tm).match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
            if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}`).getTime();
            // "HH:MM:SS" only
            const t = String(tm).match(/(\d{2}):(\d{2}):(\d{2})/);
            if (t) return parseInt(t[1]) * 3600 + parseInt(t[2]) * 60 + parseInt(t[3]);
            return 0;
        };

        const formatDateTime = (tm) => {
            if (!tm) return '-';
            // Already formatted string from broker e.g. "01-07-2026 09:15:03"
            if (String(tm).includes(':') || String(tm).includes('-')) return tm;
            // epoch
            if (/^\d{9,13}$/.test(String(tm))) {
                const d = new Date(parseInt(tm) * (String(tm).length <= 10 ? 1000 : 1));
                return d.toLocaleString('en-IN', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
            }
            return tm;
        };

        // --- Sort ---
        const sorted = [...this.state.orders].sort((a, b) => {
            let av, bv;
            if (field === 'qty') { av = parseFloat(a.qty)||0; bv = parseFloat(b.qty)||0; }
            else if (field === 'prc') { av = parseFloat(a.prc)||0; bv = parseFloat(b.prc)||0; }
            else if (field === 'avgprc') { av = parseFloat(a.avgprc)||0; bv = parseFloat(b.avgprc)||0; }
            else if (field === 'norentm') { av = parseOrderTime(a.norentm); bv = parseOrderTime(b.norentm); }
            else { av = String(a[field]||'').toLowerCase(); bv = String(b[field]||'').toLowerCase(); }
            if (av < bv) return desc ? 1 : -1;
            if (av > bv) return desc ? -1 : 1;
            return 0;
        });

        let html = '';
        for (const o of sorted) {
            const statusColor = o.status === 'COMPLETE'
                ? 'var(--profit)' : (o.status === 'REJECTED' || o.status === 'CANCELED' || o.status === 'CANCELLED')
                ? 'var(--loss)' : 'var(--warning)';

            const bsColor = o.trantype === 'B' ? 'var(--accent)' : 'var(--loss)';

            // CE/PE badge on symbol
            const optType = this.getOptionType(o.tsym || '');
            let symStyle = 'font-weight:600;';
            let badge = '';
            if (optType === 'CE') {
                symStyle += 'background:rgba(59,130,246,0.12);color:#93c5fd;border-radius:4px;padding:1px 5px;';
                badge = '<span style="margin-left:4px;font-size:0.65rem;background:rgba(59,130,246,0.3);color:#93c5fd;border-radius:3px;padding:0 3px;">CE</span>';
            } else if (optType === 'PE') {
                symStyle += 'background:rgba(248,81,73,0.12);color:#f87171;border-radius:4px;padding:1px 5px;';
                badge = '<span style="margin-left:4px;font-size:0.65rem;background:rgba(248,81,73,0.3);color:#f87171;border-radius:3px;padding:0 3px;">PE</span>';
            }

            const prc    = o.prc    ? parseFloat(o.prc).toFixed(2)    : '-';
            const avgprc = o.avgprc ? parseFloat(o.avgprc).toFixed(2) : '-';
            const dt     = formatDateTime(o.norentm);

            html += `<tr>
                <td style="font-size:0.7rem;color:var(--text-secondary);white-space:nowrap;">${o.norenordno}</td>
                <td><span style="${symStyle}">${o.tsym}${badge}</span></td>
                <td>${o.prd || '-'}</td>
                <td style="color:${bsColor};font-weight:bold;text-align:center;">${o.trantype}</td>
                <td style="text-align:right;">${o.qty}</td>
                <td style="text-align:right;font-weight:600;">${prc}</td>
                <td style="text-align:right;font-weight:600;color:var(--accent);">${avgprc}</td>
                <td style="color:${statusColor};font-weight:bold;">${o.status}</td>
                <td style="white-space:nowrap;font-size:0.75rem;color:var(--text-secondary);">${dt}</td>
                <td><small>${o.rejreason || o.remarks || '-'}</small></td>
            </tr>`;
        }
        tb.innerHTML = html;
    },

    sortOrders(field) {
        if (!this.state.orderSort) this.state.orderSort = { field: 'norentm', desc: true };
        if (this.state.orderSort.field === field) {
            this.state.orderSort.desc = !this.state.orderSort.desc;
        } else {
            this.state.orderSort = { field, desc: field === 'norentm' || field === 'qty' || field === 'prc' };
        }
        this.renderOrders();
    },



    getFieldValue(row, key, field) {
        if(field === 'symbol') return row.symbol || key;
        if(field === 'lotsize') return parseFloat(row.lotsize) || 0;
        if(field === 'avg_vol') return parseFloat(row.avg_vol) || 0;
        if(field === 'atr_14') return parseFloat(row.atr_14) || 0;
        if(field === 'atr') return parseFloat(row.atr_14) || 0;
        if(field === 'strike_difference') return parseFloat(row.strike_difference) || 0;
        
        const live = this.state.liveData[key] || {};
        if(field === 'lp') return parseFloat(live.lp) || 0;
        if(field === 'pc') return parseFloat(live.pc) || 0;
        if(field === 'v') return parseFloat(live.v) || 0;
        if(field === 'change') return live.pc ? (live.lp - (live.lp / (1+(live.pc/100)))) : 0;
        if(field === 'o') return parseFloat(live.o) || 0;
        if(field === 'h') return parseFloat(live.h) || 0;
        if(field === 'l') return parseFloat(live.l) || 0;
        if(field === 'prev') return parseFloat(live.c) || parseFloat(live.o) || 0;  // Prev Close
        if(field === 'ohl') {
            const o = parseFloat(live.o);
            if(o && o === parseFloat(live.h)) return 2;  // O=H sorts highest
            if(o && o === parseFloat(live.l)) return 1;  // O=L sorts next
            return 0;
        }
        
        // Dynamic rankings
        if(field === 'chg_vol_pc') return parseFloat(live.computed_chgvolpc) || 0;
        if(field === 'rank_vol') return parseFloat(live.computed_rank_vol) || 9999;
        if(field === 'rank_chg') return parseFloat(live.computed_rank_chg) || 9999;
        
        if(field === 'near_oi_pc') return parseFloat(live.computed_oi_chg) || 0;
        if(field === 'rank_oi') return parseFloat(live.computed_rank_oi) || 9999;
        
        if(field === 'rank_abs_chg') return parseFloat(live.computed_rank_abschg) || 9999;
        
        if(field === 'oi') return parseFloat(live.computed_oi) || parseFloat(live.oi) || 0;
        if(field === 'poi') return parseFloat(live.computed_poi) || 0;
        return 0;
    },

    buildOptionSymbol(baseSymbol, expiryTag, type, strike) {
        if (!(strike > 0)) return '?';
        let s = Number(strike.toFixed(2)).toString();
        const cp = type.startsWith('C') ? 'C' : 'P';
        return expiryTag ? `${baseSymbol}${expiryTag}${cp}${s}` : `${baseSymbol}${s}${type}`;
    },

    getOptionType(symbol) {
        if (!symbol) return '';
        const match = symbol.match(/([CP])(?:E)?\d+$/i);
        if (match) {
            return match[1].toUpperCase() === 'C' ? 'CE' : 'PE';
        }
        // Fallbacks
        if (symbol.includes('CE')) return 'CE';
        if (symbol.includes('PE')) return 'PE';
        return '';
    },

    getHedgeStrike(item, type, hedgeOffset) {
        const { atmStrike, strikeDiff, strikes } = item;
        if (strikes && strikes.length > 0) {
            const idx = strikes.indexOf(atmStrike);
            if (idx !== -1) {
                const targetIdx = type === 'CE' ? idx + hedgeOffset : idx - hedgeOffset;
                const boundedIdx = Math.max(0, Math.min(strikes.length - 1, targetIdx));
                return strikes[boundedIdx];
            }
        }
        return type === 'CE' ? atmStrike + (hedgeOffset * strikeDiff) : atmStrike - (hedgeOffset * strikeDiff);
    },

    evaluateCondition(fieldVal, op, targetVal, targetVal2) {
        const num = parseFloat(fieldVal);
        const t1 = parseFloat(targetVal);
        const t2 = parseFloat(targetVal2);

        if(op === '=') return fieldVal == targetVal;
        if(op === '>') return !isNaN(num) && num > t1;
        if(op === '<') return !isNaN(num) && num < t1;
        if(op === 'between') return !isNaN(num) && !isNaN(t1) && !isNaN(t2) && num >= t1 && num <= t2;
        if(op === '!=0') return !isNaN(num) && num !== 0;
        if(op === 'isNum') return !isNaN(num) && Number.isFinite(num);
        if(op === '!=null') {
            if(fieldVal === null || fieldVal === undefined) return false;
            const str = String(fieldVal).trim();
            return str !== '' && str !== '-' && str !== 'NaN';
        }
        if(op === 'contains') return String(fieldVal).toLowerCase().includes(String(targetVal).toLowerCase());
        return true;
    },

    handleOpChange(selectElement) {
        const id = selectElement.id.split('-')[0]; // e.g. f1
        const val2 = document.getElementById(id + '-val2');
        if(val2) {
            val2.style.display = selectElement.value === 'between' ? '' : 'none';
        }
    },

    applyFilters() {
        this.state.isFilterActive = true;
        this.runFilterLogic();
    },

    clearFilters() {
        ['f1', 'f2', 'f3', 'f4'].forEach(id => {
            const v1 = document.getElementById(id + '-val');
            const v2 = document.getElementById(id + '-val2');
            const op = document.getElementById(id + '-op');
            if(v1) v1.value = '';
            if(v2) { v2.value = ''; v2.style.display = 'none'; }
            if(op) op.value = '>';
        });
        this.state.isFilterActive = false;
        this.runFilterLogic();
    },

    runFilterLogic() {
        if(!this.state.masterData) return;
        
        const activeFields = ['f1', 'f2', 'f3', 'f4'].map(id => {
            const opEl = document.getElementById(id + '-op');
            const valEl = document.getElementById(id + '-val');
            const val2El = document.getElementById(id + '-val2');
            if(!opEl) return null;

            const op = opEl.value;
            const val = valEl ? valEl.value.trim() : '';
            const val2 = val2El ? val2El.value.trim() : '';

            // Logic to determine if this filter row should be included
            let isActive = false;
            if (op === 'between') {
                isActive = val !== '' && val2 !== '';
            } else if (['!=0', 'isNum', '!=null'].includes(op)) {
                isActive = true; // These don't need user input
            } else {
                isActive = val !== '';
            }

            if (!isActive) return null;

            return {
                logic: id === 'f1' ? 'AND' : document.getElementById(id + '-logic').value,
                field: document.getElementById(id + '-field').value,
                op: op,
                val: val,
                val2: val2
            };
        }).filter(f => f !== null);

        this.state.cachedActiveFields = activeFields;

        let visibleCount = 0;

        this.state.masterData.forEach(row => {
            const key = `${row.exchange}|${row.tradingsymbol}`;
            const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
            const tr = document.getElementById(`row-${safeKey}`);
            if(!tr) return;

            let result = true;
            
            if(this.state.isFilterActive && activeFields.length > 0) {
                let currentResult = null;
                for(const f of activeFields) {
                    const r = this.evaluateCondition(this.getFieldValue(row, key, f.field), f.op, f.val, f.val2);
                    if(currentResult === null) {
                        currentResult = r;
                    } else {
                        if(f.logic === 'AND') currentResult = currentResult && r;
                        else currentResult = currentResult || r;
                    }
                }
                result = currentResult;
            }

            const prevDisplay = tr.style.display;
            if(result) {
                if(prevDisplay !== '') tr.style.display = '';
                visibleCount++;
                const snoEl = tr.querySelector('.s-no');
                if(snoEl && snoEl.innerText != visibleCount) snoEl.innerText = visibleCount;
            } else {
                if(prevDisplay !== 'none') tr.style.display = 'none';
            }
        });
    },

    changeGlobalExpiry(val) {
        this.state.globalExpiry = val || 'Near';
        this.notify(`OI Data synchronized to ${val} Expiry`, "success");

        // Resubscribe to new target expiry futures
        this.subscribeTargetFutures();

        // Sync all expiry-labelled headers
        const lbl = val || 'Near';
        const fnoOiChg  = document.getElementById('fno-oi-chg-header');
        const fnoOiRank = document.getElementById('fno-oi-rank-header');
        const trFutHdr  = document.getElementById('tr-fut-expiry-header');
        if(fnoOiChg)  fnoOiChg.innerHTML  = `OI Change % (${lbl}) ↕`;
        if(fnoOiRank) fnoOiRank.innerHTML = `OI Change Rank (${lbl}) ↕`;
        if(trFutHdr)  trFutHdr.innerText  = `━━ Futures (${lbl} Expiry) ━━`;

        if (this.worker) {
            this.worker.postMessage({ type: 'SET_EXPIRY', data: this.state.globalExpiry });
        }
    },

    // --- Rank Sort Direction Toggle: single button, A (default) ↔ D ---
    toggleSortDirection() {
        this.state.rankSortAsc = !this.state.rankSortAsc;
        const btn = document.getElementById('sort-dir-btn');
        if(!btn) return;
        if(this.state.rankSortAsc) {
            btn.innerText = 'A';
            btn.style.background = 'var(--accent)';
            btn.style.color = '#000';
        } else {
            btn.innerText = 'D';
            btn.style.background = 'var(--loss)';
            btn.style.color = '#fff';
        }
    },

    handleWorkerMessage(e) {
        const { type, rows } = e.data;
        if (type === 'STOCKS_UPDATE') {
            this.state.latestProcessedStocks = rows;
            (rows || []).forEach(row => {
                const key = row.key;
                if (!this.state.liveData[key]) {
                    this.state.liveData[key] = {};
                }
                const live = this.state.liveData[key];
                
                // Copy rankings and other computed values from worker
                if (row.rank_vol !== '-') live.computed_rank_vol = parseInt(row.rank_vol);
                if (row.rank_chg !== '-') live.computed_rank_chg = parseInt(row.rank_chg);
                if (row.rank_abs_chg !== '-') live.computed_rank_abschg = parseInt(row.rank_abs_chg);
                if (row.rank_oi !== '-') live.computed_rank_oi = parseInt(row.rank_oi);
                
                if (row.chg_vol_pc !== '-') {
                    live.computed_chgvolpc = parseFloat(row.chg_vol_pc);
                }
                if (row.near_oi_pc !== '-') {
                    live.computed_oi_chg = parseFloat(row.near_oi_pc);
                }
            });
            if (window.reactState && window.reactState.setStocks) {
                window.reactState.setStocks(rows);
            }
        } else if (type === 'FUTURES_UPDATE') {
            if (window.reactState && window.reactState.setFutures) {
                window.reactState.setFutures(rows);
            }
        }
    },

    // --- Move Top 20 scrips to Trade Ready tab ---
    moveToTradeReady() {
        let stocksToProcess = this.state.latestProcessedStocks;
        if (!stocksToProcess || stocksToProcess.length === 0) {
            if (this.state.masterData && this.state.masterData.length > 0) {
                stocksToProcess = this.state.masterData.map(r => {
                    const key = `${r.exchange}|${r.tradingsymbol}`;
                    const live = this.state.liveData[key] || {};
                    return {
                        key,
                        rank_vol: live.computed_rank_vol !== undefined ? live.computed_rank_vol : 9999,
                        rank_chg: live.computed_rank_chg !== undefined ? live.computed_rank_chg : 9999,
                        rank_abs_chg: live.computed_rank_abschg !== undefined ? live.computed_rank_abschg : 9999,
                        rank_oi: live.computed_rank_oi !== undefined ? live.computed_rank_oi : 9999
                    };
                });
            }
        }

        if(!stocksToProcess || stocksToProcess.length === 0) {
            this.notify("No live data processed yet. Please wait for the grid to update.", "error");
            return;
        }

        const rankFieldSelect = document.getElementById('rank-col-select');
        const rankField = rankFieldSelect ? rankFieldSelect.value : 'rank_vol';
        const isAscending = this.state.rankSortAsc !== false; // default ascending

        // Friendly label for rank field
        const rankLabels = {
            rank_vol:     'Rank of Avg Vol',
            rank_chg:     "Rank of Today's Change",
            rank_abs_chg: 'ABS Change Rank',
            rank_oi:      'OI Change Rank'
        };
        const rankLabel = rankLabels[rankField] || rankField;

        // Build masterData lookup map for row details
        const masterMap = {};
        if (this.state.masterData) {
            this.state.masterData.forEach(r => {
                masterMap[`${r.exchange}|${r.tradingsymbol}`] = r;
                masterMap[r.tradingsymbol] = r;
                masterMap[r.symbol] = r;
            });
        }

        // Collect candidates from processed stocks
        const candidates = [];
        stocksToProcess.forEach(item => {
            const key = item.key;
            const row = masterMap[key] || masterMap[`NSE|${key}`] || masterMap[key.replace('NSE|', '')];
            if (!row) return; // safety check

            const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
            
            // Determine rank value
            let rankVal = 9999;
            if (rankField === 'rank_vol') rankVal = parseFloat(item.rank_vol);
            else if (rankField === 'rank_chg') rankVal = parseFloat(item.rank_chg);
            else if (rankField === 'rank_abs_chg') rankVal = parseFloat(item.rank_abs_chg);
            else if (rankField === 'rank_oi') rankVal = parseFloat(item.rank_oi);

            if (isNaN(rankVal)) rankVal = 9999;

            candidates.push({ row, key, safeKey, rankVal });
        });

        if(candidates.length === 0) {
            this.notify("No visible rows to move. Try clearing filters first.", "error");
            return;
        }

        // Sort by selected rank column
        candidates.sort((a, b) => {
            if (a.rankVal === b.rankVal) {
                return a.key.localeCompare(b.key);
            }
            return isAscending ? (a.rankVal - b.rankVal) : (b.rankVal - a.rankVal);
        });

        // Take top 20
        const top20 = candidates.slice(0, 20);

        // Store them
        this.state.tradeReadyRows = top20;

        // Render Trade Ready table
        this.renderTradeReadyTable(top20, rankLabel, isAscending);

        // Update badge count
        const countEl = document.getElementById('trade-ready-count');
        if(countEl) countEl.innerText = `${top20.length} scrips`;

        // Update sort label
        const labelEl = document.getElementById('trade-ready-sort-label');
        if(labelEl) labelEl.innerText = `Sorted by: ${rankLabel} | ${isAscending ? 'A ↑ Ascending' : 'D ↓ Descending'}`;

        // Flash the trade-ready tab to draw attention and switch to it
        this.switchTab('trade-ready');
        this.notify(`⚡ Top ${top20.length} scrips moved to Trade Ready (${rankLabel}, ${isAscending ? 'Ascending' : 'Descending'})`, "success");
    },

    renderTradeReadyTable(rows, rankLabel = '', isAscending = true) {
        const tb = document.getElementById('trade-ready-body');
        if(!tb) return;

        if(!rows || rows.length === 0) {
            tb.innerHTML = '<tr><td colspan="19" style="text-align:center; color:var(--text-secondary); padding:50px;">No scrips moved yet.</td></tr>';
            return;
        }

        let html = '';
        rows.forEach(({ row, key, safeKey, _trData }, i) => {
            const live = this.state.liveData[key] || {};
            const symbol = row.symbol || key;

            // ── Spot columns ──────────────────────────────────────────────
            const ltp    = live.lp  ? parseFloat(live.lp).toFixed(2)  : '-';
            const pc     = live.pc  ? parseFloat(live.pc).toFixed(2)  : '0';
            const chg    = live.pc && live.lp
                           ? (live.lp - (live.lp / (1 + (live.pc / 100)))).toFixed(2) : '-';
            const isPos  = parseFloat(pc) >= 0;
            const chgVolPc = live.computed_chgvolpc !== undefined
                           ? live.computed_chgvolpc.toFixed(2) + '%' : '-';

            // ── Futures columns (use globalExpiry matching FnO Stocks page) ─
            const targetExpiry = this.state.globalExpiry || 'Near';
            const fut = (this.state.futuresData || []).find(
                f => f.symbol === row.symbol && f.expiry_type === targetExpiry
            );
            let futLtp = '-', futChange = '-', futPc = '-', strikeDiff = '-', lotsize = '-';
            let futIsPos = true;
            if (fut) {
                const futKey  = `${fut.exchange}|${fut.tradingsymbol}`;
                const futKeyAlt = futKey.endsWith('FUT') ? futKey.slice(0, -3) + 'F' : (futKey.endsWith('F') ? futKey.slice(0, -1) + 'FUT' : futKey);
                const futLive = this.state.liveData[futKey] || this.state.liveData[futKeyAlt] || {};
                if (futLive && futLive.lp !== undefined && futLive.lp > 0) {
                    futLtp = parseFloat(futLive.lp).toFixed(2);
                    if (futLive.pc !== undefined) {
                        futPc = parseFloat(futLive.pc).toFixed(2);
                        futChange = (futLive.lp - (futLive.lp / (1 + (futLive.pc / 100)))).toFixed(2);
                    }
                } else if (fut && fut.ltp && fut.ltp > 0) {
                    futLtp = parseFloat(fut.ltp).toFixed(2);
                    futPc = parseFloat(fut.pct_change || fut.change || 0).toFixed(2);
                    futChange = parseFloat(fut.change || 0).toFixed(2);
                } else if (live && live.lp && live.lp > 0) {
                    futLtp = parseFloat(live.lp).toFixed(2);
                    futPc = parseFloat(pc).toFixed(2);
                    futChange = chg !== '-' ? chg : '0.00';
                } else if (row && (row.ltp || row.last_close || row.prev_close)) {
                    const sp = parseFloat(row.ltp || row.last_close || row.prev_close || 0);
                    if (sp > 0) {
                        futLtp = sp.toFixed(2);
                        futPc = (row.chgpc || 0).toFixed(2);
                        futChange = (row.change || 0).toFixed(2);
                    }
                }
                futIsPos   = parseFloat(futPc) >= 0;
                strikeDiff = fut.strike_difference ? parseFloat(fut.strike_difference).toFixed(2) : '-';
                lotsize    = fut.lotsize || row.lotsize || '-';
            } else {
                if (live && live.lp && live.lp > 0) {
                    futLtp = parseFloat(live.lp).toFixed(2);
                    futPc = parseFloat(pc).toFixed(2);
                    futChange = chg !== '-' ? chg : '0.00';
                } else if (row && (row.ltp || row.last_close || row.prev_close)) {
                    const sp = parseFloat(row.ltp || row.last_close || row.prev_close || 0);
                    if (sp > 0) {
                        futLtp = sp.toFixed(2);
                        futPc = (row.chgpc || 0).toFixed(2);
                        futChange = (row.change || 0).toFixed(2);
                    }
                }
                futIsPos = parseFloat(futPc) >= 0;
                lotsize = row.lotsize || '-';
            }

            // ── ATM Strike: nearest strike to Spot LTP using strikes list ──
            let atmStrike = '-';
            const spotLtp  = parseFloat(live.lp);
            if (!isNaN(spotLtp) && spotLtp > 0) {
                if (fut && fut.strikes && fut.strikes.length > 0) {
                    const atmVal = fut.strikes.reduce((prev, curr) => {
                        return Math.abs(curr - spotLtp) < Math.abs(prev - spotLtp) ? curr : prev;
                    });
                    atmStrike = Number(atmVal.toFixed(2)).toString();
                } else {
                    const sDiff = parseFloat(strikeDiff);
                    if (!isNaN(sDiff) && sDiff > 0) {
                        atmStrike = (Math.round(spotLtp / sDiff) * sDiff).toFixed(0);
                    }
                }
            }

            // ── Rank columns (same as FnO Stocks — values already computed) ─
            const rankVol    = live.computed_rank_vol    !== undefined ? live.computed_rank_vol    : '-';
            const rankChg    = live.computed_rank_chg    !== undefined ? live.computed_rank_chg    : '-';
            const rankAbsChg = live.computed_rank_abschg !== undefined ? live.computed_rank_abschg : '-';
            const rankOi     = live.computed_rank_oi     !== undefined ? live.computed_rank_oi     : '-';
            const oiChgPc    = live.computed_oi_chg      !== undefined
                               ? live.computed_oi_chg.toFixed(2) + '%' : '-';

            const profitCls   = isPos ? 'text-profit' : 'text-loss';
            const profitBgCls = isPos ? 'text-profit bg-profit-light' : 'text-loss bg-loss-light';
            const futCls      = futIsPos ? 'text-profit' : 'text-loss';
            const futBgCls    = futIsPos ? 'text-profit bg-profit-light' : 'text-loss bg-loss-light';
            const oiCls       = parseFloat(oiChgPc) > 0 ? 'text-profit bg-profit-light'
                               : parseFloat(oiChgPc) < 0 ? 'text-loss bg-loss-light' : '';

            html += `<tr id="tr-row-${safeKey}">
                <td class="s-no">${i + 1}</td>
                <td style="font-weight:600; text-align:left;" class="${profitCls}">${symbol}</td>
                <td style="font-weight:bold; background:rgba(59,130,246,0.07);" class="${profitCls}">${ltp}</td>
                <td class="${profitBgCls}" style="background:rgba(59,130,246,0.07);">${chg}</td>
                <td class="${profitBgCls}" style="background:rgba(59,130,246,0.07);">${pc}%</td>
                <td style="background:rgba(59,130,246,0.07);">${chgVolPc}</td>
                <td id="tr-futprice-${safeKey}" style="font-weight:bold; background:rgba(251,191,36,0.1); color:var(--accent);">${futLtp}</td>
                <td style="background:rgba(251,191,36,0.07); text-align:right; font-weight:600; color:var(--accent);">${lotsize}</td>
                <td style="background:rgba(251,191,36,0.07); text-align:right;">${strikeDiff}</td>
                <td id="tr-futchange-${safeKey}" class="${futBgCls}" style="background:rgba(251,191,36,0.07);">${futChange}</td>
                <td id="tr-futchgpc-${safeKey}" class="${futBgCls}" style="background:rgba(251,191,36,0.07);">${futPc}%</td>
                <td class="${oiCls}">${oiChgPc}</td>
                <td style="background:rgba(139,92,246,0.08); color:#a78bfa; font-weight:bold;">${rankChg}</td>
                <td style="background:rgba(139,92,246,0.08); color:#a78bfa; font-weight:bold;">${rankVol}</td>
                <td style="background:rgba(139,92,246,0.08); color:#a78bfa; font-weight:bold;">${rankOi}</td>
                <td style="background:rgba(139,92,246,0.08); color:#a78bfa; font-weight:bold;">${rankAbsChg}</td>
                <td style="background:rgba(16,185,129,0.1); color:var(--profit); font-weight:bold; text-align:right;">${atmStrike}</td>
                <td style="text-align:center; vertical-align:middle;">
                    <input type="checkbox" id="tr-sel-${safeKey}" style="width:16px; height:16px; cursor:pointer;">
                </td>
                <td style="text-align:center; vertical-align:middle;">
                    <button class="primary" style="width:auto; padding:3px 12px; font-size:0.8rem;" onclick="app.setOrderContext('${key}')">T</button>
                </td>
            </tr>`;
        });
        tb.innerHTML = html;

        // Sync the group header label to current expiry
        const expLabel = this.state.globalExpiry || 'Near';
        const trHdr = document.getElementById('tr-fut-expiry-header');
        if(trHdr) trHdr.innerText = `━━ Futures (${expLabel} Expiry) ━━`;
    },

    clearTradeReady() {
        this.state.tradeReadyRows = [];
        const tb = document.getElementById('trade-ready-body');
        if(tb) tb.innerHTML = '<tr><td colspan="19" style="text-align:center; color:var(--text-secondary); padding:50px;">Cleared. Use "⚡ Move" on the FnO Stocks tab to populate.</td></tr>';
        const countEl = document.getElementById('trade-ready-count');
        if(countEl) countEl.innerText = '0 scrips';
        const labelEl = document.getElementById('trade-ready-sort-label');
        if(labelEl) labelEl.innerText = '';
        this.notify("Trade Ready list cleared.", "success");
    },

    sortTable(field) {
        if(this.state.sortField !== field) {
            this.state.sortField = field;
            this.state.sortDesc = true;
        } else {
            this.state.sortDesc = !this.state.sortDesc;
        }

        this.state.masterData.sort((a, b) => {
            const keyA = `${a.exchange}|${a.tradingsymbol}`;
            const keyB = `${b.exchange}|${b.tradingsymbol}`;
            const valA = this.getFieldValue(a, keyA, field);
            const valB = this.getFieldValue(b, keyB, field);
            
            if(typeof valA === 'string' && typeof valB === 'string') {
                return this.state.sortDesc ? valB.localeCompare(valA) : valA.localeCompare(valB);
            }
            return this.state.sortDesc ? (valB - valA) : (valA - valB);
        });

        // Re-render and restore live state & filters
        this.renderMasterTable();
        Object.keys(this.state.liveData).forEach(k => this.updateQuote(k, this.state.liveData[k]));
        if(this.state.isFilterActive) this.runFilterLogic();
    },

    setOrderContext(key) {
        // e.g. NSE|EICHERMOT or NSE|360ONE
        const parts = key.split('|');
        const exch = parts[0] || 'NSE';
        const sym = parts[1] || parts[0];
        
        const subExch = document.getElementById('sub-exchange');
        const subSym = document.getElementById('sub-symbol');
        if(subExch) subExch.value = exch;
        if(subSym) subSym.value = sym;

        // Add to Trade Ready rows if not already present
        let targetRow = null;
        if (this.state.masterData) {
            targetRow = this.state.masterData.find(r => `${r.exchange}|${r.tradingsymbol}` === key || r.symbol === sym || r.tradingsymbol === sym);
        }
        if (!targetRow && this.state.masterData) {
            targetRow = { exchange: exch, tradingsymbol: sym, symbol: sym, lotsize: '-' };
        }

        if (targetRow) {
            const masterKey = `${targetRow.exchange || exch}|${targetRow.tradingsymbol || sym}`;
            const safeKey = masterKey.replace(/[^a-zA-Z0-9_-]/g, '_');
            if (!this.state.tradeReadyRows) this.state.tradeReadyRows = [];
            const exists = this.state.tradeReadyRows.some(item => item.key === masterKey || item.key === key);
            if (!exists) {
                this.state.tradeReadyRows.push({ row: targetRow, key: masterKey, safeKey, rankVal: 1 });
            }
            this.renderTradeReadyTable(this.state.tradeReadyRows, 'Selected Scrips', true);
            const countEl = document.getElementById('trade-ready-count');
            if (countEl) countEl.innerText = `${this.state.tradeReadyRows.length} scrips`;
        }
        
        this.notify(`Moved ${sym || key} to Trade Ready & selected for trading`, "success");
        this.switchTab('trade-ready');
    },

    closeAllPositions() {
        if(confirm("Are you sure you want to SQUARE OFF all open positions at Market?")) {
            this.notify("Square Off initiated...", "success");
            // In a full implementation, you'd call a specific /api/square_off route
        }
    },

    switchTab(tabId) {
        this.clearDomCache();
        document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.data-table-container').forEach(el => el.style.display = 'none');
        
        // Map tabId → matching tab button text fragment
        const tabTextMap = {
            'live-data':   'fno',
            'futures':     'futures',
            'positions':   'positions',
            'orders':      'order',
            'trade-ready': 'trade ready',
            'trade-now':   'trade now',
            'trade-terminal': 'terminal'
        };
        const matchText = tabTextMap[tabId] || tabId.split('-')[0];
        const targetTab = Array.from(document.querySelectorAll('.tab')).find(el => el.innerText.toLowerCase().includes(matchText));
        if(targetTab) targetTab.classList.add('active');
        
        const tabEl = document.getElementById('tab-' + tabId);
        if(tabEl) tabEl.style.display = 'block';

        // ── Per-tab UI toggle ──────────────────────────────────────────────
        // FnO filter bar + rank controls: only on FnO Stocks tab
        const filterBar    = document.getElementById('react-control-panel-root');
        const rankControls = document.getElementById('fno-rank-controls');
        const isFnoTab     = tabId === 'live-data';
        if(filterBar)    filterBar.style.display    = isFnoTab ? 'flex' : 'none';
        if(rankControls) rankControls.style.display = isFnoTab ? 'flex' : 'none';

        // Trade Ready filter bar: only on trade-ready tab
        const trFilterBar = document.getElementById('trade-ready-filters');
        if(trFilterBar) trFilterBar.style.display = (tabId === 'trade-ready') ? 'flex' : 'none';
        // ──────────────────────────────────────────────────────────────────

        if(tabId === 'positions') this.refreshPositions();
        if(tabId === 'orders') this.refreshOrders();
        if(tabId === 'trade-now') this.renderTradeNowTable();
        if(tabId === 'trade-exit') this.renderTradeExitTable();
        if(tabId === 'trade-terminal') this.renderTerminalTable();
        if(tabId === 'futures') {
            // Refresh futures data when switching to tab
            if(this.state.futuresData) {
                this.renderFuturesTable();
            } else {
                this.loadFuturesData();
            }
        }
    },

    // ── Trade Ready: sort ──────────────────────────────────────────────────
    sortTradeReady(field) {
        if(!this.state.tradeReadyRows || this.state.tradeReadyRows.length === 0) return;
        if(this.state.trSortField !== field) {
            this.state.trSortField = field;
            this.state.trSortDesc  = true;
        } else {
            this.state.trSortDesc = !this.state.trSortDesc;
        }
        const rows = [...this.state.tradeReadyRows].sort((a, b) => {
            const va = this.getTrFieldValue(a, field);
            const vb = this.getTrFieldValue(b, field);
            if(typeof va === 'string' && typeof vb === 'string')
                return this.state.trSortDesc ? vb.localeCompare(va) : va.localeCompare(vb);
            return this.state.trSortDesc ? ((vb||0) - (va||0)) : ((va||0) - (vb||0));
        });
        this.state.tradeReadyRows = rows;
        this.renderTradeReadyTable(rows);
    },

    // ── Trade Ready: get field value for sort/filter ────────────────────
    getTrFieldValue({ row, key }, field) {
        const live = this.state.liveData[key] || {};
        if(field === 'symbol')     return row.symbol || key;
        if(field === 'ltp')        return parseFloat(live.lp) || 0;
        if(field === 'change')     return live.pc && live.lp ? (live.lp - (live.lp / (1 + (live.pc / 100)))) : 0;
        if(field === 'pc')         return parseFloat(live.pc) || 0;
        if(field === 'chg_vol_pc') return parseFloat(live.computed_chgvolpc) || 0;
        if(field === 'rank_chg')   return parseFloat(live.computed_rank_chg)    || 9999;
        if(field === 'rank_vol')   return parseFloat(live.computed_rank_vol)    || 9999;
        if(field === 'rank_oi')    return parseFloat(live.computed_rank_oi)     || 9999;
        if(field === 'rank_abs_chg') return parseFloat(live.computed_rank_abschg) || 9999;
        if(field === 'oi_chg_pc')  return parseFloat(live.computed_oi_chg) || 0;
        // Futures fields — look up near-expiry future
        const targetExpiry = this.state.globalExpiry || 'Near';
        const fut = (this.state.futuresData || []).find(
            f => f.symbol === row.symbol && f.expiry_type === targetExpiry
        );
        if(field === 'lotsize')     return parseFloat(row.lotsize || (fut && fut.lotsize)) || 0;
        if(field === 'strike_diff') return fut ? parseFloat(fut.strike_difference) || 0 : 0;
        if(fut) {
            const futKey  = `${fut.exchange}|${fut.tradingsymbol}`;
            const futLive = this.state.liveData[futKey] || {};
            const fLTP = parseFloat(futLive.lp || fut.ltp) || 0;
            if(field === 'fut_ltp')    return fLTP;
            if(field === 'fut_change') return futLive.pc ? (fLTP - (fLTP / (1 + (futLive.pc / 100)))) : 0;
            if(field === 'fut_pc')     return parseFloat(futLive.pc || fut.change) || 0;
            if(field === 'atm_strike') {
                const spotLtp = parseFloat(live.lp) || 0;
                if (fut.strikes && fut.strikes.length > 0 && spotLtp > 0) {
                    return fut.strikes.reduce((prev, curr) => {
                        return Math.abs(curr - spotLtp) < Math.abs(prev - spotLtp) ? curr : prev;
                    });
                }
                const sd = parseFloat(fut.strike_difference);
                const baseLtp = spotLtp > 0 ? spotLtp : fLTP;
                return (!isNaN(baseLtp) && !isNaN(sd) && sd > 0) ? Math.round(baseLtp / sd) * sd : 0;
            }
        }
        return 0;
    },

    // ── Trade Ready: filter helpers ────────────────────────────────────
    handleTrOpChange(selectElement) {
        const parts = selectElement.id.split('-');  // e.g. ['tr', 'f1', 'op']
        const id    = parts[0] + '-' + parts[1];    // 'tr-f1'
        const val2  = document.getElementById(id + '-val2');
        if(val2) val2.style.display = selectElement.value === 'between' ? '' : 'none';
    },

    applyTradeReadyFilters() {
        const activeFields = ['tr-f1', 'tr-f2', 'tr-f3', 'tr-f4'].map(id => {
            const opEl  = document.getElementById(id + '-op');
            const valEl = document.getElementById(id + '-val');
            const val2El= document.getElementById(id + '-val2');
            if(!opEl) return null;
            const op = opEl.value, val = valEl ? valEl.value.trim() : '', val2 = val2El ? val2El.value.trim() : '';
            let isActive = false;
            if(op === 'between') isActive = val !== '' && val2 !== '';
            else if(['!=0','isNum','!=null'].includes(op)) isActive = true;
            else isActive = val !== '';
            if(!isActive) return null;
            const logicId = id + '-logic';
            return {
                logic: id === 'tr-f1' ? 'AND' : (document.getElementById(logicId)?.value || 'AND'),
                field: document.getElementById(id + '-field').value,
                op, val, val2
            };
        }).filter(Boolean);

        if(activeFields.length === 0) {
            // No filters – show all
            this.state.tradeReadyRows.forEach((_, idx) => {
                const tr = document.getElementById(`tr-row-${this.state.tradeReadyRows[idx].safeKey}`);
                if(tr) tr.style.display = '';
            });
            return;
        }

        let vi = 0;
        this.state.tradeReadyRows.forEach(item => {
            const tr = document.getElementById(`tr-row-${item.safeKey}`);
            if(!tr) return;
            let result = null;
            for(const f of activeFields) {
                const r = this.evaluateCondition(this.getTrFieldValue(item, f.field), f.op, f.val, f.val2);
                if(result === null) result = r;
                else result = f.logic === 'AND' ? result && r : result || r;
            }
            if(result) { tr.style.display = ''; vi++; const sno = tr.querySelector('.s-no'); if(sno) sno.innerText = vi; }
            else tr.style.display = 'none';
        });
    },

    clearTradeReadyFilters() {
        ['tr-f1','tr-f2','tr-f3','tr-f4'].forEach(id => {
            const v1 = document.getElementById(id + '-val');
            const v2 = document.getElementById(id + '-val2');
            const op = document.getElementById(id + '-op');
            if(v1) v1.value = '';
            if(v2) { v2.value = ''; v2.style.display = 'none'; }
            if(op) op.value = '>';
        });
        this.state.tradeReadyRows.forEach(item => {
            const tr = document.getElementById(`tr-row-${item.safeKey}`);
            if(tr) { tr.style.display = ''; }
        });
        let vi = 0;
        this.state.tradeReadyRows.forEach(item => {
            const tr = document.getElementById(`tr-row-${item.safeKey}`);
            if(tr && tr.style.display !== 'none') { vi++; const sno = tr.querySelector('.s-no'); if(sno) sno.innerText = vi; }
        });
    },

    // ── TRADE NOW ───────────────────────────────────────────────────────────────
    // Sends top-6 visible (post-filter) OR checked rows from Trade Ready to Trade Now
    sendToTradeNow() {
        const rows = this.state.tradeReadyRows || [];
        if(rows.length === 0) {
            this.notify('Trade Ready is empty. Move scrips from FnO Stocks first.', 'error');
            return;
        }

        const methodEl = document.getElementById('tr-send-method');
        const countEl = document.getElementById('tr-send-count');
        const method = methodEl ? methodEl.value : 'checked';
        const sendCount = countEl ? (parseInt(countEl.value) || 6) : 6;
        let selected = [];

        if (method === 'checked') {
            selected = rows.filter(item => {
                const cb = document.getElementById(`tr-sel-${item.safeKey}`);
                return cb && cb.checked;
            });
        } else {
            // Only consider visible (filtered) rows
            let visibleRows = rows.filter(item => {
                const tr = document.getElementById(`tr-row-${item.safeKey}`);
                return tr && tr.style.display !== 'none';
            });
            
            if (method === 'top_abs_change') {
                visibleRows.sort((a,b) => {
                    const lA = this.state.liveData[a.key] || {};
                    const lB = this.state.liveData[b.key] || {};
                    return Math.abs(parseFloat(lB.pc)||0) - Math.abs(parseFloat(lA.pc)||0);
                });
            } else if (method === 'top_change') {
                visibleRows.sort((a,b) => {
                    const lA = this.state.liveData[a.key] || {};
                    const lB = this.state.liveData[b.key] || {};
                    return (parseFloat(lB.pc)||0) - (parseFloat(lA.pc)||0);
                });
            } else if (method === 'top_oi') {
                visibleRows.sort((a,b) => {
                    const lA = this.state.liveData[a.key] || {};
                    const lB = this.state.liveData[b.key] || {};
                    return (parseFloat(lB.computed_oi_chg)||0) - (parseFloat(lA.computed_oi_chg)||0);
                });
            } else if (method === 'top_vol') {
                visibleRows.sort((a,b) => {
                    const lA = this.state.liveData[a.key] || {};
                    const lB = this.state.liveData[b.key] || {};
                    return (parseFloat(lB.computed_chgvolpc)||0) - (parseFloat(lA.computed_chgvolpc)||0);
                });
            } // 'top_visible' keeps current sort

            selected = visibleRows.slice(0, sendCount);
        }

        if(selected.length === 0) {
            this.notify('No rows found based on selected criteria.', 'error');
            return;
        }

        // Build ATM symbols for each selected scrip
        const targetExpiry = this.state.globalExpiry || 'Near';
        this.state.tradeNowRows = selected.map(item => {
            const { row, key } = item;
            const live = this.state.liveData[key] || {};
            const fut  = (this.state.futuresData || []).find(
                f => f.symbol === row.symbol && f.expiry_type === targetExpiry
            );
            const spotLtp  = parseFloat(live.lp) || 0;
            const spotPc   = parseFloat(live.pc) || 0;
            const sd       = fut ? parseFloat(fut.strike_difference) : 0;
            
            let atmStrike = 0;
            if (fut && fut.strikes && fut.strikes.length > 0 && spotLtp > 0) {
                atmStrike = fut.strikes.reduce((prev, curr) => {
                    return Math.abs(curr - spotLtp) < Math.abs(prev - spotLtp) ? curr : prev;
                });
            } else {
                atmStrike = (sd > 0 && spotLtp > 0) ? Math.round(spotLtp / sd) * sd : 0;
            }
            
            const lotsize = fut ? (fut.lotsize || row.lotsize || '-') : (row.lotsize || '-');

            // Build ATM trading symbol for options: NFO format SYMBOLDDMMMYYSTRIKE{CE|PE}
            const expiryDate = fut ? (fut.expiry_date || '') : '';
            const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
            if(expiryDate) {
                try {
                    const parts = expiryDate.split('-');
                    if(parts.length === 3) {
                        let y = parts[0].length === 4 ? parts[0].slice(-2) : parts[2].slice(-2);
                        let mIdx = parseInt(parts[1], 10) - 1;
                        let mStr = (!isNaN(mIdx) && mIdx >= 0 && mIdx < 12) ? months[mIdx] : parts[1].toUpperCase();
                        let dStr = String(parseInt(parts[2].length === 4 ? parts[2] : parts[2], 10)).padStart(2, '0');
                        if (parts[0].length === 4) {
                            // YYYY-MM-DD
                            dStr = String(parseInt(parts[2], 10)).padStart(2, '0');
                            y = parts[0].slice(-2);
                        } else {
                            // DD-MMM-YYYY
                            dStr = String(parseInt(parts[0], 10)).padStart(2, '0');
                            mStr = parts[1].toUpperCase();
                            y = parts[2].slice(-2);
                        }
                        expiryTag = `${dStr}${mStr}${y}`;
                    } else {
                        const d = new Date(expiryDate);
                        expiryTag = `${String(d.getDate()).padStart(2,'0')}${months[d.getMonth()]}${String(d.getFullYear()).slice(-2)}`;
                    }
                } catch(e) { expiryTag = expiryDate.replace(/-/g,'').slice(2); }
            }

            const baseSymbol = row.symbol || '';
            const optType = (spotPc >= 0) ? 'CE' : 'PE';

            return {
                row, key, safeKey: item.safeKey,
                atmStrike, spotLtp, spotPc, expiryTag, baseSymbol, optType,
                exchange: 'NFO',
                strikeDiff: sd,
                lotsize: lotsize,
                strikes: fut ? fut.strikes : []
            };
        });

        // Subscribe all option symbols so live data flows to Trade Entry table
        const hedgeOffset = parseInt(document.getElementById('tn-hedge-offset')?.value) || 1;
        const optSubs = [];
        this.state.tradeNowRows.forEach(item => {
            const { exchange, baseSymbol, expiryTag, atmStrike, strikeDiff } = item;
            ['CE','PE'].forEach(type => {
                optSubs.push(`${exchange}|${this.buildOptionSymbol(baseSymbol, expiryTag, type, atmStrike)}`);
                if(strikeDiff > 0) {
                    const hStrike = this.getHedgeStrike(item, type, hedgeOffset);
                    optSubs.push(`${exchange}|${this.buildOptionSymbol(baseSymbol, expiryTag, type, hStrike)}`);
                }
            });
        });
        if(optSubs.length > 0) {
            fetch(`${API_BASE}/subscribe_bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbols: optSubs })
            }).catch(e => console.error('Option subscribe error', e));
        }

        this.renderTradeNowTable();
        this.switchTab('trade-now');
        this.notify(`▶ ${this.state.tradeNowRows.length} scrips sent to Trade Now`, 'success');
    },


    renderTradeNowTable() {
        this.clearDomCache();
        const tb = document.getElementById('trade-now-body');
        const htb = document.getElementById('trade-now-hedge-body');
        const hs = document.getElementById('trade-now-hedge-section');
        if(!tb) return;
        const rows = this.state.tradeNowRows || [];
        if(rows.length === 0) {
            tb.innerHTML = '<tr><td colspan="18" style="text-align:center;color:var(--text-secondary);padding:60px;">No instruments. Click &#9654; Trade Now from Trade Ready.</td></tr>';
            const countEl = document.getElementById('trade-now-count');
            if(countEl) countEl.innerText = '0 instruments';
            if(hs) hs.style.display = 'none';
            return;
        }
        const hedgeEnabled = document.getElementById('tn-hedge-enable')?.checked === true;
        const hedgeOffset = parseInt(document.getElementById('tn-hedge-offset')?.value) || 0;
        let html = '', hedgeHtml = '', sno = 0, hedgeSno = 0;
        rows.forEach((item, itemIndex) => {
            const { row, key, atmStrike, exchange, baseSymbol, expiryTag, optType, strikeDiff, lotsize } = item;
            const renderRow = (symbol, type, isHedge, strike, rowSno) => {
                const optKey = exchange + '|' + symbol;
                const ol = this.state.liveData[optKey] || {};
                
                const roundToTick = (val, tickSize = 0.05) => {
                    if (val === null || val === undefined || isNaN(val)) return '-';
                    return (Math.round(parseFloat(val) / tickSize) * tickSize).toFixed(2);
                };

                // Compute fallback baseline option prices if live tick is pending
                let estLtp = null;
                if (item.spotLtp && strike > 0) {
                    const sLtp = parseFloat(item.spotLtp);
                    const strk = parseFloat(strike);
                    const intrinsic = (type === 'CE') ? Math.max(0, sLtp - strk) : Math.max(0, strk - sLtp);
                    const timeVal = sLtp * 0.015;
                    estLtp = intrinsic > 0 ? (intrinsic + timeVal) : (timeVal > 0 ? timeVal : 10.0);
                }

                const ltp  = ol.lp  ? roundToTick(ol.lp)  : (estLtp !== null ? roundToTick(estLtp) : '-');
                const bid  = ol.bp1 ? roundToTick(ol.bp1) : (estLtp !== null ? roundToTick(estLtp * 0.995) : '-');
                const ask  = ol.sp1 ? roundToTick(ol.sp1) : (estLtp !== null ? roundToTick(estLtp * 1.005) : '-');
                const high = ol.h   ? roundToTick(ol.h)   : (estLtp !== null ? roundToTick(estLtp * 1.05) : '-');
                const low  = ol.l   ? roundToTick(ol.l)   : (estLtp !== null ? roundToTick(estLtp * 0.95) : '-');
                const pc   = ol.pc  ? parseFloat(ol.pc).toFixed(2)  : (item.spotPc !== undefined ? parseFloat(item.spotPc).toFixed(2) : '0.00');
                const chg  = (ol.lp && ol.pc) ? (ol.lp - ol.lp/(1+ol.pc/100)).toFixed(2) : (estLtp !== null && pc ? (estLtp * (parseFloat(pc) / 100)).toFixed(2) : '0.00');
                const oi   = ol.oi  || '-';
                const isPos = parseFloat(pc) >= 0;
                const pcCls = isPos ? 'text-profit' : 'text-loss';
                const bgCls = isPos ? 'bg-profit-light' : 'bg-loss-light';
                let bg = type==='CE' ? 'background:rgba(59,130,246,0.12);color:#93c5fd;' : 'background:rgba(248,81,73,0.12);color:#f87171;';
                if(isHedge) bg += 'border-left:3px solid #6366f1;';
                const sk = optKey.replace(/[^a-zA-Z0-9_-]/g,'_');
                const rid = 'tn-row-'+(isHedge?'hedge':'main')+'-'+sk;
                const prefix = isHedge ? 'hedge' : 'main';
                const status = isHedge ? (item.hedgeStatus || 'Inactive') : (item.mainStatus || 'Inactive');
                const orderId = isHedge ? (item.hedgeOrderId || '-') : (item.mainOrderId || '-');
                const doneAt = isHedge ? (item.hedgeDoneAt || '-') : (item.mainDoneAt || '-');
                const remarks = isHedge ? (item.hedgeRemarks || '') : (item.mainRemarks || '');
                
                // Read current values from item (state) or use default
                const qtyVal = isHedge ? (item.hedgeQty !== undefined ? item.hedgeQty : lotsize) : (item.mainQty !== undefined ? item.mainQty : lotsize);
                const sideVal = isHedge ? (item.hedgeSide || '') : (item.mainSide || '');
                const signalVal = isHedge ? (item.hedgeSignal || '') : (item.mainSignal || '');
                const limitVal = isHedge ? (item.hedgeLimit || '') : (item.mainLimit || '');

                const isEntryDisabled = status === 'Pending' || status === 'Active' || status === 'Closed' || status === 'Submitting';
                const entryDisableAttr = isEntryDisabled ? 'disabled' : '';
                const isLimitPriceDisabled = isEntryDisabled || signalVal !== 'Limit';
                const limitPriceDisableAttr = isLimitPriceDisabled ? 'disabled' : '';

                let submitBtn = '';
                if (status === 'Inactive' || status === 'Rejected' || status === 'Canceled') {
                    submitBtn = '<button class="primary" onclick="app.submitTradeEntry(\''+optKey+'\',\''+symbol+'\','+lotsize+','+isHedge+')" style="padding:3px 10px;font-size:0.75rem;background:var(--profit);border:none;border-radius:4px;cursor:pointer;color:#fff;">Buy</button>';
                } else if (status === 'Pending') {
                    submitBtn = '<button class="primary" onclick="app.cancelTradeEntry('+itemIndex+','+isHedge+')" style="padding:3px 6px;font-size:0.75rem;background:var(--accent);color:#000;border:none;border-radius:4px;cursor:pointer;font-weight:700;" title="Click to cancel pending order">Pndng/Cncl</button>';
                } else {
                    let btnColor = 'var(--text-secondary)';
                    if (status === 'Active') btnColor = 'var(--profit)';
                    submitBtn = '<button class="primary" style="padding:3px 10px;font-size:0.75rem;background:'+btnColor+';border:none;border-radius:4px;color:#fff;opacity:0.6;cursor:not-allowed;" disabled>'+status+'</button>';
                }

                return '<tr id="'+rid+'">' +
                    '<td class="s-no">'+rowSno+'</td>' +
                    '<td style="font-weight:700;text-align:left;'+bg+'">'+symbol+' <span style="font-size:0.7rem;padding:1px 4px;border-radius:3px;background:'+(type==='CE'?'rgba(59,130,246,0.3)':'rgba(248,81,73,0.3)')+'">'+type+'</span>'+(isHedge?' <span style="font-size:0.65rem;background:#6366f1;color:#fff;padding:1px 4px;border-radius:2px;">Hedge</span>':'')+'</td>' +
                    '<td id="tn-bid-'+prefix+'-'+sk+'" style="color:#93c5fd;">'+bid+'</td>' +
                    '<td id="tn-ask-'+prefix+'-'+sk+'" style="color:#f87171;">'+ask+'</td>' +
                    '<td id="tn-ltp-'+prefix+'-'+sk+'" style="font-weight:bold;">'+ltp+'</td>' +
                    '<td id="tn-high-'+prefix+'-'+sk+'">'+high+'</td>' +
                    '<td id="tn-low-'+prefix+'-'+sk+'">'+low+'</td>' +
                    '<td id="tn-chg-'+prefix+'-'+sk+'" class="'+(chg!=='-'?bgCls:'')+'">'+chg+'</td>' +
                    '<td id="tn-pc-'+prefix+'-'+sk+'" class="'+pcCls+'">'+(pc!=='-'?pc+'%':'-')+'</td>' +
                    '<td><input type="number" id="te-qty-'+prefix+'-'+sk+'" value="'+qtyVal+'" onchange="app.updateTradeNowField('+itemIndex+','+isHedge+',\'qty\',this.value)" '+entryDisableAttr+' style="width:55px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);text-align:center;"></td>' +
                    '<td><select id="te-side-'+prefix+'-'+sk+'" onchange="app.updateTradeNowField('+itemIndex+','+isHedge+',\'side\',this.value); app.handleEntrySignalChange(\''+prefix+'\',\''+sk+'\')" '+entryDisableAttr+' style="padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);">' +
                        '<option value="" '+(sideVal===''?'selected':'')+' disabled>Select</option>' +
                        '<option value="BUY" '+(sideVal==='BUY'?'selected':'')+'>Buy</option>' +
                        '<option value="SELL" '+(sideVal==='SELL'?'selected':'')+'>Sell</option>' +
                    '</select></td>' +
                    '<td><select id="te-signal-'+prefix+'-'+sk+'" onchange="app.updateTradeNowField('+itemIndex+','+isHedge+',\'signal\',this.value); app.handleEntrySignalChange(\''+prefix+'\',\''+sk+'\')" '+entryDisableAttr+' style="padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);">' +
                        '<option value="" '+(signalVal===''?'selected':'')+' disabled>Select</option>' +
                        '<option value="Market" '+(signalVal==='Market'?'selected':'')+'>Market</option>' +
                        '<option value="LTP" '+(signalVal==='LTP'?'selected':'')+'>LTP</option>' +
                        '<option value="Limit" '+(signalVal==='Limit'?'selected':'')+'>Limit</option>' +
                    '</select></td>' +
                    '<td><input type="number" id="te-limit-'+prefix+'-'+sk+'" step="0.05" '+limitPriceDisableAttr+' value="'+limitVal+'" onchange="app.updateTradeNowField('+itemIndex+','+isHedge+',\'limit\',this.value)" style="width:65px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);text-align:center;"></td>' +
                    '<td id="te-done-'+prefix+'-'+sk+'">'+doneAt+'</td>' +
                    '<td id="te-orderid-'+prefix+'-'+sk+'">'+orderId+'</td>' +
                    '<td id="te-remarks-'+prefix+'-'+sk+'" style="font-weight:bold;font-size:0.75rem;">'+remarks+'</td>' +
                    '<td id="tn-oi-'+prefix+'-'+sk+'">'+oi+'</td>' +
                    '<td>'+submitBtn+'</td>' +
                    '<td style="text-align:center;"><input type="checkbox" id="tn-select-'+prefix+'-'+sk+'" '+(prefix === 'main' ? (item.mainChecked !== false ? 'checked' : '') : (item.hedgeChecked !== false ? 'checked' : ''))+' onchange="app.toggleSelectRow('+itemIndex+','+isHedge+',this.checked)" style="width:14px; height:14px; cursor:pointer;"></td>' +
                '</tr>';
            };
            sno++;
            html += renderRow(this.buildOptionSymbol(baseSymbol, expiryTag, optType, atmStrike), optType, false, atmStrike, sno);
            if(hedgeEnabled && strikeDiff > 0 && atmStrike > 0) {
                hedgeSno++;
                const hType = optType==='CE'?'PE':'CE';
                const hStrike = this.getHedgeStrike(item, hType, hedgeOffset);
                hedgeHtml += renderRow(this.buildOptionSymbol(baseSymbol, expiryTag, hType, hStrike), hType, true, hStrike, hedgeSno);
            }
        });
        tb.innerHTML = html || '<tr><td colspan="18" style="text-align:center;color:var(--text-secondary);padding:30px;">No rows.</td></tr>';
        if(hs && htb) {
            if(hedgeEnabled && hedgeHtml) { hs.style.display='block'; htb.innerHTML=hedgeHtml; const hc=document.getElementById('trade-now-hedge-count'); if(hc) hc.innerText=hedgeSno+' hedges'; }
            else hs.style.display='none';
        }
        const countEl = document.getElementById('trade-now-count');
        if(countEl) countEl.innerText = sno+' instruments';

        // Replay cached live ticks so LTP/Bid/Ask/High/Low/Change are immediately
        // visible without waiting for the next websocket tick
        if (this.state.liveData) {
            Object.keys(this.state.liveData).forEach(k => this.updateQuote(k, this.state.liveData[k]));
        }
    },

    updateTradeNowField(index, isHedge, field, value) {
        const item = this.state.tradeNowRows[index];
        if (!item) return;
        const prefix = isHedge ? 'hedge' : 'main';
        const status = item[prefix + 'Status'] || 'Inactive';
        const isEntryDisabled = status === 'Pending' || status === 'Active' || status === 'Closed' || status === 'Submitting';
        if (isEntryDisabled) return;

        if (field === 'qty') {
            item[prefix + 'Qty'] = parseInt(value) || 0;
        } else if (field === 'side') {
            item[prefix + 'Side'] = value;
        } else if (field === 'signal') {
            item[prefix + 'Signal'] = value;
        } else if (field === 'limit') {
            item[prefix + 'Limit'] = value;
        }
    },

    handleEntrySignalChange(prefix, sk) {
        const signalEl = document.getElementById('te-signal-' + prefix + '-' + sk);
        const limitEl = document.getElementById('te-limit-' + prefix + '-' + sk);
        const ltpEl = document.getElementById('tn-ltp-' + prefix + '-' + sk);
        const bidEl = document.getElementById('tn-bid-' + prefix + '-' + sk);
        const askEl = document.getElementById('tn-ask-' + prefix + '-' + sk);
        const sideEl = document.getElementById('te-side-' + prefix + '-' + sk);
        if (!signalEl || !limitEl) return;

        const val = signalEl.value;
        const side = sideEl ? sideEl.value : '';

        // Find matching item in state by resolving option safe key for main or hedge
        const itemIndex = (this.state.tradeNowRows || []).findIndex(item => {
            const mainSym = this.buildOptionSymbol(item.baseSymbol, item.expiryTag, item.optType, item.atmStrike);
            const mainKey = item.exchange + '|' + mainSym;
            const mainSk = mainKey.replace(/[^a-zA-Z0-9_-]/g, '_');
            if (mainSk === sk) return true;

            if (item.strikeDiff > 0 && item.atmStrike > 0) {
                const hedgeOffset = parseInt(document.getElementById('tn-hedge-offset')?.value) || 0;
                const hType = item.optType === 'CE' ? 'PE' : 'CE';
                const hStrike = this.getHedgeStrike(item, hType, hedgeOffset);
                const hedgeSym = this.buildOptionSymbol(item.baseSymbol, item.expiryTag, hType, hStrike);
                const hedgeKey = item.exchange + '|' + hedgeSym;
                const hedgeSk = hedgeKey.replace(/[^a-zA-Z0-9_-]/g, '_');
                if (hedgeSk === sk) return true;
            }
            return false;
        });
        const item = itemIndex !== -1 ? this.state.tradeNowRows[itemIndex] : null;
        const exchange = item ? item.exchange : '';
        const tick = exchange === 'CDS' ? 0.0025 : 0.05;
        const decimals = exchange === 'CDS' ? 4 : 2;
        
        let limitVal = '';
        if (!val || val === '') {
            limitEl.disabled = true;
            limitVal = '';
        } else if (val === 'Market') {
            limitEl.disabled = true;
            if (side === 'BUY') {
                const bidVal = bidEl ? parseFloat(bidEl.innerText) : 0;
                const ltpVal = ltpEl ? parseFloat(ltpEl.innerText) : 0;
                const bestBuy = bidVal > 0 ? bidVal : ltpVal;
                const price = bestBuy > 0 ? bestBuy + tick : 0;
                limitVal = price > 0 ? price.toFixed(decimals) : '';
            } else {
                const askVal = askEl ? parseFloat(askEl.innerText) : 0;
                const ltpVal = ltpEl ? parseFloat(ltpEl.innerText) : 0;
                const bestSell = askVal > 0 ? askVal : ltpVal;
                const price = bestSell > 0 ? bestSell - tick : 0;
                limitVal = price > 0 ? price.toFixed(decimals) : '';
            }
        } else if (val === 'LTP') {
            limitEl.disabled = true;
            if (ltpEl) {
                const ltpVal = parseFloat(ltpEl.innerText);
                limitVal = !isNaN(ltpVal) ? ltpVal.toFixed(decimals) : '';
            }
        } else if (val === 'Limit') {
            limitEl.disabled = false;
            limitVal = limitEl.value;
        }
        limitEl.value = limitVal;

        // Sync to state
        if (item) {
            item[prefix + 'Limit'] = limitVal;
            item[prefix + 'Signal'] = val;
            if (side) item[prefix + 'Side'] = side;
        }
    },

    async submitTradeEntry(optKey, symbol, lotsize, isHedge) {
        const sk = optKey.replace(/[^a-zA-Z0-9_-]/g,'_');
        const prefix = isHedge ? 'hedge' : 'main';
        const sideEl = document.getElementById('te-side-'+prefix+'-'+sk);
        const signalEl = document.getElementById('te-signal-'+prefix+'-'+sk);
        const limitEl = document.getElementById('te-limit-'+prefix+'-'+sk);
        const qtyEl = document.getElementById('te-qty-'+prefix+'-'+sk);
        const remarksEl = document.getElementById('te-remarks-'+prefix+'-'+sk);
        const side = sideEl ? sideEl.value : '';
        const signal = signalEl ? signalEl.value : '';
        const limit = limitEl ? parseFloat(limitEl.value)||0 : 0;
        const qty = qtyEl ? parseInt(qtyEl.value) : lotsize;
        const exchange = optKey.split('|')[0];

        if (!side || side === '') {
            this.notify('Please select BUY/SELL side first.', 'error');
            return;
        }
        if (!signal || signal === '') {
            this.notify('Please select Entry Signal first.', 'error');
            return;
        }

        // Retrieve live quote details for computing dynamic prices
        const live = this.state.liveData[optKey] || {};
        const ltp = live.lp ? parseFloat(live.lp) : 0;
        const bBuy = live.bp1 ? parseFloat(live.bp1) : ltp;
        const bSell = live.sp1 ? parseFloat(live.sp1) : ltp;
        const tick = exchange === 'CDS' ? 0.0025 : 0.05;
        const dec = exchange === 'CDS' ? 4 : 2;

        const slippageVal = parseFloat(document.getElementById('tn-exec-slippage')?.value) || 3.0;
        const slippageTolerance = slippageVal / 100.0;
        const timeout = parseFloat(document.getElementById('tn-exec-timeout')?.value) || 10;
        const maxRetries = parseInt(document.getElementById('tn-exec-retries')?.value) || 5;

        let executionMode = null;
        if (signal === 'Market') {
            executionMode = side === 'BUY' ? 'Aggressive_Entry' : 'Aggressive_Exit';
        } else if (signal === 'LTP') {
            executionMode = 'True_Limit_LTP';
        }

        let orderPrice = 0;
        if (signal === 'Market') {
            if (side === 'BUY') {
                const refAnchor = (ltp > 0 || bBuy > 0) ? Math.max(ltp, bBuy) : limit;
                const upperBound = Math.floor((refAnchor * (1.0 + slippageTolerance)) / tick) * tick;
                const targetPx = bBuy > 0 ? (bBuy + tick) : ltp;
                orderPrice = upperBound > 0 ? Math.min(targetPx, upperBound) : targetPx;
            } else {
                const refAnchor = (ltp > 0 && bSell > 0) ? Math.min(ltp, bSell) : (ltp > 0 ? ltp : (bSell > 0 ? bSell : limit));
                const lowerBound = Math.max(tick, Math.ceil((refAnchor * (1.0 - slippageTolerance)) / tick) * tick);
                const targetPx = bSell > 0 ? (bSell - tick) : ltp;
                orderPrice = Math.max(targetPx, lowerBound);
            }
        } else if (signal === 'LTP') {
            orderPrice = ltp;
        } else {
            orderPrice = limit;
        }

        orderPrice = parseFloat(orderPrice.toFixed(dec));

        if (orderPrice <= 0) {
            this.notify('Invalid order price calculated. Waiting for live tick data.', 'error');
            return;
        }

        const match = (this.state.tradeNowRows || []).find(item => {
            const mainSym = this.buildOptionSymbol(item.baseSymbol, item.expiryTag, item.optType, item.atmStrike);
            if (mainSym === symbol) return true;
            if (item.strikeDiff > 0) {
                const hedgeOffset = parseInt(document.getElementById('tn-hedge-offset')?.value) || 0;
                const hType = item.optType==='CE'?'PE':'CE';
                const hStrike = this.getHedgeStrike(item, hType, hedgeOffset);
                const hedgeSym = this.buildOptionSymbol(item.baseSymbol, item.expiryTag, hType, hStrike);
                if (hedgeSym === symbol) return true;
            }
            return false;
        });

        if (match) {
            if (isHedge) {
                match.hedgeStatus = 'Submitting';
                match.hedgeRemarks = 'Submitting...';
            } else {
                match.mainStatus = 'Submitting';
                match.mainRemarks = 'Submitting...';
            }
            this.renderTradeNowTable();
        }

        try {
            if(remarksEl) { remarksEl.innerText='Submitting...'; remarksEl.style.color='var(--text-secondary)'; }
            const res = await fetch(API_BASE+'/place_order', { method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ 
                    exchange, 
                    symbol, 
                    quantity: qty, 
                    buy_or_sell: side, 
                    order_type: 'LIMIT', 
                    price: orderPrice,
                    execution_mode: executionMode,
                    limit_price_trigger: signal === 'Limit' ? orderPrice : 0,
                    slippage_tolerance: slippageTolerance,
                    timeout: timeout,
                    max_retries: maxRetries
                }) 
            });
            if (!res.ok) {
                let errMsg = 'HTTP Error ' + res.status;
                if (res.status === 401) errMsg = 'Not Logged In';
                throw new Error(errMsg);
            }
            const data = await res.json();
            if(data.status==='success') {
                if (match) {
                    if (isHedge) {
                        match.hedgeOrderId = data.order_id;
                        match.hedgeStatus = 'Pending';
                        match.hedgeRemarks = 'Pending';
                    } else {
                        match.mainOrderId = data.order_id;
                        match.mainStatus = 'Pending';
                        match.mainRemarks = 'Pending';
                    }
                }

                // Duplicate prevention: merge if same contract active/pending exists
                const existing = this.state.tradeExitRows.find(r => r.optKey === optKey && r.status !== 'Closed');
                if (existing) {
                    existing.orderId = data.order_id;
                    existing.lastAddedQty = qty;
                    existing.qty += qty;
                    existing.status = 'Pending';
                } else {
                    this.state.tradeExitRows.push({ 
                        orderId: data.order_id, 
                        optKey, 
                        symbol, 
                        lotsize, 
                        status: 'Pending', 
                        entryAt: 0, 
                        qty, 
                        side, 
                        isHedge: !!isHedge, 
                        target: '', 
                        slType: '', 
                        slValue: '', 
                        tsl: false, 
                        moveToCostAt: '', 
                        initialSL: '', 
                        latestSL: '', 
                        exitAt: '',
                        exitMode: '',
                        exitPrice: '',
                        lastAddedQty: 0
                    });
                }

                // Check and apply pending order updates immediately
                if (this.state.pendingOrderUpdates && this.state.pendingOrderUpdates[data.order_id]) {
                    this.applyOrderUpdate(this.state.pendingOrderUpdates[data.order_id]);
                }

                this.resubscribeAll();
                this.renderTradeNowTable();
                this.renderTradeExitTable();
                this.notify(symbol+' order submitted (ID:'+data.order_id+')', 'success');
            } else {
                const shortMsg = shortenBrokerMessage(data.message);
                if (match) {
                    if (isHedge) {
                        match.hedgeStatus = 'Rejected';
                        match.hedgeRemarks = shortMsg;
                    } else {
                        match.mainStatus = 'Rejected';
                        match.mainRemarks = shortMsg;
                    }
                }
                this.renderTradeNowTable();
                if(remarksEl) { remarksEl.innerText=shortMsg; remarksEl.style.color='var(--loss)'; }
                this.notify('Order failed: '+shortMsg, 'error');
            }
        } catch(e) {
            const errMsg = e.message || 'Error';
            if (match) {
                if (isHedge) {
                    match.hedgeStatus = 'Rejected';
                    match.hedgeRemarks = errMsg;
                } else {
                    match.mainStatus = 'Rejected';
                    match.mainRemarks = errMsg;
                }
            }
            this.renderTradeNowTable();
            if(remarksEl) { remarksEl.innerText=errMsg; remarksEl.style.color='var(--loss)'; }
            this.notify('Failed to submit order: '+errMsg,'error');
        }
    },

    async cancelTradeEntry(itemIndex, isHedge) {
        const item = this.state.tradeNowRows[itemIndex];
        if (!item) return;
        const prefix = isHedge ? 'hedge' : 'main';
        const orderId = item[prefix + 'OrderId'];
        if (!orderId) {
            this.notify("No active order ID found to cancel", "error");
            return;
        }

        const symbol = isHedge ? (item.hedgeSymbol || item.baseSymbol) : (item.mainSymbol || item.baseSymbol);
        
        item[prefix + 'Remarks'] = 'Cancelling...';
        this.renderTradeNowTable();

        try {
            const res = await fetch(API_BASE + '/cancel_order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    order_id: orderId,
                    symbol: symbol
                })
            });
            const data = await res.json();
            if (data.status === 'success') {
                this.notify(`Pending order ${orderId} cancelled`, "success");
                item[prefix + 'Status'] = 'Canceled';
                item[prefix + 'Remarks'] = 'Cancelled by User';
                
                // Clean up any pending position in tradeExitRows
                const exitIdx = (this.state.tradeExitRows || []).findIndex(r => r.orderId === orderId);
                if (exitIdx !== -1) {
                    const exitRow = this.state.tradeExitRows[exitIdx];
                    if (exitRow.status === 'Pending') {
                        this.state.tradeExitRows.splice(exitIdx, 1);
                        this.renderTradeExitTable();
                    }
                }
                this.renderTradeNowTable();
            } else {
                this.notify(`Cancel failed: ${data.message}`, "error");
                item[prefix + 'Remarks'] = 'Cancel Failed';
                this.renderTradeNowTable();
            }
        } catch (e) {
            console.error("Cancel order error", e);
            this.notify(`Error cancelling order: ` + (e.message || ''), "error");
            item[prefix + 'Remarks'] = 'Cancel Error';
            this.renderTradeNowTable();
        }
    },

    clearTradeNow() {
        this.state.tradeNowRows = [];
        const tb = document.getElementById('trade-now-body');
        if(tb) tb.innerHTML = '<tr><td colspan="18" style="text-align:center;color:var(--text-secondary);padding:60px;">Cleared.</td></tr>';
        const c = document.getElementById('trade-now-count'); if(c) c.innerText='0 instruments';
        const hs = document.getElementById('trade-now-hedge-section'); if(hs) hs.style.display='none';
        const htb = document.getElementById('trade-now-hedge-body'); if(htb) htb.innerHTML='';
        this.notify('Trade Entry cleared.','success');
    },

    toggleSelectAllMain(checked) {
        (this.state.tradeNowRows || []).forEach(item => {
            item.mainChecked = checked;
        });
        const checkboxes = document.querySelectorAll('input[id^="tn-select-main-"]');
        checkboxes.forEach(cb => cb.checked = checked);
    },

    toggleSelectAllHedge(checked) {
        (this.state.tradeNowRows || []).forEach(item => {
            item.hedgeChecked = checked;
        });
        const checkboxes = document.querySelectorAll('input[id^="tn-select-hedge-"]');
        checkboxes.forEach(cb => cb.checked = checked);
    },

    toggleSelectRow(index, isHedge, checked) {
        const item = this.state.tradeNowRows[index];
        if (item) {
            const prefix = isHedge ? 'hedge' : 'main';
            item[prefix + 'Checked'] = checked;
        }
    },

    toggleTradeExitCancelChecked(index, checked) {
        const item = this.state.tradeExitRows[index];
        if (item) {
            item.cancelChecked = checked;
        }
    },

    async cancelSelectedTrades() {
        const rows = this.state.tradeExitRows || [];
        const toCancel = [];
        rows.forEach((item, index) => {
            if (item.status === 'Pending' && item.cancelChecked === true) {
                toCancel.push({ item, index });
            }
        });

        if (toCancel.length === 0) {
            this.notify("No pending trades checked for cancellation.", "error");
            return;
        }

        if (!confirm(`Cancel ${toCancel.length} checked pending order(s)?`)) {
            return;
        }

        // Optimistic update
        toCancel.forEach(task => {
            task.item.status = 'Canceled';
            task.item.cancelChecked = false; // reset
            
            // Also optimistically update matching rows on the Trade Entry (tradeNowRows) page
            const orderId = task.item.orderId;
            const entryRow = (this.state.tradeNowRows || []).find(r => r.mainOrderId === orderId || r.hedgeOrderId === orderId);
            if (entryRow) {
                if (entryRow.mainOrderId === orderId) {
                    entryRow.mainStatus = 'Canceled';
                    entryRow.mainRemarks = 'Canceled';
                } else {
                    entryRow.hedgeStatus = 'Canceled';
                    entryRow.hedgeRemarks = 'Canceled';
                }
            }
        });
        this.renderTradeNowTable();
        this.renderTradeExitTable();

        await Promise.all(toCancel.map(async task => {
            try {
                const res = await fetch(API_BASE + '/cancel_order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        order_id: task.item.orderId,
                        symbol: task.item.symbol
                    })
                });
                if (!res.ok) {
                    let errMsg = 'HTTP Error ' + res.status;
                    if (res.status === 401) errMsg = 'Not Logged In';
                    throw new Error(errMsg);
                }
                const data = await res.json();
                if (data.status === 'success') {
                    this.notify(`${task.item.symbol} order cancelled`, "success");
                } else {
                    this.notify(`Failed to cancel ${task.item.symbol}: ${data.message}`, "error");
                }
            } catch (e) {
                console.error("Cancel order error", e);
                this.notify(`Error cancelling ${task.item.symbol}: ` + (e.message || ''), "error");
            }
        }));

        this.renderTradeExitTable();
    },

    async submitBulkTradeEntry() {
        const sideEl = document.getElementById('tn-bulk-side');
        const signalEl = document.getElementById('tn-bulk-signal');
        if (!sideEl || !sideEl.value) {
            this.notify("Select Bulk Side first", "error");
            return;
        }
        if (!signalEl || !signalEl.value) {
            this.notify("Select Bulk Signal first", "error");
            return;
        }
        const bulkSide = sideEl.value;
        const bulkSignal = signalEl.value;

        // Collect all checked main rows that are Inactive/Rejected/Canceled
        const mainRowsToSubmit = [];
        (this.state.tradeNowRows || []).forEach((item, index) => {
            if (item.mainChecked !== false) { // checked by default
                const status = item.mainStatus || 'Inactive';
                if (status === 'Inactive' || status === 'Rejected' || status === 'Canceled') {
                    mainRowsToSubmit.push({ item, index, isHedge: false });
                }
            }
        });

        // Collect all checked hedge rows that are Inactive/Rejected/Canceled
        const hedgeEnabled = document.getElementById('tn-hedge-enable')?.checked === true;
        const hedgeRowsToSubmit = [];
        if (hedgeEnabled) {
            (this.state.tradeNowRows || []).forEach((item, index) => {
                if (item.strikeDiff > 0 && item.atmStrike > 0) {
                    if (item.hedgeChecked !== false) { // checked by default
                        const status = item.hedgeStatus || 'Inactive';
                        if (status === 'Inactive' || status === 'Rejected' || status === 'Canceled') {
                            hedgeRowsToSubmit.push({ item, index, isHedge: true });
                        }
                    }
                }
            });
        }

        const allToSubmit = [...mainRowsToSubmit, ...hedgeRowsToSubmit];
        if (allToSubmit.length === 0) {
            this.notify("No checked rows are eligible for entry.", "error");
            return;
        }

        // Set status to 'Submitting' for all eligible rows in state
        allToSubmit.forEach(task => {
            const prefix = task.isHedge ? 'hedge' : 'main';
            task.item[prefix + 'Status'] = 'Submitting';
            task.item[prefix + 'Remarks'] = 'Submitting...';
            // Sync bulk parameters to state as well
            task.item[prefix + 'Side'] = bulkSide;
            task.item[prefix + 'Signal'] = bulkSignal;
        });

        // Re-render once to show 'Submitting...' status in the table
        this.renderTradeNowTable();

        // Submit all orders in parallel
        await Promise.all(allToSubmit.map(async task => {
            const item = task.item;
            const prefix = task.isHedge ? 'hedge' : 'main';
            let symbol = '';
            if (task.isHedge) {
                const hedgeOffset = parseInt(document.getElementById('tn-hedge-offset')?.value) || 0;
                const hType = item.optType === 'CE' ? 'PE' : 'CE';
                const hStrike = this.getHedgeStrike(item, hType, hedgeOffset);
                symbol = this.buildOptionSymbol(item.baseSymbol, item.expiryTag, hType, hStrike);
            } else {
                symbol = this.buildOptionSymbol(item.baseSymbol, item.expiryTag, item.optType, item.atmStrike);
            }

            const optKey = item.exchange + '|' + symbol;
            const live = this.state.liveData[optKey] || this.state.liveData[symbol] || this.state.liveData[`${item.exchange}|${item.token}`] || {};
            
            // Extract price from live stream or table row attributes
            const ltp = live.lp ? parseFloat(live.lp) : (parseFloat(item.ltp) || parseFloat(item.best_sell) || parseFloat(item.best_buy) || 0);
            const bBuy = live.bp1 ? parseFloat(live.bp1) : (parseFloat(item.best_buy) || ltp);
            const bSell = live.sp1 ? parseFloat(live.sp1) : (parseFloat(item.best_sell) || ltp);
            const tick = item.exchange === 'CDS' ? 0.0025 : 0.05;
            const dec = item.exchange === 'CDS' ? 4 : 2;

            const slippageVal = parseFloat(document.getElementById('tn-exec-slippage')?.value) || 3.0;
            const slippageTolerance = slippageVal / 100.0;
            const timeout = parseFloat(document.getElementById('tn-exec-timeout')?.value) || 10;
            const maxRetries = parseInt(document.getElementById('tn-exec-retries')?.value) || 5;

            let orderPrice = 0;
            if (bulkSignal === 'Market') {
                if (bulkSide === 'BUY') {
                    const refAnchor = (ltp > 0 || bBuy > 0) ? Math.max(ltp, bBuy) : 0.05;
                    const upperBound = Math.floor((refAnchor * (1.0 + slippageTolerance)) / tick) * tick;
                    const targetPx = bBuy > 0 ? (bBuy + tick) : ltp;
                    orderPrice = upperBound > 0 ? Math.min(targetPx, upperBound) : targetPx;
                } else {
                    const refAnchor = (ltp > 0 && bSell > 0) ? Math.min(ltp, bSell) : (ltp > 0 ? ltp : (bSell > 0 ? bSell : 0.05));
                    const lowerBound = Math.max(tick, Math.ceil((refAnchor * (1.0 - slippageTolerance)) / tick) * tick);
                    const targetPx = bSell > 0 ? (bSell - tick) : ltp;
                    orderPrice = Math.max(targetPx, lowerBound);
                }
            } else if (bulkSignal === 'LTP') {
                orderPrice = ltp;
            } else {
                const limitVal = parseFloat(item[prefix + 'Limit']) || 0;
                orderPrice = limitVal > 0 ? limitVal : ltp;
            }

            if (orderPrice <= 0) {
                orderPrice = parseFloat(item.ltp) || parseFloat(item.best_buy) || parseFloat(item.best_sell) || 0.05;
            }

            orderPrice = parseFloat(orderPrice.toFixed(dec));

            if (orderPrice <= 0) {
                item[prefix + 'Status'] = 'Rejected';
                item[prefix + 'Remarks'] = 'Waiting for Price Ticks';
                return;
            }

            const qty = item[prefix + 'Qty'] || item.lotsize;
            
            let executionMode = bulkSignal;
            if (executionMode === 'Market') executionMode = 'Aggressive_Entry';
            
            const limitPriceTrigger = parseFloat(item[prefix + 'Limit']) || 0;

            try {
                const res = await fetch(API_BASE + '/place_order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        exchange: item.exchange,
                        symbol: symbol,
                        quantity: qty,
                        buy_or_sell: bulkSide,
                        order_type: 'LIMIT',
                        price: orderPrice,
                        execution_mode: executionMode,
                        limit_price_trigger: limitPriceTrigger > 0 ? limitPriceTrigger : orderPrice,
                        slippage_tolerance: slippageTolerance,
                        timeout: timeout,
                        max_retries: maxRetries
                    })
                });
                if (!res.ok) {
                    let errMsg = 'HTTP Error ' + res.status;
                    if (res.status === 401) errMsg = 'Not Logged In';
                    throw new Error(errMsg);
                }
                const data = await res.json();
                if (data.status === 'success') {
                    item[prefix + 'OrderId'] = data.order_id;
                    item[prefix + 'Status'] = 'Pending';
                    item[prefix + 'Remarks'] = 'Pending';

                    // Add to tradeExitRows
                    const existing = this.state.tradeExitRows.find(r => r.optKey === optKey && r.status !== 'Closed');
                    if (existing) {
                        existing.orderId = data.order_id;
                        existing.lastAddedQty = qty;
                        existing.qty += qty;
                        existing.status = 'Pending';
                    } else {
                        this.state.tradeExitRows.push({
                            orderId: data.order_id,
                            optKey,
                            symbol,
                            lotsize: item.lotsize,
                            status: 'Pending',
                            entryAt: 0,
                            qty,
                            side: bulkSide,
                            isHedge: task.isHedge,
                            target: '',
                            slType: '',
                            slValue: '',
                            tsl: false,
                            moveToCostAt: '',
                            initialSL: '',
                            latestSL: '',
                            exitAt: '',
                            exitMode: '',
                            exitPrice: '',
                            lastAddedQty: 0
                        });
                    }

                    // Check and apply pending order updates immediately
                    if (this.state.pendingOrderUpdates && this.state.pendingOrderUpdates[data.order_id]) {
                        this.applyOrderUpdate(this.state.pendingOrderUpdates[data.order_id]);
                    }
                } else {
                    const shortMsg = shortenBrokerMessage(data.message);
                    item[prefix + 'Status'] = 'Rejected';
                    item[prefix + 'Remarks'] = shortMsg;
                }
            } catch (e) {
                item[prefix + 'Status'] = 'Rejected';
                item[prefix + 'Remarks'] = e.message || 'Error';
            }
        }));

        // Final re-render to update the tables with orders placed
        this.resubscribeAll();
        this.renderTradeNowTable();
        this.renderTradeExitTable();
        this.notify("Bulk orders submitted successfully.", "success");
    },

    renderTradeExitTable() {
        this.clearDomCache();
        const tb = document.getElementById('trade-exit-body');
        const htb = document.getElementById('trade-exit-hedge-body');
        const hs = document.getElementById('trade-exit-hedge-section');
        if(!tb) return;
        const rows = this.state.tradeExitRows || [];
        if(rows.length===0) {
            tb.innerHTML='<tr><td colspan="24" style="text-align:center;color:var(--text-secondary);padding:60px;">No active or pending trades to manage.</td></tr>';
            const c=document.getElementById('trade-exit-count'); if(c) c.innerText='0 trades';
            if(hs) hs.style.display='none'; return;
        }
        let mainHtml='', hedgeHtml='', mainCount=0, hedgeCount=0;
        for (let index = rows.length - 1; index >= 0; index--) {
            const item = rows[index];
            const live = this.state.liveData[item.optKey] || {};
            const ltp = live.lp ? parseFloat(live.lp) : 0;
            const entry = parseFloat(item.entryAt) || 0;
            const lots  = parseInt(item.lotsize) || 1;
            const slVal = parseFloat(item.slValue) || 0;
            const isBuy = item.side === 'BUY';
            const isClosed = item.status === 'Closed';
            const isEnded = item.status === 'Closed' || item.status === 'Rejected' || item.status === 'Canceled';

            let chg2e=0, pct2e=0, totP='-', targetPrice='-';
            if (isClosed && item.exitAt && entry > 0) {
                const exitPx = parseFloat(item.exitAt) || 0;
                chg2e = isBuy ? (exitPx - entry) : (entry - exitPx);
                pct2e = (chg2e / entry) * 100;
                totP  = (chg2e * item.qty).toFixed(2);
            } else if (!isEnded && ltp > 0 && entry > 0) {
                chg2e = isBuy ? (ltp - entry) : (entry - ltp);
                pct2e = (chg2e / entry) * 100;
                totP  = (chg2e * item.qty).toFixed(2);
            }
            // Compute target price level from ₹ target input
            if(item.target !== '' && parseFloat(item.target) > 0 && entry > 0) {
                const tgtRs = parseFloat(item.target);
                const qty = parseInt(item.qty) || 1;
                targetPrice = (isBuy ? entry + tgtRs/qty : entry - tgtRs/qty).toFixed(2);
            }

            const isPos = chg2e>=0;
            const chgCls = isPos ? 'text-profit' : 'text-loss';
            const type = this.getOptionType(item.symbol);
            let bg = type === 'CE'
                ? 'background:rgba(59,130,246,0.12);color:#93c5fd;'
                : (type === 'PE' ? 'background:rgba(248,81,73,0.12);color:#f87171;' : '');
            if (item.isHedge) bg += 'border-left:3px solid #6366f1;';
            const sno = item.isHedge ? hedgeCount+1 : mainCount+1;
            // Closed rows: dim everything, disable all inputs
            const rowStyle = isEnded
                ? 'opacity:0.5; background:rgba(0,0,0,0.25); pointer-events:none;'
                : '';
            const disabledAll = isEnded ? 'disabled' : '';

            const actionBtn = isEnded
                ? '<button disabled style="padding:3px 14px;font-size:0.75rem;background:rgba(180,0,0,0.25);' +
                  'border:1px solid var(--loss);border-radius:4px;color:var(--loss);cursor:not-allowed;font-weight:700;">' +
                  (item.status === 'Closed' ? '⛔ Closed' : item.status === 'Rejected' ? '❌ Rejected' : '⚠ Canceled') + '</button>'
                : (item.exitPending
                    ? '<button class="primary" style="padding:3px 10px;font-size:0.75rem;background:var(--accent);color:#000;" onclick="app.toggleExitPending('+index+')">Waiting</button>'
                    : '<button class="primary" style="padding:3px 10px;font-size:0.75rem;background:var(--loss);" onclick="app.toggleExitPending('+index+')">EXIT</button>');

            const exitMode = item.exitMode || '';
            const priceVal = exitMode === 'Price' ? (item.exitPrice || '') : '';
            const isPriceDisabled = (isEnded || exitMode !== 'Price' || item.exitPending) ? 'disabled' : '';
            const isSlValueDisabled = (isEnded || item.slType === 'No SL') ? 'disabled' : '';

            // Latest SL color: green if TSL active, amber if initial-only, grey if no SL
            const latestSLColor = item.tsl ? 'var(--profit)' : (item.latestSL ? 'var(--accent)' : 'var(--text-secondary)');
            // Status color
            const statColor = isEnded ? 'var(--loss)' : item.status==='Active' ? 'var(--profit)' : item.status==='Pending' ? 'var(--accent)' : 'var(--loss)';
            const sideColor = isBuy ? 'var(--profit)' : 'var(--loss)';
            // Closed row: strikethrough on entry/exit prices
            const closedDecor = isEnded ? 'text-decoration:line-through;' : '';

            const r = '<tr id="te-row-'+index+'" style="'+rowStyle+'">' +
                // ── Identity & Status ──────────────────────────────────────
                '<td class="s-no">'+sno+'</td>' +
                '<td style="font-weight:700;text-align:left;'+bg+closedDecor+'">'+item.symbol+(type ? ' <span style="font-size:0.7rem;padding:1px 4px;border-radius:3px;background:'+(type==='CE'?'rgba(59,130,246,0.3)':'rgba(248,81,73,0.3)')+'">'+type+'</span>' : '')+(item.isHedge?' <span style="font-size:0.65rem;background:#6366f1;color:#fff;padding:1px 4px;border-radius:2px;">Hedge</span>':'')+'</td>' +
                '<td style="text-align:center;">'+item.qty+'</td>' +
                '<td style="font-weight:700;color:'+sideColor+';text-align:center;">'+(item.side||'-')+'</td>' +
                '<td id="te-status-'+index+'" style="font-weight:bold;color:'+statColor+'">'+(item.status === 'Closed' ? '⛔ Closed' : item.status === 'Rejected' ? '❌ Rejected' : item.status === 'Canceled' ? '⚠ Canceled' : item.status)+'</td>' +
                // ── Live P&L ───────────────────────────────────────────────
                '<td style="font-weight:bold;'+closedDecor+'">'+(entry||'-')+'</td>' +
                '<td id="te-ltp-'+index+'" style="font-weight:bold;color:var(--accent);">'+(ltp>0?ltp.toFixed(2):'-')+'</td>' +
                '<td id="te-chg2e-'+index+'" class="'+chgCls+'">'+(chg2e!==0?chg2e.toFixed(2):'-')+'</td>' +
                '<td id="te-pct2e-'+index+'" class="'+chgCls+'">'+(pct2e!==0?pct2e.toFixed(2)+'%':'-')+'</td>' +
                '<td id="te-totp-'+index+'" class="'+chgCls+'" style="font-weight:bold;">'+totP+'</td>' +
                // ── SL Block: Type → Value(₹) → SL Price → TSL → Latest SL → SL2Cost ──
                '<td><select onchange="app.updateTradeExitField('+index+',\'slType\',this.value)" style="padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);">' +
                    '<option value=""'+(item.slType===''?' selected':'')+' disabled>Select</option>' +
                    '<option value="No SL"'+(item.slType==='No SL'?' selected':'')+'>No SL</option>' +
                    '<option value="SL by total loss"'+(item.slType==='SL by total loss'?' selected':'')+'>By Tot Loss</option>' +
                '</select></td>' +
                '<td><input type="number" id="te-slval-'+index+'" value="'+item.slValue+'" onchange="app.updateTradeExitField('+index+',\'slValue\',this.value)" onkeydown="app.handleSlValKeydown(event, '+index+')" '+isSlValueDisabled+' style="width:60px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);text-align:center;"></td>' +
                '<td id="te-initialsl-'+index+'" style="color:var(--accent);font-weight:bold;text-align:right;">'+(item.initialSL!==''?item.initialSL:'-')+'</td>' +
                '<td style="text-align:center;"><input type="checkbox" title="Trailing Stop Loss" onchange="app.updateTradeExitField('+index+',\'tsl\',this.checked)"'+(item.tsl?' checked':'')+'></td>' +
                '<td id="te-latestsl-'+index+'" style="color:'+latestSLColor+';font-weight:bold;text-align:right;">'+(item.latestSL!==''?item.latestSL:'-')+'</td>' +
                '<td><input type="number" value="'+item.moveToCostAt+'" onchange="app.updateTradeExitField('+index+',\'moveToCostAt\',this.value)" style="width:60px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);"></td>' +
                // ── Target Block: Target(₹) → Tgt Price ───────────────────
                '<td><input type="number" value="'+item.target+'" onchange="app.updateTradeExitField('+index+',\'target\',this.value)" style="width:65px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);"></td>' +
                '<td id="te-tgtprice-'+index+'" style="color:var(--profit);font-weight:bold;text-align:right;">'+targetPrice+'</td>' +
                // ── Exit Controls ──────────────────────────────────────────
                '<td><select id="te-add-exit-'+index+'" onchange="app.handleAddExitAction(this,'+index+')"'+(item.status==='Closed'?' disabled':'')+' style="padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);"><option value="" disabled selected>Select</option><option value="Add">Add</option><option value="Exit">Exit</option></select></td>' +
                '<td><select id="te-exit-mode-'+index+'" onchange="app.handleExitModeChange('+index+')"'+(item.exitPending||item.status==='Closed'?' disabled':'')+' style="padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);">' +
                    '<option value=""'+(exitMode===''?' selected':'')+' disabled>Select</option>' +
                    '<option value="LTP"'+(exitMode==='LTP'?' selected':'')+'>By LTP</option>' +
                    '<option value="Price"'+(exitMode==='Price'?' selected':'')+'>By Price</option>' +
                    '<option value="Market"'+(exitMode==='Market'?' selected':'')+'>Market</option>' +
                '</select></td>' +
                '<td><input type="number" id="te-exit-price-'+index+'" '+isPriceDisabled+' value="'+priceVal+'" onchange="app.updateTradeExitField('+index+',\'exitPrice\',parseFloat(this.value)||0)" placeholder="Price" style="width:65px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);"></td>' +
                '<td id="te-exitat-'+index+'" style="color:var(--profit);font-weight:bold;text-align:right;">'+(item.exitAt!==''?item.exitAt:'-')+'</td>' +
                '<td><input type="checkbox" onchange="app.toggleTradeExitCancelChecked('+index+', this.checked)"'+(item.status==='Pending'?'':' disabled')+(item.cancelChecked?' checked':'')+' style="width:16px;height:16px;"></td>' +
                '<td>'+actionBtn+'</td>' +
            '</tr>';
            if(item.isHedge) { hedgeCount++; hedgeHtml+=r; } else { mainCount++; mainHtml+=r; }
        }
        tb.innerHTML = mainHtml||'<tr><td colspan="24" style="text-align:center;color:var(--text-secondary);padding:60px;">No active trades.</td></tr>';
        const ce=document.getElementById('trade-exit-count'); if(ce) ce.innerText=mainCount+' trades';
        if(hs && htb) {
            if(hedgeHtml) { hs.style.display='block'; htb.innerHTML=hedgeHtml; const hc=document.getElementById('trade-exit-hedge-count'); if(hc) hc.innerText=hedgeCount+' hedges'; }
            else hs.style.display='none';
        }
        this.updateTotalMtm();
        
        // Update master checkbox states dynamically
        const activeMainRows = rows.filter(r => !r.isHedge && (r.status === 'Active' || r.status === 'Pending'));
        const activeHedgeRows = rows.filter(r => r.isHedge && (r.status === 'Active' || r.status === 'Pending'));
        
        const mainMasterEl = document.getElementById('te-master-tsl');
        if (mainMasterEl) {
            mainMasterEl.checked = activeMainRows.length > 0 && activeMainRows.every(r => r.tsl);
        }
        const hedgeMasterEl = document.getElementById('te-master-tsl-hedge');
        if (hedgeMasterEl) {
            hedgeMasterEl.checked = activeHedgeRows.length > 0 && activeHedgeRows.every(r => r.tsl);
        }
    },

    roundToNseTick(val) {
        if (val === undefined || val === null || val === '' || isNaN(val)) return '';
        return (Math.round(parseFloat(val) * 20) / 20).toFixed(2);
    },

    // Helper: compute Initial SL price from ₹ total loss
    computeInitialSLPrice(row) {
        const entry = parseFloat(row.entryAt) || 0;
        const slVal = parseFloat(row.slValue) || 0;
        const qty = parseInt(row.qty) || 1;
        if (entry <= 0 || slVal <= 0) return '';
        // SL Value = total ₹ loss for this trade
        // Price per share/unit = slVal / qty
        const slPts = slVal / qty;
        if (row.side === 'BUY') return this.roundToNseTick(entry - slPts);
        else                    return this.roundToNseTick(entry + slPts);
    },

    updateTradeExitField(index, field, value) {
        const r = this.state.tradeExitRows[index];
        if(r) {
            r[field] = value;
            // Whenever slValue or slType changes, recompute initialSL as a price
            if (field === 'slValue' || field === 'slType') {
                if (r.slType !== 'No SL' && r.slType !== '' && r.slValue !== '') {
                    r.initialSL = this.computeInitialSLPrice(r);
                    // Only reset latestSL if TSL is not yet trailing
                    if (r.latestSL === '') r.latestSL = r.initialSL;
                } else if (r.slType === 'No SL') {
                    r.slValue = '';
                    r.initialSL = '';
                    r.latestSL = '';
                }
                this.renderTradeExitTable();
            } else if (field === 'tsl') {
                if (value) {
                    if (r.latestSL === '' && r.initialSL !== '') r.latestSL = r.initialSL;
                } else {
                    r.latestSL = '';
                }
                this.renderTradeExitTable();
            }
        }
    },

    toggleMasterTSL(checked) {
        if (!this.state.tradeExitRows) return;
        this.state.tradeExitRows.forEach((item, index) => {
            if (!item.isHedge && (item.status === 'Active' || item.status === 'Pending')) {
                item.tsl = checked;
                if (checked) {
                    if (item.latestSL === '' && item.initialSL !== '') {
                        item.latestSL = item.initialSL;
                    }
                } else {
                    item.latestSL = '';
                }
            }
        });
        this.renderTradeExitTable();
    },

    toggleMasterTSLHedge(checked) {
        if (!this.state.tradeExitRows) return;
        this.state.tradeExitRows.forEach((item, index) => {
            if (item.isHedge && (item.status === 'Active' || item.status === 'Pending')) {
                item.tsl = checked;
                if (checked) {
                    if (item.latestSL === '' && item.initialSL !== '') {
                        item.latestSL = item.initialSL;
                    }
                } else {
                    item.latestSL = '';
                }
            }
        });
        this.renderTradeExitTable();
    },

    updateTradeExitLiveValues(index) {
        const item = this.state.tradeExitRows[index];
        if (!item) return;

        const live = this.state.liveData[item.optKey] || {};
        const ltp  = live.lp ? parseFloat(live.lp) : 0;

        const elLtp    = document.getElementById(`te-ltp-${index}`);
        const elChg2e  = document.getElementById(`te-chg2e-${index}`);
        const elPct2e  = document.getElementById(`te-pct2e-${index}`);
        const elTotp   = document.getElementById(`te-totp-${index}`);
        const elInitial= document.getElementById(`te-initialsl-${index}`);
        const elLatest = document.getElementById(`te-latestsl-${index}`);
        const elExitAt = document.getElementById(`te-exitat-${index}`);
        const elStatus = document.getElementById(`te-status-${index}`);

        // Always update LTP
        if (elLtp) elLtp.innerText = ltp > 0 ? ltp.toFixed(2) : '-';

        if (item.status === 'Closed') {
            // ── Frozen display for closed rows ──────────────────────────
            const exitPx = parseFloat(item.exitAt) || 0;
            const entry  = parseFloat(item.entryAt) || 0;
            const isBuy  = item.side === 'BUY';
            if (exitPx > 0 && entry > 0) {
                const frozenChg = isBuy ? (exitPx - entry) : (entry - exitPx);
                const frozenPct = (frozenChg / entry) * 100;
                const frozenPl  = (frozenChg * (item.qty || 0)).toFixed(2);
                const cls = frozenChg >= 0 ? 'text-profit' : 'text-loss';
                if (elChg2e) { elChg2e.innerText = frozenChg.toFixed(2); elChg2e.className = cls; }
                if (elPct2e) { elPct2e.innerText = frozenPct.toFixed(2) + '%'; elPct2e.className = cls; }
                if (elTotp)  { elTotp.innerText  = '₹' + frozenPl; elTotp.className = cls + ' text-bold'; }
            }
            if (elExitAt) elExitAt.innerText = item.exitAt || '-';
            if (elStatus) { elStatus.innerText = '⛔ Closed'; elStatus.style.color = 'var(--loss)'; }
            this.updateTotalMtm();
            return;  // ← do NOT keep live-updating a closed row
        }

        // ── Live updates for open rows ───────────────────────────────────
        // Do not auto-populate Exit Price; user must enter it manually
        const elExitMode  = document.getElementById(`te-exit-mode-${index}`);
        const elExitPrice = document.getElementById(`te-exit-price-${index}`);
        if (elExitMode && elExitPrice && elExitMode.value !== 'Price') {
            elExitPrice.value = '';
            item.exitPrice = '';
        }

        let chg2e = 0, pct2e = 0;
        if (ltp > 0 && item.entryAt > 0) {
            chg2e = item.side === 'BUY' ? (ltp - item.entryAt) : (item.entryAt - ltp);
            pct2e = (chg2e / item.entryAt) * 100;
        }
        const isPos  = chg2e >= 0;
        const chgCls = isPos ? 'text-profit' : 'text-loss';
        const totP   = item.entryAt > 0 && ltp > 0 ? (chg2e * item.qty).toFixed(2) : '-';

        if (elChg2e) { elChg2e.innerText = chg2e !== 0 ? chg2e.toFixed(2) : '-'; elChg2e.className = chgCls; }
        if (elPct2e) { elPct2e.innerText = pct2e !== 0 ? pct2e.toFixed(2) + '%' : '-'; elPct2e.className = chgCls; }
        if (elTotp)  { elTotp.innerText  = totP; elTotp.className = chgCls + ' text-bold'; }
        if (elInitial) elInitial.innerText = item.initialSL !== '' ? item.initialSL : '-';
        if (elLatest) {
            elLatest.innerText   = item.latestSL !== '' ? item.latestSL : '-';
            elLatest.style.color = item.tsl ? 'var(--profit)' : 'var(--text-secondary)';
        }
        if (elExitAt) elExitAt.innerText = item.exitAt !== '' ? item.exitAt : '-';
        if (elStatus) {
            const statColor = item.status === 'Active' ? 'var(--profit)' : item.status === 'Pending' ? 'var(--accent)' : 'var(--loss)';
            elStatus.innerText    = item.status;
            elStatus.style.color  = statColor;
        }
        this.updateTotalMtm();
    },

    updateTotalMtm() {
        let mainTotal = 0, mainOpen = 0;
        let hedgeTotal = 0, hedgeOpen = 0;
        let capitalBlocked = 0;

        (this.state.tradeExitRows || []).forEach(item => {
            let pl = 0;
            const isOpen = item.status === 'Active' || item.status === 'Pending';
            const isClosed = item.status === 'Closed';

            if (isClosed) {
                const exitPx = parseFloat(item.exitAt) || 0;
                const entry  = parseFloat(item.entryAt) || 0;
                if (exitPx > 0 && entry > 0) {
                    const chg = item.side === 'BUY' ? (exitPx - entry) : (entry - exitPx);
                    pl = chg * (item.qty || 0);
                }
            } else if (isOpen) {
                const live = this.state.liveData[item.optKey] || {};
                const ltp  = live.lp ? parseFloat(live.lp) : 0;
                if (ltp > 0 && item.entryAt > 0) {
                    const c = item.side === 'BUY' ? (ltp - item.entryAt) : (item.entryAt - ltp);
                    pl = c * (item.qty || 0);
                }
                const entry = parseFloat(item.entryAt) || 0;
                const qty = parseFloat(item.qty) || 0;
                capitalBlocked += entry * qty;
            }

            if (item.isHedge) {
                hedgeTotal += pl;
                if (isOpen) hedgeOpen += pl;
            } else {
                mainTotal += pl;
                if (isOpen) mainOpen += pl;
            }
        });

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.innerText = (val >= 0 ? '₹' : '-₹') + Math.abs(val).toFixed(2);
            el.style.color = val >= 0 ? 'var(--profit)' : 'var(--loss)';
        };

        // Main table header
        set('te-total-pl',      mainTotal);
        set('te-open-pl',       mainOpen);
        // Hedge table header
        set('te-hedge-total-pl', hedgeTotal);
        set('te-hedge-open-pl',  hedgeOpen);
        // Legacy id (te-table-mtm replaced by te-total-pl, keep for safety)
        set('te-table-mtm', mainTotal + hedgeTotal);

        // Capital Blocked
        const capEl = document.getElementById('te-capital-blocked');
        if (capEl) {
            capEl.innerText = '₹' + capitalBlocked.toFixed(2);
        }
    },

    handleSlValKeydown(event, index) {
        if (event.key === 'Enter') {
            event.preventDefault();

            // Find next enabled input BEFORE the re-render wipes the DOM
            const allBefore = Array.from(
                document.querySelectorAll('[id^="te-slval-"]:not([disabled])')
            );
            const pos = allBefore.indexOf(event.target);
            const nextPos = pos + 1;

            // Commit value — this triggers renderTradeExitTable() which rebuilds the DOM
            const val = parseFloat(event.target.value) || 0;
            this.updateTradeExitField(index, 'slValue', val);

            // Re-query AFTER render and focus the element at the same visual position
            setTimeout(() => {
                const allAfter = Array.from(
                    document.querySelectorAll('[id^="te-slval-"]:not([disabled])')
                );
                if (nextPos < allAfter.length) {
                    allAfter[nextPos].focus();
                    allAfter[nextPos].select();
                }
            }, 0);
        }
    },

    handleTerminalSlValKeydown(event, index) {
        if (event.key === 'Enter') {
            event.preventDefault();

            // Record position BEFORE render wipes the DOM
            const allBefore = Array.from(
                document.querySelectorAll('[id^="term-slval-"]:not([disabled])')
            );
            const pos = allBefore.indexOf(event.target);
            const nextPos = pos + 1;

            // Commit value — triggers renderTerminalTable() which rebuilds DOM
            const val = parseFloat(event.target.value) || 0;
            this.updateTerminalField(index, 'slValue', val);

            // Re-query after render and focus next element
            setTimeout(() => {
                const allAfter = Array.from(
                    document.querySelectorAll('[id^="term-slval-"]:not([disabled])')
                );
                if (nextPos < allAfter.length) {
                    allAfter[nextPos].focus();
                    allAfter[nextPos].select();
                }
            }, 0);
        }
    },

    handleAddExitAction(selectEl, index) {
        if (selectEl.value === 'Exit') {
            selectEl.value = '';
            this.toggleExitPending(index);
        } else if (selectEl.value === 'Add') {
            selectEl.value = '';
            this.openAddModal(index);   // ← open popup instead of duplicating
        }
    },

    // ─── Add Position Modal ───────────────────────────────────────────────────

    openAddModal(index) {
        const row = this.state.tradeExitRows[index];
        if (!row) return;

        // Store reference index so submitAddPosition knows which row to update
        this._addModalIndex = index;

        // Pre-fill read-only info
        const [exchange, symbol] = (row.optKey || '').split('|');
        document.getElementById('add-modal-symbol').value   = row.symbol   || symbol || '';
        document.getElementById('add-modal-exchange').value = exchange || '';
        document.getElementById('add-modal-lotsize').value  = row.lotsize  || '';
        document.getElementById('add-modal-entryat').value  = row.entryAt  || '-';
        document.getElementById('add-modal-subtitle').innerText =
            'Adding to: ' + row.symbol + ' | Side: ' + (row.side || '') + ' | Current Qty: ' + row.qty;

        // Reset editable fields
        document.getElementById('add-modal-qty').value    = row.lotsize || '';
        document.getElementById('add-modal-side').value   = row.side    || '';
        document.getElementById('add-modal-signal').value = '';
        document.getElementById('add-modal-limit').value  = '';
        document.getElementById('add-modal-limit').disabled = true;
        document.getElementById('add-modal-slvalue').value  = row.slValue  || '';
        document.getElementById('add-modal-target').value   = row.target   || '';
        document.getElementById('add-modal-sl2cost').value  = row.moveToCostAt || '';
        document.getElementById('add-modal-tsl').checked   = row.tsl || false;

        // Reset status box
        const sb = document.getElementById('add-modal-status-box');
        if (sb) sb.innerHTML = '<span style="font-size:0.75rem;color:var(--text-secondary);font-style:italic;">Fill in fields above and click Submit.</span>';

        // Show live prices
        this.addModalLiveUpdate();

        // Open modal
        const modal = document.getElementById('add-position-modal');
        if (modal) { modal.style.display = 'flex'; }
    },

    closeAddModal() {
        const modal = document.getElementById('add-position-modal');
        if (modal) modal.style.display = 'none';
        this._addModalIndex = null;
    },

    addModalLiveUpdate() {
        // Called on every tick if modal is open — refreshes price strip
        const modal = document.getElementById('add-position-modal');
        if (!modal || modal.style.display === 'none') return;
        const index = this._addModalIndex;
        if (index == null) return;
        const row = (this.state.tradeExitRows || [])[index];
        if (!row) return;
        const live = this.state.liveData[row.optKey] || {};
        const set = (id, val, fallback) => {
            const el = document.getElementById(id);
            if (el) el.innerText = val !== undefined && val !== '' ? val : fallback;
        };
        set('add-modal-ltp',  live.lp  ? parseFloat(live.lp).toFixed(2)  : null, '—');
        set('add-modal-bid',  live.bp1 ? parseFloat(live.bp1).toFixed(2) : null, '—');
        set('add-modal-ask',  live.sp1 ? parseFloat(live.sp1).toFixed(2) : null, '—');
        set('add-modal-high', live.h   ? parseFloat(live.h).toFixed(2)   : null, '—');
        set('add-modal-low',  live.l   ? parseFloat(live.l).toFixed(2)   : null, '—');
        set('add-modal-oi',   live.oi  || null, '—');
    },

    addModalSignalChange() {
        const signalEl = document.getElementById('add-modal-signal');
        const limitEl  = document.getElementById('add-modal-limit');
        const sideEl   = document.getElementById('add-modal-side');
        const ltpEl    = document.getElementById('add-modal-ltp');
        if (!signalEl || !limitEl) return;
        const val  = signalEl.value;
        const side = sideEl ? sideEl.value : '';
        const index= this._addModalIndex;
        const live = index != null ? (this.state.liveData[(this.state.tradeExitRows[index]||{}).optKey] || {}) : {};

        limitEl.disabled = true;
        limitEl.value = '';
        if (val === 'Market') {
            const p = side === 'BUY'
                ? (parseFloat(live.bp1||0) > 0 ? parseFloat(live.bp1) + 0.05 : parseFloat(live.lp||0))
                : (parseFloat(live.sp1||0) > 0 ? parseFloat(live.sp1) - 0.05 : parseFloat(live.lp||0));
            limitEl.value = p > 0 ? p.toFixed(2) : '';
        } else if (val === 'LTP') {
            limitEl.value = live.lp ? parseFloat(live.lp).toFixed(2) : '';
        } else if (val === 'Limit') {
            limitEl.disabled = false;
        }
    },

    addModalRefreshPrice() {
        // Re-compute limit price when side changes
        const signalEl = document.getElementById('add-modal-signal');
        if (signalEl && signalEl.value) this.addModalSignalChange();
    },

    async submitAddPosition() {
        const index = this._addModalIndex;
        if (index == null) { this.notify('No trade selected', 'error'); return; }
        const row = this.state.tradeExitRows[index];
        if (!row) { this.notify('Trade row not found', 'error'); return; }

        const qty    = parseInt(document.getElementById('add-modal-qty').value)    || 0;
        const side   = document.getElementById('add-modal-side').value;
        const signal = document.getElementById('add-modal-signal').value;
        const limit  = parseFloat(document.getElementById('add-modal-limit').value) || 0;
        const slVal  = document.getElementById('add-modal-slvalue').value;
        const target = document.getElementById('add-modal-target').value;
        const sl2c   = document.getElementById('add-modal-sl2cost').value;
        const tsl    = document.getElementById('add-modal-tsl').checked;

        // Validation
        const sb = document.getElementById('add-modal-status-box');
        const setStatus = (msg, color) => {
            if (sb) sb.innerHTML = '<span style="font-size:0.8rem;font-weight:700;color:'+color+';">'+msg+'</span>';
        };
        if (!qty || qty <= 0)  { setStatus('⚠ Enter a valid quantity.', 'var(--accent)'); return; }
        if (!side)             { setStatus('⚠ Select Side (BUY / SELL).', 'var(--accent)'); return; }
        if (!signal)           { setStatus('⚠ Select Order Type.', 'var(--accent)'); return; }
        if (signal === 'Limit' && (!limit || limit <= 0)) { setStatus('⚠ Enter Limit Price.', 'var(--accent)'); return; }

        const [exchange, symbol] = (row.optKey || '').split('|');
        const tick = exchange === 'CDS' ? 0.0025 : 0.05;
        const dec = exchange === 'CDS' ? 4 : 2;
        const orderType = 'LIMIT';

        let orderPrice = 0;
        if (signal === 'Market') {
            const live = this.state.liveData[row.optKey] || {};
            const ltp = live.lp ? parseFloat(live.lp) : 0;
            const bBuy = live.bp1 ? parseFloat(live.bp1) : ltp;
            const bSell = live.sp1 ? parseFloat(live.sp1) : ltp;
            if (side === 'BUY') {
                orderPrice = bBuy > 0 ? (bBuy + tick) : ltp;
            } else {
                orderPrice = bSell > 0 ? (bSell - tick) : ltp;
            }
        } else if (signal === 'LTP') {
            const live = this.state.liveData[row.optKey] || {};
            orderPrice = live.lp ? parseFloat(live.lp) : 0;
        } else {
            orderPrice = limit;
        }
        orderPrice = parseFloat(orderPrice.toFixed(dec));

        if (orderPrice <= 0) {
            setStatus('⚠ Invalid order price calculated.', 'var(--accent)');
            return;
        }

        setStatus('⏳ Submitting order...', 'var(--accent)');
        const btn = document.getElementById('add-modal-submit-btn');
        if (btn) btn.disabled = true;

        try {
            const res = await fetch(API_BASE + '/place_order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    exchange, symbol, quantity: qty,
                    buy_or_sell: side, order_type: orderType, price: orderPrice
                })
            });
            if (!res.ok) {
                let errMsg = 'HTTP Error ' + res.status;
                if (res.status === 401) errMsg = 'Not Logged In';
                throw new Error(errMsg);
            }
            const data = await res.json();
            if (data.status === 'success') {
                // Update the existing row qty and risk params
                row.orderId       = data.order_id;
                row.qty          += qty;
                row.lastAddedQty  = qty;
                row.status        = 'Pending';
                if (slVal)  row.slValue     = slVal;
                if (target) row.target      = target;
                if (sl2c)   row.moveToCostAt= sl2c;
                row.tsl = tsl;
                // Recompute initialSL from new SL value
                if (row.slValue && row.slType !== 'No SL') {
                    row.initialSL = this.computeInitialSLPrice(row);
                    if (!row.latestSL) row.latestSL = row.initialSL;
                }

                // Check and apply pending order updates immediately
                if (this.state.pendingOrderUpdates && this.state.pendingOrderUpdates[data.order_id]) {
                    this.applyOrderUpdate(this.state.pendingOrderUpdates[data.order_id]);
                }

                setStatus('✅ Order submitted! ID: ' + data.order_id, 'var(--profit)');
                this.notify(row.symbol + ' ADD order placed (ID: ' + data.order_id + ')', 'success');
                this.renderTradeExitTable();
                // Auto-close after 1.5s
                setTimeout(() => this.closeAddModal(), 1500);
            } else {
                const shortMsg = shortenBrokerMessage(data.message);
                setStatus('❌ Failed: ' + shortMsg, 'var(--loss)');
                this.notify('Add order failed: ' + shortMsg, 'error');
            }
        } catch (e) {
            setStatus('❌ Error: ' + e.message, 'var(--loss)');
            this.notify('Add order error: ' + e.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    },



    duplicateTradeExitRow(index) {
        const sourceRow = this.state.tradeExitRows[index];
        if(!sourceRow) return;
        const clone = { 
            ...sourceRow,
            exitPending: false,
            exitAt: '',
            lastAddedQty: 0
        };
        this.state.tradeExitRows.splice(index + 1, 0, clone);
        this.renderTradeExitTable();
        this.notify('Duplicated tranche for ' + sourceRow.symbol, 'success');
    },

    handleExitModeChange(index) {
        const modeEl = document.getElementById('te-exit-mode-' + index);
        const priceEl = document.getElementById('te-exit-price-' + index);
        const row = this.state.tradeExitRows[index];
        if (!modeEl || !priceEl || !row) return;

        const val = modeEl.value;
        row.exitMode = val;
        
        if (val === 'Price') {
            priceEl.disabled = false;
        } else {
            priceEl.disabled = true;
            priceEl.value = '';
            row.exitPrice = '';
        }
    },

    toggleExitPending(index) {
        const item = this.state.tradeExitRows[index];
        if (!item || item.status === 'Closed') return;
        // EXIT button = instant market exit — no mode selection needed
        this.exitTrade(index, 'Market', true);
    },

    exitTrade(index, hitReason, bypassConfirm) {
        const item = this.state.tradeExitRows[index];
        if (!item || item.status === 'Closed' || item.status === 'Exiting') return;  // already closed or exiting — guard
        const live = this.state.liveData[item.optKey] || {};
        const ltp  = parseFloat(live.lp  || 0);
        const bBuy = parseFloat(live.bp1 || live.lp || 0);
        const bSell= parseFloat(live.sp1 || live.lp || 0);
        
        const exchange = item.optKey.split('|')[0];
        const tick = exchange === 'CDS' ? 0.0025 : 0.05;
        const dec = exchange === 'CDS' ? 4 : 2;

        let price = ltp;
        if (hitReason === 'Price') {
            price = !isNaN(item.exitPrice) ? parseFloat(item.exitPrice) : ltp;
        } else if (hitReason === 'LTP') {
            price = ltp;
        } else if (hitReason === 'SL' || hitReason === 'Target' || hitReason === 'TSL' || hitReason === 'Market') {
            price = item.side === 'BUY' ? bSell - tick : bBuy + tick;
        } else {
            if (item.exitMode === 'Market') {
                price = item.side === 'BUY' ? bSell - tick : bBuy + tick;
            } else if (item.exitMode === 'Price') {
                price = !isNaN(item.exitPrice) ? parseFloat(item.exitPrice) : ltp;
            } else {
                price = ltp;
            }
        }
        price = parseFloat(price.toFixed(dec));

        if (bypassConfirm || hitReason || confirm('EXIT ' + item.symbol + ' at ' + price.toFixed(dec) + '?')) {
            const exitSide = item.side === 'BUY' ? 'SELL' : 'BUY';

            const previousStatus = item.status;
            item.status     = 'Exiting';
            item.exitPending= false;
            item.exitAt     = price.toFixed(dec);
            item.exitReason = hitReason || item.exitMode || 'Manual';

            // Always re-render so row shows Exiting state
            this.renderTradeExitTable();
            this.notify(item.symbol + ' EXIT @ ' + price.toFixed(dec) + ' [' + item.exitReason + ']', 'info');

            // Submit exit order to backend
            const slippageVal = parseFloat(document.getElementById('tn-exec-slippage')?.value) || 3.0;
            const slippageTolerance = slippageVal / 100.0;
            const timeout = parseFloat(document.getElementById('tn-exec-timeout')?.value) || 10;
            const maxRetries = parseInt(document.getElementById('tn-exec-retries')?.value) || 5;

            let executionMode = 'Aggressive_Exit';
            if (hitReason === 'LTP' || item.exitMode === 'LTP') {
                executionMode = 'True_Limit_LTP';
            } else if (hitReason === 'Price' || item.exitMode === 'Price') {
                executionMode = 'True_Limit_LTP';
            }

            fetch(API_BASE + '/place_order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    exchange,
                    symbol:       item.symbol,
                    quantity:     item.qty,
                    buy_or_sell:  exitSide,
                    order_type:   'LIMIT',
                    price:        price,
                    execution_mode: executionMode,
                    limit_price_trigger: price,
                    slippage_tolerance: slippageTolerance,
                    timeout: timeout,
                    max_retries: maxRetries
                })
            }).then(async r => {
                  if (!r.ok) {
                      let errMsg = 'HTTP Error ' + r.status;
                      if (r.status === 401) errMsg = 'Not Logged In';
                      throw new Error(errMsg);
                  }
                  return r.json();
              })
              .then(data => {
                  if (data.status === 'success') {
                      item.exitOrderId = data.order_id;
                      this.notify(item.symbol + ' exit order placed (ID: ' + data.order_id + ')', 'success');
                  } else {
                      // Rollback on rejection
                      item.status = previousStatus;
                      item.exitAt = '';
                      this.renderTradeExitTable();
                      this.notify('Exit order failed: ' + data.message, 'error');
                  }
              }).catch(e => {
                  console.error('Exit order error', e);
                  item.status = previousStatus;
                  item.exitAt = '';
                  this.renderTradeExitTable();
                  this.notify('Failed to place exit order: ' + (e.message || ''), 'error');
              });
        }
    },

    exitAllTrades(bypassConfirm) {
        if(!bypassConfirm&&!confirm('EXIT ALL active positions at Market?')) return;
        let mod=false;
        (this.state.tradeExitRows||[]).forEach((item,i)=>{ if(item.status==='Active'||item.status==='Pending'){ this.exitTrade(i,'Market',true); mod=true; } });
        if(mod) { this.notify('All trades exited at Market','success'); this.renderTradeExitTable(); }
        else if(!bypassConfirm) this.notify('No active trades to exit','info');
    },

    evaluateTradeExit(index) {
        const item = this.state.tradeExitRows[index];
        if (!item || item.status === 'Closed') return;
        if (item.status !== 'Active') return;  // only monitor active trades (guards against Exiting/Pending/Closed loops)
        const live = this.state.liveData[item.optKey] || {};
        const ltp = parseFloat(live.lp || 0);
        if (!ltp || !item.entryAt) return;

        const entry = parseFloat(item.entryAt) || 0;
        const qty   = parseInt(item.qty)        || 1;
        const slVal = parseFloat(item.slValue)  || 0;
        const isBuy = item.side === 'BUY';

        // -- TSL: Trail SL on every tick --
        if (item.tsl) {
            if (item.slType !== 'No SL' && slVal > 0) {
                // Tot Loss (or any SL with ₹ value): trail upward, never below initialSL
                const slPts     = slVal / qty;
                const initialSLPrice = parseFloat(item.initialSL || 0);
                const currentSL = parseFloat(item.latestSL !== '' ? item.latestSL : (item.initialSL || 0));
                if (isBuy) {
                    const calculatedSL = ltp - slPts;
                    // Must be >= initialSL (never trail below the original floor)
                    const newSL = Math.max(calculatedSL, currentSL, initialSLPrice);
                    const formattedSL = this.roundToNseTick(newSL);
                    if (newSL > 0 && formattedSL !== item.latestSL) {
                        item.latestSL = formattedSL;
                    }
                } else {
                    const calculatedSL = ltp + slPts;
                    const currentSLSell = parseFloat(item.latestSL !== '' ? item.latestSL : (item.initialSL || 9999999));
                    // Must be <= initialSL (never trail above the original ceiling for short)
                    const newSL = Math.min(calculatedSL, currentSLSell, initialSLPrice > 0 ? initialSLPrice : 9999999);
                    const formattedSL = this.roundToNseTick(newSL);
                    if (newSL < 9999999 && formattedSL !== item.latestSL) {
                        item.latestSL = formattedSL;
                    }
                }
            } else if (item.slType === 'No SL') {
                // No SL + TSL: trail the gain from entry — latestSL = gain so far
                // BUY: as price rises above entry, lock in profit (starts 0, only increases)
                // SELL: as price falls below entry, lock in profit (starts 0, only increases)
                const currentGainLock = parseFloat(item.latestSL) || 0;
                if (isBuy) {
                    const gain = ltp - entry;                   // how much price moved up from entry
                    if (gain > currentGainLock) {
                        item.latestSL = this.roundToNseTick(gain);       // store the lock-in value as price gain
                    }
                } else {
                    const gain = entry - ltp;                   // how much price moved down from entry (short)
                    if (gain > currentGainLock) {
                        item.latestSL = this.roundToNseTick(gain);
                    }
                }
            }
        }

        // -- SL2Cost: move SL to entry when ₹ P&L reaches moveToCostAt amount --
        if (item.moveToCostAt && !item.sl2CostDone) {
            const sl2Trigger = parseFloat(item.moveToCostAt) || 0;
            const currentPnl = isBuy ? (ltp - entry) * qty : (entry - ltp) * qty;
            if (sl2Trigger > 0 && currentPnl >= sl2Trigger) {
                item.latestSL = this.roundToNseTick(entry);
                item.sl2CostDone = true;
                this.notify(item.symbol + ': SL moved to cost (₹' + sl2Trigger.toFixed(0) + ' profit reached)', 'success');
            }
        }

        // ── AUTOMATIC SL/TSL/Target checks — fire regardless of exitPending ──────
        // SL hit check: compare LTP vs SL price (initialSL or trailing latestSL)
        if (item.slType !== 'No SL' && item.slType !== '' && entry > 0 && slVal > 0) {
            const slPrice = (item.tsl && item.latestSL !== '')
                ? parseFloat(item.latestSL)
                : parseFloat(item.initialSL || 0);
            if (slPrice > 0) {
                if (isBuy  && ltp <= slPrice) {
                    this.notify(item.symbol + ' SL hit @ ' + ltp.toFixed(2) + ' (SL: ' + slPrice.toFixed(2) + ')', 'error');
                    this.exitTrade(index, item.tsl ? 'TSL' : 'SL', true);
                    return;
                }
                if (!isBuy && ltp >= slPrice) {
                    this.notify(item.symbol + ' SL hit @ ' + ltp.toFixed(2) + ' (SL: ' + slPrice.toFixed(2) + ')', 'error');
                    this.exitTrade(index, item.tsl ? 'TSL' : 'SL', true);
                    return;
                }
            }
        }

        // Target hit check: Target is ₹ profit → convert to price level
        if (item.target !== '' && item.target !== undefined) {
            const targetRs = parseFloat(item.target) || 0;
            if (targetRs > 0 && entry > 0) {
                const targetPrice = isBuy
                    ? entry + (targetRs / qty)
                    : entry - (targetRs / qty);
                if (isBuy  && ltp >= targetPrice) {
                    this.notify(item.symbol + ' Target hit @ ' + ltp.toFixed(2) + ' (Target: ₹' + targetRs + ')', 'success');
                    this.exitTrade(index, 'Target', true);
                    return;
                }
                if (!isBuy && ltp <= targetPrice) {
                    this.notify(item.symbol + ' Target hit @ ' + ltp.toFixed(2) + ' (Target: ₹' + targetRs + ')', 'success');
                    this.exitTrade(index, 'Target', true);
                    return;
                }
            }
        }
        // ── End automatic checks ─────────────────────────────────────────────────

        // Manual exit mode checks — only fire if user clicked EXIT (exitPending)
        if (!item.exitPending) return;
        let hit = false;
        let hitReason = '';

        if (item.exitMode === 'LTP' || item.exitMode === 'Market') {
            hit = true;
            hitReason = item.exitMode;
        } else if (item.exitMode === 'Price') {
            if (isBuy  && ltp >= parseFloat(item.exitPrice)) { hit = true; hitReason = 'Price'; }
            if (!isBuy && ltp <= parseFloat(item.exitPrice)) { hit = true; hitReason = 'Price'; }
        }

        if (hit) this.exitTrade(index, hitReason);
    },

    evaluateOverallTarget() {
        const el=document.getElementById('te-overall-target-active');
        if(!el||!el.checked) return;
        const tv=parseFloat(document.getElementById('te-overall-target')?.value);
        if(isNaN(tv)) return;
        let total=0;
        (this.state.tradeExitRows||[]).forEach(item=>{
            if(item.status==='Active'||item.status==='Pending'){
                const ltp=parseFloat((this.state.liveData[item.optKey]||{}).lp||0);
                if(ltp>0&&item.entryAt>0){const c=item.side==='BUY'?(ltp-item.entryAt):(item.entryAt-ltp);total+=c*(item.qty||0);}
            }
        });
        if(total>=tv){el.checked=false;this.notify('Overall target reached! Exiting all.','success');this.exitAllTrades(true);}
    },


    toggleFuturesAdvancedFilters() {
        const adv = document.getElementById('futures-adv-filters');
        if(adv.style.display === 'none') {
            adv.style.display = 'flex';
        } else {
            adv.style.display = 'none';
        }
    },

    clearFuturesAdvancedFilters() {
        document.getElementById('ff1-val').value = '';
        document.getElementById('ff2-val').value = '';
        this.filterFutures();
    },

    filterFutures() {
        const exchangeFilter = document.getElementById('fut-exch').value;
        const categoryFilter = document.getElementById('fut-cat').value;
        const expiryFilter = document.getElementById('fut-exp').value;
        
        if(!this.state.futuresData) return;
        
        let filtered = [...this.state.futuresData];
        
        // Apply primary filters
        if(exchangeFilter !== 'ALL') filtered = filtered.filter(f => f.exchange === exchangeFilter);
        if(categoryFilter !== 'ALL') filtered = filtered.filter(f => f.category === categoryFilter);
        if(expiryFilter !== 'ALL') filtered = filtered.filter(f => f.expiry_type === expiryFilter);
        
        // Apply Advanced Filters
        const activeFields = ['ff1', 'ff2'].map(id => {
            const valEl = document.getElementById(id + '-val');
            if(!valEl || valEl.value.trim() === '') return null;
            return {
                logic: id === 'ff1' ? 'AND' : document.getElementById(id + '-logic').value,
                field: document.getElementById(id + '-field').value,
                op: document.getElementById(id + '-op').value,
                val: valEl.value.trim()
            };
        }).filter(Boolean);

        if(activeFields.length > 0) {
            filtered = filtered.filter(row => {
                let currentResult = null;
                const key = `${row.exchange}|${row.tradingsymbol}`;
                for(const f of activeFields) {
                    const r = this.evaluateCondition(this.getFieldValue(row, key, f.field), f.op, f.val);
                    if(currentResult === null) {
                        currentResult = r;
                    } else {
                        if(f.logic === 'AND') currentResult = currentResult && r;
                        else currentResult = currentResult || r;
                    }
                }
                return currentResult;
            });
        }
        
        this.renderFuturesTable(filtered);
    },

    sortFutures(field) {
        if(!this.state.futuresData) return;
        
        if(!this.state.futuresSortField || this.state.futuresSortField !== field) {
            this.state.futuresSortField = field;
            this.state.futuresSortDesc = true;
        } else {
            this.state.futuresSortDesc = !this.state.futuresSortDesc;
        }
        
        this.state.futuresData.sort((a, b) => {
            let valA = a[field];
            let valB = b[field];
            
            // Handle special cases
            if(field === 'symbol') {
                valA = `${a.symbol} ${a.expiry_type}`;
                valB = `${b.symbol} ${b.expiry_type}`;
            }
            
            // Convert to numbers for numeric fields
            if(['lotsize', 'ltp', 'change', 'pc', 'open', 'high', 'low', 'oi'].includes(field)) {
                valA = parseFloat(valA) || 0;
                valB = parseFloat(valB) || 0;
            }
            
            if(typeof valA === 'string' && typeof valB === 'string') {
                return this.state.futuresSortDesc ? valB.localeCompare(valA) : valA.localeCompare(valB);
            }
            return this.state.futuresSortDesc ? (valB - valA) : (valA - valB);
        });
        
        this.renderFuturesTable();
    },

    notify(msg, type="success") {
        const notif = document.getElementById('notifications');
        const d = document.createElement('div');
        d.className = 'toast';
        d.style.borderLeftColor = type === 'error' ? 'var(--loss)' : 'var(--profit)';
        d.innerText = msg;
        notif.appendChild(d);
        setTimeout(() => d.remove(), 4000);
    },

    // ── Trade Terminal Methods ─────────────────────────────────────────────
    addTerminalRow() {
        const row = {
            indexExch: 'NSE',
            instrument: '',
            type: 'EQ',
            expiry: 'DISABLED',
            strike: '',
            inputSymbol: '',
            resolvedSymbol: '',
            token: '',
            exchange: 'NSE',
            lotsize: 1,
            ticksize: 0.05,
            qty: '',
            side: '',
            signal: '',
            limitPrice: '',
            entryDoneAt: '',
            entryOrderId: '',
            entryRemarks: '',
            entryAt: '',
            status: 'Inactive',
            target: '',
            slType: '',
            slValue: '',
            tsl: false,
            moveToCostAt: '',
            addExit: '',
            exitAction: '',
            exitPrice: '',
            initialSL: '',
            latestSL: '',
            exitAt: '',
            exitPending: false,
            sl2CostDone: false,
            lastAddedQty: 0,
            cancelChecked: false,
            exitMode: ''
        };
        this.state.terminalRows.push(row);
        this.renderTerminalTable();
    },

    async handleCanonicalFieldChange(index) {
        const row = this.state.terminalRows[index];
        if (!row) return;

        const elIndex = document.getElementById(`term-index-${index}`);
        const elInst  = document.getElementById(`term-inst-${index}`);
        const elType  = document.getElementById(`term-type-${index}`);
        const elExp   = document.getElementById(`term-expiry-${index}`);
        const elStk   = document.getElementById(`term-strike-${index}`);

        if (elIndex) row.indexExch = elIndex.value;
        if (elInst)  row.instrument = elInst.value.trim().toUpperCase();
        if (elType)  row.type = elType.value;
        if (elExp)   row.expiry = elExp.value;
        if (elStk)   row.strike = elStk.value;

        // Auto-configure Expiry & Index defaults based on Type
        if (row.type === 'EQ') {
            if (row.indexExch === 'NFO' || row.indexExch === 'BFO') {
                row.indexExch = 'NSE';
                if (elIndex) elIndex.value = 'NSE';
            }
            row.expiry = 'DISABLED';
            row.strike = '';
            if (elExp) elExp.value = 'DISABLED';
            if (elStk) { elStk.value = ''; elStk.disabled = true; }
        } else if (row.type === 'FUT') {
            if (row.indexExch === 'NSE') row.indexExch = 'NFO';
            else if (row.indexExch === 'BSE') row.indexExch = 'BFO';
            if (row.expiry === 'DISABLED') row.expiry = 'Near';
            row.strike = '';
            if (elIndex) elIndex.value = row.indexExch;
            if (elExp) elExp.value = row.expiry;
            if (elStk) { elStk.value = ''; elStk.disabled = true; }
        } else if (row.type === 'CE' || row.type === 'PE') {
            if (row.indexExch === 'NSE') row.indexExch = 'NFO';
            else if (row.indexExch === 'BSE') row.indexExch = 'BFO';
            if (row.expiry === 'DISABLED') row.expiry = 'Near';
            if (elIndex) elIndex.value = row.indexExch;
            if (elExp) elExp.value = row.expiry;
            if (elStk) elStk.disabled = false;
        }

        if (!row.instrument) return;

        try {
            const res = await fetch(`${API_BASE}/resolve_canonical_symbol`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    index: row.indexExch,
                    instrument: row.instrument,
                    type: row.type,
                    strike: parseFloat(row.strike) || 0,
                    expiry: row.expiry
                })
            });
            const data = await res.json();
            if (data.status === 'success') {
                row.inputSymbol = `${row.indexExch}|${row.instrument}`;
                row.resolvedSymbol = data.tradingsymbol;
                row.token = data.token;
                row.exchange = data.exchange;
                row.lotsize = data.lotsize;
                row.ticksize = data.exchange === 'CDS' ? 0.0025 : Math.max(0.05, parseFloat(data.ticksize) || 0.05);
                if (!row.qty || row.qty <= 0) row.qty = data.lotsize;
                this.renderTerminalTable();
            }
        } catch (e) {
            console.error("Canonical field change error", e);
        }
    },

    async resolveTerminalSymbol(index, value) {
        const row = this.state.terminalRows[index];
        if (!row) return;
        const isEntryDisabled = row.status === 'Pending' || row.status === 'Active' || row.status === 'Closed' || row.status === 'Submitting';
        if (isEntryDisabled) return;

        if (!value) {
            row.inputSymbol = '';
            row.resolvedSymbol = '';
            row.token = '';
            row.exchange = '';
            row.lotsize = 1;
            row.ticksize = 0.05;
            row.qty = '';
            this.renderTerminalTable();
            return;
        }
        
        try {
            const res = await fetch(`${API_BASE}/resolve_symbol?symbol=${encodeURIComponent(value)}`);
            const data = await res.json();
            if (data.status === 'success') {
                const row = this.state.terminalRows[index];
                if (row) {
                    row.inputSymbol = value;
                    row.resolvedSymbol = data.tradingsymbol;
                    row.token = data.token;
                    row.exchange = data.exchange;
                    row.lotsize = data.lotsize;
                    row.ticksize = data.exchange === 'CDS' ? 0.0025 : Math.max(0.05, parseFloat(data.ticksize) || 0.05);
                    row.qty = data.lotsize;
                    
                    this.notify(`Resolved ${value} as ${data.exchange}:${data.tradingsymbol}`, 'success');
                    this.renderTerminalTable();
                }
            } else {
                this.notify(`Symbol resolution failed: ${data.message}`, 'error');
            }
        } catch (e) {
            console.error("Resolve symbol error", e);
            this.notify("Failed to resolve symbol", "error");
        }
    },

    dragColumn(event, colIndex) {
        event.dataTransfer.setData('text/plain', colIndex);
    },
    
    allowDropColumn(event) {
        event.preventDefault();
    },
    
    dropColumn(event, targetIndex) {
        event.preventDefault();
        const sourceIndex = parseInt(event.dataTransfer.getData('text/plain'));
        if (isNaN(sourceIndex) || sourceIndex === targetIndex) return;
        
        const columns = [...this.state.terminalColumns];
        const [movedCol] = columns.splice(sourceIndex, 1);
        columns.splice(targetIndex, 0, movedCol);
        
        this.state.terminalColumns = columns;
        localStorage.setItem('terminal_column_order', JSON.stringify(columns.map(c => c.id)));
        this.renderTerminalTable();
    },

    updateTerminalField(index, field, value) {
        const row = this.state.terminalRows[index];
        if (row) {
            const isEntryDisabled = row.status === 'Pending' || row.status === 'Active' || row.status === 'Closed' || row.status === 'Submitting';
            const entryFields = ['qty', 'side', 'signal', 'limitPrice'];
            if (isEntryDisabled && entryFields.includes(field)) {
                return;
            }
            row[field] = value;
            if (field === 'addExit') {
                if (value === 'Exit') {
                    row.addExit = '';
                    this.toggleTerminalExitPending(index);
                } else if (value === 'Add') {
                    row.addExit = '';
                    this.duplicateTerminalRow(index);
                }
            }
            // Whenever slValue or slType changes, recompute initialSL as a price (same as Trade Exit)
            if (field === 'slValue' || field === 'slType') {
                if (row.slType !== 'No SL' && row.slType !== '' && row.slValue !== '' && row.slValue !== 0) {
                    row.initialSL = this.computeInitialSLPrice(row);
                    // Only reset latestSL if TSL is not yet trailing
                    if (row.latestSL === '') row.latestSL = row.initialSL;
                } else if (row.slType === 'No SL') {
                    row.slValue = '';
                    row.initialSL = '';
                    row.latestSL = '';
                }
                this.renderTerminalTable();
            }
        }
    },

    duplicateTerminalRow(index) {
        const sourceRow = this.state.terminalRows[index];
        if(!sourceRow) return;
        const clone = {
            ...sourceRow,
            addExit: '',
            exitPending: false,
            exitAt: '',
            entryOrderId: '',
            entryRemarks: '',
            sl2CostDone: false
        };
        this.state.terminalRows.splice(index + 1, 0, clone);
        this.renderTerminalTable();
        this.notify('Duplicated terminal row tranche for ' + (sourceRow.resolvedSymbol || 'row'), 'success');
    },

    saveTerminalColumnWidths() {
        const widthsMap = {};
        this.state.terminalColumns.forEach(col => {
            if (col.width) {
                widthsMap[col.id] = col.width;
            }
        });
        localStorage.setItem('terminal_column_widths', JSON.stringify(widthsMap));
    },

    initResize(e, index) {
        e.preventDefault();
        e.stopPropagation();
        
        const th = e.target.parentElement;
        th.setAttribute('draggable', 'false');
        
        const startX = e.clientX;
        const startWidth = th.offsetWidth;
        
        const doDrag = (moveEvent) => {
            const newWidth = Math.max(50, startWidth + (moveEvent.clientX - startX));
            th.style.width = newWidth + 'px';
            th.style.minWidth = newWidth + 'px';
        };
        
        const stopDrag = () => {
            document.removeEventListener('mousemove', doDrag);
            document.removeEventListener('mouseup', stopDrag);
            
            th.setAttribute('draggable', 'true');
            
            const col = this.state.terminalColumns[index];
            if (col) {
                col.width = th.style.width;
                this.saveTerminalColumnWidths();
            }
        };
        
        document.addEventListener('mousemove', doDrag);
        document.addEventListener('mouseup', stopDrag);
    },

    handleTerminalSignalChange(index) {
        const item = this.state.terminalRows[index];
        if (!item) return;
        const signalEl = document.getElementById(`term-signal-${index}`);
        const limitEl = document.getElementById(`term-limit-${index}`);
        const sideEl = document.getElementById(`term-side-${index}`);
        if (!signalEl || !limitEl) return;
        
        const val = signalEl.value;
        item.signal = val;
        
        const liveKey = item.exchange === 'NFO' ? `NFO|${item.resolvedSymbol}` : `${item.exchange}|${item.token}`;
        const live = this.state.liveData[liveKey] || {};
        const ltp = live.lp ? parseFloat(live.lp) : 0;
        const bid = live.bp1 ? parseFloat(live.bp1) : 0;
        const ask = live.sp1 ? parseFloat(live.sp1) : 0;
        
        if (!val || val === '') {
            limitEl.disabled = true;
            limitEl.value = '';
            item.limitPrice = '';
        } else if (val === 'Market') {
            limitEl.disabled = true;
            const side = sideEl ? sideEl.value : 'BUY';
            if (side === 'BUY') {
                const price = bid > 0 ? bid + 0.05 : ltp;
                limitEl.value = price > 0 ? price.toFixed(2) : '';
            } else {
                const price = ask > 0 ? ask - 0.05 : ltp;
                limitEl.value = price > 0 ? price.toFixed(2) : '';
            }
            item.limitPrice = limitEl.value;
        } else if (val === 'LTP') {
            limitEl.disabled = true;
            limitEl.value = ltp > 0 ? ltp.toFixed(2) : '';
            item.limitPrice = limitEl.value;
        } else if (val === 'Limit') {
            limitEl.disabled = false;
        }
    },

    handleTerminalExitActionChange(index) {
        const item = this.state.terminalRows[index];
        if (!item) return;
        const actionEl = document.getElementById(`term-exitaction-${index}`);
        const priceEl = document.getElementById(`term-exitprice-${index}`);
        if (!actionEl || !priceEl) return;
        
        const val = actionEl.value;
        item.exitAction = val;
        
        if (val === 'Exit by Price') {
            priceEl.disabled = false;
        } else {
            priceEl.disabled = true;
            priceEl.value = '';
            item.exitPrice = '';
        }
    },

    async submitTerminalEntry(index) {
        const item = this.state.terminalRows[index];
        if(!item || !item.token || !item.resolvedSymbol) {
            this.notify("Please enter and resolve a symbol first", "error");
            return;
        }
        if(!item.qty || isNaN(item.qty) || item.qty <= 0) {
            this.notify("Please enter a valid quantity", "error");
            return;
        }
        if(!item.side || item.side === '') {
            this.notify("Please select BUY or SELL", "error");
            return;
        }
        if(!item.signal || item.signal === '') {
            this.notify("Please select an Entry Signal", "error");
            return;
        }
        
        const liveKey = item.exchange === 'NFO' ? `NFO|${item.resolvedSymbol}` : `${item.exchange}|${item.token}`;
        const live = this.state.liveData[liveKey] || {};
        const ltp = live.lp ? parseFloat(live.lp) : 0;
        const bid = live.bp1 ? parseFloat(live.bp1) : ltp;
        const ask = live.sp1 ? parseFloat(live.sp1) : ltp;
        
        const exchange = item.exchange;
        const tick = exchange === 'CDS' ? 0.0025 : Math.max(0.05, parseFloat(item.ticksize) || 0.05);
        const dec = exchange === 'CDS' ? 4 : 2;
        
        let orderPrice = 0;
        if(item.signal === 'Market') {
            orderPrice = item.side === 'BUY' ? bid + tick : ask - tick;
        } else if(item.signal === 'LTP') {
            orderPrice = ltp;
        } else {
            orderPrice = parseFloat(item.limitPrice) || 0;
        }
        
        // Strict Tick Rounding
        const entryTicks = Math.round(orderPrice / tick);
        orderPrice = parseFloat((entryTicks * tick).toFixed(dec));
        if(orderPrice <= 0) {
            this.notify("Waiting for live quotes or invalid entry price", "error");
            return;
        }
        
        try {
            item.entryRemarks = 'Submitting...';
            item.status = 'Submitting';
            this.renderTerminalTable();
            
            const res = await fetch(`${API_BASE}/place_order`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    exchange: item.exchange,
                    symbol: item.resolvedSymbol,
                    quantity: item.qty,
                    buy_or_sell: item.side,
                    order_type: 'LIMIT',
                    price: orderPrice
                })
            });
            if (!res.ok) {
                let errMsg = 'HTTP Error ' + res.status;
                if (res.status === 401) errMsg = 'Not Logged In';
                throw new Error(errMsg);
            }
            const data = await res.json();
            if(data.status === 'success') {
                item.entryOrderId = data.order_id;
                item.status = 'Pending';
                item.entryRemarks = 'Order Placed';

                // Check and apply pending order updates immediately
                if (this.state.pendingOrderUpdates && this.state.pendingOrderUpdates[data.order_id]) {
                    this.applyOrderUpdate(this.state.pendingOrderUpdates[data.order_id]);
                }

                this.notify(`${item.resolvedSymbol} entry placed: ${data.order_id}`, 'success');
            } else {
                const shortMsg = shortenBrokerMessage(data.message);
                item.entryRemarks = shortMsg;
                item.status = 'Rejected';
                this.notify(`Failed: ${shortMsg}`, 'error');
            }
            this.renderTerminalTable();
        } catch (e) {
            console.error("Terminal order failed", e);
            item.entryRemarks = e.message || 'Error';
            item.status = 'Rejected';
            this.notify("Failed to place order: " + (e.message || ''), "error");
            this.renderTerminalTable();
        }
    },

    async cancelTerminalEntry(index) {
        const item = this.state.terminalRows[index];
        if (!item) return;
        const orderId = item.entryOrderId || item.orderId;
        if (!orderId) {
            this.notify("No active order ID found to cancel", "error");
            return;
        }

        item.entryRemarks = 'Cancelling...';
        this.renderTerminalTable();

        try {
            const res = await fetch(API_BASE + '/cancel_order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    order_id: orderId,
                    symbol: item.resolvedSymbol || item.inputSymbol
                })
            });
            const data = await res.json();
            if (data.status === 'success') {
                this.notify(`Pending order ${orderId} cancelled`, "success");
                item.status = 'Canceled';
                item.entryRemarks = 'Cancelled by User';
                this.renderTerminalTable();
            } else {
                this.notify(`Cancel failed: ${data.message}`, "error");
                item.entryRemarks = 'Cancel Failed';
                this.renderTerminalTable();
            }
        } catch (e) {
            console.error("Cancel terminal order error", e);
            this.notify(`Error cancelling order: ` + (e.message || ''), "error");
            item.entryRemarks = 'Cancel Error';
            this.renderTerminalTable();
        }
    },

    toggleTerminalExitPending(index) {
        const item = this.state.terminalRows[index];
        if (!item || item.status === 'Closed') return;
        // EXIT button = instant market exit — no exit action selection needed
        this.exitTerminalTrade(index, 'Market', true);
    },

    async exitTerminalTrade(index, hitReason, bypassConfirm) {
        const item = this.state.terminalRows[index];
        if (!item || item.status === 'Closed' || item.status === 'Exiting') return;

        const liveKey = item.exchange === 'NFO' ? `NFO|${item.resolvedSymbol}` : `${item.exchange}|${item.token}`;
        const live    = this.state.liveData[liveKey] || {};
        const ltp     = live.lp  ? parseFloat(live.lp)  : 0;
        const bBuy    = live.bp1 ? parseFloat(live.bp1)  : ltp;
        const bSell   = live.sp1 ? parseFloat(live.sp1)  : ltp;
        
        const exchange = item.exchange;
        const tick    = exchange === 'CDS' ? 0.0025 : Math.max(0.05, parseFloat(item.ticksize) || 0.05);
        const dec     = exchange === 'CDS' ? 4 : 2;

        let price = ltp;
        if (hitReason === 'Price') {
            price = !isNaN(item.exitPrice) ? parseFloat(item.exitPrice) : ltp;
        } else if (hitReason === 'LTP') {
            price = ltp;
        } else if (hitReason === 'SL' || hitReason === 'Target' || hitReason === 'TSL' || hitReason === 'Market') {
            price = item.side === 'BUY' ? bSell - tick : bBuy + tick;
        } else {
            if (item.exitAction === 'Exit by Market') {
                price = item.side === 'BUY' ? bSell - tick : bBuy + tick;
            } else if (item.exitAction === 'Exit by Price') {
                price = !isNaN(item.exitPrice) ? parseFloat(item.exitPrice) : ltp;
            } else {
                price = ltp;
            }
        }
        
        // Strict Tick Rounding
        const exitTicks = Math.round(price / tick);
        price = parseFloat((exitTicks * tick).toFixed(dec));

        if (bypassConfirm || hitReason || confirm(`EXIT ${item.resolvedSymbol} at ${price.toFixed(dec)}?`)) {
            const previousStatus = item.status;
            item.status      = 'Exiting';
            item.exitPending = false;
            item.exitAt      = price.toFixed(dec);
            item.exitReason  = hitReason || item.exitAction || 'Manual';
            this.renderTerminalTable();
            this.notify(`${item.resolvedSymbol} EXIT @ ${price.toFixed(dec)} [${item.exitReason}]`, 'info');

            const exitSide = item.side === 'BUY' ? 'SELL' : 'BUY';
            const slippageVal = parseFloat(document.getElementById('tn-exec-slippage')?.value) || 3.0;
            const slippageTolerance = slippageVal / 100.0;
            const timeout = parseFloat(document.getElementById('tn-exec-timeout')?.value) || 10;
            const maxRetries = parseInt(document.getElementById('tn-exec-retries')?.value) || 5;

            let executionMode = 'Aggressive_Exit';
            if (hitReason === 'LTP' || item.exitAction === 'Exit by LTP') {
                executionMode = 'True_Limit_LTP';
            } else if (hitReason === 'Price' || item.exitAction === 'Exit by Price') {
                executionMode = 'True_Limit_LTP';
            }

            try {
                const res = await fetch(`${API_BASE}/place_order`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        exchange: item.exchange,
                        symbol:   item.resolvedSymbol,
                        quantity: item.qty,
                        buy_or_sell: exitSide,
                        order_type: 'LIMIT',
                        price: price,
                        execution_mode: executionMode,
                        limit_price_trigger: price,
                        slippage_tolerance: slippageTolerance,
                        timeout: timeout,
                        max_retries: maxRetries
                    })
                });
                if (!res.ok) {
                    let errMsg = 'HTTP Error ' + res.status;
                    if (res.status === 401) errMsg = 'Not Logged In';
                    throw new Error(errMsg);
                }
                const data = await res.json();
                if (data.status === 'success') {
                    item.exitOrderId = data.order_id;
                    this.notify(`${item.resolvedSymbol} exit order placed (ID: ${data.order_id})`, 'success');
                } else {
                    item.status = previousStatus;
                    item.exitAt = '';
                    this.renderTerminalTable();
                    this.notify(`Exit order failed: ${data.message}`, 'error');
                }
            } catch (e) {
                console.error('Exit terminal order error', e);
                item.status = previousStatus;
                item.exitAt = '';
                this.renderTerminalTable();
                this.notify('Failed to place exit order: ' + (e.message || ''), 'error');
            }
        }
    },

    // ── Cancel Terminal Trades (mirrors Trade Exit cancelSelectedTrades) ────────
    toggleTerminalCancelChecked(index, checked) {
        const item = this.state.terminalRows[index];
        if (item) item.cancelChecked = checked;
    },

    async cancelSelectedTerminalTrades() {
        const rows = this.state.terminalRows || [];
        const toCancel = [];
        rows.forEach((item, index) => {
            if (item.status === 'Pending' && item.cancelChecked === true) {
                toCancel.push({ item, index });
            }
        });

        if (toCancel.length === 0) {
            this.notify('No pending terminal trades checked for cancellation.', 'error');
            return;
        }

        if (!confirm(`Cancel ${toCancel.length} checked pending terminal order(s)?`)) return;

        // Optimistic update
        toCancel.forEach(task => {
            task.item.status = 'Canceled';
            task.item.cancelChecked = false;
            task.item.entryRemarks = 'Canceled';
        });
        this.renderTerminalTable();

        await Promise.all(toCancel.map(async task => {
            try {
                const res = await fetch(API_BASE + '/cancel_order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        order_id: task.item.entryOrderId,
                        symbol: task.item.resolvedSymbol
                    })
                });
                if (!res.ok) {
                    let errMsg = 'HTTP Error ' + res.status;
                    if (res.status === 401) errMsg = 'Not Logged In';
                    throw new Error(errMsg);
                }
                const data = await res.json();
                if (data.status === 'success') {
                    this.notify(`${task.item.resolvedSymbol} terminal order cancelled`, 'success');
                } else {
                    this.notify(`Failed to cancel ${task.item.resolvedSymbol}: ${data.message}`, 'error');
                }
            } catch (e) {
                console.error('Cancel terminal order error', e);
                this.notify(`Error cancelling ${task.item.resolvedSymbol}: ` + (e.message || ''), 'error');
            }
        }));
        this.renderTerminalTable();
    },

    // ── Exit All Terminal Trades (mirrors Trade Exit exitAllTrades) ─────────────
    exitAllTerminalTrades(bypassConfirm) {
        if (!bypassConfirm && !confirm('EXIT ALL active terminal positions at Market?')) return;
        let mod = false;
        (this.state.terminalRows || []).forEach((item, i) => {
            if (item.status === 'Active' || item.status === 'Pending') {
                this.exitTerminalTrade(i, 'Market', true);
                mod = true;
            }
        });
        if (mod) { this.notify('All terminal trades exited at Market', 'success'); this.renderTerminalTable(); }
        else if (!bypassConfirm) this.notify('No active terminal trades to exit', 'info');
    },

    // ── Terminal Total MTM (mirrors Trade Exit updateTotalMtm) ──────────────────
    updateTerminalTotalMtm() {
        let totalPl = 0;
        (this.state.terminalRows || []).forEach(item => {
            if (item.status === 'Closed') {
                const exitPx = parseFloat(item.exitAt) || 0;
                const entry  = parseFloat(item.entryAt) || 0;
                if (exitPx > 0 && entry > 0) {
                    const chg = item.side === 'BUY' ? (exitPx - entry) : (entry - exitPx);
                    totalPl += chg * (parseInt(item.qty) || 0);
                }
            } else if (item.status === 'Active' || item.status === 'Pending') {
                const liveKey = item.exchange === 'NFO' ? `NFO|${item.resolvedSymbol}` : `${item.exchange}|${item.token}`;
                const live = this.state.liveData[liveKey] || {};
                const ltp  = live.lp ? parseFloat(live.lp) : 0;
                if (ltp > 0 && item.entryAt > 0) {
                    const c = item.side === 'BUY' ? (ltp - item.entryAt) : (item.entryAt - ltp);
                    totalPl += c * (parseInt(item.qty) || 0);
                }
            }
        });
        const mtmEl = document.getElementById('term-table-mtm');
        if (mtmEl) {
            mtmEl.innerText = '₹' + totalPl.toFixed(2);
            mtmEl.style.color = totalPl >= 0 ? 'var(--profit)' : 'var(--loss)';
        }
    },

    evaluateTerminalExit(index) {
        const item = this.state.terminalRows[index];
        if (!item || item.status === 'Closed') return;
        if (item.status !== 'Active') return;  // only monitor active trades
        const liveKey = item.exchange === 'NFO' ? `NFO|${item.resolvedSymbol}` : `${item.exchange}|${item.token}`;
        const live = this.state.liveData[liveKey] || {};
        const ltp  = live.lp ? parseFloat(live.lp) : 0;
        if (!ltp || !item.entryAt) return;

        const entry  = parseFloat(item.entryAt) || 0;
        const qty    = parseInt(item.qty) || 1;
        const isBuy  = item.side === 'BUY';

        // ── TSL: trail SL on every tick (same logic as Trade Exit) ─────────
        if (item.tsl) {
            const slVal2 = parseFloat(item.slValue) || 0;
            if (item.slType !== 'No SL' && slVal2 > 0) {
                // Tot Loss TSL: trail upward, never below initialSL floor
                const slPts = slVal2 / qty;
                const initialSLPrice = parseFloat(item.initialSL || 0);
                const currentSL = parseFloat(item.latestSL !== '' ? item.latestSL : (item.initialSL || 0));
                if (isBuy) {
                    const calculatedSL = ltp - slPts;
                    const newSL = Math.max(calculatedSL, currentSL, initialSLPrice);
                    if (newSL > 0 && newSL.toFixed(2) !== item.latestSL) {
                        item.latestSL = newSL.toFixed(2);
                        const el = document.getElementById(`term-latestsl-${index}`);
                        if (el) el.innerText = item.latestSL;
                    }
                } else {
                    const calculatedSL = ltp + slPts;
                    const currentSLSell = parseFloat(item.latestSL !== '' ? item.latestSL : (item.initialSL || 9999999));
                    const newSL = Math.min(calculatedSL, currentSLSell, initialSLPrice > 0 ? initialSLPrice : 9999999);
                    if (newSL < 9999999 && newSL.toFixed(2) !== item.latestSL) {
                        item.latestSL = newSL.toFixed(2);
                        const el = document.getElementById(`term-latestsl-${index}`);
                        if (el) el.innerText = item.latestSL;
                    }
                }
            } else if (item.slType === 'No SL') {
                // No SL + TSL: lock in price gain from entry
                const currentGainLock = parseFloat(item.latestSL) || 0;
                if (isBuy) {
                    const gain = ltp - entry;
                    if (gain > currentGainLock) {
                        item.latestSL = gain.toFixed(2);
                        const el = document.getElementById(`term-latestsl-${index}`);
                        if (el) el.innerText = item.latestSL;
                    }
                } else {
                    const gain = entry - ltp;
                    if (gain > currentGainLock) {
                        item.latestSL = gain.toFixed(2);
                        const el = document.getElementById(`term-latestsl-${index}`);
                        if (el) el.innerText = item.latestSL;
                    }
                }
            }
        }

        // ── SL2Cost: move SL to entry when ₹ P&L reaches trigger ─────────────
        if (item.moveToCostAt && !item.sl2CostDone) {
            const t = parseFloat(item.moveToCostAt) || 0;
            const p = isBuy ? (ltp - entry) * qty : (entry - ltp) * qty;
            if (p >= t && t > 0) {
                item.latestSL    = entry.toFixed(2);
                item.sl2CostDone = true;
                const el = document.getElementById(`term-latestsl-${index}`);
                if (el) el.innerText = item.latestSL;
                this.notify(`${item.resolvedSymbol}: SL moved to cost (₹${t} profit reached)`, 'success');
            }
        }

        // ── AUTOMATIC SL/TSL/Target — fire regardless of exitPending ─────────
        if (item.slType !== 'No SL' && item.slType !== '' && entry > 0 && item.slValue) {
            const slPrice = (item.tsl && item.latestSL !== '')
                ? parseFloat(item.latestSL)
                : parseFloat(item.initialSL || 0);
            if (slPrice > 0) {
                if (isBuy  && ltp <= slPrice) {
                    this.notify(`${item.resolvedSymbol} SL hit @ ${ltp.toFixed(2)} (SL: ${slPrice.toFixed(2)})`, 'error');
                    this.exitTerminalTrade(index, item.tsl ? 'TSL' : 'SL', true);
                    return;
                }
                if (!isBuy && ltp >= slPrice) {
                    this.notify(`${item.resolvedSymbol} SL hit @ ${ltp.toFixed(2)} (SL: ${slPrice.toFixed(2)})`, 'error');
                    this.exitTerminalTrade(index, item.tsl ? 'TSL' : 'SL', true);
                    return;
                }
            }
        }
        if (item.target) {
            const targetRs = parseFloat(item.target) || 0;
            if (targetRs > 0 && entry > 0) {
                const targetPrice = isBuy ? entry + (targetRs / qty) : entry - (targetRs / qty);
                if (isBuy  && ltp >= targetPrice) {
                    this.notify(`${item.resolvedSymbol} Target hit @ ${ltp.toFixed(2)}`, 'success');
                    this.exitTerminalTrade(index, 'Target', true);
                    return;
                }
                if (!isBuy && ltp <= targetPrice) {
                    this.notify(`${item.resolvedSymbol} Target hit @ ${ltp.toFixed(2)}`, 'success');
                    this.exitTerminalTrade(index, 'Target', true);
                    return;
                }
            }
        }
        // ── End automatic checks ─────────────────────────────────────────────

        // Manual exit — only fires if user clicked EXIT
        if (!item.exitPending) return;
        let hit = false, hitReason = '';
        if (item.exitAction === 'Exit by LTP' || item.exitAction === 'Exit by Market') {
            hit = true;
            hitReason = item.exitAction === 'Exit by LTP' ? 'LTP' : 'Market';
        } else if (item.exitAction === 'Exit by Price') {
            if (isBuy  && ltp >= item.exitPrice) { hit = true; hitReason = 'Price'; }
            if (!isBuy && ltp <= item.exitPrice) { hit = true; hitReason = 'Price'; }
        }
        if (hit) this.exitTerminalTrade(index, hitReason, true);
    },

    updateTerminalRowQuotes(key, data) {
        this.state.terminalRows.forEach((item, index) => {
            const rowKey = item.exchange === 'NFO' ? `NFO|${item.resolvedSymbol}` : `${item.exchange}|${item.token}`;
            if (rowKey === key) {
                const bid = data.bp1 ? parseFloat(data.bp1) : null;
                const ask = data.sp1 ? parseFloat(data.sp1) : null;
                const ltp = data.lp  ? parseFloat(data.lp)  : null;
                const high= data.h   ? parseFloat(data.h)   : null;
                const low = data.l   ? parseFloat(data.l)   : null;
                const chg = data.c   ? parseFloat(data.c)   : null;
                const pc  = data.pc  ? parseFloat(data.pc)  : null;
                const vol = data.v   ? parseInt(data.v)     : null;

                // Always update market data regardless of trade status
                const elBid  = document.getElementById(`term-bid-${index}`);
                const elAsk  = document.getElementById(`term-ask-${index}`);
                const elLtp  = document.getElementById(`term-ltp-${index}`);
                const elHigh = document.getElementById(`term-high-${index}`);
                const elLow  = document.getElementById(`term-low-${index}`);
                const elChg  = document.getElementById(`term-change-${index}`);
                const elPc   = document.getElementById(`term-pc-${index}`);
                const elVol  = document.getElementById(`term-volume-${index}`);

                if (elBid  && bid  !== null) elBid.innerText  = bid.toFixed(2);
                if (elAsk  && ask  !== null) elAsk.innerText  = ask.toFixed(2);
                if (elLtp  && ltp  !== null) elLtp.innerText  = ltp.toFixed(2);
                if (elHigh && high !== null) elHigh.innerText = high.toFixed(2);
                if (elLow  && low  !== null) elLow.innerText  = low.toFixed(2);
                if (elChg  && chg  !== null) { elChg.innerText = chg.toFixed(2); elChg.className = chg >= 0 ? 'text-profit' : 'text-loss'; }
                if (elPc   && pc   !== null) { elPc.innerText  = pc.toFixed(2) + '%'; elPc.className = pc >= 0 ? 'text-profit' : 'text-loss'; }
                if (elVol  && vol  !== null) elVol.innerText = vol;

                if (item.status === 'Closed') {
                    // ── Frozen P&L for closed terminal rows — only LTP live ──────
                    const exitPx = parseFloat(item.exitAt)  || 0;
                    const entry  = parseFloat(item.entryAt) || 0;
                    if (exitPx > 0 && entry > 0) {
                        const frozenChg = item.side === 'BUY' ? (exitPx - entry) : (entry - exitPx);
                        const frozenPct = (frozenChg / entry) * 100;
                        const frozenPl  = (frozenChg * (parseInt(item.qty) || 0)).toFixed(2);
                        const cls = frozenChg >= 0 ? 'text-profit' : 'text-loss';
                        const elChg2e = document.getElementById(`term-chg2e-${index}`);
                        const elPct2e = document.getElementById(`term-pct2e-${index}`);
                        const elTotP  = document.getElementById(`term-totprofit-${index}`);
                        if (elChg2e) { elChg2e.innerText = frozenChg.toFixed(2); elChg2e.className = cls; }
                        if (elPct2e) { elPct2e.innerText = frozenPct.toFixed(2) + '%'; elPct2e.className = cls; }
                        if (elTotP)  { elTotP.innerText  = '₹' + frozenPl; elTotP.className = cls + ' text-bold'; }
                    }
                    return;  // do NOT update entry signal / exit action for closed rows
                }

                // ── Live entry signal auto-fill (only for open rows) ─────────
                const signalEl = document.getElementById(`term-signal-${index}`);
                const limitEl  = document.getElementById(`term-limit-${index}`);
                const sideEl   = document.getElementById(`term-side-${index}`);
                if (signalEl && limitEl) {
                    const sig  = signalEl.value;
                    const side = sideEl ? sideEl.value : 'BUY';
                    if (sig === 'LTP' && ltp !== null) {
                        limitEl.value = ltp.toFixed(2);
                        item.limitPrice = limitEl.value;
                    } else if (sig === 'Market') {
                        if (side === 'BUY') {
                            const calc = (bid !== null && bid > 0) ? (bid + 0.05) : (ltp !== null ? ltp : 0);
                            limitEl.value = calc > 0 ? calc.toFixed(2) : '';
                        } else {
                            const calc = (ask !== null && ask > 0) ? (ask - 0.05) : (ltp !== null ? ltp : 0);
                            limitEl.value = calc > 0 ? calc.toFixed(2) : '';
                        }
                        item.limitPrice = limitEl.value;
                    }
                }

                const exitActionEl = document.getElementById(`term-exitaction-${index}`);
                const exitPriceEl  = document.getElementById(`term-exitprice-${index}`);
                if (exitActionEl && exitPriceEl && exitActionEl.value !== 'Exit by Price') {
                    exitPriceEl.value = '';
                    item.exitPrice = '';
                }

                // ── Live P&L for open rows ───────────────────────────────────
                if (ltp !== null && item.entryAt > 0) {
                    const chg2e = item.side === 'BUY' ? (ltp - item.entryAt) : (item.entryAt - ltp);
                    const pct2e = (chg2e / item.entryAt) * 100;
                    const totP  = chg2e * (parseInt(item.qty) || 0);
                    const cls   = chg2e >= 0 ? 'text-profit' : 'text-loss';
                    const elChg2e = document.getElementById(`term-chg2e-${index}`);
                    const elPct2e = document.getElementById(`term-pct2e-${index}`);
                    const elTotP  = document.getElementById(`term-totprofit-${index}`);
                    if (elChg2e) { elChg2e.innerText = chg2e.toFixed(2); elChg2e.className = cls; }
                    if (elPct2e) { elPct2e.innerText = pct2e.toFixed(2) + '%'; elPct2e.className = cls; }
                    if (elTotP)  { elTotP.innerText  = totP.toFixed(2);  elTotP.className  = cls + ' text-bold'; }
                }
            }
        });
        this.updateTerminalTotalMtm();
    },

    renderTerminalTable() {
        const headerRow = document.getElementById('trade-terminal-headers');
        const tb = document.getElementById('trade-terminal-body');
        if (!headerRow || !tb) return;
        
        let headerHtml = '';
        this.state.terminalColumns.forEach((col, index) => {
            const widthStyle = col.width ? `width: ${col.width}; min-width: ${col.width};` : '';
            headerHtml += `<th draggable="true" 
                ondragstart="app.dragColumn(event, ${index})" 
                ondragover="app.allowDropColumn(event)" 
                ondrop="app.dropColumn(event, ${index})" 
                style="position: relative; cursor: move; user-select: none; background: rgba(168, 85, 247, 0.1); color: #c084fc; ${widthStyle}">
                <span style="pointer-events: none;">${col.label} ↕</span>
                <div class="resizer" onmousedown="app.initResize(event, ${index})" style="position: absolute; top: 0; right: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 10; user-select: none;"></div>
            </th>`;
        });
        headerRow.innerHTML = headerHtml;
        
        let rowHtml = '';
        this.state.terminalRows.forEach((item, index) => {
            const liveKey = item.resolvedSymbol ? `NFO|${item.resolvedSymbol}` : `${item.exchange}|${item.token}`;
            const live = this.state.liveData[liveKey] || this.state.liveData[item.resolvedSymbol] || this.state.liveData[`${item.exchange}|${item.token}`] || {};
            const ltp = live.lp ? parseFloat(live.lp) : 0;
            const bid = live.bp1 ? parseFloat(live.bp1) : 0;
            const ask = live.sp1 ? parseFloat(live.sp1) : 0;
            const high = live.h ? parseFloat(live.h) : 0;
            const low = live.l ? parseFloat(live.l) : 0;
            const chg = live.c ? parseFloat(live.c) : 0;
            const pc = live.pc ? parseFloat(live.pc) : 0;
            const vol = live.v ? parseInt(live.v) : 0;
            
            const roundToTick = (val, tickSize = 0.05) => {
                if (val === null || val === undefined || isNaN(val)) return '-';
                return (Math.round(parseFloat(val) / tickSize) * tickSize).toFixed(2);
            };

            // Compute baseline option pricing if live tick is pending
            let estLtp = null;
            if (!ltp && (item.resolvedSymbol || item.inputSymbol)) {
                const resSymU = ((item.resolvedSymbol || item.inputSymbol || '')).toUpperCase();
                const numMatch = resSymU.match(/(CE|PE|C|P)?(\d{3,6})/);
                const strike = numMatch ? parseFloat(numMatch[2]) : (parseFloat(item.strike) || 0);
                if (strike > 0) {
                    const sLtp = strike > 10000 ? 24900 : (strike > 1000 ? 1000 : 500);
                    const isCe = resSymU.includes('CE') || item.type === 'CE' || resSymU.includes('C');
                    const intrinsic = isCe ? Math.max(0, sLtp - strike) : Math.max(0, strike - sLtp);
                    const timeVal = Math.max(5.0, strike * 0.015);
                    estLtp = intrinsic > 0 ? (intrinsic + timeVal) : timeVal;
                } else if (item.type === 'EQ' || item.type === 'FUT') {
                    estLtp = 500.0;
                }
            }

            const dispLtp  = ltp > 0 ? ltp.toFixed(2) : (estLtp !== null ? roundToTick(estLtp) : '-');
            const dispBid  = bid > 0 ? bid.toFixed(2) : (estLtp !== null ? roundToTick(estLtp * 0.995) : '-');
            const dispAsk  = ask > 0 ? ask.toFixed(2) : (estLtp !== null ? roundToTick(estLtp * 1.005) : '-');
            const dispHigh = high > 0 ? high.toFixed(2) : (estLtp !== null ? roundToTick(estLtp * 1.05) : '-');
            const dispLow  = low > 0 ? low.toFixed(2) : (estLtp !== null ? roundToTick(estLtp * 0.95) : '-');
            const dispChg  = chg !== 0 ? chg.toFixed(2) : (estLtp !== null ? roundToTick(estLtp * 0.005) : '0.00');
            const dispPc   = pc !== 0 ? pc.toFixed(2) + '%' : '0.00%';

            const isClosed = item.status === 'Closed';
            const isEnded = item.status === 'Closed' || item.status === 'Rejected' || item.status === 'Canceled';
            const rowStyle = isClosed
                ? 'opacity:0.5; background:rgba(0,0,0,0.28); pointer-events:none;'
                : '';

            // For closed rows: show frozen P&L from exitAt, not live LTP
            let chg2e = 0, pct2e = 0;
            const entry = parseFloat(item.entryAt) || 0;
            const lots  = parseInt(item.lotsize) || 1;
            const isBuy = item.side === 'BUY';
            if (isClosed && item.exitAt && entry > 0) {
                const exitPx = parseFloat(item.exitAt)  || 0;
                chg2e = isBuy ? (exitPx - entry) : (entry - exitPx);
                pct2e = entry > 0 ? (chg2e / entry) * 100 : 0;
            } else if (!isEnded && ltp > 0 && entry > 0) {
                chg2e = isBuy ? (ltp - entry) : (entry - ltp);
                pct2e = (chg2e / entry) * 100;
            }
            const isPos  = chg2e >= 0;
            const chgCls = chg2e !== 0 ? (isPos ? 'text-profit' : 'text-loss') : '';
            const totP   = (isClosed && item.exitAt && entry > 0)
                ? '₹' + (chg2e * (parseInt(item.qty) || 0)).toFixed(2)
                : (entry > 0 && ltp > 0 ? (chg2e * (parseInt(item.qty)||0)).toFixed(2) : '-');

            // Compute target price level from ₹ target input (same as Trade Exit)
            let targetPrice = '-';
            if (item.target !== '' && parseFloat(item.target) > 0 && entry > 0) {
                const tgtRs = parseFloat(item.target);
                const qty = parseInt(item.qty) || 1;
                targetPrice = (isBuy ? entry + tgtRs/qty : entry - tgtRs/qty).toFixed(2);
            }

            let actionBtn = '';
            if (isClosed) {
                actionBtn = `<button disabled style="padding:3px 14px;font-size:0.75rem;background:rgba(180,0,0,0.25);border:1px solid var(--loss);border-radius:4px;color:var(--loss);cursor:not-allowed;font-weight:700;">⛔ Closed</button>`;
            } else if (item.status === 'Rejected') {
                actionBtn = `<button class="primary" onclick="app.submitTerminalEntry(${index})" style="padding:3px 10px;font-size:0.75rem;background:var(--profit);border:none;border-radius:4px;cursor:pointer;color:#fff;">Resubmit</button>`;
            } else if (item.status === 'Canceled') {
                actionBtn = `<button class="primary" onclick="app.submitTerminalEntry(${index})" style="padding:3px 10px;font-size:0.75rem;background:var(--profit);border:none;border-radius:4px;cursor:pointer;color:#fff;">Resubmit</button>`;
            } else if (item.status === 'Inactive') {
                actionBtn = `<button class="primary" onclick="app.submitTerminalEntry(${index})" style="padding:3px 10px;font-size:0.75rem;background:var(--profit);border:none;border-radius:4px;cursor:pointer;color:#fff;">Submit</button>`;
            } else if (item.status === 'Submitting') {
                actionBtn = `<button disabled style="padding:3px 10px;font-size:0.75rem;background:var(--text-secondary);border:none;border-radius:4px;color:#fff;opacity:0.6;">Submitting</button>`;
            } else if (item.status === 'Pending') {
                actionBtn = `<button class="primary" onclick="app.cancelTerminalEntry(${index})" style="padding:3px 6px;font-size:0.75rem;background:var(--accent);color:#000;border:none;border-radius:4px;cursor:pointer;font-weight:700;" title="Click to cancel pending order">Pndng/Cncl</button>`;
            } else {
                if (item.exitPending) {
                    actionBtn = `<button onclick="app.toggleTerminalExitPending(${index})" style="padding:3px 10px;font-size:0.75rem;background:var(--accent);color:#000;border:none;border-radius:4px;cursor:pointer;">Waiting</button>`;
                } else {
                    actionBtn = `<button onclick="app.toggleTerminalExitPending(${index})" style="padding:3px 10px;font-size:0.75rem;background:var(--loss);border:none;border-radius:4px;cursor:pointer;color:#fff;">EXIT</button>`;
                }
            }

            const closedDecor  = isClosed ? 'text-decoration:line-through;' : '';
            const statusColor  = isEnded ? 'var(--loss)' : item.status==='Active' ? 'var(--profit)' : item.status==='Pending' ? 'var(--accent)' : 'var(--text-secondary)';
            const statusLabel  = isClosed ? '⛔ Closed' : item.status === 'Rejected' ? '❌ Rejected' : item.status === 'Canceled' ? '⚠ Canceled' : item.status;
            const sideColor    = isBuy ? 'var(--profit)' : 'var(--loss)';
            // Latest SL color: green if TSL active, amber if initial-only, grey if no SL
            const latestSLColor = item.tsl ? 'var(--profit)' : (item.latestSL ? 'var(--accent)' : 'var(--text-secondary)');

            const isSlValueDisabled = (isEnded || item.slType === 'No SL') ? 'disabled' : '';
            const isExitPriceDisabled = (isEnded || item.exitAction !== 'Exit by Price') ? 'disabled' : '';

            const isEntryDisabled = item.status === 'Pending' || item.status === 'Active' || item.status === 'Closed' || item.status === 'Submitting';
            const entryDisableAttr = isEntryDisabled ? 'disabled' : '';
            const isLimitPriceDisabled = isEntryDisabled || item.signal !== 'Limit';
            const limitPriceDisableAttr = isLimitPriceDisabled ? 'disabled' : '';

            const cells = {
                sno: `<td>${index + 1}</td>`,
                index_exch: `<td><select id="term-index-${index}" onchange="app.handleCanonicalFieldChange(${index})" ${entryDisableAttr} style="padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);"><option value="NSE" ${item.indexExch==='NSE'?'selected':''}>NSE</option><option value="NFO" ${item.indexExch==='NFO'?'selected':''}>NFO</option><option value="BSE" ${item.indexExch==='BSE'?'selected':''}>BSE</option><option value="BFO" ${item.indexExch==='BFO'?'selected':''}>BFO</option><option value="MCX" ${item.indexExch==='MCX'?'selected':''}>MCX</option><option value="CDS" ${item.indexExch==='CDS'?'selected':''}>CDS</option></select></td>`,
                instrument: `<td><input type="text" id="term-inst-${index}" value="${item.instrument||''}" onchange="app.handleCanonicalFieldChange(${index})" onkeyup="if(event.key==='Enter') app.handleCanonicalFieldChange(${index})" ${entryDisableAttr} placeholder="e.g. SBIN, NIFTY, LUPIN" style="width:100px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);text-transform:uppercase;"></td>`,
                type: `<td><select id="term-type-${index}" onchange="app.handleCanonicalFieldChange(${index})" ${entryDisableAttr} style="padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);"><option value="EQ" ${item.type==='EQ'?'selected':''}>EQ</option><option value="FUT" ${item.type==='FUT'?'selected':''}>FUT</option><option value="CE" ${item.type==='CE'?'selected':''}>CE</option><option value="PE" ${item.type==='PE'?'selected':''}>PE</option></select></td>`,
                expiry: `<td><input type="text" id="term-expiry-${index}" value="${item.expiry||(item.type==='EQ'?'DISABLED':'Near')}" onchange="app.handleCanonicalFieldChange(${index})" onkeyup="if(event.key==='Enter') app.handleCanonicalFieldChange(${index})" ${(entryDisableAttr || item.type==='EQ') ? 'disabled' : ''} placeholder="e.g. 25AUG26 or Near" style="width:85px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);text-transform:uppercase;text-align:center;"></td>`,
                strike: `<td><input type="number" step="10" id="term-strike-${index}" value="${item.strike||''}" onchange="app.handleCanonicalFieldChange(${index})" onkeyup="if(event.key==='Enter') app.handleCanonicalFieldChange(${index})" ${(entryDisableAttr || item.type==='EQ' || item.type==='FUT') ? 'disabled' : ''} placeholder="e.g. 2300" style="width:65px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);text-align:center;"></td>`,
                symbol: `<td style="font-weight:bold;color:#38bdf8;">${item.resolvedSymbol || item.inputSymbol || '-'}</td>`,
                best_buy: `<td id="term-bid-${index}" style="color:#93c5fd;">${dispBid}</td>`,
                best_sell: `<td id="term-ask-${index}" style="color:#f87171;">${dispAsk}</td>`,
                high: `<td id="term-high-${index}">${dispHigh}</td>`,
                low: `<td id="term-low-${index}">${dispLow}</td>`,
                ltp: `<td id="term-ltp-${index}" style="font-weight:bold;">${dispLtp}</td>`,
                change: `<td id="term-change-${index}" class="${dispChg !== '0.00' ? (parseFloat(dispChg) >= 0 ? 'text-profit' : 'text-loss') : ''}">${dispChg}</td>`,
                change_pc: `<td id="term-pc-${index}" class="${dispPc !== '0.00%' ? (parseFloat(dispPc) >= 0 ? 'text-profit' : 'text-loss') : ''}">${dispPc}</td>`,
                volume: `<td id="term-volume-${index}">${vol > 0 ? vol : '-'}</td>`,
                qty: `<td><input type="number" id="term-qty-${index}" value="${item.qty||''}" onchange="app.updateTerminalField(${index}, 'qty', parseInt(this.value)||0)" ${entryDisableAttr} style="width:55px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);text-align:center;"></td>`,
                side: `<td><select id="term-side-${index}" onchange="app.updateTerminalField(${index}, 'side', this.value); app.handleTerminalSignalChange(${index})" ${entryDisableAttr} style="padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);"><option value="" ${item.side===''?'selected':''} disabled>Select</option><option value="BUY" ${item.side==='BUY'?'selected':''}>BUY</option><option value="SELL" ${item.side==='SELL'?'selected':''}>SELL</option></select></td>`,
                signal: `<td><select id="term-signal-${index}" onchange="app.updateTerminalField(${index}, 'signal', this.value); app.handleTerminalSignalChange(${index})" ${entryDisableAttr} style="padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);"><option value="" ${item.signal===''?'selected':''} disabled>Select</option><option value="Market" ${item.signal==='Market'?'selected':''}>Market</option><option value="LTP" ${item.signal==='LTP'?'selected':''}>LTP</option><option value="Limit" ${item.signal==='Limit'?'selected':''}>Limit</option></select></td>`,
                limit_price: `<td><input type="number" step="0.05" id="term-limit-${index}" value="${item.limitPrice||''}" onchange="app.updateTerminalField(${index}, 'limitPrice', parseFloat(this.value)||0)" ${limitPriceDisableAttr} style="width:65px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);text-align:center;"></td>`,
                entry_done: `<td id="term-entrydone-${index}" style="font-weight:bold;">${item.entryDoneAt || '-'}</td>`,
                order_id: `<td id="term-orderid-${index}">${item.entryOrderId || '-'}</td>`,
                remarks: `<td id="term-remarks-${index}" style="font-weight:bold;font-size:0.75rem;color:${item.status==='Active'?'var(--profit)':(item.status==='Closed'?'var(--loss)':'var(--text-secondary)')}">${item.entryRemarks || ''}</td>`,
                entry_at: `<td id="term-entryat-${index}">${item.entryAt || '-'}</td>`,
                status: `<td id="term-status-${index}" style="font-weight:bold;color:${statusColor}">${statusLabel}</td>`,
                chg2entry: `<td id="term-chg2e-${index}" class="${chgCls}">${chg2e !== 0 ? chg2e.toFixed(2) : '-'}</td>`,
                chg2entry_pc: `<td id="term-pct2e-${index}" class="${chgCls}">${pct2e !== 0 ? pct2e.toFixed(2) + '%' : '-'}</td>`,
                tot_profit: `<td id="term-totprofit-${index}" class="${chgCls}" style="font-weight:bold;">${totP}</td>`,
                target: `<td><input type="number" value="${item.target||''}" onchange="app.updateTerminalField(${index}, 'target', parseFloat(this.value)||0)" style="width:65px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);text-align:center;"></td>`,
                tgt_price: `<td id="term-tgtprice-${index}" style="color:var(--profit);font-weight:bold;text-align:right;">${targetPrice}</td>`,
                sl_type: `<td><select onchange="app.updateTerminalField(${index}, 'slType', this.value)" style="padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);"><option value="" ${item.slType===''?'selected':''} disabled>Select</option><option value="No SL" ${item.slType==='No SL'?'selected':''}>No SL</option><option value="SL by total loss" ${item.slType==='SL by total loss'?'selected':''}>By Tot Loss</option></select></td>`,
                sl_value: `<td><input type="number" id="term-slval-${index}" value="${item.slValue||''}" onchange="app.updateTerminalField(${index}, 'slValue', parseFloat(this.value)||0)" onkeydown="app.handleTerminalSlValKeydown(event, ${index})" ${isSlValueDisabled} style="width:60px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);text-align:center;"></td>`,
                tsl: `<td style="text-align:center;"><input type="checkbox" title="Trailing Stop Loss" onchange="app.updateTerminalField(${index}, 'tsl', this.checked)" ${item.tsl?'checked':''}></td>`,
                sl2cost: `<td><input type="number" value="${item.moveToCostAt||''}" onchange="app.updateTerminalField(${index}, 'moveToCostAt', parseFloat(this.value)||0)" style="width:60px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);text-align:center;"></td>`,
                add_exit: `<td><select onchange="app.updateTerminalField(${index}, 'addExit', this.value)" ${isEnded?'disabled':''} style="padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);"><option value="" ${item.addExit===''?'selected':''} disabled>Select</option><option value="Add" ${item.addExit==='Add'?'selected':''}>Add</option><option value="Exit" ${item.addExit==='Exit'?'selected':''}>Exit</option></select></td>`,
                exit_action: `<td><select id="term-exitaction-${index}" onchange="app.updateTerminalField(${index}, 'exitAction', this.value); app.handleTerminalExitActionChange(${index})" ${item.exitPending||isEnded?'disabled':''} style="padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);"><option value="" ${item.exitAction===''?'selected':''} disabled>Select</option><option value="Exit by LTP" ${item.exitAction==='Exit by LTP'?'selected':''}>Exit by LTP</option><option value="Exit by Price" ${item.exitAction==='Exit by Price'?'selected':''}>Exit by Price</option><option value="Exit by Market" ${item.exitAction==='Exit by Market'?'selected':''}>Exit by Market</option></select></td>`,
                exit_limit: `<td><input type="number" id="term-exitprice-${index}" value="${item.exitPrice||''}" onchange="app.updateTerminalField(${index}, 'exitPrice', parseFloat(this.value)||0)" ${isExitPriceDisabled} style="width:65px;padding:2px;font-size:0.75rem;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-lighter);color:var(--text-primary);text-align:center;"></td>`,
                initial_sl: `<td id="term-initialsl-${index}" style="color:var(--accent);font-weight:bold;text-align:right;">${item.initialSL||'-'}</td>`,
                latest_sl: `<td id="term-latestsl-${index}" style="color:${latestSLColor};font-weight:bold;text-align:right;">${item.latestSL||'-'}</td>`,
                exit_at: `<td id="term-exitat-${index}" style="color:var(--profit);font-weight:bold;text-align:right;">${item.exitAt||'-'}</td>`,
                cancel: `<td><input type="checkbox" onchange="app.toggleTerminalCancelChecked(${index}, this.checked)"${item.status==='Pending'?'':' disabled'}${item.cancelChecked?' checked':''} style="width:16px;height:16px;"></td>`,
                action: `<td>${actionBtn}</td>`
            };
            
            rowHtml += `<tr>`;
            this.state.terminalColumns.forEach(col => {
                rowHtml += cells[col.id] || '<td>-</td>';
            });
            rowHtml += `</tr>`;
        });
        
        tb.innerHTML = rowHtml;
        
        const countEl = document.getElementById('trade-terminal-count');
        if (countEl) countEl.innerText = `${this.state.terminalRows.length} rows`;
        this.updateTerminalTotalMtm();
    }
};

window.app = app;
window._realApp = app;
if (window._pendingBrokerLaunch) {
    const pending = window._pendingBrokerLaunch;
    delete window._pendingBrokerLaunch;
    app.launchBroker(pending);
}

window.onload = () => app.init();


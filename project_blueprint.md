# FnO Stock Trading Application - Complete Project Blueprint & Knowledge Archive

**Archive Date**: September 10, 2026  
**Document Classification**: Comprehensive Zero-Loss Technical Blueprint  
**Application Title**: FnO Stock Trading Application (Enterprise Edition)  
**Target Environment**: Windows / Python 3.10+ / Node (Frontend Static Assets)  
**Authors**: Antigravity Pair-Programming Agent & System Architect  

---

## SECTION 1: PROJECT PURPOSE & BUSINESS LOGIC

### 1.1 Problem Statement & Core Value Proposition
Retail and semi-institutional derivative traders in the Indian stock market (NSE / BSE F&O) face major operational and technological hurdles when scalping or running algorithmic strategies:
1. **Broker Outages & Feed Resets**: Broker API WebSockets frequently disconnect, proxy-reset, or rate-limit during peak volatility (e.g. 09:15-09:30 AM market open). Standard open-source client libraries (like `NorenRestApiPy` or `myntapi`) contain severe connection lifecycle bugs that spawn zombie threads, enter infinite busy-spin warning loops (`socket is already opened`), choke CPU/disk, and require hard restarts during trading hours.
2. **Execution Slippage in Fast Options Markets**: Placing plain market orders on illiquid or high-beta stock options causes extreme price slippage. Placing static limit orders leads to missed fills as the underlying spot moves away. Traders require dynamic **limit order chasing** that walks bid/ask touchlines until filled within defined slippage thresholds.
3. **Complex Strike Geometry**: NSE lists over 200+ distinct F&O underlying stocks with heterogeneous strike step intervals (e.g. 0.5 for low-priced equities, up to 100 for high-priced stocks), lot sizes, and monthly/weekly expiration schedules. Manual calculation or static tables lead to stale strikes and calculation errors.
4. **Broker Vendor Lock-In**: Trading desks need the ability to switch execution venues (Flattrade, Upstox, Zebu) instantaneously without rebooting systems, losing live market data feeds, or changing client-side interfaces.

### 1.2 Target Audience
- Systematic options scalpers and intraday momentum traders trading NSE Futures & Options.
- Multi-account proprietary desks requiring automated limit order chasing and spread capture.
- Developers needing a multi-broker framework with paper-trading mode and dual-port tick relays.

### 1.3 Feature Rationale ("Why" Behind Every Feature)
- **Multi-Broker Plugin Layer (`brokers/`)**: Isolates authentication, order schema, and WebSocket feeds behind a unified `BaseBroker` interface. If Flattrade experiences an outage, switching to Zebu or Upstox takes one API call or UI button press without losing the UI state.
- **Zero-Zombie WebSocket Lifecycle Engine**: Solves the NorenApi/Cloudflare reconnect crash by forcing clean socket disposal, 2.0s worker thread joins, 1.0s backoff delays, and immediate redundant thread termination.
- **Dynamic Strike Calculator (`data/fno_strike_calculator.py`)**: Automatically scans and computes true strike intervals, lot sizes, and ATM strikes across ~216 F&O scrips from daily official NSE CSV files.
- **Order Chasing Execution Engine (`brokers/execution_engine.py`)**: Replaces manual order modification with a dedicated chasing loop that monitors L1 quotes, adjusts limit prices by defined tick increments, and cancels or completes based on max-chase bounds.
- **Paper Trading Mode**: Evaluates strategies against live L1/L2 broker ticks with simulated execution fills before committing real risk capital.
- **Dual-Server Tick Relay (Port 8095 <-> 8000)**: Allows running an experimental or companion terminal instance alongside the primary instance by piggybacking on the primary instance's live WebSocket feed, preventing duplicate session errors at the broker.
- **10-Day FIFO Log Retention (`config/logging_config.py`)**: Rotates logs at midnight (`TimedRotatingFileHandler`) and prunes logs older than 10 days in strict FIFO order, preventing disk filling while preserving necessary audit history.

---

## SECTION 2: SYSTEM ARCHITECTURE & DATA FLOW

### 2.1 Component Interaction Architecture

```
+-------------------------------------------------------------------------+
|                              React Frontend                             |
|       (Scalper Grid, Depth Matrix, Option Chain, Chaser Controls)       |
+------------------------------------+------------------------------------+
                                     | WebSocket (/ws/stream, /ws/orders)
                                     | REST (/api/*)
+------------------------------------v------------------------------------+
|                         FastAPI Core Application                        |
|                               (main.py)                                 |
|  - REST Endpoints (/api/status, /api/select_broker, /api/orders, etc.)  |
|  - WebSockets Connection Manager (Client broadcasting)                  |
|  - In-Memory AppState (Live quotes, Subscriptions, Instrument Maps)     |
|  - Daily Master Data Scheduler (09:00 AM download & Strike Diff sync)   |
+---------+--------------------------+--------------------------+---------+
          |                          |                          |
          v                          v                          v
+-------------------+      +-------------------+      +-------------------+
|  Flattrade Broker |      |   Upstox Broker   |      |    Zebu Broker    |
|  - FlatTradeApiPy |      |   - REST Polling  |      |   - ZebuApiPy     |
|  - Zero-Zombie WS |      |   - V3 Protobuf WS|      |   - Zero-Zombie WS|
+---------+---------+      +-------------------+      +---------+---------+
          |                                                     |
          +--------------------------+--------------------------+
                                     |
                                     v
                  +--------------------------------------+
                  |      Dual-Instance Tick Relay        |
                  |  Port 8095 <-----> Port 8000 Relay   |
                  +--------------------------------------+
```

### 2.2 Key In-Memory State Objects (`app_state`)
- `app_state.live_data: Dict[str, Dict[str, Any]]`: Real-time quote cache keyed by canonical symbol (e.g. `NSE|RELIANCE`, `NFO|NIFTY26SEP24500CE`), storing `lp` (LTP), `c` (close), `h` (high), `l` (low), `v` (volume), `oi` (open interest), `tbq` (total buy qty), `tsq` (total sell qty), and bid/ask depth.
- `app_state.subscriptions: Set[str]`: Set of all active subscribed tokens across equities and derivative contracts.
- `app_state.token_to_info: Dict[Tuple[str, str], Dict[str, Any]]`: Mapping `(exchange, token)` -> instrument metadata (Symbol, Strike, Expiry, LotSize).
- `app_state.fno_spot_df: pd.DataFrame`: Master DataFrame containing all active ~216 F&O underlying stocks, their current spot, computed strike steps, and lot sizes.
- `app_state.trade_mode: str`: Either `"PAPER"` or `"REAL"`.

### 2.3 REST API Endpoints

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/api/status` | GET | Returns server status, active broker, trade mode, login state, and subscription count. |
| `/api/brokers` | GET | Lists registered broker plugins (`FLATTRADE`, `UPSTOX`, `ZEBU`) and active status. |
| `/api/select_broker/{broker_name}` | POST | Switches the live active broker at runtime. |
| `/api/set_trade_mode` | POST | Toggles execution between `PAPER` and `REAL`. |
| `/api/orders` | GET | Retrieves open and closed orders. |
| `/api/positions` | GET | Retrieves active net and day positions. |
| `/api/limits` | GET | Retrieves broker margin, cash balance, and collateral limits. |
| `/api/place_order` | POST | Submits a new market, limit, or chasing order. |
| `/api/modify_order` | POST | Modifies price or quantity of an open order. |
| `/api/cancel_order` | POST | Cancels an active open order. |
| `/api/subscribe` | POST | Subscribes a batch of symbols to the live feed. |
| `/api/unsubscribe` | POST | Unsubscribes symbols from the live feed. |
| `/ws/stream` | WebSocket | High-frequency client WebSocket streaming real-time JSON ticks to the frontend. |
| `/ws/order_updates` | WebSocket | Broadcasts real-time order status changes and execution notifications. |

---

## SECTION 3: COMPLETE CODEBASE RECONSTRUCTION

Below is the complete, production-ready, exact code for every script, configuration, styling, and asset file in the repository.
\n
### File: `main.py`
```python
import os
import sys
import time
import json
import logging
import asyncio
import threading

import pandas as pd
from typing import List, Dict, Any, Optional
from datetime import datetime as dt

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    from brokers import flattrade_broker, execution_engine
    from brokers.canonical_symbol_mapper import canonical_mapper
except ModuleNotFoundError:
    from broker import flattrade_broker, execution_engine
    from broker.canonical_symbol_mapper import canonical_mapper

try:
    from data.fno_strike_calculator import load_and_calculate_fno_data
except ModuleNotFoundError:
    try:
        from fno_strike_calculator import load_and_calculate_fno_data
    except ModuleNotFoundError:
        from get_strike_difference_all import load_and_calculate_fno_data
from brokers.flattrade_broker import (
    do_login,
    subscribe_symbols,
    check_api_response_for_expiry,
    trigger_relogin_and_reconnect,
    place_broker_order,
    cancel_broker_order,
    get_all_historical_metrics
)

# Setup Logger with 10-Day FIFO Retention
from config.logging_config import setup_logging, enforce_log_retention
from config.settings import LOG_FILE, LOG_RETENTION_DAYS

logger = setup_logging()

app = FastAPI(title="WebTrader - Enterprise Edition")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.endswith((".html", ".js", ".css")) or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# Include broker-specific routes dynamically
app.include_router(flattrade_broker.router)

from brokers.broker_manager import broker_manager
from brokers.flattrade_broker import FlattradeBroker
from brokers.upstox_broker import UpstoxBroker
from brokers.zebu_broker import ZebuBroker

flattrade_plugin = FlattradeBroker()
upstox_plugin = UpstoxBroker()
zebu_plugin = ZebuBroker()

broker_manager.register_broker(flattrade_plugin)
broker_manager.register_broker(upstox_plugin)
broker_manager.register_broker(zebu_plugin)

@app.get("/api/brokers")
async def get_brokers():
    b_inst = broker_manager.get_active_broker()
    is_running = b_inst.is_logged_in() if b_inst else False
    return {
        "status": "success",
        "brokers": broker_manager.list_brokers(),
        "active": broker_manager._active_broker_name,
        "is_running": is_running,
        "status_text": "RUNNING" if is_running else "STOPPED"
    }

async def ensure_daily_master_data(force: bool = False):
    """
    Checks if FnO stocks, Strike Differences, Lot Sizes and Instrument CSVs have been updated for today.
    If 1st time of the day (or forced), downloads fresh data, calculates metrics, and updates Master_data.csv/xlsx.
    If already updated today, skips the update.
    """
    import datetime as _dt
    script_dir = os.path.dirname(os.path.abspath(__file__))
    instrument_dir = os.path.join(script_dir, "Instrument")
    master_csv = os.path.join(script_dir, "Master_data.csv")
    master_xlsx = os.path.join(script_dir, "Master_data.xlsx")
    nfo_csv = os.path.join(instrument_dir, "NFO_symbols.csv")

    today = _dt.date.today()
    needs_update = force

    if not needs_update:
        if not os.path.exists(nfo_csv) or not os.path.exists(master_csv):
            needs_update = True
        else:
            try:
                mtime_csv = _dt.datetime.fromtimestamp(os.path.getmtime(nfo_csv)).date()
                mtime_master = _dt.datetime.fromtimestamp(os.path.getmtime(master_csv)).date()
                if mtime_csv < today or mtime_master < today:
                    needs_update = True
            except Exception:
                needs_update = True

    if needs_update:
        logger.info("[DAILY MASTER DATA] 1st login of the day detected — Fetching fresh instrument data...")
        # Enforce 10-day FIFO log retention
        try:
            enforce_log_retention(LOG_FILE, LOG_RETENTION_DAYS)
        except Exception as _ex:
            logger.warning(f"[LOG RETENTION] Daily log retention check error: {_ex}")

        try:
            from download_instruments import main as _dl_main
            await asyncio.to_thread(_dl_main)
            
            df, strike_dict = await asyncio.to_thread(load_and_calculate_fno_data, instrument_dir)
            
            if not df.empty:
                df.to_csv(master_csv, index=False)
                try:
                    df.to_excel(master_xlsx, index=False)
                except Exception as ex_excel:
                    logger.warning(f"Could not save Master_data.xlsx: {ex_excel}")
                logger.info(f"[DAILY MASTER DATA] Saved {len(df)} records to Master_data.csv & Master_data.xlsx for {today}.")
            
            app_state.fno_spot_df = df
            app_state.fno_strike_cache = strike_dict
        except Exception as e:
            logger.error(f"[DAILY MASTER DATA] Error updating daily master data: {e}")
    else:
        logger.info(f"[DAILY MASTER DATA] Master data already up to date for today ({today}) — Skipping download.")
        if getattr(app_state, 'fno_spot_df', None) is None or getattr(app_state, 'fno_strike_cache', None) is None:
            df, strike_dict = await asyncio.to_thread(load_and_calculate_fno_data, instrument_dir)
            app_state.fno_spot_df = df
            app_state.fno_strike_cache = strike_dict

@app.post("/api/select_broker/{broker_name}")
async def select_broker(broker_name: str):
    target_name = broker_name.upper()
    current_active = broker_manager._active_broker_name
    current_broker = broker_manager.get_active_broker()

    # 1. Check if already connected & logged into requested broker
    if current_active == target_name and current_broker and current_broker.is_logged_in():
        msg = f"Already connected to {target_name} Broker"
        logger.info(msg)
        return {
            "status": "success",
            "active": target_name,
            "is_running": True,
            "status_text": "RUNNING",
            "message": msg,
            "already_connected": True
        }

    # 2. Logout active broker if switching to a different broker
    previous_broker_name = None
    if current_broker and current_active != target_name:
        previous_broker_name = broker_manager.logout_active_broker() or current_active

    # 3. Switch active broker registry
    success = broker_manager.set_active_broker(target_name)
    if success:
        b_inst = broker_manager.get_active_broker()
        login_success = False
        login_msg = ""
        
        if b_inst:
            if not b_inst.is_logged_in():
                try:
                    login_success, login_msg = await b_inst.login({})
                    if not login_success and login_msg.startswith("AUTH_REQUIRED:"):
                        auth_url = login_msg.split("AUTH_REQUIRED:", 1)[1]
                        return {
                            "status": "auth_required",
                            "active": target_name,
                            "auth_url": auth_url,
                            "message": "Authorization required"
                        }
                except Exception as e:
                    logger.error(f"Error logging into {target_name} broker: {e}")
                    login_msg = str(e)
            else:
                login_success = True
                login_msg = "Session active"

            # 4. Trigger Daily Master Data Check (1st time of the day update)
            try:
                await ensure_daily_master_data()
            except Exception as ex_md:
                logger.error(f"Error checking daily master data: {ex_md}")

            if hasattr(app_state, 'master_dict') and app_state.master_dict:
                try:
                    b_inst.subscribe_symbols(list(app_state.master_dict.keys()))
                except Exception as ex:
                    logger.error(f"Error subscribing symbols for {target_name}: {ex}")

        is_running = b_inst.is_logged_in() if b_inst else False
        status_str = "RUNNING" if is_running else "NOT CONNECTED"

        return {
            "status": "success" if is_running else "error",
            "active": target_name,
            "previous_broker": previous_broker_name,
            "is_running": is_running,
            "status_text": status_str,
            "message": f"Connected to {target_name} Broker ({status_str})" if is_running else f"Failed to connect to {target_name}: {login_msg}"
        }
    return {"status": "error", "message": f"Broker {broker_name} not found"}

# === Global State === #
class AppState:
    api: Optional[NorenApi] = None
    logged_in: bool = False
    trade_mode: str = "PAPER"
    live_data: Dict[str, Any] = {}
    positions: List[Dict[str, Any]] = []
    order_book: List[Dict[str, Any]] = []
    subscriptions: List[str] = []
    main_loop = None
    fno_strike_cache: Dict = {}
    fno_spot_df: Optional[pd.DataFrame] = None
    flattrade_auth_code_future: Optional[asyncio.Future] = None
    pending_updates: Dict[str, Dict[str, Any]] = {}
    pending_updates_lock = threading.Lock()
    websocket_connected: bool = False
    reconnecting: bool = False
    chasing_orders: Dict[str, bool] = {}
    order_mappings: Dict[str, Dict[str, Any]] = {}
    paper_orders: Dict[str, Dict[str, Any]] = {}

app_state = AppState()

# === Vectorized Pandas Filter Evaluator === #
def evaluate_condition_pandas(df: pd.DataFrame, field: str, op: str, val: Any = None, val2: Any = None) -> pd.Series:
    if field not in df.columns:
        return pd.Series(False, index=df.index)
        
    s = df[field]
    
    # Cast to numeric if filtering numerically (Phase 4: type safety & integrity)
    if op in ['>', '<', 'between', '!=0', 'isNum']:
        s_numeric = pd.to_numeric(s, errors='coerce')
        val_num = pd.to_numeric(val, errors='coerce') if val is not None and val != '' else None
        val2_num = pd.to_numeric(val2, errors='coerce') if val2 is not None and val2 != '' else None
        
        if op == '>':
            return s_numeric > val_num
        elif op == '<':
            return s_numeric < val_num
        elif op == 'between':
            return (s_numeric >= val_num) & (s_numeric <= val2_num)
        elif op == '!=0':
            return (s_numeric != 0) & s_numeric.notna()
        elif op == 'isNum':
            return s_numeric.notna()
            
    if op == '=':
        try:
            return pd.to_numeric(s, errors='coerce') == pd.to_numeric(val, errors='coerce')
        except:
            return s.astype(str) == str(val)
            
    if op == '!=null':
        return s.notna() & (s.astype(str).str.strip() != '') & (s.astype(str) != '-') & (s.astype(str) != 'NaN')
        
    if op == 'contains':
        return s.astype(str).str.contains(str(val), case=False, na=False)
        
    return pd.Series(True, index=df.index)


# === WebSocket Manager === #
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.connection_filters: Dict[WebSocket, List[Dict[str, Any]]] = {}

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"Client connected. Active: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        if websocket in self.connection_filters:
            del self.connection_filters[websocket]

    async def broadcast(self, message_type: str, data: Any):
        payload = json.dumps({"type": message_type, "data": data})
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_text(payload)
            except Exception as e:
                logger.error(f"WS error: {e}")
                disconnected.append(connection)
        
        for conn in disconnected:
            self.disconnect(conn)

    async def broadcast_filtered(self, updates_to_send: List[Dict[str, Any]]):
        # Build DataFrame representing updates_to_send enriched with master data & accumulated live data
        full_records = []
        master_dict = getattr(app_state, 'master_dict', None)
        
        for update in updates_to_send:
            key = update.get('key')
            if not key:
                continue
        if not updates_to_send or not self.active_connections:
            return

        payload = json.dumps({"type": "BATCH_QUOTE_UPDATE", "data": updates_to_send})
        for connection in list(self.active_connections):
            try:
                await connection.send_text(payload)
            except Exception as e:
                logger.error(f"WS send error: {e}")
                self.disconnect(connection)

manager = ConnectionManager()

# Inject app_state and manager into the flattrade_broker, upstox_plugin, zebu_plugin and execution_engine modules
from brokers import zebu_broker
flattrade_broker.app_state = app_state
flattrade_broker.manager = manager
upstox_plugin.app_state = app_state
upstox_plugin.manager = manager
upstox_plugin._start_ticker_thread()
zebu_broker.app_state = app_state
zebu_broker.manager = manager
zebu_plugin.app_state = app_state
zebu_plugin.manager = manager
execution_engine.app_state = app_state
execution_engine.manager = manager

async def broadcast_batched_quotes_loop():
    while True:
        try:
            await asyncio.sleep(0.2)  # Broadcast updates 5 times a second (200ms)
            updates_to_send = []
            with app_state.pending_updates_lock:
                if app_state.pending_updates:
                    updates_to_send = list(app_state.pending_updates.values())
                    app_state.pending_updates.clear()
            
            if updates_to_send:
                await manager.broadcast_filtered(updates_to_send)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Error in batch broadcast loop: {e}")

def disable_quick_edit():
    try:
        import sys
        if sys.platform == 'win32':
            import ctypes
            kernel32 = ctypes.windll.kernel32
            hStdIn = kernel32.GetStdHandle(-10) # STD_INPUT_HANDLE = -10
            if hStdIn:
                mode = ctypes.c_ulong()
                if kernel32.GetConsoleMode(hStdIn, ctypes.byref(mode)):
                    # ENABLE_QUICK_EDIT_MODE = 0x0040, ENABLE_EXTENDED_FLAGS = 0x0080
                    # We clear ENABLE_QUICK_EDIT_MODE and set ENABLE_EXTENDED_FLAGS to apply changes
                    new_mode = (mode.value & ~0x0040) | 0x0080
                    kernel32.SetConsoleMode(hStdIn, new_mode)
                    logger.info("Disabled Windows Console QuickEdit mode to prevent keepalive process pauses.")
    except Exception as e:
        logger.warning(f"Could not disable QuickEdit mode: {e}")

@app.on_event("startup")
async def startup_event():
    import logging
    logging.getLogger("urllib3").setLevel(logging.ERROR)
    logging.getLogger("urllib3.connectionpool").setLevel(logging.ERROR)
    logging.getLogger("requests").setLevel(logging.ERROR)

    app_state.main_loop = asyncio.get_running_loop()
    
    # Disable console QuickEdit mode on Windows to avoid process suspension
    disable_quick_edit()
    
    # Start background batch quote broadcast task
    asyncio.create_task(broadcast_batched_quotes_loop())

    # === Auto-download fresh instrument CSVs if stale (older than today) ===
    try:
        import datetime as _dt
        _instrument_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Instrument")
        _nfo_csv = os.path.join(_instrument_dir, "NFO_symbols.csv")
        _needs_download = True
        if os.path.exists(_nfo_csv):
            _mtime = _dt.datetime.fromtimestamp(os.path.getmtime(_nfo_csv)).date()
            if _mtime >= _dt.datetime.now().date():
                _needs_download = False
        if _needs_download:
            logger.info("[STARTUP] Instrument CSVs are stale or missing — downloading fresh data...")
            from download_instruments import main as _dl_main
            await asyncio.to_thread(_dl_main)
            logger.info("[STARTUP] Instrument CSV download complete.")
        else:
            logger.info("[STARTUP] Instrument CSVs are up to date — skipping download.")
    except Exception as _e:
        logger.warning(f"[STARTUP] Instrument auto-download failed (non-fatal): {_e}")

    
def _load_instruments_background():
    try:
        logger.info("Computing F&O strike differences and lot sizes in-memory...")
        script_dir = os.path.dirname(os.path.abspath(__file__))
        instrument_dir = os.path.join(script_dir, "Instrument")
        
        df, strike_dict = load_and_calculate_fno_data(instrument_dir)
        app_state.fno_spot_df = df
        app_state.fno_strike_cache = strike_dict
        logger.info("[SUCCESS] F&O Data cached successfully.")

        logger.info("Loading all instrument symbol mappings for lookup resolution...")
        app_state.symbol_to_token = {}
        app_state.token_to_info = {}
        app_state.nfo_symbol_map = {}
        app_state.nfo_token_map = {}
        
        files_config = {
            'NSE': 'NSE_symbols.csv',
            'NFO': 'NFO_symbols.csv',
            'MCX': 'MCX_symbols.csv',
            'CDS': 'CDS_symbols.csv',
            'BSE': 'BSE_symbols.csv'
        }
        
        for exch, fname in files_config.items():
            csv_path = os.path.join(instrument_dir, fname)
            if os.path.exists(csv_path):
                try:
                    df_sym = pd.read_csv(csv_path, low_memory=False)
                    df_sym['Token'] = df_sym['Token'].fillna('').astype(str)
                    df_sym['TradingSymbol'] = df_sym['TradingSymbol'].fillna('').astype(str)
                    df_sym['Symbol'] = df_sym['Symbol'].fillna('').astype(str)
                    
                    for _, row in df_sym.iterrows():
                        tok = str(row['Token']).strip()
                        tsym = str(row['TradingSymbol']).strip()
                        sym = str(row.get('Symbol', '')).strip()
                        ls_val = row.get('LotSize')
                        lotsize = int(ls_val) if pd.notna(ls_val) else 1
                        ts_val = row.get('TickSize')
                        if exch == "CDS":
                            ticksize = 0.0025
                        else:
                            try:
                                ts_float = float(ts_val) if pd.notna(ts_val) else 0.05
                                ticksize = ts_float if ts_float >= 0.05 else 0.05
                            except Exception:
                                ticksize = 0.05
                        
                        if not tok or not tsym or tok == 'nan' or tsym == 'nan':
                            continue
                            
                        info = {
                            'Token': tok,
                            'TradingSymbol': tsym,
                            'Symbol': sym,
                            'Instrument': str(row.get('Instrument', '')),
                            'Expiry': str(row.get('Expiry', '')),
                            'LotSize': lotsize,
                            'TickSize': ticksize,
                            'Exchange': exch
                        }
                        
                        app_state.token_to_info[(exch, tok)] = info
                        app_state.symbol_to_token[(exch, tsym.upper())] = tok
                        app_state.symbol_to_token[(exch, tok)] = tok
                        
                        # Ensure EQ instrument always takes precedence for bare Symbol mapping
                        inst_code = str(row.get('Instrument', '')).upper()
                        if (exch, sym.upper()) not in app_state.symbol_to_token or inst_code == 'EQ':
                            app_state.symbol_to_token[(exch, sym.upper())] = tok
                        
                        if exch == 'NFO':
                            app_state.nfo_symbol_map[tsym] = tok
                            app_state.nfo_token_map[tok] = tsym
                except Exception as ex:
                    logger.error(f"Error loading {fname}: {ex}")
        logger.info(f"Loaded unique lookup tokens: {len(app_state.token_to_info)} and symbol-to-token mappings: {len(app_state.symbol_to_token)}")
    except Exception as e:
        logger.error(f"[ERROR] Error loading symbol mapping: {e}")

@app.on_event("startup")
async def startup_event():
    disable_quick_edit()
    asyncio.create_task(asyncio.to_thread(_load_instruments_background))
    logger.info("⚡ Server startup INSTANT! Landing Home Page ready at http://127.0.0.1:8095.")

class LoginParams(BaseModel):
    userid: str
    password: str
    totp_key: str
    vendor_code: str
    api_secret: str
    imei: str = "abcd1234"

class SubscriptionParams(BaseModel):
    exchange: str
    symbol_or_token: str

class BulkSubscriptionParams(BaseModel):
    symbols: List[str]

class TradeOrderParams(BaseModel):
    exchange: str
    symbol: str
    quantity: int
    buy_or_sell: str
    order_type: str  # MARKET, LIMIT, SL-M
    price: float = 0.0
    execution_mode: Optional[str] = None
    limit_price_trigger: Optional[float] = None
    slippage_tolerance: Optional[float] = None
    timeout: Optional[float] = None
    max_retries: Optional[int] = None

class CancelOrderParams(BaseModel):
    order_id: str
    symbol: Optional[str] = None

class TradeModeParams(BaseModel):
    mode: str

class SubsystemResponse(BaseModel):
    status: str
    message: str

@app.get("/flattrade/callback")
async def flattrade_callback(request: Request, request_code: str = None, code: str = None):
    from fastapi.responses import HTMLResponse, RedirectResponse
    
    # Auto-forward to the other port if we are not expecting a login callback on this server
    future_active = getattr(app_state, 'flattrade_auth_code_future', None) is not None and not app_state.flattrade_auth_code_future.done()
    if not future_active:
        our_port = 8095
        try:
            main_path = os.path.join(os.getcwd(), "main.py")
            if os.path.exists(main_path):
                with open(main_path, 'r', encoding='utf-8') as f:
                    for line in f:
                        if 'uvicorn.run(' in line and 'port=' in line:
                            import re
                            m = re.search(r'port\s*=\s*(\d+)', line)
                            if m:
                                our_port = int(m.group(1))
                                break
        except Exception:
            pass
        other_port = 8000 if our_port == 8095 else 8095
        query_str = request.url.query
        redirect_url = f"http://127.0.0.1:{other_port}/flattrade/callback?{query_str}"
        logger.info(f"[PORT PROXY] Forwarding callback to other server on port {other_port} -> {redirect_url}")
        return RedirectResponse(url=redirect_url)

    code_val = request_code or code
    if not code_val:
        code_val = request.query_params.get("request_code") or request.query_params.get("code")
    if app_state.flattrade_auth_code_future and not app_state.flattrade_auth_code_future.done():
        if code_val:
            app_state.flattrade_auth_code_future.set_result(code_val)
            logger.info(f"Callback future resolved with code: {code_val}")
    if code_val:
        # Return HTML that redirects back to the main trading page
        html = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Login Successful</title>
  <style>
    body { background:#0f1117; color:#4ade80; font-family:sans-serif;
           display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
    .box { text-align:center; }
    h2 { font-size:2rem; margin-bottom:0.5rem; }
    p  { color:#94a3b8; }
    .spinner { width:40px; height:40px; border:4px solid #1e293b;
               border-top-color:#4ade80; border-radius:50%;
               animation:spin 0.8s linear infinite; margin:16px auto; }
    @keyframes spin { to { transform:rotate(360deg); } }
  </style>
  <script>
    // Redirect main page back to / so the frontend detects login
    setTimeout(function() { window.location.href = '/'; }, 1500);
  </script>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <h2>✅ Login Successful!</h2>
    <p>Redirecting to WebTrader...</p>
  </div>
</body>
</html>"""
        return HTMLResponse(content=html)
    else:
        return HTMLResponse(content="<h2 style='color:red'>Login failed: no code in callback URL.</h2>", status_code=400)

@app.get("/upstox/callback")
async def upstox_callback(request: Request, code: str = None):
    from fastapi.responses import HTMLResponse
    import requests
    code_val = code or request.query_params.get("code")
    if not code_val:
        return HTMLResponse(content="<h2 style='color:red'>Upstox Login failed: no authorization code received.</h2>", status_code=400)

    token_url = "https://api.upstox.com/v2/login/authorization/token"
    creds = upstox_plugin.load_creds_from_file()
    payload = {
        "code": code_val,
        "client_id": creds.get("api key", "445bbbd2-d56b-48c3-bbec-120bf6a1d8e1"),
        "client_secret": creds.get("api secret", "yzqz28t8xq"),
        "redirect_uri": creds.get("redirect url", "http://localhost:8095/upstox/callback"),
        "grant_type": "authorization_code"
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    try:
        r = requests.post(token_url, data=payload, headers=headers, timeout=10)
        res_data = r.json()
        access_token = res_data.get("access_token")
        if access_token:
            upstox_plugin.save_access_token(access_token)
            upstox_plugin._start_ticker_thread()

            print("\n" + "="*60)
            print("  🟢 UPSTOX AUTHENTICATION SUCCESSFUL!")
            print("  ⚡ ACCESS TOKEN GENERATED & LIVE MARKET DATA STREAM ACTIVE")
            print("="*60 + "\n")
            
            html = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Upstox Login Successful</title>
<style>body{background:#0f1117;color:#4ade80;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}.box{text-align:center;}h2{font-size:2rem;margin-bottom:0.5rem;}p{color:#94a3b8;}</style>
<script>setTimeout(function(){ window.location.href = '/'; }, 1500);</script>
</head>
<body><div class="box"><h2>✅ Upstox Login Successful!</h2><p>Redirecting to WebTrader...</p></div></body>
</html>"""
            return HTMLResponse(content=html)
        else:
            return HTMLResponse(content=f"<h2 style='color:red'>Upstox Token Error: {res_data.get('errors')}</h2>", status_code=400)
    except Exception as e:
        return HTMLResponse(content=f"<h2 style='color:red'>Upstox Exception: {e}</h2>", status_code=500)

# === API Routes === #
@app.post("/api/login", response_model=SubsystemResponse)
async def api_login(params: LoginParams):
    success, msg = await do_login(
        params.userid, params.password, params.totp_key, 
        params.vendor_code, params.api_secret, params.imei
    )
    if success:
        return {"status": "success", "message": f"Welcome {msg}"}
    else:
        return {"status": "error", "message": msg}

class ClientErrorParams(BaseModel):
    message: Optional[str] = None
    source: Optional[str] = None
    lineno: Optional[int] = None
    colno: Optional[int] = None
    error: Optional[str] = None

@app.post("/api/log_error")
async def api_log_error(params: ClientErrorParams):
    logger.error(f"[CLIENT ERROR] Source: {params.source}, Line: {params.lineno}, Col: {params.colno}\nMessage: {params.message}\nStack: {params.error}")
    return {"status": "success"}

@app.post("/api/set_trade_mode")
async def api_set_trade_mode(params: TradeModeParams):
    app_state.trade_mode = params.mode
    logger.info(f"System Trade Mode switched to: {app_state.trade_mode}")
    return {"status": "success", "mode": app_state.trade_mode}

@app.get("/api/status")
async def get_status():
    active_broker = broker_manager.get_active_broker()
    is_active_logged_in = active_broker.is_logged_in() if active_broker else False
    is_logged_in = is_active_logged_in or app_state.logged_in
    api_token = getattr(app_state.api, '_NorenApi__access_token', None) if app_state.api else "ACTIVE"
    return {
        "logged_in": is_logged_in,
        "is_running": is_logged_in,
        "active_broker": broker_manager._active_broker_name,
        "trade_mode": app_state.trade_mode,
        "subscriptions": len(app_state.subscriptions),
        "websocket_connected": app_state.websocket_connected or is_logged_in,
        "access_token": api_token
    }

@app.post("/api/test_update_live_data")
async def api_test_update_live_data(params: Dict[str, Any]):
    key = params.get("key")
    data = params.get("data", {})
    if not key:
        return {"status": "error", "message": "Missing key"}
    if key not in app_state.live_data:
        app_state.live_data[key] = {}
    app_state.live_data[key].update(data)
    with app_state.pending_updates_lock:
        app_state.pending_updates[key] = {"key": key, **app_state.live_data[key]}
    return {"status": "success", "live_data": app_state.live_data[key]}

@app.get("/api/live_data")
async def get_live_data(key: str = None):
    if key:
        return app_state.live_data.get(key, {})
    return list(app_state.live_data.keys())

@app.get("/api/subscriptions")
async def get_subscriptions():
    return app_state.subscriptions

def build_symbol_token_map(df_spots, nse_token_map, Token_list):
    symbol_token_map = {}
    for _, row in df_spots.iterrows():
        sym = row["Symbol"]
        if 'NSETEST' in str(sym).upper() or sym in Token_list or sym not in nse_token_map:
            continue
        token = nse_token_map[sym]
        symbol_token_map[sym] = {"exchange": "NSE", "token": token}
    return symbol_token_map

@app.post("/api/refresh_google_data")
@app.post("/api/refresh_historical_data")
async def api_refresh_historical_data():
    try:
        logger.info("Forcing refresh of 14-day historical metrics via Flattrade broker API...")
        
        if getattr(app_state, 'fno_spot_df', None) is not None and not app_state.fno_spot_df.empty:
            df_spots = app_state.fno_spot_df.drop_duplicates(subset=["Symbol"]).copy()
        else:
            df_spots = pd.DataFrame()

        try:
            df_nse = pd.read_csv("Instrument/NSE_symbols.csv")
            df_nse_eq = df_nse[df_nse['Instrument'] == 'EQ']
            nse_token_map = dict(zip(df_nse_eq['Symbol'], df_nse_eq['Token'].astype(str)))
        except Exception as e:
            logger.warning(f"Could not load NSE_symbols.csv: {e}")
            nse_token_map = {}

        Token_list = {
            'NIFTY': "26000", 'MIDCPNIFTY': "26074", 'BANKNIFTY': "26009", 
            'FINNIFTY': "26037", 'INDIAVIX': "26017", "SENSEX": "1", 
            "SENSEX50": "47", "BANKEX": "12"
        }

        symbol_token_map = build_symbol_token_map(df_spots, nse_token_map, Token_list)

        active_broker = broker_manager.get_active_broker()
        if not active_broker:
            return {"status": "error", "message": "No active broker selected"}

        logger.info(f"Forcing refresh of 14-day historical metrics via {active_broker.get_name()} broker API...")
        loop = asyncio.get_event_loop()
        new_hist_data = await loop.run_in_executor(None, active_broker.fetch_historical_metrics, symbol_token_map, True)

        if new_hist_data:
            app_state.historical_data = new_hist_data
            logger.info(f"Successfully refreshed 14-day historical metrics in-cache via {active_broker.get_name()}.")
            return {"status": "success", "message": f"14-Day Avg Volume & ATR refreshed successfully via {active_broker.get_name()} API!"}
        else:
            return {"status": "error", "message": f"No historical metrics returned from {active_broker.get_name()}"}
    except Exception as e:
        logger.error(f"Failed to refresh historical metrics: {e}")
        return {"status": "error", "message": str(e)}

def fetch_official_nse_oi_baseline() -> dict:
    if getattr(app_state, 'nse_oi_cache', None) is not None and len(app_state.nse_oi_cache) > 0:
        return app_state.nse_oi_cache

    import requests
    session = requests.Session()
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
    }
    try:
        session.get('https://www.nseindia.com', headers=headers, timeout=5)
        r = session.get('https://www.nseindia.com/api/live-analysis-oi-spurts-underlyings', headers=headers, timeout=5)
        if r.status_code == 200:
            items = r.json().get('data', [])
            oi_dict = {}
            for item in items:
                sym = item.get('symbol')
                if sym:
                    oi_dict[sym] = {
                        'oi': item.get('latestOI', 0),
                        'poi': item.get('prevOI', 0),
                        'oi_chg_pc': item.get('avgInOI', 0.0)
                    }
            logger.info(f"[OFFICIAL NSE OI] Loaded official NSE Open Interest data for {len(oi_dict)} F&O scrips.")
            app_state.nse_oi_cache = oi_dict
            return oi_dict
    except Exception as e:
        logger.warning(f"[OFFICIAL NSE OI NOTE] Could not fetch NSE OI data: {e}")
    return getattr(app_state, 'nse_oi_cache', {}) or {}

@app.get("/api/fno_master_data")
@app.get("/api/master_data")
async def api_master_data():
    try:
        if getattr(app_state, 'fno_spot_df', None) is not None and not app_state.fno_spot_df.empty:
            df = app_state.fno_spot_df
        else:
            return {"status": "error", "message": "F&O data not initialized", "data": []}

        df_spots = df.drop_duplicates(subset=["Symbol"]).copy()
        
        try:
            df_nse = pd.read_csv("Instrument/NSE_symbols.csv")
            df_nse_eq = df_nse[df_nse['Instrument'] == 'EQ']
            nse_token_map = dict(zip(df_nse_eq['Symbol'], df_nse_eq['Token'].astype(str)))
        except Exception as e:
            logger.warning(f"Could not load NSE_symbols.csv: {e}")
            nse_token_map = {}
        
        Token_list = {
            'NIFTY': "26000", 'MIDCPNIFTY': "26074", 'BANKNIFTY': "26009", 
            'FINNIFTY': "26037", 'INDIAVIX': "26017", "SENSEX": "1", 
            "SENSEX50": "47", "BANKEX": "12"
        }

        # Cache 14-day historical data (ATR, Volume) locally over page reloads
        symbol_token_map = build_symbol_token_map(df_spots, nse_token_map, Token_list)
        active_broker = broker_manager.get_active_broker()
        if not getattr(app_state, 'historical_data', None):
            if active_broker:
                app_state.historical_data = active_broker.fetch_historical_metrics(symbol_token_map, force_refresh=False)
            else:
                api = getattr(app_state, 'api', None)
                app_state.historical_data = get_all_historical_metrics(api, symbol_token_map, force_refresh=False)
            logger.info(f"Loaded {len(app_state.historical_data)} historical metrics for F&O master data.")

        # Auto-Recovery: detect any symbols missing ATR/AvgVol and auto-fetch them in background
        if app_state.historical_data:
            missing_syms = {s: info for s, info in symbol_token_map.items() if s not in app_state.historical_data or not app_state.historical_data[s].get("ATR") or app_state.historical_data[s].get("ATR") == "-"}
            if missing_syms and active_broker and active_broker.is_logged_in():
                logger.info(f"[AUTO-RECOVERY] Found {len(missing_syms)} missing historical stocks. Fetching in background...")
                def _bg_fetch_missing():
                    try:
                        fresh = active_broker.fetch_historical_metrics(missing_syms, force_refresh=True)
                        if fresh:
                            app_state.historical_data.update(fresh)
                            logger.info(f"[AUTO-RECOVERY] Successfully recovered {len(fresh)} missing historical metrics.")
                    except Exception as ex:
                        logger.error(f"[AUTO-RECOVERY] Error fetching missing metrics: {ex}")
                threading.Thread(target=_bg_fetch_missing, daemon=True).start()

        records = []
        for _, row in df_spots.iterrows():
            sym = row["Symbol"]
            
            # Filter out NSETEST symbols, broad market index symbols, commodities (SILVER, GOLD), and scrips without a cash equity token
            if 'NSETEST' in sym.upper() or sym in Token_list or sym not in nse_token_map or sym.upper() in ['SILVER', 'GOLD', 'SILVERBEES', 'GOLDBEES']:
                continue
            
            lot_size = row.get("LotSize", "-")
            h_data = app_state.historical_data.get(sym, {})
            
            token = nse_token_map[sym]
            key = f"NSE|{sym}"
            canonical_key = canonical_mapper.build_canonical_id("EQ", sym)
            
            # Register multi-broker canonical mappings
            canonical_mapper.register_mapping(canonical_key, "FLATTRADE", str(token), f"{sym}-EQ", "NSE", lot_size)
            canonical_mapper.register_mapping(canonical_key, "UPSTOX", f"NSE_EQ|{token}", sym, "NSE_EQ", lot_size)
            canonical_mapper.register_mapping(canonical_key, "ZEBU", str(token), f"{sym}-EQ", "NSE", lot_size)
            
            records.append({
                "key": key,
                "canonical_key": canonical_key,
                "symbol": sym,
                "tradingsymbol": sym,
                "token": str(token),
                "exchange": "NSE",
                "lotsize": lot_size,
                "atr_14": h_data.get("ATR", "-"),
                "avg_vol": h_data.get("AvgVol", "-")
            })
        # Cache master data DataFrame & dictionary for vectorized filtering (Phase 3)
        app_state.master_df = pd.DataFrame(records).set_index("key")
        app_state.master_dict = app_state.master_df.to_dict('index')

        # Pre-seed live_data with official NSE OI & POI for all F&O scrips to guarantee Present OI & Yesterday's OI for Upstox & all brokers
        nse_oi_data = fetch_official_nse_oi_baseline()
        for r in records:
            sym = r["symbol"]
            info = nse_oi_data.get(sym, {})
            oi_val = info.get("oi")
            poi_val = info.get("poi")
            
            lot_num = 1
            try:
                lot_num = int(r.get("lotsize", 1))
            except Exception:
                pass
            if lot_num <= 0: lot_num = 1
            
            oi_shares = (oi_val * lot_num) if (oi_val and oi_val < 500000) else oi_val
            poi_shares = (poi_val * lot_num) if (poi_val and poi_val < 500000) else poi_val

            r["oi"] = oi_shares or "-"
            r["poi"] = poi_shares or "-"

            # Find associated futures keys
            fut_keys = []
            if hasattr(app_state, 'futures_data') and app_state.futures_data:
                for f in app_state.futures_data:
                    if str(f.get('symbol', '')).upper() == sym.upper():
                        fut_tsym = str(f.get('tradingsymbol', ''))
                        fut_exch = str(f.get('exchange', 'NFO'))
                        fut_keys.extend([f"{fut_exch}|{fut_tsym}", fut_tsym])
            
            all_keys = [f"NSE|{sym}", f"NFO|{sym}", sym] + fut_keys
            for k in set(all_keys):
                if k not in app_state.live_data:
                    app_state.live_data[k] = {}
                if oi_shares is not None and oi_shares > 0:
                    app_state.live_data[k]["oi"] = oi_shares
                if poi_shares is not None and poi_shares > 0:
                    app_state.live_data[k]["poi"] = poi_shares
                
        return {"status": "success", "data": records}
    except Exception as e:
        logger.error(f"Failed to read master data: {e}")
        return {"status": "error", "message": str(e), "data": []}

@app.get("/api/futures_master_data")
async def api_futures_master_data():
    if getattr(app_state, 'futures_data', None) is not None:
        logger.info(f"Returning cached futures data: {len(app_state.futures_data)} records")
        return {"status": "success", "data": app_state.futures_data}
        
    try:
        base_path = "Instrument"
        exchanges = ['NFO']
        results = []
        today = pd.Timestamp(dt.today().date())
        logger.info(f"Loading futures data from {base_path}")
        
        # Get in-memory strike differences
        strike_diff_data = getattr(app_state, 'fno_strike_cache', {})
        logger.info(f"Using {len(strike_diff_data)} cached strike difference records")
        
        for exch in exchanges:
            file_path = os.path.join(base_path, f"{exch}_symbols.csv")
            if not os.path.exists(file_path):
                logger.warning(f"File not found: {file_path}")
                continue
            
            df = pd.read_csv(file_path, low_memory=False)
            logger.info(f"Loaded {len(df)} records from {file_path}")
            
            futures_df = df[df['Instrument'].astype(str) == 'FUTSTK'].copy()
            logger.info(f"Found {len(futures_df)} FUTSTK instruments in {exch}")
            
            if futures_df.empty: continue
            
            # Try multiple date formats
            futures_df['ExpiryDate'] = pd.to_datetime(futures_df['Expiry'], errors='coerce')
            futures_df = futures_df[futures_df['ExpiryDate'] >= today]
            logger.info(f"After expiry filter: {len(futures_df)} records for {exch}")
            
            nse_oi_dict = fetch_official_nse_oi_baseline()
            for sym, grp in futures_df.groupby('Symbol'):
                # Filter out NSETEST symbols
                if 'NSETEST' in sym.upper():
                    continue
                    
                unique_exp = sorted(grp['ExpiryDate'].dropna().unique())
                for _, row in grp.iterrows():
                    exp = row['ExpiryDate']
                    if pd.isnull(exp): continue
                    
                    idx = unique_exp.index(exp)
                    if idx == 0: exp_type = 'Near'
                    elif idx == 1: exp_type = 'Next'
                    elif idx == 2: exp_type = 'Far'
                    else: exp_type = 'Far'
                    
                    inst = str(row['Instrument']).upper()
                    if 'IDX' in inst: cat = 'Index'
                    elif 'STK' in inst: cat = 'Stocks'
                    else: cat = 'Others'
                    
                    # Try to get lot size and strike diff from CSV
                    lookup_key = (sym, exp.strftime('%Y-%m-%d'))
                    extra_data = strike_diff_data.get(lookup_key, {})
                    
                    lotsize = extra_data.get('lotsize', int(row.get('LotSize', 0)))
                    strike_diff = extra_data.get('strike_difference', None)
                    
                    exp_str = exp.strftime('%Y-%m-%d')
                    opt_mask = (df['Symbol'] == sym) & (df['Expiry'] == exp_str) & (df['Instrument'].isin(['OPTSTK', 'OPTIDX']))
                    opt_df = df[opt_mask]
                    strikes = sorted(opt_df['StrikePrice'].dropna().astype(float).unique())
                    
                    tsym = str(row.get('TradingSymbol', row['Token']))
                    fut_token = str(row['Token'])
                    
                    sym_oi_info = nse_oi_dict.get(sym, {})
                    init_oi = sym_oi_info.get("oi")
                    init_poi = sym_oi_info.get("poi")
                    
                    lot_mult = lotsize if (lotsize and lotsize > 0) else 1
                    init_oi_shares = (init_oi * lot_mult) if (init_oi and init_oi < 500000) else init_oi
                    init_poi_shares = (init_poi * lot_mult) if (init_poi and init_poi < 500000) else init_poi

                    # Ensure live_data keys exist for OI & price calculations
                    tsym_alt = tsym[:-3] + "F" if tsym.endswith("FUT") else (tsym[:-1] + "FUT" if tsym.endswith("F") else tsym)
                    fut_keys = [f"{exch}|{tsym}", f"{exch}|{tsym_alt}", f"{exch}|{fut_token}", tsym, tsym_alt, f"{sym}-I.{exch}"]
                    for fk in fut_keys:
                        if fk not in app_state.live_data:
                            app_state.live_data[fk] = {"lp": 0.0, "pc": 0.0}
                        if init_oi_shares is not None and init_oi_shares > 0:
                            app_state.live_data[fk]["oi"] = init_oi_shares
                        if init_poi_shares is not None and init_poi_shares > 0:
                            app_state.live_data[fk]["poi"] = init_poi_shares

                    results.append({
                        'symbol': sym,
                        'tradingsymbol': tsym,
                        'token': fut_token,
                        'exchange': exch,
                        'lotsize': lotsize,
                        'expiry_date': exp.strftime('%d-%b-%Y'),
                        'expiry_type': exp_type,
                        'category': cat,
                        'strike_difference': strike_diff,
                        'strikes': list(strikes)
                    })
        
        logger.info(f"Total futures loaded: {len(results)}")
        app_state.futures_data = results
        return {"status": "success", "data": results}
    except Exception as e:
        logger.error(f"Failed to load futures config: {e}", exc_info=True)
        return {"status": "error", "message": str(e), "data": []}

@app.get("/api/futures_with_prices")
async def api_futures_with_prices():
    """Get futures data with live market prices"""
    try:
        # Get master data first
        master_res = await api_futures_master_data()
        if master_res['status'] != 'success':
            return master_res
        
        futures_list = master_res['data']
        
        # Enrich with live prices from cache
        enriched_futures = []
        for fut in futures_list:
            key = f"{fut['exchange']}|{fut['tradingsymbol']}"
            live_data = app_state.live_data.get(key, {})
            
            enriched_futures.append({
                **fut,
                'ltp': live_data.get('lp', 0.0),
                'change': live_data.get('pc', 0.0),
                'prev_close': live_data.get('o', 0.0),  # Using open as prev_close approximation
                'open': live_data.get('o', 0.0),
                'high': live_data.get('h', 0.0),
                'low': live_data.get('l', 0.0),
                'volume': live_data.get('v', 0),
                'oi': live_data.get('oi') if live_data.get('oi') is not None else fut.get('oi', 0),
                'poi': live_data.get('poi') if live_data.get('poi') is not None else fut.get('poi', 0),
                'strike_difference': fut.get('strike_difference')
            })
        
        return {"status": "success", "data": enriched_futures}
    except Exception as e:
        logger.error(f"Failed to load futures with prices: {e}")
        return {"status": "error", "message": str(e), "data": []}

@app.post("/api/subscribe")
async def api_subscribe(params: SubscriptionParams):
    orig_str = f"{params.exchange}|{params.symbol_or_token}"
    sym_norm = orig_str.replace(':', '|').replace(' ', '|').upper()
    if sym_norm not in app_state.subscriptions:
        app_state.subscriptions.append(sym_norm)
        
    if app_state.logged_in and app_state.api:
        subscribe_symbols([sym_norm])
        return {"status": "success", "message": f"Subscribed to {sym_norm}"}
    return {"status": "success", "message": f"Subscription to {sym_norm} queued (waiting for login)"}

@app.post("/api/subscribe_bulk")
async def api_subscribe_bulk(params: BulkSubscriptionParams):
    added_count = 0
    for sym in params.symbols:
        sym_norm = sym.replace(':', '|').replace(' ', '|').upper()
        if sym_norm not in app_state.subscriptions:
            app_state.subscriptions.append(sym_norm)
            added_count += 1
            
    # Always call active broker and Flattrade subscription if logged in
    active_broker = broker_manager.get_active_broker()
    if active_broker and active_broker.is_logged_in():
        try:
            active_broker.subscribe_symbols(params.symbols)
        except Exception as e:
            logger.error(f"Error subscribing symbols via active broker {active_broker.get_name()}: {e}")
            
    if app_state.logged_in and app_state.api:
        try:
            subscribe_symbols(params.symbols)
        except Exception as e:
            logger.error(f"Error subscribing symbols via Flattrade API: {e}")
            
    return {"status": "success", "message": f"Subscribed {len(params.symbols)} symbols to market feed"}

@app.get("/api/positions")
async def api_positions():
    active_broker = broker_manager.get_active_broker()
    if active_broker and active_broker.is_logged_in() and hasattr(active_broker, 'get_positions'):
        positions = active_broker.get_positions()
        check_api_response_for_expiry(positions)
        if isinstance(positions, dict) and positions.get("stat") == "Not_Ok":
            return {"status": "error", "message": positions.get("emsg", "Failed to fetch positions"), "positions": []}
        return {"status": "success", "positions": positions if positions else []}
    return {"status": "success", "positions": []}

@app.get("/api/orderbook")
async def api_orderbook():
    if app_state.trade_mode == "PAPER":
        orders_list = []
        paper_dict = getattr(app_state, 'paper_orders', {})
        for order_id, o in paper_dict.items():
            import datetime
            ts = o.get("created_at", None)
            if ts:
                norentm = datetime.datetime.fromtimestamp(ts).strftime("%d-%m-%Y %H:%M:%S")
            else:
                norentm = datetime.datetime.now().strftime("%d-%m-%Y %H:%M:%S")
            orders_list.append({
                "norenordno": order_id,
                "status": o.get("status", "PENDING"),
                "qty": str(o.get("qty", 0)),
                "fillshares": str(o.get("filled_qty", 0)),
                "avgprc": str(o.get("avg_price", 0.0)),
                "prc": str(o.get("price", 0.0)),
                "tsym": o.get("symbol", ""),
                "exch": o.get("exchange", ""),
                "trantype": o.get("side", "BUY")[:1].upper(),
                "prd": "M",
                "nstatus": o.get("status", "PENDING"),
                "rejreason": o.get("rejreason", ""),
                "norentm": norentm
            })
        return {"status": "success", "orderbook": orders_list[::-1]}

    active_broker = broker_manager.get_active_broker()
    if active_broker and active_broker.is_logged_in() and hasattr(active_broker, 'get_order_book'):
        book = active_broker.get_order_book()
        check_api_response_for_expiry(book)
        if isinstance(book, dict) and book.get("stat") == "Not_Ok":
            return {"status": "error", "message": book.get("emsg", "Failed to fetch order book"), "orderbook": []}
        return {"status": "success", "orderbook": book if book else []}
    return {"status": "success", "orderbook": []}

@app.get("/api/resolve_symbol")
async def api_resolve_symbol(symbol: str):
    raw_sym = symbol.strip()
    sym_clean = raw_sym.replace(':', '|').replace(' ', '|').upper()
    symbol_to_token = getattr(app_state, 'symbol_to_token', {})
    token_to_info = getattr(app_state, 'token_to_info', {})
    
    token = None
    exch = None

    # 1. Check Canonical Symbol Mapper first
    from brokers.canonical_symbol_mapper import canonical_mapper
    active_broker = broker_manager._active_broker_name or "FLATTRADE"
    
    # Try direct canonical lookup
    b_spec = canonical_mapper.get_broker_spec(raw_sym, active_broker)
    if b_spec and b_spec.get("broker_token"):
        token = b_spec["broker_token"]
        exch = b_spec.get("exchange", "NFO")
    else:
        # Check by reverse token lookup
        c_id = canonical_mapper.get_canonical_id(active_broker, raw_sym)
        if c_id:
            b_spec = canonical_mapper.get_broker_spec(c_id, active_broker)
            if b_spec and b_spec.get("broker_token"):
                token = b_spec["broker_token"]
                exch = b_spec.get("exchange", "NFO")

    # 2. Standard pipe-delimited or direct symbol lookup
    if not token:
        if '|' not in sym_clean:
            exchanges = ['NSE', 'NFO', 'MCX', 'BSE', 'CDS']
            for e in exchanges:
                t = symbol_to_token.get((e, sym_clean))
                if t:
                    exch = e
                    token = t
                    break
            
            # Fuzzy match on TradingSymbol if direct lookup failed
            if not token:
                for (e, t), info in token_to_info.items():
                    tsym = info.get('TradingSymbol', '').upper()
                    if tsym == sym_clean or tsym.startswith(sym_clean):
                        exch = e
                        token = t
                        break
        else:
            parts = sym_clean.split('|')
            if len(parts) == 2:
                exch, name = parts[0], parts[1]
                token = symbol_to_token.get((exch, name))
                if not token:
                    # Try fuzzy match on TradingSymbol for given exchange
                    for (e, t), info in token_to_info.items():
                        if e == exch and info.get('TradingSymbol', '').upper().startswith(name):
                            token = t
                            break
            elif len(parts) >= 3:
                # Canonical 5-part structure: OPT|SYMBOL|EXPIRY|STRIKE|TYPE or FUT|SYMBOL|EXPIRY
                inst_type, sym_name = parts[0], parts[1]
                target_exch = 'NFO' if inst_type in ['FUT', 'OPT'] else 'NSE'
                for (e, t), info in token_to_info.items():
                    if e == target_exch:
                        tsym = info.get('TradingSymbol', '').upper()
                        if tsym.startswith(sym_name) and (parts[-1] in tsym or parts[-2] in tsym):
                            exch = e
                            token = t
                            break

    if not token and '|' not in sym_clean:
        return {"status": "error", "message": f"Symbol {symbol} not found on any exchange"}
    elif not token:
        return {"status": "error", "message": f"Symbol {symbol} could not be resolved"}

    info = token_to_info.get((exch, token))
    if info:
        sub_key = f"{exch}|{token}"
        if sub_key not in app_state.subscriptions:
            app_state.subscriptions.append(sub_key)
            
        tsym_key = f"{exch}|{info['TradingSymbol']}".upper()
        if tsym_key not in app_state.subscriptions:
            app_state.subscriptions.append(tsym_key)
            
        subscribe_symbols([sub_key])
        return {
            "status": "success",
            "token": token,
            "exchange": exch,
            "tradingsymbol": info['TradingSymbol'],
            "symbol": info['Symbol'],
            "lotsize": info['LotSize'],
            "ticksize": info['TickSize']
        }
class CanonicalResolveParams(BaseModel):
    index: Optional[str] = "NSE"
    instrument: str
    type: Optional[str] = "EQ"
    strike: Optional[float] = 0.0
    expiry: Optional[str] = "Near"

@app.post("/api/resolve_canonical_symbol")
async def api_resolve_canonical_symbol(params: CanonicalResolveParams):
    import re, datetime

    def parse_ddmmmyy(exp_str: str) -> str:
        if not exp_str or exp_str.upper() in ["NEAR", "NEXT", "FAR", "DISABLED"]:
            return exp_str.upper()
        clean = re.sub(r'[^a-zA-Z0-9]', '', exp_str).upper()
        if len(clean) == 7 and clean[:2].isdigit() and clean[2:5].isalpha() and clean[5:].isdigit():
            return clean
        for fmt in ['%d-%m-%Y', '%Y-%m-%d', '%d/%m/%Y', '%d-%b-%Y', '%d%b%Y', '%d%b%y']:
            try:
                dt = datetime.datetime.strptime(exp_str, fmt)
                return dt.strftime('%d%b%y').upper()
            except Exception:
                pass
        return clean

    raw_inst = params.instrument.strip().upper()
    raw_type = (params.type or "EQ").strip().upper()
    raw_index = (params.index or "NSE").strip().upper()
    exp_code = parse_ddmmmyy(params.expiry or "Near")
    strike_val = int(params.strike) if (params.strike and params.strike > 0 and params.strike.is_integer()) else (float(params.strike) if (params.strike and params.strike > 0) else None)

    # 1. Check EQ
    if raw_type == "EQ":
        target_eq_exch = raw_index if raw_index in ["NSE", "BSE", "MCX"] else "NSE"
        res = await api_resolve_symbol(f"{target_eq_exch}|{raw_inst}")
        if res.get("status") == "success":
            return res

    # 2. Derivative lookup (FUT, CE, PE)
    target_exch = raw_index if raw_index in ["NFO", "BFO", "MCX", "CDS"] else "NFO"
    token_to_info = getattr(app_state, 'token_to_info', {})
    
    candidates = []
    for (e, t), info in token_to_info.items():
        if (e == target_exch or target_exch == "NFO"):
            sym_u = info.get('Symbol', '').upper()
            tsym_u = info.get('TradingSymbol', '').upper()
            inst_u = str(info.get('Instrument', '')).upper()
            
            if sym_u != raw_inst and not tsym_u.startswith(raw_inst):
                continue
                
            if raw_type == "FUT":
                if not (inst_u.startswith("FUT") or tsym_u.endswith("F")):
                    continue
            elif raw_type in ["CE", "PE"]:
                opt_flag = "C" if raw_type == "CE" else "P"
                if strike_val:
                    stk_str = str(int(strike_val)) if float(strike_val).is_integer() else str(strike_val)
                    pattern = f"{opt_flag}{stk_str}"
                    if pattern not in tsym_u:
                        continue
                else:
                    if opt_flag not in tsym_u:
                        continue
                        
            if exp_code and exp_code not in ["NEAR", "NEXT", "FAR", "DISABLED"]:
                if exp_code not in tsym_u:
                    continue
                    
            # Prioritize exact symbol matches
            is_exact = 1 if sym_u == raw_inst else 2
            candidates.append((is_exact, info.get('Expiry', '9999-99-99'), t, info, e))

    if candidates:
        # Sort by exact symbol match first, then Expiry date ascending
        candidates.sort(key=lambda x: (x[0], x[1]))
        
        cand_idx = 0
        if exp_code == "NEXT" and len(candidates) > 1:
            cand_idx = 1
        elif exp_code == "FAR" and len(candidates) > 2:
            cand_idx = 2
            
        _, _, matched_token, matched_info, matched_exch = candidates[cand_idx]
        
        sub_key = f"{matched_exch}|{matched_token}"
        if sub_key not in app_state.subscriptions:
            app_state.subscriptions.append(sub_key)
        tsym_key = f"{matched_exch}|{matched_info['TradingSymbol']}".upper()
        if tsym_key not in app_state.subscriptions:
            app_state.subscriptions.append(tsym_key)
            
        subscribe_symbols([sub_key])
        return {
            "status": "success",
            "token": matched_token,
            "exchange": matched_exch,
            "tradingsymbol": matched_info['TradingSymbol'],
            "symbol": matched_info['Symbol'],
            "lotsize": matched_info['LotSize'],
            "ticksize": matched_info['TickSize']
        }

    return {"status": "error", "message": f"Could not resolve instrument {raw_inst} {raw_type} {strike_val or ''} {exp_code or ''}"}

@app.post("/api/place_order")
async def api_place_order(params: TradeOrderParams):
    is_paper = (getattr(app_state, 'trade_mode', 'PAPER') == "PAPER")
    if not is_paper:
        active_broker = broker_manager.get_active_broker()
        if not active_broker or not active_broker.is_logged_in():
            raise HTTPException(status_code=401, detail="Broker is not logged in")

    if params.execution_mode:
        from brokers.execution_engine import start_execution_engine
        res = start_execution_engine(params, is_paper)
        return res
    
    order_type = params.order_type.upper()
    price = params.price
    
    # Enforce tick size rule:
    # CDS (Currency Derivatives) tick size: 0.0025, otherwise 0.05
    tick_size = 0.0025 if params.exchange.upper() == "CDS" else 0.05
    decimals = 4 if params.exchange.upper() == "CDS" else 2
    
    # Calculate dynamic price in backend if order_type is MARKET
    if order_type == "MARKET":
        key = f"{params.exchange}|{params.symbol}"
        token = None
        if hasattr(app_state, 'symbol_to_token'):
            token = app_state.symbol_to_token.get((params.exchange.upper(), params.symbol.upper()))
            
        live_data = app_state.live_data.get(key) or app_state.live_data.get(params.symbol) or (app_state.live_data.get(f"{params.exchange}|{token}") if token else {}) or {}
        ltp = float(live_data.get('lp', 0.0))
        bp1 = float(live_data.get('bp1', 0.0))
        sp1 = float(live_data.get('sp1', 0.0))
        
        # Calculate price based on side with Pegged Collar protection
        collar_tol = params.slippage_tolerance if params.slippage_tolerance is not None else 0.03
        side = params.buy_or_sell.upper()
        if side.startswith("B"): # BUY -> Best Buy + tick, capped at Upper Boundary = max(LTP, Best Buy) * (1 + collar%)
            ref_anchor = max(ltp, bp1) if (ltp > 0 or bp1 > 0) else float(params.price or 0)
            upper_bound = math.floor((ref_anchor * (1.0 + collar_tol)) / tick_size) * tick_size if ref_anchor > 0 else 0
            target_px = (bp1 + tick_size) if bp1 > 0 else (ltp if ltp > 0 else params.price)
            price = min(target_px, upper_bound) if upper_bound > 0 else target_px
        else: # SELL -> Best Sell - tick, floored at Lower Boundary = min(LTP, Best Sell) * (1 - collar%)
            ref_anchor = min(ltp, sp1) if (ltp > 0 and sp1 > 0) else (ltp if ltp > 0 else (sp1 if sp1 > 0 else float(params.price or 0)))
            lower_bound = max(tick_size, math.ceil((ref_anchor * (1.0 - collar_tol)) / tick_size) * tick_size) if ref_anchor > 0 else tick_size
            target_px = (sp1 - tick_size) if sp1 > 0 else (ltp if ltp > 0 else params.price)
            price = max(target_px, lower_bound)
        
        # Fallback to params.price or LTP if price collapsed
        ref_p = float(params.price or 0)
        if ref_p > 0.5 and price < (ref_p * 0.5):
            price = ref_p
        elif price <= 0.05 and ref_p > 0:
            price = ref_p
            
        logger.info(f"[MARKET PRICING] Computed pegged limit price for {key} ({side}): {price} (bp1={bp1}, sp1={sp1}, ltp={ltp})")

    # Round price to nearest tick size
    if price > 0:
        price = round(round(price / tick_size) * tick_size, decimals)
    
    if app_state.trade_mode == "PAPER":
        import time
        import random
        order_id = f"PAPER_{int(time.time())}_{random.randint(1000, 9999)}"
        logger.info(f"[PAPER TRADE] Placed: {params.buy_or_sell} {params.quantity} {params.symbol} @ {price}")
        
        # Register standard paper order
        if not hasattr(app_state, 'paper_orders'):
            app_state.paper_orders = {}
        app_state.paper_orders[order_id] = {
            "status": "COMPLETE",
            "qty": params.quantity,
            "filled_qty": params.quantity,
            "remaining_qty": 0,
            "price": price,
            "avg_price": price,
            "symbol": params.symbol,
            "exchange": params.exchange,
            "side": params.buy_or_sell,
            "created_at": time.time()
        }

        
        # Broadcast a mock COMPLETE status update after a brief delay
        async def send_mock_update():
            await asyncio.sleep(0.1)
            mock_order = {
                "norenordno": order_id,
                "status": "COMPLETE",
                "avgprc": str(price),
                "tsym": params.symbol,
                "rejreason": ""
            }
            logger.info(f"[PAPER TRADE] Broadcasting mock update: {mock_order}")
            await manager.broadcast("ORDER_UPDATE", mock_order)
            
        asyncio.create_task(send_mock_update())
        return {"status": "success", "order_id": order_id}
        
    product_type = "M" if params.exchange not in ["NSE", "BSE"] else "C"
    # Force LIMIT order placement for MARKET order types as option market orders are barred by SEBI
    price_type = "LMT" if order_type in ["MARKET", "LIMIT"] else "SL-LMT"
    active_broker = broker_manager.get_active_broker()
    if not active_broker or not active_broker.is_logged_in():
        return {"status": "error", "message": f"Broker {broker_manager._active_broker_name} is not logged in"}

    res = active_broker.place_order(
        buy_or_sell=params.buy_or_sell[0],
        exchange=params.exchange,
        tradingsymbol=params.symbol,
        quantity=params.quantity,
        price_type=price_type,
        price=price,
        trigger_price=price if price_type == "SL-LMT" else None,
        product_type=product_type
    )
    if res is None or (isinstance(res, dict) and (res.get("status") == "error" or res.get("stat") == "Not_Ok")):
        emsg = res.get("message") or res.get("emsg") if isinstance(res, dict) else "Order failed"
        return {"status": "error", "message": emsg}

    order_id = res.get("data", {}).get("order_id") if isinstance(res, dict) and "data" in res else (res.get("norenordno") or str(res))
    return {"status": "success", "order_id": order_id}

@app.post("/api/cancel_order")
async def api_cancel_order(params: CancelOrderParams):
    order_id = params.order_id
    
    # 1. Deactivate chasing thread if this is a parent or mapped order
    if order_id.startswith("PARENT_"):
        app_state.chasing_orders[order_id] = False
    elif hasattr(app_state, 'order_mappings') and order_id in app_state.order_mappings:
        p_id = app_state.order_mappings[order_id].get("parent_order_id")
        if p_id:
            app_state.chasing_orders[p_id] = False
            
    # 2. If parent order, find and cancel any active child orders on broker or paper
    if order_id.startswith("PARENT_") and hasattr(app_state, 'order_mappings'):
        for child_id, mapping in list(app_state.order_mappings.items()):
            if mapping.get("parent_order_id") == order_id:
                if mapping.get("is_paper"):
                    if hasattr(app_state, 'paper_orders') and child_id in app_state.paper_orders:
                        app_state.paper_orders[child_id]["status"] = "CANCELED"
                else:
                    active_broker = broker_manager.get_active_broker()
                    if active_broker and active_broker.is_logged_in():
                        try:
                            active_broker.cancel_order(order_id=child_id)
                        except Exception as e:
                            logger.warning(f"Error cancelling child order {child_id}: {e}")

    # 3. Handle PAPER trade mode or Parent virtual order
    if app_state.trade_mode == "PAPER" or order_id.startswith("PARENT_"):
        if hasattr(app_state, 'paper_orders') and order_id in app_state.paper_orders:
            app_state.paper_orders[order_id]["status"] = "CANCELED"
            
        # Broadcast a mock CANCELED status update
        async def send_mock_cancel():
            await asyncio.sleep(0.1)
            mock_order = {
                "norenordno": order_id,
                "status": "CANCELED",
                "avgprc": "0",
                "tsym": params.symbol or "order",
                "rejreason": "Cancelled by User"
            }
            logger.info(f"[ORDER MGMT] Broadcasting cancel update: {mock_order}")
            await manager.broadcast("ORDER_UPDATE", mock_order)
            
        asyncio.create_task(send_mock_cancel())
        return {"status": "success", "order_id": order_id}

    active_broker = broker_manager.get_active_broker()
    if not active_broker or not active_broker.is_logged_in():
        return {"status": "error", "message": f"Broker {broker_manager._active_broker_name} is not logged in"}

    res = active_broker.cancel_order(order_id=order_id)
    if res is None or (isinstance(res, dict) and (res.get("status") == "error" or res.get("stat") == "Not_Ok")):
        emsg = res.get("message") or res.get("emsg") if isinstance(res, dict) else "Cancel failed"
        return {"status": "error", "message": emsg}

    return {"status": "success", "order_id": order_id}

# === WebSocket Route === #
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
                continue
            try:
                msg = json.loads(data)
                if msg.get("type") == "SET_FILTER":
                    filters = msg.get("filters", [])
                    manager.connection_filters[websocket] = filters
                    logger.info(f"Set filters for client {id(websocket)}: {filters}")
            except Exception as e:
                logger.error(f"Error parsing websocket message: {e}")
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# Mount Frontend
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8074))
    uvicorn.run("main:app", host="127.0.0.1", port=port, reload=True, ws_ping_interval=None, ws_ping_timeout=None)
```
\n
### File: `config/__init__.py`
```python
# config package
```
\n
### File: `config/settings.py`
```python
"""
config/settings.py
==================
Application-level configuration & environment defaults.
All tunable parameters are centralised here. Do NOT scatter magic
strings or port numbers across the codebase.
"""

import os

# ---------------------------------------------------------------------------
# Server / Network
# ---------------------------------------------------------------------------

# Port the uvicorn server listens on; override via PORT env-var at runtime.
APP_PORT: int = int(os.environ.get("PORT", 8095))

# FastAPI application display title (shown in /docs Swagger UI).
APP_TITLE: str = "FnO Stock Trading Application"

# CORS – allow all origins so the React frontend can connect from any tab.
CORS_ALLOW_ORIGINS: list = ["*"]

# ---------------------------------------------------------------------------
# Trading Mode
# ---------------------------------------------------------------------------

# Default trade mode on fresh startup.  Switch via /api/set_trade_mode.
DEFAULT_TRADE_MODE: str = "PAPER"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

# Active log file location (relative to project root at startup time).
LOG_FILE: str = "app_log.txt"

# Number of days of historical logs to maintain in FIFO order.
LOG_RETENTION_DAYS: int = 10
LOG_BACKUP_COUNT: int = 10

# Max size per log file rotation (legacy fallback).
LOG_MAX_BYTES: int = 20 * 1024 * 1024

# ---------------------------------------------------------------------------
# Static / Frontend
# ---------------------------------------------------------------------------

# Directory that holds the compiled React / JS frontend assets.
STATIC_DIR: str = "static"
```
\n
### File: `config/constants.py`
```python
"""
config/constants.py
===================
Market-level constants: NSE index tokens, exchange names, tick sizes,
instrument-file mapping, and OI lot-size thresholds.

All values are preserved exactly from the original main.py inline dicts.
"""

# ---------------------------------------------------------------------------
# NSE / BSE Broad-Market Index Token Map
# Used to skip non-F&O scrips when building master data & symbol maps.
# Keys are canonical symbol names; values are Flattrade/Shoonya tokens.
# ---------------------------------------------------------------------------
INDEX_TOKEN_MAP: dict = {
    'NIFTY':       "26000",
    'MIDCPNIFTY':  "26074",
    'BANKNIFTY':   "26009",
    'FINNIFTY':    "26037",
    'INDIAVIX':    "26017",
    'SENSEX':      "1",
    'SENSEX50':    "47",
    'BANKEX':      "12",
}

# ---------------------------------------------------------------------------
# Instrument CSV Files
# Maps exchange name → CSV filename inside the Instrument/ directory.
# ---------------------------------------------------------------------------
EXCHANGE_FILES_CONFIG: dict = {
    'NSE': 'NSE_symbols.csv',
    'NFO': 'NFO_symbols.csv',
    'MCX': 'MCX_symbols.csv',
    'CDS': 'CDS_symbols.csv',
    'BSE': 'BSE_symbols.csv',
}

# ---------------------------------------------------------------------------
# Tick Sizes
# NSE default option/futures tick: 0.05
# CDS (Currency Derivatives) tick:  0.0025
# ---------------------------------------------------------------------------
TICK_SIZE_DEFAULT: float = 0.05
TICK_SIZE_CDS:     float = 0.0025

# Decimal precision for price rounding per market segment.
PRICE_DECIMALS_DEFAULT: int = 2
PRICE_DECIMALS_CDS:     int = 4

# ---------------------------------------------------------------------------
# OI Lot-Size Conversion Threshold
# NSE OI data from the official API is sometimes reported in lots, not shares.
# When raw OI < 500 000 we multiply by lot-size to convert to shares.
# ---------------------------------------------------------------------------
OI_LOT_CONVERSION_THRESHOLD: int = 500_000

# ---------------------------------------------------------------------------
# Historical Metrics
# Number of calendar days to look back for daily candle data.
# ---------------------------------------------------------------------------
HISTORICAL_LOOKBACK_DAYS: int = 35
HISTORICAL_WINDOW_DAYS:   int = 14  # Rolling window for ATR & AvgVol
```
\n
### File: `config/logging_config.py`
```python
"""
config/logging_config.py
========================
Centralised logging setup for the WebTrader application.
Implements 10-day FIFO log retention using TimedRotatingFileHandler
and automatic startup/daily retention sweeping.
"""

import os
import re
import sys
import glob
import logging
import warnings
import datetime
from logging.handlers import TimedRotatingFileHandler

from config.settings import LOG_FILE, LOG_RETENTION_DAYS, LOG_BACKUP_COUNT


def enforce_log_retention(log_file: str = LOG_FILE, retention_days: int = LOG_RETENTION_DAYS) -> None:
    """
    Enforces a strict 10-day FIFO retention window.
    - Removes legacy size-rotated logs (e.g., app_log.txt.1, app_log.txt.2, etc.).
    - Scans for date-stamped rotated logs (e.g., app_log.txt.YYYY-MM-DD), sorts them
      chronologically (oldest first), and deletes any files older than retention_days (FIFO).
    """
    logger = logging.getLogger("WebTraderApi")
    base_dir = os.path.dirname(os.path.abspath(log_file)) or os.getcwd()
    base_name = os.path.basename(log_file)

    # 1. Clean up legacy size-rotated files (.1, .2, etc.)
    for legacy_file in glob.glob(os.path.join(base_dir, f"{base_name}.[0-9]*")):
        suffix = legacy_file.split('.')[-1]
        if suffix.isdigit():
            try:
                os.remove(legacy_file)
                logger.info(f"[LOG RETENTION] Purged legacy size-based log: {os.path.basename(legacy_file)}")
            except Exception as e:
                logger.warning(f"[LOG RETENTION] Could not delete {legacy_file}: {e}")

    # 2. Find date-stamped rotated files
    date_regex = re.compile(r'(\d{4}-\d{2}-\d{2})')
    pattern = os.path.join(base_dir, f"{base_name}.*")
    matching_files = []

    for fpath in glob.glob(pattern):
        fname = os.path.basename(fpath)
        match = date_regex.search(fname)
        if match:
            try:
                file_date = datetime.datetime.strptime(match.group(1), "%Y-%m-%d").date()
                matching_files.append((file_date, fpath))
            except ValueError:
                continue

    # Sort files chronologically: oldest first (FIFO order)
    matching_files.sort(key=lambda x: x[0])

    today = datetime.date.today()
    cutoff_date = today - datetime.timedelta(days=retention_days)

    to_delete = set()
    for file_date, fpath in matching_files:
        if file_date < cutoff_date:
            to_delete.add(fpath)

    # If there are more than retention_days files regardless of calendar gaps, drop oldest
    remaining = [f for f in matching_files if f[1] not in to_delete]
    if len(remaining) > retention_days:
        excess_count = len(remaining) - retention_days
        for i in range(excess_count):
            to_delete.add(remaining[i][1])

    for fpath in to_delete:
        try:
            os.remove(fpath)
            logger.info(f"[LOG RETENTION] FIFO pruned log file (> {retention_days} days): {os.path.basename(fpath)}")
        except Exception as e:
            logger.warning(f"[LOG RETENTION] Failed to remove {fpath}: {e}")


def setup_logging() -> logging.Logger:
    """
    Configures the root logging system with a TimedRotatingFileHandler (midnight rollover,
    10-day FIFO retention) and a stdout stream handler.
    """
    handler = TimedRotatingFileHandler(
        LOG_FILE,
        when="midnight",
        interval=1,
        backupCount=LOG_BACKUP_COUNT,
        encoding='utf-8'
    )
    handler.suffix = "%Y-%m-%d"
    handler.extMatch = re.compile(r"^\d{4}-\d{2}-\d{2}$")

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            handler,
            logging.StreamHandler(sys.stdout)
        ],
        force=True
    )

    # Suppress verbose third-party loggers
    logging.getLogger("urllib3").setLevel(logging.ERROR)
    logging.getLogger("urllib3.connectionpool").setLevel(logging.ERROR)
    logging.getLogger("websocket").setLevel(logging.WARNING)
    logging.getLogger("requests").setLevel(logging.ERROR)
    warnings.filterwarnings("ignore", message="Connection pool is full")

    logger = logging.getLogger("WebTraderApi")

    # Run initial startup retention enforcement
    try:
        enforce_log_retention(LOG_FILE, LOG_RETENTION_DAYS)
    except Exception as e:
        logger.warning(f"[LOG RETENTION] Startup retention check warning: {e}")

    return logger
```
\n
### File: `data/__init__.py`
```python
# data package
```
\n
### File: `data/download_instruments.py`
```python
import os
import requests
import zipfile
import io
import pandas as pd

exchanges = ['NSE', 'NFO', 'CDS', 'MCX']
subdir = "Instrument"


def main():
    if not os.path.exists(subdir):
        os.makedirs(subdir)

    for exchange in exchanges:
        zip_name = f"{exchange}_symbols.txt.zip"
        url = f"https://api.shoonya.com/{zip_name}"
        print(f"Downloading {exchange} instrument data from {url}...")
        try:
            response = requests.get(url, timeout=60)
            response.raise_for_status()

            # Unzip in memory
            with zipfile.ZipFile(io.BytesIO(response.content)) as z:
                file_names = z.namelist()
                if not file_names:
                    print(f"Empty zip for {exchange}")
                    continue

                txt_filename = file_names[0]
                print(f"Extracting {txt_filename}...")
                txt_content = z.read(txt_filename)

                # Save as CSV in the Instrument folder
                csv_path = os.path.join(subdir, f"{exchange}_symbols.csv")

                # Read txt as CSV (it is comma separated)
                df = pd.read_csv(io.BytesIO(txt_content), low_memory=False)

                # Standardize column headers and format Expiry date to YYYY-MM-DD
                if 'Expiry' in df.columns:
                    df['Expiry'] = pd.to_datetime(df['Expiry'], errors='coerce').dt.strftime('%Y-%m-%d')

                df.to_csv(csv_path, index=False)
                print(f"Saved {len(df)} records to {csv_path}")

        except Exception as e:
            print(f"Failed to download {exchange}: {e}")

    # Download official NSE F&O Bhavcopy for baseline POI
    try:
        download_nse_fo_bhavcopy()
    except Exception as ex_bhav:
        print(f"Bhavcopy step note: {ex_bhav}")

    print("Download complete!")

def download_nse_fo_bhavcopy():
    import datetime
    today = datetime.date.today()
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
    for d_offset in range(1, 6):
        target_date = today - datetime.timedelta(days=d_offset)
        if target_date.weekday() >= 5: continue
        
        dd = target_date.strftime("%d")
        mmm = target_date.strftime("%b").upper()
        yyyy = target_date.strftime("%Y")
        
        url = f"https://archives.nseindia.com/content/historical/DERIVATIVES/{yyyy}/{mmm}/fo{dd}{mmm}{yyyy}bhav.csv.zip"
        try:
            r = requests.get(url, headers=headers, timeout=10)
            if r.status_code == 200:
                with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                    file_names = z.namelist()
                    if file_names:
                        bhav_content = z.read(file_names[0])
                        df_bhav = pd.read_csv(io.BytesIO(bhav_content))
                        bhav_path = os.path.join(subdir, "nse_fo_bhavcopy.csv")
                        df_bhav.to_csv(bhav_path, index=False)
                        print(f"Successfully downloaded official NSE F&O Bhavcopy for {target_date} ({len(df_bhav)} rows)")
                        return True
        except Exception:
            pass
    return False


if __name__ == "__main__":
    main()
```
\n
### File: `data/fno_strike_calculator.py`
```python
import os
import pandas as pd
import numpy as np
import logging

logger = logging.getLogger("StrikeDiff")
logger.setLevel(logging.INFO)

def get_strike_difference_all(df, exch_name):
    """Calculate strike difference & lot size for each symbol+expiry in a given exchange"""
    results = []

    if "Expiry" not in df.columns or "StrikePrice" not in df.columns:
        return pd.DataFrame()  # Skip non-derivative files (like NSE/BSE cash)

    # Convert datatypes
    df['Expiry'] = pd.to_datetime(df['Expiry'], errors='coerce').dt.date
    df['StrikePrice'] = pd.to_numeric(df['StrikePrice'], errors='coerce')

    # Group by symbol & expiry
    for (sym, expiry), grp in df.groupby(["Symbol", "Expiry"]):
        strikes = sorted(grp["StrikePrice"].dropna().unique())
        lot_size = grp["LotSize"].iloc[0] if "LotSize" in grp.columns else None

        strike_diff = min(np.diff(strikes)) if len(strikes) > 1 else None

        results.append({
            "Symbol": sym,
            "Expiry": expiry,
            "LotSize": lot_size,
            "StrikeDifference": strike_diff,
            "Exchange": exch_name
        })

    return pd.DataFrame(results)

def load_and_calculate_fno_data(instrument_dir):
    """
    Reads all derivative instrument files in memory, calculates strike
    differences and lot sizes, and returns a Pandas DataFrame and a dictionary of the results.
    """
    all_results = []

    if not os.path.exists(instrument_dir):
        logger.warning(f"⚠️ Instrument folder not found at {instrument_dir}")
        return pd.DataFrame(), {}

    for file in os.listdir(instrument_dir):
        if file.endswith(".csv") or file.endswith(".txt"):
            exch = file.split("_")[0].upper()  # e.g., NFO_symbols.csv → NFO
            if exch != 'NFO':
                continue
            try:
                df = pd.read_csv(os.path.join(instrument_dir, file), low_memory=False)
                if 'Instrument' in df.columns:
                    df = df[df['Instrument'].isin(['OPTSTK', 'FUTSTK'])]
                res = get_strike_difference_all(df, exch)
                if not res.empty:
                    all_results.append(res)
                    logger.info(f"Calculated strike metrics from {file} ({len(res)} entries)")
            except Exception as e:
                logger.error(f"Could not process {file}: {e}")

    if all_results:
        final_df = pd.concat(all_results, ignore_index=True)
        # Reorder & sort
        final_df = final_df[["Symbol", "Expiry", "LotSize", "StrikeDifference", "Exchange"]]
        final_df = final_df.sort_values(by=["Symbol", "Expiry"]).reset_index(drop=True)

        # Build dictionary for O(1) fast lookups by (Symbol, Expiry) in API limits
        strike_diff_dict = {}
        for _, row in final_df.iterrows():
            key = (row['Symbol'], str(row['Expiry']))
            strike_diff_dict[key] = {
                'lotsize': int(row['LotSize']) if pd.notna(row['LotSize']) else 0,
                'strike_difference': float(row['StrikeDifference']) if pd.notna(row['StrikeDifference']) else None,
                'exchange': row['Exchange']
            }

        logger.info(f"Cached {len(strike_diff_dict)} strike difference records into memory")
        return final_df, strike_diff_dict
    else:
        logger.warning("No derivative instrument records calculated.")
        return pd.DataFrame(), {}

if __name__ == "__main__":
    # Test block
    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_path = os.path.join(script_dir, "..", "Instrument")
    print("Testing load_and_calculate_fno_data...")
    df, strike_dict = load_and_calculate_fno_data(base_path)
    print(f"Total calculated: {len(df)}")
    print(df.head())
```
\n
### File: `brokers/__init__.py`
```python
﻿# brokers package
```
\n
### File: `brokers/base_broker.py`
```python
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional

class BaseBroker(ABC):
    """
    Universal Base Broker Interface for WebTrader.
    Any broker integration (Flattrade, Upstox, Zerodha, Dhan, etc.) must implement this interface.
    """
    
    @abstractmethod
    def get_name(self) -> str:
        """Returns the uppercase string name of the broker (e.g. 'FLATTRADE', 'UPSTOX')"""
        pass

    @abstractmethod
    async def login(self, creds: Dict[str, str]) -> tuple[bool, str]:
        """Performs authentication and initializes WebSocket feeds."""
        pass

    @abstractmethod
    def is_logged_in(self) -> bool:
        """Returns True if the broker session is active and authorized."""
        pass

    @abstractmethod
    def logout(self):
        """Logs out from broker session and deactivates background tasks."""
        pass

    @abstractmethod
    def subscribe_symbols(self, symbols: List[str]):
        """Subscribes to live market data feed for a list of symbols/tokens."""
        pass

    @abstractmethod
    def fetch_historical_metrics(self, symbol_token_map: Dict[str, Dict[str, str]], force_refresh: bool = False) -> Dict[str, Dict[str, str]]:
        """
        Fetches 14-day historical Avg Volume & ATR for a set of symbols.
        Returns dict: {symbol: {"ATR": str, "AvgVol": str, "YestVol": str}}
        """
        pass

    @abstractmethod
    def place_order(
        self, 
        buy_or_sell: str, 
        exchange: str, 
        tradingsymbol: str, 
        quantity: int, 
        price_type: str, 
        price: float, 
        trigger_price: Optional[float] = None, 
        product_type: Optional[str] = None
    ) -> Any:
        """Places a buy/sell order via broker API."""
        pass

    @abstractmethod
    def cancel_order(self, order_id: str) -> Any:
        """Cancels an active order by order ID."""
        pass

    def modify_order(self, order_id: str, exchange: str, tradingsymbol: str, new_quantity: int, new_price_type: str, new_price: float, trigger_price: Optional[float] = None) -> Any:
        """Modifies price/quantity of an existing open order if supported by the broker."""
        return {"status": "error", "message": "modify_order not implemented"}
```
\n
### File: `brokers/broker_manager.py`
```python
﻿import logging
from typing import Dict, Optional
from brokers.base_broker import BaseBroker

logger = logging.getLogger("WebTraderApi.BrokerManager")

class BrokerManager:
    """
    Universal Registry & Switcher for all WebTrader Brokers.
    Manages active broker instance (FLATTRADE, UPSTOX, etc.) dynamically.
    """
    def __init__(self):
        self._brokers: Dict[str, BaseBroker] = {}
        self._active_broker_name: str = "FLATTRADE"

    def register_broker(self, broker: BaseBroker):
        name = broker.get_name().upper()
        self._brokers[name] = broker
        logger.info(f"[BROKER MANAGER] Registered broker plugin: {name}")

    def get_active_broker(self) -> Optional[BaseBroker]:
        return self._brokers.get(self._active_broker_name)

    def set_active_broker(self, name: str) -> bool:
        name_upper = name.upper()
        if name_upper in self._brokers:
            self._active_broker_name = name_upper
            logger.info(f"[BROKER MANAGER] Switched active broker to: {name_upper}")
            return True
        logger.warning(f"[BROKER MANAGER] Broker '{name_upper}' is not registered!")
        return False

    def logout_active_broker(self) -> Optional[str]:
        current_broker = self.get_active_broker()
        current_name = self._active_broker_name
        if current_broker:
            try:
                current_broker.logout()
                logger.info(f"[BROKER MANAGER] Logged out active broker: {current_name}")
            except Exception as e:
                logger.error(f"[BROKER MANAGER] Error logging out broker {current_name}: {e}")
            return current_name
        return None

    def list_brokers(self) -> list[str]:
        return list(self._brokers.keys())

# Global singleton manager
broker_manager = BrokerManager()
```
\n
### File: `brokers/canonical_symbol_mapper.py`
```python
﻿"""
brokers/canonical_symbol_mapper.py
===================================
Canonical Symbol Mapper Module (WebTrader Multi-Broker)
Provides O(1) bi-directional symbol translation between internal canonical IDs
and broker-specific tokens / trading symbols.
"""
import os
import json
import logging
from typing import Dict, Any, Optional, Tuple

logger = logging.getLogger("CanonicalMapper")

class CanonicalSymbolMapper:
    def __init__(self):
        # Maps canonical_id -> broker_name -> broker_spec dict
        self._canonical_to_broker: Dict[str, Dict[str, Dict[str, Any]]] = {}
        
        # Maps (broker_name, token_or_tsym) -> canonical_id
        self._broker_to_canonical: Dict[Tuple[str, str], str] = {}

    @staticmethod
    def build_canonical_id(inst_type: str, symbol: str, expiry: Optional[str] = None, strike: Optional[float] = None, option_type: Optional[str] = None) -> str:
        """
        Builds unified canonical key.
        Examples:
          build_canonical_id("EQ", "RELIANCE") -> "EQ|RELIANCE"
          build_canonical_id("FUT", "RELIANCE", expiry="2026-08-28") -> "FUT|RELIANCE|2026-08-28"
          build_canonical_id("OPT", "RELIANCE", expiry="2026-08-28", strike=2900, option_type="CE") -> "OPT|RELIANCE|2026-08-28|2900|CE"
        """
        inst = inst_type.upper().strip()
        sym = symbol.upper().strip()
        
        if inst in ("EQ", "EQUITY", "SPOT"):
            return f"EQ|{sym}"
        elif inst in ("INDEX", "IDX"):
            return f"INDEX|{sym}"
        elif inst in ("FUT", "FUTSTK", "FUTIDX"):
            exp_str = str(expiry).split(" ")[0] if expiry else "NEAR"
            return f"FUT|{sym}|{exp_str}"
        elif inst in ("OPT", "OPTSTK", "OPTIDX"):
            exp_str = str(expiry).split(" ")[0] if expiry else "NEAR"
            stk_str = f"{float(strike):.2f}".rstrip('0').rstrip('.') if strike is not None else "0"
            opt_str = option_type.upper().strip() if option_type else "CE"
            return f"OPT|{sym}|{exp_str}|{stk_str}|{opt_str}"
        
        return f"{inst}|{sym}"

    def register_mapping(self, canonical_id: str, broker_name: str, broker_token: str, broker_symbol: str, exchange: str, lot_size: int = 1, extra_info: Optional[Dict[str, Any]] = None):
        """Registers bi-directional mapping between canonical_id and broker-specific details."""
        b_name = broker_name.upper().strip()
        token_str = str(broker_token).strip()
        symbol_str = str(broker_symbol).strip()
        
        spec = {
            "canonical_id": canonical_id,
            "broker_name": b_name,
            "broker_token": token_str,
            "broker_symbol": symbol_str,
            "exchange": exchange.upper().strip(),
            "lot_size": lot_size
        }
        if extra_info:
            spec.update(extra_info)

        # 1. Store Canonical -> Broker Spec
        if canonical_id not in self._canonical_to_broker:
            self._canonical_to_broker[canonical_id] = {}
        self._canonical_to_broker[canonical_id][b_name] = spec

        # 2. Store Broker (Name, Token) -> Canonical ID
        if token_str and token_str != "-":
            self._broker_to_canonical[(b_name, token_str)] = canonical_id
            
        # 3. Store Broker (Name, Symbol) -> Canonical ID
        if symbol_str:
            self._broker_to_canonical[(b_name, symbol_str)] = canonical_id
            self._broker_to_canonical[(b_name, f"{spec['exchange']}|{symbol_str}")] = canonical_id

    def get_broker_spec(self, canonical_id: str, broker_name: str) -> Optional[Dict[str, Any]]:
        """Returns broker-specific order payload fields for a canonical_id."""
        return self._canonical_to_broker.get(canonical_id, {}).get(broker_name.upper().strip())

    def get_canonical_id(self, broker_name: str, token_or_symbol: str) -> Optional[str]:
        """Resolves broker token or trading symbol back to canonical_id."""
        b_name = broker_name.upper().strip()
        key = (b_name, str(token_or_symbol).strip())
        return self._broker_to_canonical.get(key)

# Global Singleton Instance
canonical_mapper = CanonicalSymbolMapper()
```
\n
### File: `brokers/execution_engine.py`
```python
import time
import math
import logging
import asyncio
import threading
from typing import Optional

# Global variables to be injected from main.py
app_state = None
manager = None

logger = logging.getLogger("uvicorn.error")

def get_tick_size(exchange: str, symbol: str) -> float:
    """Resolve tick size dynamically from token_to_info or fall back to defaults.
    Enforces exchange rules: CDS is 0.0025, and Indian equity derivatives/cash (NFO, NSE, BSE)
    strictly trade in multiples of 0.05 (5 paise). Never allow CSV errors (like 0.01) to violate this."""
    exch = exchange.upper()
    sym = symbol.upper()
    
    if exch == "CDS":
        return 0.0025

    if app_state and hasattr(app_state, 'symbol_to_token'):
        token = app_state.symbol_to_token.get((exch, sym))
        if token and hasattr(app_state, 'token_to_info'):
            info = app_state.token_to_info.get((exch, token))
            if info:
                try:
                    ts = float(info.get('TickSize', 0.05))
                    # NSE F&O & Equity rules: tick size is minimum 0.05 paise
                    if ts >= 0.05:
                        return ts
                except:
                    pass
    
    # Defaults: Currency derivatives (CDS) is 0.0025, all others (NFO, NSE, BSE, MCX) minimum 0.05
    return 0.05

def round_to_tick(price: float, tick: float, round_up: bool = False, round_down: bool = False) -> float:
    """Round price dynamically to nearest tick size."""
    if tick <= 0:
        tick = 0.05
    ticks = price / tick
    if round_up:
        rounded_ticks = math.ceil(ticks - 1e-9)
    elif round_down:
        rounded_ticks = math.floor(ticks + 1e-9)
    else:
        rounded_ticks = round(ticks)
    return round(rounded_ticks * tick, 4 if tick < 0.01 else 2)

def get_live_data(exchange: str, symbol: str) -> dict:
    """Resolve live ticker quote from app_state.live_data using various key formats."""
    if not app_state or not hasattr(app_state, 'live_data'):
        return {}
    exch = exchange.upper()
    sym = symbol.upper()
    
    # 1. Try Direct exchange|symbol
    key = f"{exch}|{sym}"
    live = app_state.live_data.get(key)
    if live and ("lp" in live or "bp1" in live or "sp1" in live):
        return live
        
    # 2. Try raw symbol
    live = app_state.live_data.get(sym)
    if live and ("lp" in live or "bp1" in live or "sp1" in live):
        return live
        
    # 3. Try token resolution
    if hasattr(app_state, 'symbol_to_token'):
        token = app_state.symbol_to_token.get((exch, sym))
        if token:
            live = app_state.live_data.get(f"{exch}|{token}") or app_state.live_data.get(str(token))
            if live and ("lp" in live or "bp1" in live or "sp1" in live):
                return live
                
    return app_state.live_data.get(key) or {}

def get_order_status(order_id: str, is_paper: bool, params) -> Optional[dict]:
    """Retrieve details for a specific order (PAPER or REAL)."""
    if is_paper:
        if not hasattr(app_state, 'paper_orders'):
            app_state.paper_orders = {}
        order = app_state.paper_orders.get(order_id)
        if not order:
            return None
        
        # Simulate fill for paper order if PENDING
        if order.get("status") == "PENDING":
            live_data = get_live_data(order.get('exchange', params.exchange), order.get('symbol', params.symbol))
            ltp = float(live_data.get('lp', 0.0))
            
            side = order.get("side", "BUY").upper()
            price = order.get("price", 0.0)
            
            should_fill = False
            if ltp <= 0:
                should_fill = True  # If no stream, fill immediately at order price
            elif side.startswith("B"):  # BUY
                if ltp <= price:
                    should_fill = True
            else:  # SELL
                if ltp >= price:
                    should_fill = True
            
            if should_fill:
                order["status"] = "COMPLETE"
                order["filled_qty"] = order["qty"]
                order["remaining_qty"] = 0
                
                # Determine realistic fill price by crossing the spread / LTP (capped/floored by limit price)
                fill_price = price
                if side.startswith("B"):
                    sp1 = float(live_data.get('sp1', 0.0))
                    ref_price = sp1 if sp1 > 0 else (ltp if ltp > 0 else price)
                    if ref_price > 0:
                        fill_price = min(price, ref_price)
                else:
                    bp1 = float(live_data.get('bp1', 0.0))
                    ref_price = bp1 if bp1 > 0 else (ltp if ltp > 0 else price)
                    if ref_price > 0:
                        fill_price = max(price, ref_price)
                        
                if price > 0.5 and fill_price < (price * 0.5):
                    fill_price = price
                elif fill_price <= 0.05 and price > 0.05:
                    fill_price = price

                order_exch = order.get('exchange', params.exchange)
                order_sym = order.get('symbol', params.symbol)
                fill_tick = get_tick_size(order_exch, order_sym)
                fill_price = round_to_tick(fill_price, fill_tick, round_up=side.startswith("B"), round_down=not side.startswith("B"))
                order["avg_price"] = fill_price
        
        return {
            "status": order.get("status"),
            "filled_qty": order.get("filled_qty", 0),
            "remaining_qty": order.get("remaining_qty", order.get("qty")),
            "avg_price": order.get("avg_price", 0.0),
            "rejreason": order.get("rejreason", "")
        }
    
    if not app_state or not app_state.api:
        return None
    
    try:
        res = app_state.api.single_order_history(orderno=order_id)
        if isinstance(res, list) and len(res) > 0:
            latest = res[0]
            status = latest.get("status", "").upper()
            filled_qty = int(latest.get("fillshares", 0))
            qty = int(latest.get("qty", 0))
            avg_price = float(latest.get("avgprc", 0.0))
            remaining_qty = qty - filled_qty
            
            return {
                "status": status,
                "filled_qty": filled_qty,
                "remaining_qty": remaining_qty,
                "avg_price": avg_price,
                "rejreason": latest.get("rejreason", "")
            }
        elif isinstance(res, dict):
            if res.get("stat") == "Not_Ok":
                return {
                    "status": "REJECTED",
                    "filled_qty": 0,
                    "remaining_qty": 0,
                    "avg_price": 0.0,
                    "rejreason": res.get("emsg", "")
                }
            status = res.get("status", "").upper()
            filled_qty = int(res.get("fillshares", 0))
            qty = int(res.get("qty", 0))
            avg_price = float(res.get("avgprc", 0.0))
            remaining_qty = qty - filled_qty
            return {
                "status": status,
                "filled_qty": filled_qty,
                "remaining_qty": remaining_qty,
                "avg_price": avg_price,
                "rejreason": res.get("rejreason", "")
            }
    except Exception as e:
        logger.error(f"[EXEC ENGINE] Error fetching broker order status for {order_id}: {e}")
    return None

def cancel_order(order_id: str, is_paper: bool) -> dict:
    """Request order cancellation (PAPER or REAL)."""
    if is_paper:
        if hasattr(app_state, 'paper_orders') and order_id in app_state.paper_orders:
            app_state.paper_orders[order_id]["status"] = "CANCELED"
            return {"status": "success"}
        return {"status": "error", "message": "Order not found"}
        
    from brokers.broker_manager import broker_manager
    active_broker = broker_manager.get_active_broker()
    if active_broker:
        res = active_broker.cancel_order(order_id=order_id)
        if isinstance(res, dict) and res.get("status") == "error":
            return {"status": "error", "message": res.get("message", "Cancel failed")}
        return {"status": "success"}
    return {"status": "error", "message": "No active broker connected"}

def modify_open_order(order_id: str, params, new_qty: int, new_price: float, is_paper: bool) -> dict:
    """Attempt fast atomic price modification on broker before resorting to cancel-and-replace."""
    tick_sz = get_tick_size(params.exchange, params.symbol)
    side = params.buy_or_sell.upper()
    new_price = round_to_tick(new_price, tick_sz, round_up=side.startswith("B"), round_down=not side.startswith("B"))
    
    if is_paper:
        if hasattr(app_state, 'paper_orders') and order_id in app_state.paper_orders:
            app_state.paper_orders[order_id]["price"] = new_price
            app_state.paper_orders[order_id]["remaining_qty"] = new_qty
            return {"status": "success"}
        return {"status": "error", "message": "Paper order not found"}

    from brokers.broker_manager import broker_manager
    active_broker = broker_manager.get_active_broker()
    if not active_broker:
        return {"status": "error", "message": "No active broker connected"}

    try:
        res = active_broker.modify_order(
            order_id=order_id,
            exchange=params.exchange,
            tradingsymbol=params.symbol,
            new_quantity=new_qty,
            new_price_type="LMT",
            new_price=new_price,
            trigger_price=None
        )
        if res is None or (isinstance(res, dict) and (res.get("status") == "error" or res.get("stat") == "Not_Ok")):
            emsg = res.get("message") or res.get("emsg") if isinstance(res, dict) else "Modify failed"
            return {"status": "error", "message": emsg}
        return {"status": "success"}
    except Exception as e:
        logger.warning(f"[EXEC ENGINE] modify_open_order exception: {e}")
        return {"status": "error", "message": str(e)}

def place_new_order(params, qty: int, price: float, is_paper: bool) -> dict:
    """Submit a new order (PAPER or REAL)."""
    tick_sz = get_tick_size(params.exchange, params.symbol)
    side = params.buy_or_sell.upper()
    price = round_to_tick(price, tick_sz, round_up=side.startswith("B"), round_down=not side.startswith("B"))

    if is_paper:
        new_order_id = f"PAPER_CHASE_{int(time.time())}_{math.floor(time.time() * 1000) % 1000}"
        if not hasattr(app_state, 'paper_orders'):
            app_state.paper_orders = {}
        app_state.paper_orders[new_order_id] = {
            "status": "PENDING",
            "qty": qty,
            "filled_qty": 0,
            "remaining_qty": qty,
            "price": price,
            "avg_price": 0.0,
            "symbol": params.symbol,
            "exchange": params.exchange,
            "side": params.buy_or_sell,
            "created_at": time.time()
        }
        return {"status": "success", "order_id": new_order_id}
        
    from brokers.broker_manager import broker_manager
    active_broker = broker_manager.get_active_broker()
    if not active_broker:
        return {"status": "error", "message": "No active broker connected"}

    product_type = "M" if params.exchange not in ["NSE", "BSE"] else "C"
    res = active_broker.place_order(
        buy_or_sell=params.buy_or_sell[0],
        exchange=params.exchange,
        tradingsymbol=params.symbol,
        quantity=qty,
        price_type="LMT",
        price=price,
        trigger_price=None,
        product_type=product_type
    )
    if res is None or (isinstance(res, dict) and (res.get("status") == "error" or res.get("stat") == "Not_Ok")):
        emsg = res.get("message") or res.get("emsg") if isinstance(res, dict) else "Broker API returned error"
        return {"status": "error", "message": emsg}
    order_id = res.get("data", {}).get("order_id") if isinstance(res, dict) and "data" in res else (res.get("norenordno") or str(res))
    return {"status": "success", "order_id": order_id}

def broadcast_order_update(parent_order_id: str, status: str, avgprc: float, filledqty: int, symbol: str, remarks: str):
    """Broadcast virtualized parent order state to frontend clients."""
    if app_state and hasattr(app_state, 'paper_orders') and parent_order_id in app_state.paper_orders:
        app_state.paper_orders[parent_order_id].update({
            "status": status,
            "filled_qty": filledqty,
            "remaining_qty": app_state.paper_orders[parent_order_id]["qty"] - filledqty,
            "avg_price": avgprc,
            "rejreason": remarks
        })

    if not app_state or not app_state.main_loop or not manager:
        return
    data = {
        "norenordno": parent_order_id,
        "status": status,
        "avgprc": str(avgprc),
        "filledqty": str(filledqty),
        "tsym": symbol,
        "rejreason": remarks
    }
    logger.info(f"[EXEC ENGINE] Broadcasting virtual update: {data}")
    asyncio.run_coroutine_threadsafe(
        manager.broadcast("ORDER_UPDATE", data),
        app_state.main_loop
    )

def execution_thread_worker(
    params,
    parent_order_id: str,
    initial_price: float,
    tick_size: float,
    is_paper: bool
):
    """Background thread running the trigger detection, chasing loop, and sweep safeguard."""
    # Ensure symbol subscription is live
    sub_key = f"{params.exchange}|{params.symbol}"
    from brokers.broker_manager import broker_manager
    active_broker = broker_manager.get_active_broker()
    if active_broker:
        active_broker.subscribe_symbols([sub_key])
    
    execution_mode = params.execution_mode
    total_qty = params.quantity
    
    # 1. Trigger phase for Limit_Below / Limit_Above modes
    if execution_mode in ["Limit_Below", "Limit_Above"]:
        trigger_price = params.limit_price_trigger if params.limit_price_trigger and params.limit_price_trigger > 0 else params.price
        logger.info(f"[EXEC ENGINE] Order {parent_order_id} enters trigger phase: {execution_mode} at {trigger_price}")
        
        triggered = False
        start_wait = time.time()
        while time.time() - start_wait < 3600:  # 1 hour safety cutoff
            live_data = app_state.live_data.get(sub_key, {})
            ltp = float(live_data.get('lp', 0.0))
            if ltp > 0:
                if execution_mode == "Limit_Below" and ltp <= trigger_price:
                    triggered = True
                    break
                elif execution_mode == "Limit_Above" and ltp >= trigger_price:
                    triggered = True
                    break
            time.sleep(0.5)
            
        if not triggered:
            logger.warning(f"[EXEC ENGINE] Trigger timeout (1 hour elapsed) for order {parent_order_id}")
            broadcast_order_update(parent_order_id, "REJECTED", 0.0, 0, params.symbol, "Trigger Timeout")
            return
            
        logger.info(f"[EXEC ENGINE] Order {parent_order_id} triggered! LTP: {ltp}")
        initial_price = trigger_price

    # 2. Placement and Chasing loop
    fills = []  # List of tuples: (filled_qty, avg_price)
    
    # Submit first broker order
    first_res = place_new_order(params, total_qty, initial_price, is_paper)
    if first_res.get("status") != "success":
        logger.error(f"[EXEC ENGINE] Initial order placement failed: {first_res.get('message')}")
        broadcast_order_update(parent_order_id, "REJECTED", 0.0, 0, params.symbol, first_res.get("message", "Order Failed"))
        return
        
    current_order_id = first_res.get("order_id")
    
    # Map current order to parent
    app_state.order_mappings[current_order_id] = {
        "parent_order_id": parent_order_id,
        "total_qty": total_qty,
        "is_paper": is_paper,
        "symbol": params.symbol,
        "exchange": params.exchange,
        "side": params.buy_or_sell
    }
    
    # Mark chasing active
    app_state.chasing_orders[parent_order_id] = True
    
    start_time = time.time()
    retries = 0
    max_retries = params.max_retries if params.max_retries is not None else 5
    timeout = params.timeout if params.timeout is not None else 10.0
    slippage_tolerance = params.slippage_tolerance if params.slippage_tolerance is not None else 0.03
    
    current_order_price = initial_price
    is_exit_mode = (execution_mode == "Aggressive_Exit")
    
    logger.info(f"[EXEC ENGINE] Active order: {parent_order_id} -> {current_order_id} @ {current_order_price} (Mode: {execution_mode}, is_exit: {is_exit_mode})")
    
    last_status = "OPEN"
    
    while True:
        time.sleep(0.5)
        
        # User manual cancellation check
        if not app_state.chasing_orders.get(parent_order_id, False):
            logger.info(f"[EXEC ENGINE] Order {parent_order_id} stopped by user cancellation.")
            break
            
        # For exits only: enforce timeout and retry safeguards so intraday positions are never trapped
        if is_exit_mode:
            elapsed = time.time() - start_time
            if elapsed >= timeout or retries >= max_retries:
                logger.info(f"[EXEC ENGINE] Exit timeout reached ({elapsed:.1f}s / retries {retries}) for {parent_order_id}.")
                break
        
        status_info = get_order_status(current_order_id, is_paper, params)
        if not status_info:
            continue
            
        last_status = status_info.get("status", "").upper()
        filled_qty = int(status_info.get("filled_qty", 0))
        avg_price = float(status_info.get("avg_price", 0.0))
        
        sum_prev_fills = sum(q for q, _ in fills)
        unfilled_parent_qty = total_qty - sum_prev_fills
        
        if last_status == "COMPLETE":
            # The remaining quantity of the parent order was completely filled
            fill_qty = (filled_qty - sum_prev_fills) if (filled_qty > sum_prev_fills) else unfilled_parent_qty
            fills.append((fill_qty, avg_price if avg_price > 0 else current_order_price))
            logger.info(f"[EXEC ENGINE] Child order {current_order_id} filled {fill_qty} @ {avg_price or current_order_price} (Total: {sum_prev_fills + fill_qty}/{total_qty})")
            break
        elif last_status in ["REJECTED", "REJECT"]:
            logger.warning(f"[EXEC ENGINE] Child order {current_order_id} rejected: {status_info.get('rejreason')}")
            break
        elif last_status in ["CANCELED", "CANCELLED"]:
            if filled_qty > sum_prev_fills:
                fills.append((filled_qty - sum_prev_fills, avg_price if avg_price > 0 else current_order_price))
            break
        else:
            # Active (OPEN, PENDING, etc.)
            remaining_qty = unfilled_parent_qty
            if execution_mode not in ["Aggressive_Entry", "Aggressive_Exit"]:
                # True_Limit_LTP rests in the order book without chasing
                continue
                
            live_data = get_live_data(params.exchange, params.symbol)
            ltp = float(live_data.get('lp', 0.0))
            bp1 = float(live_data.get('bp1', 0.0))
            sp1 = float(live_data.get('sp1', 0.0))
            
            side = params.buy_or_sell.upper()
            elapsed = time.time() - start_time
            
            # Collar boundary definitions
            # For Exits past 4s, adaptively widen collar floor/ceiling so an exit position is never trapped
            effective_collar = slippage_tolerance
            if is_exit_mode and elapsed > 4.0:
                effective_collar = min(0.08, slippage_tolerance * 1.5)  # Safe bounded widening up to 8% max
                
            if side.startswith("B"):
                ref_anchor = max(ltp, bp1) if (ltp > 0 or bp1 > 0) else initial_price
                upper_bound = round_to_tick(ref_anchor * (1.0 + effective_collar), tick_size, round_down=True)
                
                # For long exits past 4s, cross to ask (sp1) if available, otherwise bp1 + tick
                if is_exit_mode and elapsed > 4.0 and sp1 > 0:
                    target_price = sp1
                else:
                    best_buy = bp1 if bp1 > 0 else ltp
                    target_price = best_buy + tick_size
                    
                target_price = round_to_tick(target_price, tick_size, round_up=True)
                # Cap at upper collar bound (Range-Bound Protection)
                if target_price > upper_bound:
                    target_price = upper_bound
                price_moved = (target_price > current_order_price)
            else:
                ref_anchor = min(ltp, sp1) if (ltp > 0 and sp1 > 0) else (ltp if ltp > 0 else (sp1 if sp1 > 0 else initial_price))
                lower_bound = max(tick_size, round_to_tick(ref_anchor * (1.0 - effective_collar), tick_size, round_up=True))
                
                # For short exits past 4s, cross to bid (bp1) if available, otherwise sp1 - tick
                if is_exit_mode and elapsed > 4.0 and bp1 > 0:
                    target_price = bp1
                else:
                    best_sell = sp1 if sp1 > 0 else ltp
                    target_price = best_sell - tick_size
                    
                target_price = round_to_tick(target_price, tick_size, round_down=True)
                # Floor at lower collar bound (Range-Bound Protection)
                if target_price < lower_bound:
                    target_price = lower_bound
                price_moved = (target_price < current_order_price)
                
            if price_moved and target_price != current_order_price:
                # Fast path: try atomic modify_open_order first
                logger.info(f"[EXEC ENGINE] Price adjusted to {target_price} within collar. Modifying order {current_order_id}...")
                mod_res = modify_open_order(current_order_id, params, remaining_qty, target_price, is_paper)
                if mod_res.get("status") == "success":
                    current_order_price = target_price
                    logger.info(f"[EXEC ENGINE] Order {current_order_id} successfully modified to {target_price}")
                else:
                    # Slow path fallback: cancel and replace only if retries < max_retries
                    if retries < max_retries:
                        logger.info(f"[EXEC ENGINE] Modify failed ({mod_res.get('message')}). Fallback cancel-and-replace...")
                        cancel_res = cancel_order(current_order_id, is_paper)
                        cancelled_confirmed = False
                        for _ in range(10):
                            c_status = get_order_status(current_order_id, is_paper, params)
                            if c_status and c_status.get("status") in ["CANCELED", "CANCELLED", "COMPLETE"]:
                                c_filled = int(c_status.get("filled_qty", 0))
                                c_avg = float(c_status.get("avg_price", 0.0))
                                cur_sum = sum(q for q, _ in fills)
                                if c_filled > cur_sum:
                                    fills.append((c_filled - cur_sum, c_avg if c_avg > 0 else current_order_price))
                                cancelled_confirmed = True
                                break
                            time.sleep(0.1)
                            
                        total_filled = sum(q for q, _ in fills)
                        remaining_qty = total_qty - total_filled
                        if remaining_qty <= 0:
                            break
                            
                        retries += 1
                        current_order_price = target_price
                        new_res = place_new_order(params, remaining_qty, target_price, is_paper)
                        if new_res.get("status") == "success":
                            new_order_id = new_res.get("order_id")
                            logger.info(f"[EXEC ENGINE] Replaced order: {current_order_id} -> {new_order_id} @ {target_price}")
                            current_order_id = new_order_id
                            app_state.order_mappings[current_order_id] = {
                                "parent_order_id": parent_order_id,
                                "total_qty": total_qty,
                                "is_paper": is_paper,
                                "symbol": params.symbol,
                                "exchange": params.exchange,
                                "side": params.buy_or_sell
                            }
                        else:
                            logger.error(f"[EXEC ENGINE] Replacement order failed: {new_res.get('message')}")
                            time.sleep(0.5)

    # 3. Safeguard & Cleanup
    total_filled = sum(q for q, _ in fills)
    remaining_qty = total_qty - total_filled
    user_cancelled = not app_state.chasing_orders.get(parent_order_id, False)
    
    if remaining_qty > 0:
        if is_exit_mode and not user_cancelled:
            # Intraday Exit Safeguard: Escalating to best resting quote
            live_data = get_live_data(params.exchange, params.symbol)
            bp1 = float(live_data.get('bp1', 0.0))
            sp1 = float(live_data.get('sp1', 0.0))
            ltp = float(live_data.get('lp', 0.0))
            side = params.buy_or_sell.upper()
            
            if side.startswith("S") and bp1 > 0:
                final_price = bp1
            elif side.startswith("B") and sp1 > 0:
                final_price = sp1
            else:
                final_price = ltp if ltp > 0 else current_order_price
                
            final_price = round_to_tick(final_price, tick_size, round_up=side.startswith("B"), round_down=not side.startswith("B"))
            logger.info(f"[EXEC ENGINE] Exit timeout reached. Escalating order {current_order_id} to resting quote @ {final_price}")
            modify_open_order(current_order_id, params, remaining_qty, final_price, is_paper)
            
            # Give 2.0s for resting fill
            for _ in range(20):
                time.sleep(0.1)
                c_status = get_order_status(current_order_id, is_paper, params)
                if c_status:
                    if c_status.get("status") == "COMPLETE":
                        c_avg = float(c_status.get("avg_price", 0.0))
                        cur_sum = sum(q for q, _ in fills)
                        fill_qty = total_qty - cur_sum
                        fills.append((fill_qty, c_avg if c_avg > 0 else final_price))
                        remaining_qty = 0
                        break
                    elif int(c_status.get("filled_qty", 0)) > 0:
                        c_filled = int(c_status.get("filled_qty", 0))
                        c_avg = float(c_status.get("avg_price", 0.0))
                        cur_sum = sum(q for q, _ in fills)
                        if c_filled > cur_sum:
                            fills.append((c_filled - cur_sum, c_avg if c_avg > 0 else final_price))
                        remaining_qty = total_qty - sum(q for q, _ in fills)
                        if remaining_qty <= 0:
                            break
                            
            if remaining_qty > 0:
                logger.warning(f"[EXEC ENGINE] Exit order {parent_order_id} could not be filled. Cancelling child order...")
                cancel_order(current_order_id, is_paper)
        elif user_cancelled:
            # User explicitly requested order cancellation
            logger.info(f"[EXEC ENGINE] Cancelling active child order {current_order_id} due to user request...")
            cancel_order(current_order_id, is_paper)
            for _ in range(10):
                c_status = get_order_status(current_order_id, is_paper, params)
                if c_status and c_status.get("status") in ["CANCELED", "CANCELLED", "COMPLETE"]:
                    c_filled = int(c_status.get("filled_qty", 0))
                    c_avg = float(c_status.get("avg_price", 0.0))
                    cur_sum = sum(q for q, _ in fills)
                    if c_filled > cur_sum:
                        fills.append((c_filled - cur_sum, c_avg if c_avg > 0 else current_order_price))
                    break
                time.sleep(0.1)
        elif last_status in ["REJECTED", "REJECT"]:
            pass
        else:
            # Only cancel if exit mode
            if is_exit_mode:
                cancel_order(current_order_id, is_paper)

    # 4. Final Compile & Broadcast
    total_filled = sum(q for q, _ in fills)
    if total_filled > 0:
        weighted_avg = sum(q * p for q, p in fills) / total_filled
        weighted_avg = round(weighted_avg, 4 if params.exchange.upper() == "CDS" else 2)
        status = "COMPLETE" if total_filled == total_qty else "PARTIAL"
        
        broadcast_order_update(
            parent_order_id=parent_order_id,
            status=status,
            avgprc=weighted_avg,
            filledqty=total_filled,
            symbol=params.symbol,
            remarks=f"Chased, filled {total_filled}/{total_qty}"
        )
    elif last_status in ["REJECTED", "REJECT"]:
        broadcast_order_update(
            parent_order_id=parent_order_id,
            status="REJECTED",
            avgprc=0.0,
            filledqty=0,
            symbol=params.symbol,
            remarks=status_info.get("rejreason", "Order Rejected") if 'status_info' in locals() and status_info else "Order Rejected"
        )
    else:
        remarks = "Cancelled by User" if user_cancelled else ("Exit Chasing Timeout (Collar Guard)" if is_exit_mode else "Order Cancelled")
        broadcast_order_update(
            parent_order_id=parent_order_id,
            status="CANCELED",
            avgprc=0.0,
            filledqty=0,
            symbol=params.symbol,
            remarks=remarks
        )
        
    app_state.chasing_orders.pop(parent_order_id, None)

def start_execution_engine(params, is_paper: bool) -> dict:
    """Create a parent order entry and spawn the background chasing thread."""
    # Generate unique parent order ID
    parent_order_id = f"PARENT_{int(time.time())}_{math.floor(time.time() * 1000) % 1000}"
    
    # Resolve tick size
    tick_size = get_tick_size(params.exchange, params.symbol)
    
    # Calculate price based on mode if not triggering
    initial_price = params.price
    execution_mode = params.execution_mode
    slippage_tolerance = params.slippage_tolerance if params.slippage_tolerance is not None else 0.03
    
    if execution_mode not in ["Limit_Below", "Limit_Above"]:
        live_data = get_live_data(params.exchange, params.symbol)
        ltp = float(live_data.get('lp', 0.0))
        bp1 = float(live_data.get('bp1', 0.0))
        sp1 = float(live_data.get('sp1', 0.0))
        
        side = params.buy_or_sell.upper()
        
        if execution_mode in ["Aggressive_Entry", "Aggressive_Exit"]:
            if side.startswith("B"):  # BUY: Best Buy + tick, capped at Upper Boundary = max(LTP, Best Buy) * (1 + collar%)
                ref_anchor = max(ltp, bp1) if (ltp > 0 or bp1 > 0) else float(params.price or 0)
                upper_bound = round_to_tick(ref_anchor * (1.0 + slippage_tolerance), tick_size, round_down=True)
                target_px = (bp1 + tick_size) if bp1 > 0 else (ltp if ltp > 0 else float(params.price or 0))
                initial_price = min(target_px, upper_bound) if upper_bound > 0 else target_px
            else:  # SELL: Best Sell - tick, floored at Lower Boundary = min(LTP, Best Sell) * (1 - collar%)
                ref_anchor = min(ltp, sp1) if (ltp > 0 and sp1 > 0) else (ltp if ltp > 0 else (sp1 if sp1 > 0 else float(params.price or 0)))
                lower_bound = max(tick_size, round_to_tick(ref_anchor * (1.0 - slippage_tolerance), tick_size, round_up=True))
                target_px = (sp1 - tick_size) if sp1 > 0 else (ltp if ltp > 0 else float(params.price or 0))
                initial_price = max(target_px, lower_bound)
        elif execution_mode == "True_Limit_LTP":
            initial_price = ltp if ltp > 0 else float(params.price or 0)
            
        initial_price = round_to_tick(
            initial_price,
            tick_size,
            round_up=side.startswith("B"),
            round_down=not side.startswith("B")
        )
        
    ref_px = float(params.price or 0)
    side_str = params.buy_or_sell.upper()
    if side_str.startswith("B"):
        if ref_px > 0.5 and initial_price < (ref_px * 0.5):
            initial_price = ref_px
        elif initial_price <= 0.05 and ref_px > 0:
            initial_price = ref_px
    else:
        if initial_price <= 0.05 and ref_px > 0:
            initial_price = max(tick_size, ref_px)
        
    # Initialize mock paper order record if PAPER trading
    if is_paper:
        if not hasattr(app_state, 'paper_orders'):
            app_state.paper_orders = {}
        app_state.paper_orders[parent_order_id] = {
            "status": "PENDING",
            "qty": params.quantity,
            "filled_qty": 0,
            "remaining_qty": params.quantity,
            "price": initial_price,
            "avg_price": 0.0,
            "symbol": params.symbol,
            "exchange": params.exchange,
            "side": params.buy_or_sell,
            "created_at": time.time()
        }
        
    # Spawn chasing daemon thread
    t = threading.Thread(
        target=execution_thread_worker,
        args=(params, parent_order_id, initial_price, tick_size, is_paper),
        daemon=True
    )
    t.start()
    
    return {"status": "success", "order_id": parent_order_id}
```
\n
### File: `brokers/flattrade_broker.py`
```python
import os
import time
import json
import logging
import asyncio
import hashlib
import requests
import threading
import datetime
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, Request
import pyotp
import pandas as pd
from NorenRestApiPy.NorenApi import NorenApi

try:
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
except ImportError:
    pass

logger = logging.getLogger("WebTraderApi.Broker")

# Globals to be injected by main.py
app_state = None
manager = None

router = APIRouter()

# === Flattrade REST & WS Client === #
class FlatTradeApiPy(NorenApi):
    def __init__(self):
        NorenApi.__init__(self, 'https://piconnect.flattrade.in/PiConnectAPI/', 'wss://piconnect.flattrade.in/PiConnectWSAPI/')

    def _NorenApi__on_open_callback(self, ws=None):
        self._NorenApi__websocket_connected = True
        import json as _json
        values = { "t": "a" }
        values["uid"] = getattr(self, '_NorenApi__username', '')        
        values["actid"] = getattr(self, '_NorenApi__username', '')
        ws_token = getattr(self, '_NorenApi__access_token', '')
        values["accesstoken"] = ws_token
        values["source"] = 'API'   
        payload = _json.dumps(values)
        logger.info(f"Sending WS Auth payload for Flattrade API")
        self._NorenApi__ws_send(payload)

    def _NorenApi__on_data_callback(self, ws=None, message=None, data_type=None, continue_flag=None):
        import json as _json
        try:
            res = _json.loads(message)
        except Exception:
            return

        subscribe_cb = getattr(self, '_NorenApi__subscribe_callback', None)
        if subscribe_cb is not None and res.get('t') in ('tk', 'tf', 'dk', 'df'):
            subscribe_cb(res)
            return

        order_cb = getattr(self, '_NorenApi__order_update_callback', None)
        if order_cb is not None and res.get('t') == 'om':
            order_cb(res)
            return

        open_cb = getattr(self, '_NorenApi__on_open', None)
        if open_cb is not None and res.get('t') in ('ck', 'ak') and res.get('s') == 'OK':
            logger.info("WS Auth acknowledged OK - connection live!")
            open_cb()
            return

        error_cb = getattr(self, '_NorenApi__on_error', None)
        if error_cb is not None and res.get('t') in ('ck', 'ak') and res.get('s') != 'OK':
            logger.error(f"WS Auth REJECTED by server: {res}")
            error_cb(res)
            return

    def close_websocket(self):
        """Cleanly and unconditionally closes WebSocket and joins worker thread."""
        stop_event = getattr(self, '_NorenApi__stop_event', None)
        if stop_event is not None:
            stop_event.set()

        ws = getattr(self, '_NorenApi__websocket', None)
        if ws is not None:
            try:
                ws.close()
            except Exception as e:
                logger.debug(f"[FLATTRADE WS] Error closing WebSocket: {e}")

        ws_thread = getattr(self, '_NorenApi__ws_thread', None)
        if ws_thread is not None and ws_thread.is_alive() and ws_thread != threading.current_thread():
            try:
                ws_thread.join(timeout=2.0)
            except Exception as e:
                logger.debug(f"[FLATTRADE WS] Error joining ws_thread: {e}")

        self._NorenApi__websocket_connected = False
        self._NorenApi__websocket = None
        self._NorenApi__ws_thread = None

    def _NorenApi__ws_run_forever(self):
        """Thread worker with zombie thread exit and backoff."""
        stop_event = getattr(self, '_NorenApi__stop_event', None)
        while stop_event and not stop_event.is_set():
            ws = getattr(self, '_NorenApi__websocket', None)
            if not ws:
                break
            try:
                ws.run_forever(ping_interval=3, ping_payload='{"t":"h"}')
            except Exception as e:
                err_msg = str(e).lower()
                if "already opened" in err_msg:
                    logger.warning("[FLATTRADE WS] Redundant WebSocket thread detected ('socket is already opened'); exiting thread cleanly.")
                    break
                logger.warning(f"websocket run forever ended in exception, {e}")

            if stop_event.is_set():
                break
            time.sleep(1.0)

    def start_websocket(self, subscribe_callback=None, 
                        order_update_callback=None,
                        socket_open_callback=None,
                        socket_close_callback=None,
                        socket_error_callback=None):
        """Start a websocket connection with clean pre-teardown."""
        self.close_websocket()

        self._NorenApi__on_open = socket_open_callback
        self._NorenApi__on_disconnect = socket_close_callback
        self._NorenApi__on_error = socket_error_callback
        self._NorenApi__subscribe_callback = subscribe_callback
        self._NorenApi__order_update_callback = order_update_callback
        self._NorenApi__stop_event = threading.Event()

        import websocket
        service_config = getattr(self, '_NorenApi__service_config', {})
        endpoint = service_config.get('websocket_endpoint', 'wss://piconnect.flattrade.in/PiConnectWSAPI/')
        susertoken = getattr(self, '_NorenApi__susertoken', '') or getattr(self, '_NorenApi__access_token', '')
        url = endpoint.format(access_token=susertoken)
        logger.info(f"[FLATTRADE WS] Connecting WebSocket to {endpoint}...")

        self._NorenApi__websocket = websocket.WebSocketApp(
            url,
            on_data=self._NorenApi__on_data_callback,
            on_error=self._NorenApi__on_error_callback,
            on_close=self._NorenApi__on_close_callback,
            on_open=self._NorenApi__on_open_callback
        )
        self._NorenApi__ws_thread = threading.Thread(target=self._NorenApi__ws_run_forever, daemon=True)
        self._NorenApi__ws_thread.start()

# === Shoonya API Callbacks === #
def convert_to_float(val):
    try:
        if val is None or val == "": return 0.0
        return float(val)
    except:
        return 0.0

def shoonya_quote_update(data: dict):
    try:
        exch = data.get('e') or data.get('exch') or ''
        token = str(data.get('tk') or data.get('token') or '')
        ts = data.get('ts') or data.get('tsym')

        keys_to_update = [f"{exch}|{token}", token]
        if ts:
            keys_to_update.extend([f"{exch}|{ts}", ts])
            if ts.endswith('-EQ'):
                base_ts = ts[:-3]
                keys_to_update.extend([f"{exch}|{base_ts}", base_ts, f"NSE|{base_ts}"])

        # Resolve symbol from token map for NSE spot equities
        t2i = getattr(app_state, 'token_to_info', {})
        info = t2i.get((exch, token)) or t2i.get(('NSE', token)) or t2i.get(('NFO', token))
        if info:
            sym_name = info.get('Symbol') or info.get('TradingSymbol')
            if sym_name:
                keys_to_update.extend([f"{exch}|{sym_name}", sym_name])
                if sym_name.endswith('-EQ'):
                    base_s = sym_name[:-3]
                    keys_to_update.extend([f"{exch}|{base_s}", base_s, f"NSE|{base_s}"])

        nfo_token_map = getattr(app_state, 'nfo_token_map', {})
        if exch == 'NFO':
            ts = ts or nfo_token_map.get(token)
            if ts:
                if token not in nfo_token_map:
                    nfo_token_map[token] = ts
                keys_to_update.extend([f"{exch}|{ts}", ts])

        for k in set(keys_to_update):
            if not k: continue
            if k not in app_state.live_data:
                app_state.live_data[k] = {}
            old_data = app_state.live_data[k]
            for fd in ["lp", "pc", "o", "h", "l", "c", "v", "oi", "poi", "bp1", "sp1"]:
                if fd in data:
                    old_data[fd] = convert_to_float(data[fd])

            if "lp" in old_data and "c" in old_data and old_data["c"] > 0:
                lp_val = old_data["lp"]
                c_val = old_data["c"]
                old_data["pc"] = round(((lp_val - c_val) / c_val) * 100.0, 2)
                old_data["change"] = round(lp_val - c_val, 2)

            # Safely buffer update for batched background broadcasting
            with app_state.pending_updates_lock:
                app_state.pending_updates[k] = {"key": k, **old_data}
    except Exception as e:
        logger.error(f"Quote update error: {e}")

def shoonya_order_update(data: dict):
    logger.info(f"Shoonya Order Update callback received: {data}")
    if not app_state.main_loop: return
    try:
        orderno = data.get("norenordno")
        if orderno and hasattr(app_state, 'order_mappings') and orderno in app_state.order_mappings:
            logger.info(f"[EXEC ENGINE] Suppressing raw update for chased child order: {orderno}")
            return
            
        asyncio.run_coroutine_threadsafe(
            manager.broadcast("ORDER_UPDATE", data),
            app_state.main_loop
        )
    except Exception as e:
        logger.error(f"Order update error: {e}")

def subscribe_symbols(symbols: List[str]):
    if not app_state.logged_in or not app_state.api:
        return
    resolved_symbols = []
    snapshot_items = []
    symbol_to_token = getattr(app_state, 'symbol_to_token', {})
    nfo_token_map = getattr(app_state, 'nfo_token_map', {})
    for sym in symbols:
        sym_norm = sym.replace(':', '|').replace(' ', '|').upper()
        if "|" in sym_norm:
            exch, symbol_or_token = sym_norm.split("|", 1)
            exch = exch.upper()
            token = symbol_to_token.get((exch, symbol_or_token.upper()))
            if token:
                resolved_symbols.append(f"{exch}|{token}")
                if exch == 'NFO':
                    nfo_token_map[token] = symbol_or_token.upper()
                live_entry = app_state.live_data.get(f"{exch}|{token}", {})
                if "lp" not in live_entry:
                    snapshot_items.append((exch, token, symbol_or_token.upper()))
            else:
                resolved_symbols.append(sym_norm)
        else:
            resolved_symbols.append(sym_norm)
            
    flattrade_subscribed_tokens = getattr(app_state, 'flattrade_subscribed_tokens', set())
    new_symbols = [s for s in resolved_symbols if s not in flattrade_subscribed_tokens]
    if new_symbols:
        logger.info(f"[FLATTRADE SUBSCRIPTION] Subscribing {len(new_symbols)} new symbols to market feed in 50-symbol batches...")
        for i in range(0, len(new_symbols), 50):
            chunk = new_symbols[i:i+50]
            try:
                app_state.api.subscribe(chunk)
                flattrade_subscribed_tokens.update(chunk)
                time.sleep(0.05)
            except Exception as e:
                logger.error(f"[FLATTRADE] Subscription error for chunk: {e}")
        app_state.flattrade_subscribed_tokens = flattrade_subscribed_tokens
    
    if snapshot_items:
        import threading
        from concurrent.futures import ThreadPoolExecutor
        def fetch_single_snap(item):
            exch, token, orig_sym = item
            try:
                if not app_state.api or not app_state.logged_in: return
                q = app_state.api.get_quotes(exchange=exch, token=token)
                if q and isinstance(q, dict) and q.get('stat') == 'Ok':
                    if not q.get('ts') and orig_sym: q['ts'] = orig_sym
                    if not q.get('e'): q['e'] = exch
                    shoonya_quote_update(q)
            except Exception as e:
                logger.debug(f"[FLATTRADE] REST quote snapshot note for {exch}|{token}: {e}")

        def bg_snapshots():
            logger.info(f"[FLATTRADE SNAPSHOTS] Fetching initial REST quotes for {len(snapshot_items)} symbols via 10 workers...")
            with ThreadPoolExecutor(max_workers=10) as executor:
                executor.map(fetch_single_snap, snapshot_items)

        threading.Thread(target=bg_snapshots, daemon=True).start()

def start_relay_ticks(other_port):
    import websocket
    import json
    import threading
    
    def on_message(ws, message):
        try:
            payload = json.loads(message)
            if payload.get("type") == "BATCH_QUOTE_UPDATE":
                for item in payload.get("data", []):
                    key = item.get("key", "")
                    if "|" in key:
                        exch, token = key.split("|", 1)
                        mock_update = {
                            "e": exch,
                            "tk": token
                        }
                        for fld in ["lp", "pc", "o", "h", "l", "c", "v", "oi", "poi", "bp1", "sp1"]:
                            if fld in item:
                                mock_update[fld] = item[fld]
                        shoonya_quote_update(mock_update)
        except Exception as e:
            logger.debug(f"[TICK RELAY] Error processing relay message: {e}")

    def on_error(ws, error):
        logger.warning(f"[TICK RELAY] Connection error on port {other_port}: {error}")

    def on_close(ws, close_status_code, close_msg):
        logger.info(f"[TICK RELAY] Connection closed on port {other_port}. Checking failover...")
        other_active = False
        try:
            import requests
            r = requests.get(f"http://127.0.0.1:{other_port}/api/status", timeout=2)
            if r.status_code == 200:
                data = r.json()
                if data.get("logged_in") and data.get("active_broker") == "FLATTRADE":
                    other_active = True
        except Exception:
            pass

        if other_active:
            logger.info("Other server is still active. Retrying relay in 5s...")
            time.sleep(5)
            connect_relay()
        else:
            logger.warning("[TICK RELAY] Other server is down. Failing back to broker WebSocket...")
            app_state.websocket_connected = False
            websocket_reconnect_loop()

    def connect_relay():
        ws_url = f"ws://127.0.0.1:{other_port}/ws"
        logger.info(f"[TICK RELAY] Connecting to {ws_url} to share market data...")
        ws = websocket.WebSocketApp(
            ws_url,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close
        )
        ws.run_forever()

    threading.Thread(target=connect_relay, daemon=True).start()

_flattrade_ws_lock = threading.Lock()

def ensure_websocket_or_relay(api):
    with _flattrade_ws_lock:
        our_port = 8095
        try:
            main_path = os.path.join(os.getcwd(), "main.py")
            if os.path.exists(main_path):
                with open(main_path, 'r', encoding='utf-8') as f:
                    for line in f:
                        if 'uvicorn.run(' in line and 'port=' in line:
                            import re
                            m = re.search(r'port\s*=\s*(\d+)', line)
                            if m:
                                our_port = int(m.group(1))
                                break
        except Exception:
            pass
        other_port = 8000 if our_port == 8095 else 8095

        # Check if other server is active and logged in to FLATTRADE
        other_active = False
        try:
            import requests
            r = requests.get(f"http://127.0.0.1:{other_port}/api/status", timeout=2)
            if r.status_code == 200:
                data = r.json()
                if data.get("logged_in") and data.get("active_broker") == "FLATTRADE":
                    other_active = True
        except Exception:
            pass

        if other_active:
            logger.info(f"[TICK RELAY] Other server on port {other_port} is active and logged in. Connecting to its websocket instead of broker to avoid conflicts...")
            try:
                api.close_websocket()
            except Exception:
                pass
            start_relay_ticks(other_port)
            app_state.websocket_connected = True
            return True

        # Otherwise start normal websocket
        logger.info("[TICK RELAY] Starting normal broker WebSocket connection...")
        try:
            api.close_websocket()
        except Exception:
            pass
        api.start_websocket(
            order_update_callback=shoonya_order_update,
            subscribe_callback=shoonya_quote_update,
            socket_open_callback=shoonya_socket_open,
            socket_close_callback=shoonya_socket_close,
        )
        return False

def websocket_reconnect_loop():
    if app_state.reconnecting:
        return
    app_state.reconnecting = True
    logger.info("Initiating automatic WebSocket reconnection loop...")
    
    attempt = 0
    while not app_state.websocket_connected:
        attempt += 1
        logger.info(f"WebSocket reconnect attempt {attempt}...")
        
        # If reconnection fails repeatedly (e.g. after 3 attempts), the token is likely expired.
        # Trigger background automatic re-login.
        if attempt > 3 and attempt % 3 == 1:
            logger.warning("WebSocket reconnection failing repeatedly. Session token might have expired. Triggering re-login...")
            if app_state.main_loop:
                future = asyncio.run_coroutine_threadsafe(trigger_relogin_and_reconnect(), app_state.main_loop)
                try:
                    success = future.result(timeout=60)
                    if success:
                        logger.info("Re-login successful inside reconnect loop, resetting attempt count.")
                        attempt = 0
                        continue
                except Exception as re_err:
                    logger.error(f"Error during automatic re-login in reconnect loop: {re_err}")
                    
        try:
            if app_state.api:
                is_relay = ensure_websocket_or_relay(app_state.api)
                if is_relay:
                    logger.info("WebSocket reconnected successfully via Tick Relay!")
                    if app_state.subscriptions:
                        logger.info(f"Restoring {len(app_state.subscriptions)} subscriptions...")
                        subscribe_symbols(app_state.subscriptions)
                    break
                
                # Wait up to 10 seconds for socket_open_callback to set websocket_connected to True
                for _ in range(20):
                    if app_state.websocket_connected:
                        break
                    time.sleep(0.5)
                    
                if app_state.websocket_connected:
                    logger.info("WebSocket reconnected successfully!")
                    if app_state.subscriptions:
                        logger.info(f"Restoring {len(app_state.subscriptions)} subscriptions...")
                        subscribe_symbols(app_state.subscriptions)
                    break
            else:
                logger.warning("API not initialized during reconnect")
        except Exception as e:
            logger.error(f"Error during WebSocket reconnect attempt: {e}")
            
        time.sleep(5)  # Wait 5 seconds before next attempt
        
    app_state.reconnecting = False

def shoonya_socket_open():
    app_state.websocket_connected = True
    if not app_state.main_loop: return
    logger.info("Flattrade WebSocket Opened")
    
    # Auto-subscribe to all queued symbols when the market feed becomes live
    if app_state.subscriptions:
        logger.info(f"Automatically subscribing to {len(app_state.subscriptions)} queued symbols...")
        try:
            subscribe_symbols(app_state.subscriptions)
        except Exception as se:
            logger.error(f"Error subscribing during socket open: {se}")
            
    asyncio.run_coroutine_threadsafe(
        manager.broadcast("SYSTEM_MSG", "⚡ Flattrade Market Data Feed Connected"),
        app_state.main_loop
    )

def shoonya_socket_error(err):
    logger.error(f"Flattrade WebSocket Error: {err}")

def shoonya_socket_close():
    app_state.websocket_connected = False
    logger.warning("Flattrade WebSocket Closed")
    if app_state.main_loop:
        asyncio.run_coroutine_threadsafe(
            manager.broadcast("SYSTEM_MSG", "⚠️ Flattrade Market Data Feed Disconnected - Reconnecting..."),
            app_state.main_loop
        )
    if not app_state.reconnecting:
        threading.Thread(target=websocket_reconnect_loop, daemon=True).start()

def auto_login_flattrade_browser_sync(auth_url: str, userid: str, password: str, totp_secret: str):
    try:
        logger.info("Initializing Chrome options...")
        options = webdriver.ChromeOptions()
        options.add_argument("--window-size=1440,960")
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        options.add_experimental_option("useAutomationExtension", False)
        logger.info("Starting webdriver.Chrome...")
        driver = webdriver.Chrome(options=options)
        wait = WebDriverWait(driver, 20)

        def get_vis_inputs():
            try:
                inputs = driver.find_elements(
                    By.CSS_SELECTOR,
                    "input:not([type='hidden']):not([type='checkbox']):not([type='radio'])",
                )
                return [inp for inp in inputs if inp.is_displayed() and inp.is_enabled()]
            except Exception:
                return []

        def wait_for_inputs(min_count, timeout=10):
            logger.info(f"Waiting for {min_count} inputs...")
            start = time.time()
            while time.time() - start < timeout:
                vis = get_vis_inputs()
                if len(vis) >= min_count:
                    logger.info(f"Found {len(vis)} inputs.")
                    return True
                time.sleep(0.5)
            logger.warning(f"Timeout waiting for inputs.")
            return False

        def safe_fill(index, value):
            logger.info(f"Filling input index {index}...")
            for _ in range(10):
                try:
                    vis = get_vis_inputs()
                    if index < len(vis):
                        el = vis[index]
                        el.click()
                        time.sleep(0.1)
                        try:
                            from selenium.webdriver.common.keys import Keys
                            el.send_keys(Keys.CONTROL + "a")
                            el.send_keys(Keys.BACKSPACE)
                        except Exception:
                            el.clear()

                        for char in str(value):
                            el.send_keys(char)
                            time.sleep(0.02)

                        try:
                            driver.execute_script("""
                                var el = arguments[0];
                                var val = arguments[1];
                                var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                                if (nativeInputValueSetter) {
                                    nativeInputValueSetter.call(el, val);
                                } else {
                                    el.value = val;
                                }
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                el.dispatchEvent(new Event('blur', { bubbles: true }));
                            """, el, str(value))
                        except Exception:
                            pass
                        logger.info(f"Successfully filled input {index}.")
                        return True
                except Exception:
                    pass
                time.sleep(0.5)
            logger.warning(f"Failed to fill input {index}.")
            return False

        def click_primary_button():
            logger.info("Waiting for primary button...")
            for _ in range(20): # 10 seconds max
                try:
                    buttons = driver.find_elements(By.TAG_NAME, "button")
                    inputs = driver.find_elements(By.TAG_NAME, "input")
                    
                    for btn in buttons + inputs:
                        if not btn.is_displayed():
                            continue
                            
                        raw_text = (btn.text or btn.get_attribute("value") or "").lower()
                        text = raw_text.replace(" ", "")
                        btn_type = (btn.get_attribute("type") or "").lower()
                        
                        if "login" in text or "submit" in text or "verify" in text or "signin" in text or btn_type == "submit":
                            time.sleep(0.3)
                            try:
                                btn.click()
                                logger.info(f"Clicked primary button (text: '{raw_text}', type: '{btn_type}').")
                            except Exception as click_err:
                                pass
                                
                            try:
                                driver.execute_script("arguments[0].click();", btn)
                                logger.info(f"Clicked primary button via JS (text: '{raw_text}').")
                            except Exception:
                                pass
                            return True
                except Exception as e:
                    logger.debug(f"Error checking buttons: {e}")
                time.sleep(0.5)
            logger.warning("Failed to automatically click login button. Please click it manually if you see it.")
            return False

        logger.info(f"Navigating to auth_url: {auth_url}")
        driver.get(auth_url)
        time.sleep(1)
        if driver.current_url.startswith("data:"):
            logger.info("Retrying navigation to auth_url...")
            driver.get(auth_url)

        has_totp_on_screen = False
        if wait_for_inputs(min_count=2, timeout=15):
            safe_fill(0, userid)
            safe_fill(1, password)
            
            vis = get_vis_inputs()
            if len(vis) >= 3 and totp_secret:
                has_totp_on_screen = True
                totp_code = pyotp.TOTP(totp_secret).now()
                safe_fill(2, totp_code)
                time.sleep(0.3)
                try:
                    from selenium.webdriver.common.keys import Keys
                    vis[2].send_keys(Keys.ENTER)
                    logger.info("Sent ENTER key to TOTP input.")
                except Exception as ke:
                    logger.warning(f"Failed to send ENTER key: {ke}")
                
            click_primary_button()

        if not has_totp_on_screen:
            logger.info("Waiting for TOTP screen...")
            start_totp = time.time()
            while time.time() - start_totp < 15:
                try:
                    curr_url = driver.current_url
                    if "request_code" in curr_url or "/flattrade/callback" in curr_url:
                        logger.info("Callback reached before/during TOTP.")
                        break
                        
                    vis = get_vis_inputs()
                    if len(vis) == 1 and totp_secret:
                        logger.info("Detected exactly 1 input. Entering TOTP...")
                        if safe_fill(0, pyotp.TOTP(totp_secret).now()):
                            click_primary_button()
                            break
                except Exception as loop_err:
                    logger.debug(f"Transient error waiting for TOTP screen: {loop_err}")
                time.sleep(1)

        logger.info("Flattrade browser auto-login completed. Waiting for callback...")
        for i in range(30):
            try:
                current_url = driver.current_url
                if "request_code" in current_url or "code=" in current_url:
                    logger.info(f"Found callback in URL! URL: {current_url}")
                    try:
                        from urllib.parse import urlparse, parse_qs
                        parsed = urlparse(current_url)
                        params = parse_qs(parsed.query)
                        req_code = params.get("request_code", params.get("code", [None]))[0]
                        
                        if req_code and app_state.flattrade_auth_code_future and not app_state.flattrade_auth_code_future.done():
                            logger.info(f"Extracted request_code. Setting future...")
                            app_state.main_loop.call_soon_threadsafe(
                                app_state.flattrade_auth_code_future.set_result, req_code
                            )
                    except Exception as e:
                        logger.error(f"Failed to extract request_code from URL: {e}")
                    break
                else:
                    if i > 0 and i % 3 == 0:
                        logger.info(f"Still waiting for callback... Current URL: {current_url}. Re-trying primary button click...")
                        click_primary_button()
            except Exception as loop_err:
                logger.debug(f"Transient error waiting for callback URL: {loop_err}")
            time.sleep(1)
        
        time.sleep(1)
        try:
            driver.quit()
        except Exception:
            pass
    except Exception as e:
        logger.error(f"Flattrade browser auto-login fallback. Please check browser manually: {e}")
        import webbrowser
        webbrowser.open(auth_url)

async def do_login(userid, password, totp_key, vendor_code, api_secret, imei="abcd1234"):
    api = FlatTradeApiPy()
    
    # Load redirect URL from Flattrade_Creds.txt if available
    creds = {}
    target_files = [
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "Flattrade", "Flattrade_Creds.txt"),
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "Flattrade", "Creds.txt"),
        os.path.join(os.getcwd(), "Flattrade", "Flattrade_Creds.txt"),
        os.path.join(os.getcwd(), "Flattrade", "Creds.txt"),
        os.path.join(os.getcwd(), "Creds.txt"),
    ]
    creds_file = next((f for f in target_files if os.path.exists(f)), None)
    if creds_file:
        try:
            with open(creds_file, 'r') as f:
                for line in f:
                    if ':' in line:
                        parts = line.strip().split(':', 1)
                        creds[parts[0].strip().lower()] = parts[1].strip()
        except Exception as e:
            logger.error(f"Failed to read Flattrade creds file from {creds_file}: {e}")
            
    redirect_url = creds.get('redirecturl') or creds.get('redirect url') or "http://127.0.0.1:8095/flattrade/callback"
    redirect_url = redirect_url.strip()

    # If there are multiple comma-separated URLs in Creds.txt, parse our port and match the correct one
    if ',' in redirect_url:
        port = 8095
        try:
            main_path = os.path.join(os.getcwd(), "main.py")
            if os.path.exists(main_path):
                with open(main_path, 'r', encoding='utf-8') as f:
                    for line in f:
                        if 'uvicorn.run(' in line and 'port=' in line:
                            import re
                            m = re.search(r'port\s*=\s*(\d+)', line)
                            if m:
                                port = int(m.group(1))
                                break
        except Exception as pe:
            logger.warning(f"Could not parse port from main.py: {pe}")

        urls = [u.strip() for u in redirect_url.split(',')]
        matched = [u for u in urls if f":{port}" in u]
        if matched:
            redirect_url = matched[0]
        else:
            redirect_url = urls[0]

    params = {
        "app_key": vendor_code,
        "redirect_url": redirect_url,
        "user_id": userid,
    }
    auth_url = "https://auth.flattrade.in/?" + urlencode(params)
    
    logger.info("Logging in via Flattrade. Initializing browser...")
    app_state.flattrade_auth_code_future = app_state.main_loop.create_future()
    
    import threading
    threading.Thread(target=auto_login_flattrade_browser_sync, args=(auth_url, userid, password, totp_key), daemon=True).start()
    
    try:
        request_code = await asyncio.wait_for(app_state.flattrade_auth_code_future, timeout=120)
    except asyncio.TimeoutError:
        app_state.logged_in = False
        app_state.api = None
        return False, "Timeout waiting for Flattrade request_code"
    
    logger.info("Exchanging Flattrade callback code for access token...")
    hash_input = vendor_code + request_code + api_secret
    api_secret_hash = hashlib.sha256(hash_input.encode()).hexdigest()
    
    payload = {
        "api_key": vendor_code,
        "request_code": request_code,
        "api_secret": api_secret_hash,
    }
    TOKEN_URL = "https://authapi.flattrade.in/trade/apitoken"
    max_post_attempts = 5
    response = None
    last_err = None
    for attempt in range(1, max_post_attempts + 1):
        try:
            logger.info(f"Sending token exchange request (attempt {attempt}/{max_post_attempts})...")
            response = await asyncio.to_thread(requests.post, TOKEN_URL, json=payload, timeout=20)
            response.raise_for_status()
            break
        except Exception as e:
            last_err = e
            logger.warning(f"Token exchange POST failed (attempt {attempt}): {e}")
            if attempt < max_post_attempts:
                await asyncio.sleep(2)
                
    if response is None:
        logger.error(f"Failed to exchange token after {max_post_attempts} attempts: {last_err}")
        app_state.logged_in = False
        app_state.api = None
        return False, f"Error generating token: {str(last_err)}"

    try:
        data = response.json()
        if data.get("stat") == "Ok":
            access_token = data.get("token")
            susertoken = data.get("susertoken") or access_token
            
            def session_setup():
                api.set_session(userid=userid, password=password, usertoken=susertoken)
                setattr(api, '_NorenApi__access_token', access_token or susertoken)
                if hasattr(api, "injectOAuthHeader"):
                    api.injectOAuthHeader(access_token, userid, userid)
                return api.get_limits()
                
            limits = await asyncio.to_thread(session_setup)
            if limits and limits.get('stat') == 'Ok':
                app_state.api = api
                app_state.logged_in = True
                uname = limits.get('uname', userid)
                logger.info(f"Login Success. Welcome {uname}")
                ensure_websocket_or_relay(api)
                # Background fetch 14-day historical metrics from Flattrade API
                def _fetch_hist_bg():
                    try:
                        if getattr(app_state, 'fno_spot_df', None) is not None and not app_state.fno_spot_df.empty:
                            df_spots = app_state.fno_spot_df.drop_duplicates(subset=["Symbol"]).copy()
                            df_nse = pd.read_csv("Instrument/NSE_symbols.csv")
                            df_nse_eq = df_nse[df_nse['Instrument'] == 'EQ']
                            nse_token_map = dict(zip(df_nse_eq['Symbol'], df_nse_eq['Token'].astype(str)))
                            
                            symbol_token_map = {}
                            for _, r in df_spots.iterrows():
                                sym = r["Symbol"]
                                if 'NSETEST' not in str(sym).upper() and sym in nse_token_map:
                                    symbol_token_map[sym] = {"exchange": "NSE", "token": nse_token_map[sym]}
                                    
                            logger.info(f"[BACKGROUND] Fetching 14-day Avg Volume & ATR via Flattrade API for {len(symbol_token_map)} symbols...")
                            new_metrics = get_all_historical_metrics(api, symbol_token_map, force_refresh=False)
                            if new_metrics:
                                app_state.historical_data = new_metrics
                                logger.info(f"[BACKGROUND] Successfully cached {len(new_metrics)} historical metrics post-login.")
                    except Exception as e:
                        logger.error(f"Error fetching background historical metrics: {e}")

                threading.Thread(target=_fetch_hist_bg, daemon=True).start()
                return True, uname
            else:
                app_state.logged_in = False
                app_state.api = None
                return False, limits.get("emsg", "Session limits fetch failed")
        else:
            app_state.logged_in = False
            app_state.api = None
            return False, data.get("emsg", "Token generation API Error")
    except Exception as e:
        logger.error(f"Error processing session response: {e}")
        app_state.logged_in = False
        app_state.api = None
        return False, f"Error processing session limits: {str(e)}"

async def trigger_relogin_and_reconnect() -> bool:
    logger.warning("Initiating background session re-login...")
    creds_file = os.path.join(os.path.dirname(os.path.dirname(__file__)), "Creds.txt")
    if not os.path.exists(creds_file):
        creds_file = os.path.join(os.getcwd(), "Creds.txt")
    if not os.path.exists(creds_file):
        logger.error("Creds.txt not found. Cannot perform background re-login.")
        return False
        
    creds = {}
    try:
        with open(creds_file, 'r') as f:
            for line in f:
                if ':' in line:
                    k, v = line.split(':', 1)
                    creds[k.strip().lower().replace(" ", "_")] = v.strip()
    except Exception as e:
        logger.error(f"Failed to read Creds.txt during re-login: {e}")
        return False
        
    success, msg = await do_login(
        userid=creds.get('vendor_code', ''),
        password=creds.get('password', ''),
        totp_key=creds.get('totp', ''),
        vendor_code=creds.get('api_key', ''),
        api_secret=creds.get('api_secret', '')
    )
    if success:
        logger.info("Session re-login succeeded. WebSocket connection and subscriptions are active.")
        return True
    else:
        logger.error(f"Session re-login failed: {msg}")
        return False

def check_api_response_for_expiry(res):
    if isinstance(res, dict) and res.get("stat") == "Not_Ok":
        emsg = str(res.get("emsg", "")).lower()
        if any(x in emsg for x in ["session expired", "invalid session", "not logged in", "session_expired", "invalid token"]):
            logger.warning(f"Detected session expiry/invalid error: {res.get('emsg')}. Triggering background re-login...")
            if app_state.main_loop:
                asyncio.run_coroutine_threadsafe(trigger_relogin_and_reconnect(), app_state.main_loop)

# === Generic Broker Operations to separate Main.py from specific Noren APIs === #
def place_broker_order(buy_or_sell: str, exchange: str, tradingsymbol: str, quantity: int, price_type: str, price: float, trigger_price: float = None, product_type: str = None):
    if not app_state.api:
        return None
    # Auto-resolve product_type if not provided: MIS ("M") for F&O derivatives, CNC ("C") for cash equities
    if not product_type:
        product_type = "M" if exchange.upper() not in ["NSE", "BSE"] else "C"
        
    res = app_state.api.place_order(
        buy_or_sell=buy_or_sell,
        product_type=product_type,
        exchange=exchange,
        tradingsymbol=tradingsymbol,
        quantity=quantity,
        discloseqty=0,
        price_type=price_type,
        price=price,
        trigger_price=trigger_price,
        retention="DAY",
        remarks="WebTrader"
    )
    return res

def cancel_broker_order(order_id: str):
    if not app_state.api:
        return None
    res = app_state.api.cancel_order(orderno=order_id)
    return res

def modify_broker_order(order_id: str, exchange: str, tradingsymbol: str, new_quantity: int, new_price_type: str, new_price: float, trigger_price: Optional[float] = None):
    if not app_state.api:
        return None
    res = app_state.api.modify_order(
        orderno=order_id,
        exchange=exchange,
        tradingsymbol=tradingsymbol,
        newquantity=new_quantity,
        newprice_type=new_price_type,
        newprice=new_price,
        newtrigger_price=trigger_price
    )
    return res

@router.get("/flattrade/callback")
async def flattrade_callback(request: Request, request_code: str = None, code: str = None):
    from fastapi.responses import HTMLResponse
    code_val = request_code or code
    if not code_val:
        return HTMLResponse(content="<h2 style='color:red'>Login failed: no code in callback URL.</h2>", status_code=400)
        
    if app_state and app_state.flattrade_auth_code_future and not app_state.flattrade_auth_code_future.done():
        if app_state.main_loop:
            app_state.main_loop.call_soon_threadsafe(
                app_state.flattrade_auth_code_future.set_result, code_val
            )
            return HTMLResponse(content="<h2>Login callback received. Processing in background...</h2>")
            
    return HTMLResponse(content="<h2>Callback ignored (future already resolved or not initialized).</h2>")

# === Flattrade Historical Metrics (14-Day Avg Vol & ATR) === #
HISTORICAL_CACHE_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "historical_cache.json")
_fetching_hist_lock = threading.Lock()

def fetch_single_symbol_metrics(api, exch: str, token: str):
    """
    Fetches daily time price series from Flattrade API for a single token,
    and returns dict: {"ATR": str, "AvgVol": str, "YestVol": str}
    """
    try:
        now = datetime.datetime.now()
        start_time = int((now - datetime.timedelta(days=35)).timestamp())
        end_time = int(now.timestamp())
        
        candles = api.get_time_price_series(exchange=exch, token=token, starttime=start_time, endtime=end_time, interval='1440')
        if not candles or not isinstance(candles, list):
            return None
            
        parsed_candles = []
        for c in candles:
            try:
                v = float(c.get('v', 0))
                h = float(c.get('inth', 0))
                l = float(c.get('intl', 0))
                c_price = float(c.get('intc', 0))
                parsed_candles.append({
                    'v': v, 
                    'h': h, 
                    'l': l, 
                    'c': c_price, 
                    'time': str(c.get('time', ''))
                })
            except (ValueError, TypeError):
                continue
                
        if len(parsed_candles) < 2:
            return None
            
        if parsed_candles[0]['time'] > parsed_candles[-1]['time']:
            parsed_candles.reverse()
            
        recent_14 = parsed_candles[-14:]
        
        vols = [c['v'] for c in recent_14]
        avg_vol = sum(vols) / len(vols) if vols else 0.0
        yest_vol = recent_14[-1]['v'] if recent_14 else 0.0
        
        tr_list = []
        for i in range(len(recent_14)):
            h = recent_14[i]['h']
            l = recent_14[i]['l']
            if i == 0:
                tr = h - l
            else:
                prev_close = recent_14[i-1]['c']
                tr = max(h - l, abs(h - prev_close), abs(l - prev_close))
            tr_list.append(tr)
            
        atr = sum(tr_list) / len(tr_list) if tr_list else 0.0
        
        return {
            "ATR": f"{atr:.2f}",
            "AvgVol": f"{avg_vol:.2f}",
            "YestVol": f"{int(yest_vol)}"
        }
    except Exception as e:
        logger.error(f"Error fetching historical metrics for {exch}|{token}: {e}")
        return None

def load_historical_cache(check_today: bool = True) -> dict:
    if os.path.exists(HISTORICAL_CACHE_FILE):
        try:
            with open(HISTORICAL_CACHE_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, dict):
                    m = data.get("metrics") if isinstance(data.get("metrics"), dict) else data
                    metrics = {k: v for k, v in m.items() if k != "date" and isinstance(v, dict)}
                    if metrics:
                        logger.info(f"[CACHE] Loaded {len(metrics)} historical metrics from cache.")
                        return metrics
        except Exception as e:
            logger.warning(f"Failed to load historical cache: {e}")
    return {}

def save_historical_cache(metrics: dict):
    try:
        data = {
            "date": datetime.date.today().isoformat(),
            "metrics": metrics
        }
        with open(HISTORICAL_CACHE_FILE, 'w') as f:
            json.dump(data, f, indent=2)
        logger.info(f"[CACHE] Saved {len(metrics)} historical metrics to {HISTORICAL_CACHE_FILE}")
    except Exception as e:
        logger.error(f"Failed to save historical cache: {e}")

def get_all_historical_metrics(api, symbol_token_map: dict, force_refresh: bool = False) -> dict:
    # 1. First check if today's cache is already populated on disk
    cached_today = load_historical_cache(check_today=True)
    if cached_today and not force_refresh:
        return cached_today

    # 2. If API not logged in, return any prior disk cache
    if not api or not getattr(app_state, 'logged_in', False):
        logger.warning("[CACHE] Flattrade API not logged in; returning cached historical metrics")
        return load_historical_cache(check_today=False)

    # 3. Single-flight lock: ensure only ONE thread downloads historical data at a time
    if not _fetching_hist_lock.acquire(blocking=False):
        logger.info("[CACHE] Historical metrics download already in progress in another thread; returning current cache.")
        return load_historical_cache(check_today=False)

    try:
        logger.info(f"Fetching 14-day Avg Volume & ATR from Flattrade API for {len(symbol_token_map)} symbols...")
        results = {}

        def fetch_task(item):
            sym, info = item
            exch = info.get("exchange", "NSE")
            token = str(info.get("token", ""))
            if not token or token == "-":
                return sym, None
            res = fetch_single_symbol_metrics(api, exch, token)
            return sym, res

        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(fetch_task, item) for item in symbol_token_map.items()]
            for future in futures:
                sym, res = future.result()
                if res:
                    results[sym] = res

        if results:
            save_historical_cache(results)
        else:
            results = load_historical_cache(check_today=False)
            
        return results
    finally:
        _fetching_hist_lock.release()

# === Flattrade BaseBroker Implementation === #
from brokers.base_broker import BaseBroker

class FlattradeBroker(BaseBroker):
    def get_name(self) -> str:
        return "FLATTRADE"

    def load_creds_from_file(self) -> Dict[str, str]:
        creds = {}
        target_files = [
            os.path.join(os.path.dirname(os.path.dirname(__file__)), "Flattrade", "Flattrade_Creds.txt"),
            os.path.join(os.path.dirname(os.path.dirname(__file__)), "Flattrade", "Creds.txt"),
            os.path.join(os.getcwd(), "Flattrade", "Flattrade_Creds.txt"),
            os.path.join(os.getcwd(), "Flattrade", "Creds.txt"),
            os.path.join(os.getcwd(), "Creds.txt"),
        ]
        creds_file = next((f for f in target_files if os.path.exists(f)), None)
        if creds_file:
            try:
                with open(creds_file, 'r') as f:
                    for line in f:
                        if ':' in line:
                            parts = line.strip().split(':', 1)
                            k = parts[0].strip().lower()
                            v = parts[1].strip()
                            creds[k] = v
                            creds[k.replace(" ", "_")] = v
                            creds[k.replace("_", " ")] = v
            except Exception as e:
                logger.error(f"Failed to read Flattrade_Creds.txt from {creds_file}: {e}")
        return creds

    async def login(self, creds: Optional[Dict[str, str]] = None) -> tuple[bool, str]:
        if self.is_logged_in():
            logger.info("[FLATTRADE] Already connected & running. Skipping login process.")
            return True, "Already logged in"

        file_creds = self.load_creds_from_file()
        if not creds:
            creds = file_creds
        else:
            for k, v in file_creds.items():
                if not creds.get(k):
                    creds[k] = v

        userid = creds.get('vendor_code') or creds.get('vendor code') or creds.get('user') or 'FZ31110'
        password = creds.get('password') or creds.get('pwd') or creds.get('pass') or 'Amma@312'
        totp_key = creds.get('totp') or creds.get('factor2') or 'PM263N53PU4765472TH7BFZHX464J745'
        vendor_code = creds.get('api_key') or creds.get('api key') or creds.get('appkey') or 'fce3c4a6bbff4458b5417d882ea59798'
        api_secret = creds.get('api_secret') or creds.get('api secret') or creds.get('vc_new') or '2026.62d759e547f045afb0de2a2679d947dfa894eb2b7324000c'
        return await do_login(userid, password, totp_key, vendor_code, api_secret)

    def is_logged_in(self) -> bool:
        return bool(getattr(app_state, 'logged_in', False) and getattr(app_state, 'api', None) is not None)

    def logout(self):
        setattr(app_state, 'logged_in', False)
        setattr(app_state, 'api', None)
        logger.info("[FLATTRADE] Session logged out / deactivated.")

    def subscribe_symbols(self, symbols: List[str]):
        return subscribe_symbols(symbols)

    def fetch_historical_metrics(self, symbol_token_map: Dict[str, Dict[str, str]], force_refresh: bool = False) -> Dict[str, Dict[str, str]]:
        api = getattr(app_state, 'api', None)
        return get_all_historical_metrics(api, symbol_token_map, force_refresh)

    def place_order(self, buy_or_sell: str, exchange: str, tradingsymbol: str, quantity: int, price_type: str, price: float, trigger_price: Optional[float] = None, product_type: Optional[str] = None) -> Any:
        return place_broker_order(buy_or_sell, exchange, tradingsymbol, quantity, price_type, price, trigger_price, product_type)

    def cancel_order(self, order_id: str) -> Any:
        return cancel_broker_order(order_id)

    def modify_order(self, order_id: str, exchange: str, tradingsymbol: str, new_quantity: int, new_price_type: str, new_price: float, trigger_price: Optional[float] = None) -> Any:
        return modify_broker_order(order_id, exchange, tradingsymbol, new_quantity, new_price_type, new_price, trigger_price)

    def get_positions(self) -> Any:
        api = getattr(app_state, 'api', None)
        if api and getattr(app_state, 'logged_in', False):
            return api.get_positions()
        return []

    def get_order_book(self) -> Any:
        api = getattr(app_state, 'api', None)
        if api and getattr(app_state, 'logged_in', False):
            return api.get_order_book()
        return []
```
\n
### File: `brokers/upstox_broker.py`
```python
import os
import sys
import time
import json
import re
import pyotp
import logging
import asyncio
import requests
import datetime
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Any, Optional
from urllib.parse import urlencode, parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from brokers.base_broker import BaseBroker

logger = logging.getLogger("WebTraderApi.Upstox")

UPSTOX_CACHE_FILE = os.path.join(os.path.dirname(__file__), "historical_cache_upstox.json")
ROOT_CACHE_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "historical_cache.json")
UPSTOX_CREDS_FILE = os.path.join(os.path.dirname(__file__), "Upstox_Creds.txt")

def round_to_nse_tick(price: float) -> float:
    if price is None:
        return 0.0
    return round(float(price) * 20.0) / 20.0

class UpstoxBroker(BaseBroker):
    def __init__(self, app_state=None):
        self.app_state = app_state
        self.access_token: Optional[str] = None
        self.user_code: Optional[str] = None
        self.api_key: Optional[str] = None
        self.api_secret: Optional[str] = None
        self.redirect_url: Optional[str] = None
        self.totp_key: Optional[str] = None
        self.pin: Optional[str] = None
        self.mobile_no: Optional[str] = None
        self._logged_in: bool = False
        self.subscribed_tokens: set = set()
        self._start_ticker_thread()

    def get_name(self) -> str:
        return "UPSTOX"

    def load_creds_from_file(self) -> Dict[str, str]:
        creds = {}
        target_files = [
            UPSTOX_CREDS_FILE,
            os.path.join(os.getcwd(), "Upstox", "Upstox_Creds.txt"),
            os.path.join(os.getcwd(), "Upstox_Creds.txt"),
            os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Upstox", "Upstox_Creds.txt"),
            os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Upstox_Creds.txt"),
            os.path.join(os.getcwd(), "Creds.txt")
        ]
        creds_file = next((f for f in target_files if os.path.exists(f)), None)
        if creds_file:
            try:
                with open(creds_file, 'r', encoding='utf-8', errors='ignore') as f:
                    for line in f:
                        if ':' in line:
                            parts = line.strip().split(':', 1)
                            key_norm = parts[0].strip().lower().replace(' ', '_')
                            creds[key_norm] = parts[1].strip()
                            # Store raw lower key as well
                            creds[parts[0].strip().lower()] = parts[1].strip()
            except Exception as e:
                logger.error(f"Failed to read creds file: {e}")
        return creds

    async def login(self, creds: Optional[Dict[str, str]] = None) -> tuple[bool, str]:
        if self.is_logged_in():
            logger.info("[UPSTOX] Already connected & running. Skipping login process.")
            return True, "Already logged in"

        if not creds:
            creds = self.load_creds_from_file()

        self.user_code = creds.get('user_code') or creds.get('user') or '2DCYAV'
        self.mobile_no = creds.get('mobile') or creds.get('mobile_no') or creds.get('phone') or creds.get('mobile_num') or '8555947993'
        self.api_key = creds.get('api_key') or creds.get('apikey') or '445bbbd2-d56b-48c3-bbec-120bf6a1d8e1'
        self.api_secret = creds.get('api_secret') or creds.get('apisecret') or 'yzqz28t8xq'
        self.totp_key = creds.get('totp') or '3M6HOZO4U2TWVTLC6NHNS5CKTG3YSUZM'
        self.redirect_url = creds.get('redirect_url') or creds.get('redirecturl') or 'http://localhost:8095/upstox/callback'
        self.pin = creds.get('pin') or '258247'

        logger.info(f"[UPSTOX] Initiating login for User: {self.user_code}, API Key: {self.api_key}")

        # Check if pre-authorized token is available
        if creds.get('access_token'):
            token_date = creds.get('token_date') or creds.get('token date')
            today_str = datetime.date.today().isoformat()
            
            if token_date == today_str:
                self.access_token = creds.get('access_token')
                self._logged_in = True
                logger.info("[UPSTOX] Saved token date matches today. Reusing token without OAuth.")
                return True, f"Upstox Login Success (Token loaded from today's session)"
            else:
                logger.info(f"[UPSTOX] Saved token date ({token_date}) does not match today ({today_str}). Requiring fresh daily login.")
                self.remove_access_token_from_creds()
                self.access_token = None

        # Upstox auth dialog URL
        auth_url = f"https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id={self.api_key}&redirect_uri={self.redirect_url}"
        logger.info(f"[UPSTOX] Missing Access Token. Launching background automated browser login: {auth_url}")
        
        self._logged_in = False
        self.auto_login_selenium(auth_url)
        return False, f"AUTH_REQUIRED:{auth_url}"

    def is_logged_in(self) -> bool:
        return bool(self._logged_in and self.access_token)

    def auto_login_selenium(self, auth_url: str):
        def _run():
            mobile = getattr(self, 'mobile_no', None)
            pin = getattr(self, 'pin', None)
            totp_key = getattr(self, 'totp_key', None)

            if not mobile:
                logger.warning("[UPSTOX SELENIUM] Mobile number missing from Upstox_Creds.txt")
                return

            driver = None
            try:
                from selenium import webdriver
                from selenium.webdriver.common.by import By
                from selenium.webdriver.support.ui import WebDriverWait
                from selenium.webdriver.support import expected_conditions as EC

                options = webdriver.ChromeOptions()
                options.add_argument("--window-size=1440,960")
                options.add_argument("--disable-gpu")
                options.add_argument("--no-sandbox")
                options.add_argument("--disable-dev-shm-usage")
                options.page_load_strategy = 'eager'

                logger.info(f"[UPSTOX SELENIUM] Automated background browser opening: {auth_url}")
                driver = webdriver.Chrome(options=options)
                wait = WebDriverWait(driver, 15)

                from selenium.webdriver.common.keys import Keys

                driver.get(auth_url)
                time.sleep(2)

                # 1. Fill Mobile Number
                try:
                    mob_input = wait.until(EC.element_to_be_clickable((By.ID, "mobileNum")))
                    mob_input.clear()
                    mob_input.send_keys(mobile)
                    time.sleep(0.5)
                    mob_input.send_keys(Keys.ENTER)
                    logger.info("[UPSTOX SELENIUM] Submitted Mobile Number. Waiting for TOTP step...")
                except Exception as e:
                    logger.warning(f"[UPSTOX SELENIUM] Mobile step info: {e}")

                # 2. Fill TOTP
                if totp_key:
                    try:
                        totp_val = pyotp.TOTP(str(totp_key).replace(" ", "")).now()
                        logger.info(f"[UPSTOX SELENIUM] Generated TOTP code: {totp_val}")

                        otp_input = wait.until(EC.presence_of_element_located((By.ID, "otpNum")))
                        time.sleep(0.5)
                        otp_input.clear()
                        otp_input.send_keys(totp_val)
                        time.sleep(0.5)
                        otp_input.send_keys(Keys.ENTER)
                        logger.info("[UPSTOX SELENIUM] Submitted TOTP. Waiting for PIN step...")
                    except Exception as e:
                        logger.warning(f"[UPSTOX SELENIUM] TOTP step info: {e}")

                # 3. Fill PIN if prompted
                if pin:
                    try:
                        time.sleep(1.5)
                        pin_inputs = [x for x in driver.find_elements(By.TAG_NAME, "input") if x.is_displayed()]
                        if pin_inputs:
                            pin_inputs[0].send_keys(pin)
                            time.sleep(0.5)
                            pin_inputs[0].send_keys(Keys.ENTER)
                            logger.info("[UPSTOX SELENIUM] Submitted PIN. Waiting for callback navigation...")
                            
                            # Wait for browser to reach callback URL (up to 15 seconds)
                            for _ in range(15):
                                cur_url = driver.current_url
                                if "upstox/callback" in cur_url or "8095" in cur_url:
                                    logger.info(f"[UPSTOX SELENIUM] Successfully reached callback URL: {cur_url}")
                                    time.sleep(2)
                                    break
                                time.sleep(1)
                    except Exception as e:
                        logger.warning(f"[UPSTOX SELENIUM] PIN step info: {e}")

            except Exception as e:
                logger.error(f"[UPSTOX SELENIUM] Error during automated login: {e}")
            finally:
                if driver:
                    try:
                        driver.quit()
                    except Exception:
                        pass

        threading.Thread(target=_run, daemon=True).start()

    def save_access_token(self, token: str):
        self.access_token = token
        self._logged_in = True
        today_str = datetime.date.today().isoformat()
        
        target_files = [
            UPSTOX_CREDS_FILE,
            os.path.join(os.getcwd(), "Upstox_Creds.txt"),
            os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Upstox_Creds.txt")
        ]
        creds_file = next((f for f in target_files if os.path.exists(f)), None)
        if creds_file:
            try:
                lines = []
                with open(creds_file, 'r') as f:
                    for l in f:
                        if "access_token" not in l.lower() and "token_date" not in l.lower():
                            lines.append(l)
                lines.append(f"Access_Token\t:\t{token}\n")
                lines.append(f"Token_Date\t:\t{today_str}\n")
                with open(creds_file, 'w') as f:
                    f.writelines(lines)
                logger.info(f"[UPSTOX] Saved fresh access token ({today_str}) to {creds_file}")
            except Exception as e:
                logger.error(f"[UPSTOX] Failed to save access token to file: {e}")

    def remove_access_token_from_creds(self):
        upstox_creds_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Upstox_Creds.txt")
        if os.path.exists(upstox_creds_path):
            try:
                with open(upstox_creds_path, 'r') as f:
                    lines = f.readlines()
                with open(upstox_creds_path, 'w') as f:
                    for line in lines:
                        if "Access_Token" not in line and "access_token" not in line.lower() and "Token_Date" not in line and "token_date" not in line.lower():
                            f.write(line)
                logger.info("[UPSTOX] Removed Access_Token from Upstox_Creds.txt")
            except Exception as e:
                logger.error(f"[UPSTOX] Failed to clean credentials file: {e}")

    def logout(self):
        self._logged_in = False
        self.access_token = None
        self._ticker_running = False
        self.v3_streamer = None
        if hasattr(self, 'subscribed_v3_keys'):
            self.subscribed_v3_keys = set()
        logger.info("[UPSTOX] Session deactivated.")
        self.remove_access_token_from_creds()

    def _start_ticker_thread(self):
        if not self._logged_in:
            return
        if getattr(self, '_ticker_running', False) and getattr(self, '_thread_inst', None) and self._thread_inst.is_alive():
            return
        self._ticker_running = True
        self._thread_inst = threading.Thread(target=self._ticker_loop, daemon=True)
        self._thread_inst.start()

    def _fetch_single_quote(self, sym: str, headers: dict):
        sym_clean = sym.split('|')[-1] if '|' in sym else sym
        if 'NSETEST' in sym_clean.upper(): return
        
        INDEX_YAHOO_MAP = {
            '26000': '^NSEI', 'NIFTY': '^NSEI', 'NSE|26000': '^NSEI', 'NSE|NIFTY': '^NSEI',
            '26009': '^NSEBANK', 'BANKNIFTY': '^NSEBANK', 'NSE|26009': '^NSEBANK', 'NSE|BANKNIFTY': '^NSEBANK',
            '1': '^BSESN', 'SENSEX': '^BSESN', 'BSE|1': '^BSESN', 'BSE|SENSEX': '^BSESN',
            '12': '^BSEBK', 'BANKEX': '^BSEBK', 'BSE|12': '^BSEBK', 'BSE|BANKEX': '^BSEBK',
            '26017': '^INDIAVIX', 'INDIAVIX': '^INDIAVIX', 'INDIA VIX': '^INDIAVIX', 'NSE|26017': '^INDIAVIX'
        }

        try:
            # Check if index symbol
            sym_upper = sym.upper()
            sym_clean_upper = sym_clean.upper()
            is_index = False
            
            if sym_upper in INDEX_YAHOO_MAP or sym_clean_upper in INDEX_YAHOO_MAP:
                ticker = INDEX_YAHOO_MAP.get(sym_upper) or INDEX_YAHOO_MAP.get(sym_clean_upper)
                is_index = True
                is_option = False
                is_futures = False
            else:
                # Check if it's an Option symbol (e.g. TVSMOTOR28JUL26C3800 or PNB28JUL26C112)
                opt_pattern = r"^([A-Z0-9\-_]+?)(\d{1,2}[A-Z]{3}\d{2}|\d{2}[A-Z]{3})([CP])(\d+(?:\.\d+)?)$"
                opt_match = re.match(opt_pattern, sym_clean_upper)
                
                # Check if it's a Futures symbol (e.g. BAJAJ-AUTO28JUL26F or BAJAJAUTO26JULFUT)
                fut_pattern = r"^([A-Z0-9\-_]+?)(\d{1,2}[A-Z]{3}\d{2}|\d{2}[A-Z]{3})(?:F|FUT)$"
                fut_match = re.match(fut_pattern, sym_clean_upper)
                
                underlying = sym_clean
                is_option = False
                is_futures = False
                opt_type = None
                strike = 0.0
                
                if opt_match:
                    underlying = opt_match.group(1)
                    is_option = True
                    opt_type = "CE" if opt_match.group(3) == "C" else "PE"
                    strike = float(opt_match.group(4))
                elif fut_match:
                    underlying = fut_match.group(1)
                    is_futures = True
                    
                ticker = f"{underlying}.NS"

            spot_price = None
            prev_close = None
            high = None
            low = None
            meta = {}

            session = getattr(self, '_http_session', None)
            if not session:
                session = requests.Session()
                adapter = requests.adapters.HTTPAdapter(pool_connections=50, pool_maxsize=50)
                session.mount('https://', adapter)
                self._http_session = session

            # For options and futures, derive directly from cached spot price to eliminate redundant HTTP overhead
            if is_futures or is_option:
                spot_record = {}
                if self.app_state and hasattr(self.app_state, 'live_data'):
                    spot_record = self.app_state.live_data.get(f"NSE|{underlying}") or self.app_state.live_data.get(underlying.upper()) or {}
                if spot_record and spot_record.get('lp'):
                    spot_price = spot_record.get('lp')
                    prev_close = spot_record.get('c') or spot_price
                    high = spot_record.get('h') or spot_price
                    low = spot_record.get('l') or spot_price
                    meta = {'regularMarketVolume': spot_record.get('v', 0)}

            if spot_price is None:
                for domain in ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]:
                    try:
                        url = f"https://{domain}/v8/finance/chart/{ticker}?range=1d&interval=1m"
                        r = session.get(url, headers=headers, timeout=3)
                        if r.status_code == 200:
                            data = r.json()
                            meta = data.get('chart', {}).get('result', [{}])[0].get('meta', {})
                            spot_price = meta.get('regularMarketPrice')
                            prev_close = meta.get('chartPreviousClose') or meta.get('previousClose')
                            high = meta.get('regularMarketDayHigh')
                            low = meta.get('regularMarketDayLow')
                            if spot_price is not None:
                                break
                    except Exception:
                        continue

            if spot_price is not None:
                    if is_index:
                        price = round_to_nse_tick(spot_price)
                        prev_c = round_to_nse_tick(prev_close or spot_price)
                        h_val = round_to_nse_tick(high if high is not None else spot_price)
                        l_val = round_to_nse_tick(low if low is not None else spot_price)
                    elif is_option:
                        if opt_type == "CE":
                            intrinsic = max(0.50, spot_price - strike)
                        else:
                            intrinsic = max(0.50, strike - spot_price)
                        time_val = max(1.0, spot_price * 0.015)
                        price = round_to_nse_tick(intrinsic + time_val)
                        prev_c = round_to_nse_tick(max(0.50, price * 0.98))
                        h_val = round_to_nse_tick(price * 1.03)
                        l_val = round_to_nse_tick(max(0.10, price * 0.95))
                    elif is_futures:
                        price = round_to_nse_tick(spot_price * 1.002)
                        prev_c = round_to_nse_tick((prev_close or spot_price) * 1.002)
                        h_val = round_to_nse_tick((high or spot_price) * 1.002)
                        l_val = round_to_nse_tick((low or spot_price) * 1.002)
                    else:
                        price = round_to_nse_tick(spot_price)
                        prev_c = round_to_nse_tick(prev_close or spot_price)
                        h_val = round_to_nse_tick(high if high is not None else spot_price)
                        l_val = round_to_nse_tick(low if low is not None else spot_price)

                    chg = price - prev_c
                    chg_pc = (chg / prev_c * 100) if prev_c else 0.0
                    
                    # Compute OI metrics: check existing real live_data first
                    oi_val = 0
                    poi_val = 0
                    if not self.app_state:
                        try:
                            from main import app_state
                            self.app_state = app_state
                        except Exception:
                            pass

                    if self.app_state and hasattr(self.app_state, 'live_data'):
                        for k_test in [sym, sym_upper, sym_clean, f"NSE|{sym_clean}", f"NFO|{sym_clean}"]:
                            rec = self.app_state.live_data.get(k_test, {})
                            if rec.get("oi") and rec.get("oi") > 0:
                                oi_val = rec["oi"]
                            if rec.get("poi") and rec.get("poi") > 0:
                                poi_val = rec["poi"]

                    if oi_val == 0:
                        vol = meta.get('regularMarketVolume', 0)
                        oi_val = 0
                        poi_val = 0

                    quote = {
                        "lp": float(price),
                        "bp1": round(float(price - 0.05), 2),
                        "sp1": round(float(price + 0.05), 2),
                        "h": float(h_val),
                        "l": float(l_val),
                        "o": float(prev_c),
                        "c": float(prev_c),
                        "pc": float(round(chg_pc, 2)),
                        "v": meta.get('regularMarketVolume', 0)
                    }
                    if oi_val > 0:
                        quote["oi"] = oi_val
                    if poi_val > 0:
                        quote["poi"] = poi_val
                    
                    keys = [sym, sym_upper, sym_clean, f"NSE|{sym_clean}", f"NFO|{sym_clean}"]
                    if self.app_state and hasattr(self.app_state, 'symbol_to_token'):
                        tok = self.app_state.symbol_to_token.get(('NSE', sym_clean_upper)) or self.app_state.symbol_to_token.get(('NFO', sym_clean_upper))
                        if tok:
                            keys.extend([f"NSE|{tok}", f"NFO|{tok}", str(tok)])

                    if self.app_state and hasattr(self.app_state, 'live_data'):
                        for k in set(keys):
                            if k not in self.app_state.live_data:
                                self.app_state.live_data[k] = {}
                            self.app_state.live_data[k].update(quote)
                            
                            if hasattr(self.app_state, 'pending_updates_lock') and hasattr(self.app_state, 'pending_updates'):
                                 with self.app_state.pending_updates_lock:
                                     self.app_state.pending_updates[k] = {"key": k, **self.app_state.live_data[k]}

                        # Synchronize associated futures keys for OI and futures price tracking
                        if hasattr(self.app_state, 'futures_data') and self.app_state.futures_data:
                            target_sym = sym_clean_upper.replace('NSE|', '').replace('NFO|', '')
                            for f in self.app_state.futures_data:
                                f_sym = str(f.get('symbol', '')).upper()
                                if f_sym == target_sym or f_sym == sym_clean_upper:
                                    fut_tsym = str(f.get('tradingsymbol', ''))
                                    fut_exch = str(f.get('exchange', 'NFO'))
                                    fut_key = f"{fut_exch}|{fut_tsym}"
                                    
                                    # Use real futures data if already in live_data
                                    existing_fut = self.app_state.live_data.get(fut_key, {})
                                    fut_price = existing_fut.get('lp')
                                    fut_prev = existing_fut.get('c') or existing_fut.get('o')
                                    
                                    fut_quote = {}
                                    if fut_price is not None and fut_price > 0:
                                        fut_quote["lp"] = float(fut_price)
                                        fut_quote["bp1"] = round(float(fut_price - 0.05), 2)
                                        fut_quote["sp1"] = round(float(fut_price + 0.05), 2)
                                        if fut_prev and fut_prev > 0:
                                            fut_chg = fut_price - fut_prev
                                            fut_quote["pc"] = float(round((fut_chg / fut_prev * 100), 2))
                                            fut_quote["o"] = float(fut_prev)
                                            fut_quote["c"] = float(fut_prev)
                                    if existing_fut.get('h'): fut_quote['h'] = float(existing_fut['h'])
                                    if existing_fut.get('l'): fut_quote['l'] = float(existing_fut['l'])
                                    if existing_fut.get('v'): fut_quote['v'] = existing_fut['v']
                                    if existing_fut.get('oi'): fut_quote['oi'] = existing_fut['oi']
                                    if existing_fut.get('poi'): fut_quote['poi'] = existing_fut['poi']

                                    for fk in [fut_key, fut_tsym]:
                                        if fk not in self.app_state.live_data:
                                            self.app_state.live_data[fk] = {}
                                        self.app_state.live_data[fk].update(fut_quote)
                                        if hasattr(self.app_state, 'pending_updates_lock') and hasattr(self.app_state, 'pending_updates'):
                                            with self.app_state.pending_updates_lock:
                                                self.app_state.pending_updates[fk] = {"key": fk, **self.app_state.live_data[fk]}
        except Exception:
            pass

    def _load_upstox_instrument_map(self):
        if hasattr(self, 'upstox_key_map') and self.upstox_key_map:
            return
        self.upstox_key_map = {}
        self.upstox_tsym_map = {}
        cache_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Instrument", "upstox_instruments.csv")
        if os.path.exists(cache_file):
            try:
                import pandas as pd
                df = pd.read_csv(cache_file, low_memory=False)
                for _, row in df.iterrows():
                    tsym = str(row['tradingsymbol']).upper()
                    ikey = str(row['instrument_key'])
                    self.upstox_key_map[tsym] = ikey
                    self.upstox_tsym_map[ikey] = tsym
                    if tsym.endswith('FUT'):
                        alt_f = tsym[:-3] + 'F'
                        self.upstox_key_map[alt_f] = ikey
                logger.info(f"[UPSTOX] Loaded {len(self.upstox_key_map)} official instrument keys from upstox_instruments.csv")
            except Exception as e:
                logger.warning(f"[UPSTOX] Failed loading upstox_instruments.csv: {e}")

    def shoonya_to_upstox_key(self, token: str) -> Optional[str]:
        self._load_upstox_instrument_map()
        s = token.split('|')[-1].upper().strip()
        if not s: return None
        
        # Direct lookup
        if s in self.upstox_key_map:
            return self.upstox_key_map[s]
            
        import re
        # Futures: 360ONE28JUL26F -> 360ONE26JULFUT
        if s.endswith('F') or s.endswith('FUT'):
            raw = s[:-1] if s.endswith('F') else s[:-3]
            m = re.match(r'^(.*?)(0[1-9]|[12][0-9]|3[01])([A-Z]{3})([0-9]{2})$', raw)
            if m:
                sym, day, month, year = m.groups()
                sym_clean = sym.replace('-', '')
                cand1 = f"{sym_clean}{year}{month}FUT"
                cand2 = f"{sym}{year}{month}FUT"
                ikey = self.upstox_key_map.get(cand1) or self.upstox_key_map.get(cand2)
                if ikey: return ikey

        # Options: TVSMOTOR28JUL26C3800 -> TVSMOTOR26JUL3800CE
        m_opt = re.match(r'^(.*?)(0[1-9]|[12][0-9]|3[01])([A-Z]{3})([0-9]{2})([CP])([0-9.]+)$', s)
        if m_opt:
            sym, day, month, year, opt_type_char, strike = m_opt.groups()
            opt_type = 'CE' if opt_type_char == 'C' else 'PE'
            try:
                strike_val = float(strike)
                strike_str = str(int(strike_val)) if strike_val.is_integer() else str(strike_val)
            except Exception:
                strike_str = strike
            sym_clean = sym.replace('-', '')
            cand1 = f"{sym_clean}{year}{month}{strike_str}{opt_type}"
            cand2 = f"{sym}{year}{month}{strike_str}{opt_type}"
            ikey = self.upstox_key_map.get(cand1) or self.upstox_key_map.get(cand2)
            if ikey: return ikey

        return None

    def _fetch_upstox_api_quotes(self, tokens_list: list) -> bool:
        if not self.access_token:
            return False
            
        try:
            instrument_keys = []
            key_to_req_token = {}
            for t in tokens_list:
                t_clean = t.split('|')[-1] if '|' in t else t
                if 'NSETEST' in t_clean.upper(): continue
                
                ikey = self.shoonya_to_upstox_key(t_clean)
                if ikey:
                    instrument_keys.append(ikey)
                    key_to_req_token[ikey] = t_clean
                    key_to_req_token[ikey.replace('|', ':')] = t_clean
                else:
                    if t.startswith("NFO|") or "FUT" in t_clean.upper() or "CE" in t_clean.upper() or "PE" in t_clean.upper():
                        instrument_keys.append(f"NSE_FO|{t_clean}")
                    else:
                        instrument_keys.append(f"NSE_EQ|{t_clean}")
                    
            if not instrument_keys:
                return False

            chunk_size = 50
            headers = {
                'Authorization': f'Bearer {self.access_token}',
                'Accept': 'application/json'
            }
            
            session = getattr(self, '_http_session', None)
            if not session:
                session = requests.Session()
                self._http_session = session

            import urllib.parse
            fetched_any = False
            for i in range(0, len(instrument_keys), chunk_size):
                chunk = instrument_keys[i:i+chunk_size]
                encoded_chunk = [urllib.parse.quote(k) for k in chunk]
                keys_str = ",".join(encoded_chunk)
                url = f"https://api.upstox.com/v2/market-quote/quotes?instrument_key={keys_str}"
                
                r = session.get(url, headers=headers, timeout=4)
                if r.status_code == 200:
                    res_data = r.json().get('data', {})
                    if res_data:
                        fetched_any = True
                    for key_name, qdata in res_data.items():
                        lp = qdata.get('last_price', 0.0)
                        ohlc = qdata.get('ohlc', {})
                        o = ohlc.get('open', lp)
                        h = ohlc.get('high', lp)
                        l = ohlc.get('low', lp)
                        c = ohlc.get('close', lp)
                        vol = qdata.get('volume', 0)
                        oi = qdata.get('open_interest', 0)
                        chg = qdata.get('net_change', 0.0)
                        pc = (chg / c * 100) if c else 0.0
                        
                        key_clean = key_name.replace(':', '|')
                        sym_raw = key_name.split(':')[-1] if ':' in key_name else key_name
                        mapped_req = key_to_req_token.get(key_name) or key_to_req_token.get(key_clean) or ""
                        mapped_tsym = self.upstox_tsym_map.get(key_name) or self.upstox_tsym_map.get(key_clean) or sym_raw
                        
                        quote = {
                            "lp": float(lp), "bp1": round(float(lp - 0.05), 2), "sp1": round(float(lp + 0.05), 2),
                            "h": float(h), "l": float(l), "o": float(o), "c": float(c), "pc": float(round(pc, 2)),
                            "v": vol
                        }
                        if oi > 0:
                            quote["oi"] = oi

                        keys = [key_name, key_clean, sym_raw, mapped_req, mapped_tsym, f"NSE|{sym_raw}", f"NFO|{sym_raw}", f"NSE|{mapped_tsym}", f"NFO|{mapped_tsym}"]
                        if mapped_req:
                            keys.extend([mapped_req, f"NSE|{mapped_req}", f"NFO|{mapped_req}"])
                            if mapped_req.endswith("F"):
                                alt = mapped_req[:-1] + "FUT"
                                keys.extend([alt, f"NFO|{alt}", f"NSE|{alt}"])
                            elif mapped_req.endswith("FUT"):
                                alt = mapped_req[:-3] + "F"
                                keys.extend([alt, f"NFO|{alt}", f"NSE|{alt}"])
                        if mapped_tsym.endswith("FUT"):
                            alt_f = mapped_tsym[:-3] + "F"
                            keys.extend([alt_f, f"NSE|{alt_f}", f"NFO|{alt_f}"])
                        elif mapped_tsym.endswith("F"):
                            alt_fut = mapped_tsym[:-1] + "FUT"
                            keys.extend([alt_fut, f"NSE|{alt_fut}", f"NFO|{alt_fut}"])

                        if self.app_state and hasattr(self.app_state, 'live_data'):
                            for k in set(keys):
                                if k not in self.app_state.live_data:
                                    self.app_state.live_data[k] = {}
                                self.app_state.live_data[k].update(quote)
                                with self.app_state.pending_updates_lock:
                                    self.app_state.pending_updates[k] = {"key": k, **self.app_state.live_data[k]}
            return fetched_any
        except Exception as e:
            logger.debug(f"[UPSTOX API QUOTES ERROR] {e}")
            return False

    def _ticker_loop(self):
        try:
            print("\n" + "="*60 + "\n  >> [UPSTOX TICKER] Multi-threaded fast tick engine started (25 workers)\n" + "="*60 + "\n")
        except Exception:
            pass
        logger.info("[UPSTOX TICKER] Multi-threaded fast tick engine started (25 workers).")
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
        from concurrent.futures import ThreadPoolExecutor
        
        while getattr(self, '_ticker_running', False):
            try:
                if not self.app_state:
                    try:
                        from main import app_state
                        self.app_state = app_state
                    except Exception:
                        pass

                # Only poll active UI subscribed tokens via REST to avoid rate limits (120 req/min)
                tokens_list = list(self.subscribed_tokens)
                
                # If empty, add default major indices so the screen has active connections
                if not tokens_list:
                    tokens_list = ["NSE|NIFTY", "NSE|BANKNIFTY", "NSE|FINNIFTY"]

                if tokens_list:
                    api_success = False
                    if self.access_token:
                        api_success = self._fetch_upstox_api_quotes(tokens_list)

                    if not api_success:
                        with ThreadPoolExecutor(max_workers=10) as executor:
                            futures = [executor.submit(self._fetch_single_quote, sym, headers) for sym in tokens_list]
                            for f in futures:
                                try:
                                    f.result()
                                except Exception:
                                    pass
                time.sleep(1.0)
            except Exception as e:
                logger.error(f"[UPSTOX TICKER ERROR] {e}")
                time.sleep(1)

    def subscribe_symbols(self, symbols: List[str]):
        self.subscribed_tokens.update(symbols)

        # Link global app_state if not already attached
        if not self.app_state:
            try:
                from main import app_state
                self.app_state = app_state
            except Exception:
                pass

        # Auto-subscribe associated futures symbols for all spot symbols
        if self.app_state and hasattr(self.app_state, 'futures_data') and self.app_state.futures_data:
            for sym in list(symbols):
                sym_clean = sym.split('|')[-1].upper()
                for f in self.app_state.futures_data:
                    if str(f.get('symbol', '')).upper() == sym_clean:
                        fut_tsym = str(f.get('tradingsymbol', ''))
                        fut_exch = str(f.get('exchange', 'NFO'))
                        alt_tsym = fut_tsym[:-1] + 'FUT' if fut_tsym.endswith('F') else (fut_tsym[:-3] + 'F' if fut_tsym.endswith('FUT') else fut_tsym)
                        self.subscribed_tokens.update([
                            f"{fut_exch}|{fut_tsym}",
                            f"{fut_exch}|{alt_tsym}",
                            fut_tsym,
                            alt_tsym
                        ])

        logger.info(f"[UPSTOX] Subscribed to {len(symbols)} symbols. Total: {len(self.subscribed_tokens)}")
        self._start_ticker_thread()
        self._start_upstox_v3_streamer(symbols)

    def _start_upstox_v3_streamer(self, symbols=None):
        if not self.access_token:
            return
        if symbols is None:
            symbols = list(self.subscribed_tokens)

        try:
            import upstox_client
            if not hasattr(upstox_client, 'MarketDataStreamerV3'):
                return

            # Link global app_state
            if not self.app_state:
                try:
                    from main import app_state
                    self.app_state = app_state
                except Exception:
                    pass

            # Collect all futures and active tokens
            all_tokens = set(self.subscribed_tokens)
            if self.app_state and hasattr(self.app_state, 'futures_data') and self.app_state.futures_data:
                for f in self.app_state.futures_data:
                    all_tokens.add(f.get('tradingsymbol', ''))

            # Convert to Upstox instrument keys
            upstox_keys = set()
            if not hasattr(self, 'v3_key_to_req'): self.v3_key_to_req = {}
            
            for t in all_tokens:
                if not t: continue
                ikey = self.shoonya_to_upstox_key(t)
                if ikey:
                    upstox_keys.add(ikey)
                    self.v3_key_to_req[ikey] = t
                    self.v3_key_to_req[ikey.replace('|', ':')] = t

            if not upstox_keys:
                return

            if not hasattr(self, 'subscribed_v3_keys'):
                self.subscribed_v3_keys = set()

            # Dynamic subscription if streamer is already connected
            if getattr(self, 'v3_streamer', None) is not None:
                new_keys = upstox_keys - self.subscribed_v3_keys
                if new_keys:
                    logger.info(f"[UPSTOX V3 STREAMER] Dynamically subscribing to {len(new_keys)} new instrument keys...")
                    try:
                        self.v3_streamer.subscribe(list(new_keys), "full")
                        self.subscribed_v3_keys.update(new_keys)
                    except Exception as ex:
                        logger.warning(f"[UPSTOX V3 STREAMER ERROR] Could not subscribe: {ex}. Resetting streamer.")
                        self.v3_streamer = None
                        self.subscribed_v3_keys = set()
                return

            self.subscribed_v3_keys.update(upstox_keys)
            logger.info(f"[UPSTOX V3 STREAMER] Initializing MarketDataStreamerV3 with {len(upstox_keys)} instrument keys...")

            configuration = upstox_client.Configuration()
            configuration.access_token = self.access_token

            def on_upstox_message(message):
                try:
                    data = message if isinstance(message, dict) else json.loads(message)
                    feeds = data.get("feeds", {})
                    for key_name, feed in feeds.items():
                        mff = feed.get("marketFF", {})
                        ltpc = feed.get("ltpc") or mff.get("ltpc", {})
                        
                        lp = None
                        cp = None
                        volume = None
                        oi = None
                        open_px = None
                        high_px = None
                        low_px = None
                        
                        if ltpc:
                            lp = float(ltpc.get("ltp", 0.0))
                            cp = float(ltpc.get("cp", lp))
                            
                        ohlc_obj = feed.get("marketOHLC") or mff.get("marketOHLC", {})
                        if ohlc_obj:
                            ohlc_list = ohlc_obj.get("ohlc", [])
                            if ohlc_list:
                                day_bar = ohlc_list[0]
                                open_px = float(day_bar.get("open", 0.0))
                                high_px = float(day_bar.get("high", 0.0))
                                low_px = float(day_bar.get("low", 0.0))
                                volume = float(day_bar.get("volume", 0.0))
                                
                        oi_obj = feed.get("marketOI") or mff.get("marketOI", {})
                        if oi_obj:
                            oi = float(oi_obj.get("oi", 0.0))

                        quote = {}
                        if lp is not None:
                            quote["lp"] = lp
                        if cp is not None:
                            quote["c"] = cp
                        if open_px is not None and open_px > 0:
                            quote["o"] = open_px
                        if high_px is not None and high_px > 0:
                            quote["h"] = high_px
                        if low_px is not None and low_px > 0:
                            quote["l"] = low_px
                        if volume is not None and volume > 0:
                            quote["v"] = volume
                        if oi is not None and oi > 0:
                            quote["oi"] = oi

                        if lp is not None and cp is not None:
                            chg = lp - cp
                            pc = (chg / cp * 100.0) if cp > 0 else 0.0
                            quote["pc"] = float(round(pc, 2))
                        
                        if not quote:
                            continue

                        key_clean = key_name.replace(':', '|')
                        sym_raw = key_name.split(':')[-1] if ':' in key_name else key_name
                        mapped_req = self.v3_key_to_req.get(key_name) or self.v3_key_to_req.get(key_clean) or ""
                        mapped_tsym = self.upstox_tsym_map.get(key_name) or self.upstox_tsym_map.get(key_clean) or sym_raw

                        keys = [key_name, key_clean, sym_raw, mapped_req, mapped_tsym, f"NSE|{sym_raw}", f"NFO|{sym_raw}", f"NSE|{mapped_req}", f"NFO|{mapped_req}"]
                        if mapped_req:
                            keys.extend([mapped_req, f"NSE|{mapped_req}", f"NFO|{mapped_req}"])
                            if mapped_req.endswith("F"):
                                alt = mapped_req[:-1] + "FUT"
                                keys.extend([alt, f"NFO|{alt}", f"NSE|{alt}"])
                            elif mapped_req.endswith("FUT"):
                                alt = mapped_req[:-3] + "F"
                                keys.extend([alt, f"NFO|{alt}", f"NSE|{alt}"])

                        if self.app_state and hasattr(self.app_state, 'live_data'):
                            for k in set(keys):
                                if k:
                                    if k not in self.app_state.live_data:
                                        self.app_state.live_data[k] = {}
                                    self.app_state.live_data[k].update(quote)
                                    if hasattr(self.app_state, 'pending_updates_lock') and hasattr(self.app_state, 'pending_updates'):
                                        with self.app_state.pending_updates_lock:
                                            self.app_state.pending_updates[k] = {"key": k, **self.app_state.live_data[k]}
                except Exception as ex:
                    logger.debug(f"[UPSTOX V3 MSG ERROR] {ex}")

            def on_upstox_error(err):
                logger.error(f"[UPSTOX V3 STREAMER ERROR] {err}")
                self.v3_streamer = None
                if hasattr(self, 'subscribed_v3_keys'):
                    self.subscribed_v3_keys = set()
                if "401" in str(err) or "unauthorized" in str(err).lower():
                    logger.error("[UPSTOX] Access token has expired or is invalid. Resetting Upstox session.")
                    self.logout()

            def on_upstox_close(code=None, reason=None):
                logger.info(f"[UPSTOX V3 STREAMER CLOSED] Code: {code}, Reason: {reason}")
                self.v3_streamer = None
                if hasattr(self, 'subscribed_v3_keys'):
                    self.subscribed_v3_keys = set()

            self.v3_streamer = upstox_client.MarketDataStreamerV3(
                upstox_client.ApiClient(configuration),
                list(upstox_keys),
                "full"
            )
            self.v3_streamer.on("message", on_upstox_message)
            self.v3_streamer.on("error", on_upstox_error)
            self.v3_streamer.on("close", on_upstox_close)
            
            import threading
            t = threading.Thread(target=self.v3_streamer.connect, daemon=True)
            t.start()
            logger.info("[UPSTOX V3 STREAMER] Connecting to Real-time MarketDataStreamerV3...")
        except Exception as e:
            logger.warning(f"[UPSTOX V3 STREAMER ERROR] Could not start V3 Streamer: {e}")
                
        if self.app_state and hasattr(self.app_state, 'live_data'):
            for sym in symbols:
                keys = [sym, sym.upper(), sym.replace(':', '|').replace(' ', '|').upper()]
                if '|' in sym:
                    keys.append(sym.split('|')[-1])
                    
                # Find existing price & OI data in live_data or initialize
                existing_data = None
                for k in keys:
                    if k in self.app_state.live_data and self.app_state.live_data[k]:
                        existing_data = self.app_state.live_data[k]
                        break
                        
                if not existing_data:
                    existing_data = {
                        "lp": 0.0, "bp1": 0.0, "sp1": 0.0, "h": 0.0, "l": 0.0, 
                        "o": 0.0, "c": 0.0, "pc": 0.0
                    }
                    
                for k in keys:
                    if k not in self.app_state.live_data or not self.app_state.live_data[k]:
                        self.app_state.live_data[k] = dict(existing_data)
                    else:
                        for fd, val in existing_data.items():
                            self.app_state.live_data[k].setdefault(fd, val)

    def fetch_historical_metrics(self, symbol_token_map: Dict[str, Dict[str, str]], force_refresh: bool = False) -> Dict[str, Dict[str, str]]:
        if not force_refresh:
            today_str = datetime.date.today().isoformat()
            if os.path.exists(UPSTOX_CACHE_FILE):
                try:
                    with open(UPSTOX_CACHE_FILE, 'r') as f:
                        data = json.load(f)
                        if data.get("date") == today_str and "metrics" in data and len(data["metrics"]) >= len(symbol_token_map) * 0.8:
                            logger.info(f"[UPSTOX] Loaded {len(data['metrics'])} historical metrics from Upstox cache")
                            return data["metrics"]
                except Exception as e:
                    logger.warning(f"[UPSTOX] Failed to load Upstox cache: {e}")
            if os.path.exists(ROOT_CACHE_FILE):
                try:
                    with open(ROOT_CACHE_FILE, 'r') as f:
                        data = json.load(f)
                        if data.get("date") == today_str and "metrics" in data and len(data["metrics"]) > 0:
                            logger.info(f"[UPSTOX] Loaded {len(data['metrics'])} historical metrics from root cache")
                            return data["metrics"]
                except Exception as e:
                    logger.warning(f"[UPSTOX] Failed to load root cache: {e}")

        logger.info(f"[UPSTOX] Fetching historical metrics for {len(symbol_token_map)} symbols...")
        results = {}

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }

        def fetch_symbol_upstox(item):
            sym, info = item
            if 'NSETEST' in sym.upper():
                return sym, None
            
            upstox_success = False
            # 1. Try Upstox REST historical API first
            try:
                ikey = self.upstox_key_map.get(sym.upper())
                if not ikey:
                    ikey = f"NSE_EQ|{sym.upper()}"
                
                import urllib.parse
                safe_ikey = urllib.parse.quote(ikey)
                
                today_str = datetime.date.today().isoformat()
                month_ago_str = (datetime.date.today() - datetime.timedelta(days=35)).isoformat()
                
                url = f"https://api.upstox.com/v2/historical-candle/{safe_ikey}/day/{today_str}/{month_ago_str}"
                r = requests.get(url, timeout=5)
                if r.status_code == 200:
                    data = r.json()
                    candles = data.get('data', {}).get('candles', [])
                    if candles:
                        recent = candles[:14]
                        vols = [float(c[5]) for c in recent if c[5] is not None]
                        avg_vol = sum(vols) / len(vols) if vols else 0.0
                        yest_vol = vols[0] if vols else 0.0
                        
                        chronological = list(reversed(recent))
                        tr_list = []
                        for i in range(len(chronological)):
                            h = float(chronological[i][2])
                            l = float(chronological[i][3])
                            if i == 0:
                                tr = h - l
                            else:
                                prev_c = float(chronological[i-1][4])
                                tr = max(h - l, abs(h - prev_c), abs(l - prev_c))
                            tr_list.append(tr)
                        
                        atr_14 = sum(tr_list) / len(tr_list) if tr_list else 0.0
                        upstox_success = True
                        return sym, {
                            "ATR": f"{atr_14:.2f}",
                            "AvgVol": f"{avg_vol:.2f}",
                            "YestVol": f"{int(yest_vol)}"
                        }
            except Exception as e:
                logger.warning(f"[UPSTOX HISTORICAL ERROR] {sym}: {e}")

            # 2. Fallback to Yahoo Finance
            if not upstox_success:
                try:
                    ticker = f"{sym}.NS"
                    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=1mo&interval=1d"
                    r = requests.get(url, headers=headers, timeout=10)
                    if r.status_code != 200:
                        logger.warning(f"[YAHOO FALLBACK ERROR] {sym} status code: {r.status_code}")
                        return sym, None
                    data = r.json()
                    res_chart = data.get('chart', {}).get('result', [])
                    if not res_chart:
                        return sym, None
                    
                    quotes = res_chart[0].get('indicators', {}).get('quote', [{}])[0]
                    vols = quotes.get('volume', [])
                    highs = quotes.get('high', [])
                    lows = quotes.get('low', [])
                    closes = quotes.get('close', [])
                    
                    clean = []
                    for i in range(len(vols)):
                        v, h, l, c = vols[i], highs[i], lows[i], closes[i]
                        if v is not None and h is not None and l is not None and c is not None:
                            clean.append({'v': float(v), 'h': float(h), 'l': float(l), 'c': float(c)})
                            
                    if len(clean) < 5:
                        return sym, None
                        
                    recent_14 = clean[-14:]
                    v_list = [item['v'] for item in recent_14]
                    avg_vol = sum(v_list) / len(v_list)
                    yest_vol = recent_14[-1]['v']
                    
                    tr_list = []
                    for i in range(len(recent_14)):
                        h, l = recent_14[i]['h'], recent_14[i]['l']
                        if i == 0:
                            tr = h - l
                        else:
                            prev_c = recent_14[i-1]['c']
                            tr = max(h - l, abs(h - prev_c), abs(l - prev_c))
                        tr_list.append(tr)
                        
                    atr_14 = sum(tr_list) / len(tr_list)
                    return sym, {
                        "ATR": f"{atr_14:.2f}",
                        "AvgVol": f"{avg_vol:.2f}",
                        "YestVol": f"{int(yest_vol)}"
                    }
                except Exception as e:
                    logger.warning(f"[YAHOO FALLBACK ERROR] {sym}: {e}")
                    return sym, None

        with ThreadPoolExecutor(max_workers=15) as executor:
            futures = [executor.submit(fetch_symbol_upstox, item) for item in symbol_token_map.items()]
            for future in futures:
                sym, res = future.result()
                if res:
                    results[sym] = res

        success_count = len([k for k, v in results.items() if v])
        fail_count = len(symbol_token_map) - success_count
        logger.info(f"[UPSTOX] Historical metrics loaded: {success_count} succeeded, {fail_count} failed.")

        if results:
            try:
                with open(UPSTOX_CACHE_FILE, 'w') as f:
                    json.dump({"date": datetime.date.today().isoformat(), "metrics": results}, f, indent=2)
                logger.info(f"[UPSTOX] Saved {len(results)} metrics to {UPSTOX_CACHE_FILE}")
            except Exception as e:
                logger.error(f"[UPSTOX] Failed to save cache: {e}")
        else:
            # Fallback to old cache on failure
            if os.path.exists(UPSTOX_CACHE_FILE):
                try:
                    with open(UPSTOX_CACHE_FILE, 'r') as f:
                        data = json.load(f)
                        if "metrics" in data:
                            results = data["metrics"]
                            logger.info(f"[UPSTOX] Fetch failed. Restoring from Upstox cache fallback (date: {data.get('date')}).")
                except Exception:
                    pass
            if not results and os.path.exists(ROOT_CACHE_FILE):
                try:
                    with open(ROOT_CACHE_FILE, 'r') as f:
                        data = json.load(f)
                        if "metrics" in data:
                            results = data["metrics"]
                            logger.info(f"[UPSTOX] Fetch failed. Restoring from root cache fallback (date: {data.get('date')}).")
                except Exception:
                    pass

        return results

    def place_order(
        self, 
        buy_or_sell: str, 
        exchange: str, 
        tradingsymbol: str, 
        quantity: int, 
        price_type: str, 
        price: float, 
        trigger_price: Optional[float] = None, 
        product_type: Optional[str] = None
    ) -> Any:
        logger.info(f"[UPSTOX ORDER] {buy_or_sell} {quantity} {tradingsymbol} @ {price} (Type: {price_type})")
        
        # Check if real trading but token is missing
        is_paper = True
        if self.app_state:
            is_paper = (getattr(self.app_state, 'trade_mode', 'PAPER') == "PAPER")
            
        if not is_paper and not self.access_token:
            logger.error("[UPSTOX ORDER REJECTED] Access token is missing in Real Mode. Please authenticate first.")
            return {
                "status": "error",
                "message": "Upstox access token is missing. Please click Upstox in the navbar to log in."
            }

        # Resolve official Upstox instrument key (e.g. NSE_FO|61095 or NSE_EQ|RELIANCE)
        instrument_key = self.shoonya_to_upstox_key(tradingsymbol)
        if not instrument_key:
            if exchange.upper() in ["NSE", "NSE_EQ", "BSE"]:
                instrument_key = f"NSE_EQ|{tradingsymbol}"
            else:
                instrument_key = f"NSE_FO|{tradingsymbol}"
        
        # Upstox Order Place API
        url = "https://api.upstox.com/v2/order/place"
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {self.access_token}" if self.access_token else ""
        }
        
        tx_type = "BUY" if buy_or_sell.upper().startswith("B") else "SELL"
        
        payload = {
            "quantity": quantity,
            "product": "I" if product_type == "M" else "D", # Intraday vs Delivery
            "validity": "DAY",
            "price": price,
            "tag": "WebTrader",
            "instrument_token": instrument_key,
            "order_type": "LIMIT" if price_type == "LMT" else "MARKET",
            "transaction_type": tx_type,
            "disclosed_quantity": 0,
            "trigger_price": trigger_price or 0.0,
            "is_amo": False
        }
        
        if self.access_token:
            try:
                r = requests.post(url, json=payload, headers=headers, timeout=10)
                res_json = r.json()
                if res_json.get("status") == "error" and "errors" in res_json:
                    err_msgs = [e.get("message") for e in res_json["errors"] if e.get("message")]
                    if err_msgs:
                        res_json["message"] = ", ".join(err_msgs)
                return res_json
            except Exception as e:
                logger.error(f"[UPSTOX ORDER ERROR] {e}")
                return {"status": "error", "message": str(e)}
        else:
            # Paper trading / Mock simulation
            return {
                "status": "success", 
                "data": {"order_id": f"UPSTOX_SIM_{int(time.time()*1000)}"}
            }

    def cancel_order(self, order_id: str) -> Any:
        logger.info(f"[UPSTOX CANCEL] Order ID: {order_id}")
        if self.access_token:
            url = f"https://api.upstox.com/v2/order/cancel?order_id={order_id}"
            headers = {"Authorization": f"Bearer {self.access_token}"}
            try:
                r = requests.delete(url, headers=headers, timeout=10)
                res_json = r.json()
                if res_json.get("status") == "error" and "errors" in res_json:
                    err_msgs = [e.get("message") for e in res_json["errors"] if e.get("message")]
                    if err_msgs:
                        res_json["message"] = ", ".join(err_msgs)
                return res_json
            except Exception as e:
                return {"status": "error", "message": str(e)}
        return {"status": "success", "message": "Order cancelled"}

    def modify_order(
        self,
        order_id: str,
        exchange: str,
        tradingsymbol: str,
        new_quantity: int,
        new_price_type: str,
        new_price: float,
        trigger_price: Optional[float] = None
    ) -> Any:
        logger.info(f"[UPSTOX MODIFY] Order ID: {order_id} -> Price: {new_price}, Qty: {new_quantity}")
        if self.access_token:
            url = "https://api.upstox.com/v2/order/modify"
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Bearer {self.access_token}"
            }
            payload = {
                "order_id": order_id,
                "quantity": new_quantity,
                "price": new_price,
                "order_type": "LIMIT" if new_price_type == "LMT" else "MARKET",
                "validity": "DAY",
                "disclosed_quantity": 0,
                "trigger_price": trigger_price or 0.0
            }
            try:
                r = requests.put(url, json=payload, headers=headers, timeout=10)
                res_json = r.json()
                if res_json.get("status") == "error" and "errors" in res_json:
                    err_msgs = [e.get("message") for e in res_json["errors"] if e.get("message")]
                    if err_msgs:
                        res_json["message"] = ", ".join(err_msgs)
                return res_json
            except Exception as e:
                logger.error(f"[UPSTOX MODIFY ERROR] {e}")
                return {"status": "error", "message": str(e)}
        return {"status": "success", "message": "Order modified (mock)"}
```
\n
### File: `brokers/zebu_broker.py`
```python
import os
import sys
import time
import json
import re
import pyotp
import logging
import asyncio
import requests
import datetime
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Any, Optional
from urllib.parse import urlencode, parse_qs, urlparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from brokers.base_broker import BaseBroker

logger = logging.getLogger("WebTraderApi.Zebu")

try:
    from myntapi import app_oauth
except ImportError:
    app_oauth = object

class ZebuApiPy(app_oauth):
    def close_websocket(self):
        """Cleanly and unconditionally closes Zebu WebSocket and joins worker thread."""
        stop_event = getattr(self, '_NorenApi_oauth__stop_event', None)
        if stop_event is not None:
            stop_event.set()

        ws = getattr(self, '_NorenApi_oauth__websocket', None)
        if ws is not None:
            try:
                ws.close()
            except Exception as e:
                logger.debug(f"[ZEBU WS] Error closing WebSocket: {e}")

        ws_thread = getattr(self, '_NorenApi_oauth__ws_thread', None)
        if ws_thread is not None and ws_thread.is_alive() and ws_thread != threading.current_thread():
            try:
                ws_thread.join(timeout=2.0)
            except Exception as e:
                logger.debug(f"[ZEBU WS] Error joining ws_thread: {e}")

        self._NorenApi_oauth__websocket_connected = False
        self._NorenApi_oauth__websocket = None
        self._NorenApi_oauth__ws_thread = None

    def _NorenApi_oauth__ws_run_forever(self):
        """Zebu WebSocket thread worker with zombie thread exit and backoff."""
        stop_event = getattr(self, '_NorenApi_oauth__stop_event', None)
        while stop_event and not stop_event.is_set():
            ws = getattr(self, '_NorenApi_oauth__websocket', None)
            if not ws:
                break
            try:
                ws.run_forever(ping_interval=3, ping_payload='{"t":"h"}')
            except Exception as e:
                err_msg = str(e).lower()
                if "already opened" in err_msg:
                    logger.warning("[ZEBU WS] Redundant WebSocket thread detected ('socket is already opened'); exiting thread cleanly.")
                    break
                logger.warning(f"[ZEBU WS] websocket run forever ended in exception, {e}")

            if stop_event.is_set():
                break
            time.sleep(1.0)

    def _NorenApi_oauth__on_data_callback(self, ws=None, message=None, data_type=None, continue_flag=None):
        import json as _json
        try:
            res = _json.loads(message)
        except Exception:
            return

        subscribe_cb = getattr(self, '_NorenApi_oauth__subscribe_callback', None)
        if subscribe_cb is not None and res.get('t') in ('tk', 'tf', 'dk', 'df'):
            subscribe_cb(res)
            return

        order_cb = getattr(self, '_NorenApi_oauth__order_update_callback', None)
        if order_cb is not None and res.get('t') == 'om':
            order_cb(res)
            return

        open_cb = getattr(self, '_NorenApi_oauth__on_open', None)
        if open_cb is not None and res.get('t') in ('ck', 'ak') and res.get('s') == 'OK':
            logger.info("[WS] Zebu WS Auth acknowledged OK - connection live!")
            open_cb()
            return

        error_cb = getattr(self, '_NorenApi_oauth__on_error', None)
        if error_cb is not None and res.get('t') in ('ck', 'ak') and res.get('s') != 'OK':
            logger.error(f"[WS] Zebu WS Auth REJECTED by server: {res}")
            error_cb(res)
            return

    def start_websocket(self, subscribe_callback=None, 
                        order_update_callback=None,
                        socket_open_callback=None,
                        socket_close_callback=None,
                        socket_error_callback=None,
                        ltp_callback=None,
                        position_update_callback=None,
                        alert_callback=None,
                        admin_message_callback=None,
                        market_status_callback=None):
        self.close_websocket()

        self._NorenApi_oauth__on_open = socket_open_callback
        self._NorenApi_oauth__on_disconnect = socket_close_callback
        self._NorenApi_oauth__on_error = socket_error_callback
        self._NorenApi_oauth__subscribe_callback = subscribe_callback
        self._NorenApi_oauth__order_update_callback = order_update_callback
        self._NorenApi_oauth__ltp_callback = ltp_callback
        self._NorenApi_oauth__position_update_callback = position_update_callback
        self._NorenApi_oauth__alert_callback = alert_callback
        self._NorenApi_oauth__admin_message_callback = admin_message_callback
        self._NorenApi_oauth__market_status_callback = market_status_callback
        self._NorenApi_oauth__stop_event = threading.Event()

        susertoken = getattr(self, '_NorenApi_oauth__susertoken', '')
        service_config = getattr(self, '_NorenApi_oauth__service_config', {})
        endpoint = service_config.get('websocket_endpoint', 'wss://go.mynt.in/NorenWSTP/')
        url = endpoint.format(access_token=susertoken)
        logger.info(f"[ZEBU WS] Connecting WebSocket to {endpoint}...")

        import websocket
        self._NorenApi_oauth__websocket = websocket.WebSocketApp(
            url,
            on_data=self._NorenApi_oauth__on_data_callback,
            on_error=self._NorenApi_oauth__on_error_callback,
            on_close=self._NorenApi_oauth__on_close_callback,
            on_open=self._NorenApi_oauth__on_open_callback
        )
        self._NorenApi_oauth__ws_thread = threading.Thread(target=self._NorenApi_oauth__ws_run_forever, daemon=True)
        self._NorenApi_oauth__ws_thread.start()

ZEBU_CACHE_FILE = os.path.join(os.path.dirname(__file__), "historical_cache_zebu.json")
ROOT_CACHE_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "historical_cache.json")
ZEBU_CREDS_FILE = os.path.join(os.path.dirname(__file__), "Zebu_Creds.txt")

# Globals to be injected by main.py
app_state = None
manager = None

def convert_to_float(val):
    try:
        if val is None or val == "": return 0.0
        return float(val)
    except:
        return 0.0

def zebu_quote_update(data: dict):
    try:
        exch = data.get('e') or data.get('exch') or ''
        token = str(data.get('tk') or data.get('token') or '')
        ts = data.get('ts') or data.get('tsym')
        
        keys_to_update = [f"{exch}|{token}", token]
        if ts:
            keys_to_update.extend([f"{exch}|{ts}", ts])
            if ts.endswith('-EQ'):
                base_ts = ts[:-3]
                keys_to_update.extend([f"{exch}|{base_ts}", base_ts, f"NSE|{base_ts}"])

        # Resolve symbol from token_to_info for NSE spot equities
        t2i = getattr(app_state, 'token_to_info', {})
        info = t2i.get((exch, token)) or t2i.get(('NSE', token)) or t2i.get(('NFO', token))
        if info:
            sym_name = info.get('Symbol') or info.get('TradingSymbol')
            if sym_name:
                keys_to_update.extend([f"{exch}|{sym_name}", sym_name])
                if sym_name.endswith('-EQ'):
                    base_s = sym_name[:-3]
                    keys_to_update.extend([f"{exch}|{base_s}", base_s, f"NSE|{base_s}"])

        nfo_token_map = getattr(app_state, 'nfo_token_map', {})
        if exch == 'NFO':
            ts = ts or nfo_token_map.get(token)
            if ts:
                if token not in nfo_token_map:
                    nfo_token_map[token] = ts
                keys_to_update.extend([f"{exch}|{ts}", ts])

        for k in set(keys_to_update):
            if not k: continue
            if k not in app_state.live_data:
                app_state.live_data[k] = {}
            old_data = app_state.live_data[k]
            for fd in ["lp", "pc", "o", "h", "l", "c", "v", "oi", "poi", "bp1", "sp1"]:
                if fd in data and data[fd] is not None and str(data[fd]) != "":
                    val = convert_to_float(data[fd])
                    if val > 0 or fd in ["pc", "lp"]:
                        old_data[fd] = val

            # Compute pc and change dynamically if c (close) and lp (ltp) exist
            if "lp" in old_data and "c" in old_data and old_data["c"] > 0:
                c_val = old_data["c"]
                lp_val = old_data["lp"]
                old_data["pc"] = round(((lp_val - c_val) / c_val) * 100.0, 2)

            with app_state.pending_updates_lock:
                app_state.pending_updates[k] = {"key": k, **old_data}
    except Exception as e:
        logger.error(f"Zebu quote update error: {e}")

def zebu_order_update(data: dict):
    logger.info(f"Zebu Order Update callback received: {data}")
    if not app_state.main_loop: return
    try:
        orderno = data.get("norenordno")
        if orderno and hasattr(app_state, 'order_mappings') and orderno in app_state.order_mappings:
            logger.info(f"[EXEC ENGINE] Suppressing raw update for chased child order: {orderno}")
            return
            
        asyncio.run_coroutine_threadsafe(
            manager.broadcast("ORDER_UPDATE", data),
            app_state.main_loop
        )
    except Exception as e:
        logger.error(f"Zebu order update error: {e}")

class ZebuBroker(BaseBroker):
    def __init__(self):
        self.api = None
        self.access_token: Optional[str] = None
        self.user_code: Optional[str] = None
        self.password: Optional[str] = None
        self.client_id: Optional[str] = None
        self.api_key: Optional[str] = None
        self.api_secret: Optional[str] = None
        self.redirect_url: Optional[str] = None
        self.totp_key: Optional[str] = None
        self._logged_in: bool = False
        self._callback_server: Optional[HTTPServer] = None
        self._ws_feed_opened: bool = False
        self.subscribed_tokens: set = set()

    def get_name(self) -> str:
        return "ZEBU"

    def load_creds_from_file(self) -> Dict[str, str]:
        creds = {}
        target_files = [
            ZEBUR_CREDS_FILE if 'ZEBUR_CREDS_FILE' in globals() else ZEBU_CREDS_FILE,
            os.path.join(os.getcwd(), "Zebu_Creds.txt"),
            os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Zebu_Creds.txt"),
            os.path.join(os.getcwd(), "Creds.txt")
        ]
        creds_file = next((f for f in target_files if os.path.exists(f)), None)
        if creds_file:
            try:
                with open(creds_file, 'r') as f:
                    for line in f:
                        if ':' in line:
                            parts = line.strip().split(':', 1)
                            creds[parts[0].strip().lower()] = parts[1].strip()
            except Exception as e:
                logger.error(f"Failed to read Zebu creds file: {e}")
        return creds

    async def login(self, creds: Optional[Dict[str, str]] = None) -> tuple[bool, str]:
        if self.is_logged_in():
            logger.info("[ZEBU] Already connected & running. Skipping login process.")
            return True, "Already logged in"

        if not creds:
            creds = self.load_creds_from_file()

        self.user_code = creds.get('vendor code') or creds.get('vendor_code') or creds.get('user') or 'Z50011'
        self.password = creds.get('password') or creds.get('pwd') or 'Ragram@312'
        self.client_id = creds.get('client_id') or creds.get('client id') or 'Z50011_U'
        self.api_key = creds.get('api key') or creds.get('apikey') or 'tAWUq655s6zmu65cDUuB3m277ca2CeRn'
        self.api_secret = creds.get('api secret') or creds.get('apisecret') or 'nQF2tQgypa3gwCOj8b4dFxiymj22pxhA'
        self.totp_key = creds.get('totp') or '5757XV35F4L7PG6246C6AT5VX2O2R546'
        self.redirect_url = creds.get('redirecturl') or creds.get('redirect url') or 'http://127.0.0.1:5000/zebu/callback'
        self.access_token = creds.get('access_token') or creds.get('access token')

        logger.info(f"[ZEBU] Initiating login for User: {self.user_code}, Client ID: {self.client_id}")

        # Check if pre-authorized token is available
        if self.access_token:
            try:
                self.api = ZebuApiPy()
                self.api.set_session(userid=self.user_code, password="", usertoken=self.access_token)
                # Inject name-mangled variables to bypass myntapi subclass conflict
                self.api._NorenApi_oauth__username = self.user_code
                self.api._NorenApi_oauth__accountid = self.user_code
                self.api._NorenApi_oauth__susertoken = self.access_token
                limits = await asyncio.to_thread(self.api.get_limits)
                if limits and limits.get('stat') == 'Ok':
                    self._logged_in = True
                    self.start_websocket()
                    self.fetch_historical_metrics_bg()
                    return True, "Zebu Login Success (Token loaded)"
                else:
                    logger.warning("[ZEBU] Loaded token is expired or invalid. Attempting OAuth.")
            except Exception as e:
                logger.error(f"[ZEBU] Token validation failed: {e}")

        # Create future to wait for callback or auto-login
        self.login_future = asyncio.get_event_loop().create_future()

        # Start the redirect capture HTTP server on port 5000
        self.start_callback_listener()

        # Generate auth URL
        auth_url = f"https://go.mynt.in/OAuthlogin/authorize/oauth?client_id={self.client_id}"
        logger.info(f"[ZEBU] Redirection auth URL: {auth_url}")

        # Start background Selenium headless thread for auto-login
        threading.Thread(target=self.auto_login_selenium, daemon=True).start()

        try:
            logger.info("[ZEBU] Waiting for auto-login/callback to complete...")
            success, msg = await asyncio.wait_for(self.login_future, timeout=45)
            if success:
                return True, msg
            else:
                logger.warning(f"[ZEBU] Auto-login failed: {msg}. Falling back to manual browser login.")
        except asyncio.TimeoutError:
            logger.warning("[ZEBU] Auto-login timed out. Falling back to manual browser login.")

        return False, f"AUTH_REQUIRED:{auth_url}"

    def is_logged_in(self) -> bool:
        return bool(self._logged_in and self.access_token and self.api)

    def remove_access_token_from_creds(self):
        try:
            creds_file = ZEBU_CREDS_FILE
            if os.path.exists(creds_file):
                lines = []
                with open(creds_file, 'r') as f:
                    lines = f.readlines()
                
                clean_lines = [l for l in lines if not l.strip().lower().startswith("access_token")]
                with open(creds_file, 'w') as f:
                    f.writelines(clean_lines)
                logger.info("[ZEBU] Removed expired access token from credentials file.")
        except Exception as e:
            logger.error(f"[ZEBU] Failed to remove access token: {e}")

    def logout(self):
        self._logged_in = False
        self.access_token = None
        self.api = None
        self._ws_feed_opened = False
        self.remove_access_token_from_creds()
        logger.info("[ZEBU] Session logged out / deactivated.")

    def subscribe_symbols(self, symbols: List[str]):
        if not self.is_logged_in() or not self.api:
            return
        resolved_symbols = []
        snapshot_items = []
        symbol_to_token = getattr(app_state, 'symbol_to_token', {})
        nfo_token_map = getattr(app_state, 'nfo_token_map', {})
        for sym in symbols:
            sym_norm = sym.replace(':', '|').replace(' ', '|').upper()
            if "|" in sym_norm:
                exch, symbol_or_token = sym_norm.split("|", 1)
                exch = exch.upper()
                token = symbol_to_token.get((exch, symbol_or_token.upper()))
                if token:
                    resolved_symbols.append(f"{exch}|{token}")
                    if exch == 'NFO':
                        nfo_token_map[token] = symbol_or_token.upper()
                    live_entry = app_state.live_data.get(f"{exch}|{token}", {})
                    if "lp" not in live_entry:
                        snapshot_items.append((exch, token, symbol_or_token.upper()))
                else:
                    resolved_symbols.append(sym_norm)
            else:
                resolved_symbols.append(sym_norm)

        new_symbols = [s for s in resolved_symbols if s not in self.subscribed_tokens]
        if new_symbols:
            logger.info(f"[ZEBU] Subscribing to {len(new_symbols)} symbols in 50-symbol batches...")
            for i in range(0, len(new_symbols), 50):
                chunk = new_symbols[i:i+50]
                try:
                    self.api.subscribe(chunk)
                    self.subscribed_tokens.update(chunk)
                    time.sleep(0.05)
                except Exception as e:
                    logger.error(f"[ZEBU] Subscription error for batch: {e}")
                
        if snapshot_items:
            import threading
            from concurrent.futures import ThreadPoolExecutor
            def fetch_single_snap(item):
                exch, token, orig_sym = item
                try:
                    if not self.api or not self.is_logged_in(): return
                    q = self.api.get_quotes(exchange=exch, token=token)
                    if q and isinstance(q, dict) and q.get('stat') == 'Ok':
                        if not q.get('ts') and orig_sym: q['ts'] = orig_sym
                        if not q.get('e'): q['e'] = exch
                        zebu_quote_update(q)
                except Exception as e:
                    logger.debug(f"[ZEBU] REST quote snapshot note for {exch}|{token}: {e}")

            def bg_snapshots():
                logger.info(f"[ZEBU SNAPSHOTS] Fetching initial REST quotes for {len(snapshot_items)} symbols via 10 workers...")
                with ThreadPoolExecutor(max_workers=10) as executor:
                    executor.map(fetch_single_snap, snapshot_items)

            threading.Thread(target=bg_snapshots, daemon=True).start()

    def fetch_historical_metrics(self, symbol_token_map: Dict[str, Dict[str, str]], force_refresh: bool = False) -> Dict[str, Dict[str, str]]:
        # 1. Instant lookup: return cached metrics (today's or prior date fallback) immediately
        if not force_refresh:
            cached = self.load_historical_cache(check_today=False)
            if cached:
                logger.info(f"[ZEBU CACHE] Returning {len(cached)} instant cached historical metrics (0ms delay).")
                return cached
                
        if not self.is_logged_in() or not self.api:
            logger.warning("Zebu API not logged in; returning cached historical metrics")
            return self.load_historical_cache(check_today=False)

        logger.info(f"Fetching 14-day Avg Volume & ATR from Zebu API for {len(symbol_token_map)} symbols...")
        results = {}

        def fetch_task(item):
            sym, info = item
            exch = info.get("exchange", "NSE")
            token = str(info.get("token", ""))
            if not token or token == "-":
                return sym, None
            res = self.fetch_single_symbol_metrics(exch, token)
            return sym, res

        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(fetch_task, item) for item in symbol_token_map.items()]
            for future in futures:
                try:
                    sym, res = future.result(timeout=5)
                    if res:
                        results[sym] = res
                except Exception:
                    pass

        if results:
            self.save_historical_cache(results)
        else:
            results = self.load_historical_cache(check_today=False)
            
        return results

    def fetch_single_symbol_metrics(self, exch: str, token: str):
        try:
            now = datetime.datetime.now()
            start_time = int((now - datetime.timedelta(days=35)).timestamp())
            end_time = int(now.timestamp())
            
            # Zebu doesn't support '1440' daily candles, so fetch '60' hourly candles and resample
            candles = self.api.get_time_price_series(exchange=exch, token=token, starttime=start_time, endtime=end_time, interval='60')
            from collections import defaultdict
            daily_groups = defaultdict(list)
            for c in candles:
                time_str = c.get("time", "")
                if time_str:
                    date_str = time_str.split(" ")[0]
                    daily_groups[date_str].append(c)
            
            if len(daily_groups) < 2:
                return None
                
            # Convert groups to daily candles sorted chronologically
            sorted_dates = sorted(daily_groups.keys(), key=lambda d: datetime.datetime.strptime(d, "%d-%m-%Y"))
            daily_candles = []
            for d_str in sorted_dates:
                group = daily_groups[d_str]
                
                highs = [float(c["inth"]) for c in group if "inth" in c]
                lows = [float(c["intl"]) for c in group if "intl" in c]
                
                # Sort group by ssboe (timestamp) ascending
                group_sorted = sorted(group, key=lambda c: int(c.get("ssboe", 0)))
                open_val = float(group_sorted[0]["into"])
                close_val = float(group_sorted[-1]["intc"])
                
                # Volume: max "v" in the group represents cumulative daily volume
                vols = [float(c.get("v", 0)) for c in group]
                vol_val = max(vols) if vols else 0.0
                
                daily_candles.append({
                    "c": close_val,
                    "h": max(highs) if highs else open_val,
                    "l": min(lows) if lows else open_val,
                    "v": vol_val
                })
                
            recent_14 = daily_candles[-14:]
            if not recent_14:
                return None
                
            vols = [c['v'] for c in recent_14]
            avg_vol = sum(vols) / len(vols) if vols else 0.0
            yest_vol = recent_14[-1]['v'] if recent_14 else 0.0
            
            tr_list = []
            for i in range(len(recent_14)):
                h = recent_14[i]['h']
                l = recent_14[i]['l']
                if i == 0:
                    # Look for previous day close from daily_candles if possible
                    idx_in_all = len(daily_candles) - len(recent_14) + i
                    if idx_in_all > 0:
                        prev_close = daily_candles[idx_in_all - 1]['c']
                        tr = max(h - l, abs(h - prev_close), abs(l - prev_close))
                    else:
                        tr = h - l
                else:
                    prev_close = recent_14[i-1]['c']
                    tr = max(h - l, abs(h - prev_close), abs(l - prev_close))
                tr_list.append(tr)
                
            atr = sum(tr_list) / len(tr_list) if tr_list else 0.0
            
            return {
                "ATR": f"{atr:.2f}",
                "AvgVol": f"{avg_vol:.2f}",
                "YestVol": f"{int(yest_vol)}"
            }
        except Exception as e:
            logger.error(f"Error fetching historical metrics from Zebu for {exch}|{token}: {e}")
            return None

    def load_historical_cache(self, check_today: bool = True) -> dict:
        merged = {}
        for cache_path in [ROOT_CACHE_FILE, ZEBU_CACHE_FILE]:
            if os.path.exists(cache_path):
                try:
                    with open(cache_path, 'r') as f:
                        data = json.load(f)
                        if isinstance(data, dict):
                            m = data.get("metrics") if "metrics" in data else data
                            if isinstance(m, dict):
                                merged.update(m)
                except Exception as e:
                    logger.warning(f"Failed to load historical cache from {cache_path}: {e}")
        return merged

    def save_historical_cache(self, metrics: dict):
        try:
            existing = self.load_historical_cache(check_today=False)
            existing.update(metrics)
            
            data = {
                "date": datetime.date.today().isoformat(),
                "metrics": existing
            }
            with open(ROOT_CACHE_FILE, 'w') as f:
                json.dump(existing, f, indent=2)
            with open(ZEBU_CACHE_FILE, 'w') as f:
                json.dump(data, f, indent=2)
            logger.info(f"Saved {len(existing)} Zebu historical metrics to {ROOT_CACHE_FILE}")
        except Exception as e:
            logger.error(f"Failed to save Zebu historical cache: {e}")

    def fetch_historical_metrics_bg(self):
        def _fetch():
            try:
                if getattr(app_state, 'fno_spot_df', None) is not None and not app_state.fno_spot_df.empty:
                    df_spots = app_state.fno_spot_df.drop_duplicates(subset=["Symbol"]).copy()
                    df_nse = pd.read_csv("Instrument/NSE_symbols.csv")
                    df_nse_eq = df_nse[df_nse['Instrument'] == 'EQ']
                    nse_token_map = dict(zip(df_nse_eq['Symbol'], df_nse_eq['Token'].astype(str)))
                    
                    symbol_token_map = {}
                    for _, r in df_spots.iterrows():
                        sym = r["Symbol"]
                        if 'NSETEST' not in str(sym).upper() and sym in nse_token_map:
                            symbol_token_map[sym] = {"exchange": "NSE", "token": nse_token_map[sym]}
                            
                    new_metrics = self.fetch_historical_metrics(symbol_token_map, force_refresh=False)
                    if new_metrics:
                        app_state.historical_data = new_metrics
                        logger.info(f"[BACKGROUND] Successfully cached {len(new_metrics)} Zebu historical metrics post-login.")
            except Exception as e:
                logger.error(f"Error fetching background historical metrics from Zebu: {e}")

        threading.Thread(target=_fetch, daemon=True).start()

    def place_order(self, buy_or_sell: str, exchange: str, tradingsymbol: str, quantity: int, price_type: str, price: float, trigger_price: Optional[float] = None, product_type: Optional[str] = None) -> Any:
        if not self.is_logged_in() or not self.api:
            raise RuntimeError("Zebu API not logged in")
            
        prod = product_type or "M"
        logger.info(f"[ZEBU] Placing order - {buy_or_sell} {quantity} {tradingsymbol} ({prod})")
        
        response = self.api.place_order(
            buy_or_sell=buy_or_sell,
            product_type=prod,
            exchange=exchange,
            tradingsymbol=tradingsymbol,
            quantity=quantity,
            discloseqty=0,
            price_type=price_type,
            price=price,
            trigger_price=trigger_price,
            retention="DAY",
            remarks="webtrader-nse"
        )
        if response:
            return response
        raise RuntimeError("Zebu Order placement returned empty response")

    def cancel_order(self, order_id: str) -> Any:
        if not self.is_logged_in() or not self.api:
            raise RuntimeError("Zebu API not logged in")
            
        logger.info(f"[ZEBU] Cancelling order - {order_id}")
        response = self.api.cancel_order(orderno=order_id)
        if response:
            return response
        raise RuntimeError("Zebu Order cancellation failed")

    def modify_order(self, order_id: str, exchange: str, tradingsymbol: str, new_quantity: int, new_price_type: str, new_price: float, trigger_price: Optional[float] = None) -> Any:
        if not self.is_logged_in() or not self.api:
            raise RuntimeError("Zebu API not logged in")
        logger.info(f"[ZEBU] Modifying order {order_id} -> {new_quantity} @ {new_price}")
        return self.api.modify_order(
            orderno=order_id,
            exchange=exchange,
            tradingsymbol=tradingsymbol,
            newquantity=new_quantity,
            newprice_type=new_price_type,
            newprice=new_price,
            newtrigger_price=trigger_price
        )

    def get_positions(self) -> Any:
        if not self.is_logged_in() or not self.api:
            return []
        return self.api.get_positions() or []

    def get_order_book(self) -> Any:
        if not self.is_logged_in() or not self.api:
            return []
        return self.api.get_order_book() or []

    # ==============================================================================
    # OAUTH REDIRECT SERVER & AUTO-LOGIN
    # ==============================================================================

    def start_callback_listener(self):
        if self._callback_server:
            return
        
        parsed_url = urlparse(self.redirect_url)
        port = parsed_url.port or 5000
        
        class ZebuCallbackHandler(BaseHTTPRequestHandler):
            broker_ref = self
            
            def do_GET(self):
                query = urlparse(self.path).query
                params = parse_qs(query)
                code_list = params.get('code')
                if code_list:
                    code_val = code_list[0]
                    logger.info(f"[ZEBU] Callback auth code captured: {code_val}")
                    success, msg = ZebuCallbackHandler.broker_ref.exchange_code_for_token(code_val)
                    if success:
                        body = "<html><body style='background:#0f1117;color:#4ade80;font-family:sans-serif;text-align:center;padding-top:10%;'><h2>✅ Zebu Login Successful!</h2><p>Redirecting to WebTrader...</p><script>setTimeout(function(){ window.location.href = 'http://127.0.0.1:8095/'; }, 1500);</script></body></html>".encode('utf-8')
                    else:
                        body = f"<html><body style='background:#0f1117;color:#f87171;font-family:sans-serif;text-align:center;padding-top:10%;'><h2>❌ Zebu Token Error</h2><p>{msg}</p></body></html>".encode('utf-8')
                else:
                    body = "<html><body><h2>No auth code received</h2></body></html>".encode('utf-8')
                
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                
                # Stop listener in a separate thread
                threading.Thread(target=ZebuCallbackHandler.broker_ref.shutdown_callback_server).start()

            def log_message(self, format, *args):
                return

        try:
            self._callback_server = HTTPServer(("127.0.0.1", port), ZebuCallbackHandler)
            threading.Thread(target=self._callback_server.serve_forever, daemon=True).start()
            logger.info(f"[ZEBU] Redirect listener active on port {port} for callback.")
        except Exception as e:
            logger.error(f"[ZEBU] Failed to start callback server: {e}")

    def shutdown_callback_server(self):
        server = self._callback_server
        if server:
            self._callback_server = None
            time.sleep(1.0)
            try:
                server.shutdown()
                logger.info("[ZEBU] Temporary redirect listener shut down.")
            except Exception as e:
                logger.warning(f"[ZEBU] Error shutting down callback server: {e}")

    def exchange_code_for_token(self, auth_code: str) -> tuple[bool, str]:
        try:
            self.api = ZebuApiPy()
            response = self.api.Oauth_login_using_code(
                self.client_id,
                self.api_secret,
                auth_code,
            )
            if not response or response.get("stat") == "Not_Ok":
                err_msg = response.get("emsg", "OAuth login failed") if response else "OAuth login failed"
                return False, err_msg
            
            raw_token = (
                response.get("susertoken")
                or response.get("token")
                or response.get("access_token")
                or response.get("usertoken")
                or response.get("jKey")
                or ""
            )
            if not raw_token:
                return False, "No access token found in response"
                
            self.access_token = str(raw_token).strip()
            self.api.set_session(userid=self.user_code, password="", usertoken=self.access_token)
            # Inject name-mangled variables to bypass myntapi subclass conflict
            self.api._NorenApi_oauth__username = self.user_code
            self.api._NorenApi_oauth__accountid = self.user_code
            self.api._NorenApi_oauth__susertoken = self.access_token
            
            limits = self.api.get_limits()
            if limits and limits.get('stat') == 'Ok':
                self._logged_in = True
                self.save_access_token_to_file(self.access_token)
                self.start_websocket()
                self.fetch_historical_metrics_bg()
                
                print("\n" + "="*60)
                print("  🟢 ZEBU AUTHENTICATION SUCCESSFUL!")
                print("  ⚡ ACCESS TOKEN GENERATED & LIVE MARKET DATA STREAM ACTIVE")
                print("="*60 + "\n")
                
                if hasattr(self, 'login_future') and not self.login_future.done():
                    app_state.main_loop.call_soon_threadsafe(self.login_future.set_result, (True, "Zebu Login Success"))
                return True, "Success"
            else:
                err_msg = limits.get("emsg", "Limits check failed") if limits else "Limits check failed"
                if hasattr(self, 'login_future') and not self.login_future.done():
                    app_state.main_loop.call_soon_threadsafe(self.login_future.set_result, (False, err_msg))
                return False, err_msg
        except Exception as e:
            logger.error(f"[ZEBU] Token exchange exception: {e}")
            if hasattr(self, 'login_future') and not self.login_future.done():
                app_state.main_loop.call_soon_threadsafe(self.login_future.set_result, (False, str(e)))
            return False, str(e)

    def save_access_token_to_file(self, token: str):
        try:
            creds_file = ZEBU_CREDS_FILE
            lines = []
            if os.path.exists(creds_file):
                with open(creds_file, 'r') as f:
                    lines = f.readlines()
            
            updated = False
            for i, line in enumerate(lines):
                if line.strip().lower().startswith("access_token"):
                    lines[i] = f"Access_Token\t:\t{token}\n"
                    updated = True
                    break
            
            if not updated:
                lines.append(f"\nAccess_Token\t:\t{token}\n")
            
            with open(creds_file, 'w') as f:
                f.writelines(lines)
            logger.info("[ZEBU] Saved access token to Zebu_Creds.txt")
        except Exception as e:
            logger.error(f"[ZEBU] Failed to save token to file: {e}")

    def auto_login_selenium(self):
        driver = None
        try:
            from selenium import webdriver
            from selenium.webdriver.common.by import By
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.common.exceptions import StaleElementReferenceException
            
            options = webdriver.ChromeOptions()
            options.add_argument("--headless=new")
            options.add_argument("--window-size=1440,960")
            options.add_argument("--disable-gpu")
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
            driver = webdriver.Chrome(options=options)
            wait = WebDriverWait(driver, 20)
            
            auth_url = f"https://go.mynt.in/OAuthlogin/authorize/oauth?client_id={self.client_id}"
            logger.info(f"[ZEBU] Selenium background browser opening: {auth_url}")
            driver.get(auth_url)
            
            filled_and_submitted = False
            for attempt in range(5):
                try:
                    inputs = wait.until(lambda d: [x for x in d.find_elements(By.TAG_NAME, "input") if x.is_displayed()])
                    text_inputs = [x for x in inputs if (x.get_attribute("type") or "text").lower() not in {"hidden", "submit", "button"}]
                    if not text_inputs:
                        time.sleep(0.5)
                        continue
                    
                    text_inputs[0].clear()
                    text_inputs[0].send_keys(self.user_code)
                    if len(text_inputs) > 1:
                        text_inputs[1].clear()
                        text_inputs[1].send_keys(self.password)
                    
                    if self.totp_key and len(text_inputs) > 2:
                        otp = pyotp.TOTP(self.totp_key).now()
                        text_inputs[2].clear()
                        text_inputs[2].send_keys(otp)
                        
                    buttons = [b for b in driver.find_elements(By.TAG_NAME, "button") if b.is_displayed()]
                    if buttons:
                        driver.execute_script("arguments[0].click();", buttons[0])
                    
                    filled_and_submitted = True
                    break
                except StaleElementReferenceException:
                    time.sleep(0.5)
                    continue

            if filled_and_submitted:
                logger.info("[ZEBU] Selenium login credentials automatically filled and submitted.")
                # Give it up to 10 seconds to complete redirection
                time.sleep(10)
            else:
                logger.warning("[ZEBU] Selenium auto-login could not locate form inputs.")
        except Exception as e:
            logger.warning(f"[ZEBU] Selenium auto-login background task encountered warning: {e}")
        finally:
            if driver:
                try:
                    driver.quit()
                except:
                    pass

    # ==============================================================================
    # WEBSOCKET STREAMING ENGINE
    # ==============================================================================

    def start_websocket(self):
        if not self.is_logged_in() or not self.api:
            return
        if self._ws_feed_opened:
            return

        def _ws_callback_socket_open():
            logger.info("[WS] Zebu WebSocket connection established successfully")
            self._ws_feed_opened = True
            if self.subscribed_tokens:
                try:
                    self.api.subscribe(list(self.subscribed_tokens))
                    logger.info(f"[WS] Zebu Re-subscribed to {len(self.subscribed_tokens)} symbols")
                except Exception as e:
                    logger.error(f"[WS] Zebu Re-subscription error: {e}")

        def _ws_callback_socket_closed():
            logger.warning("[WS] Zebu WebSocket connection closed")
            self._ws_feed_opened = False
            if not getattr(self, '_reconnecting', False) and self.is_logged_in():
                threading.Thread(target=self._websocket_reconnect_loop, daemon=True).start()

        def _ws_callback_socket_error(err):
            logger.error(f"[WS] Zebu WebSocket Error: {err}")

        def run_ws():
            try:
                logger.info("[WS] Starting Zebu WebSocket thread...")
                self.api.start_websocket(
                    order_update_callback=zebu_order_update,
                    subscribe_callback=zebu_quote_update,
                    socket_open_callback=_ws_callback_socket_open,
                    socket_close_callback=_ws_callback_socket_closed,
                    socket_error_callback=_ws_callback_socket_error
                )

                for _ in range(10):
                    if self._ws_feed_opened:
                        break
                    time.sleep(1)

                if self._ws_feed_opened:
                    try:
                        self.api.subscribe_orders()
                        logger.info("[WS] Zebu Subscribed to orders successfully")
                    except Exception as sub_e:
                        logger.warning(f"[WS] Zebu Order subscription warning: {sub_e}")
                else:
                    logger.warning("[WS] Zebu WebSocket feed failed to open within timeout")
            except Exception as e:
                logger.error(f"[WS] Zebu WebSocket runner error: {e}")

        threading.Thread(target=run_ws, daemon=True).start()

    def _websocket_reconnect_loop(self):
        if getattr(self, '_reconnecting', False):
            return
        self._reconnecting = True
        logger.info("[ZEBU WS] Initiating automatic WebSocket reconnection loop...")
        attempt = 0
        while not self._ws_feed_opened and self.is_logged_in():
            attempt += 1
            logger.info(f"[ZEBU WS] WebSocket reconnect attempt {attempt}...")
            try:
                self.start_websocket()
                for _ in range(20):
                    if self._ws_feed_opened:
                        break
                    time.sleep(0.5)
                if self._ws_feed_opened:
                    logger.info("[ZEBU WS] WebSocket reconnected successfully!")
                    break
            except Exception as e:
                logger.error(f"[ZEBU WS] Error during WebSocket reconnect attempt: {e}")
            time.sleep(5)
        self._reconnecting = False
```
\n
### File: `requirements.txt`
```text
# Core dependencies
pandas>=1.3.0
numpy>=1.21.0
requests>=2.25.0
pyotp>=2.8.0
xlwings>=0.28.0
pyttsx3>=2.90
websocket-client>=1.2.0
psutil>=5.8.0

# Trading API
NorenRestApiPy>=1.0.0

# Optional/Additional dependencies (uncomment if needed)
# openpyxl>=3.0.0  # For Excel file operations
# python-dateutil>=2.8.0  # For date/time handling
# pytz>=2021.0  # For timezone support
# pandas-ta>=0.3.0  # For technical analysis (if using option chain features)
# matplotlib>=3.3.0  # For data visualization (if needed)
# seaborn>=0.11.0  # For enhanced visualization (if needed)


#pip install -r requirements.txt

#pip install git+https://github.com/kirajcg/ShoonyaApi.git
```
\n
### File: `install_dependencies.bat`
```bat
@echo off
TITLE Install StockOptionsTradingApp Dependencies
COLOR 0B
echo =======================================================================
echo          INSTALLING STOCK OPTIONS TRADING APP DEPENDENCIES
echo =======================================================================
echo.
cd /d "%~dp0"
pip install -r requirements.txt
echo.
echo Setup Complete! Double-click run_app.bat to launch WebTrader.
pause
```
\n
### File: `run_app.bat`
```bat
@echo off
title StockOptionsTradingApp - FLATTRADE (Port 8095)
echo ========================================================
echo   Launching Flattrade Workspace on Port 8095...
echo ========================================================
set PORT=8095
start http://127.0.0.1:8095/
python -u main.py
pause
```
\n
### File: `run_app_8095.bat`
```bat
@echo off
title StockOptionsTradingApp - FLATTRADE (Port 8095)
echo ========================================================
echo   Launching Flattrade Workspace on Port 8095...
echo ========================================================
set PORT=8095
start http://127.0.0.1:8095/
python -u main.py
pause
```
\n
### File: `static/index.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
    <meta http-equiv="Pragma" content="no-cache">
    <meta http-equiv="Expires" content="0">
    <script>
        window.onerror = function(message, source, lineno, colno, error) {
            fetch('/api/log_error', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    message: String(message),
                    source: String(source),
                    lineno: lineno,
                    colno: colno,
                    error: error ? String(error.stack) : ''
                })
            }).catch(e => {});
        };
        const origError = console.error;
        console.error = function(...args) {
            origError.apply(console, args);
            fetch('/api/log_error', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    message: args.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '),
                    source: 'console.error'
                })
            }).catch(e => {});
        };
    </script>
    <title>FnO Stock Trading Application</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script>
        // Force the browser to grab new, uncached versions of CSS and JS on every reload
        document.write('<link rel="stylesheet" href="style.css?v=' + new Date().getTime() + '">');
    </script>
    <!-- React & ReactDOM Global UMD CDN builds -->
    <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
    <!-- Babel Standalone to compile react_app.js in the browser -->
    <script src="https://unpkg.com/@babel/standalone@7.24.0/babel.min.js"></script>
    <!-- Pre-define window.app so any immediate inline click handlers work safely -->
    <script>
        window.app = window.app || {
            launchBroker: function(name) {
                if (window._realApp && window._realApp.launchBroker) {
                    window._realApp.launchBroker(name);
                } else {
                    window._pendingBrokerLaunch = name;
                }
            }
        };
        function launchBroker(name) {
            if (window.app && window.app.launchBroker) {
                window.app.launchBroker(name);
            }
        }
        document.write('<script src="app.js?v=' + new Date().getTime() + '"><\/script>');
    </script>
</head>
<body>
    <!-- INITIAL HOME LANDING PAGE (BROKER LAUNCHPAD) -->
    <div id="landing-home-page" style="position: fixed; inset: 0; background: linear-gradient(135deg, #090d16 0%, #0f172a 100%); z-index: 99999; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px; overflow-y: auto;">
        <div style="max-width: 900px; width: 100%; text-align: center;">
            <div style="display: inline-flex; align-items: center; gap: 10px; padding: 6px 16px; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 20px; color: #38bdf8; font-size: 0.85rem; font-weight: 700; margin-bottom: 20px; letter-spacing: 0.5px;">
                ⚡ FNO STOCK TRADING APPLICATION • UNIVERSAL BROKER LAUNCHPAD
            </div>
            
            <h1 style="font-size: 2.5rem; font-weight: 900; color: #f8fafc; margin-bottom: 12px; letter-spacing: -0.5px;">
                Select Your Broker to Connect & Launch
            </h1>
            <p style="font-size: 1.05rem; color: #94a3b8; margin-bottom: 44px; max-width: 640px; margin-left: auto; margin-right: auto;">
                High-performance real-time trading dashboard. Choose your preferred broker connection below or enter paper trading mode.
            </p>

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 24px; text-align: left;">
                
                <!-- Flattrade Card -->
                <div onclick="launchBroker('FLATTRADE')" style="background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 28px; cursor: pointer; transition: all 0.25s ease; backdrop-filter: blur(12px);" onmouseover="this.style.borderColor='#38bdf8'; this.style.transform='translateY(-4px)'; this.style.boxShadow='0 16px 40px rgba(56,189,248,0.15)'" onmouseout="this.style.borderColor='rgba(255,255,255,0.1)'; this.style.transform=''; this.style.boxShadow=''">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px;">
                        <span style="font-size: 2.2rem;">⚡</span>
                        <span style="padding: 4px 10px; background: rgba(56,189,248,0.15); color: #38bdf8; border-radius: 6px; font-size: 0.72rem; font-weight: 800;">ACTIVE READY</span>
                    </div>
                    <h3 style="font-size: 1.3rem; font-weight: 800; color: #f8fafc; margin-bottom: 6px;">Flattrade Broker</h3>
                    <p style="font-size: 0.82rem; color: #94a3b8; margin-bottom: 22px; line-height: 1.5;">Zero brokerage trading engine powered by Flattrade REST & PiConnect WebSockets.</p>
                    <button style="width: 100%; padding: 12px; border: none; border-radius: 8px; background: linear-gradient(135deg, #0284c7, #38bdf8); color: #000; font-size: 0.9rem; font-weight: 800; cursor: pointer;">Connect & Launch →</button>
                </div>

                <!-- Upstox Card -->
                <div onclick="launchBroker('UPSTOX')" style="background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 28px; cursor: pointer; transition: all 0.25s ease; backdrop-filter: blur(12px);" onmouseover="this.style.borderColor='#a855f7'; this.style.transform='translateY(-4px)'; this.style.boxShadow='0 16px 40px rgba(168,85,247,0.15)'" onmouseout="this.style.borderColor='rgba(255,255,255,0.1)'; this.style.transform=''; this.style.boxShadow=''">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px;">
                        <span style="font-size: 2.2rem;">🚀</span>
                        <span style="padding: 4px 10px; background: rgba(168,85,247,0.15); color: #c084fc; border-radius: 6px; font-size: 0.72rem; font-weight: 800;">v2 API READY</span>
                    </div>
                    <h3 style="font-size: 1.3rem; font-weight: 800; color: #f8fafc; margin-bottom: 6px;">Upstox Broker API</h3>
                    <p style="font-size: 0.82rem; color: #94a3b8; margin-bottom: 22px; line-height: 1.5;">Next-gen OAuth 2.0 streaming feed with Protobuf market tick decoding.</p>
                    <button style="width: 100%; padding: 12px; border: none; border-radius: 8px; background: linear-gradient(135deg, #9333ea, #c084fc); color: #fff; font-size: 0.9rem; font-weight: 800; cursor: pointer;">Connect & Launch →</button>
                </div>

                <!-- Paper Trading Card -->
                <div onclick="launchBroker('PAPER')" style="background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 28px; cursor: pointer; transition: all 0.25s ease; backdrop-filter: blur(12px);" onmouseover="this.style.borderColor='#22c55e'; this.style.transform='translateY(-4px)'; this.style.boxShadow='0 16px 40px rgba(34,197,94,0.15)'" onmouseout="this.style.borderColor='rgba(255,255,255,0.1)'; this.style.transform=''; this.style.boxShadow=''">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px;">
                        <span style="font-size: 2.2rem;">📝</span>
                        <span style="padding: 4px 10px; background: rgba(34,197,94,0.15); color: #4ade80; border-radius: 6px; font-size: 0.72rem; font-weight: 800;">SANDBOX</span>
                    </div>
                    <h3 style="font-size: 1.3rem; font-weight: 800; color: #f8fafc; margin-bottom: 6px;">Paper Trade Mode</h3>
                    <p style="font-size: 0.82rem; color: #94a3b8; margin-bottom: 22px; line-height: 1.5;">Simulated order execution sandbox. Test strategies with zero risk.</p>
                    <button style="width: 100%; padding: 12px; border: none; border-radius: 8px; background: linear-gradient(135deg, #16a34a, #4ade80); color: #000; font-size: 0.9rem; font-weight: 800; cursor: pointer;">Launch Sandbox →</button>
                </div>

                <!-- Zebu Card -->
                <div onclick="launchBroker('ZEBU')" style="background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 28px; cursor: pointer; transition: all 0.25s ease; backdrop-filter: blur(12px);" onmouseover="this.style.borderColor='#f59e0b'; this.style.transform='translateY(-4px)'; this.style.boxShadow='0 16px 40px rgba(245,158,11,0.15)'" onmouseout="this.style.borderColor='rgba(255,255,255,0.1)'; this.style.transform=''; this.style.boxShadow=''">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px;">
                        <span style="font-size: 2.2rem;">🐂</span>
                        <span style="padding: 4px 10px; background: rgba(245,158,11,0.15); color: #f59e0b; border-radius: 6px; font-size: 0.72rem; font-weight: 800;">MYNT API READY</span>
                    </div>
                    <h3 style="font-size: 1.3rem; font-weight: 800; color: #f8fafc; margin-bottom: 6px;">Zebu Broker</h3>
                    <p style="font-size: 0.82rem; color: #94a3b8; margin-bottom: 22px; line-height: 1.5;">High-performance trading engine powered by Zebu Mynt Rest & WebSocket APIs.</p>
                    <button style="width: 100%; padding: 12px; border: none; border-radius: 8px; background: linear-gradient(135deg, #d97706, #f59e0b); color: #000; font-size: 0.9rem; font-weight: 800; cursor: pointer;">Connect & Launch →</button>
                </div>

                <!-- Universal Plugin Card (Future Brokers) -->
                <div style="background: rgba(15, 23, 42, 0.35); border: 1px dashed rgba(255,255,255,0.15); border-radius: 16px; padding: 28px; opacity: 0.7;">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px;">
                        <span style="font-size: 2.2rem;">🔌</span>
                        <span style="padding: 4px 10px; background: rgba(255,255,255,0.06); color: #94a3b8; border-radius: 6px; font-size: 0.72rem; font-weight: 800;">UNIVERSAL FRAMEWORK</span>
                    </div>
                    <h3 style="font-size: 1.3rem; font-weight: 800; color: #94a3b8; margin-bottom: 6px;">+ Add Broker Plugin</h3>
                    <p style="font-size: 0.82rem; color: #64748b; margin-bottom: 22px; line-height: 1.5;">Zerodha, Dhan, AngelOne & custom brokers ready via BaseBroker plugin interface.</p>
                    <button disabled style="width: 100%; padding: 12px; border: none; border-radius: 8px; background: rgba(255,255,255,0.05); color: #64748b; font-size: 0.9rem; font-weight: 800; cursor: not-allowed;">Plugin Architecture Ready</button>
                </div>

            </div>
        </div>
    </div>

    <header style="padding: 6px 14px; background: rgba(15, 23, 42, 0.95); border-bottom: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: nowrap; overflow-x: auto;">
        <h1 class="logo" style="margin: 0; font-size: 1.1rem; font-weight: 900; white-space: nowrap; flex-shrink: 0;"><span>⚡</span> FnO Stock Trading Application</h1>
        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; flex-shrink: 0;">
            
            <!-- Broker Status Badge -->
            <div id="broker-status-badge" style="padding: 3px 8px; border-radius: 6px; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3); color: #38bdf8; font-size: 11px; font-weight: 800; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;">
                <span id="broker-badge-dot" style="width: 6px; height: 6px; border-radius: 50%; background: #38bdf8; display: inline-block;"></span>
                <span id="broker-badge-text">FLATTRADE: RUNNING</span>
            </div>

            <!-- Expiry Select -->
            <select id="global-expiry-select" onchange="app.changeGlobalExpiry(this.value)" style="width: auto; padding: 3px 6px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-lighter); color: var(--text-primary); font-size: 11px; font-weight: bold; cursor: pointer; outline: none; white-space: nowrap;">
                <option value="" disabled selected>Expiry</option>
                <option value="Near">Near OI</option>
                <option value="Next">Next OI</option>
                <option value="Far">Far OI</option>
            </select>

            <!-- Broker Select -->
            <select id="global-broker-select" onchange="app.changeBroker(this.value)" style="width: auto; padding: 3px 6px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-lighter); color: #38bdf8; font-size: 11px; font-weight: bold; cursor: pointer; outline: none; white-space: nowrap;">
                <option value="FLATTRADE">⚡ Flattrade</option>
                <option value="UPSTOX">🚀 Upstox</option>
                <option value="ZEBU">🐂 Zebu</option>
            </select>

            <!-- Home Button -->
            <button onclick="app.showLandingHome()" style="padding: 3px 8px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-lighter); color: var(--text-primary); font-size: 11px; font-weight: bold; cursor: pointer; outline: none; display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;">
                🏠 Home
            </button>

            <!-- Sync & Refresh Data Button -->
            <button id="btn-sync-refresh" onclick="app.syncAndRefreshData()" title="Re-sync master metrics & broker quote subscriptions without logging out or reloading page" style="padding: 3px 10px; border-radius: 4px; border: 1px solid #38bdf8; background: rgba(56, 189, 248, 0.12); color: #38bdf8; font-size: 11px; font-weight: bold; cursor: pointer; outline: none; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; transition: all 0.2s ease;">
                <span id="sync-refresh-icon">🔄</span> Sync &amp; Refresh
            </button>

            <!-- Trade Mode Toggle (Paper / Real Mode) -->
            <div class="trade-mode-toggle" style="display: inline-flex; border: 1px solid var(--border-color); border-radius: 4px; overflow: hidden; white-space: nowrap; flex-shrink: 0;">
                <button id="btn-paper-mode" onclick="app.setTradeMode('PAPER')" style="padding: 4px 10px; border: none; background: var(--profit); color: #fff; cursor: pointer; font-size: 11px; border-right: 1px solid var(--border-color); font-weight: bold; white-space: nowrap;">Paper Mode</button>
                <button id="btn-real-mode" onclick="app.setTradeMode('REAL')" style="padding: 4px 10px; border: none; background: var(--bg-lighter); color: var(--text-primary); cursor: pointer; font-size: 11px; font-weight: bold; white-space: nowrap;">Real Mode</button>
            </div>

            <!-- Socket Status -->
            <div class="status-indicator" style="display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; flex-shrink: 0;">
                <div class="dot" id="socket-status"></div>
                <span id="socket-text" style="font-size: 11px;">Disconnected</span>
            </div>
        </div>
    </header>

    <!-- INDEX TICKER (STATIC BOXES) -->
    <div class="index-ticker-container" style="display: flex; gap: 10px; padding: 8px 20px; background: rgba(0, 0, 0, 0.3); border-bottom: 1px solid var(--border-color); overflow-x: auto; align-items: center; white-space: nowrap;">
        <!-- NIFTY -->
        <div class="index-card" style="display: flex; align-items: center; gap: 8px; border: 1px solid rgba(255,255,255,0.12); padding: 4px 10px; border-radius: 6px; background: rgba(0,0,0,0.25); font-size: 0.85rem; font-weight: 500;">
            <span style="color: var(--text-secondary); font-weight: 600;">NIFTY</span>
            <span class="ticker-val" id="ticker-lp-NSE_26000" style="color: var(--text-primary); font-weight: 700;">--</span>
            <span id="ticker-change-NSE_26000" style="font-weight: 600;">--</span>
            <span id="ticker-pc-NSE_26000" style="font-weight: 600;">(--%)</span>
        </div>
        <!-- BANKNIFTY -->
        <div class="index-card" style="display: flex; align-items: center; gap: 8px; border: 1px solid rgba(255,255,255,0.12); padding: 4px 10px; border-radius: 6px; background: rgba(0,0,0,0.25); font-size: 0.85rem; font-weight: 500;">
            <span style="color: var(--text-secondary); font-weight: 600;">BANKNIFTY</span>
            <span class="ticker-val" id="ticker-lp-NSE_26009" style="color: var(--text-primary); font-weight: 700;">--</span>
            <span id="ticker-change-NSE_26009" style="font-weight: 600;">--</span>
            <span id="ticker-pc-NSE_26009" style="font-weight: 600;">(--%)</span>
        </div>
        <!-- SENSEX -->
        <div class="index-card" style="display: flex; align-items: center; gap: 8px; border: 1px solid rgba(255,255,255,0.12); padding: 4px 10px; border-radius: 6px; background: rgba(0,0,0,0.25); font-size: 0.85rem; font-weight: 500;">
            <span style="color: var(--text-secondary); font-weight: 600;">SENSEX</span>
            <span class="ticker-val" id="ticker-lp-BSE_1" style="color: var(--text-primary); font-weight: 700;">--</span>
            <span id="ticker-change-BSE_1" style="font-weight: 600;">--</span>
            <span id="ticker-pc-BSE_1" style="font-weight: 600;">(--%)</span>
        </div>
        <!-- BANKEX -->
        <div class="index-card" style="display: flex; align-items: center; gap: 8px; border: 1px solid rgba(255,255,255,0.12); padding: 4px 10px; border-radius: 6px; background: rgba(0,0,0,0.25); font-size: 0.85rem; font-weight: 500;">
            <span style="color: var(--text-secondary); font-weight: 600;">BANKEX</span>
            <span class="ticker-val" id="ticker-lp-BSE_12" style="color: var(--text-primary); font-weight: 700;">--</span>
            <span id="ticker-change-BSE_12" style="font-weight: 600;">--</span>
            <span id="ticker-pc-BSE_12" style="font-weight: 600;">(--%)</span>
        </div>
        <!-- INDIA VIX -->
        <div class="index-card" style="display: flex; align-items: center; gap: 8px; border: 1px solid rgba(255,255,255,0.12); padding: 4px 10px; border-radius: 6px; background: rgba(0,0,0,0.25); font-size: 0.85rem; font-weight: 500;">
            <span style="color: var(--text-secondary); font-weight: 600;">INDIA VIX</span>
            <span class="ticker-val" id="ticker-lp-NSE_26017" style="color: var(--text-primary); font-weight: 700;">--</span>
            <span id="ticker-change-NSE_26017" style="font-weight: 600;">--</span>
            <span id="ticker-pc-NSE_26017" style="font-weight: 600;">(--%)</span>
        </div>
    </div>

    <div class="container">
        <!-- Sidebar Configuration -->
        <aside class="sidebar">
            <!-- Login Panel -->
            <div class="panel" id="login-panel">
                <h3 style="margin-bottom: 15px;">API Credentials</h3>
                <div class="form-group">
                    <label>User ID</label>
                    <input type="text" id="userid" placeholder="Enter Shoonya User ID">
                </div>
                <div class="form-group">
                    <label>Password</label>
                    <input type="password" id="password" placeholder="Password">
                </div>
                <div class="form-group">
                    <label>TOTP Secret / PIN</label>
                    <input type="password" id="totp" placeholder="TOTP Secret">
                </div>
                <div class="form-group">
                    <label>Vendor Code</label>
                    <input type="text" id="vendor" placeholder="Vendor Code">
                </div>
                <div class="form-group">
                    <label>API Secret</label>
                    <input type="password" id="secret" placeholder="API Secret">
                </div>
                <button class="primary" onclick="app.login()">Connect to Shoonya</button>
            </div>

            <!-- Action Panel Removed -->
        </aside>

        <!-- Main Workspace -->
        <main class="workspace">
            <div class="panel" style="flex: 1; display:flex; flex-direction:column; padding: 0; overflow:hidden;">
                <!-- Tabs + Rank Controls Row (always visible) -->
                <div style="padding: 20px 20px 0 20px; display:flex; align-items:center; justify-content:space-between;">
                    <div class="tabs">
                        <div class="tab active" onclick="app.switchTab('live-data')">FnO Stocks</div>
                        <div class="tab" onclick="app.switchTab('futures')">Stock Futures</div>
                        <div class="tab" onclick="app.switchTab('positions')">Open Positions</div>
                        <div class="tab" onclick="app.switchTab('orders')">Order Book</div>
                        <div class="tab trade-ready-tab" onclick="app.switchTab('trade-ready')" id="tab-btn-trade-ready" style="border-left:2px solid var(--accent); color:var(--accent);">&#9889; Trade Ready</div>
                        <div class="tab" onclick="app.switchTab('trade-now')" id="tab-btn-trade-now" style="border-left:2px solid var(--profit); color:var(--profit); font-weight:700;">&#9654; Trade Entry</div>
                        <div class="tab" onclick="app.switchTab('trade-exit')" id="tab-btn-trade-exit" style="border-left:2px solid var(--loss); color:var(--loss); font-weight:700;">&#9632; Trade Exit</div>
                        <div class="tab" onclick="app.switchTab('trade-terminal')" id="tab-btn-trade-terminal" style="border-left:2px solid #a855f7; color:#a855f7; font-weight:700;">🖥️ Trade Terminal</div>
                    </div>
                    <!-- Rank Sort Controls in tab bar row -->
                    <div id="fno-rank-controls" style="display:flex; align-items:center; gap:6px; padding-right:4px;">
                        <span style="font-weight:600; font-size:0.78rem; color:var(--accent); white-space:nowrap;">Rank:</span>
                        <select id="rank-col-select" style="padding:3px 5px; font-size:0.78rem; border-radius:4px; background:var(--bg-lighter); color:var(--text-primary); border:1px solid var(--border-color); width:110px;">
                            <option value="" disabled selected>Select</option>
                            <option value="rank_vol">Avg Vol Rank</option>
                            <option value="rank_chg">Change Rank</option>
                            <option value="rank_abs_chg">ABS Chg Rank</option>
                            <option value="rank_oi">OI Rank</option>
                        </select>
                        <button id="sort-dir-btn" onclick="app.toggleSortDirection()" style="padding:3px 10px; font-size:0.78rem; font-weight:bold; background:var(--accent); color:#000; border:none; border-radius:4px; cursor:pointer; min-width:32px;">A</button>
                        <button onclick="app.moveToTradeReady()" style="padding:3px 10px; font-size:0.78rem; font-weight:bold; background:linear-gradient(135deg,#f59e0b,#d97706); border:none; border-radius:4px; cursor:pointer; color:#000;">&#9889; Move</button>
                    </div>
                </div>

                <!-- React Advanced Filters Control Panel Root -->
                <div id="react-control-panel-root"></div>

                <!-- Live Data Grid — FnO Stocks -->
                <div class="data-table-container" id="tab-live-data" style="margin: 0 20px 20px 20px; flex:1;">
                    <div id="react-streaming-grid-root"></div>
                </div>

                <!-- Trade Ready Grid -->
                <div class="data-table-container" id="tab-trade-ready" style="margin: 0 20px 20px 20px; flex:1; display:none;">
                    <div style="display:flex; align-items:center; justify-content:space-between; padding: 10px 5px 6px 5px;">
                        <div style="display:flex; align-items:center; gap:12px;">
                            <span style="font-size:1.1rem; font-weight:700; color:var(--accent);">⚡ Trade Ready Scrips</span>
                            <span id="trade-ready-count" style="padding:3px 10px; background:var(--accent); color:#000; border-radius:12px; font-size:0.8rem; font-weight:bold;">0 scrips</span>
                            <span id="trade-ready-sort-label" style="font-size:0.8rem; color:var(--text-secondary);"></span>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <input type="number" id="tr-send-count" value="6" min="1" max="50" style="width:40px; padding:4px; font-size:0.82rem; border-radius:4px; background:var(--bg-lighter); color:var(--text-primary); border:1px solid var(--border-color); text-align:center;" title="Number of scrips to send">
                            <select id="tr-send-method" style="padding:5px; font-size:0.82rem; border-radius:4px; background:var(--bg-lighter); color:var(--text-primary); border:1px solid var(--border-color);">
                                <option value="" disabled selected>Select</option>
                                <option value="top_change">Change% (High to Low)</option>
                                <option value="top_abs_change">ABS Change% (High to Low)</option>
                                <option value="top_oi">OI Change% (High to Low)</option>
                                <option value="top_vol">Volume Change% (High to Low)</option>
                                <option value="checked">Checked in Table</option>
                                <option value="top_visible">Current View (Top N)</option>
                            </select>
                            <button onclick="app.sendToTradeNow()" style="padding:5px 16px; font-size:0.82rem; font-weight:700; background:linear-gradient(135deg,var(--profit),#16a34a); color:#fff; border:none; border-radius:5px; cursor:pointer; box-shadow:0 2px 8px rgba(63,185,80,0.4);">&#9654; Trade Now →</button>
                            <button onclick="app.clearTradeReady()" style="padding:5px 14px; font-size:0.82rem; background:var(--bg-lighter); color:var(--text-primary); border:1px solid var(--border-color); border-radius:4px; cursor:pointer;">🗑 Clear</button>
                        </div>
                    </div>

                    <!-- Trade Ready Filter Bar (independent state from FnO filter bar) -->
                    <div id="trade-ready-filters"
                         style="margin: 0 0 8px 0; padding: 6px 12px;
                                background: rgba(251,191,36,0.07); border: 1px solid rgba(251,191,36,0.3);
                                border-radius: 8px; display: none; flex-wrap: nowrap;
                                gap: 6px; align-items: center; overflow-x: auto;">
                        <span style="font-weight:600; font-size:0.8rem; color:var(--accent); white-space:nowrap;">TR Filters:</span>
                        <div style="display:flex; gap:4px; align-items:center; flex-shrink:0;">
                            <select id="tr-f1-field" style="width:90px; padding:3px; font-size:0.78rem;">
                                <option value="" disabled selected>Select</option>
                                <option value="symbol">Name</option><option value="ltp">Spot LTP</option><option value="change">Spot Chg</option><option value="pc">Spot Chg%</option><option value="chg_vol_pc">Vol Chg%</option><option value="fut_ltp">Fut Price</option><option value="lotsize">Lot Size</option><option value="strike_diff">Strike Diff</option><option value="fut_pc">Fut Chg%</option><option value="oi_chg_pc">OI Chg%</option><option value="rank_chg">Price Rank</option><option value="rank_vol">Vol Rank</option><option value="rank_oi">OI Rank</option><option value="rank_abs_chg">Abs Rank</option><option value="atm_strike">ATM Strike</option>
                            </select>
                            <select id="tr-f1-op" style="width:55px; padding:3px; font-size:0.78rem;" onchange="app.handleTrOpChange(this)">
                                <option value="" disabled selected>Select</option>
                                <option value=">">&gt;</option><option value="<">&lt;</option><option value="=">=</option>
                                <option value="between">Betw</option><option value="!=0">!= 0</option><option value="isNum">isNum</option><option value="!=null">!=Null</option><option value="contains">In</option>
                            </select>
                            <input type="text" id="tr-f1-val" placeholder="Value" style="width:55px; padding:3px; font-size:0.78rem;">
                            <input type="text" id="tr-f1-val2" placeholder="To" style="width:55px; padding:3px; font-size:0.78rem; display:none;">
                        </div>
                        <div style="display:flex; gap:4px; align-items:center; flex-shrink:0;">
                            <select id="tr-f2-logic" style="width:46px; padding:3px; font-size:0.78rem;"><option value="" disabled selected>Select</option><option value="AND">AND</option><option value="OR">OR</option></select>
                            <select id="tr-f2-field" style="width:90px; padding:3px; font-size:0.78rem;">
                                <option value="" disabled selected>Select</option>
                                <option value="symbol">Name</option><option value="ltp">Spot LTP</option><option value="change">Spot Chg</option><option value="pc">Spot Chg%</option><option value="chg_vol_pc">Vol Chg%</option><option value="fut_ltp">Fut Price</option><option value="lotsize">Lot Size</option><option value="strike_diff">Strike Diff</option><option value="fut_pc">Fut Chg%</option><option value="oi_chg_pc">OI Chg%</option><option value="rank_chg">Price Rank</option><option value="rank_vol">Vol Rank</option><option value="rank_oi">OI Rank</option><option value="rank_abs_chg">Abs Rank</option><option value="atm_strike">ATM Strike</option>
                            </select>
                            <select id="tr-f2-op" style="width:55px; padding:3px; font-size:0.78rem;" onchange="app.handleTrOpChange(this)">
                                <option value="" disabled selected>Select</option>
                                <option value=">">&gt;</option><option value="<">&lt;</option><option value="=">=</option>
                                <option value="between">Betw</option><option value="!=0">!= 0</option><option value="isNum">isNum</option><option value="!=null">!=Null</option><option value="contains">In</option>
                            </select>
                            <input type="text" id="tr-f2-val" placeholder="Value" style="width:55px; padding:3px; font-size:0.78rem;">
                            <input type="text" id="tr-f2-val2" placeholder="To" style="width:55px; padding:3px; font-size:0.78rem; display:none;">
                        </div>
                        <div style="display:flex; gap:4px; align-items:center; flex-shrink:0;">
                            <select id="tr-f3-logic" style="width:46px; padding:3px; font-size:0.78rem;"><option value="" disabled selected>Select</option><option value="AND">AND</option><option value="OR">OR</option></select>
                            <select id="tr-f3-field" style="width:90px; padding:3px; font-size:0.78rem;">
                                <option value="" disabled selected>Select</option>
                                <option value="symbol">Name</option><option value="ltp">Spot LTP</option><option value="change">Spot Chg</option><option value="pc">Spot Chg%</option><option value="chg_vol_pc">Vol Chg%</option><option value="fut_ltp">Fut Price</option><option value="lotsize">Lot Size</option><option value="strike_diff">Strike Diff</option><option value="fut_pc">Fut Chg%</option><option value="oi_chg_pc">OI Chg%</option><option value="rank_chg">Price Rank</option><option value="rank_vol">Vol Rank</option><option value="rank_oi">OI Rank</option><option value="rank_abs_chg">Abs Rank</option><option value="atm_strike">ATM Strike</option>
                            </select>
                            <select id="tr-f3-op" style="width:55px; padding:3px; font-size:0.78rem;" onchange="app.handleTrOpChange(this)">
                                <option value="" disabled selected>Select</option>
                                <option value=">">&gt;</option><option value="<">&lt;</option><option value="=">=</option>
                                <option value="between">Betw</option><option value="!=0">!= 0</option><option value="isNum">isNum</option><option value="!=null">!=Null</option><option value="contains">In</option>
                            </select>
                            <input type="text" id="tr-f3-val" placeholder="Value" style="width:55px; padding:3px; font-size:0.78rem;">
                            <input type="text" id="tr-f3-val2" placeholder="To" style="width:55px; padding:3px; font-size:0.78rem; display:none;">
                        </div>
                        <div style="display:flex; gap:4px; align-items:center; flex-shrink:0;">
                            <select id="tr-f4-logic" style="width:46px; padding:3px; font-size:0.78rem;"><option value="" disabled selected>Select</option><option value="AND">AND</option><option value="OR">OR</option></select>
                            <select id="tr-f4-field" style="width:90px; padding:3px; font-size:0.78rem;">
                                <option value="" disabled selected>Select</option>
                                <option value="symbol">Name</option><option value="ltp">Spot LTP</option><option value="change">Spot Chg</option><option value="pc">Spot Chg%</option><option value="chg_vol_pc">Vol Chg%</option><option value="fut_ltp">Fut Price</option><option value="lotsize">Lot Size</option><option value="strike_diff">Strike Diff</option><option value="fut_pc">Fut Chg%</option><option value="oi_chg_pc">OI Chg%</option><option value="rank_chg">Price Rank</option><option value="rank_vol">Vol Rank</option><option value="rank_oi">OI Rank</option><option value="rank_abs_chg">Abs Rank</option><option value="atm_strike">ATM Strike</option>
                            </select>
                            <select id="tr-f4-op" style="width:55px; padding:3px; font-size:0.78rem;" onchange="app.handleTrOpChange(this)">
                                <option value="" disabled selected>Select</option>
                                <option value=">">&gt;</option><option value="<">&lt;</option><option value="=">=</option>
                                <option value="between">Betw</option><option value="!=0">!= 0</option><option value="isNum">isNum</option><option value="!=null">!=Null</option><option value="contains">In</option>
                            </select>
                            <input type="text" id="tr-f4-val" placeholder="Value" style="width:55px; padding:3px; font-size:0.78rem;">
                            <input type="text" id="tr-f4-val2" placeholder="To" style="width:55px; padding:3px; font-size:0.78rem; display:none;">
                        </div>
                        <div style="display:flex; gap:5px; margin-left:auto; align-items:center; flex-shrink:0;">
                            <button class="primary" style="padding:3px 10px; font-size:0.78rem;" onclick="app.applyTradeReadyFilters()">Apply</button>
                            <button style="padding:3px 10px; font-size:0.78rem;" onclick="app.clearTradeReadyFilters()">Clear</button>
                        </div>
                    </div>

                    <table class="flex-grid fno-header" id="trade-ready-table">
                        <thead class="fno-header">
                            <tr>
                                <th colspan="2" style="text-align:center;">Scrip</th>
                                <th colspan="4" style="background:rgba(59,130,246,0.25); color:#93c5fd; text-align:center;">━━ Spot ━━</th>
                                <th colspan="5" style="background:rgba(251,191,36,0.25); color:#000; text-align:center;" id="tr-fut-expiry-header">━━ Futures (Near Expiry) ━━</th>
                                <th colspan="5" style="background:rgba(139,92,246,0.25); color:#a78bfa; text-align:center;">━━ Ranks ━━</th>
                                <th colspan="1" style="background:rgba(16,185,129,0.25); color:var(--profit); text-align:center;">Options</th>
                                <th colspan="2" style="text-align:center;">Trade</th>
                            </tr>
                            <tr style="cursor:pointer;">
                                <th>S.No</th>
                                <th style="text-align:left;">Spot Name</th>
                                <th onclick="app.sortTradeReady('ltp')" style="background:rgba(59,130,246,0.12);">Spot LTP ↕</th>
                                <th onclick="app.sortTradeReady('change')" style="background:rgba(59,130,246,0.12);">Change ↕</th>
                                <th onclick="app.sortTradeReady('pc')" style="background:rgba(59,130,246,0.12);">Chg% ↕</th>
                                <th onclick="app.sortTradeReady('chg_vol_pc')" style="background:rgba(59,130,246,0.12);">Vol Chg% ↕</th>
                                <th onclick="app.sortTradeReady('fut_ltp')" style="background:rgba(251,191,36,0.12); color:var(--accent);">Future Price ↕</th>
                                <th onclick="app.sortTradeReady('lotsize')" style="background:rgba(251,191,36,0.12); color:var(--accent);">Lot Size ↕</th>
                                <th onclick="app.sortTradeReady('strike_diff')" style="background:rgba(251,191,36,0.12); color:var(--accent);">Strike Diff ↕</th>
                                <th onclick="app.sortTradeReady('fut_change')" style="background:rgba(251,191,36,0.12); color:var(--accent);">Fut Change ↕</th>
                                <th onclick="app.sortTradeReady('fut_pc')" style="background:rgba(251,191,36,0.12); color:var(--accent);">Fut Chg% ↕</th>
                                <th onclick="app.sortTradeReady('oi_chg_pc')">OI Change% ↕</th>
                                <th onclick="app.sortTradeReady('rank_chg')" style="background:rgba(139,92,246,0.1); color:#a78bfa;">Price Chg Rank ↕</th>
                                <th onclick="app.sortTradeReady('rank_vol')" style="background:rgba(139,92,246,0.1); color:#a78bfa;">Vol Rank ↕</th>
                                <th onclick="app.sortTradeReady('rank_oi')" style="background:rgba(139,92,246,0.1); color:#a78bfa;">OI Chg Rank ↕</th>
                                <th onclick="app.sortTradeReady('rank_abs_chg')" style="background:rgba(139,92,246,0.1); color:#a78bfa;">Abs Chg Rank ↕</th>
                                <th onclick="app.sortTradeReady('atm_strike')" style="background:rgba(16,185,129,0.12); color:var(--profit);">ATM Strike ↕</th>
                                <th>Select</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody id="trade-ready-body">
                            <tr><td colspan="19" style="text-align:center; color:var(--text-secondary); padding:50px;">No scrips moved yet. Use the "⚡ Move" button on FnO Stocks tab.</td></tr>
                        </tbody>
                    </table>
                </div>


                <!-- ═══════════════════════════════════════════════════════
                     TRADE ENTRY PAGE
                ═══════════════════════════════════════════════════════ -->
                <div class="data-table-container" id="tab-trade-now"
                     style="margin: 0 20px 20px 20px; flex:1; display:none; overflow-x:auto;">

                    <!-- Trade Entry Header -->
                    <div style="display:flex; align-items:center; justify-content:space-between; padding: 10px 5px 10px 5px;">
                        <div style="display:flex; align-items:center; gap:12px;">
                            <span style="font-size:1.2rem; font-weight:700; background:linear-gradient(135deg,var(--profit),#22c55e); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent;">&#9654; Trade Entry</span>
                            <span id="trade-now-count" style="padding:3px 10px; background:var(--profit); color:#000; border-radius:12px; font-size:0.8rem; font-weight:bold;">0 instruments</span>
                            <span style="padding:3px 8px; background:rgba(63,185,80,0.15); border:1px solid var(--profit); color:var(--profit); border-radius:4px; font-size:0.72rem; font-weight:600; letter-spacing:0.5px;">LIVE</span>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <!-- Bulk Controls -->
                            <select id="tn-bulk-side" style="padding:4px 8px; font-size:0.8rem; border-radius:4px; background:var(--bg-lighter); color:var(--text-primary); border:1px solid var(--border-color); outline:none; cursor:pointer;">
                                <option value="" disabled selected>Select Side</option>
                                <option value="BUY">Buy</option>
                                <option value="SELL">Sell</option>
                            </select>
                            <select id="tn-bulk-signal" style="padding:4px 8px; font-size:0.8rem; border-radius:4px; background:var(--bg-lighter); color:var(--text-primary); border:1px solid var(--border-color); outline:none; cursor:pointer;">
                                <option value="" disabled selected>Select Signal</option>
                                <option value="Aggressive_Entry">Aggressive Entry</option>
                                <option value="True_Limit_LTP">True Limit (LTP)</option>
                                <option value="Limit_Below">Limit Below</option>
                                <option value="Limit_Above">Limit Above</option>
                            </select>
                            <button id="btn-bulk-buy" onclick="app.submitBulkTradeEntry()" style="padding:4px 12px; font-size:0.8rem; font-weight:bold; background:var(--profit); color:#fff; border:none; border-radius:4px; cursor:pointer; margin-right:15px; display:inline-flex; align-items:center;">Buy</button>

                            <!-- Execution Engine Parameters -->
                            <div style="display:flex; align-items:center; gap:4px; margin-right: 10px; border-left: 1px solid var(--border-color); padding-left: 10px;">
                                <span style="font-size:0.75rem; color:var(--text-secondary);" title="Collar Boundary Tolerance % for Pegged Execution & Price Chasing">Collar %:</span>
                                <input type="number" id="tn-exec-slippage" value="3.0" step="0.5" style="width:45px; padding:3px; font-size:0.8rem; border-radius:4px; background:var(--bg-lighter); color:var(--text-primary); border:1px solid var(--border-color); text-align:center;">
                            </div>
                            <div style="display:flex; align-items:center; gap:4px; margin-right: 10px;">
                                <span style="font-size:0.75rem; color:var(--text-secondary);" title="Timeout in seconds before placing sweep order">Timeout (s):</span>
                                <input type="number" id="tn-exec-timeout" value="10" step="1" style="width:40px; padding:3px; font-size:0.8rem; border-radius:4px; background:var(--bg-lighter); color:var(--text-primary); border:1px solid var(--border-color); text-align:center;">
                            </div>
                            <div style="display:flex; align-items:center; gap:4px; margin-right: 10px;">
                                <span style="font-size:0.75rem; color:var(--text-secondary);" title="Maximum number of cancellation and replacement retries">Retries:</span>
                                <input type="number" id="tn-exec-retries" value="5" step="1" style="width:35px; padding:3px; font-size:0.8rem; border-radius:4px; background:var(--bg-lighter); color:var(--text-primary); border:1px solid var(--border-color); text-align:center;">
                            </div>

                            <label style="font-size:0.8rem; color:var(--accent); display:flex; align-items:center; gap:5px; font-weight:600;">
                                <input type="checkbox" id="tn-hedge-enable" onchange="app.renderTradeNowTable()" style="width:14px; height:14px;"> Add Hedge
                            </label>
                            <div style="display:flex; align-items:center; gap:4px; margin-right: 10px;">
                                <span style="font-size:0.75rem; color:var(--text-secondary);">Offset:</span>
                                <input type="number" id="tn-hedge-offset" value="1" onchange="app.renderTradeNowTable()" style="width:45px; padding:3px; font-size:0.8rem; border-radius:4px; background:var(--bg-lighter); color:var(--text-primary); border:1px solid var(--border-color); text-align:center;">
                            </div>
                            <button onclick="app.clearTradeNow()" style="padding:5px 14px; font-size:0.82rem; background:var(--bg-lighter); color:var(--text-primary); border:1px solid var(--border-color); border-radius:4px; cursor:pointer;">&#128465; Clear</button>
                        </div>
                    </div>

                    <table class="flex-grid" id="trade-now-table" style="min-width: 1400px;">
                        <thead class="fno-header">
                            <tr>
                                <th>S.No</th>
                                <th style="text-align:left; min-width:180px;">Symbol</th>
                                <th style="color:#93c5fd;">Best Buy</th>
                                <th style="color:#f87171;">Best Sell</th>
                                <th>LTP</th>
                                <th>High</th>
                                <th>Low</th>
                                <th>Change</th>
                                <th>% change</th>
                                <th>Qty</th>
                                <th>BUY/SELL</th>
                                <th>Entry Signal</th>
                                <th>Entry Limit Price</th>
                                <th>Entry Done @</th>
                                <th>Entry Order ID</th>
                                <th>Entry Remarks</th>
                                <th>OI</th>
                                <th>Action</th>
                                <th style="width: 40px; text-align: center;"><input type="checkbox" id="tn-select-all-main" onchange="app.toggleSelectAllMain(this.checked)" checked style="width:14px; height:14px; cursor:pointer;"></th>
                            </tr>
                        </thead>
                        <tbody id="trade-now-body">
                            <tr><td colspan="19" style="text-align:center; color:var(--text-secondary); padding:60px;">No instruments. Click "&#9654; Trade Now &rarr;" from Trade Ready to populate.</td></tr>
                        </tbody>
                    </table>

                    <div id="trade-now-hedge-section" style="margin-top: 20px; display:none;">
                        <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
                            <span style="font-size:1.0rem; font-weight:700; color:var(--accent);">&#128737;&#65039; Hedge Options</span>
                            <span id="trade-now-hedge-count" style="padding:3px 10px; background:rgba(99, 102, 241, 0.2); color:#6366f1; border-radius:12px; font-size:0.75rem; font-weight:bold; border: 1px solid #6366f1;">0 hedges</span>
                        </div>
                        <table class="flex-grid" id="trade-now-hedge-table" style="min-width: 1400px;">
                            <thead class="fno-header">
                                <tr>
                                    <th>S.No</th>
                                    <th style="text-align:left; min-width:180px;">Symbol</th>
                                    <th style="color:#93c5fd;">Best Buy</th>
                                    <th style="color:#f87171;">Best Sell</th>
                                    <th>LTP</th>
                                    <th>High</th>
                                    <th>Low</th>
                                    <th>Change</th>
                                    <th>% change</th>
                                    <th>Qty</th>
                                    <th>BUY/SELL</th>
                                    <th>Entry Signal</th>
                                    <th>Entry Limit Price</th>
                                    <th>Entry Done @</th>
                                    <th>Entry Order ID</th>
                                    <th>Entry Remarks</th>
                                    <th>OI</th>
                                    <th>Action</th>
                                    <th style="width: 40px; text-align: center;"><input type="checkbox" id="tn-select-all-hedge" onchange="app.toggleSelectAllHedge(this.checked)" checked style="width:14px; height:14px; cursor:pointer;"></th>
                                </tr>
                            </thead>
                            <tbody id="trade-now-hedge-body">
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- ═══════════════════════════════════════════════════════
                     TRADE EXIT PAGE
                ═══════════════════════════════════════════════════════ -->
                <div class="data-table-container" id="tab-trade-exit"
                     style="margin: 0 20px 20px 20px; flex:1; display:none; overflow-x:auto;">

                    <div style="display:flex; align-items:center; justify-content:space-between; padding: 10px 5px 10px 5px;">
                        <div style="display:flex; align-items:center; gap:12px;">
                            <span style="font-size:1.2rem; font-weight:700; color:var(--loss);">&#9632; Trade Exit</span>
                            <span id="trade-exit-count" style="padding:3px 10px; background:var(--loss); color:#000; border-radius:12px; font-size:0.8rem; font-weight:bold;">0 trades</span>
                            <div style="margin-left: 20px; display:flex; gap: 18px; flex-wrap:wrap; font-size: 0.88rem; font-weight:bold; background:rgba(0,0,0,0.3); padding:5px 16px; border-radius:15px; border:1px solid rgba(255,255,255,0.1); align-items:center;">
                                <span style="color:var(--text-secondary);">Broker MTM:&nbsp;<span id="te-broker-mtm" style="color:var(--text-primary);">&#8377;0.00</span></span>
                                <span style="color:rgba(255,255,255,0.15);">|</span>
                                <span style="color:var(--text-secondary);">Total P&amp;L:&nbsp;<span id="te-total-pl" style="color:var(--text-primary);">&#8377;0.00</span></span>
                                <span style="color:rgba(255,255,255,0.15);">|</span>
                                <span style="color:var(--text-secondary);">Open P&amp;L:&nbsp;<span id="te-open-pl" style="color:var(--text-primary);">&#8377;0.00</span></span>
                                <span style="color:rgba(255,255,255,0.15);">|</span>
                                <span style="color:var(--text-secondary);">Capital Blocked:&nbsp;<span id="te-capital-blocked" style="color:var(--text-primary);">&#8377;0.00</span></span>
                            </div>
                        </div>
                        <div style="display:flex; align-items:center; gap:15px;">
                            <div style="display:flex; align-items:center; gap:6px;">
                                <input type="checkbox" id="te-overall-target-active" style="width:16px; height:16px;">
                                <span style="font-weight:600; font-size:0.85rem; color:var(--text-primary);">Overall Target:</span>
                                <input type="number" id="te-overall-target" placeholder="Amt" style="width:70px; padding:4px; font-size:0.85rem; border-radius:4px; border:1px solid var(--border-color); background:var(--bg-lighter); color:var(--text-primary);">
                            </div>
                            <button class="primary" style="background:var(--accent); color:#000; padding:6px 12px; font-weight:bold;" onclick="app.cancelSelectedTrades()">Cancel</button>
                            <button class="primary" style="background:var(--loss); padding:6px 12px; font-weight:bold;" onclick="app.exitAllTrades()">EXIT ALL</button>
                        </div>
                    </div>

                    <table class="flex-grid" id="trade-exit-table" style="min-width: 1600px;">
                        <thead class="fno-header">
                            <tr>
                                <th>S.No</th>
                                <th style="text-align:left; min-width:160px;">Symbol</th>
                                <th title="Total quantity">Qty</th>
                                <th>Side</th>
                                <th>Status</th>
                                <th>Entry @</th>
                                <th>LTP</th>
                                <th>Chg2Entry</th>
                                <th>% Chg2Entry</th>
                                <th style="color:var(--accent);">Tot P&amp;L (₹)</th>
                                <th title="SL Type">SL Type</th>
                                <th title="Total ₹ loss for this trade. SL price = Entry ± (SL₹ ÷ LotSize)">SL Val(₹)</th>
                                <th title="Initial SL price = Entry ± (SL₹ ÷ LotSize) — computed from SL Value">SL Price</th>
                                <th title="Trailing Stop Loss: SL moves up with LTP on every tick" style="text-align:center;">
                                    TSL <br>
                                    <input type="checkbox" id="te-master-tsl" onchange="app.toggleMasterTSL(this.checked)" style="width:14px; height:14px; margin-top:3px; cursor:pointer;">
                                </th>
                                <th title="Latest trailing SL price (updates on every tick when TSL is ON)">Latest SL</th>
                                <th title="Move SL to entry cost when ₹ profit reaches this amount">SL2Cost(₹)</th>
                                <th title="Target profit in ₹ — auto-exit when P&amp;L reaches this">Target(₹)</th>
                                <th title="Computed price level where Target ₹ will be hit">Tgt Price</th>
                                <th>Add/Exit</th>
                                <th>Exit Mode</th>
                                <th>Exit Price</th>
                                <th>Exit @</th>
                                <th>Select</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody id="trade-exit-body">
                            <tr><td colspan="24" style="text-align:center; color:var(--text-secondary); padding:60px;">No active or pending trades to manage.</td></tr>
                        </tbody>
                    </table>

                    <div id="trade-exit-hedge-section" style="margin-top: 20px; display:none;">
                        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
                            <span style="font-size:1.0rem; font-weight:700; color:var(--accent);">&#128737;&#65039; Hedge Exits</span>
                            <span id="trade-exit-hedge-count" style="padding:3px 10px; background:rgba(99, 102, 241, 0.2); color:#6366f1; border-radius:12px; font-size:0.75rem; font-weight:bold; border: 1px solid #6366f1;">0 hedges</span>
                            <div style="margin-left:8px; display:flex; gap:16px; font-size:0.85rem; font-weight:bold; background:rgba(0,0,0,0.3); padding:4px 14px; border-radius:15px; border:1px solid rgba(99,102,241,0.25); align-items:center;">
                                <span style="color:var(--text-secondary);">Hedge Total P&amp;L:&nbsp;<span id="te-hedge-total-pl" style="color:var(--text-primary);">&#8377;0.00</span></span>
                                <span style="color:rgba(255,255,255,0.15);">|</span>
                                <span style="color:var(--text-secondary);">Hedge Open P&amp;L:&nbsp;<span id="te-hedge-open-pl" style="color:var(--text-primary);">&#8377;0.00</span></span>
                            </div>
                        </div>
                        <table class="flex-grid" id="trade-exit-hedge-table" style="min-width: 1600px;">
                            <thead class="fno-header">
                                <tr>
                                    <th>S.No</th>
                                    <th style="text-align:left; min-width:160px;">Symbol</th>
                                    <th title="Total quantity">Qty</th>
                                    <th>Side</th>
                                    <th>Status</th>
                                    <th>Entry @</th>
                                    <th>LTP</th>
                                    <th>Chg2Entry</th>
                                    <th>% Chg2Entry</th>
                                    <th style="color:var(--accent);">Tot P&amp;L (₹)</th>
                                    <th title="SL Type">SL Type</th>
                                    <th title="Total ₹ loss">SL Val(₹)</th>
                                    <th title="Initial SL price computed from SL Value">SL Price</th>
                                    <th title="Trailing Stop Loss" style="text-align:center;">
                                        TSL <br>
                                        <input type="checkbox" id="te-master-tsl-hedge" onchange="app.toggleMasterTSLHedge(this.checked)" style="width:14px; height:14px; margin-top:3px; cursor:pointer;">
                                    </th>
                                    <th title="Latest trailing SL price">Latest SL</th>
                                    <th title="Move SL to cost when ₹ profit reaches this">SL2Cost(₹)</th>
                                    <th title="Target profit in ₹">Target(₹)</th>
                                    <th title="Computed target price level">Tgt Price</th>
                                    <th>Add/Exit</th>
                                    <th>Exit Mode</th>
                                    <th>Exit Price</th>
                                    <th>Exit @</th>
                                    <th>Select</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody id="trade-exit-hedge-body">
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- ═══════════════════════════════════════════════════════
                     TRADE TERMINAL PAGE
                ═══════════════════════════════════════════════════════ -->
                <div class="data-table-container" id="tab-trade-terminal"
                     style="margin: 0 20px 20px 20px; flex:1; display:none; overflow-x:auto;">
                    
                    <div style="display:flex; align-items:center; justify-content:space-between; padding: 10px 5px 10px 5px;">
                        <div style="display:flex; align-items:center; gap:12px;">
                            <span style="font-size:1.2rem; font-weight:700; color:#a855f7;">🖥️ Trade Terminal</span>
                            <span id="trade-terminal-count" style="padding:3px 10px; background:#a855f7; color:#000; border-radius:12px; font-size:0.8rem; font-weight:bold;">0 rows</span>
                            <div style="margin-left: 10px; display:flex; gap: 15px; font-size: 0.95rem; font-weight:bold; background:rgba(0,0,0,0.3); padding:4px 15px; border-radius:15px; border:1px solid rgba(255,255,255,0.1);">
                                <span style="color:var(--text-secondary);">Terminal P&amp;L: <span id="term-table-mtm" style="color:var(--text-primary);">&#8377;0.00</span></span>
                            </div>
                            <span style="font-size:0.75rem; color:var(--text-secondary); margin-left: 5px;">(Drag columns by headers to rearrange)</span>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <button class="primary" style="background:#22c55e; padding:6px 14px; font-weight:bold; color:#000; border:none; border-radius:4px; cursor:pointer;" onclick="app.submitAllTerminalEntries()">EXECUTE ALL ▶</button>
                            <button class="primary" style="background:var(--accent); color:#000; padding:6px 12px; font-weight:bold; border:none; border-radius:4px; cursor:pointer;" onclick="app.cancelSelectedTerminalTrades()">Cancel</button>
                            <button class="primary" style="background:var(--loss); padding:6px 12px; font-weight:bold; border:none; border-radius:4px; cursor:pointer;" onclick="app.exitAllTerminalTrades()">EXIT ALL</button>
                            <button class="primary" style="background:#a855f7; padding:6px 12px; font-weight:bold; color:#000; border:none; border-radius:4px; cursor:pointer;" onclick="app.addTerminalRow()">Add Next Row (+)</button>
                        </div>
                    </div>
                    
                    <table class="flex-grid" id="trade-terminal-table" style="min-width: 2500px;">
                        <thead class="fno-header">
                            <tr id="trade-terminal-headers">
                                <!-- Rendered dynamically in app.js for drag and drop rearrangement -->
                            </tr>
                        </thead>
                        <tbody id="trade-terminal-body">
                            <!-- Rendered dynamically in app.js -->
                        </tbody>
                    </table>
                </div>

                <!-- Futures Grid -->
                <div class="data-table-container" id="tab-futures" style="margin: 0 20px 20px 20px; flex:1; display:none;">
                    <div id="react-futures-root"></div>
                </div>

                <!-- Positions Grid -->
                <div class="data-table-container" id="tab-positions" style="margin: 0 20px 20px 20px; flex:1; display:none;">
                    <table>
                        <thead>
                            <tr>
                                <th>Symbol</th>
                                <th>Product</th>
                                <th>Net Qty</th>
                                <th>Avg Price</th>
                                <th>LTP</th>
                                <th>M2M PnL</th>
                            </tr>
                        </thead>
                        <tbody id="positions-body">
                            <!-- Rows injected by JS -->
                        </tbody>
                    </table>
                </div>

                <!-- Orders Grid -->
                <div class="data-table-container" id="tab-orders" style="margin: 0 20px 20px 20px; flex:1; display:none;">
                    <table>
                        <thead>
                            <tr>
                                <th onclick="app.sortOrders('norenordno')" style="cursor:pointer;white-space:nowrap;">Order No <span id="ob-sort-norenordno">↕</span></th>
                                <th onclick="app.sortOrders('tsym')" style="cursor:pointer;">Symbol <span id="ob-sort-tsym">↕</span></th>
                                <th>Type</th>
                                <th onclick="app.sortOrders('trantype')" style="cursor:pointer;">B/S <span id="ob-sort-trantype">↕</span></th>
                                <th onclick="app.sortOrders('qty')" style="cursor:pointer;">Qty <span id="ob-sort-qty">↕</span></th>
                                <th onclick="app.sortOrders('prc')" style="cursor:pointer;white-space:nowrap;">Price <span id="ob-sort-prc">↕</span></th>
                                <th onclick="app.sortOrders('avgprc')" style="cursor:pointer;white-space:nowrap;">Avg Price <span id="ob-sort-avgprc">↕</span></th>
                                <th onclick="app.sortOrders('status')" style="cursor:pointer;">Status <span id="ob-sort-status">↕</span></th>
                                <th onclick="app.sortOrders('norentm')" style="cursor:pointer;white-space:nowrap;">Date &amp; Time <span id="ob-sort-norentm">↕</span></th>
                                <th>Remarks</th>
                            </tr>
                        </thead>
                        <tbody id="orders-body">
                            <!-- Rows injected by JS -->
                        </tbody>
                    </table>
                </div>

            </div>
        </main>
    </div>

    <div class="notifications" id="notifications">
        <!-- Toasts injected here -->
    </div>

    <script>
        document.write('<script type="text/babel" src="react_app.js?v=' + new Date().getTime() + '"><\/script>');
    </script>
    <!-- ════════════════════════════════════════════════════════
         ADD POSITION MODAL — shown when "Add" is selected in Trade Exit
         ════════════════════════════════════════════════════════ -->
    <div id="add-position-modal" style="
        display:none; position:fixed; inset:0; z-index:9999;
        background:rgba(0,0,0,0.75); backdrop-filter:blur(6px);
        align-items:center; justify-content:center;">

        <div style="
            background:var(--bg-card); border:1px solid var(--border-color);
            border-radius:16px; box-shadow:0 24px 64px rgba(0,0,0,0.6);
            width:700px; max-width:96vw; padding:0; overflow:hidden;
            animation: modalPop 0.18s cubic-bezier(.175,.885,.32,1.275);">

            <!-- Header -->
            <div style="
                background:linear-gradient(135deg,rgba(var(--profit-rgb,.2,224,143),0.15),rgba(59,130,246,0.12));
                border-bottom:1px solid var(--border-color);
                padding:18px 24px; display:flex; align-items:center; justify-content:space-between;">
                <div>
                    <div style="font-size:1.1rem;font-weight:800;color:var(--text-primary);letter-spacing:0.5px;">
                        ➕ Add to Position
                    </div>
                    <div id="add-modal-subtitle" style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;"></div>
                </div>
                <button onclick="app.closeAddModal()" style="
                    background:transparent;border:1px solid var(--border-color);
                    color:var(--text-secondary);border-radius:8px;padding:6px 12px;
                    cursor:pointer;font-size:0.85rem;transition:all 0.15s;"
                    onmouseover="this.style.background='var(--bg-lighter)'"
                    onmouseout="this.style.background='transparent'">✕ Close</button>
            </div>

            <!-- Live Price Strip -->
            <div style="
                background:var(--bg-lighter); border-bottom:1px solid var(--border-color);
                padding:10px 24px; display:flex; align-items:center; gap:32px;">
                <div style="display:flex;flex-direction:column;align-items:center;">
                    <span style="font-size:0.68rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:1px;">LTP</span>
                    <span id="add-modal-ltp" style="font-size:1.25rem;font-weight:800;color:var(--accent);">—</span>
                </div>
                <div style="display:flex;flex-direction:column;align-items:center;">
                    <span style="font-size:0.68rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:1px;">Bid</span>
                    <span id="add-modal-bid" style="font-size:1rem;font-weight:700;color:#93c5fd;">—</span>
                </div>
                <div style="display:flex;flex-direction:column;align-items:center;">
                    <span style="font-size:0.68rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:1px;">Ask</span>
                    <span id="add-modal-ask" style="font-size:1rem;font-weight:700;color:#f87171;">—</span>
                </div>
                <div style="display:flex;flex-direction:column;align-items:center;">
                    <span style="font-size:0.68rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:1px;">High</span>
                    <span id="add-modal-high" style="font-size:0.95rem;font-weight:600;color:var(--profit);">—</span>
                </div>
                <div style="display:flex;flex-direction:column;align-items:center;">
                    <span style="font-size:0.68rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:1px;">Low</span>
                    <span id="add-modal-low" style="font-size:0.95rem;font-weight:600;color:var(--loss);">—</span>
                </div>
                <div style="display:flex;flex-direction:column;align-items:center;">
                    <span style="font-size:0.68rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:1px;">OI</span>
                    <span id="add-modal-oi" style="font-size:0.95rem;font-weight:600;color:var(--text-primary);">—</span>
                </div>
            </div>

            <!-- 4×4 Grid of Entry Fields -->
            <div style="padding:24px; display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:18px 20px;">

                <!-- Row 1 -->
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.72rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.8px;">Symbol</label>
                    <input id="add-modal-symbol" type="text" readonly style="
                        padding:10px 12px;background:var(--bg-lighter);border:1px solid var(--border-color);
                        border-radius:8px;color:var(--text-primary);font-weight:700;font-size:0.85rem;
                        cursor:not-allowed;opacity:0.8;">
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.72rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.8px;">Exchange</label>
                    <input id="add-modal-exchange" type="text" readonly style="
                        padding:10px 12px;background:var(--bg-lighter);border:1px solid var(--border-color);
                        border-radius:8px;color:var(--text-primary);font-size:0.85rem;
                        cursor:not-allowed;opacity:0.8;">
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.72rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.8px;">Lot Size</label>
                    <input id="add-modal-lotsize" type="text" readonly style="
                        padding:10px 12px;background:var(--bg-lighter);border:1px solid var(--border-color);
                        border-radius:8px;color:var(--accent);font-weight:700;font-size:0.85rem;
                        cursor:not-allowed;opacity:0.8;">
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.72rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.8px;">Original Entry @</label>
                    <input id="add-modal-entryat" type="text" readonly style="
                        padding:10px 12px;background:var(--bg-lighter);border:1px solid var(--border-color);
                        border-radius:8px;color:var(--profit);font-weight:700;font-size:0.85rem;
                        cursor:not-allowed;opacity:0.8;">
                </div>

                <!-- Row 2 -->
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.72rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.8px;">Qty to Add</label>
                    <input id="add-modal-qty" type="number" min="1" placeholder="Enter qty" style="
                        padding:10px 12px;background:var(--bg-lighter);border:1px solid var(--border-color);
                        border-radius:8px;color:var(--text-primary);font-weight:700;font-size:0.85rem;
                        outline:none;transition:border 0.15s;"
                        onfocus="this.style.borderColor='var(--accent)'"
                        onblur="this.style.borderColor='var(--border-color)'">
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.72rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.8px;">Side</label>
                    <select id="add-modal-side" style="
                        padding:10px 12px;background:var(--bg-lighter);border:1px solid var(--border-color);
                        border-radius:8px;color:var(--text-primary);font-size:0.85rem;
                        outline:none;cursor:pointer;transition:border 0.15s;"
                        onfocus="this.style.borderColor='var(--accent)'"
                        onblur="this.style.borderColor='var(--border-color)'"
                        onchange="app.addModalRefreshPrice()">
                        <option value="" disabled selected>Select</option>
                        <option value="BUY">BUY</option>
                        <option value="SELL">SELL</option>
                    </select>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.72rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.8px;">Order Type</label>
                    <select id="add-modal-signal" onchange="app.addModalSignalChange()" style="
                        padding:10px 12px;background:var(--bg-lighter);border:1px solid var(--border-color);
                        border-radius:8px;color:var(--text-primary);font-size:0.85rem;
                        outline:none;cursor:pointer;transition:border 0.15s;"
                        onfocus="this.style.borderColor='var(--accent)'"
                        onblur="this.style.borderColor='var(--border-color)'">
                        <option value="" disabled selected>Select</option>
                        <option value="Market">Market</option>
                        <option value="LTP">LTP</option>
                        <option value="Limit">Limit</option>
                    </select>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.72rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.8px;">Limit Price</label>
                    <input id="add-modal-limit" type="number" step="0.05" disabled placeholder="Auto" style="
                        padding:10px 12px;background:var(--bg-lighter);border:1px solid var(--border-color);
                        border-radius:8px;color:var(--text-primary);font-size:0.85rem;
                        outline:none;transition:border 0.15s;"
                        onfocus="this.style.borderColor='var(--accent)'"
                        onblur="this.style.borderColor='var(--border-color)'">
                </div>

                <!-- Row 3 — SL & Target for this additional tranche -->
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.72rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.8px;">SL Value (₹)</label>
                    <input id="add-modal-slvalue" type="number" placeholder="e.g. 500" style="
                        padding:10px 12px;background:var(--bg-lighter);border:1px solid var(--border-color);
                        border-radius:8px;color:var(--loss);font-size:0.85rem;
                        outline:none;transition:border 0.15s;"
                        onfocus="this.style.borderColor='var(--loss)'"
                        onblur="this.style.borderColor='var(--border-color)'">
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.72rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.8px;">Target (₹)</label>
                    <input id="add-modal-target" type="number" placeholder="e.g. 1000" style="
                        padding:10px 12px;background:var(--bg-lighter);border:1px solid var(--border-color);
                        border-radius:8px;color:var(--profit);font-size:0.85rem;
                        outline:none;transition:border 0.15s;"
                        onfocus="this.style.borderColor='var(--profit)'"
                        onblur="this.style.borderColor='var(--border-color)'">
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.72rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.8px;">SL2Cost (₹)</label>
                    <input id="add-modal-sl2cost" type="number" placeholder="e.g. 300" style="
                        padding:10px 12px;background:var(--bg-lighter);border:1px solid var(--border-color);
                        border-radius:8px;color:var(--accent);font-size:0.85rem;
                        outline:none;transition:border 0.15s;"
                        onfocus="this.style.borderColor='var(--accent)'"
                        onblur="this.style.borderColor='var(--border-color)'">
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.72rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.8px;">Trail SL (TSL)</label>
                    <div style="padding:10px 12px;background:var(--bg-lighter);border:1px solid var(--border-color);border-radius:8px;display:flex;align-items:center;gap:10px;">
                        <input id="add-modal-tsl" type="checkbox" style="width:18px;height:18px;cursor:pointer;accent-color:var(--profit);">
                        <span style="font-size:0.82rem;color:var(--text-secondary);">Enable TSL</span>
                    </div>
                </div>

                <!-- Row 4 — Status + Submit span full width -->
                <div id="add-modal-status-box" style="
                    grid-column:1/4; display:flex; align-items:center;
                    background:rgba(255,255,255,0.04); border:1px solid var(--border-color);
                    border-radius:8px; padding:12px 16px; gap:10px; min-height:44px;">
                    <span style="font-size:0.75rem;color:var(--text-secondary);font-style:italic;">Fill in fields above and click Submit.</span>
                </div>
                <div style="display:flex;flex-direction:column;justify-content:flex-end;">
                    <button id="add-modal-submit-btn" onclick="app.submitAddPosition()" style="
                        padding:12px 0;border:none;border-radius:8px;font-size:0.9rem;font-weight:800;
                        background:linear-gradient(135deg,var(--profit),#16a34a);color:#fff;
                        cursor:pointer;letter-spacing:0.5px;transition:all 0.15s;
                        box-shadow:0 4px 16px rgba(0,200,100,0.3);"
                        onmouseover="this.style.transform='translateY(-1px)';this.style.boxShadow='0 6px 24px rgba(0,200,100,0.45)'"
                        onmouseout="this.style.transform='';this.style.boxShadow='0 4px 16px rgba(0,200,100,0.3)'">
                        ➕ Submit Add Order
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- BROKER SELECTION MODAL -->
    <div id="broker-selection-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.85); backdrop-filter:blur(8px); z-index:10000; align-items:center; justify-content:center;">
        <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:16px; width:480px; max-width:90%; padding:28px; box-shadow:0 24px 60px rgba(0,0,0,0.7); animation:modalPop 0.25s ease-out;">
            <div style="text-align:center; margin-bottom:24px;">
                <h2 style="font-size:1.4rem; font-weight:800; color:var(--text-primary); margin-bottom:8px;">⚡ Connect Broker Account</h2>
                <p style="font-size:0.85rem; color:var(--text-secondary);">Select which broker API to connect for real-time market data & order execution.</p>
            </div>
            
            <div style="display:flex; flex-direction:column; gap:14px; margin-bottom:24px;">
                <!-- Flattrade Card -->
                <div onclick="app.selectBrokerModal('FLATTRADE')" style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px; background:var(--bg-lighter); border:2px solid var(--border-color); border-radius:12px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.borderColor='#38bdf8'; this.style.transform='translateY(-2px)'" onmouseout="this.style.borderColor='var(--border-color)'; this.style.transform=''">
                    <div style="display:flex; align-items:center; gap:14px;">
                        <span style="font-size:1.8rem;">⚡</span>
                        <div>
                            <div style="font-weight:800; font-size:1.05rem; color:var(--text-primary);">Flattrade Broker</div>
                            <div style="font-size:0.75rem; color:var(--text-secondary);">Free API • Noren/PiConnect Engine</div>
                        </div>
                    </div>
                    <button style="padding:6px 16px; border:none; border-radius:6px; background:#38bdf8; color:#000; font-size:0.8rem; font-weight:800; cursor:pointer;">Connect</button>
                </div>

                <!-- Upstox Card -->
                <div onclick="app.selectBrokerModal('UPSTOX')" style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px; background:var(--bg-lighter); border:2px solid var(--border-color); border-radius:12px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.borderColor='#a855f7'; this.style.transform='translateY(-2px)'" onmouseout="this.style.borderColor='var(--border-color)'; this.style.transform=''">
                    <div style="display:flex; align-items:center; gap:14px;">
                        <span style="font-size:1.8rem;">🚀</span>
                        <div>
                            <div style="font-weight:800; font-size:1.05rem; color:var(--text-primary);">Upstox Broker API v2</div>
                            <div style="font-size:0.75rem; color:var(--text-secondary);">OAuth 2.0 • Protobuf WebSocket Stream</div>
                        </div>
                    </div>
                    <button style="padding:6px 16px; border:none; border-radius:6px; background:#a855f7; color:#fff; font-size:0.8rem; font-weight:800; cursor:pointer;">Connect</button>
                </div>
            </div>

            <div style="text-align:center;">
                <button onclick="document.getElementById('broker-selection-modal').style.display='none'" style="background:transparent; border:none; color:var(--text-secondary); font-size:0.8rem; cursor:pointer; text-decoration:underline;">Skip & Continue in Paper Mode</button>
            </div>
        </div>
    </div>

    <style>
        @keyframes modalPop {
            from { opacity:0; transform:scale(0.88) translateY(16px); }
            to   { opacity:1; transform:scale(1) translateY(0); }
        }
        #add-position-modal.open { display:flex !important; }
    </style>

</body>
</html>
```
\n
### File: `static/style.css`
```css
:root {
    --bg-color: #0a0f1d;
    --bg-lighter: #1e293b;
    --panel-bg: rgba(15, 23, 42, 0.65);
    --border-color: rgba(56, 189, 248, 0.15);
    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --accent: #38bdf8; /* Electric Cyan */
    --accent-hover: #0ea5e9;
    --profit: #10b981; /* Emerald Green */
    --loss: #f43f5e; /* Ruby Crimson */
    --warning: #f59e0b; /* Amber */
    --glass-blur: 16px;
    --font-main: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

/* Custom Scrollbars */
::-webkit-scrollbar {
    width: 8px;
    height: 8px;
}
::-webkit-scrollbar-track {
    background: rgba(15, 23, 42, 0.5);
}
::-webkit-scrollbar-thumb {
    background: rgba(56, 189, 248, 0.2);
    border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
    background: rgba(56, 189, 248, 0.4);
}

body {
    background-color: var(--bg-color);
    background-image: 
        radial-gradient(circle at 5% 10%, rgba(56, 189, 248, 0.08) 0%, transparent 35%),
        radial-gradient(circle at 90% 80%, rgba(168, 85, 247, 0.06) 0%, transparent 35%),
        linear-gradient(rgba(56, 189, 248, 0.06) 1px, transparent 1px),
        linear-gradient(90deg, rgba(56, 189, 248, 0.06) 1px, transparent 1px);
    background-size: 100% 100%, 100% 100%, 30px 30px, 30px 30px;
    color: var(--text-primary);
    font-family: var(--font-main);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
}

/* Glassmorphism Panel */
.panel {
    background: var(--panel-bg);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 20px;
    box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.05), 0 8px 32px 0 rgba(0, 0, 0, 0.4);
    transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
}

.panel:hover {
    border-color: rgba(56, 189, 248, 0.25);
    box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.08), 0 12px 40px 0 rgba(56, 189, 248, 0.08);
}

header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 15px 30px;
    border-bottom: 1px solid var(--border-color);
    background: rgba(10, 15, 29, 0.8);
    backdrop-filter: blur(8px);
    position: sticky;
    top: 0;
    z-index: 100;
}

h1.logo {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 10px;
}

h1.logo span {
    color: var(--accent);
    text-shadow: 0 0 10px rgba(56, 189, 248, 0.5);
}

.status-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
    font-weight: 500;
}

.dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background-color: var(--loss);
    box-shadow: 0 0 8px var(--loss);
    transition: background-color 0.3s, box-shadow 0.3s;
}

.dot.connected {
    background-color: var(--profit);
    box-shadow: 0 0 8px var(--profit);
}

.container {
    flex: 1;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 24px;
    max-width: 99%;
    margin: 0 auto;
    width: 100%;
}

/* Sidebar & Forms */
.sidebar {
    display: flex;
    flex-direction: column;
    gap: 24px;
    max-width: 400px;
    margin: 0 auto;
}

.form-group {
    margin-bottom: 15px;
}

.form-group label {
    display: block;
    margin-bottom: 5px;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--accent);
}

input,
select {
    width: 100%;
    padding: 10px 12px;
    background: rgba(15, 23, 42, 0.8);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 0.95rem;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
}

input:focus,
select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);
}

select option {
    background-color: #1e293b !important;
    color: #f8fafc !important;
}

button {
    width: 100%;
    padding: 10px 16px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    background: rgba(30, 41, 59, 0.6);
    color: var(--text-primary);
}

button:hover {
    background: rgba(51, 65, 85, 0.8);
    border-color: rgba(56, 189, 248, 0.3);
}

button.primary {
    background: linear-gradient(135deg, var(--accent-hover), var(--accent));
    color: #0f172a;
    border: none;
    font-weight: 700;
    box-shadow: 0 4px 12px rgba(56, 189, 248, 0.25);
}

button.primary:hover {
    background: linear-gradient(135deg, var(--accent), #7dd3fc);
    transform: translateY(-1px);
    box-shadow: 0 6px 16px rgba(56, 189, 248, 0.35);
}

button.success {
    background: rgba(16, 185, 129, 0.2);
    border-color: rgba(16, 185, 129, 0.4);
    color: var(--profit);
}
button.success:hover {
    background: rgba(16, 185, 129, 0.3);
}

button.danger {
    background: rgba(244, 63, 94, 0.2);
    border-color: rgba(244, 63, 94, 0.4);
    color: var(--loss);
}
button.danger:hover {
    background: rgba(244, 63, 94, 0.3);
}

/* Main Workspace */
.workspace {
    display: flex;
    flex-direction: column;
    gap: 24px;
}

.tabs {
    display: flex;
    gap: 10px;
    border-bottom: 2px solid var(--border-color);
    margin-bottom: 20px;
}

.tab {
    padding: 10px 20px;
    cursor: pointer;
    color: var(--text-secondary);
    font-weight: 600;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    transition: all 0.2s;
}

.tab:hover {
    color: var(--text-primary);
}

.tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    text-shadow: 0 0 8px rgba(56, 189, 248, 0.3);
}

/* Data Table (Grid) */
.data-table-container {
    overflow: auto;
    max-height: calc(100vh - 320px);
    border-radius: 8px;
    border: 1px solid var(--border-color);
    background: rgba(10, 15, 29, 0.5);
    box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.3);
}

/* Frozen Header Row */
.data-table-container thead th {
    position: sticky;
    top: 0;
    z-index: 10;
    background: #0f172a;
    box-shadow: 0 2px 4px rgba(0,0,0,0.4);
}

/* Frozen Columns */
.data-table-container .excel-grid tbody td:first-child {
    position: sticky;
    left: 0;
    z-index: 5;
    background: #0f172a;
    min-width: 50px;
    box-shadow: 2px 0 4px rgba(0,0,0,0.3);
}
.data-table-container .excel-grid thead th:first-child {
    position: sticky;
    left: 0;
    z-index: 20;
    background: #1e293b;
    min-width: 50px;
    box-shadow: 2px 0 4px rgba(0,0,0,0.3);
}

.data-table-container .excel-grid tbody td:nth-child(2) {
    position: sticky;
    left: 50px;
    z-index: 5;
    background: #0f172a;
    min-width: 150px;
    box-shadow: 2px 0 4px rgba(0,0,0,0.3);
}
.data-table-container .excel-grid thead th:nth-child(2) {
    position: sticky;
    left: 50px;
    z-index: 20;
    background: #1e293b;
    min-width: 150px;
    box-shadow: 2px 0 4px rgba(0,0,0,0.3);
}

.data-table-container .excel-grid tbody tr:hover td:first-child,
.data-table-container .excel-grid tbody tr:hover td:nth-child(2) {
    background: #1e293b !important;
}

#tab-futures .data-table-container thead th {
    background: #0f172a;
}

#tab-futures .data-table-container .excel-grid tbody td:first-child {
    background: #0f172a;
}
#tab-futures .data-table-container .excel-grid thead th:first-child {
    background: #1e293b;
}

#tab-futures .data-table-container .excel-grid tbody td:nth-child(2) {
    background: #0f172a;
}
#tab-futures .data-table-container .excel-grid thead th:nth-child(2) {
    background: #1e293b;
}

table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
    white-space: nowrap;
}

th,
td {
    padding: 12px 16px;
    border-bottom: 1px solid rgba(56, 189, 248, 0.1);
}

th {
    background: rgba(15, 23, 42, 0.95);
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.5px;
}

th[onclick] {
    cursor: pointer;
    user-select: none;
}

th[onclick]:hover {
    background: rgba(56, 189, 248, 0.08);
    color: var(--accent);
}

.fno-header th {
    background: #1e293b !important;
    color: var(--accent) !important;
    font-weight: 700;
    border: 1px solid rgba(56, 189, 248, 0.25);
    letter-spacing: 0.5px;
    font-size: 0.85rem;
    z-index: 10;
}

.fno-header th:hover {
    background: rgba(56, 189, 248, 0.08) !important;
    color: #e0f2fe !important;
}

tr:hover {
    background: rgba(56, 189, 248, 0.04);
}

.trade-actions {
    display: flex;
    gap: 8px;
}

.trade-actions button {
    padding: 5px 10px;
    font-size: 0.8rem;
    width: auto;
}

/* Utilities */
.text-profit {
    color: var(--profit) !important;
    text-shadow: 0 0 5px rgba(16, 185, 129, 0.4);
}

.text-loss {
    color: var(--loss) !important;
    text-shadow: 0 0 5px rgba(244, 63, 94, 0.4);
}

/* Notifications Menu */
.notifications {
    position: fixed;
    bottom: 20px;
    right: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    z-index: 1000;
}

.toast {
    background: var(--panel-bg);
    border-left: 4px solid var(--accent);
    backdrop-filter: blur(10px);
    padding: 15px 20px;
    border-radius: 6px;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5);
    color: var(--text-primary);
    animation: slideIn 0.3s ease-out forwards;
    min-width: 250px;
}

@keyframes slideIn {
    from {
        transform: translateX(100%);
        opacity: 0;
    }
    to {
        transform: translateX(0);
        opacity: 1;
    }
}

/* Excel-like Grid */
.excel-grid {
    border-collapse: collapse;
    font-size: 0.85rem;
    table-layout: fixed;
    width: 100%;
}

.excel-grid td {
    padding: 6px 12px;
    border: 1px solid rgba(56, 189, 248, 0.1);
    text-align: right;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.excel-grid th {
    padding: 8px 12px;
    border: 1px solid rgba(56, 189, 248, 0.15);
    text-align: center;
    vertical-align: middle;
    white-space: normal;
    word-wrap: break-word;
    line-height: 1.2;
}

/* Column width definitions */
.excel-grid th:nth-child(1),
.excel-grid td:nth-child(1) { width: 60px; min-width: 60px; } /* S.No */

.excel-grid th:nth-child(2),
.excel-grid td:nth-child(2) { width: 150px; min-width: 150px; } /* Name */

.excel-grid th:nth-child(n+3),
.excel-grid td:nth-child(n+3) { width: 100px; min-width: 100px; } /* Default for others */

/* ── Trade Ready & Trade Now ── */
.flex-grid {
    border-collapse: collapse;
    font-size: 0.85rem;
    table-layout: auto;
    width: 100%;
}

.flex-grid td {
    padding: 6px 12px;
    border: 1px solid rgba(56, 189, 248, 0.1);
    text-align: right;
    white-space: nowrap;
}

.flex-grid th {
    padding: 8px 12px;
    border: 1px solid rgba(56, 189, 248, 0.15);
    text-align: center;
    vertical-align: middle;
    white-space: normal;
    word-break: normal;
    line-height: 1.2;
    position: relative;
    overflow: visible;
}

.flex-grid th:nth-child(1), .flex-grid td:nth-child(1) { min-width: 48px;  } /* S.No */
.flex-grid th:nth-child(2), .flex-grid td:nth-child(2) { min-width: 120px; text-align: left; } /* Name */

/* Futures specific column widths */
#futures-body th:nth-child(3),
#futures-body td:nth-child(3) { width: 90px; } /* Lot Size */

#futures-body th:nth-child(4),
#futures-body td:nth-child(4) { width: 100px; } /* Strike Diff */

#futures-body th:nth-child(5),
#futures-body td:nth-child(5) { width: 110px; } /* Expiry Date */

/* FREEZE FIRST 2 COLUMNS IN BODY ONLY */
.data-table-container .excel-grid td:first-child {
    position: sticky;
    left: 0;
    z-index: 5;
    background: rgba(15, 23, 42, 0.98);
    border-right: 2px solid rgba(56, 189, 248, 0.2);
}

.data-table-container .excel-grid td:nth-child(2) {
    position: sticky;
    left: 60px;
    z-index: 5;
    background: rgba(15, 23, 42, 0.98);
    text-align: left;
}

.excel-grid tr:nth-child(even) {
    background: rgba(255, 255, 255, 0.015);
}

.excel-grid tr:hover {
    background: rgba(56, 189, 248, 0.08);
}

.bg-profit-light {
    background: rgba(16, 185, 129, 0.1) !important;
}

.bg-loss-light {
    background: rgba(244, 63, 94, 0.1) !important;
}

@keyframes ticker {
    0% { transform: translateX(0); }
    100% { transform: translateX(-100%); }
}
```
\n
### File: `static/react_app.js`
```javascript
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
```
\n
### File: `static/worker.js`
```javascript
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
```
\n
### File: `static/app.js`
```javascript
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
```
\n
### File: `Flattrade/Flattrade_Creds.txt`
```text
Vendor code:	FZ31110
Password:	Amma@312
TOTP :		PM263N53PU4765472TH7BFZHX464J745
API key : 	fce3c4a6bbff4458b5417d882ea59798
API Secret:	2026.62d759e547f045afb0de2a2679d947dfa894eb2b7324000c
redirectURL: 	http://127.0.0.1:8095/flattrade/callback
```
\n
### File: `Upstox/Upstox_Creds.txt`
```text
User_code	:	2DCYAV
Static IP	:	49.204.168.42
API Key		: 	445bbbd2-d56b-48c3-bbec-120bf6a1d8e1
API Secret	:	yzqz28t8xq
TOTP		:	3M6HOZO4U2TWVTLC6NHNS5CKTG3YSUZM
Redirect URL	:	http://localhost:8095/upstox/callback
Pin		:	258247
Mobile 		: 	8555947993
Access_Token	:	eyJ0eXAiOiJKV1QiLCJrZXlfaWQiOiJza192MS4wIiwiYWxnIjoiSFMyNTYifQ.eyJzdWIiOiIyRENZQVYiLCJqdGkiOiI2YTdhODdjMjdhY2IyNTE5MDQzNTZjZGUiLCJpc011bHRpQ2xpZW50IjpmYWxzZSwiaXNQbHVzUGxhbiI6ZmFsc2UsImlhdCI6MTc4NjQxNTA0MiwiaXNzIjoidWRhcGktZ2F0ZXdheS1zZXJ2aWNlIiwiZXhwIjoxNzg2NDg1NjAwfQ.8v7iMm0-hZ5JBbFP_tWsDfQ95t8E9Q1KXhhLrXwC6SU
Token_Date	:	2026-08-11
```
\n
### File: `Zebu/Zebu_Creds.txt`
```text
Vendor code	:	Z50011
Password	:	Ragram@312
TOTP		:	5757XV35F4L7PG6246C6AT5VX2O2R546
API key		: 	tAWUq655s6zmu65cDUuB3m277ca2CeRn
API Secret	:	nQF2tQgypa3gwCOj8b4dFxiymj22pxhA
redirectURL	: 	http://127.0.0.1:5000/zebu/callback
Client_Id	:	Z50011_U
```
\n
---

## SECTION 4: DEPENDENCIES & ENVIRONMENT

### 4.1 Python Dependencies (`requirements.txt`)
- `fastapi>=0.110.0`: High-performance asynchronous REST and WebSocket server.
- `uvicorn>=0.28.0`: Lightning-fast ASGI web server implementation.
- `websockets>=12.0`: WebSocket protocol client and server utilities.
- `websocket-client>=1.7.0`: Synchronous WebSocket client used by NorenApi.
- `pandas>=2.2.0`: High-speed data manipulation for F&O master CSVs.
- `numpy>=1.26.0`: Numerical calculations for strike intervals and ATR.
- `requests>=2.31.0`: Synchronous HTTP client for REST authentication.
- `httpx>=0.27.0`: Asynchronous HTTP client.
- `pyotp>=2.9.0`: RFC 6238 TOTP generator for automated headless broker logins.
- `selenium>=4.18.0`: Automated browser automation for Zebu and Upstox OAuth callbacks.
- `openpyxl>=3.1.2`: Excel read/write engine for `Master_data.xlsx`.

### 4.2 System Requirements & Execution Environment
- **Operating System**: Windows 10/11 (PowerShell / Command Prompt).
- **Python Version**: Python 3.10, 3.11, or 3.12 (64-bit recommended).
- **Browser Drivers**: Google Chrome and matching `chromedriver` installed and available in PATH (for automated headless OAuth flows).
- **Network Ports**:
  - `8095`: Primary terminal port.
  - `8000`: Companion/Tick-Relay port.
  - `5000`: Local redirect capture listener for Zebu OAuth callback (`http://127.0.0.1:5000/zebu/callback`).

---

## SECTION 5: PROMPT LOG, DESIGN DECISIONS & CONVERSATIONAL CONTEXT

### 5.1 The WebSocket Zombie Loop Incident & Diagnosis
- **Symptom**: Console terminal spammed repeatedly every 100ms with:
  `WARNING - websocket run forever ended in exception, socket is already opened`
  Logs inflated by over 800,000 lines within minutes, consuming 100% of a CPU thread and freezing UI updates.
- **Root Cause Identified**:
  Flattrade upstream Cloudflare proxy restarts triggered `__on_close_callback()`, setting `self.__websocket_connected = False`.
  When reconnection logic ran, it called `api.close_websocket()`. In `NorenApi`:
  ```python
  def close_websocket(self):
      if self.__websocket_connected == False:
          return  # BUG: Does nothing because connection already marked False!
      self.__stop_event.set()
      ...
  ```
  Consequently, `__stop_event` was never signaled and `__ws_thread` was never joined. When `api.start_websocket()` was invoked, a new `WebSocketApp` was assigned to `self.__websocket` and a second thread spawned. The old zombie thread waking up every 100ms attempted to run `.run_forever()` on the open socket, triggering `socket is already opened` in an infinite loop.
- **Architectural Solution Implemented (Way 1 Subclassing)**:
  Overrode `close_websocket()`, `_ws_run_forever()`, and `start_websocket()` in `FlatTradeApiPy` and `ZebuApiPy`:
  1. Unconditionally set `stop_event.set()`, closed the socket, and joined the worker thread with a 2.0s timeout.
  2. Catches `"already opened"` in `_ws_run_forever()` and immediately breaks/terminates the thread.
  3. Replaced 100ms busy-spin with 1.0s backoff.
  4. Wrapped reconnection in reentrant mutex locks (`_flattrade_ws_lock`, `_ws_lock`) to serialize reconnection attempts.

### 5.2 10-Day FIFO Log Retention Architecture
- **Problem**: Size-based rotation (`RotatingFileHandler(20MB, 5 backups)`) kept over 105MB of `.1` through `.5` files without calendar-day correlation.
- **Architectural Solution Implemented (Way 3 Hybrid)**:
  1. Standardized on `TimedRotatingFileHandler` with `when="midnight"`, `interval=1`, `backupCount=10`, and date suffixes (`app_log.txt.YYYY-MM-DD`).
  2. Implemented `enforce_log_retention(retention_days=10)` which scans date suffixes, sorts chronologically, and deletes files older than 10 calendar days in FIFO order.
  3. Purged legacy size-based `.1` through `.5` files.
  4. Hooked into both startup initialization (`setup_logging()`) and daily morning market refresh (`ensure_daily_master_data()`).

### 5.3 Strict Operating Constraints Established
1. **Approval-First Execution Protocol**: Never apply modifications to workspace files without first analyzing options, presenting a clear recommendation, and receiving an explicit "go" command from the user.
2. **Directory Synchronization**: Maintain strict parity between `brokers/` and `broker/` packages so all import paths remain functional.
3. **Preservation of Documentation & Blueprints**: Maintain comprehensive architecture documentation (`SYSTEM_BLUEPRINT.md`, `README.md`, and this master archive) so the entire system can be reconstituted in an empty workspace with zero loss of knowledge.\n
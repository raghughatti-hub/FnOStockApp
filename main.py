# Application assembly: preserve state ownership and registration/startup order.
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
    from broker import flattrade_broker, execution_engine
    from broker.canonical_symbol_mapper import canonical_mapper
except ModuleNotFoundError:
    from brokers import flattrade_broker, execution_engine
    from brokers.canonical_symbol_mapper import canonical_mapper

try:
    from data.fno_strike_calculator import load_and_calculate_fno_data
except ModuleNotFoundError:
    try:
        from fno_strike_calculator import load_and_calculate_fno_data
    except ModuleNotFoundError:
        from get_strike_difference_all import load_and_calculate_fno_data
from broker.flattrade_broker import (
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

from broker.broker_manager import broker_manager
from broker.flattrade_broker import FlattradeBroker
from broker.upstox_broker import UpstoxBroker
from broker.zebu_broker import ZebuBroker

flattrade_plugin = FlattradeBroker()
upstox_plugin = UpstoxBroker()
zebu_plugin = ZebuBroker()

broker_manager.register_broker(flattrade_plugin)
broker_manager.register_broker(upstox_plugin)
broker_manager.register_broker(zebu_plugin)

# === Broker selection and daily data lifecycle === #
# === Broker selection and daily data lifecycle === #
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
from utilities.filters import evaluate_condition_pandas


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
from broker import zebu_broker
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

# === Background scheduling and startup (ordered) === #
# === Background scheduling and startup (ordered) === #
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

# === HTTP contracts (public re-exports) === #
# === HTTP contracts (public re-exports) === #
from models.api import LoginParams

from models.api import SubscriptionParams

from models.api import BulkSubscriptionParams

from models.api import TradeOrderParams

from models.api import CancelOrderParams

from models.api import TradeModeParams

from models.api import SubsystemResponse

# Broker callback dependencies share the application-owned instances.
from broker import callbacks as broker_callbacks
broker_callbacks.app_state = app_state
broker_callbacks.upstox_plugin = upstox_plugin
broker_callbacks.logger = logger

flattrade_callback = app.get("/flattrade/callback")(broker_callbacks.flattrade_callback)

upstox_callback = app.get("/upstox/callback")(broker_callbacks.upstox_callback)

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

from models.api import ClientErrorParams

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
    from broker.canonical_symbol_mapper import canonical_mapper
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
from models.api import CanonicalResolveParams

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

# === Generic order submission and cancellation === #
# === Generic order submission and cancellation === #
@app.post("/api/place_order")
async def api_place_order(params: TradeOrderParams):
    is_paper = (getattr(app_state, 'trade_mode', 'PAPER') == "PAPER")
    if not is_paper:
        active_broker = broker_manager.get_active_broker()
        if not active_broker or not active_broker.is_logged_in():
            raise HTTPException(status_code=401, detail="Broker is not logged in")

    if params.execution_mode:
        from broker.execution_engine import start_execution_engine
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

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
from broker.base_broker import BaseBroker
from broker.resource_paths import LEGACY_BROKER_RESOURCE_DIR

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

ZEBU_CACHE_FILE = os.path.join(LEGACY_BROKER_RESOURCE_DIR, "historical_cache_zebu.json")
ROOT_CACHE_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "historical_cache.json")
ZEBU_CREDS_FILE = os.path.join(LEGACY_BROKER_RESOURCE_DIR, "Zebu_Creds.txt")

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

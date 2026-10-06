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
from broker.base_broker import BaseBroker

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



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
from broker.base_broker import BaseBroker
from broker.resource_paths import LEGACY_BROKER_RESOURCE_DIR

logger = logging.getLogger("WebTraderApi.Upstox")

UPSTOX_CACHE_FILE = os.path.join(LEGACY_BROKER_RESOURCE_DIR, "historical_cache_upstox.json")
ROOT_CACHE_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "historical_cache.json")
UPSTOX_CREDS_FILE = os.path.join(LEGACY_BROKER_RESOURCE_DIR, "Upstox_Creds.txt")

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
        upstox_creds_path = os.path.join(LEGACY_BROKER_RESOURCE_DIR, "Upstox_Creds.txt")
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


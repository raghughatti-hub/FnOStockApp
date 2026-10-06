# System Architecture & Technical Blueprint

**Project**: FnO Stock Trading Application (Enterprise Edition)  
**Target Environment**: Windows / Python 3.10+  
**Architecture Style**: Asynchronous Micro-Monolith (FastAPI + React + Multi-Broker Plugins)  
**Last Updated**: September 2026

---

## 1. System Architecture Overview

The FnO Stock Trading Application is an algorithmic options and futures trading terminal designed for high-frequency market data streaming, dynamic strike calculations, and multi-broker execution with zero downtime.

```
+-------------------------------------------------------------------------+
|                              React Frontend                             |
|          (Live Scalper Grid, Options Matrix, Order Chaser Panel)        |
+------------------------------------+------------------------------------+
                                     | WebSocket / REST (Port 8095 or 8000)
+------------------------------------v------------------------------------+
|                         FastAPI Core Engine (main.py)                   |
|  - Active Broker Switcher & Token Session Management                    |
|  - Live Data In-Memory Cache (LTP, Depth, Greeks, ATR)                  |
|  - Daily Master Data Pipeline (NSE/NFO Download & Strike Diff Sync)     |
|  - Multi-Client Broadcast WebSocket Manager                             |
+---------+--------------------------+--------------------------+---------+
          |                          |                          |
          v                          v                          v
+-------------------+      +-------------------+      +-------------------+
|  Flattrade Broker |      |   Upstox Broker   |      |    Zebu Broker    |
|  - FlatTradeApiPy |      |   - Polling/REST  |      |   - ZebuApiPy     |
|  - Zero-Zombie WS |      |   - V3 Stream     |      |   - Zero-Zombie WS|
+---------+---------+      +-------------------+      +---------+---------+
          |                                                     |
          +--------------------------+--------------------------+
                                     |
                                     v
                  +--------------------------------------+
                  |           Dual-Server Relay          |
                  |  Port 8095 <-----> Port 8000 Relay   |
                  +--------------------------------------+
```

---

## 2. Multi-Broker Abstraction Layer

The application isolates broker-specific authentication, market streaming, and order placement behind a standardized interface:

### 2.1 Component Structure
- **`BaseBroker` (`brokers/base_broker.py`)**: Defines the contract for all broker integrations:
  - `login()`: Multi-factor authentication (TOTP, OAuth, Selenium).
  - `is_logged_in()`: Session token status check.
  - `subscribe(tokens)`: Touchline and depth market subscription.
  - `place_order()`, `modify_order()`, `cancel_order()`: Standardized execution.
  - `get_positions()`, `get_orders()`, `get_limits()`: Portfolio synchronization.
- **`BrokerManager` (`brokers/broker_manager.py`)**:
  - Dynamically registers broker plugins (`FLATTRADE`, `UPSTOX`, `ZEBU`).
  - Routes active market subscriptions and execution requests to the selected broker without restarting the FastAPI server.
- **`CanonicalSymbolMapper` (`brokers/canonical_symbol_mapper.py`)**:
  - Normalizes symbols across brokers (e.g. converting between Flattrade tokens, Upstox instrument keys, and standard NSE trading symbols).
- **`ExecutionEngine` (`brokers/execution_engine.py`)**:
  - Manages **PAPER** vs **REAL** trade modes.
  - Implements dynamic limit order chasing (tracking bid/ask spreads and modifying pending orders until filled or timed out).

---

## 3. WebSocket Streaming Engine & Lifecycle Management

A critical component of the platform is reliable market data streaming. The application interfaces with brokers utilizing the Noren/Shoonya protocol (Flattrade and Zebu).

### 3.1 The Zombie Reconnect Problem (Resolved)
In the standard `NorenRestApiPy` and `myntapi` packages:
1. When a WebSocket drops (e.g., Cloudflare proxy resets, network hiccups), `__on_close_callback()` sets `__websocket_connected = False`.
2. The library's `close_websocket()` contains a faulty guard:
   ```python
   if self.__websocket_connected == False:
       return  # BUG: Exits immediately without signaling stop or joining thread!
   ```
3. When reconnection logic calls `api.start_websocket()`, a second worker thread is created on a new `WebSocketApp`.
4. The first worker thread remains trapped in its internal `while not stop_event.is_set():` loop, calling `.run_forever()` on the new socket.
5. The `websocket-client` library detects the open socket and throws `WebSocketException: socket is already opened`.
6. This causes a tight 100ms infinite loop (10 warnings/second, flooding logs with hundreds of thousands of lines and freezing the app).

### 3.2 The Zero-Zombie Lifecycle Specification
Both `FlatTradeApiPy` (in `brokers/flattrade_broker.py`) and `ZebuApiPy` (in `brokers/zebu_broker.py`) override the socket lifecycle:

1. **Unconditional Teardown (`close_websocket`)**:
   - Explicitly sets `stop_event.set()` regardless of `__websocket_connected`.
   - Closes the active `WebSocketApp` instance.
   - Joins the background worker thread with a 2.0-second timeout.
   - Resets all internal socket and thread references to `None`.
2. **Graceful Zombie Exit (`_ws_run_forever`)**:
   - Catches `WebSocketException`. If `"already opened"` is detected, the redundant thread logs a graceful exit message and **breaks immediately** from the loop.
   - Increases retry sleep backoff from 100ms to 1.0s to prevent busy-spinning.
3. **Clean Pre-Initialization (`start_websocket`)**:
   - Always invokes `self.close_websocket()` before instantiating a new `WebSocketApp` and starting a worker thread.
4. **Thread Serialization Locks**:
   - Reconnection routines (`ensure_websocket_or_relay` and `start_websocket`) are guarded by `threading.Lock()` to prevent race conditions during sudden network drops.
5. **Auto-Reconnection & Portfolio Re-Subscription**:
   - Background loops monitor connection health and automatically restore all active subscriptions upon reconnect.

---

## 4. 10-Day FIFO Log Retention Engine

To maintain high I/O performance and prevent disk exhaustion, the logging system operates on a 10-day FIFO (First-In, First-Out) time-based rotation.

### 4.1 Configuration (`config/settings.py`)
- `LOG_FILE: str = "app_log.txt"`: Active log destination.
- `LOG_RETENTION_DAYS: int = 10`: Retention window in calendar days.
- `LOG_BACKUP_COUNT: int = 10`: Number of daily backups retained.

### 4.2 Logging Engine (`config/logging_config.py`)
1. **Midnight Timed Rotation**:
   - Uses `TimedRotatingFileHandler` with `when="midnight"`, `interval=1`, and `backupCount=10`.
   - Rotated files receive ISO date stamps: `app_log.txt.YYYY-MM-DD`.
2. **FIFO Retention Sweeper (`enforce_log_retention`)**:
   - Regex-scans for date-stamped logs (`app_log.txt.YYYY-MM-DD`).
   - Chronologically sorts matching logs (oldest first).
   - Prunes any log files older than 10 calendar days.
   - If more than 10 files exist, discards the oldest surplus files in FIFO order.
   - Automatically purges legacy size-based numeric backups (`app_log.txt.[1-9]*`).
3. **Execution Hooks**:
   - **On Startup**: Run immediately in `setup_logging()` before server boots.
   - **Every Morning**: Triggered in `ensure_daily_master_data()` during the 1st login market initialization.

---

## 5. Dual-Server Tick Relay Architecture

To support parallel testing or running two app instances simultaneously (e.g. on Port 8095 and Port 8000) without broker WebSocket connection conflicts:

1. **Port Detection**:
   - The application inspects its assigned port at launch.
2. **Relay Check**:
   - Before opening a direct broker WebSocket connection, it checks whether the companion port (e.g. 8000 if running on 8095) is active and authenticated to Flattrade.
3. **Tick Relay Bridge**:
   - If the other server is active, it connects to the local server's internal tick relay WebSocket (`ws://127.0.0.1:{other_port}/ws/stream`) instead of opening a duplicate session with the broker.
   - If the primary server goes down, the standby server automatically falls back to standard broker WebSocket mode.

---

## 6. Daily Instrument & Strike Calculation Pipeline

1. **Daily Master Data Download (`data/download_instruments.py`)**:
   - Checks modification time of `Instrument/NFO_symbols.csv` and `Master_data.csv`.
   - If the file is from a previous date (or missing), fetches fresh instrument master files from NSE/NFO.
2. **Strike Difference Calculator (`data/fno_strike_calculator.py`)**:
   - Analyzes ATM strike intervals and contract lot sizes across all ~216 F&O underlying assets.
   - Caches results to `Master_data.csv` and `Master_data.xlsx`.
3. **Historical Metrics Cache**:
   - Asynchronously fetches 14-day average trading volume and ATR from the broker REST API.
   - Persists metrics to `historical_cache.json` to prevent API rate-limit bottlenecks.

---

## 7. Operations & Maintenance Runbook

### 7.1 Starting the Application
- **Default Port 8095**: `run_app_8095.bat`
- **Companion Port 8000**: `run_app.bat`

### 7.2 Credentials Storage
Store API keys in their respective broker folders:
- Flattrade: `Flattrade/Flattrade_Creds.txt`
- Upstox: `Upstox/Upstox_Creds.txt`
- Zebu: `Zebu/Zebu_Creds.txt`

### 7.3 Log Inspection
- Current live log: `app_log.txt`
- Past 10 days of history: `app_log.txt.YYYY-MM-DD`

---

## 8. Pegged Limit Collar Order Execution Engine

To prevent order fills into illiquid spreads or manipulated asks (e.g. illiquid strikes with Ask at `13.55` while LTP is `7.00` and Best Buy is `8.25`), the execution engine enforces strict Pegged Limit Boundaries with zero market sweeping.

### 8.1 Mathematical Collar Boundaries
- **Collar Percentage (`collar%`)**: User-defined from UI (`tn-exec-slippage`), defaulting to **`3.0%`**.
- **BUY Boundary**:
  $$\text{Upper Boundary} = \text{round\_to\_tick}(\max(\text{LTP}, \text{Best Buy}) \times (1 + \text{collar\%}), \text{round\_down}=\text{True})$$
  $$\text{Initial Price} = \min(\text{Best Buy} + \text{Tick}, \text{Upper Boundary})$$
- **SELL Boundary**:
  $$\text{Lower Boundary} = \max(\text{Tick}, \text{round\_to\_tick}(\min(\text{LTP}, \text{Best Sell}) \times (1 - \text{collar\%}), \text{round\_up}=\text{True}))$$
  $$\text{Initial Price} = \max(\text{Best Sell} - \text{Tick}, \text{Lower Boundary})$$

### 8.2 Dynamic Chasing & Safety Constraints
1. **Tick-by-Tick Pegged Chasing**:
   - The worker thread recalculates `Upper Boundary` / `Lower Boundary` on every live quote update.
   - For BUY, chasing price can never exceed `Upper Boundary`.
   - For SELL, chasing price can never drop below `Lower Boundary`.
2. **Strict Order Serialization**:
   - Previous child order is canceled and confirmed before placing a replacement child order.
   - Prevents duplicate order fills or orphaned orders.
3. **Entry Orders vs. Exit Orders Lifecycle**:
   - **Entry Orders (`Aggressive_Entry`, `Limit_Below`, `Limit_Above`, `True_Limit_LTP`)**:
     - **Range-Bound Only**: Zero time-bound cutoffs. Entry orders are **never cancelled due to an elapsed timer**.
     - If market price moves within collar bounds, orders dynamically chase up to the boundary.
     - If market price moves outside collar bounds, the order **rests passively at the collar limit** in the exchange book rather than cancelling.
     - Stays active until filled, rejected by the exchange, or cancelled by the user via the UI.
   - **Exit Orders (`Aggressive_Exit`)**:
     - Retains the 10.0s adaptive escalation and timeout resting quote safeguard to ensure intraday positions are never left unclosed before market close.

### 8.3 Strict Tick-Size Conformance (0.05 Paise Minimum)
- In accordance with Indian exchange rules (NFO, NSE, BSE, MCX), option and equity order prices and fills are strictly clamped to multiples of **0.05** (5 paise). Currency derivatives (CDS) trade in **0.0025** ticks.
- Erroneous `0.01` tick entries from broker CSV master files are strictly sanitized across master CSVs, backend loaders, the execution engine (`round_to_tick`), and UI order generation.

### 8.4 In-Flight Atomic Modification Architecture
To eliminate excessive cancel-replace latency and prevent broker rate-limit throttling (HTTP 429), the execution engine implements native `modify_order`:
- **Fast Path**: When price moves, calls `broker.modify_order(order_id, new_price, new_qty)`. Single hop (~50ms) preserves exchange queue priority.
- **Fallback Path**: If modification is rejected or unsupported, automatically falls back to confirmed serialization: `cancel_order` -> await cancellation -> `place_order`.
- **Supported Across All Brokers**: Implemented natively in `FlattradeBroker` (`ModifyOrder`), `ZebuBroker` (`modifyOrder`), `UpstoxBroker` (`PUT /order/modify`), and `paper_orders` virtual engine.

### 8.5 Adaptive 2-Stage Intraday Exit Escalation
- **Stage 1 (0.0s - 4.0s)**: Pegs passively to inside depth (`Best Sell - Tick` / `Best Buy + Tick`) within the 3.0% collar boundary.
- **Stage 2 (> 4.0s)**: Adaptively widens collar tolerance up to 8.0% and matches resting quotes (`sp1` for BUY exit, `bp1` for SELL exit) to guarantee execution before close.
- **Timeout Window**: Replaces blind 10% sweeps with a targeted resting depth match and a 2.0s fill verification window before clean remnant teardown.
- **UI Rollback Guard**: Positions mark as `Exiting` (amber) with rollback protection, transitioning to `Closed` (grey) only upon broker `COMPLETE` event verification.

### 8.6 Exit Order In-Flight Locking & Feedback Loop Prevention
- **Root Cause Eliminated**: Continuous high-frequency WebSocket quotes previously caused `evaluateTradeExit` to re-trigger new exit order submissions on every incoming tick while an existing exit order was in flight.
- **In-Flight Lock**: `evaluateTradeExit` strictly guards with `if (item.status !== 'Active') return;`, and `exitTrade` / `exitTerminalTrade` enforce `if (!item || item.status === 'Closed' || item.status === 'Exiting') return;`.
- **Multi-Key Feed Resolution**: In paper trading and broker execution, `get_live_data` reconciles multi-key live feeds (`EXCHANGE|TOKEN`, `EXCHANGE|SYMBOL`, raw `SYMBOL`) ensuring zero quote starvation or phantom loops.


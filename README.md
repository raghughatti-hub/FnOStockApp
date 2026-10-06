# FnO Stock Trading Application (Enterprise Edition)

A high-performance algorithmic trading platform for NSE/BSE Futures & Options with multi-broker support, live depth streaming, and automated limit order chasing.

## Structural organization (September 29, 2026)

The application is assembled in `main.py`, which retains state ownership,
plugin construction, route order, and both existing startup handlers.

| Location | Responsibility |
| --- | --- |
| `broker/` | Broker contract, registry, symbol mapper, Flattrade/Upstox/Zebu adapters, OAuth callbacks |
| `services/execution_engine.py` | Shared paper/live order execution and sequential chasing |
| `models/api.py` | Unchanged HTTP request and response models, re-exported by `main.py` |
| `utilities/filters.py` | Shared dataframe filtering |
| `brokers/` | Backward-compatible module aliases and existing credential/cache locations |
| `config/`, `data/`, `static/` | Existing configuration, instrument processing, and browser application |

Legacy `brokers.*` imports share the exact implementation modules with `broker.*`.
Both execution-engine import paths share `services.execution_engine`, so injected
state and callbacks are not copied. Broker credential search order and cache
locations remain unchanged; `broker/resource_paths.py` documents this constraint.
Do not move credential files simply to match the source folder layout.

Run offline regression verification from the project root:

```text
python -B tests/test_structural_refactor.py
```

Tests compare against `.refactor_baseline/sources.zip` in disposable directories;
they block external requests and production trading threads. The local snapshot
contains original source and should be handled like the original source files.
See [REFACTOR_PLAN.md](REFACTOR_PLAN.md) and [REFACTOR_REPORT.md](REFACTOR_REPORT.md)
for scope, evidence, and verification limits. The blueprint files below describe
the historical layout and were retained unchanged.

> **Technical Architecture & Specifications**:
> - [SYSTEM_BLUEPRINT.md](SYSTEM_BLUEPRINT.md): Component designs, WebSocket connection lifecycle, and data pipelines.
> - [Order_mgt.md](Order_mgt.md): **AI Agent Directive** for Order Management System (OMS), Risk Collars, 0.05 Tick Clamping, Range-Bound Entry, and 3-Stage Exit Chaser.
> - [Order_Management.md](Order_Management.md): Legacy Order Management System (OMS) documentation.

---

## Project Structure

```
FnOStockApp/
├── main.py                    # FastAPI application entry-point & API routes
├── SYSTEM_BLUEPRINT.md        # Technical architecture, WebSocket lifecycle & specs
├── Order_Management.md        # OMS, atomic modify engine & adaptive exit specs
├── README.md                  # Project overview and runbook
├── requirements.txt           # Python dependencies
│
├── config/                    # Centralised configuration
│   ├── settings.py            # Ports, credentials, CORS, and log retention settings
│   ├── constants.py           # Market constants (index tokens, tick sizes)
│   └── logging_config.py      # 10-day FIFO TimedRotatingFileHandler setup
│
├── data/                      # Instrument & market data utilities
│   ├── download_instruments.py    # Downloads daily NSE/NFO/MCX master CSVs
│   └── fno_strike_calculator.py   # Computes strike differences & lot sizes
│
├── broker/                    # Canonical multi-broker implementation
│   ├── base_broker.py             # Abstract interface all brokers implement
│   ├── broker_manager.py          # Dynamic broker switcher & registry
│   ├── canonical_symbol_mapper.py # Bi-directional broker symbol translation
│   ├── execution_engine.py        # Compatibility alias to services/execution_engine.py
│   ├── flattrade_broker.py        # Flattrade/Shoonya integration (Zero-Zombie WS)
│   ├── upstox_broker.py           # Upstox integration (REST + V3 stream)
│   └── zebu_broker.py             # Zebu/Mynt integration (Zero-Zombie WS)
│
├── brokers/                   # Legacy imports and unchanged resource locations
├── services/                  # Shared execution engine
├── models/                    # HTTP request/response contracts
├── utilities/                 # Shared dataframe filtering
├── tests/                     # Offline structural regression checks
│
├── Instrument/                # Daily updated instrument CSV files
│   ├── NSE_symbols.csv
│   ├── NFO_symbols.csv
│   └── ...
│
├── Flattrade/                 # Flattrade credentials (Flattrade_Creds.txt)
├── Upstox/                    # Upstox credentials (Upstox_Creds.txt)
├── Zebu/                      # Zebu credentials (Zebu_Creds.txt)
├── static/                    # React / JavaScript web trading interface
├── logs/                      # Application log directory
│
├── run_app_8095.bat           # Launch server on primary port 8095
└── run_app.bat                # Launch server on companion port 8000 (Tick Relay)
```

---

## Quick Start

1. **Install Dependencies**:
   ```bat
   install_dependencies.bat
   ```
2. **Launch Application**:
   - **Primary Instance (Port 8095)**:
     ```bat
     run_app_8095.bat
     ```
   - **Companion Instance (Port 8000 - Tick Relay)**:
     ```bat
     run_app.bat
     ```
3. **Access Terminal**:
   Open your browser at `http://127.0.0.1:8095`

---

## Multi-Broker Integration

Switch between brokers on the fly via the UI or API without server restarts:

| Broker | Auth Method | Market Data Feed | Features |
| :--- | :--- | :--- | :--- |
| **Flattrade** | OAuth + TOTP | Shoonya WebSocket | Zero-Zombie WS, Tick Relay, Auto-Reconnect |
| **Upstox** | OAuth + TOTP + PIN | V3 Market Stream | High-speed tick polling & multi-token batching |
| **Zebu** | OAuth + Headless Browser | Mynt WebSocket | Zero-Zombie WS, Auto-reconnect & Token Recovery |

---

## Logging & 10-Day FIFO Retention Policy

Logging is configured using Python's `TimedRotatingFileHandler` with automated FIFO retention:
- **Active Log**: Written to `app_log.txt`.
- **Daily Rollover**: Automatically rotated at midnight (`00:00:00`) with date stamps (`app_log.txt.YYYY-MM-DD`).
- **10-Day FIFO Pruning**: Only the latest 10 calendar days of logs are retained. Older backups beyond 10 days are automatically purged in FIFO order upon startup and during daily morning initialization.
- **Settings**: Tunable via `config/settings.py` (`LOG_RETENTION_DAYS = 10`).

---

## Trade Modes

- **PAPER** (Default): Simulated trade tracking using real-time tick and market depth feeds.
- **REAL**: Live trade execution placed directly with the active broker API.\n

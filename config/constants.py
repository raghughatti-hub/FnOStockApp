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

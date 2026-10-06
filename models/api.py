"""HTTP request/response contracts. Field order, defaults and types are unchanged."""
from typing import List, Optional
from pydantic import BaseModel


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


class ClientErrorParams(BaseModel):
    message: Optional[str] = None
    source: Optional[str] = None
    lineno: Optional[int] = None
    colno: Optional[int] = None
    error: Optional[str] = None


class CanonicalResolveParams(BaseModel):
    index: Optional[str] = "NSE"
    instrument: str
    type: Optional[str] = "EQ"
    strike: Optional[float] = 0.0
    expiry: Optional[str] = "Near"


# Keep legacy public metadata: these classes remain re-exported by main.py.
LoginParams.__module__ = "main"
SubscriptionParams.__module__ = "main"
BulkSubscriptionParams.__module__ = "main"
TradeOrderParams.__module__ = "main"
CancelOrderParams.__module__ = "main"
TradeModeParams.__module__ = "main"
SubsystemResponse.__module__ = "main"
ClientErrorParams.__module__ = "main"
CanonicalResolveParams.__module__ = "main"

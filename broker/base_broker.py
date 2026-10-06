# Shared contract for broker integrations. No runtime registration here.
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

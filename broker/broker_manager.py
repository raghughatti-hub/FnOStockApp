import logging
from typing import Dict, Optional
from broker.base_broker import BaseBroker

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

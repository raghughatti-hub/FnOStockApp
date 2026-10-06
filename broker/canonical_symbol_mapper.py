"""
broker/canonical_symbol_mapper.py
===================================
Canonical Symbol Mapper Module (WebTrader Multi-Broker)
Provides O(1) bi-directional symbol translation between internal canonical IDs
and broker-specific tokens / trading symbols.
"""
import os
import json
import logging
from typing import Dict, Any, Optional, Tuple

logger = logging.getLogger("CanonicalMapper")

class CanonicalSymbolMapper:
    def __init__(self):
        # Maps canonical_id -> broker_name -> broker_spec dict
        self._canonical_to_broker: Dict[str, Dict[str, Dict[str, Any]]] = {}
        
        # Maps (broker_name, token_or_tsym) -> canonical_id
        self._broker_to_canonical: Dict[Tuple[str, str], str] = {}

    @staticmethod
    def build_canonical_id(inst_type: str, symbol: str, expiry: Optional[str] = None, strike: Optional[float] = None, option_type: Optional[str] = None) -> str:
        """
        Builds unified canonical key.
        Examples:
          build_canonical_id("EQ", "RELIANCE") -> "EQ|RELIANCE"
          build_canonical_id("FUT", "RELIANCE", expiry="2026-08-28") -> "FUT|RELIANCE|2026-08-28"
          build_canonical_id("OPT", "RELIANCE", expiry="2026-08-28", strike=2900, option_type="CE") -> "OPT|RELIANCE|2026-08-28|2900|CE"
        """
        inst = inst_type.upper().strip()
        sym = symbol.upper().strip()
        
        if inst in ("EQ", "EQUITY", "SPOT"):
            return f"EQ|{sym}"
        elif inst in ("INDEX", "IDX"):
            return f"INDEX|{sym}"
        elif inst in ("FUT", "FUTSTK", "FUTIDX"):
            exp_str = str(expiry).split(" ")[0] if expiry else "NEAR"
            return f"FUT|{sym}|{exp_str}"
        elif inst in ("OPT", "OPTSTK", "OPTIDX"):
            exp_str = str(expiry).split(" ")[0] if expiry else "NEAR"
            stk_str = f"{float(strike):.2f}".rstrip('0').rstrip('.') if strike is not None else "0"
            opt_str = option_type.upper().strip() if option_type else "CE"
            return f"OPT|{sym}|{exp_str}|{stk_str}|{opt_str}"
        
        return f"{inst}|{sym}"

    def register_mapping(self, canonical_id: str, broker_name: str, broker_token: str, broker_symbol: str, exchange: str, lot_size: int = 1, extra_info: Optional[Dict[str, Any]] = None):
        """Registers bi-directional mapping between canonical_id and broker-specific details."""
        b_name = broker_name.upper().strip()
        token_str = str(broker_token).strip()
        symbol_str = str(broker_symbol).strip()
        
        spec = {
            "canonical_id": canonical_id,
            "broker_name": b_name,
            "broker_token": token_str,
            "broker_symbol": symbol_str,
            "exchange": exchange.upper().strip(),
            "lot_size": lot_size
        }
        if extra_info:
            spec.update(extra_info)

        # 1. Store Canonical -> Broker Spec
        if canonical_id not in self._canonical_to_broker:
            self._canonical_to_broker[canonical_id] = {}
        self._canonical_to_broker[canonical_id][b_name] = spec

        # 2. Store Broker (Name, Token) -> Canonical ID
        if token_str and token_str != "-":
            self._broker_to_canonical[(b_name, token_str)] = canonical_id
            
        # 3. Store Broker (Name, Symbol) -> Canonical ID
        if symbol_str:
            self._broker_to_canonical[(b_name, symbol_str)] = canonical_id
            self._broker_to_canonical[(b_name, f"{spec['exchange']}|{symbol_str}")] = canonical_id

    def get_broker_spec(self, canonical_id: str, broker_name: str) -> Optional[Dict[str, Any]]:
        """Returns broker-specific order payload fields for a canonical_id."""
        return self._canonical_to_broker.get(canonical_id, {}).get(broker_name.upper().strip())

    def get_canonical_id(self, broker_name: str, token_or_symbol: str) -> Optional[str]:
        """Resolves broker token or trading symbol back to canonical_id."""
        b_name = broker_name.upper().strip()
        key = (b_name, str(token_or_symbol).strip())
        return self._broker_to_canonical.get(key)

# Global Singleton Instance
canonical_mapper = CanonicalSymbolMapper()

"""Dataframe filter evaluation with the original coercion and error behavior."""
from typing import Any
import pandas as pd

def evaluate_condition_pandas(df: pd.DataFrame, field: str, op: str, val: Any = None, val2: Any = None) -> pd.Series:
    if field not in df.columns:
        return pd.Series(False, index=df.index)
        
    s = df[field]
    
    # Cast to numeric if filtering numerically (Phase 4: type safety & integrity)
    if op in ['>', '<', 'between', '!=0', 'isNum']:
        s_numeric = pd.to_numeric(s, errors='coerce')
        val_num = pd.to_numeric(val, errors='coerce') if val is not None and val != '' else None
        val2_num = pd.to_numeric(val2, errors='coerce') if val2 is not None and val2 != '' else None
        
        if op == '>':
            return s_numeric > val_num
        elif op == '<':
            return s_numeric < val_num
        elif op == 'between':
            return (s_numeric >= val_num) & (s_numeric <= val2_num)
        elif op == '!=0':
            return (s_numeric != 0) & s_numeric.notna()
        elif op == 'isNum':
            return s_numeric.notna()
            
    if op == '=':
        try:
            return pd.to_numeric(s, errors='coerce') == pd.to_numeric(val, errors='coerce')
        except:
            return s.astype(str) == str(val)
            
    if op == '!=null':
        return s.notna() & (s.astype(str).str.strip() != '') & (s.astype(str) != '-') & (s.astype(str) != 'NaN')
        
    if op == 'contains':
        return s.astype(str).str.contains(str(val), case=False, na=False)
        
    return pd.Series(True, index=df.index)


# Preserve the public main.py symbol for existing callers and serializers.
evaluate_condition_pandas.__module__ = "main"

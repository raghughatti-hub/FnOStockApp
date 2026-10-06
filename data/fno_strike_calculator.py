import os
import pandas as pd
import numpy as np
import logging

logger = logging.getLogger("StrikeDiff")
logger.setLevel(logging.INFO)

def get_strike_difference_all(df, exch_name):
    """Calculate strike difference & lot size for each symbol+expiry in a given exchange"""
    results = []

    if "Expiry" not in df.columns or "StrikePrice" not in df.columns:
        return pd.DataFrame()  # Skip non-derivative files (like NSE/BSE cash)

    # Convert datatypes
    df['Expiry'] = pd.to_datetime(df['Expiry'], errors='coerce').dt.date
    df['StrikePrice'] = pd.to_numeric(df['StrikePrice'], errors='coerce')

    # Group by symbol & expiry
    for (sym, expiry), grp in df.groupby(["Symbol", "Expiry"]):
        strikes = sorted(grp["StrikePrice"].dropna().unique())
        lot_size = grp["LotSize"].iloc[0] if "LotSize" in grp.columns else None

        strike_diff = min(np.diff(strikes)) if len(strikes) > 1 else None

        results.append({
            "Symbol": sym,
            "Expiry": expiry,
            "LotSize": lot_size,
            "StrikeDifference": strike_diff,
            "Exchange": exch_name
        })

    return pd.DataFrame(results)

def load_and_calculate_fno_data(instrument_dir):
    """
    Reads all derivative instrument files in memory, calculates strike
    differences and lot sizes, and returns a Pandas DataFrame and a dictionary of the results.
    """
    all_results = []

    if not os.path.exists(instrument_dir):
        logger.warning(f"⚠️ Instrument folder not found at {instrument_dir}")
        return pd.DataFrame(), {}

    for file in os.listdir(instrument_dir):
        if file.endswith(".csv") or file.endswith(".txt"):
            exch = file.split("_")[0].upper()  # e.g., NFO_symbols.csv → NFO
            if exch != 'NFO':
                continue
            try:
                df = pd.read_csv(os.path.join(instrument_dir, file), low_memory=False)
                if 'Instrument' in df.columns:
                    df = df[df['Instrument'].isin(['OPTSTK', 'FUTSTK'])]
                res = get_strike_difference_all(df, exch)
                if not res.empty:
                    all_results.append(res)
                    logger.info(f"Calculated strike metrics from {file} ({len(res)} entries)")
            except Exception as e:
                logger.error(f"Could not process {file}: {e}")

    if all_results:
        final_df = pd.concat(all_results, ignore_index=True)
        # Reorder & sort
        final_df = final_df[["Symbol", "Expiry", "LotSize", "StrikeDifference", "Exchange"]]
        final_df = final_df.sort_values(by=["Symbol", "Expiry"]).reset_index(drop=True)

        # Build dictionary for O(1) fast lookups by (Symbol, Expiry) in API limits
        strike_diff_dict = {}
        for _, row in final_df.iterrows():
            key = (row['Symbol'], str(row['Expiry']))
            strike_diff_dict[key] = {
                'lotsize': int(row['LotSize']) if pd.notna(row['LotSize']) else 0,
                'strike_difference': float(row['StrikeDifference']) if pd.notna(row['StrikeDifference']) else None,
                'exchange': row['Exchange']
            }

        logger.info(f"Cached {len(strike_diff_dict)} strike difference records into memory")
        return final_df, strike_diff_dict
    else:
        logger.warning("No derivative instrument records calculated.")
        return pd.DataFrame(), {}

if __name__ == "__main__":
    # Test block
    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_path = os.path.join(script_dir, "..", "Instrument")
    print("Testing load_and_calculate_fno_data...")
    df, strike_dict = load_and_calculate_fno_data(base_path)
    print(f"Total calculated: {len(df)}")
    print(df.head())

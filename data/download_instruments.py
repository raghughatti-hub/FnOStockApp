import os
import requests
import zipfile
import io
import pandas as pd

exchanges = ['NSE', 'NFO', 'CDS', 'MCX']
subdir = "Instrument"


def main():
    if not os.path.exists(subdir):
        os.makedirs(subdir)

    for exchange in exchanges:
        zip_name = f"{exchange}_symbols.txt.zip"
        url = f"https://api.shoonya.com/{zip_name}"
        print(f"Downloading {exchange} instrument data from {url}...")
        try:
            response = requests.get(url, timeout=60)
            response.raise_for_status()

            # Unzip in memory
            with zipfile.ZipFile(io.BytesIO(response.content)) as z:
                file_names = z.namelist()
                if not file_names:
                    print(f"Empty zip for {exchange}")
                    continue

                txt_filename = file_names[0]
                print(f"Extracting {txt_filename}...")
                txt_content = z.read(txt_filename)

                # Save as CSV in the Instrument folder
                csv_path = os.path.join(subdir, f"{exchange}_symbols.csv")

                # Read txt as CSV (it is comma separated)
                df = pd.read_csv(io.BytesIO(txt_content), low_memory=False)

                # Standardize column headers and format Expiry date to YYYY-MM-DD
                if 'Expiry' in df.columns:
                    df['Expiry'] = pd.to_datetime(df['Expiry'], errors='coerce').dt.strftime('%Y-%m-%d')

                df.to_csv(csv_path, index=False)
                print(f"Saved {len(df)} records to {csv_path}")

        except Exception as e:
            print(f"Failed to download {exchange}: {e}")

    # Download official NSE F&O Bhavcopy for baseline POI
    try:
        download_nse_fo_bhavcopy()
    except Exception as ex_bhav:
        print(f"Bhavcopy step note: {ex_bhav}")

    print("Download complete!")

def download_nse_fo_bhavcopy():
    import datetime
    today = datetime.date.today()
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
    for d_offset in range(1, 6):
        target_date = today - datetime.timedelta(days=d_offset)
        if target_date.weekday() >= 5: continue
        
        dd = target_date.strftime("%d")
        mmm = target_date.strftime("%b").upper()
        yyyy = target_date.strftime("%Y")
        
        url = f"https://archives.nseindia.com/content/historical/DERIVATIVES/{yyyy}/{mmm}/fo{dd}{mmm}{yyyy}bhav.csv.zip"
        try:
            r = requests.get(url, headers=headers, timeout=10)
            if r.status_code == 200:
                with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                    file_names = z.namelist()
                    if file_names:
                        bhav_content = z.read(file_names[0])
                        df_bhav = pd.read_csv(io.BytesIO(bhav_content))
                        bhav_path = os.path.join(subdir, "nse_fo_bhavcopy.csv")
                        df_bhav.to_csv(bhav_path, index=False)
                        print(f"Successfully downloaded official NSE F&O Bhavcopy for {target_date} ({len(df_bhav)} rows)")
                        return True
        except Exception:
            pass
    return False


if __name__ == "__main__":
    main()

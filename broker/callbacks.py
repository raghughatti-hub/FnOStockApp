"""Broker OAuth callbacks; main.py injects dependencies and registers routes.

Registration stays at its original position, including the existing duplicate
Flattrade route. HTTP bodies, credentials fallback, and error handling are intact.
"""
import os
from fastapi import Request

app_state = None
upstox_plugin = None
logger = None


async def flattrade_callback(request: Request, request_code: str = None, code: str = None):
    from fastapi.responses import HTMLResponse, RedirectResponse
    
    # Auto-forward to the other port if we are not expecting a login callback on this server
    future_active = getattr(app_state, 'flattrade_auth_code_future', None) is not None and not app_state.flattrade_auth_code_future.done()
    if not future_active:
        our_port = 8095
        try:
            main_path = os.path.join(os.getcwd(), "main.py")
            if os.path.exists(main_path):
                with open(main_path, 'r', encoding='utf-8') as f:
                    for line in f:
                        if 'uvicorn.run(' in line and 'port=' in line:
                            import re
                            m = re.search(r'port\s*=\s*(\d+)', line)
                            if m:
                                our_port = int(m.group(1))
                                break
        except Exception:
            pass
        other_port = 8000 if our_port == 8095 else 8095
        query_str = request.url.query
        redirect_url = f"http://127.0.0.1:{other_port}/flattrade/callback?{query_str}"
        logger.info(f"[PORT PROXY] Forwarding callback to other server on port {other_port} -> {redirect_url}")
        return RedirectResponse(url=redirect_url)

    code_val = request_code or code
    if not code_val:
        code_val = request.query_params.get("request_code") or request.query_params.get("code")
    if app_state.flattrade_auth_code_future and not app_state.flattrade_auth_code_future.done():
        if code_val:
            app_state.flattrade_auth_code_future.set_result(code_val)
            logger.info(f"Callback future resolved with code: {code_val}")
    if code_val:
        # Return HTML that redirects back to the main trading page
        html = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Login Successful</title>
  <style>
    body { background:#0f1117; color:#4ade80; font-family:sans-serif;
           display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
    .box { text-align:center; }
    h2 { font-size:2rem; margin-bottom:0.5rem; }
    p  { color:#94a3b8; }
    .spinner { width:40px; height:40px; border:4px solid #1e293b;
               border-top-color:#4ade80; border-radius:50%;
               animation:spin 0.8s linear infinite; margin:16px auto; }
    @keyframes spin { to { transform:rotate(360deg); } }
  </style>
  <script>
    // Redirect main page back to / so the frontend detects login
    setTimeout(function() { window.location.href = '/'; }, 1500);
  </script>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <h2>✅ Login Successful!</h2>
    <p>Redirecting to WebTrader...</p>
  </div>
</body>
</html>"""
        return HTMLResponse(content=html)
    else:
        return HTMLResponse(content="<h2 style='color:red'>Login failed: no code in callback URL.</h2>", status_code=400)


async def upstox_callback(request: Request, code: str = None):
    from fastapi.responses import HTMLResponse
    import requests
    code_val = code or request.query_params.get("code")
    if not code_val:
        return HTMLResponse(content="<h2 style='color:red'>Upstox Login failed: no authorization code received.</h2>", status_code=400)

    token_url = "https://api.upstox.com/v2/login/authorization/token"
    creds = upstox_plugin.load_creds_from_file()
    payload = {
        "code": code_val,
        "client_id": creds.get("api key", "445bbbd2-d56b-48c3-bbec-120bf6a1d8e1"),
        "client_secret": creds.get("api secret", "yzqz28t8xq"),
        "redirect_uri": creds.get("redirect url", "http://localhost:8095/upstox/callback"),
        "grant_type": "authorization_code"
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    try:
        r = requests.post(token_url, data=payload, headers=headers, timeout=10)
        res_data = r.json()
        access_token = res_data.get("access_token")
        if access_token:
            upstox_plugin.save_access_token(access_token)
            upstox_plugin._start_ticker_thread()

            print("\n" + "="*60)
            print("  🟢 UPSTOX AUTHENTICATION SUCCESSFUL!")
            print("  ⚡ ACCESS TOKEN GENERATED & LIVE MARKET DATA STREAM ACTIVE")
            print("="*60 + "\n")
            
            html = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Upstox Login Successful</title>
<style>body{background:#0f1117;color:#4ade80;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}.box{text-align:center;}h2{font-size:2rem;margin-bottom:0.5rem;}p{color:#94a3b8;}</style>
<script>setTimeout(function(){ window.location.href = '/'; }, 1500);</script>
</head>
<body><div class="box"><h2>✅ Upstox Login Successful!</h2><p>Redirecting to WebTrader...</p></div></body>
</html>"""
            return HTMLResponse(content=html)
        else:
            return HTMLResponse(content=f"<h2 style='color:red'>Upstox Token Error: {res_data.get('errors')}</h2>", status_code=400)
    except Exception as e:
        return HTMLResponse(content=f"<h2 style='color:red'>Upstox Exception: {e}</h2>", status_code=500)


# Preserve the original endpoint metadata.
flattrade_callback.__module__ = "main"
upstox_callback.__module__ = "main"

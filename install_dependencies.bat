@echo off
TITLE Install StockOptionsTradingApp Dependencies
COLOR 0B
echo =======================================================================
echo          INSTALLING STOCK OPTIONS TRADING APP DEPENDENCIES
echo =======================================================================
echo.
cd /d "%~dp0"
pip install -r requirements.txt
echo.
echo Setup Complete! Double-click run_app.bat to launch WebTrader.
pause

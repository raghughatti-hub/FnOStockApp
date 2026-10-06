@echo off
title StockOptionsTradingApp - FLATTRADE (Port 8095)
echo ========================================================
echo   Launching Flattrade Workspace on Port 8095...
echo ========================================================
set PORT=8095
start http://127.0.0.1:8095/
python -u main.py
pause

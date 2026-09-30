@echo off
title Celebrare Local Face Reco & Scoring Tester
echo ========================================================
echo Starting Celebrare FaceReco & Scoring Web Tester...
echo URL: http://localhost:5000
echo ========================================================
cd /d "%~dp0"
python app.py
pause

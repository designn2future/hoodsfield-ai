#!/bin/bash
# usage: shot.sh "<hash>" out.png
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --hide-scrollbars --window-size=1500,900 --virtual-time-budget=12000 --screenshot="$2" "http://localhost:8000/$1" >/dev/null 2>&1

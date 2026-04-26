#!/bin/bash
# ══════════════════════════════════════════════
#  ЧИТАЛКА — запуск локального сервера
#  Работает на Mac. iPhone/iPad подключаются
#  через ту же Wi-Fi сеть.
# ══════════════════════════════════════════════

PORT=8080
DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "📚 ЧИТАЛКА"
echo "══════════════════════════════"

# Get local IP (for iPhone/iPad access)
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")

echo ""
echo "  Mac:              http://localhost:$PORT"
if [ -n "$LOCAL_IP" ]; then
  echo "  iPhone / iPad:    http://$LOCAL_IP:$PORT"
else
  echo "  iPhone / iPad:    (подключись к той же Wi-Fi)"
fi
echo ""
echo "  Нажми Ctrl+C чтобы остановить"
echo "══════════════════════════════"
echo ""

# Open browser on Mac
open "http://localhost:$PORT" 2>/dev/null &

# Start server
cd "$DIR"
if command -v python3 &>/dev/null; then
  python3 -m http.server $PORT --bind 0.0.0.0
elif command -v python &>/dev/null; then
  python -m SimpleHTTPServer $PORT
else
  echo "Python не найден. Установи Python или используй другой HTTP-сервер."
  exit 1
fi

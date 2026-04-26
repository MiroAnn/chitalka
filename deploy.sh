#!/bin/bash
# ══════════════════════════════════════════════
#  ЧИТАЛКА — деплой на GitHub Pages
#  Запусти один раз из папки reader/
#  Нужен GitHub CLI: brew install gh
# ══════════════════════════════════════════════

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

REPO_NAME="chitaika"

echo ""
echo "📚 Деплой ЧИТАЛКИ на GitHub Pages"
echo "══════════════════════════════════"

# 1. Проверяем gh CLI
if ! command -v gh &>/dev/null; then
  echo ""
  echo "  ❌ GitHub CLI не найден."
  echo "     Установи: brew install gh"
  echo "     Потом снова запусти этот скрипт."
  echo ""
  exit 1
fi

# 2. Авторизация (если ещё нет)
if ! gh auth status &>/dev/null; then
  echo ""
  echo "  🔐 Войди в GitHub:"
  gh auth login
fi

# 3. Git init (если репозиторий ещё не создан)
if [ ! -d ".git" ]; then
  echo ""
  echo "  📁 Инициализирую git репозиторий…"
  git init
  git checkout -b main
fi

# 4. Коммит всех файлов
echo "  📝 Добавляю файлы…"
git add -A
git commit -m "Читалка — начальная версия" --allow-empty

# 5. Создаём репозиторий на GitHub
GH_USER=$(gh api user --jq .login)
REPO_EXISTS=$(gh repo list "$GH_USER" --json name --jq ".[].name" 2>/dev/null | grep -x "$REPO_NAME" || true)

if [ -z "$REPO_EXISTS" ]; then
  echo "  🌐 Создаю репозиторий $GH_USER/$REPO_NAME…"
  gh repo create "$REPO_NAME" --public --source=. --remote=origin --push
else
  echo "  🌐 Репозиторий уже существует, пушу…"
  git remote set-url origin "https://github.com/$GH_USER/$REPO_NAME.git" 2>/dev/null || \
  git remote add origin "https://github.com/$GH_USER/$REPO_NAME.git"
  git push -u origin main --force
fi

# 6. Включаем GitHub Pages
echo "  🚀 Включаю GitHub Pages…"
gh api "repos/$GH_USER/$REPO_NAME/pages" \
  --method POST \
  --field source[branch]=main \
  --field source[path]=/ \
  2>/dev/null || true

sleep 2

# 7. Получаем ссылку
PAGES_URL=$(gh api "repos/$GH_USER/$REPO_NAME/pages" --jq .html_url 2>/dev/null || echo "")

echo ""
echo "══════════════════════════════════"
echo "  ✅ Готово!"
echo ""
if [ -n "$PAGES_URL" ]; then
  echo "  🔗 Ссылка: $PAGES_URL"
  echo ""
  echo "  (Страница активируется через 1-2 минуты)"
  # Открываем в браузере
  open "$PAGES_URL" 2>/dev/null || true
else
  echo "  🔗 GitHub: https://github.com/$GH_USER/$REPO_NAME"
  echo ""
  echo "  GitHub Pages активируется через 1-2 минуты."
  echo "  Ссылка будет: https://$GH_USER.github.io/$REPO_NAME"
fi
echo "══════════════════════════════════"
echo ""

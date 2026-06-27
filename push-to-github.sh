#!/bin/bash
# ─────────────────────────────────────────────────────────────
# FORGE → GitHub : crée le repo privé "Firmz" et pousse le code
# Usage: bash push-to-github.sh
# ─────────────────────────────────────────────────────────────

set -e

REPO_NAME="Firmz"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "⬡  Forge → GitHub push"
echo "   Dossier : $DIR"
echo ""

# ── 1. Récupérer le token GitHub ──
if [ -z "$GITHUB_TOKEN" ]; then
  # Essayer gh CLI d'abord
  if command -v gh &>/dev/null && gh auth status &>/dev/null; then
    echo "✓  gh CLI détecté et authentifié"
    GITHUB_TOKEN=$(gh auth token)
    GH_USER=$(gh api user --jq .login)
  else
    echo "Entre ton GitHub Personal Access Token (avec scope 'repo') :"
    echo "→ Crée-le ici : https://github.com/settings/tokens/new?scopes=repo"
    echo ""
    read -rs -p "Token : " GITHUB_TOKEN
    echo ""
    if [ -z "$GITHUB_TOKEN" ]; then
      echo "✗  Token vide. Abandon."
      exit 1
    fi
    GH_USER=$(curl -sf -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user | python3 -c "import sys,json; print(json.load(sys.stdin)['login'])")
  fi
else
  GH_USER=$(curl -sf -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user | python3 -c "import sys,json; print(json.load(sys.stdin)['login'])")
fi

echo "✓  Connecté en tant que : $GH_USER"

# ── 2. Créer le repo privé sur GitHub ──
echo "→  Création du repo privé '$REPO_NAME'..."

HTTP_STATUS=$(curl -s -o /tmp/gh_create_resp.json -w "%{http_code}" \
  -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/user/repos \
  -d "{\"name\":\"$REPO_NAME\",\"private\":true,\"description\":\"AI company builder — Forge/Firmz\",\"auto_init\":false}")

if [ "$HTTP_STATUS" = "201" ]; then
  echo "✓  Repo créé : https://github.com/$GH_USER/$REPO_NAME"
elif [ "$HTTP_STATUS" = "422" ]; then
  echo "⚠  Le repo '$REPO_NAME' existe déjà — on va pousser dessus."
else
  echo "✗  Erreur GitHub API ($HTTP_STATUS) :"
  cat /tmp/gh_create_resp.json
  exit 1
fi

REMOTE_URL="https://$GITHUB_TOKEN@github.com/$GH_USER/$REPO_NAME.git"

# ── 3. Init git dans le dossier projet ──
cd "$DIR"

if [ ! -d ".git" ]; then
  echo "→  Initialisation git..."
  git init -b main
  git config user.email "thomas@victoire.ai"
  git config user.name "Thomas"
else
  echo "✓  Repo git déjà initialisé"
  # S'assurer qu'on est sur main
  git checkout -B main 2>/dev/null || true
fi

# ── 4. Ajouter le remote ──
if git remote get-url origin &>/dev/null; then
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
fi

# ── 5. Commit & push ──
echo "→  Ajout des fichiers..."

# Exclure node_modules et .env (déjà dans .gitignore)
git add .

CHANGED=$(git status --porcelain | wc -l | tr -d ' ')
if [ "$CHANGED" = "0" ]; then
  echo "ℹ  Rien à committer (tout est déjà à jour)"
else
  git commit -m "🚀 Initial commit — Firmz AI company builder"
  echo "✓  Commit créé ($CHANGED fichiers)"
fi

echo "→  Push vers GitHub..."
git push -u origin main --force

echo ""
echo "✅  Terminé !"
echo "   → https://github.com/$GH_USER/$REPO_NAME"
echo ""

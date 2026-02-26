#!/bin/bash

##############################################################################
# QuickTask GitHub Push Script
# Pushes code to GitHub with credentials
#
# Usage Options:
# 1. Interactive: bash push-to-github.sh
# 2. With GitHub Token: GITHUB_TOKEN=<token> bash push-to-github.sh
# 3. With credentials: GIT_USERNAME=<user> GIT_PASSWORD=<pass> bash push-to-github.sh
##############################################################################

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

echo "================================"
echo "QuickTask GitHub Push Script"
echo "================================"
echo ""

# Check if we have all commits
echo "Checking git status..."
git status
echo ""

# Check for remote
if git remote get-url origin > /dev/null 2>&1; then
    echo "Remote already configured:"
    git remote -v
else
    echo "ERROR: No git remote configured!"
    echo "Run: git remote add origin https://github.com/YOUR_USERNAME/quicktask.git"
    exit 1
fi

# Prepare credentials
if [ -n "$GITHUB_TOKEN" ]; then
    echo "Using GitHub token for authentication..."
    export GIT_ASKPASS=echo
    export GIT_PASSWORD="$GITHUB_TOKEN"
    GIT_USERNAME="x-access-token"
elif [ -n "$GIT_PASSWORD" ]; then
    echo "Using provided Git credentials..."
    export GIT_ASKPASS=echo
else
    echo "No credentials provided."
    echo ""
    echo "Options to provide credentials:"
    echo "1. GitHub Personal Access Token (recommended):"
    echo "   GITHUB_TOKEN=ghp_xxxx bash push-to-github.sh"
    echo ""
    echo "2. GitHub username and password:"
    echo "   GIT_USERNAME=user GIT_PASSWORD=pass bash push-to-github.sh"
    echo ""
    echo "3. Interactive (Git will prompt):"
    echo "   bash push-to-github.sh (enter credentials when prompted)"
    exit 1
fi

# Extract username and password from remote if needed
if [ -z "$GIT_USERNAME" ]; then
    read -p "GitHub username: " GIT_USERNAME
fi
if [ -z "$GIT_PASSWORD" ]; then
    read -sp "GitHub password or token: " GIT_PASSWORD
    echo ""
fi

# Construct URL with credentials
REMOTE_URL=$(git remote get-url origin)
if [[ $REMOTE_URL == https://* ]]; then
    # Add credentials to URL
    AUTH_URL="${REMOTE_URL//https:\/\//https:\/\/$GIT_USERNAME:$GIT_PASSWORD@}"
else
    echo "ERROR: Remote URL must be HTTPS for credential-based push"
    exit 1
fi

# Push with credentials
echo ""
echo "Pushing to GitHub..."
echo "Remote: $(git remote get-url origin)"
echo ""

if git push -u origin master "$@" 2>&1; then
    echo ""
    echo "✓ Successfully pushed to GitHub!"
    echo ""
    echo "Next steps:"
    echo "1. Check Vercel Dashboard: https://vercel.com/dashboard"
    echo "2. Wait for deployment to complete (usually 2-5 minutes)"
    echo "3. Visit https://quicktask-five.vercel.app"
    echo "4. Test the bilingual feature (click EN button)"
else
    echo ""
    echo "✗ Push failed"
    echo ""
    echo "Possible reasons:"
    echo "1. Repository doesn't exist on GitHub"
    echo "2. Credentials are incorrect"
    echo "3. No write access to repository"
    echo ""
    echo "To create repository on GitHub:"
    echo "1. Go to https://github.com/new"
    echo "2. Name: quicktask"
    echo "3. Create repository (without initializing)"
    echo "4. Then run this script again"
    exit 1
fi


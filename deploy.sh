#!/bin/bash

##############################################################################
# QuickTask Full Deployment Script
# Handles: Git setup, GitHub push, Vercel deployment, verification
# Usage: bash deploy.sh
##############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Project directory
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Functions
print_step() {
    echo -e "\n${BLUE}▶ $1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

# Step 1: Verify project directory
print_step "Verifying project directory"
cd "$PROJECT_DIR"
if [ ! -d ".git" ]; then
    print_error "Not a git repository!"
    exit 1
fi
print_success "Project directory verified: $PROJECT_DIR"

# Step 2: Check git status
print_step "Checking git status"
if [ -z "$(git status -s)" ]; then
    print_success "All changes committed"
else
    print_warning "Uncommitted changes detected:"
    git status -s
    print_warning "Please commit changes before deploying"
    exit 1
fi

# Step 3: Get GitHub info
print_step "GitHub Configuration"
echo "Available options:"
echo "1. SSH (recommended if key added to GitHub)"
echo "2. HTTPS (requires GitHub token or password)"
read -p "Choose authentication method (1 or 2): " auth_method

if [ "$auth_method" = "1" ]; then
    print_step "SSH Configuration"
    read -p "Enter your GitHub username: " github_user
    REMOTE_URL="git@github.com:${github_user}/quicktask.git"
    AUTH_TYPE="SSH"
else
    print_step "HTTPS Configuration"
    read -p "Enter your GitHub username: " github_user
    REMOTE_URL="https://github.com/${github_user}/quicktask.git"
    AUTH_TYPE="HTTPS"
fi

echo "Remote URL: $REMOTE_URL"
echo "Authentication: $AUTH_TYPE"

# Step 4: Add git remote
print_step "Adding git remote"
if git remote get-url origin > /dev/null 2>&1; then
    print_warning "Remote 'origin' already exists"
    read -p "Remove existing remote? (y/n): " remove_remote
    if [ "$remove_remote" = "y" ]; then
        git remote remove origin
        git remote add origin "$REMOTE_URL"
        print_success "Remote updated"
    fi
else
    git remote add origin "$REMOTE_URL"
    print_success "Remote added: origin → $REMOTE_URL"
fi

# Step 5: Verify remote
print_step "Verifying remote configuration"
git remote -v
print_success "Remote configured"

# Step 6: Test connectivity
print_step "Testing connectivity to GitHub"
if [ "$AUTH_TYPE" = "SSH" ]; then
    if ssh -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
        print_success "SSH authentication successful"
    else
        print_warning "SSH authentication test inconclusive - proceeding anyway"
    fi
else
    print_warning "HTTPS authentication will be tested during push"
fi

# Step 7: Push to GitHub
print_step "Pushing to GitHub"
echo "Pushing branch 'master' to 'origin'..."
git push -u origin master

if [ $? -eq 0 ]; then
    print_success "Code pushed to GitHub successfully!"
else
    print_error "Push failed"
    echo "Please check:"
    echo "1. GitHub credentials are correct"
    echo "2. Repository exists and you have push access"
    echo "3. SSH key is added to GitHub (if using SSH)"
    exit 1
fi

# Step 8: Display deployment info
print_step "Deployment Information"
echo ""
echo "✓ Code pushed to GitHub: $REMOTE_URL"
echo "✓ Project name: quicktask"
echo "✓ Branch: master"
echo ""
echo "Vercel will auto-deploy in the next few minutes."
echo ""

# Step 9: Display verification steps
print_step "Next Steps - Verify Deployment"
echo ""
echo "1. Check Vercel Dashboard:"
echo "   → https://vercel.com/dashboard"
echo "   → Look for 'quicktask' project"
echo "   → Watch for status: Building... → Ready"
echo ""
echo "2. Visit Live Site:"
echo "   → https://quicktask-five.vercel.app"
echo ""
echo "3. Test Bilingual Feature:"
echo "   → Default language should be Bulgarian"
echo "   → Click 'EN' button in top right"
echo "   → All text should switch to English"
echo "   → Reload page - language should persist"
echo ""
echo "4. Check Browser Console (F12):"
echo "   → Should show no errors"
echo "   → Check localStorage for 'qt_lang' key"
echo ""

# Step 10: Optional - Watch deployment
read -p "Watch deployment logs? (requires Vercel CLI, y/n): " watch_logs
if [ "$watch_logs" = "y" ]; then
    if command -v vercel &> /dev/null; then
        echo "Watching deployment logs..."
        vercel logs
    else
        print_warning "Vercel CLI not installed"
        echo "Install with: npm i -g vercel"
    fi
fi

print_success "Deployment script completed!"
echo ""
echo "Summary:"
echo "  - Git remote added and configured"
echo "  - Code pushed to GitHub"
echo "  - Vercel will auto-deploy"
echo "  - Check dashboard for deployment status"
echo ""

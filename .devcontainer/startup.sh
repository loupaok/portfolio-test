#!/bin/bash

# PhantomWP Infrastructure Version
PHANTOMWP_INFRA_VERSION="1.1.0"

# Get the workspace directory (parent of .devcontainer)
WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORKSPACE_DIR" || {
  echo "❌ Failed to change to workspace directory"
  exit 1
}

echo "🚀 Starting PhantomWP development environment..."
echo "📁 Working directory: $WORKSPACE_DIR"
echo "📦 Infrastructure version: v$PHANTOMWP_INFRA_VERSION"
echo ""

# ============================================================================
# CHECK FOR INFRASTRUCTURE UPDATES
# ============================================================================
check_for_updates() {
  echo "🔍 Checking for infrastructure updates..."
  
  # Read current version from file if it exists
  if [ -f ".phantomwp-version" ]; then
    CURRENT_VERSION=$(cat .phantomwp-version)
  else
    CURRENT_VERSION="$PHANTOMWP_INFRA_VERSION"
    echo "$PHANTOMWP_INFRA_VERSION" > .phantomwp-version
  fi
  
  # Check for updates (with 5 second timeout)
  UPDATE_CHECK=$(curl -s --connect-timeout 5 "https://phantomwp.com/api/infrastructure/version?current=$CURRENT_VERSION" 2>/dev/null)
  
  if [ -n "$UPDATE_CHECK" ]; then
    IS_OUTDATED=$(echo "$UPDATE_CHECK" | grep -o '"isOutdated":true' || true)
    IS_BREAKING=$(echo "$UPDATE_CHECK" | grep -o '"isBreaking":true' || true)
    LATEST_VERSION=$(echo "$UPDATE_CHECK" | grep -o '"latestVersion":"[^"]*"' | cut -d'"' -f4)
    
    if [ -n "$IS_OUTDATED" ] && [ -n "$LATEST_VERSION" ]; then
      echo ""
      echo "╔════════════════════════════════════════════════════════════════╗"
      if [ -n "$IS_BREAKING" ]; then
        echo "║  ⚠️   INFRASTRUCTURE UPDATE AVAILABLE (BREAKING CHANGES)      ║"
      else
        echo "║  🆕  INFRASTRUCTURE UPDATE AVAILABLE                          ║"
      fi
      echo "╠════════════════════════════════════════════════════════════════╣"
      echo "║  Current: v$CURRENT_VERSION                                            ║"
      echo "║  Latest:  v$LATEST_VERSION                                            ║"
      echo "╠════════════════════════════════════════════════════════════════╣"
      echo "║  To update, run:                                               ║"
      echo "║  curl -s 'https://phantomwp.com/api/infrastructure/update?current=$CURRENT_VERSION' | bash ║"
      echo "╚════════════════════════════════════════════════════════════════╝"
      echo ""
    else
      echo "✅ Infrastructure is up to date (v$CURRENT_VERSION)"
    fi
  else
    echo "⚠️  Could not check for updates (network unavailable)"
  fi
  
  echo ""
}

# Check for updates in background (don't block startup)
check_for_updates &

# ============================================================================
# JWT PUBLIC KEY SETUP (Automatic)
# ============================================================================
echo "🔐 Setting up JWT authentication..."

# Check if JWT_PUBLIC_KEY is already set (from GitHub Codespaces Secrets)
if [ -n "${JWT_PUBLIC_KEY}" ]; then
  echo "✅ JWT_PUBLIC_KEY found in environment"
else
  # Priority 1: Check for .phantomwp-key file (created by main app during codespace creation)
  if [ -f ".phantomwp-key" ]; then
    echo "🔍 Found .phantomwp-key file (injected by main app)"
    JWT_PUBLIC_KEY=$(cat .phantomwp-key | base64 -d 2>/dev/null || cat .phantomwp-key)
    
    if [ -n "${JWT_PUBLIC_KEY}" ]; then
      export JWT_PUBLIC_KEY
      echo "✅ JWT_PUBLIC_KEY loaded from injected file"
      
      # Delete the file for security (it's already in memory)
      rm -f .phantomwp-key
      echo "🗑️  Removed temporary key file"
      
      # Also remove from git if it was committed
      if [ -d ".git" ]; then
        git rm --cached .phantomwp-key 2>/dev/null || true
        git commit -m "Remove temporary JWT key file" 2>/dev/null || true
      fi
    else
      echo "⚠️  Failed to decode .phantomwp-key file"
      rm -f .phantomwp-key
    fi
  fi
  
  # Priority 2: If still not found, show error
  if [ -z "${JWT_PUBLIC_KEY}" ]; then
    echo "❌ JWT_PUBLIC_KEY not found!"
    echo ""
    echo "The JWT public key is required for WebSocket authentication."
    echo ""
    echo "How to fix:"
    echo "  1. Make sure JWT_PUBLIC_KEY is set in main app environment"
    echo "     (The key should be injected automatically during codespace creation)"
    echo ""
    echo "  2. OR manually set in GitHub Codespaces Secrets:"
    echo "     → Go to: https://github.com/settings/codespaces"
    echo "     → Add secret: JWT_PUBLIC_KEY"
    echo "     → Paste your public key"
    echo ""
    echo "  3. Then restart this codespace"
    echo ""
  fi
fi

# Export JWT_PUBLIC_KEY for PM2 processes
if [ -n "${JWT_PUBLIC_KEY}" ]; then
  export JWT_PUBLIC_KEY
  echo "🔓 JWT public key configured (RS256 authentication enabled)"
else
  echo "⚠️  JWT public key not available - WebSocket auth will fail"
  echo "   WebSocket server will exit if JWT_PUBLIC_KEY is missing"
fi

echo ""

# ============================================================================
# DEPENDENCY INSTALLATION
# ============================================================================

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
fi

# Check if ws module is available
if [ ! -d "node_modules/ws" ]; then
  echo "⚠️  WebSocket dependency missing, installing..."
  npm install ws chokidar
fi

# Verify PM2 is installed
if ! command -v pm2 &> /dev/null; then
  echo "❌ PM2 not found, installing..."
  npm install -g pm2
fi

# Stop any existing PM2 processes
echo "🧹 Cleaning up any existing processes..."
pm2 delete all 2>/dev/null || true
sleep 2

# Start services with PM2
echo "📡 Starting services with PM2..."
if ! pm2 start .devcontainer/ecosystem.config.cjs; then
  echo "❌ Failed to start PM2 services, retrying..."
  sleep 2
  pm2 start .devcontainer/ecosystem.config.cjs || {
    echo "❌ Failed to start PM2 services after retry"
    echo "Checking PM2 logs..."
    pm2 logs --lines 20 --nostream || true
    echo "Attempting to start services manually..."
    # Try starting services individually as fallback
    pm2 start "$WORKSPACE_DIR/.devcontainer/ws-server.js" --name websocket --cwd "$WORKSPACE_DIR" || true
    pm2 start npm --name astro --cwd "$WORKSPACE_DIR" -- run dev || true
  }
fi

# Save PM2 process list to survive restarts
pm2 save --force || true

# Configure PM2 startup script (may fail in Codespaces, that's OK)
pm2 startup systemd -u $(whoami) --hp $HOME 2>/dev/null || pm2 startup -u $(whoami) --hp $HOME 2>/dev/null || true

# Wait for services to start
echo "⏳ Waiting for services to start..."
sleep 5

# Show PM2 status immediately
echo ""
echo "📊 PM2 Status:"
pm2 list

# Check if services are actually running
if ! pm2 list | grep -q "online"; then
  echo "⚠️  Warning: No PM2 services are online"
  echo "Checking logs for errors..."
  pm2 logs --lines 50 --nostream || true
fi

# Wait for Astro server to be ready
echo "⏳ Waiting for Astro server to be ready..."
ASTRO_READY=false
for i in {1..60}; do
  if curl -s http://localhost:4321 > /dev/null 2>&1; then
    echo "✅ Astro server is ready!"
    ASTRO_READY=true
    break
  fi
  sleep 1
  if [ $i -eq 30 ]; then
    echo "⏳ Still waiting for Astro server... (checking PM2 status)"
    pm2 list
    pm2 logs astro --lines 10 --nostream || true
  fi
done

if [ "$ASTRO_READY" = false ]; then
  echo "⚠️  Astro server did not become ready within 60 seconds"
  echo "Checking PM2 logs..."
  pm2 logs astro --lines 20 --nostream || true
fi

# Check WebSocket server is responding
echo "🔍 Checking WebSocket server..."
WS_READY=false
for i in {1..10}; do
  if lsof -i:8080 > /dev/null 2>&1 || netstat -tuln 2>/dev/null | grep -q ":8080"; then
    echo "✅ WebSocket server is listening on port 8080"
    WS_READY=true
    break
  fi
  sleep 1
done

if [ "$WS_READY" = false ]; then
  echo "⚠️  WebSocket server did not start on port 8080"
  echo "Checking PM2 logs..."
  pm2 logs websocket --lines 20 --nostream || true
fi

# Set ports to public (for GitHub Codespaces)
if command -v gh &> /dev/null && [ -n "$CODESPACE_NAME" ]; then
  echo "🔓 Setting ports to public..."
  # Wait a bit for ports to be forwarded
  sleep 5
  
  # Set ports to public synchronously with retries
  for port in 4321 8080; do
    for attempt in {1..5}; do
      if gh codespace ports visibility "$port:public" -c "$CODESPACE_NAME" 2>/dev/null; then
        echo "✅ Port $port set to public"
        break
      else
        if [ $attempt -lt 5 ]; then
          echo "⏳ Retrying to set port $port to public (attempt $attempt/5)..."
          sleep 2
        else
          echo "⚠️  Failed to set port $port to public after 5 attempts"
        fi
      fi
    done
  done
elif [ -n "$CODESPACE_NAME" ]; then
  echo "⚠️  GitHub CLI not available, ports may need to be set to public manually"
  echo "   Go to the Ports tab and set ports 4321 and 8080 to public"
fi

# Open index.astro in the editor
code src/pages/index.astro 2>/dev/null || true

# Wait a moment for the file to open
sleep 2

# Open preview in Simple Browser (split view)
code --open-url "http://localhost:4321" 2>/dev/null || true

echo ""
echo "🎉 Workspace ready!"
echo "📝 Edit on the left, preview on the right"
echo "🔗 WebSocket: localhost:8080"
echo "🌐 Preview: localhost:4321"
echo ""
echo "Services are managed by PM2 (production-grade process manager)"
echo ""
echo "PM2 Commands:"
echo "  Status:  pm2 list"
echo "  Logs:    pm2 logs"
echo "  Restart: pm2 restart all"
echo "  Stop:    pm2 stop all"
echo ""
echo "Individual logs:"
echo "  WebSocket: pm2 logs websocket"
echo "  Astro: pm2 logs astro"
echo ""

# Unstage devcontainer files from git (they shouldn't be committed)
if [ -d ".git" ]; then
  git restore --staged .devcontainer/startup.sh 2>/dev/null || git reset HEAD .devcontainer/startup.sh 2>/dev/null || true
fi

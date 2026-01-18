import { WebSocketServer } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import jwt from 'jsonwebtoken';

const execAsync = promisify(exec);
const PORT = 8080;

// JWT Public Key for token verification (RS256)
const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY;

if (!JWT_PUBLIC_KEY) {
  console.error('❌ JWT_PUBLIC_KEY environment variable is required');
  console.error('');
  console.error('This codespace requires JWT authentication to be set up.');
  console.error('The public key should be automatically injected during codespace creation.');
  console.error('');
  console.error('If you see this error:');
  console.error('  1. Try recreating the codespace from the PhantomWP dashboard');
  console.error('  2. Check that the main app has JWT_PUBLIC_KEY set');
  console.error('');
  process.exit(1);
}

// Verify the key format
if (!JWT_PUBLIC_KEY.includes('BEGIN PUBLIC KEY') && !JWT_PUBLIC_KEY.includes('BEGIN RSA PUBLIC KEY')) {
  console.error('❌ JWT_PUBLIC_KEY appears to be invalid (not a PEM-formatted public key)');
  process.exit(1);
}

console.log('🔐 JWT public key loaded for WebSocket authentication');
console.log('   Using RS256 asymmetric verification');

const wss = new WebSocketServer({ 
  port: PORT,
  maxPayload: 50 * 1024 * 1024,
});

// Verify JWT token (RS256)
function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ['RS256'] });
    return { valid: true, payload: decoded };
  } catch (error) {
    console.error('JWT verification failed:', error.message);
    return { valid: false, error: error.message };
  }
}

// Extract token from URL query parameter
function authenticateConnection(req) {
  try {
    const url = new URL(req.url, 'ws://localhost');
    const token = url.searchParams.get('token');
    
    if (!token) {
      console.error('❌ No token provided in connection URL');
      return null;
    }
    
    const result = verifyToken(token);
    if (!result.valid) {
      console.error('❌ Invalid token:', result.error);
      return null;
    }
    
    return {
      userId: result.payload.userId,
      username: result.payload.username || 'unknown',
      repoId: result.payload.repoId,
      repoName: result.payload.repoName,
    };
  } catch (error) {
    console.error('❌ Authentication error:', error.message);
    return null;
  }
}

// Path validation to prevent traversal attacks
function isPathSafe(filePath) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false;
  if (normalized.includes('../') || normalized.includes('/..') || normalized === '..') return false;
  if (normalized.startsWith('.git/') || normalized === '.git') return false;
  if (normalized.startsWith('node_modules/') || normalized === 'node_modules') return false;
  return true;
}

// List files in a directory (recursive)
async function listDirectory(dirPath, basePath = '') {
  const files = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.astro' && entry.name !== '.devcontainer') continue;
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      
      const relativePath = basePath ? basePath + '/' + entry.name : entry.name;
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        files.push({
          name: entry.name,
          path: relativePath,
          isDirectory: true,
        });
        const subFiles = await listDirectory(fullPath, relativePath);
        files.push(...subFiles);
      } else {
        files.push({
          name: entry.name,
          path: relativePath,
          isDirectory: false,
        });
      }
    }
  } catch (error) {
    console.error('Error listing directory ' + dirPath + ':', error.message);
  }
  return files;
}

// Handle client connection
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log('🔌 New connection from ' + clientIp);
  
  // Authenticate on connection via URL token
  const authData = authenticateConnection(req);
  
  if (!authData) {
    console.error('❌ Unauthorized connection attempt from ' + clientIp);
    ws.close(1008, 'Unauthorized');
    return;
  }
  
  // Store auth data on connection
  ws.userId = authData.userId;
  ws.username = authData.username;
  ws.repoId = authData.repoId;
  ws.repoName = authData.repoName;
  
  console.log('✅ Client connected: ' + authData.username + ' (' + authData.repoName + ')');

  // Connection health
  let isAlive = true;
  
  ws.on('ping', () => { ws.pong(); });
  ws.on('pong', () => { isAlive = true; });

  const pingInterval = setInterval(() => {
    if (!isAlive) {
      clearInterval(pingInterval);
      ws.terminate();
      return;
    }
    isAlive = false;
    ws.ping();
  }, 20000);

  ws.on('message', async (message) => {
    try {
      const messageStr = typeof message === 'string' ? message : message.toString('utf8');
      const data = JSON.parse(messageStr);
      const username = ws.username || 'unknown';
      
      // Handle ping action
      if (data.action === 'ping') {
        ws.send(JSON.stringify({ action: 'pong' }));
        return;
      }
      
      // Validate path
      if (data.path && !isPathSafe(data.path)) {
        ws.send(JSON.stringify({
          action: data.action,
          path: data.path,
          error: 'Invalid file path',
          success: false,
        }));
        console.error('❌ Path traversal attempt blocked: ' + data.path + ' (user: ' + username + ')');
        return;
      }
      
      // Handle file operations (using 'action' protocol)
      switch (data.action) {
        case 'read':
          try {
            let content;
            if (data.encoding === 'base64') {
              const buffer = await fs.readFile(data.path);
              content = buffer.toString('base64');
            } else {
              content = await fs.readFile(data.path, 'utf8');
            }
            ws.send(JSON.stringify({
              action: 'read',
              path: data.path,
              content,
              encoding: data.encoding || 'utf8',
              success: true,
            }));
            console.log('📖 [' + username + '] Read file: ' + data.path + (data.encoding === 'base64' ? ' (base64)' : ''));
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'read',
              path: data.path,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'write':
          try {
            const dirname = path.dirname(data.path);
            await fs.mkdir(dirname, { recursive: true });
            
            if (data.encoding === 'base64') {
              const buffer = Buffer.from(data.content, 'base64');
              await fs.writeFile(data.path, buffer);
            } else {
              await fs.writeFile(data.path, data.content, 'utf8');
            }
            
            // Touch global.css to trigger Tailwind CSS rebuild for files that might contain classes
            // This fixes a race condition where Vite's eager glob imports can cache CSS before
            // Tailwind has scanned new files for arbitrary values like h-[56px], w-[200px], etc.
            const tailwindTriggerExtensions = ['.astro', '.tsx', '.jsx', '.html', '.mdx', '.md', '.vue', '.svelte'];
            if (tailwindTriggerExtensions.some(ext => data.path.endsWith(ext))) {
              try {
                const now = new Date();
                await fs.utimes('src/styles/global.css', now, now);
              } catch (e) {
                // Ignore if global.css doesn't exist
              }
            }
            
            ws.send(JSON.stringify({
              action: 'write',
              path: data.path,
              success: true,
            }));
            console.log('💾 [' + username + '] Wrote file: ' + data.path);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'write',
              path: data.path,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'list':
          try {
            const targetPath = data.path === '.' ? process.cwd() : path.join(process.cwd(), data.path);
            const files = await listDirectory(targetPath, data.path === '.' ? '' : data.path);
            ws.send(JSON.stringify({
              action: 'list',
              path: data.path,
              files,
              success: true,
            }));
            console.log('📂 [' + username + '] Listed directory: ' + data.path);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'list',
              path: data.path,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'delete':
          try {
            const stats = await fs.stat(data.path);
            if (stats.isDirectory()) {
              await fs.rm(data.path, { recursive: true, force: true });
            } else {
              await fs.unlink(data.path);
            }
            ws.send(JSON.stringify({
              action: 'delete',
              path: data.path,
              success: true,
            }));
            console.log('🗑️ [' + username + '] Deleted: ' + data.path);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'delete',
              path: data.path,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'rename':
          try {
            if (!data.oldPath || !data.newPath) {
              throw new Error('oldPath and newPath are required');
            }
            if (!isPathSafe(data.oldPath) || !isPathSafe(data.newPath)) {
              throw new Error('Invalid path');
            }
            const newDir = path.dirname(data.newPath);
            await fs.mkdir(newDir, { recursive: true });
            await fs.rename(data.oldPath, data.newPath);
            ws.send(JSON.stringify({
              action: 'rename',
              oldPath: data.oldPath,
              newPath: data.newPath,
              success: true,
            }));
            console.log('📝 [' + username + '] Renamed: ' + data.oldPath + ' → ' + data.newPath);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'rename',
              oldPath: data.oldPath,
              newPath: data.newPath,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'create':
          try {
            const dirname = path.dirname(data.path);
            await fs.mkdir(dirname, { recursive: true });
            await fs.writeFile(data.path, data.content || '', 'utf8');
            
            // Touch global.css to trigger Tailwind CSS rebuild (same as write action)
            const tailwindTriggerExts = ['.astro', '.tsx', '.jsx', '.html', '.mdx', '.md', '.vue', '.svelte'];
            if (tailwindTriggerExts.some(ext => data.path.endsWith(ext))) {
              try {
                const now = new Date();
                await fs.utimes('src/styles/global.css', now, now);
              } catch (e) {
                // Ignore if global.css doesn't exist
              }
            }
            
            ws.send(JSON.stringify({
              action: 'create',
              path: data.path,
              success: true,
            }));
            console.log('✨ [' + username + '] Created file: ' + data.path);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'create',
              path: data.path,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'mkdir':
          try {
            await fs.mkdir(data.path, { recursive: true });
            ws.send(JSON.stringify({
              action: 'mkdir',
              path: data.path,
              success: true,
            }));
            console.log('📁 [' + username + '] Created directory: ' + data.path);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'mkdir',
              path: data.path,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'git':
          try {
            const { command } = data;
            const allowedCommands = ['status', 'diff', 'log', 'branch', 'add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'stash'];
            const gitCommand = command.split(' ')[0];
            if (!allowedCommands.includes(gitCommand)) {
              throw new Error('Git command not allowed');
            }
            const { stdout, stderr } = await execAsync('git ' + command, { cwd: process.cwd() });
            ws.send(JSON.stringify({
              action: 'git',
              success: true,
              stdout,
              stderr,
            }));
            console.log('🔀 [' + username + '] Git: ' + command);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'gitStatus':
          try {
            const { stdout } = await execAsync('git status --porcelain', { cwd: process.cwd() });
            const changes = stdout.trim().split('\n').filter(line => line.length > 0);
            ws.send(JSON.stringify({
              action: 'gitStatus',
              success: true,
              changes: changes.length,
              files: changes,
            }));
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'gitStatus',
              success: true,
              changes: 0,
              files: [],
            }));
          }
          break;

        case 'git-status':
          try {
            const { stdout: statusOutput } = await execAsync('git status --porcelain', { cwd: process.cwd() });
            const statusLines = statusOutput.trim().split('\n').filter(line => line.length > 0);
            const parsedChanges = statusLines.map(line => {
              const status = line.substring(0, 2);
              const file = line.substring(3);
              let type = 'modified';
              if (status.includes('?')) type = 'untracked';
              else if (status.includes('A')) type = 'added';
              else if (status.includes('D')) type = 'deleted';
              else if (status.includes('R')) type = 'renamed';
              else if (status.includes('M')) type = 'modified';
              return { file, status, type };
            });
            ws.send(JSON.stringify({
              action: 'git-status',
              success: true,
              changes: parsedChanges,
            }));
            console.log('🔀 [' + username + '] Git status: ' + parsedChanges.length + ' changes');
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-status',
              success: false,
              error: error.message,
              changes: [],
            }));
          }
          break;

        case 'git-diff':
          try {
            const { file: diffFile } = data;
            if (!diffFile) {
              throw new Error('File path is required for git-diff');
            }
            const { stdout: diffOutput } = await execAsync('git diff -- ' + JSON.stringify(diffFile), { cwd: process.cwd() });
            ws.send(JSON.stringify({
              action: 'git-diff',
              success: true,
              file: diffFile,
              diff: diffOutput,
            }));
            console.log('🔀 [' + username + '] Git diff: ' + diffFile);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-diff',
              success: false,
              error: error.message,
              diff: '',
            }));
          }
          break;

        case 'git-commit':
          try {
            const { message: commitMsg } = data;
            if (!commitMsg) {
              throw new Error('Commit message is required');
            }
            // First, stage all changes
            await execAsync('git add -A', { cwd: process.cwd() });
            // Then commit with the message
            const { stdout: commitOutput } = await execAsync('git commit -m ' + JSON.stringify(commitMsg), { cwd: process.cwd() });
            ws.send(JSON.stringify({
              action: 'git-commit',
              success: true,
              message: commitMsg,
              output: commitOutput,
            }));
            console.log('🔀 [' + username + '] Git commit: ' + commitMsg);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-commit',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'git-push':
          try {
            const { stdout: pushOutput, stderr: pushStderr } = await execAsync('git push', { cwd: process.cwd() });
            ws.send(JSON.stringify({
              action: 'git-push',
              success: true,
              output: pushOutput || pushStderr,
            }));
            console.log('🔀 [' + username + '] Git push completed');
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-push',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'git-pull-force':
          try {
            // Fetch from origin and reset to match remote
            await execAsync('git fetch origin', { cwd: process.cwd() });
            // Get the current branch name
            const { stdout: branchOutput } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: process.cwd() });
            const currentBranch = branchOutput.trim();
            // Reset hard to origin branch
            const { stdout: resetOutput, stderr: resetStderr } = await execAsync('git reset --hard origin/' + currentBranch, { cwd: process.cwd() });
            ws.send(JSON.stringify({
              action: 'git-pull-force',
              success: true,
              branch: currentBranch,
              output: resetOutput || resetStderr,
            }));
            console.log('🔀 [' + username + '] Git pull force completed (branch: ' + currentBranch + ')');
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-pull-force',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'exec':
          try {
            const { command: execCommand } = data;
            if (!execCommand) {
              throw new Error('Command is required');
            }
            // Only allow specific safe commands
            const allowedPatterns = [
              /^cd\s+\/workspaces\/[^&;|]+\s*&&\s*npm\s+(install|i)\s+/,  // npm install
              /^pm2\s+(restart|start|stop|reload)\s+/,  // pm2 commands
              /^pkill\s+-f\s+/,  // process kill
              /^npm\s+run\s+/,  // npm run scripts
            ];
            const isAllowed = allowedPatterns.some(pattern => pattern.test(execCommand));
            if (!isAllowed) {
              throw new Error('Command not allowed for security reasons');
            }
            const { stdout: execOutput, stderr: execStderr } = await execAsync(execCommand, { 
              cwd: process.cwd(),
              timeout: 120000,  // 2 minute timeout for npm install
            });
            ws.send(JSON.stringify({
              action: 'exec',
              success: true,
              command: execCommand,
              output: execOutput || execStderr,
            }));
            console.log('⚡ [' + username + '] Exec: ' + execCommand);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'exec',
              success: false,
              command: data.command,
              error: error.message,
            }));
            console.error('❌ [' + username + '] Exec failed: ' + error.message);
          }
          break;

        default:
          console.log('Unknown action: ' + data.action);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({ action: 'error', error: error.message, success: false }));
    }
  });
  
  ws.on('close', () => {
    clearInterval(pingInterval);
    console.log('🔌 Client disconnected: ' + ws.username);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clearInterval(pingInterval);
  });
});

console.log('🔌 WebSocket server running on port ' + PORT);
console.log('📁 Watching directory:', process.cwd());

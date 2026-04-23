/**
 * OpenClaw WebChat Server
 * 使用 WebSocket 连接 Gateway
 */

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();

// 加载配置
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const { server: serverConfig, openclaw: openclawConfig, jwtSecret, agents, users: configUsers } = config;

// Gateway 配置
const GATEWAY_URL = openclawConfig.apiUrl.replace('/v1/chat/completions', '');
const GATEWAY_TOKEN = openclawConfig.apiKey;

// WebSocket 连接
let ws = null;
let connected = false;
let requestId = 0;
const pendingRequests = new Map();
const eventHandlers = new Map();

// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const username = req.user.username;
    const uploadDir = path.join(__dirname, 'uploads', username);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${path.extname(file.originalname)}`);
  }
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// 数据目录
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHATS_DIR = path.join(DATA_DIR, 'chats');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CHATS_DIR)) fs.mkdirSync(CHATS_DIR, { recursive: true });

// 初始化用户
function initUsers() {
  let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) : [];
  for (const cu of configUsers) {
    const existing = users.find(u => u.username === cu.username);
    if (existing) {
      Object.assign(existing, { allowedAgents: cu.allowedAgents, isAdmin: cu.isAdmin || false, disabled: false });
    } else {
      users.push({ id: uuidv4(), username: cu.username, password: bcrypt.hashSync(cu.password, 10), allowedAgents: cu.allowedAgents, isAdmin: cu.isAdmin || false, disabled: false, createdAt: new Date().toISOString() });
    }
  }
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  return users;
}
initUsers();

// 工具函数
const readUsers = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; } };
const getChatPath = (userId, agentId) => { const d = path.join(CHATS_DIR, userId); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return path.join(d, `${agentId}.json`); };
const readChat = (userId, agentId) => { try { return fs.existsSync(getChatPath(userId, agentId)) ? JSON.parse(fs.readFileSync(getChatPath(userId, agentId), 'utf8')) : []; } catch { return []; } };
const writeChat = (userId, agentId, msgs) => fs.writeFileSync(getChatPath(userId, agentId), JSON.stringify(msgs, null, 2));

// 临时会话相关
const getTempDir = (userId) => { const d = path.join(CHATS_DIR, userId, 'temp'); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d; };
const getTempSessionsPath = (userId) => path.join(CHATS_DIR, userId, 'temp-sessions.json');

const readTempSessions = (userId) => {
  try { return fs.existsSync(getTempSessionsPath(userId)) ? JSON.parse(fs.readFileSync(getTempSessionsPath(userId), 'utf8')) : []; } catch { return []; } };
const writeTempSessions = (userId, sessions) => fs.writeFileSync(getTempSessionsPath(userId), JSON.stringify(sessions, null, 2));

const getTempSessionPath = (userId, sessionId) => path.join(getTempDir(userId), `${sessionId}.json`);
const readTempChat = (userId, sessionId) => { try { return fs.existsSync(getTempSessionPath(userId, sessionId)) ? JSON.parse(fs.readFileSync(getTempSessionPath(userId, sessionId), 'utf8')) : []; } catch { return []; } };
const writeTempChat = (userId, sessionId, msgs) => fs.writeFileSync(getTempSessionPath(userId, sessionId), JSON.stringify(msgs, null, 2));

// 清理2天无交互的临时会话
function cleanupOldTempSessions() {
  const now = Date.now();
  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
  
  try {
    const users = readUsers();
    for (const user of users) {
      const sessions = readTempSessions(user.id);
      const toDelete = sessions.filter(s => now - new Date(s.lastActive).getTime() > TWO_DAYS);
      
      for (const s of toDelete) {
        const sessionPath = getTempSessionPath(user.id, s.id);
        if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
        console.log(`[Cleanup] Deleted temp session: ${s.name} (${s.id}) for user ${user.username}`);
      }
      
      const remaining = sessions.filter(s => now - new Date(s.lastActive).getTime() <= TWO_DAYS);
      writeTempSessions(user.id, remaining);
    }
  } catch (err) {
    console.error('[Cleanup] Error:', err.message);
  }
}

// 每小时清理一次
setInterval(cleanupOldTempSessions, 60 * 60 * 1000);
// 启动时也清理一次
setTimeout(cleanupOldTempSessions, 10000);

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(token, jwtSecret); next(); }
  catch { return res.status(401).json({ error: 'token无效' }); }
}

// ============ WebSocket Gateway ============

function connectGateway() {
  const wsUrl = GATEWAY_URL.replace('https://', 'wss://').replace('http://', 'ws://');
  console.log('[Gateway] Connecting to', wsUrl);
  
  ws = new WebSocket(wsUrl, { rejectUnauthorized: false, headers: { 'Origin': 'https://localhost:3443' } });
  
  ws.on('open', () => console.log('[Gateway] WebSocket opened'));
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // 处理 challenge
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        sendConnect(msg.payload);
        return;
      }
      
      // 处理 connect 响应
      if (msg.type === 'res' && !connected) {
        if (msg.ok) {
          console.log('[Gateway] Connected successfully!');
          connected = true;
        } else {
          console.error('[Gateway] Connect failed:', msg.error);
        }
        return;
      }
      
      // 处理请求响应
      if (msg.type === 'res' && msg.id) {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          pendingRequests.delete(msg.id);
          if (msg.ok) pending.resolve(msg.payload);
          else pending.reject(new Error(msg.error?.message || 'Request failed'));
        }
        return;
      }
      
      // 处理事件
      if (msg.type === 'event') {
        const handlers = eventHandlers.get(msg.event) || [];
        handlers.forEach(h => { try { h(msg.payload); } catch {} });
        const allHandlers = eventHandlers.get('*') || [];
        allHandlers.forEach(h => { try { h(msg); } catch {} });
      }
    } catch (err) {
      console.error('[Gateway] Parse error:', err.message);
    }
  });
  
  ws.on('error', (err) => console.error('[Gateway] Error:', err.message));
  ws.on('close', () => {
    console.log('[Gateway] Closed, reconnecting...');
    connected = false;
    setTimeout(connectGateway, 3000);
  });
}

function sendConnect(challenge) {
  const params = {
    minProtocol: 3,
    maxProtocol: 3,
    client: { id: 'openclaw-control-ui', displayName: 'webchat', version: '1.0.0', platform: 'web', mode: 'webchat' },
    role: 'operator',
    scopes: ['operator.read', 'operator.write'],
    caps: [],
    commands: [],
    permissions: {},
    auth: { token: GATEWAY_TOKEN },
    locale: 'zh-CN',
    userAgent: 'openclaw-webchat/1.0.0'
  };
  
  ws.send(JSON.stringify({ type: 'req', id: (++requestId).toString(), method: 'connect', params }));
}

async function gatewayRequest(method, params, timeout = 120000) {
  if (!connected) throw new Error('Gateway not connected');
  
  return new Promise((resolve, reject) => {
    const id = (++requestId).toString();
    const timer = setTimeout(() => { pendingRequests.delete(id); reject(new Error('Timeout')); }, timeout);
    
    pendingRequests.set(id, {
      resolve: (p) => { clearTimeout(timer); resolve(p); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

// ============ API 路由 ============

app.get('/api/config', (req, res) => res.json({ title: 'OpenClaw 聊天', version: '2.0.0-ws' }));

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = readUsers().find(u => u.username === username);
  
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  if (user.disabled) return res.status(403).json({ error: '账号已被禁用' });
  
  const token = jwt.sign({ id: user.id, username: user.username, allowedAgents: user.allowedAgents || [], isAdmin: user.isAdmin || false }, jwtSecret, { expiresIn: '7d' });
  res.json({ success: true, token, user: { id: user.id, username: user.username, allowedAgents: user.allowedAgents || [], isAdmin: user.isAdmin || false } });
});

app.get('/api/auth/verify', authMiddleware, (req, res) => res.json({ valid: true, user: { id: req.user.id, username: req.user.username, allowedAgents: req.user.allowedAgents, isAdmin: req.user.isAdmin } }));
app.get('/api/agents', authMiddleware, (req, res) => res.json({ agents: agents.filter(a => (req.user.allowedAgents || []).includes(a.id)) }));
app.get('/api/chat/history/:agentId', authMiddleware, (req, res) => {
  if (!(req.user.allowedAgents || []).includes(req.params.agentId)) return res.status(403).json({ error: '无权访问' });
  res.json({ messages: readChat(req.user.id, req.params.agentId) });
});
app.delete('/api/chat/clear/:agentId', authMiddleware, (req, res) => {
  if (!(req.user.allowedAgents || []).includes(req.params.agentId)) return res.status(403).json({ error: '无权访问' });
  writeChat(req.user.id, req.params.agentId, []);
  res.json({ success: true });
});

// ===== 临时会话 API =====
app.get('/api/chat/temp/:agentId', authMiddleware, (req, res) => {
  if (!(req.user.allowedAgents || []).includes(req.params.agentId)) return res.status(403).json({ error: '无权访问' });
  const sessions = readTempSessions(req.user.id).filter(s => s.agentId === req.params.agentId);
  res.json({ sessions });
});

app.post('/api/chat/temp/:agentId', authMiddleware, (req, res) => {
  if (!(req.user.allowedAgents || []).includes(req.params.agentId)) return res.status(403).json({ error: '无权访问' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '请输入会话名称' });
  
  const sessions = readTempSessions(req.user.id);
  const newSession = {
    id: uuidv4(),
    agentId: req.params.agentId,
    name: name.trim(),
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString()
  };
  sessions.push(newSession);
  writeTempSessions(req.user.id, sessions);
  writeTempChat(req.user.id, newSession.id, []);
  
  res.json({ success: true, session: newSession });
});

app.get('/api/chat/temp/history/:sessionId', authMiddleware, (req, res) => {
  const sessions = readTempSessions(req.user.id);
  const session = sessions.find(s => s.id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  if (!(req.user.allowedAgents || []).includes(session.agentId)) return res.status(403).json({ error: '无权访问' });
  
  const messages = readTempChat(req.user.id, req.params.sessionId);
  res.json({ session, messages });
});

app.delete('/api/chat/temp/:sessionId', authMiddleware, (req, res) => {
  const sessions = readTempSessions(req.user.id);
  const sessionIndex = sessions.findIndex(s => s.id === req.params.sessionId);
  if (sessionIndex === -1) return res.status(404).json({ error: '会话不存在' });
  
  const session = sessions[sessionIndex];
  if (!(req.user.allowedAgents || []).includes(session.agentId)) return res.status(403).json({ error: '无权访问' });
  
  // 删除会话文件
  const sessionPath = getTempSessionPath(req.user.id, req.params.sessionId);
  if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  
  // 更新列表
  sessions.splice(sessionIndex, 1);
  writeTempSessions(req.user.id, sessions);
  
  res.json({ success: true });
});
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未选择文件' });
  res.json({ success: true, file: { originalName: req.file.originalname, filename: req.file.filename, mimetype: req.file.mimetype, size: req.file.size, url: `/uploads/${req.user.username}/${req.file.filename}`, absolutePath: req.file.path } });
});

// 聊天 - 发送消息 (支持主会话和临时会话)
app.post('/api/chat/send', authMiddleware, async (req, res) => {
  const { message, agentId, file, tempSessionId } = req.body;
  
  // 确定是主会话还是临时会话
  let isTempSession = false;
  let sessionId = tempSessionId;
  let sessions = [];
  
  if (tempSessionId) {
    // 临时会话
    sessions = readTempSessions(req.user.id);
    const tempSession = sessions.find(s => s.id === tempSessionId);
    if (!tempSession) return res.status(404).json({ error: '临时会话不存在' });
    if (!(req.user.allowedAgents || []).includes(tempSession.agentId)) return res.status(403).json({ error: '无权访问' });
    
    // 更新最后活跃时间
    tempSession.lastActive = new Date().toISOString();
    writeTempSessions(req.user.id, sessions);
    
    isTempSession = true;
  } else {
    // 主会话
    if (!(req.user.allowedAgents || []).includes(agentId)) return res.status(403).json({ error: '无权访问' });
  }
  
  if (!connected) return res.status(503).json({ error: 'Gateway 未连接' });
  
  // 读取或创建消息历史
  let messages = isTempSession ? readTempChat(req.user.id, tempSessionId) : readChat(req.user.id, agentId);
  let userContent = message || '';
  if (file) userContent += `\n\n[文件: ${file.originalName}]`;
  messages.push({ role: 'user', content: userContent, timestamp: new Date().toISOString(), file: file || null });
  
  const effectiveAgentId = isTempSession ? sessions.find(s => s.id === tempSessionId).agentId : agentId;
  // 主会话使用固定的 session key，临时会话使用 tempSessionId
  const chatSessionId = isTempSession ? tempSessionId : agentId;
  const sessionKey = `agent:${effectiveAgentId}:openai:webchat:${req.user.username}:chat:${chatSessionId}`;
  let requestMessage = message || '';
  if (file?.absolutePath) requestMessage = `[用户上传${file.mimetype?.startsWith('image/') ? '图片' : '文件'}: ${file.originalName}]\n文件路径: ${file.absolutePath}\n\n${message || '请查看'}`;
  
  console.log(`[Chat] ${req.user.username} -> ${agentId}`);
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  
  let ended = false;
  let fullContent = '';
  let lastContent = '';
  
  const finish = (content, error = null) => {
    if (ended) return;
    ended = true;
    if (error) { try { res.write(`data: ${JSON.stringify({ error })}\n\n`); } catch {} }
    else if (content) {
      messages.push({ role: 'assistant', content, timestamp: new Date().toISOString() });
      if (isTempSession) {
        writeTempChat(req.user.id, tempSessionId, messages);
      } else {
        writeChat(req.user.id, agentId, messages);
      }
      try { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`); } catch {}
    }
    try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
  };
  
  // 监听 chat 事件
  const chatHandler = (payload) => {
    if (payload?.sessionKey !== sessionKey) return;
    if (payload?.message?.role === 'assistant' && payload?.message?.content) {
      const content = payload.message.content;
      if (typeof content === 'string' && content.length > fullContent.length) {
        fullContent = content;
      }
    }
  };
  eventHandlers.set('chat', [chatHandler]);
  
  // 监听 agent lifecycle 事件来检测 run 完成
  let runEnded = false;
  let currentRunId = null;
  const agentHandler = (payload) => {
    // 忽略不相关的 run
    if (currentRunId && payload?.runId !== currentRunId) return;
    
    if (payload?.stream === 'lifecycle' && payload?.data?.phase === 'end') {
      console.log('[Chat] Run lifecycle end detected:', payload.runId);
      runEnded = true;
    }
    // 也监听 stream:done 作为备用
    if (payload?.stream === 'done') {
      console.log('[Chat] Stream done detected:', payload.runId);
      runEnded = true;
    }
  };
  eventHandlers.set('agent', [agentHandler]);
  
  try {
    const result = await gatewayRequest('chat.send', { sessionKey, message: requestMessage, idempotencyKey: uuidv4() }, 180000);
    console.log('[Chat] Result:', result?.status);
    
    if (result?.status === 'started' || result?.status === 'in_flight') {
      currentRunId = result.runId;
      console.log('[Chat] Run started:', currentRunId);
      
      // 等待 agent lifecycle end 事件
      const startTime = Date.now();
      const maxWait = 180000; // 3 minutes
      let checkCount = 0;
      
      while (Date.now() - startTime < maxWait && !ended && !runEnded) {
        await new Promise(r => setTimeout(r, 1000));
        checkCount++;
        
        // 每 5 秒检查一次 runEnded 状态（由 agentHandler 设置）
        if (checkCount % 5 === 0) {
          console.log(`[Chat] Check ${checkCount}: runEnded=${runEnded}`);
        }
      }
      
      // run 结束后获取历史
      if (runEnded || ended) {
        await new Promise(r => setTimeout(r, 1500)); // 等待历史写入
        try {
          const history = await gatewayRequest('chat.history', { sessionKey, limit: 10 }, 10000);
          console.log('[Chat] History response:', JSON.stringify(history).slice(0, 800));
          
          if (history?.messages && Array.isArray(history.messages)) {
            console.log('[Chat] Messages count:', history.messages.length);
            
            // 找到最后一条 assistant 消息
            for (let i = history.messages.length - 1; i >= 0; i--) {
              const msg = history.messages[i];
              
              if (msg.role === 'assistant') {
                console.log('[Chat] Found assistant message:', JSON.stringify(msg).slice(0, 300));
                
                // 内容可能是字符串或数组
                if (typeof msg.content === 'string') {
                  fullContent = msg.content;
                  console.log('[Chat] String content:', fullContent?.slice(0, 100));
                } else if (Array.isArray(msg.content)) {
                  // 提取 text 类型
                  for (const part of msg.content) {
                    if (part.type === 'text' && part.text) {
                      fullContent = part.text;
                      console.log('[Chat] Array text content:', fullContent?.slice(0, 100));
                      break;
                    }
                  }
                }
                break;
              }
            }
          }
        } catch (e) {
          console.error('[Chat] History fetch error:', e.message);
        }
      }
      
      console.log('[Chat] Final content:', fullContent?.slice(0, 100) || 'EMPTY');
      finish(fullContent || '响应超时，请稍后查看历史记录');
    } else if (result?.reply) {
      finish(result.reply);
    } else {
      finish(null, result?.error || 'Unknown response');
    }
  } catch (err) {
    console.error('[Chat] Error:', err.message);
    finish(null, err.message);
  } finally {
    eventHandlers.delete('chat');
    eventHandlers.delete('agent');
  }
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ============ 启动服务器 ============

const httpServer = http.createServer(app);

try {
  const certPath = path.resolve(__dirname, serverConfig.certFile);
  const keyPath = path.resolve(__dirname, serverConfig.keyFile);
  
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const httpsServer = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app);
    httpServer.listen(serverConfig.httpPort, () => console.log(`🔄 HTTP -> HTTPS: http://localhost:${serverConfig.httpPort}`));
    httpsServer.listen(serverConfig.httpsPort, () => {
      console.log('');
      console.log('╔════════════════════════════════════════════════════╗');
      console.log('║     🤖 OpenClaw WebChat Server (WebSocket)         ║');
      console.log('║                                                    ║');
      console.log(`║   🔒 https://localhost:${serverConfig.httpsPort}                      ║`);
      console.log('║   🔌 Gateway: WebSocket 模式                        ║');
      console.log('╚════════════════════════════════════════════════════╝');
    });
  } else {
    httpServer.listen(serverConfig.httpPort, () => console.log(`🤖 http://localhost:${serverConfig.httpPort}`));
  }
} catch (e) {
  httpServer.listen(serverConfig.httpPort, () => console.log(`🤖 http://localhost:${serverConfig.httpPort}`));
}

// 连接 Gateway
connectGateway();
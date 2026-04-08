/**
 * Gateway WebSocket Client
 * 用于连接 OpenClaw Gateway 的 WebSocket 客户端
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

class GatewayClient {
  constructor(config) {
    this.gatewayUrl = config.gatewayUrl;
    this.gatewayToken = config.gatewayToken;
    this.reconnectInterval = config.reconnectInterval || 5000;
    this.requestTimeout = config.requestTimeout || 120000; // 2 minutes for long agent runs
    
    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.deviceToken = null;
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.eventHandlers = new Map();
    this.connectPromise = null;
    
    // Device identity (简化版，用于 dangerouslyDisableDeviceAuth 模式)
    this.deviceId = this.generateDeviceId();
  }
  
  generateDeviceId() {
    // 生成一个稳定的设备 ID（基于随机但持久化）
    return 'webchat-' + crypto.randomBytes(16).toString('hex');
  }
  
  /**
   * 连接 Gateway
   */
  async connect() {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    
    this.connectPromise = this._doConnect();
    
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }
  
  async _doConnect() {
    return new Promise((resolve, reject) => {
      console.log('[GatewayClient] Connecting to', this.gatewayUrl);
      
      const wsUrl = this.gatewayUrl.replace('https://', 'wss://').replace('http://', 'ws://');
      
      this.ws = new WebSocket(wsUrl, {
        rejectUnauthorized: false, // 允许自签名证书
        headers: {
          'User-Agent': 'openclaw-webchat/1.0.0',
          'Origin': 'https://localhost:3443'
        }
      });
      
      let challengeNonce = null;
      let challengeTs = null;
      
      this.ws.on('open', () => {
        console.log('[GatewayClient] WebSocket connected, waiting for challenge...');
      });
      
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // console.log('[GatewayClient] Received message:', JSON.stringify(msg).slice(0, 200));
          this._handleMessage(msg, { challengeNonce, challengeTs, resolve, reject });
          
          // 更新 challenge 引用
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            challengeNonce = msg.payload?.nonce;
            challengeTs = msg.payload?.ts;
          }
        } catch (err) {
          console.error('[GatewayClient] Parse error:', err);
        }
      });
      
      this.ws.on('error', (err) => {
        console.error('[GatewayClient] WebSocket error:', err.message);
        reject(err);
      });
      
      this.ws.on('close', (code, reason) => {
        console.log('[GatewayClient] WebSocket closed:', code, reason?.toString());
        this.connected = false;
        this.authenticated = false;
        this._scheduleReconnect();
      });
    });
  }
  
  _handleMessage(msg, ctx) {
    const { challengeNonce, challengeTs, resolve, reject } = ctx;
    
    // 处理 challenge
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      console.log('[GatewayClient] Received challenge, sending connect...');
      this._sendConnect(msg.payload, ctx);
      return;
    }
    
    // 处理 connect 响应 - 第一个响应就是 connect 的结果
    if (msg.type === 'res' && !this.connected) {
      if (msg.ok) {
        console.log('[GatewayClient] Connected successfully!');
        console.log('[GatewayClient] Response payload:', JSON.stringify(msg.payload).slice(0, 500));
        this.connected = true;
        this.authenticated = true;
        
        if (msg.payload?.auth?.deviceToken) {
          this.deviceToken = msg.payload.auth.deviceToken;
          console.log('[GatewayClient] Received device token');
        }
        
        // 检查返回的 scopes
        if (msg.payload?.auth?.scopes) {
          this.scopes = msg.payload.auth.scopes;
          console.log('[GatewayClient] Granted scopes:', this.scopes);
        }
        
        resolve();
      } else {
        console.error('[GatewayClient] Connect failed:', msg.error);
        reject(new Error(msg.error?.message || 'Connection failed'));
      }
      return;
    }
    
    // 处理响应
    if (msg.type === 'res' && msg.id) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.payload);
        } else {
          pending.reject(new Error(msg.error?.message || 'Request failed'));
        }
      }
      return;
    }
    
    // 处理事件
    if (msg.type === 'event') {
      this._handleEvent(msg);
      return;
    }
  }
  
  _sendConnect(challenge, ctx) {
    const nonce = challenge?.nonce || '';
    const ts = challenge?.ts || Date.now();
    
    const connectParams = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'openclaw-control-ui',
        displayName: 'webchat',
        version: '1.0.0',
        platform: 'web',
        mode: 'webchat'
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      caps: [],
      commands: [],
      permissions: {},
      auth: { token: this.gatewayToken },
      locale: 'zh-CN',
      userAgent: 'openclaw-webchat/1.0.0'
      // device 字段在 dangerouslyDisableDeviceAuth 模式下可以省略
    };
    
    const connectMsg = {
      type: 'req',
      id: this._nextId(),
      method: 'connect',
      params: connectParams
    };
    
    console.log('[GatewayClient] Sending connect:', JSON.stringify(connectMsg).slice(0, 500));
    this.ws.send(JSON.stringify(connectMsg));
  }
  
  _handleEvent(msg) {
    const eventName = msg.event;
    const handlers = this.eventHandlers.get(eventName) || [];
    handlers.forEach(handler => {
      try {
        handler(msg.payload);
      } catch (err) {
        console.error('[GatewayClient] Event handler error:', err);
      }
    });
    
    // 也处理通配符事件
    const allHandlers = this.eventHandlers.get('*') || [];
    allHandlers.forEach(handler => {
      try {
        handler(msg);
      } catch (err) {
        console.error('[GatewayClient] Event handler error:', err);
      }
    });
  }
  
  /**
   * 发送请求并等待响应
   */
  async request(method, params) {
    if (!this.connected || !this.authenticated) {
      await this.connect();
    }
    
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, this.requestTimeout);
      
      this.pendingRequests.set(id, {
        resolve: (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      });
      
      const msg = {
        type: 'req',
        id,
        method,
        params
      };
      
      this.ws.send(JSON.stringify(msg));
    });
  }
  
  /**
   * 订阅事件
   */
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
  }
  
  /**
   * 取消订阅事件
   */
  off(event, handler) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) {
        handlers.splice(idx, 1);
      }
    }
  }
  
  _nextId() {
    return (++this.requestId).toString();
  }
  
  _scheduleReconnect() {
    setTimeout(() => {
      console.log('[GatewayClient] Attempting to reconnect...');
      this.connect().catch(err => {
        console.error('[GatewayClient] Reconnect failed:', err.message);
      });
    }, this.reconnectInterval);
  }
  
  /**
   * 发送聊天消息 (chat.send)
   */
  async chatSend(sessionKey, message, options = {}) {
    const params = {
      sessionKey,
      message,
      ...options
    };
    
    return this.request('chat.send', params);
  }
  
  /**
   * 获取聊天历史 (chat.history)
   */
  async chatHistory(sessionKey, options = {}) {
    const params = {
      sessionKey,
      ...options
    };
    
    return this.request('chat.history', params);
  }
  
  /**
   * 获取会话列表
   */
  async sessionsList(options = {}) {
    return this.request('sessions.list', options);
  }
  
  /**
   * 关闭连接
   */
  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
  }
}

module.exports = GatewayClient;
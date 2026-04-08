# OpenClaw WebChat

一个轻量级的网页聊天应用，通过 WebSocket 连接 OpenClaw Gateway，提供多用户、多 Agent 的对话界面。

## 功能特性

- 🔐 **用户认证** - JWT 登录验证，支持多用户管理
- 🤖 **多 Agent 支持** - 可配置多个 AI Agent，按权限分配给用户
- 💬 **主会话 + 临时会话** - 每个用户可创建多个临时会话
- 📁 **文件上传** - 支持上传文件/图片给 Agent 处理
- 🔒 **HTTPS 支持** - 自签名证书，安全连接
- 🧹 **自动清理** - 临时会话 2 天无交互自动删除
- 🌐 **WebSocket 模式** - 实时连接 Gateway，支持流式响应

## 目录结构

```
openclaw-webchat/
├── server.js              # 主服务器文件
├── gateway-client.js      # Gateway WebSocket 客户端
├── config.json            # 配置文件（用户、Agent、端口等）
├── package.json           # npm 依赖
├── generate-certs.sh      # HTTPS 证书生成脚本
├── certs/                 # HTTPS 证书目录
│   ├── cert.pem           # 证书文件
│   └── key.pem            # 私钥文件
├── data/                  # 运行时数据目录
│   ├── users.json         # 用户数据（自动生成）
│   └── chats/             # 聊天记录目录
│       ├── <userId>/      # 用户聊天目录
│       │   ├── <agentId>.json    # 主会话记录
│       │   ├── temp/             # 临时会话目录
│       │   │   ├── <sessionId>.json  # 临时会话记录
│       │   └── temp-sessions.json    # 临时会话列表
├── uploads/               # 用户上传文件目录
└── public/                # 前端静态文件
    ├── index.html         # 主页面
    └── marked.min.js      # Markdown 解析库
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置

编辑 `config.json`：

```json5
{
  "server": {
    "httpPort": 3000,      // HTTP 端口（自动跳转 HTTPS）
    "httpsPort": 3443,     // HTTPS 端口
    "certFile": "./certs/cert.pem",
    "keyFile": "./certs/key.pem"
  },
  "openclaw": {
    "apiUrl": "https://127.0.0.1:18789/v1/chat/completions",  // Gateway 地址
    "apiKey": "your-gateway-token"                            // Gateway Token
  },
  "jwtSecret": "your-jwt-secret",  // JWT 签名密钥
  "agents": [
    {
      "id": "main",
      "name": "🤖 管家",
      "description": "智能生活助理"
    },
    {
      "id": "it",
      "name": "💻 IT专家",
      "description": "技术问题解答"
    }
  ],
  "users": [
    {
      "username": "admin",
      "password": "admin123",
      "allowedAgents": ["main", "it", "oc", "gp"],
      "isAdmin": true
    },
    {
      "username": "guest",
      "password": "guest123",
      "allowedAgents": ["main"]
    }
  ]
}
```

### 3. 生成 HTTPS 证书

```bash
# 默认生成 localhost 证书（1 年有效期）
./generate-certs.sh

# 自定义域名
./generate-certs.sh --domain your-domain.com

# 自定义有效期并覆盖已有证书
./generate-certs.sh --days 730 --force

# 查看帮助
./generate-certs.sh --help
```

### 4. 启动服务

```bash
# 正常启动
npm start

# 开发模式（忽略 TLS 验证）
npm run dev
```

启动后访问：`https://localhost:3443`

## 配置说明

### server 服务器配置

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `httpPort` | HTTP 端口（跳转到 HTTPS） | 3000 |
| `httpsPort` | HTTPS 端口 | 3443 |
| `certFile` | SSL 证书路径 | `./certs/cert.pem` |
| `keyFile` | SSL 私钥路径 | `./certs/key.pem` |

### openclaw Gateway 配置

| 字段 | 说明 |
|------|------|
| `apiUrl` | Gateway WebSocket 地址（去掉 `/v1/chat/completions` 后为 WebSocket URL） |
| `apiKey` | Gateway 认证 Token（对应 `gateway.auth.token`） |

### agents Agent 配置

| 字段 | 说明 |
|------|------|
| `id` | Agent ID（对应 OpenClaw 的 agentId） |
| `name` | 显示名称（支持 Emoji） |
| `description` | Agent 描述 |

### users 用户配置

| 字段 | 说明 |
|------|------|
| `username` | 用户名 |
| `password` | 密码（明文，启动后自动加密存储到 `data/users.json`） |
| `allowedAgents` | 允许访问的 Agent ID 列表 |
| `isAdmin` | 是否管理员（可选） |

## 用户管理

### 用户初始化流程

1. 服务启动时读取 `config.json` 中的 `users` 配置
2. 检查 `data/users.json` 是否存在
3. 合入用户：
   - 已存在：更新 `allowedAgents` 和 `isAdmin`
   - 不存在：创建新用户，密码 bcrypt 加密
4. 写入 `data/users.json`

### 添加新用户

修改 `config.json`，添加用户配置，重启服务即可：

```json5
{
  "users": [
    // ...现有用户
    {
      "username": "newuser",
      "password": "password123",
      "allowedAgents": ["main", "it"]
    }
  ]
}
```

## API 接口

### 认证

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/auth/login` | POST | 登录，返回 JWT Token |
| `/api/auth/verify` | GET | 验证 Token |

### Agent

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/agents` | GET | 获取用户可访问的 Agent 列表 |

### 聊天

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/chat/history/:agentId` | GET | 获取主会话历史 |
| `/api/chat/clear/:agentId` | DELETE | 清空主会话历史 |
| `/api/chat/send` | POST | 发送消息（SSE 流式响应） |

### 临时会话

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/chat/temp/:agentId` | GET | 获取临时会话列表 |
| `/api/chat/temp/:agentId` | POST | 创建临时会话 |
| `/api/chat/temp/history/:sessionId` | GET | 获取临时会话历史 |
| `/api/chat/temp/:sessionId` | DELETE | 删除临时会话 |

### 文件

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/upload` | POST | 上传文件 |
| `/uploads/:username/:filename` | GET | 获取上传的文件 |

## 自动清理机制

临时会话会在以下情况自动清理：

- **启动后 10 秒**：执行一次清理
- **每小时**：定期清理

清理规则：`lastActive` 超过 **2 天** 的临时会话会被删除。

## 开发调试

### 查看日志

```bash
# 实时查看日志
tail -f server.log
```

### 测试 Gateway 连接

确保 OpenClaw Gateway 已启动：

```bash
openclaw gateway status
```

Gateway 默认端口：18789

### 常见问题

| 问题 | 解决方案 |
|------|----------|
| 浏览器显示证书不安全 | 自签名证书，点击"继续访问"或信任证书 |
| Gateway 未连接 | 检查 `apiUrl` 和 `apiKey` 配置，确保 Gateway 已启动 |
| 登录失败 | 检查 `config.json` 用户配置，重启服务重新初始化 |
| 消息无响应 | 检查 `server.log` 日志，确认 Agent ID 正确 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | 开发模式下忽略 TLS 证书验证 |

## 安全建议

1. **修改默认密码** - 生产环境务必修改 `admin123` 等默认密码
2. **更换 JWT Secret** - 使用随机生成的强密钥
3. **限制用户权限** - 按需分配 `allowedAgents`
4. **正规证书** - 生产环境建议使用 Let's Encrypt 或购买正规 SSL 证书

## 依赖

- express - Web 框架
- ws - WebSocket 客户端
- bcryptjs - 密码加密
- jsonwebtoken - JWT 认证
- multer - 文件上传
- uuid - ID 生成

## License

MIT
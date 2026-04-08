#!/bin/bash
#
# HTTPS 证书生成脚本
# 用法: ./generate-certs.sh [选项]
#
# 选项:
#   --domain    域名 (默认: localhost)
#   --days      有效期天数 (默认: 365)
#   --force     强制覆盖已有证书
#

set -e

# 默认配置
DOMAIN="localhost"
DAYS=365
FORCE=false
CERTS_DIR="$(cd "$(dirname "$0")" && pwd)/certs"
CERT_FILE="$CERTS_DIR/cert.pem"
KEY_FILE="$CERTS_DIR/key.pem"

# 解析参数
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain)
      DOMAIN="$2"
      shift 2
      ;;
    --days)
      DAYS="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    -h|--help)
      echo "用法: $0 [选项]"
      echo ""
      echo "选项:"
      echo "  --domain <域名>    证书域名 (默认: localhost)"
      echo "  --days <天数>      有效期天数 (默认: 365)"
      echo "  --force            强制覆盖已有证书"
      echo "  -h, --help         显示帮助"
      echo ""
      echo "示例:"
      echo "  $0                           # 生成 localhost 证书"
      echo "  $0 --domain example.com      # 生成指定域名证书"
      echo "  $0 --domain \"*.local\"       # 生成通配符证书"
      echo "  $0 --days 730 --force        # 生成 2 年有效期证书并覆盖"
      exit 0
      ;;
    *)
      echo "未知参数: $1"
      exit 1
      ;;
  esac
done

# 检查是否已存在证书
if [[ -f "$CERT_FILE" && -f "$KEY_FILE" && "$FORCE" != true ]]; then
  echo "⚠️  证书已存在: $CERT_FILE"
  echo "   使用 --force 选项覆盖"
  exit 1
fi

# 检查 openssl
if ! command -v openssl &> /dev/null; then
  echo "❌ 错误: 未安装 openssl"
  echo "   安装: apt install openssl 或 yum install openssl"
  exit 1
fi

# 创建目录
mkdir -p "$CERTS_DIR"

echo "🔑 生成 HTTPS 证书..."
echo "   域名: $DOMAIN"
echo "   有效期: $DAYS 天"
echo "   输出: $CERTS_DIR"
echo ""

# 生成私钥和证书
openssl req -x509 -newkey rsa:2048 -keyout "$KEY_FILE" -out "$CERT_FILE" \
  -days "$DAYS" -nodes -subj "/CN=$DOMAIN" \
  -addext "subjectAltName=DNS:$DOMAIN,IP:127.0.0.1,IP:::1" \
  2>/dev/null

# 设置权限
chmod 644 "$CERT_FILE"
chmod 600 "$KEY_FILE"

echo "✅ 证书生成成功!"
echo ""
echo "文件列表:"
ls -la "$CERTS_DIR"/*.pem
echo ""
echo "💡 提示:"
echo "   - 这是自签名证书，浏览器会显示不安全警告"
echo "   - 开发环境可以信任此证书继续访问"
echo "   - 生产环境建议使用 Let's Encrypt 或购买正规证书"
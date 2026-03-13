#!/bin/bash
export HOME=/root

# Write .env using heredoc (single-quoted delimiter = no expansion)
cat > /opt/roy-relay-core/packages/api/.env << 'ENVEOF'
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
SUPABASE_JWT_SECRET=your_supabase_jwt_secret
ENCRYPTION_KEY=your_encryption_key
GROQ_API_KEY=your_groq_api_key
PORT=3000
ENVEOF

echo "=== .env written ==="
cat /opt/roy-relay-core/packages/api/.env

# Kill any existing instance
pm2 delete roy-api 2>/dev/null || true

# Start API with correct bun invocation
pm2 start /root/.bun/bin/bun \
  --name roy-api \
  --cwd /opt/roy-relay-core/packages/api \
  -- run src/server.ts

sleep 5
echo "=== PM2 status ==="
pm2 status
echo "=== PM2 logs ==="
pm2 logs roy-api --lines 40 --nostream
pm2 save

# Auto-start on reboot
pm2 startup systemd -u root --hp /root | tail -1 | bash

echo "=== all-done ==="

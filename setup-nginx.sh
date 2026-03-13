#!/bin/bash

# Write nginx config (single-quoted heredoc = $host etc. are literal, correct for nginx)
cat > /etc/nginx/sites-available/roy << 'NGINXEOF'
server {
    listen 443 ssl;
    server_name 100.76.98.4;
    ssl_certificate /etc/ssl/certs/roy.crt;
    ssl_certificate_key /etc/ssl/private/roy.key;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection upgrade;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/roy /etc/nginx/sites-enabled/roy
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx && systemctl enable nginx
echo "=== nginx done ==="

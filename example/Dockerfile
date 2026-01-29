# Example container - a simple HTTP server
# Replace this with your own application

FROM node:22-alpine

WORKDIR /app

# Create a simple HTTP server
RUN cat > server.js << 'EOF'
const http = require('http');

const PORT = 8080;

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  
  // Health check endpoint
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }

  // Echo endpoint - returns request details
  if (req.url === '/echo') {
    const response = {
      timestamp: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      containerId: process.env.CONTAINER_ID || 'unknown',
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response, null, 2));
    return;
  }

  // Default response
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    message: 'Hello from container!',
    timestamp: new Date().toISOString(),
    containerId: process.env.CONTAINER_ID || 'unknown',
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
EOF

EXPOSE 8080

CMD ["node", "server.js"]

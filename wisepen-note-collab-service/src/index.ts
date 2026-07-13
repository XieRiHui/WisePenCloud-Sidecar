import http from 'http';
import { WebSocketServer } from 'ws';
import { config, loadNacosConfig } from './config';
import { setupWebSocketServer } from './ws/connection-handler';
import { initKafkaProducer, disconnectKafka } from './clients/kafka-producer';
import { registerWithNacos, deregisterFromNacos } from './nacos/registry';
import { handleHttpRequest } from './aiNoteDiff/internalHttpRouter';

async function main(): Promise<void> {
  // 从 Nacos 拉取远程配置
  await loadNacosConfig();
  console.log(`[Boot] Starting ${config.serviceName} on port ${config.port}`);

  // 注册到 Nacos
  await registerWithNacos();

  // 初始化 Kafka producer
  await initKafkaProducer();

  // 启动HTTP server
  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res).catch((err) => {
      console.error('[HTTP] Unhandled request error', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ code: 500, msg: 'internal_error', data: null }));
    });
  });

  // 在 /note-collab/ws 路径上挂 WebSocket server
  const wss = new WebSocketServer({ server, path: '/note-collab/ws' });
  setupWebSocketServer(wss);

  server.listen(config.port, () => {
    console.log(`[Boot] HTTP + WebSocket server listening on :${config.port}`);
  });

  const shutdown = async () => {
    console.log('[Shutdown] Gracefully shutting down...');
    await deregisterFromNacos();
    await disconnectKafka();
    wss.close();
    server.close();
    process.exit(0);
  };

  // 监听 SIGINT / SIGTERM，做优雅关闭
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});

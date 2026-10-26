/**
 * Mock del API de administración de frps — SOLO PARA DESARROLLO.
 *
 * Reproduce el esquema real de frp v0.71.x:
 *   GET /api/serverinfo      -> ServerInfoResp
 *   GET /api/proxy/:type     -> { proxies: ProxyStatsInfo[] }
 *
 * Sirve para probar el panel sin tener frps en ejecución.
 * Uso: node scripts/mock-frps-api.js
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 7500);

const serverInfo = {
  version: "0.71.1-mock",
  bindPort: 7000,
  vhostHTTPPort: 80,
  vhostHTTPSPort: 443,
  tcpmuxHTTPConnectPort: 0,
  kcpBindPort: 0,
  quicBindPort: 0,
  subdomainHost: "eds.dev",
  maxPoolCount: 5,
  maxPortsPerClient: 0,
  heartbeatTimeout: 90,
  allowPortsStr: "",
  tlsForce: false,
  clientCounts: 2,
  curConns: 3,
  totalTrafficIn: 482_301,
  totalTrafficOut: 1_204_882,
  proxyTypeCount: { http: 2, tcp: 1 },
};

const proxies = {
  http: [
    {
      name: "qpos",
      conf: { name: "qpos", type: "http", localIP: "127.0.0.1", localPort: 8000, subdomain: "qpos" },
      user: "",
      clientID: "mock-client-1",
      todayTrafficIn: 120_455,
      todayTrafficOut: 340_112,
      curConns: 2,
      lastStartTime: "10-26 09:14:02",
      lastCloseTime: "",
      status: "online",
    },
    {
      name: "panel-staging",
      conf: { name: "panel-staging", type: "http", localIP: "127.0.0.1", localPort: 3000, subdomain: "staging" },
      user: "",
      clientID: "mock-client-2",
      todayTrafficIn: 8_120,
      todayTrafficOut: 24_900,
      curConns: 0,
      lastStartTime: "10-26 08:02:41",
      lastCloseTime: "10-26 08:59:10",
      status: "offline",
    },
  ],
  tcp: [
    {
      name: "db",
      conf: { name: "db", type: "tcp", localIP: "127.0.0.1", localPort: 3306, remotePort: 6100 },
      user: "",
      clientID: "mock-client-1",
      todayTrafficIn: 1_024,
      todayTrafficOut: 4_096,
      curConns: 1,
      lastStartTime: "10-26 09:14:05",
      lastCloseTime: "",
      status: "online",
    },
  ],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/api/serverinfo") return json(200, serverInfo);

  const match = url.pathname.match(/^\/api\/proxy\/([a-z0-9]+)$/);
  if (match) return json(200, { proxies: proxies[match[1]] || [] });

  return json(404, { code: 404, msg: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-frps] API de administración simulada en http://127.0.0.1:${PORT}`);
});

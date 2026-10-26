import fs from "node:fs";
import path from "node:path";
import { RUNTIME_DIR } from "./config.js";
import * as store from "./store.js";
import { buildFrpcToml, buildFrpsToml } from "./toml.js";

/** Escribe data/runtime/frps.toml con la configuración actual. */
export function writeFrpsConfig() {
  const settings = store.getSettings();
  const file = path.join(RUNTIME_DIR, "frps.toml");
  fs.writeFileSync(file, buildFrpsToml(settings), "utf8");
  return file;
}

/** Escribe la config frpc de un nodo en data/runtime/<nodeId>/frpc.toml */
export function writeNodeConfig(nodeId) {
  const db = store.read();
  const node = db.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const tunnels = db.tunnels.filter((t) => t.nodeId === nodeId);
  const toml = buildFrpcToml(db.settings, node, tunnels);
  const dir = path.join(RUNTIME_DIR, nodeId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "frpc.toml");
  fs.writeFileSync(file, toml, "utf8");
  return { file, toml, node };
}

/** Regenera las configs de todos los nodos. */
export function writeAllNodeConfigs() {
  const db = store.read();
  return db.nodes.map((n) => writeNodeConfig(n.id)).filter(Boolean);
}

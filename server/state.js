'use strict';
/**
 * 纵横四海 · 网游服务器 — 进程内内存状态 registry（方案A）
 *
 * 在线玩家的实时状态暂存于内存（Map），避免每次读写 SQLite；
 * 关键变更（任务/战斗/道具结算）通过引擎事务落盘到 sqlite。
 * 玩家上下线、世界广播、在线列表均走此 registry。
 */
class WorldStateRegistry {
  constructor({ engine, storage }) {
    this.engine = engine;
    this.storage = storage;
    this.online = new Map(); // playerCanonicalId -> { conns:[ws], last_seen, location, snapshot }
    this.worldBroadcast = new Set(); // 订阅世界广播的连接
  }

  connect(playerCanonicalId, ws) {
    const entry = this.online.get(playerCanonicalId) || { conns: [], last_seen: 0, location: null, snapshot: null };
    entry.conns = entry.conns.filter((c) => c.readyState === ws.readyState);
    entry.conns.push(ws);
    this.online.set(playerCanonicalId, entry);
    return entry;
  }

  /** 虚拟在线：AI 玩家等非 WS 连接的角色进入在线列表（可被世界广播/在线列表看到） */
  registerVirtual(playerCanonicalId, { snapshot = null } = {}) {
    const entry = this.online.get(playerCanonicalId) || { conns: [], last_seen: 0, location: null, snapshot };
    this.online.set(playerCanonicalId, entry);
    return entry;
  }

  disconnect(playerCanonicalId, ws) {
    const entry = this.online.get(playerCanonicalId);
    if (!entry) return;
    entry.conns = entry.conns.filter((c) => c !== ws && c.readyState === 1);
    if (entry.conns.length === 0) this.online.delete(playerCanonicalId);
  }

  /** 刷新该玩家最近状态快照（含所在地点），供世界广播/同场景可见 */
  refresh(playerCanonicalId) {
    const entry = this.online.get(playerCanonicalId);
    if (!entry) return null;
    const view = this.engine.getPlayerView(playerCanonicalId);
    entry.last_seen = Date.now();
    entry.location = view.current_location?.map_node_canonical_id ?? null;
    entry.snapshot = {
      player: view.player,
      location: view.current_location?.display_name ?? null,
      map_node: view.current_location?.map_node_canonical_id ?? null,
      hp: view.player.current_health ?? null,
      level: view.player.level ?? null,
    };
    return entry.snapshot;
  }

  onlineList() {
    return [...this.online.entries()].map(([pid, e]) => ({ player: pid, snapshot: e.snapshot }));
  }

  /** 向某玩家所有连接发送 */
  sendTo(playerCanonicalId, payload) {
    const entry = this.online.get(playerCanonicalId);
    if (!entry) return;
    const data = JSON.stringify(payload);
    for (const ws of entry.conns) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  /** 世界广播（对所有在线玩家） */
  broadcast(payload, { exclude = null } = {}) {
    const data = JSON.stringify(payload);
    for (const [pid, entry] of this.online) {
      if (pid === exclude) continue;
      for (const ws of entry.conns) {
        if (ws.readyState === 1) ws.send(data);
      }
    }
  }

  onlineCount() { return this.online.size; }
}

module.exports = { WorldStateRegistry };

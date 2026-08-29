'use strict';
/**
 * 纵横四海 · 前端 API 层（纯客户端 → 服务器权威）
 *
 * 封装对 /api/auth/*、/api/game/* 的全部 HTTP 调用。
 * 服务器权威：state 只来自服务器；所有动作经 /api/game/action 或 /api/game/runtime。
 */
export function createGameApi({ base = '' } = {}) {
  let token = typeof localStorage !== 'undefined' ? localStorage.getItem('zhsh_token') : null;
  let currentPlayerId = typeof localStorage !== 'undefined' ? localStorage.getItem('zhsh_player_id') : null;

  async function request(pathname, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `请求失败：${response.status}`);
    }
    return data;
  }

  async function register(username, password) {
    const data = await request('/api/auth/register', { method: 'POST', body: { username, password }, auth: false });
    setToken(data.token);
    setPlayer(data.player);
    return data;
  }

  async function login(username, password) {
    const data = await request('/api/auth/login', { method: 'POST', body: { username, password }, auth: false });
    setToken(data.token);
    setPlayer(data.player);
    return data;
  }

  function setToken(value) {
    token = value;
    if (typeof localStorage !== 'undefined') {
      if (value) localStorage.setItem('zhsh_token', value);
      else localStorage.removeItem('zhsh_token');
    }
  }

  function setPlayer(player) {
    if (!player?.player_canonical_id) return;
    currentPlayerId = player.player_canonical_id;
    if (typeof localStorage !== 'undefined') localStorage.setItem('zhsh_player_id', currentPlayerId);
  }

  // ---- 游戏状态 ----
  async function getState() {
    return request('/api/game/state');
  }

  // ---- 引擎动作（task engine：移动/对话/任务/提交） ----
  async function action(actionName, args = {}, eventId) {
    return request('/api/game/action', { method: 'POST', body: { action: actionName, args, event_id: eventId } });
  }

  // ---- 玩法 runtime（combat/market/enhance/pet/discover 等）----
  async function runtime(gadget, method, args = {}, eventId) {
    return request('/api/game/runtime', { method: 'POST', body: { gadget, method, args, event_id: eventId } });
  }

  // ---- 世界 / 在线 ----
  async function getWorld() {
    return request('/api/game/world');
  }

  async function getPlayers() {
    return request('/api/game/players');
  }

  async function getIntel() {
    return request('/api/game/intel');
  }

  // ---- 超管测试控制台（本地开发/测试：改 state + 手工触发世界动态）----
  async function admin(pathname, payload = {}) {
    return request(`/api/admin/${pathname}`, { method: 'POST', body: payload });
  }

  async function getCurrentWorld() {
    return request('/api/admin/current_world');
  }

  async function npcBanter(npcName) {
    return request('/api/game/npc_banter', { method: 'POST', body: { npc_name: npcName } });
  }

  async function combatNarrative(payload) {
    return request('/api/game/combat_narrative', { method: 'POST', body: payload });
  }

  async function marketAdvice() {
    return request('/api/game/market_advice', { method: 'POST', body: {} });
  }

  async function discoveryDescription(payload) {
    return request('/api/game/discovery_description', { method: 'POST', body: payload });
  }

  async function taskNarrative(payload) {
    return request('/api/game/task_narrative', { method: 'POST', body: payload });
  }

  function getToken() { return token; }
  function getPlayerId() { return currentPlayerId; }

  return {
    request, register, login, setToken, setPlayer,
    getState, action, runtime, getWorld, getPlayers, getIntel, npcBanter, combatNarrative, marketAdvice, discoveryDescription, taskNarrative,
    admin, getCurrentWorld,
    getToken, getPlayerId,
  };
}

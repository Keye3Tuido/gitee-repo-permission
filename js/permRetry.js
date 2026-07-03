import { appendLog } from './utils.js';

const RETRY_INTERVAL = 4000;
const tasks = new Map();
let timer = null;
let ticking = false;

function stopTimerIfIdle() {
  if (timer && tasks.size === 0) {
    clearInterval(timer);
    timer = null;
  }
}

function ensureTimer() {
  if (timer || tasks.size === 0) return;
  timer = setInterval(function() { runTick(); }, RETRY_INTERVAL);
}

async function runTick() {
  if (ticking) return;
  ticking = true;
  try {
    const ids = Array.from(tasks.keys());
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const task = tasks.get(id);
      if (!task) continue;
      if (typeof task.isValid === 'function' && !task.isValid()) {
        tasks.delete(id);
        continue;
      }
      let result = 'retry';
      try {
        result = await task.run();
      } catch (e) {
        result = 'retry';
      }
      if (result === true) result = 'ok';
      if (result === false) result = 'retry';
      if (!tasks.has(id)) continue;
      if (typeof task.isValid === 'function' && !task.isValid()) {
        tasks.delete(id);
        continue;
      }
      if (result === 'ok') {
        tasks.delete(id);
        if (task.label) appendLog('权限补拉成功: ' + task.label, 'ok');
      } else if (result === 'stop') {
        tasks.delete(id);
      }
    }
  } finally {
    ticking = false;
    stopTimerIfIdle();
  }
}

function registerPermRetry(id, task) {
  if (!id || !task || typeof task.run !== 'function') return;
  tasks.set(id, task);
  ensureTimer();
}

function unregisterPermRetry(id) {
  tasks.delete(id);
  stopTimerIfIdle();
}

function clearPermRetries() {
  tasks.clear();
  stopTimerIfIdle();
}

export { registerPermRetry, unregisterPermRetry, clearPermRetries };

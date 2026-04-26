'use strict';
/* ============================================================
   ЧИТАЛКА — sync.js
   Синхронизация позиции чтения и аннотаций через GitHub Gist.
   Не требует карты — только бесплатный GitHub аккаунт.
   ============================================================ */

// ── BOOK HASH ─────────────────────────────────────────────────
async function computeBookHash(buffer) {
  try {
    const sample = buffer instanceof ArrayBuffer
      ? buffer.slice(0, 8192)
      : buffer;
    const hash = await crypto.subtle.digest('SHA-256', sample);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 24);
  } catch {
    return null;
  }
}

// ── SYNC CLIENT ───────────────────────────────────────────────
class SyncClient {
  constructor(githubToken, syncCode) {
    this.token     = githubToken;
    this.code      = syncCode;   // общий «ключ» на всех устройствах
    this._gistId   = null;       // кэш ID gist'а
    this._progressTimers = {};
  }

  get _headers() {
    return {
      'Authorization': `token ${this.token}`,
      'Accept':        'application/vnd.github.v3+json',
      'Content-Type':  'application/json',
    };
  }

  async _apiFetch(path, opts = {}) {
    const res = await fetch('https://api.github.com' + path, {
      ...opts,
      headers: { ...this._headers, ...opts.headers },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status}: ${text.slice(0, 120)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  // ── Найти или создать gist ─────────────────────────────────
  async _ensureGist() {
    if (this._gistId) return this._gistId;

    const gistName = `читалка-${this.code}`;

    // Листаем gists пользователя (макс 100)
    const list = await this._apiFetch('/gists?per_page=100');
    const found = list.find(g => g.description === gistName);

    if (found) {
      this._gistId = found.id;
    } else {
      const created = await this._apiFetch('/gists', {
        method: 'POST',
        body: JSON.stringify({
          description: gistName,
          public: false,
          files: {
            'sync.json': {
              content: JSON.stringify({ progress: {}, annotations: {} })
            }
          }
        })
      });
      this._gistId = created.id;
    }
    return this._gistId;
  }

  // ── Читаем данные из gist ─────────────────────────────────
  async _readData() {
    const id   = await this._ensureGist();
    const gist = await this._apiFetch(`/gists/${id}`);
    const raw  = gist.files?.['sync.json']?.content;
    if (!raw) return { progress: {}, annotations: {} };
    try { return JSON.parse(raw); }
    catch { return { progress: {}, annotations: {} }; }
  }

  // ── Пишем данные в gist ───────────────────────────────────
  async _writeData(data) {
    const id = await this._ensureGist();
    await this._apiFetch(`/gists/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        files: { 'sync.json': { content: JSON.stringify(data) } }
      })
    });
  }

  // ── Проверка соединения ───────────────────────────────────
  async ping() {
    try {
      await this._apiFetch('/user');
      return true;
    } catch {
      return false;
    }
  }

  // ── PROGRESS ─────────────────────────────────────────────
  saveProgressDebounced(bookHash, progress, delayMs = 4000) {
    clearTimeout(this._progressTimers[bookHash]);
    this._progressTimers[bookHash] = setTimeout(() => {
      this.saveProgress(bookHash, progress).catch(() => {});
    }, delayMs);
  }

  async saveProgress(bookHash, progress) {
    const data = await this._readData();
    data.progress[bookHash] = {
      progress,
      updated_at: new Date().toISOString(),
    };
    await this._writeData(data);
  }

  async getProgress(bookHash) {
    const data = await this._readData();
    return data.progress[bookHash] || null;
  }

  // ── ANNOTATIONS ───────────────────────────────────────────
  async saveAnnotation(bookHash, ann) {
    const data = await this._readData();
    if (!data.annotations[bookHash]) data.annotations[bookHash] = [];
    const list = data.annotations[bookHash];
    const idx  = list.findIndex(a => a.ann_uuid === (ann.ann_uuid || ann.uuid));
    const entry = {
      ann_uuid:   ann.ann_uuid || ann.uuid,
      type:       ann.type,
      quote:      ann.quote,
      note:       ann.note || '',
      context:    ann.context || {},
      created_at: ann.createdAt,
    };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    await this._writeData(data);
  }

  async deleteAnnotation(bookHash, annUuid) {
    const data = await this._readData();
    if (data.annotations[bookHash]) {
      data.annotations[bookHash] = data.annotations[bookHash]
        .filter(a => a.ann_uuid !== annUuid);
    }
    await this._writeData(data);
  }

  async getAnnotations(bookHash) {
    const data = await this._readData();
    return data.annotations[bookHash] || [];
  }
}

// ── TELEGRAM SYNC ─────────────────────────────────────────────
class TelegramSync {
  constructor(botToken) {
    this.token = botToken;
    this._base = `https://api.telegram.org/bot${botToken}`;
  }

  // Проверка токена
  async ping() {
    try {
      const res = await fetch(`${this._base}/getMe`);
      const data = await res.json();
      return data.ok === true;
    } catch { return false; }
  }

  // Получить список книг из последних сообщений бота
  async fetchFileCatalog() {
    const res = await fetch(`${this._base}/getUpdates?limit=100&allowed_updates=%5B%22message%22%5D`);
    if (!res.ok) throw new Error('Telegram API недоступен');
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || 'Ошибка Telegram');

    const seen = new Set();
    const files = [];

    for (const update of (data.result || [])) {
      const doc = update.message?.document;
      if (!doc) continue;
      if (seen.has(doc.file_id)) continue;
      seen.add(doc.file_id);

      const ext = (doc.file_name || '').split('.').pop().toLowerCase();
      if (!['epub', 'pdf', 'txt', 'fb2'].includes(ext)) continue;

      files.push({
        file_id:   doc.file_id,
        file_name: doc.file_name || 'Книга.' + ext,
        file_size: doc.file_size || 0,
        ext,
      });
    }

    // Свежие сначала
    return files.reverse();
  }

  // Скачать файл по file_id → ArrayBuffer
  async downloadFile(file_id) {
    const r1 = await fetch(`${this._base}/getFile?file_id=${encodeURIComponent(file_id)}`);
    if (!r1.ok) throw new Error('Ошибка получения файла');
    const j1 = await r1.json();
    if (!j1.ok || !j1.result?.file_path) {
      throw new Error('Файл недоступен — возможно, он больше 20 МБ');
    }

    const fileUrl = `https://api.telegram.org/file/bot${this.token}/${j1.result.file_path}`;
    const r2 = await fetch(fileUrl);
    if (!r2.ok) throw new Error('Ошибка скачивания файла');
    return r2.arrayBuffer();
  }

  // Форматирование размера
  static formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' КБ';
    return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
  }
}

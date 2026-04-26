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

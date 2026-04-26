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

  async _apiFetch(path, opts = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch('https://api.github.com' + path, {
        ...opts,
        signal: controller.signal,
        headers: { ...this._headers, ...opts.headers },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`GitHub ${res.status}: ${text.slice(0, 120)}`);
      }
      return res.status === 204 ? null : res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Превышено время ожидания (GitHub)');
      throw e;
    } finally {
      clearTimeout(timer);
    }
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

// ── DROPBOX SYNC ──────────────────────────────────────────────

// PKCE helpers
function _dbxVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
async function _dbxChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

class DropboxSync {
  constructor(accessToken, refreshToken = null, clientId = null) {
    this.accessToken  = accessToken;
    this.refreshToken = refreshToken;
    this.clientId     = clientId;
    this.folder       = '/Читалка';
  }

  // ── Redirect URI = текущая страница без query/hash ────────
  static getRedirectUri() {
    return window.location.origin + window.location.pathname.replace(/\/$/, '');
  }

  // ── Начать OAuth (редирект на Dropbox) ───────────────────
  static async startOAuth(clientId) {
    const verifier  = _dbxVerifier();
    const challenge = await _dbxChallenge(verifier);
    sessionStorage.setItem('dbx_verifier',  verifier);
    sessionStorage.setItem('dbx_client_id', clientId);

    const params = new URLSearchParams({
      client_id:             clientId,
      response_type:         'code',
      code_challenge:        challenge,
      code_challenge_method: 'S256',
      redirect_uri:          DropboxSync.getRedirectUri(),
      token_access_type:     'offline',
    });
    window.location.href = 'https://www.dropbox.com/oauth2/authorize?' + params;
  }

  // ── Завершить OAuth (обмен кода на токены) ────────────────
  static async completeOAuth(code) {
    const verifier  = sessionStorage.getItem('dbx_verifier');
    const clientId  = sessionStorage.getItem('dbx_client_id');
    sessionStorage.removeItem('dbx_verifier');
    sessionStorage.removeItem('dbx_client_id');
    if (!verifier || !clientId) throw new Error('OAuth-сессия устарела, попробуй снова');

    const res = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type:    'authorization_code',
        client_id:     clientId,
        redirect_uri:  DropboxSync.getRedirectUri(),
        code_verifier: verifier,
      }),
    });
    const data = await res.json();
    if (!data.access_token) throw new Error(data.error_description || 'OAuth ошибка');
    return { clientId, accessToken: data.access_token, refreshToken: data.refresh_token };
  }

  // ── Обновить access token через refresh token ─────────────
  async _refresh() {
    if (!this.refreshToken || !this.clientId) throw new Error('Нет refresh token — войди заново');
    const res = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: this.refreshToken,
        client_id:     this.clientId,
      }),
    });
    const data = await res.json();
    if (!data.access_token) throw new Error('Не удалось обновить токен — войди заново');
    this.accessToken = data.access_token;
  }

  // ── Универсальный fetch с авто-рефрешем ──────────────────
  async _fetch(url, opts = {}) {
    const makeReq = () => fetch(url, {
      ...opts,
      headers: { 'Authorization': `Bearer ${this.accessToken}`, ...opts.headers },
    });
    let res = await makeReq();
    if (res.status === 401) {
      await this._refresh();
      res = await makeReq();
    }
    return res;
  }

  // ── Проверка соединения ───────────────────────────────────
  async ping() {
    try {
      const res = await this._fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        this._accountName = data.name?.display_name || '';
      }
      return res.ok;
    } catch { return false; }
  }

  // ── Список книг из папки /Читалка ─────────────────────────
  async listBooks() {
    const res = await this._fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: this.folder, recursive: false }),
    });
    if (res.status === 409) return []; // папка не существует ещё
    if (!res.ok) throw new Error(`Dropbox error ${res.status}`);
    const data = await res.json();

    return (data.entries || [])
      .filter(e => e['.tag'] === 'file')
      .filter(e => ['epub','pdf','txt','fb2'].includes(e.name.split('.').pop().toLowerCase()))
      .map(e => ({
        path: e.path_lower,
        name: e.name,
        size: e.size || 0,
        ext:  e.name.split('.').pop().toLowerCase(),
        id:   e.id,
      }));
  }

  // ── Скачать файл → ArrayBuffer ────────────────────────────
  async downloadFile(path) {
    const res = await this._fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': JSON.stringify({ path }) },
    });
    if (!res.ok) throw new Error(`Ошибка скачивания (${res.status})`);
    const blob = await res.blob();
    return blob.arrayBuffer();
  }

  static formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' КБ';
    return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
  }
}

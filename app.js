'use strict';
/* ============================================================
   ЧИТАЛКА — app.js
   Поддерживает: EPUB, PDF, TXT, FB2
   Хранение: IndexedDB
   Obsidian: File System Access API (Mac / Chrome)
   ============================================================ */

// ─────────────────────────────────────────────────────────────
//  DATABASE
// ─────────────────────────────────────────────────────────────
class ReaderDB {
  constructor() { this.db = null; }

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('reader-app', 2);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          const bs = db.createObjectStore('books', { keyPath: 'id', autoIncrement: true });
          bs.createIndex('addedAt', 'addedAt');
        }
        if (!db.objectStoreNames.contains('annotations')) {
          const as = db.createObjectStore('annotations', { keyPath: 'id', autoIncrement: true });
          as.createIndex('bookId', 'bookId');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      req.onsuccess = (e) => { this.db = e.target.result; resolve(this); };
      req.onerror = () => reject(req.error);
    });
  }

  _store(name, mode) {
    return this.db.transaction([name], mode).objectStore(name);
  }

  _req(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  addBook(data) { return this._req(this._store('books','readwrite').add(data)); }

  getAllBooks() { return this._req(this._store('books','readonly').getAll()); }

  getBook(id) { return this._req(this._store('books','readonly').get(id)); }

  async updateBook(id, updates) {
    const book = await this.getBook(id);
    const merged = { ...book, ...updates };
    return this._req(this._store('books','readwrite').put(merged));
  }

  async deleteBook(id) {
    await this._req(this._store('books','readwrite').delete(id));
    // delete annotations
    const anns = await this.getAnnotations(id);
    const tx = this.db.transaction(['annotations'],'readwrite');
    const st = tx.objectStore('annotations');
    for (const a of anns) st.delete(a.id);
    return new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }

  addAnnotation(ann) { return this._req(this._store('annotations','readwrite').add(ann)); }

  async getAnnotations(bookId) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(['annotations'],'readonly');
      const idx = tx.objectStore('annotations').index('bookId');
      const req = idx.getAll(bookId);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  deleteAnnotation(id) { return this._req(this._store('annotations','readwrite').delete(id)); }

  async getSetting(key, def = null) {
    const r = await this._req(this._store('settings','readonly').get(key));
    return r ? r.value : def;
  }

  setSetting(key, value) {
    return this._req(this._store('settings','readwrite').put({ key, value }));
  }
}

// ─────────────────────────────────────────────────────────────
//  FB2 PARSER
// ─────────────────────────────────────────────────────────────
function parseFB2(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8').decode(buffer);
    if (text.includes('<?xml') && !text.includes('<FictionBook') && !text.includes('<fictionbook')) {
      throw new Error('try other encoding');
    }
  } catch {
    try { text = new TextDecoder('windows-1251').decode(buffer); } catch { text = ''; }
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');

  if (doc.querySelector('parsererror')) {
    // fallback: treat as text
    return { title: 'FB2 файл', author: '', html: `<p>${text.replace(/</g,'&lt;')}</p>`, coverUrl: null };
  }

  const q = (sel) => doc.querySelector(sel);
  const title = q('title-info book-title')?.textContent?.trim() || 'Без названия';
  const firstName = q('title-info author first-name')?.textContent?.trim() || '';
  const lastName = q('title-info author last-name')?.textContent?.trim() || '';
  const author = [firstName, lastName].filter(Boolean).join(' ');

  // Cover
  let coverUrl = null;
  const coverImg = q('coverpage image');
  if (coverImg) {
    const href = coverImg.getAttribute('l:href') || coverImg.getAttribute('xlink:href') || '';
    const imgId = href.replace('#', '');
    const bin = doc.querySelector(`binary[id="${imgId}"]`);
    if (bin) {
      const ct = bin.getAttribute('content-type') || 'image/jpeg';
      coverUrl = `data:${ct};base64,${bin.textContent.trim()}`;
    }
  }

  // Body
  function inlineNode(node) {
    if (node.nodeType === 3) return escHtml(node.textContent);
    const tag = node.nodeName.toLowerCase();
    const inner = Array.from(node.childNodes).map(inlineNode).join('');
    if (tag === 'emphasis') return `<em>${inner}</em>`;
    if (tag === 'strong') return `<strong>${inner}</strong>`;
    if (tag === 'strikethrough') return `<s>${inner}</s>`;
    if (tag === 'sup') return `<sup>${inner}</sup>`;
    if (tag === 'sub') return `<sub>${inner}</sub>`;
    if (tag === 'a') return inner; // strip links, keep text
    return inner;
  }

  function processSection(sec, depth = 0) {
    let html = '';
    for (const node of sec.childNodes) {
      const tag = node.nodeName.toLowerCase();
      if (tag === 'title') {
        const level = depth <= 0 ? 'h2' : 'h3';
        const t = Array.from(node.querySelectorAll('p')).map(p => p.textContent).join(' ').trim()
                   || node.textContent.trim();
        if (t) html += `<${level} class="chapter-title">${escHtml(t)}</${level}>`;
      } else if (tag === 'p') {
        html += `<p>${inlineNode(node)}</p>`;
      } else if (tag === 'empty-line') {
        html += '<p>&nbsp;</p>';
      } else if (tag === 'section') {
        html += processSection(node, depth + 1);
      } else if (tag === 'cite') {
        html += `<blockquote>${Array.from(node.childNodes).map(n => {
          if (n.nodeName.toLowerCase() === 'p') return `<p>${inlineNode(n)}</p>`;
          return inlineNode(n);
        }).join('')}</blockquote>`;
      } else if (tag === 'poem') {
        const stanzas = node.querySelectorAll('stanza');
        let poemHtml = '';
        stanzas.forEach(st => {
          st.querySelectorAll('v').forEach(v => { poemHtml += `${escHtml(v.textContent)}<br>`; });
          poemHtml += '<br>';
        });
        html += `<blockquote class="poem">${poemHtml}</blockquote>`;
      } else if (tag === 'epigraph') {
        html += `<blockquote class="epigraph">${inlineNode(node)}</blockquote>`;
      } else if (tag === 'image') {
        // skip inline images for performance
      }
    }
    return html;
  }

  let html = '';
  // Use first non-notes body
  const bodies = doc.querySelectorAll('body');
  for (const body of bodies) {
    if (body.getAttribute('name') === 'notes') continue;
    const sections = body.querySelectorAll(':scope > section');
    if (sections.length === 0) {
      html += processSection(body);
    } else {
      sections.forEach(s => { html += processSection(s); });
    }
  }

  if (!html.trim()) html = `<p>Не удалось разобрать содержимое FB2 файла.</p>`;

  return { title, author, html, coverUrl };
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─────────────────────────────────────────────────────────────
//  TXT PARSER
// ─────────────────────────────────────────────────────────────
function parseTXT(buffer) {
  let text;
  try { text = new TextDecoder('utf-8').decode(buffer); }
  catch { text = new TextDecoder('windows-1251').decode(buffer); }

  const lines = text.split('\n');
  const rawTitle = lines[0].trim().slice(0, 120);
  const title = rawTitle || 'Текстовый файл';

  const paragraphs = text.split(/\n{2,}/);
  const html = paragraphs.map(p => {
    const t = p.trim();
    if (!t) return '';
    return `<p>${escHtml(t).replace(/\n/g, '<br>')}</p>`;
  }).filter(Boolean).join('\n');

  return { title, author: '', html, coverUrl: null };
}

// ─────────────────────────────────────────────────────────────
//  EPUB NATIVE PARSER  (uses JSZip, no iframe)
// ─────────────────────────────────────────────────────────────
async function parseEPUBNative(buffer) {
  if (typeof JSZip === 'undefined') throw new Error('JSZip не загружен — проверь интернет');

  const zip = await JSZip.loadAsync(buffer);

  // 1. Read META-INF/container.xml → find OPF path
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('Не найден container.xml — файл не является корректным EPUB');
  const containerXml = await containerFile.async('text');
  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const opfPath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('Не найден путь к OPF');

  // 2. Parse OPF
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('OPF файл не найден: ' + opfPath);
  const opfXml = await opfFile.async('text');
  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

  // Metadata
  const title = (
    opfDoc.querySelector('title')?.textContent ||
    opfDoc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent ||
    'EPUB'
  ).trim();
  const author = (
    opfDoc.querySelector('creator')?.textContent ||
    opfDoc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'creator')[0]?.textContent ||
    ''
  ).trim();

  // Base dir for resolving relative paths
  const opfDir = opfPath.includes('/')
    ? opfPath.split('/').slice(0, -1).join('/') + '/'
    : '';

  // Manifest: id → {href, type, fullPath}
  const manifest = {};
  opfDoc.querySelectorAll('manifest item').forEach(item => {
    const id   = item.getAttribute('id');
    const href = item.getAttribute('href');
    const type = item.getAttribute('media-type') || '';
    if (id && href) manifest[id] = { href, type, fullPath: opfDir + decodeURIComponent(href) };
  });

  // Spine: reading order
  const spineIds = Array.from(opfDoc.querySelectorAll('spine itemref'))
    .map(el => el.getAttribute('idref'))
    .filter(Boolean);

  // 3. Cover image (best-effort)
  let coverUrl = null;
  try {
    const coverId = opfDoc.querySelector('meta[name="cover"]')?.getAttribute('content');
    const coverItem = coverId && manifest[coverId]
      ? manifest[coverId]
      : Object.values(manifest).find(m =>
          m.type?.startsWith('image/') &&
          (m.href.toLowerCase().includes('cover') || m.fullPath.toLowerCase().includes('cover'))
        );
    if (coverItem) {
      const f = zip.file(coverItem.fullPath) || zip.file(opfDir + coverItem.href);
      if (f) {
        const b64 = await f.async('base64');
        coverUrl = `data:${coverItem.type || 'image/jpeg'};base64,${b64}`;
      }
    }
  } catch {}

  // 4. Process spine chapters → combined HTML
  function nodeToHtml(node) {
    if (node.nodeType === 3) { // text
      return escHtml(node.textContent);
    }
    const tag = node.nodeName.toLowerCase();
    const kids = Array.from(node.childNodes).map(nodeToHtml).join('');

    if (tag === 'p')   return `<p>${kids}</p>`;
    if (tag === 'br')  return '<br>';
    if (tag === 'hr')  return '<hr>';
    if (/^h[1-6]$/.test(tag)) return `<h2 class="chapter-title">${kids}</h2>`;
    if (tag === 'blockquote' || tag === 'cite') return `<blockquote>${kids}</blockquote>`;
    if (tag === 'em' || tag === 'i')    return `<em>${kids}</em>`;
    if (tag === 'strong' || tag === 'b') return `<strong>${kids}</strong>`;
    if (tag === 'sup') return `<sup>${kids}</sup>`;
    if (tag === 'sub') return `<sub>${kids}</sub>`;
    if (tag === 'img' || tag === 'image') return ''; // skip images
    if (tag === 'script' || tag === 'style' || tag === 'link') return '';
    return kids; // div, span, section, article, nav → just children
  }

  let html = '';
  for (const id of spineIds) {
    const item = manifest[id];
    if (!item) continue;
    if (!item.type.includes('html') && !item.type.includes('xhtml') && !item.type.includes('xml')) continue;

    const f = zip.file(item.fullPath);
    if (!f) continue;

    const raw = await f.async('text');
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    doc.querySelectorAll('script,style,link,meta,nav').forEach(el => el.remove());
    const body = doc.querySelector('body');
    if (body) {
      html += Array.from(body.childNodes).map(nodeToHtml).join('\n');
      html += '\n<p>&nbsp;</p>\n'; // chapter separator
    }
  }

  if (!html.trim()) throw new Error('EPUB не содержит текстового контента');
  return { title, author, html, coverUrl };
}

// ─────────────────────────────────────────────────────────────
//  TEXT HIGHLIGHT HELPERS
// ─────────────────────────────────────────────────────────────

/** Находит диапазон текста в DOM-контейнере через TreeWalker */
function findTextRange(container, searchText) {
  if (!searchText || searchText.length < 2 || !container) return null;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let totalText = '';
  let node;
  while ((node = walker.nextNode())) {
    // пропускаем текст внутри самих mark-элементов при переиндексации
    nodes.push({ node, start: totalText.length });
    totalText += node.textContent;
  }

  const idx = totalText.indexOf(searchText);
  if (idx === -1) return null;
  const endIdx = idx + searchText.length;

  let startNode = null, startOff = 0, endNode = null, endOff = 0;
  for (const { node, start } of nodes) {
    const end = start + node.textContent.length;
    if (!startNode && endIdx > start && idx < end) {
      startNode = node;
      startOff = Math.max(0, idx - start);
    }
    if (startNode && endIdx <= end) {
      endNode = node;
      endOff = endIdx - start;
      break;
    }
  }
  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  return range;
}

/** Оборачивает range в <mark> с данными аннотации */
function applyHighlightRange(range, annId, type) {
  const mark = document.createElement('mark');
  mark.className = 'reader-highlight' + (type === 'note' ? ' reader-highlight-note' : '');
  mark.dataset.annId = String(annId);
  try {
    range.surroundContents(mark);
  } catch {
    try {
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
    } catch { return false; }
  }
  return true;
}

/** Снимает выделение с mark-элемента (при удалении аннотации) */
function removeHighlightMark(annId) {
  const mark = document.querySelector(`mark.reader-highlight[data-ann-id="${annId}"]`);
  if (!mark) return;
  const parent = mark.parentNode;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  parent.normalize();
}

// ─────────────────────────────────────────────────────────────
//  COLOUR PALETTES FOR GENERATED COVERS
// ─────────────────────────────────────────────────────────────
const COVER_PALETTES = [
  ['#2d4059','#ea5455'],['#3d5a80','#98c1d9'],
  ['#2c3e50','#e74c3c'],['#1a535c','#4ecdc4'],
  ['#4a1942','#c7b8ea'],['#2b4865','#dde8b9'],
  ['#2f4f4f','#8fbc8f'],['#4b0082','#9370db'],
  ['#8b0000','#f5deb3'],['#1b4332','#74c69d'],
];
function coverPalette(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return COVER_PALETTES[h % COVER_PALETTES.length];
}

// ─────────────────────────────────────────────────────────────
//  MAIN APP
// ─────────────────────────────────────────────────────────────
class App {
  constructor() {
    this.db = new ReaderDB();
    this.currentBook = null;
    this.currentAnnotations = [];
    this.obsidianDir = null;   // FileSystemDirectoryHandle
    this.obsidianDirName = ''; // for display

    // Obsidian: handle сохранённой директории (может требовать переразрешения)
    this._pendingObsidianHandle = null;

    // iOS: таймер для авто-сброса выделения (убирает нативное меню)
    this._iosSelectionClearTimer = null;

    // EPUB
    this.epubBook = null;
    this.rendition = null;

    // PDF
    this.pdfDoc = null;
    this.pdfCurrentPage = 1;
    this.pdfTotalPages = 0;
    this.pdfZoom = 1.0; // multiplier on top of fit-page scale

    // Selection state
    this.pendingSelection = null; // { text, context }

    // Settings
    this.settings = { theme: 'sepia', fontSize: 19, lineHeight: 1.8 };

    // Sync
    this.sync = null;         // SyncClient instance
    this.syncReady = false;

    // Dropbox
    this.dropbox = null;          // DropboxSync instance
    this._downloadingPaths = new Set(); // пути файлов которые сейчас скачиваются
    this._autoSyncing = false;    // флаг чтобы не запускать два автосинка сразу
  }

  // ── INIT ──────────────────────────────────────────────────
  async init() {
    await this.db.init();
    await this.loadSettings();
    this.applyTheme();
    this.bindEvents();
    this.updateObsidianUI(); // адаптируем кнопку под Mac / iPad сразу
    this.registerSW();
    await this.initSync();
    await this._restoreObsidianDir(); // пробуем восстановить сохранённую папку vault

    // Detect Dropbox OAuth callback (?code=...)
    const _urlParams = new URLSearchParams(window.location.search);
    const _oauthCode = _urlParams.get('code');
    if (_oauthCode) {
      history.replaceState({}, '', window.location.pathname);
      await this._completeDropboxOAuth(_oauthCode);
    }
    await this.initDropbox();

    await this.renderLibrary();
  }

  async loadSettings() {
    const s = await this.db.getSetting('appSettings', null);
    if (s) this.settings = { ...this.settings, ...s };
    this.applyReadingCSS();
  }

  async saveSettings() {
    await this.db.setSetting('appSettings', this.settings);
  }

  applyTheme() {
    document.body.className = `theme-${this.settings.theme}`;
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === this.settings.theme);
    });
  }

  applyReadingCSS() {
    document.documentElement.style.setProperty('--font-size', this.settings.fontSize + 'px');
    document.documentElement.style.setProperty('--line-height', this.settings.lineHeight);
  }

  registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  // ── LIBRARY ───────────────────────────────────────────────
  async renderLibrary() {
    const books = await this.db.getAllBooks();
    const grid = document.getElementById('books-grid');
    const empty = document.getElementById('empty-library');

    books.sort((a, b) => (b.lastRead || b.addedAt) - (a.lastRead || a.addedAt));

    if (books.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'flex';
      return;
    }
    empty.style.display = 'none';
    grid.innerHTML = books.map(b => this.bookCardHTML(b)).join('');

    // Bind card events
    grid.querySelectorAll('.book-card').forEach(card => {
      const id = parseInt(card.dataset.id);
      card.addEventListener('click', (e) => {
        if (e.target.closest('.delete-btn')) return;
        this.openBook(id);
      });
      card.querySelector('.delete-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm('Удалить книгу?')) {
          await this.db.deleteBook(id);
          await this.renderLibrary();
          this.showToast('Книга удалена');
        }
      });
    });
  }

  bookCardHTML(book) {
    const pct = Math.round((book.progress || 0) * 100);
    const [bg1, bg2] = coverPalette(book.title);

    const coverInner = book.coverUrl
      ? `<img class="book-cover" src="${book.coverUrl}" alt="" loading="lazy">`
      : `<div class="book-cover-placeholder" style="background:linear-gradient(135deg,${bg1},${bg2})">
           <span>📖</span>
           <span class="cover-title">${escHtml(book.title)}</span>
         </div>`;

    return `<div class="book-card" data-id="${book.id}">
      ${coverInner}
      <span class="format-tag">${book.format.toUpperCase()}</span>
      <button class="delete-btn" title="Удалить">✕</button>
      <div class="book-info">
        <div class="book-title-card">${escHtml(book.title)}</div>
        ${book.author ? `<div class="book-author-card">${escHtml(book.author)}</div>` : ''}
        <div class="book-progress-bar">
          <div class="book-progress-fill" style="width:${pct}%"></div>
        </div>
      </div>
    </div>`;
  }

  showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.toggle('active', s.id === name);
    });
  }

  // ── ADD BOOK ──────────────────────────────────────────────
  async addBooks(files) {
    let added = 0;
    // Получаем список уже добавленных имён файлов чтобы не дублировать
    const existingBooks = await this.db.getAllBooks();
    const existingNames = new Set(existingBooks.map(b => b.sourceFileName).filter(Boolean));

    for (const file of files) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!['epub','pdf','txt','fb2'].includes(ext)) {
        this.showToast(`${file.name}: формат не поддерживается`);
        continue;
      }
      // Пропускаем если файл с таким именем уже есть
      if (existingNames.has(file.name)) {
        this.showToast(`«${file.name}» уже в библиотеке`);
        continue;
      }
      existingNames.add(file.name); // на случай если один файл добавляется дважды за раз
      this.showToast('Добавляем ' + file.name + '…');
      try {
        const buf = await file.arrayBuffer();
        let meta = { title: file.name.replace(/\.[^.]+$/, ''), author: '', coverUrl: null };

        if (ext === 'txt') {
          const parsed = parseTXT(buf);
          meta = { ...meta, ...parsed };
        } else if (ext === 'fb2') {
          const parsed = parseFB2(buf);
          meta = { ...meta, ...parsed };
        } else if (ext === 'epub') {
          const parsed = await parseEPUBNative(buf);
          meta = { ...meta, ...parsed };
        }
        // pdf: just store, title = filename

        await this.db.addBook({
          title:          meta.title,
          author:         meta.author || '',
          format:         ext,
          content:        buf,
          coverUrl:       meta.coverUrl || null,
          html:           meta.html || null,
          progress:       0,
          addedAt:        Date.now(),
          lastRead:       null,
          sourceFileName: file.name,
        });
        added++;
      } catch (err) {
        this.showToast('Ошибка: ' + err.message);
      }
    }
    if (added > 0) {
      await this.renderLibrary();
      this.showToast(added === 1 ? 'Книга добавлена ✓' : `Добавлено ${added} книг ✓`);
    }
  }

  // ── OPEN BOOK ─────────────────────────────────────────────
  async openBook(id) {
    // Cleanup previous
    this.destroyReader();

    const book = await this.db.getBook(id);
    if (!book) return;
    this.currentBook = book;
    this.currentAnnotations = await this.db.getAnnotations(id);

    await this.db.updateBook(id, { lastRead: Date.now() });

    document.getElementById('reader-title').textContent = book.title;
    document.getElementById('reader-loading').style.display = 'flex';
    document.getElementById('reader-footer').style.display = 'none';

    this.showScreen('reader');
    this.updateAnnotationBadge();

    try {
      // Запускаем оба запроса к Gist параллельно пока рендерится книга
      const remoteProgressPromise     = this.fetchRemoteProgress(book);
      const remoteAnnotationsPromise  = this.fetchRemoteAnnotations(book);

      if (book.format === 'epub') await this.renderEPUB(book);
      else if (book.format === 'pdf') await this.renderPDF(book);
      else await this.renderText(book);

      // Предлагаем перейти к удалённой позиции если она свежее
      this._offerRemotePosition(book, await remoteProgressPromise);

      // Подтягиваем аннотации с других устройств
      const remoteAnns = await remoteAnnotationsPromise;
      await this._mergeRemoteAnnotations(book, remoteAnns);
    } catch (err) {
      document.getElementById('reader-loading').innerHTML =
        `<p style="color:var(--accent-2);padding:20px;text-align:center">
          Ошибка загрузки: ${err.message}
        </p>`;
    }
  }

  destroyReader() {
    this.pdfDoc = null;
    // Убираем PDF-свайп листенеры
    const body = document.getElementById('reader-body');
    if (this._pdfSwipeStart) body.removeEventListener('touchstart', this._pdfSwipeStart);
    if (this._pdfSwipeEnd)   body.removeEventListener('touchend',   this._pdfSwipeEnd);
    this._pdfSwipeStart = null;
    this._pdfSwipeEnd   = null;
    // Убираем отслеживание выделения
    if (this._selectionChangeHandler) {
      document.removeEventListener('selectionchange', this._selectionChangeHandler);
      this._selectionChangeHandler = null;
    }
    body.innerHTML = `<div class="loading" id="reader-loading"><div class="spinner"></div><span>Загрузка…</span></div>`;
  }

  // Универсальная конвертация в ArrayBuffer (Safari IndexedDB может вернуть другой тип)
  async _toArrayBuffer(buf) {
    if (buf instanceof ArrayBuffer) return buf;
    if (ArrayBuffer.isView(buf)) return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    if (buf instanceof Blob) {
      if (typeof buf.arrayBuffer === 'function') return buf.arrayBuffer();
      return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload  = () => res(fr.result);
        fr.onerror = () => rej(fr.error);
        fr.readAsArrayBuffer(buf);
      });
    }
    return buf;
  }

  // ── EPUB RENDERER ─────────────────────────────────────────
  // EPUB теперь парсится через JSZip и рендерится как текст
  async renderEPUB(book) {
    return this.renderText(book);
  }

  // ── PDF RENDERER ──────────────────────────────────────────
  async renderPDF(book) {
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js не загружен');

    const blob = new Blob([book.content], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    this.pdfDoc = await pdfjsLib.getDocument(url).promise;
    this.pdfTotalPages = this.pdfDoc.numPages;
    this.pdfCurrentPage = Math.max(1,
      Math.round((book.progress || 0) * this.pdfTotalPages) || 1
    );
    this.pdfZoom = 1.0;

    const body = document.getElementById('reader-body');
    body.innerHTML = '';

    const container = document.createElement('div');
    container.id = 'pdf-container';
    body.appendChild(container);

    const nav = document.createElement('div');
    nav.className = 'pdf-nav';
    nav.innerHTML = `
      <button id="pdf-prev" title="Предыдущая">‹</button>
      <span id="pdf-page-info">${this.pdfCurrentPage} / ${this.pdfTotalPages}</span>
      <button id="pdf-next" title="Следующая">›</button>
      <div class="pdf-nav-sep"></div>
      <button id="pdf-zoom-out" title="Уменьшить">−</button>
      <span id="pdf-zoom-label">100%</span>
      <button id="pdf-zoom-in" title="Увеличить">+</button>
      <button id="pdf-zoom-fit" title="По странице">⊡</button>
    `;
    body.appendChild(nav);

    // Ждём layout перед первым рендером, чтобы clientWidth был правильным
    await new Promise(r => requestAnimationFrame(r));
    await this.renderPDFPage(container, this.pdfCurrentPage);

    document.getElementById('pdf-prev').addEventListener('click', () => this.changePDFPage(-1));
    document.getElementById('pdf-next').addEventListener('click', () => this.changePDFPage(1));

    document.getElementById('pdf-zoom-in').addEventListener('click', () => {
      this.pdfZoom = Math.min(4.0, Math.round((this.pdfZoom + 0.25) * 100) / 100);
      this._updatePDFZoomLabel();
      this.renderPDFPage(container, this.pdfCurrentPage);
    });
    document.getElementById('pdf-zoom-out').addEventListener('click', () => {
      this.pdfZoom = Math.max(0.25, Math.round((this.pdfZoom - 0.25) * 100) / 100);
      this._updatePDFZoomLabel();
      this.renderPDFPage(container, this.pdfCurrentPage);
    });
    document.getElementById('pdf-zoom-fit').addEventListener('click', () => {
      this.pdfZoom = 1.0;
      this._updatePDFZoomLabel();
      this.renderPDFPage(container, this.pdfCurrentPage);
    });

    document.addEventListener('keyup', this._pdfKeyHandler = (e) => {
      if (this.currentBook?.format !== 'pdf') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') this.changePDFPage(1);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') this.changePDFPage(-1);
      if (e.key === '+' || e.key === '=') document.getElementById('pdf-zoom-in')?.click();
      if (e.key === '-') document.getElementById('pdf-zoom-out')?.click();
    });

    // Свайп пальцем (iPad) для перелистывания страниц PDF
    let _swipeX = 0;
    const readerBody = document.getElementById('reader-body');
    readerBody.addEventListener('touchstart', this._pdfSwipeStart = (e) => {
      _swipeX = e.touches[0].clientX;
    }, { passive: true });
    readerBody.addEventListener('touchend', this._pdfSwipeEnd = (e) => {
      const dx = e.changedTouches[0].clientX - _swipeX;
      if (Math.abs(dx) > 50) this.changePDFPage(dx < 0 ? 1 : -1);
    }, { passive: true });

    // Text selection
    container.addEventListener('mouseup', () => this._handleTextSelection(null));
    container.addEventListener('touchend', () => setTimeout(() => this._handleTextSelection(null), 300));

    document.getElementById('reader-footer').style.display = 'flex';
    const pct = (this.pdfCurrentPage - 1) / Math.max(1, this.pdfTotalPages - 1);
    this.updateProgress(pct);
  }

  _updatePDFZoomLabel() {
    const el = document.getElementById('pdf-zoom-label');
    if (el) el.textContent = Math.round(this.pdfZoom * 100) + '%';
  }

  async renderPDFPage(container, pageNum) {
    container.innerHTML = '';
    const page = await this.pdfDoc.getPage(pageNum);

    // Fit the whole page (width AND height) then apply zoom multiplier
    const page1 = page.getViewport({ scale: 1 });
    const padH = 48;  // top+bottom padding inside container
    const padX = 32;  // horizontal padding (16px each side)
    const navH = 56;  // nav bar height
    const containerW = container.clientWidth || (window.innerWidth - padX);
    const containerH = container.clientHeight || (window.innerHeight - 120 - navH);

    const scaleW = (containerW - padX) / page1.width;
    const scaleH = (containerH - padH) / page1.height;
    const fitScale = Math.min(scaleW, scaleH);
    const scale = Math.max(0.1, fitScale * this.pdfZoom);

    const viewport = page.getViewport({ scale });

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    wrapper.appendChild(canvas);

    // Text layer
    const textLayer = document.createElement('div');
    textLayer.className = 'pdf-text-layer';
    textLayer.style.width = viewport.width + 'px';
    textLayer.style.height = viewport.height + 'px';
    wrapper.appendChild(textLayer);

    container.appendChild(wrapper);

    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const textContent = await page.getTextContent();
    pdfjsLib.renderTextLayer({
      textContent,
      container: textLayer,
      viewport,
      textDivs: [],
    });
  }

  changePDFPage(delta) {
    const next = this.pdfCurrentPage + delta;
    if (next < 1 || next > this.pdfTotalPages) return;
    this.pdfCurrentPage = next;

    const container = document.getElementById('pdf-container');
    this.renderPDFPage(container, next);

    document.getElementById('pdf-page-info').textContent = `${next} / ${this.pdfTotalPages}`;
    document.getElementById('pdf-prev').disabled = next <= 1;
    document.getElementById('pdf-next').disabled = next >= this.pdfTotalPages;

    const pct = (next - 1) / Math.max(1, this.pdfTotalPages - 1);
    this.updateProgress(pct);
    this.db.updateBook(this.currentBook.id, { progress: pct });
    this.pushProgress(this.currentBook, pct);
  }

  // ── TEXT (TXT / FB2) RENDERER ─────────────────────────────
  async renderText(book) {
    let html = book.html;

    // If stored html is missing, re-parse
    if (!html && book.format === 'txt') {
      const parsed = parseTXT(book.content);
      html = parsed.html;
      await this.db.updateBook(book.id, { html, title: parsed.title });
    }
    if (!html && book.format === 'fb2') {
      const parsed = parseFB2(book.content);
      html = parsed.html;
      await this.db.updateBook(book.id, {
        html, title: parsed.title, author: parsed.author, coverUrl: parsed.coverUrl
      });
    }
    if (!html && book.format === 'epub') {
      const loadingEl = document.getElementById('reader-loading');
      if (loadingEl) loadingEl.querySelector('span').textContent = 'Разбираю EPUB…';
      // Конвертируем в ArrayBuffer — Safari/IndexedDB иногда возвращает другой тип
      const epubBuf = await this._toArrayBuffer(book.content);
      const parsed = await parseEPUBNative(epubBuf);
      html = parsed.html;
      await this.db.updateBook(book.id, {
        html, title: parsed.title, author: parsed.author, coverUrl: parsed.coverUrl
      });
      document.getElementById('reader-title').textContent = parsed.title;
      this.currentBook = { ...this.currentBook, ...parsed };
    }

    const body = document.getElementById('reader-body');
    body.innerHTML = '';

    const div = document.createElement('div');
    div.className = 'text-content';
    div.id = 'text-content';
    div.innerHTML = html || '<p>Нет текста</p>';
    body.appendChild(div);

    // Restore scroll position
    const savedPct = book.progress || 0;
    if (savedPct > 0) {
      requestAnimationFrame(() => {
        div.scrollTop = div.scrollHeight * savedPct;
      });
    }

    // Восстанавливаем визуальные выделения
    this.restoreTextHighlights(div);

    // Поповер при клике на выделенный текст
    this.setupAnnotationPopover(div);

    // Progress tracking on scroll
    div.addEventListener('scroll', () => {
      const pct = div.scrollTop / (div.scrollHeight - div.clientHeight) || 0;
      this.updateProgress(pct);
      this.db.updateBook(this.currentBook.id, { progress: pct });
      this.pushProgress(this.currentBook, pct);
    });

    // Выделение текста
    div.addEventListener('mouseup',  (e) => this._handleTextSelection(e));
    div.addEventListener('touchend', (e) => setTimeout(() => this._handleTextSelection(e), 100));
    div.addEventListener('contextmenu', (e) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) e.preventDefault();
    });

    document.getElementById('reader-footer').style.display = 'flex';
    this.updateProgress(savedPct);
  }

  restoreTextHighlights(container) {
    if (!this.currentAnnotations.length) return;

    // Сортируем по убыванию длины — длинные сначала, чтобы вложения не сломали поиск
    const sorted = [...this.currentAnnotations]
      .filter(a => a.quote && a.quote.length >= 2 && a.context?.type !== 'pdf')
      .sort((a, b) => b.quote.length - a.quote.length);

    for (const ann of sorted) {
      try {
        const range = findTextRange(container, ann.quote);
        if (range) applyHighlightRange(range, ann.id, ann.type);
      } catch {}
    }
  }

  // ── ANNOTATION POPOVER ────────────────────────────────────
  setupAnnotationPopover(container) {
    container.addEventListener('click', (e) => {
      const mark = e.target.closest('mark.reader-highlight');
      if (mark) {
        e.stopPropagation();
        const annId = parseInt(mark.dataset.annId);
        const ann = this.currentAnnotations.find(a => a.id === annId);
        if (ann) this.showAnnotationPopover(ann, mark);
      } else {
        this.hideAnnotationPopover();
      }
    });

    // Закрытие при клике вне
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#ann-popover') && !e.target.closest('mark.reader-highlight')) {
        this.hideAnnotationPopover();
      }
    });

    // Кнопка «Удалить» в поповере
    document.getElementById('ann-popover-del').addEventListener('click', async () => {
      const annId = parseInt(document.getElementById('ann-popover-del').dataset.annId);
      const ann = this.currentAnnotations.find(a => a.id === annId);
      await this.db.deleteAnnotation(annId);
      if (ann) this.pushDeleteAnnotation(this.currentBook, ann).catch(() => {});
      this.currentAnnotations = this.currentAnnotations.filter(a => a.id !== annId);
      removeHighlightMark(annId);
      this.updateAnnotationBadge();
      this.hideAnnotationPopover();
      if (this.obsidianDir) await this.syncCurrentBookToObsidian();
      this.showToast('Удалено');
    });
  }

  showAnnotationPopover(ann, markEl) {
    const popover = document.getElementById('ann-popover');
    document.getElementById('ann-popover-quote').textContent = ann.quote;

    const noteEl = document.getElementById('ann-popover-note');
    if (ann.note) {
      noteEl.textContent = ann.note;
      noteEl.style.display = 'block';
    } else {
      noteEl.style.display = 'none';
    }

    const typeEl = document.getElementById('ann-popover-type');
    typeEl.textContent = ann.type === 'highlight' ? '📌 Цитата' : '📝 Заметка';

    const delBtn = document.getElementById('ann-popover-del');
    delBtn.dataset.annId = ann.id;

    popover.style.display = 'block';

    // Позиция: над выделенным словом
    const rect = markEl.getBoundingClientRect();
    const pw = 300;
    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(10, Math.min(window.innerWidth - pw - 10, left));

    popover.style.left = left + 'px';
    popover.style.top = '-9999px'; // рендерим скрыто, чтобы получить высоту
    requestAnimationFrame(() => {
      const ph = popover.offsetHeight;
      let top = rect.top - ph - 10;
      if (top < 60) top = rect.bottom + 10;
      popover.style.top = top + 'px';
    });
  }

  hideAnnotationPopover() {
    document.getElementById('ann-popover').style.display = 'none';
  }

  _handleTextSelection(e) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (text.length < 2) return;

    let x = window.innerWidth / 2, y = 200;
    let savedRange = null;
    try {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top - 10;
      savedRange = range.cloneRange();
    } catch {}

    this.pendingSelection = {
      text,
      range: savedRange,
      context: { type: this.currentBook?.format || 'text' }
    };

    // Снимаем нативное выделение — убирает iOS-меню
    try { window.getSelection()?.removeAllRanges(); } catch {}

    this.showSelectionBar(x, y);
  }

  // ── CUSTOM iOS SELECTION ──────────────────────────────────
  // user-select:none запрещает нативное выделение → iOS не показывает меню.
  // Мы сами реализуем long-press + drag через caretRangeFromPoint.

  _setupCustomIOSSelection(container) {
    let longPressTimer  = null;
    let isDragging      = false;
    let startX = 0, startY = 0;
    let anchorRange     = null; // начало выделения при long-press
    let lastDragAt      = 0;   // throttle обновлений при drag

    // Находим позицию каретки по координатам экрана
    const caretAt = (x, y) => {
      if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (!pos) return null;
        const r = document.createRange();
        r.setStart(pos.offsetNode, pos.offset);
        r.collapse(true);
        return r;
      }
      return null;
    };

    // Расширяем range до границ слова
    const expandWord = (range) => {
      if (typeof range.expand === 'function') { range.expand('word'); return; }
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return;
      const t = node.textContent;
      let s = range.startOffset, e = range.startOffset;
      while (s > 0 && /\S/.test(t[s - 1])) s--;
      while (e < t.length && /\S/.test(t[e])) e++;
      range.setStart(node, s);
      range.setEnd(node, e);
    };

    // Показываем временную подсветку + нашу панель
    const showSelection = (range) => {
      const text = range.toString().trim();
      if (text.length < 2) return;
      this._applyPendingSelectionMark(range.cloneRange());
      const rect = range.getBoundingClientRect();
      this.pendingSelection = {
        text,
        range: null, // при сохранении найдём через findTextRange
        context: { type: this.currentBook?.format || 'text' }
      };
      this.showSelectionBar(rect.left + rect.width / 2, rect.top - 10);
    };

    container.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      isDragging = false;
      anchorRange = null;

      longPressTimer = setTimeout(() => {
        const cr = caretAt(startX, startY);
        if (!cr || !container.contains(cr.startContainer)) return;
        expandWord(cr);
        anchorRange = cr.cloneRange();
        isDragging  = true;
        showSelection(cr);
      }, 480);
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (!isDragging) {
        if (Math.hypot(dx, dy) > 8) clearTimeout(longPressTimer);
        return;
      }
      // Throttle: не чаще раза в 80мс
      const now = Date.now();
      if (now - lastDragAt < 80) return;
      lastDragAt = now;

      const x = e.touches[0].clientX, y = e.touches[0].clientY;
      const endCr = caretAt(x, y);
      if (!endCr || !container.contains(endCr.startContainer)) return;
      try {
        const combined = document.createRange();
        // Определяем направление drag
        if (anchorRange.compareBoundaryPoints(Range.START_TO_START, endCr) <= 0) {
          combined.setStart(anchorRange.startContainer, anchorRange.startOffset);
          combined.setEnd(endCr.startContainer, endCr.startOffset);
        } else {
          combined.setStart(endCr.startContainer, endCr.startOffset);
          combined.setEnd(anchorRange.endContainer, anchorRange.endOffset);
        }
        if (combined.toString().trim().length >= 2) showSelection(combined);
      } catch {}
    }, { passive: true });

    container.addEventListener('touchend', () => {
      clearTimeout(longPressTimer);
      isDragging  = false;
      anchorRange = null;
    }, { passive: true });
  }

  // Оборачиваем текст во временный <mark class="pending-selection">
  _applyPendingSelectionMark(range) {
    this._removePendingSelectionMark();
    const mark = document.createElement('mark');
    mark.className = 'pending-selection';
    try {
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
    } catch {
      try { range.surroundContents(mark); } catch {}
    }
  }

  // Убираем временную метку (восстанавливаем DOM)
  _removePendingSelectionMark() {
    const mark = document.querySelector('mark.pending-selection');
    if (!mark) return;
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    try { parent.normalize(); } catch {}
  }

  // Запускаем таймер: через 1.2с снимаем нативное выделение.
  // Если пользователь двигает ручки — selectionchange сбрасывает таймер заново.
  // Наш бар и pendingSelection.range при этом сохраняются — кнопки работают.
  _scheduleIOSSelectionClear() {
    clearTimeout(this._iosSelectionClearTimer);
    this._iosSelectionClearTimer = setTimeout(() => {
      if (!this.pendingSelection) return; // бар уже скрыт
      try { window.getSelection()?.removeAllRanges(); } catch {}
    }, 1200);
  }

  // ── SELECTION BAR ─────────────────────────────────────────
  showSelectionBar(x, y) {
    const bar = document.getElementById('selection-bar');
    bar.style.display = 'flex';

    const barW = 200;
    const clampedX = Math.max(barW / 2 + 10, Math.min(window.innerWidth - barW / 2 - 10, x));
    const clampedY = Math.max(60, y - 60);

    bar.style.left = clampedX + 'px';
    bar.style.top = clampedY + 'px';

    // Защищаем панель от немедленного скрытия (следующий touchstart/mousedown закроет её)
    this._barProtectedUntil = Date.now() + 500;
  }

  hideSelectionBar() {
    document.getElementById('selection-bar').style.display = 'none';
    clearTimeout(this._iosSelectionClearTimer);
  }

  // ── ANNOTATIONS ───────────────────────────────────────────
  async saveAnnotation(type, note = '') {
    if (!this.pendingSelection || !this.currentBook) return;
    const { text, context } = this.pendingSelection;

    const ann = {
      bookId: this.currentBook.id,
      type,           // 'highlight' | 'note'
      quote: text,
      note,
      context,
      createdAt: Date.now(),
    };

    const id = await this.db.addAnnotation(ann);
    ann.id = id;
    this.currentAnnotations.push(ann);

    // Push to remote sync
    this.pushAnnotation(this.currentBook, ann).catch(() => {});

    const savedRange = this.pendingSelection?.range; // есть только на десктопе
    this.pendingSelection = null;

    // Убираем временную метку выделения (iOS custom selection)
    this._removePendingSelectionMark();
    this.hideSelectionBar();
    try { window.getSelection()?.removeAllRanges(); } catch {}

    if (this.currentBook?.format !== 'pdf') {
      try {
        const tc = document.getElementById('text-content');
        if (tc) {
          // Десктоп: используем сохранённый range; iOS: ищем текст в DOM
          const range = savedRange || findTextRange(tc, ann.quote);
          if (range) applyHighlightRange(range, id, type);
        }
      } catch {}
    }

    this.updateAnnotationBadge();

    // Auto-sync to Obsidian on Mac (если есть доступ или pending handle)
    if (this.obsidianDir || this._pendingObsidianHandle) {
      const ok = await this._ensureObsidianPermission();
      if (ok) await this.syncCurrentBookToObsidian();
    }

    this.showToast(type === 'highlight' ? '📌 Цитата сохранена' : '📝 Заметка сохранена');
  }

  updateAnnotationBadge() {
    const badge = document.getElementById('ann-count');
    const n = this.currentAnnotations.length;
    badge.textContent = n;
    badge.style.display = n > 0 ? 'inline-flex' : 'none';
  }

  async renderAnnotationsPanel() {
    if (!this.currentBook) return;
    this.currentAnnotations = await this.db.getAnnotations(this.currentBook.id);
    const list = document.getElementById('ann-list');

    if (this.currentAnnotations.length === 0) {
      list.innerHTML = `<div class="ann-empty">Нет заметок.<br>Выдели текст в читалке, чтобы сохранить цитату или написать заметку.</div>`;
      return;
    }

    const sorted = [...this.currentAnnotations].sort((a, b) => b.createdAt - a.createdAt);

    list.innerHTML = sorted.map(ann => {
      const icon = ann.type === 'highlight' ? '📌' : '📝';
      const typeLabel = ann.type === 'highlight' ? 'Цитата' : 'Заметка';
      const date = new Date(ann.createdAt).toLocaleDateString('ru-RU', {
        day: 'numeric', month: 'short', year: 'numeric'
      });
      return `<div class="ann-item" data-id="${ann.id}">
        <div class="ann-item-type">${icon} ${typeLabel}</div>
        <div class="ann-quote">${escHtml(ann.quote)}</div>
        ${ann.note ? `<div class="ann-note">${escHtml(ann.note)}</div>` : ''}
        <div class="ann-date">${date}</div>
        <button class="ann-del-btn" title="Удалить">✕</button>
      </div>`;
    }).join('');

    list.querySelectorAll('.ann-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.ann-item');
        const id = parseInt(item.dataset.id);
        const ann = this.currentAnnotations.find(a => a.id === id);
        await this.db.deleteAnnotation(id);
        if (ann) this.pushDeleteAnnotation(this.currentBook, ann).catch(() => {});
        this.currentAnnotations = this.currentAnnotations.filter(a => a.id !== id);
        removeHighlightMark(id);
        this.updateAnnotationBadge();
        await this.renderAnnotationsPanel();
        if (this.obsidianDir) await this.syncCurrentBookToObsidian();
      });
    });
  }

  openAnnotationsPanel() {
    this.renderAnnotationsPanel();
    document.getElementById('annotations-panel').classList.add('open');
    document.getElementById('overlay').classList.add('show');
  }

  closeAnnotationsPanel() {
    document.getElementById('annotations-panel').classList.remove('open');
    document.getElementById('overlay').classList.remove('show');
  }

  // ── OBSIDIAN SYNC ─────────────────────────────────────────
  get _isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  async setupObsidian() {
    if (this._isIOS || !window.showDirectoryPicker) {
      await this._showIOSObsidianMenu();
      return;
    }
    // Если уже есть сохранённый handle — просто запрашиваем разрешение
    if (this._pendingObsidianHandle) {
      const ok = await this._ensureObsidianPermission();
      if (ok) this.showToast('Доступ к Obsidian vault разрешён ✓');
      else this.showToast('Разрешение не предоставлено');
      return;
    }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      this.obsidianDir = dir;
      this.obsidianDirName = dir.name;
      // Сохраняем handle в IndexedDB — при следующем запуске не нужно выбирать снова
      await this.db.setSetting('obsidianDirHandle', dir);
      this.updateObsidianUI();
      this.showToast('Папка Obsidian настроена ✓');
    } catch (e) {
      if (e.name !== 'AbortError') this.showToast('Ошибка: ' + e.message);
    }
  }

  async _showIOSObsidianMenu() {
    if (!this.currentBook) {
      this.showToast('Открой книгу, чтобы экспортировать заметки');
      return;
    }

    const safeTitle = (this.currentBook.title || 'книга')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
    const filename = safeTitle + '.md';

    // ── Пробуем Advanced URI (append / new) если vault настроен ──────────
    const vaultName   = await this.db.getSetting('obsidianVaultName', null);
    const timestamps  = await this.db.getSetting('obsidianExportTimestamps', {});
    const lastExport  = timestamps[this.currentBook.id] || 0;

    if (vaultName) {
      const vEnc = encodeURIComponent(vaultName);
      const fEnc = encodeURIComponent(filename);

      if (lastExport === 0) {
        // Первый экспорт — создаём файл целиком
        const fullMd  = this.generateObsidianMD(this.currentBook, this.currentAnnotations);
        const dataEnc = encodeURIComponent(fullMd);
        const uri = `obsidian://advanced-uri?vault=${vEnc}&filepath=${fEnc}&data=${dataEnc}&mode=new`;
        if (uri.length < 8000) {
          window.location.href = uri;
          timestamps[this.currentBook.id] = Date.now();
          await this.db.setSetting('obsidianExportTimestamps', timestamps);
          return;
        }
        // URI слишком длинный — упадём в fallback ниже
      } else {
        // Последующий экспорт — только новые аннотации
        const newAnns = this.currentAnnotations.filter(a => a.createdAt > lastExport);
        if (newAnns.length === 0) {
          this.showToast('Нет новых заметок с последнего экспорта');
          return;
        }
        const deltaMd = this._generateAnnotationsOnlyMD(newAnns);
        const dataEnc = encodeURIComponent(deltaMd);
        const uri = `obsidian://advanced-uri?vault=${vEnc}&filepath=${fEnc}&data=${dataEnc}&mode=append`;
        if (uri.length < 8000) {
          window.location.href = uri;
          timestamps[this.currentBook.id] = Date.now();
          await this.db.setSetting('obsidianExportTimestamps', timestamps);
          return;
        }
        // Слишком длинный — упадём в fallback
      }
    }

    // ── Fallback 1: Web Share API с .md файлом (iOS 15+) ─────────────────
    const md   = this.generateObsidianMD(this.currentBook, this.currentAnnotations);
    const file = new File([md], filename, { type: 'text/markdown' });
    try {
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: this.currentBook.title, files: [file] });
        timestamps[this.currentBook.id] = Date.now();
        await this.db.setSetting('obsidianExportTimestamps', timestamps);
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return; // пользователь отменил
    }

    // ── Fallback 2: Копировать в буфер ─────────────────────────────────
    try {
      await navigator.clipboard.writeText(md);
      this.showToast('📋 Markdown скопирован — вставь в Obsidian');
      return;
    } catch {}

    // ── Fallback 3: obsidian://new URI ────────────────────────────────
    const encoded = encodeURIComponent(md);
    if (encoded.length < 10000) {
      window.location.href = `obsidian://new?name=${encodeURIComponent(safeTitle)}&content=${encoded}`;
    } else {
      this.showToast('Заметки слишком длинные для URI. Введи имя vault для автоматической синхронизации.');
    }
  }

  updateObsidianUI() {
    const path      = document.getElementById('obsidian-path');
    const setup     = document.getElementById('obsidian-setup-btn');
    const vaultRow  = document.getElementById('obsidian-vault-row');
    const vaultHint = document.getElementById('obsidian-vault-hint');
    const vaultInput= document.getElementById('obsidian-vault-input');

    if (this._isIOS || !window.showDirectoryPicker) {
      // ── iPad ──────────────────────────────────────────────────────────
      if (path) path.style.display = 'none';
      if (setup) setup.textContent = '📤 Экспорт в Obsidian';
      // Показываем поле vault name + подсказку про плагин
      if (vaultRow)  vaultRow.style.display  = 'flex';
      if (vaultHint) vaultHint.style.display = 'block';
      // Подставляем сохранённое имя vault
      if (vaultInput) {
        this.db.getSetting('obsidianVaultName', '').then(name => {
          if (name && vaultInput) vaultInput.value = name;
        });
      }
      return;
    }

    // ── Mac / Chrome ───────────────────────────────────────────────────
    if (vaultRow)  vaultRow.style.display  = 'none';
    if (vaultHint) vaultHint.style.display = 'none';

    if (this.obsidianDir) {
      if (path) { path.textContent = '📂 ' + this.obsidianDirName + ' · авто-сохранение ✓'; path.style.display = 'block'; }
      if (setup) setup.textContent = '🔮 Сменить папку vault';
    } else if (this._pendingObsidianHandle) {
      if (path) { path.textContent = '📂 ' + this.obsidianDirName + ' · нужно разрешение'; path.style.display = 'block'; }
      if (setup) setup.textContent = '🔑 Разрешить доступ к vault';
    } else {
      if (path) path.style.display = 'none';
      if (setup) setup.textContent = '🔮 Указать папку Obsidian vault';
    }
  }

  async syncCurrentBookToObsidian() {
    if (!this.currentBook || !this.obsidianDir) return;
    try {
      await this.syncBookToObsidian(this.currentBook, this.currentAnnotations);
    } catch (e) {
      this.showToast('Ошибка синхронизации: ' + e.message);
    }
  }

  async syncBookToObsidian(book, annotations) {
    const md = this.generateObsidianMD(book, annotations);
    const filename = (book.title || 'Книга')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .slice(0, 100)
      + '.md';

    let dir = this.obsidianDir;
    // Try to write to a "Читалка" subfolder
    try {
      dir = await this.obsidianDir.getDirectoryHandle('Читалка', { create: true });
    } catch {}

    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(md);
    await writable.close();

    // Сохраняем время последнего экспорта для этой книги
    const timestamps = await this.db.getSetting('obsidianExportTimestamps', {});
    timestamps[book.id] = Date.now();
    await this.db.setSetting('obsidianExportTimestamps', timestamps);

    return filename;
  }

  generateObsidianMD(book, annotations) {
    const today = new Date().toISOString().split('T')[0];
    const added = book.addedAt ? new Date(book.addedAt).toISOString().split('T')[0] : today;

    let md = `---
title: "${(book.title || '').replace(/"/g, '\\"')}"
author: "${(book.author || '').replace(/"/g, '\\"')}"
format: ${book.format || 'unknown'}
added: ${added}
tags:
  - книги
  - читалка
---

# ${book.title || 'Книга'}
`;
    if (book.author) md += `\n**Автор:** ${book.author}\n`;
    md += `**Формат:** ${(book.format || '').toUpperCase()}\n`;
    md += `**Прогресс:** ${Math.round((book.progress || 0) * 100)}%\n`;

    if (annotations.length === 0) {
      md += '\n*Нет заметок.*\n';
      return md;
    }

    md += '\n---\n\n## Цитаты и заметки\n\n';

    const sorted = [...annotations].sort((a, b) => a.createdAt - b.createdAt);

    sorted.forEach(ann => {
      const date = new Date(ann.createdAt).toLocaleDateString('ru-RU', {
        day: 'numeric', month: 'long', year: 'numeric'
      });

      if (ann.type === 'highlight') {
        md += `### 📌 Цитата — ${date}\n\n`;
        md += `> ${ann.quote.replace(/\n/g, '\n> ')}\n\n`;
      } else {
        md += `### 📝 Заметка — ${date}\n\n`;
        md += `> ${ann.quote.replace(/\n/g, '\n> ')}\n\n`;
        if (ann.note) md += `${ann.note}\n\n`;
      }
      md += '---\n\n';
    });

    return md;
  }

  // Только блоки аннотаций без frontmatter — для append-режима на iPad
  _generateAnnotationsOnlyMD(annotations) {
    if (!annotations.length) return '';
    const sorted = [...annotations].sort((a, b) => a.createdAt - b.createdAt);
    let md = '';
    sorted.forEach(ann => {
      const date = new Date(ann.createdAt).toLocaleDateString('ru-RU', {
        day: 'numeric', month: 'long', year: 'numeric'
      });
      if (ann.type === 'highlight') {
        md += `\n### 📌 Цитата — ${date}\n\n> ${ann.quote.replace(/\n/g, '\n> ')}\n\n---\n`;
      } else {
        md += `\n### 📝 Заметка — ${date}\n\n> ${ann.quote.replace(/\n/g, '\n> ')}\n\n`;
        if (ann.note) md += `${ann.note}\n\n`;
        md += `---\n`;
      }
    });
    return md;
  }

  async manualSyncObsidian() {
    if (this._isIOS || !window.showDirectoryPicker) {
      await this._showIOSObsidianMenu();
      return;
    }

    // Восстанавливаем доступ к vault если нужно
    if (!this.obsidianDir) {
      if (this._pendingObsidianHandle) {
        const ok = await this._ensureObsidianPermission();
        if (!ok) { this.showToast('Нет доступа к папке Obsidian'); return; }
      } else {
        await this.setupObsidian();
        if (!this.obsidianDir) return;
      }
    }
    if (!this.currentBook) return;

    const btn = document.getElementById('sync-obsidian-btn');
    if (btn) btn.disabled = true;
    try {
      const filename = await this.syncBookToObsidian(this.currentBook, this.currentAnnotations);
      this.showToast(`✓ Синхронизировано: ${filename}`);
    } catch (e) {
      this.showToast('Ошибка: ' + e.message);
    }
    if (btn) btn.disabled = false;
  }

  // Export annotations as markdown (for iPhone — share / copy)
  exportAnnotationsMarkdown() {
    if (!this.currentBook) return;
    const md = this.generateObsidianMD(this.currentBook, this.currentAnnotations);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (this.currentBook.title || 'книга') + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    this.showToast('Markdown файл скачан');
  }

  // ── PROGRESS ──────────────────────────────────────────────
  updateProgress(pct) {
    const p = Math.max(0, Math.min(1, pct));
    const pctStr = Math.round(p * 100) + '%';
    document.getElementById('progress-fill').style.width = pctStr;
    document.getElementById('progress-pct').textContent = pctStr;
  }

  // ── SETTINGS ──────────────────────────────────────────────
  openSettings() { document.getElementById('settings-panel').classList.add('open'); }
  closeSettings() { document.getElementById('settings-panel').classList.remove('open'); }

  setTheme(theme) {
    this.settings.theme = theme;
    this.applyTheme();
    this.saveSettings();
  }

  changeFontSize(delta) {
    this.settings.fontSize = Math.max(13, Math.min(30, this.settings.fontSize + delta));
    this.applyReadingCSS();
    document.getElementById('font-size-label').textContent = this.settings.fontSize;
    this.saveSettings();
  }

  changeLineHeight(delta) {
    this.settings.lineHeight = Math.round((
      Math.max(1.2, Math.min(2.5, this.settings.lineHeight + delta))
    ) * 10) / 10;
    this.applyReadingCSS();
    document.getElementById('lh-label').textContent = this.settings.lineHeight.toFixed(1);
    this.saveSettings();
  }

  syncSettingsUI() {
    document.getElementById('font-size-label').textContent = this.settings.fontSize;
    document.getElementById('lh-label').textContent = this.settings.lineHeight.toFixed(1);
    document.querySelectorAll('.theme-btn').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.theme === this.settings.theme)
    );
  }

  // ── TOAST ─────────────────────────────────────────────────
  showToast(msg, duration = 2500) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), duration);
  }

  // ── SYNC ──────────────────────────────────────────────────
  async initSync() {
    const cfg = await this.db.getSetting('syncConfig', null);
    if (cfg?.token && cfg?.code) {
      this.sync = new SyncClient(cfg.token, cfg.code);
      this.syncReady = await this.sync.ping();
      this.updateSyncUI();
    }
  }

  // Восстанавливаем сохранённую папку Obsidian vault из IndexedDB (только Mac/Chrome)
  async _restoreObsidianDir() {
    if (this._isIOS || !window.showDirectoryPicker) return;
    try {
      const handle = await this.db.getSetting('obsidianDirHandle', null);
      if (!handle || typeof handle.queryPermission !== 'function') return;
      this.obsidianDirName = handle.name;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        // Разрешение уже есть — авто-синк работает сразу
        this.obsidianDir = handle;
      } else {
        // Разрешение нужно запросить (браузер требует жест пользователя)
        this._pendingObsidianHandle = handle;
      }
      this.updateObsidianUI();
    } catch {}
  }

  // Запрашиваем разрешение на доступ к vault (вызывать только из обработчика клика)
  async _ensureObsidianPermission() {
    if (this.obsidianDir) return true;
    if (!this._pendingObsidianHandle) return false;
    try {
      const perm = await this._pendingObsidianHandle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        this.obsidianDir = this._pendingObsidianHandle;
        this._pendingObsidianHandle = null;
        this.updateObsidianUI();
        return true;
      }
    } catch {}
    return false;
  }

  updateSyncUI() {
    const btn = document.getElementById('sync-open-btn');
    if (btn) btn.title = this.syncReady ? 'Синхронизация ✓' : 'Синхронизация';
  }

  openSyncModal() {
    const statusRow = document.getElementById('sync-status-row');
    const setupForm = document.getElementById('sync-setup-form');

    if (this.syncReady) {
      statusRow.style.display = 'flex';
      setupForm.style.display = 'none';
      document.getElementById('sync-status-dot').className = 'sync-status-dot';
      document.getElementById('sync-status-text').textContent = 'Синхронизация активна (GitHub Gist)';
    } else {
      statusRow.style.display = 'none';
      setupForm.style.display = 'block';
      // Подставляем сохранённый код (токен не показываем из соображений безопасности)
      this.db.getSetting('syncConfig', null).then(cfg => {
        if (cfg) document.getElementById('sync-code').value = cfg.code || '';
      });
    }
    document.getElementById('sync-modal').classList.add('open');
  }

  closeSyncModal() {
    document.getElementById('sync-modal').classList.remove('open');
  }

  async connectSync() {
    const token = document.getElementById('sync-token').value.trim();
    const code  = document.getElementById('sync-code').value.trim();

    if (!token || !code) {
      this.showToast('Введи токен и код синхронизации');
      return;
    }

    const btn = document.getElementById('sync-connect-btn');
    btn.textContent = 'Проверяем…';
    btn.disabled = true;

    this.sync = new SyncClient(token, code);
    const ok = await this.sync.ping();

    btn.textContent = 'Подключить';
    btn.disabled = false;

    if (ok) {
      await this.db.setSetting('syncConfig', { token, code });
      this.syncReady = true;
      this.updateSyncUI();
      this.closeSyncModal();
      this.showToast('☁️ Синхронизация через GitHub подключена!');
    } else {
      this.showToast('Не удалось подключиться. Проверь токен — нужен scope "gist".');
      this.sync = null;
    }
  }

  async disconnectSync() {
    this.sync = null;
    this.syncReady = false;
    await this.db.setSetting('syncConfig', null);
    this.updateSyncUI();
    this.closeSyncModal();
    this.showToast('Синхронизация отключена');
  }

  // Убеждаемся что у книги есть hash для синхронизации
  async ensureBookHash(book) {
    if (book.syncHash) return book.syncHash;
    const hash = await computeBookHash(book.content);
    if (hash) {
      await this.db.updateBook(book.id, { syncHash: hash });
      this.currentBook = { ...this.currentBook, syncHash: hash };
    }
    return hash;
  }

  // Вызывается при открытии книги — проверяем есть ли более свежая позиция на сервере
  async fetchRemoteProgress(book) {
    if (!this.sync || !this.syncReady) return null;
    try {
      const hash = await this.ensureBookHash(book);
      if (!hash) return null;
      return await this.sync.getProgress(hash);
    } catch { return null; }
  }

  // Получаем аннотации с сервера
  async fetchRemoteAnnotations(book) {
    if (!this.sync || !this.syncReady) return null;
    try {
      const hash = await this.ensureBookHash(book);
      if (!hash) return null;
      return await this.sync.getAnnotations(hash);
    } catch { return null; }
  }

  // Мёрджим удалённые аннотации с локальными (добавляем то чего нет)
  async _mergeRemoteAnnotations(book, remoteAnns) {
    if (!remoteAnns || !remoteAnns.length) return;

    // Сначала убедимся что все локальные аннотации запушены на сервер
    await this._pushUnsynced(book);

    // UUID локальных аннотаций
    const localUuids = new Set(
      this.currentAnnotations.map(a => a.uuid || a.ann_uuid).filter(Boolean)
    );

    // Только те что есть удалённо но нет локально
    const toAdd = remoteAnns.filter(ra => ra.ann_uuid && !localUuids.has(ra.ann_uuid));
    if (!toAdd.length) return;

    for (const ra of toAdd) {
      try {
        const ann = {
          bookId:    book.id,
          type:      ra.type      || 'highlight',
          quote:     ra.quote     || '',
          note:      ra.note      || '',
          context:   ra.context   || {},
          createdAt: ra.created_at || Date.now(),
          uuid:      ra.ann_uuid,
        };
        const id = await this.db.addAnnotation(ann);
        ann.id = id;
        this.currentAnnotations.push(ann);
      } catch {}
    }

    this.updateAnnotationBadge();

    // Перерисовываем подсветки в тексте
    const tc = document.getElementById('text-content');
    if (tc) {
      // Добавляем только новые хайлайты (не перерисовываем все)
      const newAnns = toAdd.map(ra => {
        return this.currentAnnotations.find(a => a.uuid === ra.ann_uuid);
      }).filter(Boolean);
      for (const ann of newAnns) {
        try {
          const range = findTextRange(tc, ann.quote);
          if (range) applyHighlightRange(range, ann.id, ann.type);
        } catch {}
      }
    }

    const n = toAdd.length;
    const word = n === 1 ? 'заметка' : n < 5 ? 'заметки' : 'заметок';
    this.showToast(`📝 Синхронизировано ${n} ${word} с другого устройства`);
  }

  // Пушим локальные аннотации без UUID (сохранённые до настройки синка)
  async _pushUnsynced(book) {
    if (!this.sync || !this.syncReady) return;
    const unsynced = this.currentAnnotations.filter(a => !a.uuid);
    for (const ann of unsynced) {
      await this.pushAnnotation(book, ann).catch(() => {});
    }
  }

  // Сохраняем позицию (дебаунс 4с)
  pushProgress(book, progress) {
    if (!this.sync || !this.syncReady) return;
    this.ensureBookHash(book).then(hash => {
      if (hash) this.sync.saveProgressDebounced(hash, progress, 4000);
    }).catch(() => {});
  }

  // Предлагаем перейти к удалённой позиции если она свежее локальной
  _offerRemotePosition(book, remote) {
    if (!remote || remote.progress == null) return;
    const local = book.progress || 0;
    const remotePct = remote.progress;

    // Предлагаем только если разница > 1% и удалённая позиция дальше
    if (Math.abs(remotePct - local) < 0.01) return;

    const remotePctStr = Math.round(remotePct * 100) + '%';
    const localPctStr  = Math.round(local * 100) + '%';

    // Показываем тост с кнопкой «Перейти»
    const t = document.getElementById('toast');
    t.innerHTML = `С другого устройства: ${remotePctStr} (здесь: ${localPctStr})&nbsp;<button id="toast-jump-btn" style="background:none;border:1px solid rgba(255,255,255,.5);color:inherit;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:13px">Перейти</button>`;
    t.classList.add('show');

    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      t.classList.remove('show');
      t.innerHTML = '';
    }, 6000);

    document.getElementById('toast-jump-btn')?.addEventListener('click', () => {
      t.classList.remove('show');
      t.innerHTML = '';

      const format = this.currentBook?.format;
      if (format === 'pdf') {
        // Прыгаем на нужную страницу
        const page = Math.max(1, Math.round(remotePct * this.pdfTotalPages));
        const delta = page - this.pdfCurrentPage;
        if (delta !== 0) this.changePDFPage(delta);
      } else {
        // Прокручиваем текстовый контент
        const div = document.getElementById('text-content');
        if (div) {
          div.scrollTop = div.scrollHeight * remotePct;
          this.updateProgress(remotePct);
          this.db.updateBook(this.currentBook.id, { progress: remotePct });
        }
      }
      this.showToast(`Перешли к позиции ${remotePctStr}`);
    });
  }

  // Синхронизируем аннотацию после сохранения
  async pushAnnotation(book, ann) {
    if (!this.sync || !this.syncReady) return;
    try {
      const hash = await this.ensureBookHash(book);
      if (!hash) return;
      // Генерируем UUID для аннотации если нет
      if (!ann.uuid) {
        ann.uuid = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
        await this.db._req(
          this.db._store('annotations','readwrite').put(ann)
        );
      }
      await this.sync.saveAnnotation(hash, ann);
    } catch (e) { console.warn('Sync annotation failed:', e); }
  }

  async pushDeleteAnnotation(book, ann) {
    if (!this.sync || !this.syncReady || !ann.uuid) return;
    try {
      const hash = await this.ensureBookHash(book);
      if (hash) await this.sync.deleteAnnotation(hash, ann.uuid);
    } catch {}
  }

  // ── DROPBOX ───────────────────────────────────────────────
  async initDropbox() {
    const cfg = await this.db.getSetting('dropboxConfig', null);
    if (cfg?.accessToken) {
      this.dropbox = new DropboxSync(cfg.accessToken, cfg.refreshToken || null, cfg.clientId || null);
      const ok = await this.dropbox.ping();
      if (!ok) {
        this.dropbox = null; // token expired and refresh failed — will need re-login
        return;
      }
      // Auto-sync new books from Dropbox on startup
      this._autoSyncDropbox();
    }

    // Re-check when the tab/app becomes visible again (e.g. after switching devices)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.dropbox) {
        this._autoSyncDropbox();
      }
    });
  }

  // Automatically download books from Dropbox that aren't in the local library yet
  async _autoSyncDropbox() {
    if (!this.dropbox || this._autoSyncing) return;
    this._autoSyncing = true;
    try {
      const [remoteFiles, localBooks] = await Promise.all([
        this.dropbox.listBooks(),
        this.db.getAllBooks(),
      ]);
      const localPaths = new Set(localBooks.map(b => b.dropboxPath).filter(Boolean));

      // Исключаем файлы которые уже скачиваются вручную через модал
      const newFiles = remoteFiles.filter(f =>
        !localPaths.has(f.path) && !this._downloadingPaths.has(f.path)
      );
      if (newFiles.length === 0) return;

      this.showToast(`📦 Скачиваем ${newFiles.length} ${this._pluralBooks(newFiles.length)} из Dropbox…`, 4000);

      let added = 0;
      for (const f of newFiles) {
        // Перепроверяем перед каждой загрузкой — вдруг уже добавили за это время
        if (this._downloadingPaths.has(f.path)) continue;
        const freshBooks = await this.db.getAllBooks();
        const freshPaths = new Set(freshBooks.map(b => b.dropboxPath).filter(Boolean));
        if (freshPaths.has(f.path)) continue;

        try {
          const buf = await this.dropbox.downloadFile(f.path);
          const ext = f.ext;
          let meta = { title: f.name.replace(/\.[^.]+$/, ''), author: '', coverUrl: null, html: null };
          if (ext === 'txt')  { const p = parseTXT(buf);              meta = { ...meta, ...p }; }
          if (ext === 'fb2')  { const p = parseFB2(buf);              meta = { ...meta, ...p }; }
          if (ext === 'epub') { const p = await parseEPUBNative(buf); meta = { ...meta, ...p }; }

          await this.db.addBook({
            title:       meta.title,
            author:      meta.author || '',
            format:      ext,
            content:     buf,
            coverUrl:    meta.coverUrl || null,
            html:        meta.html || null,
            progress:    0,
            addedAt:     Date.now(),
            lastRead:    null,
            dropboxPath: f.path,
          });
          added++;
        } catch { /* пропускаем отдельные ошибки */ }
      }

      if (added > 0) {
        await this.renderLibrary();
        this.showToast(`✓ Добавлено ${added} ${this._pluralBooks(added)} из Dropbox`);
      }
    } catch (e) {
      this.showToast('📦 Dropbox: ' + e.message.slice(0, 80), 5000);
    } finally {
      this._autoSyncing = false;
    }
  }

  _pluralBooks(n) {
    if (n % 10 === 1 && n % 100 !== 11) return 'книга';
    if ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) return 'книги';
    return 'книг';
  }

  openDropboxModal() {
    const setupForm  = document.getElementById('dbx-setup-form');
    const connected  = document.getElementById('dbx-connected');

    // Fill in redirect URI so user can copy it
    document.getElementById('dbx-redirect-uri').textContent = DropboxSync.getRedirectUri();

    if (this.dropbox) {
      setupForm.style.display = 'none';
      connected.style.display = 'block';
      document.getElementById('dbx-account-name').textContent = this.dropbox._accountName || '';
      this.loadDropboxBooks();
    } else {
      setupForm.style.display = 'block';
      connected.style.display = 'none';
      // Pre-fill app key if saved
      this.db.getSetting('dropboxConfig', null).then(cfg => {
        if (cfg?.clientId) document.getElementById('dbx-app-key').value = cfg.clientId;
      });
    }
    document.getElementById('dbx-modal').classList.add('open');
  }

  closeDropboxModal() {
    document.getElementById('dbx-modal').classList.remove('open');
  }

  async startDropboxLogin() {
    const appKey = document.getElementById('dbx-app-key').value.trim();
    if (!appKey) { this.showToast('Введи App Key'); return; }

    // Save app key so we can restore it after redirect
    await this.db.setSetting('dropboxConfig', { clientId: appKey });

    try {
      await DropboxSync.startOAuth(appKey);
      // Page will redirect — no code after this
    } catch (e) {
      this.showToast('Ошибка: ' + e.message);
    }
  }

  async _completeDropboxOAuth(code) {
    try {
      const { clientId, accessToken, refreshToken } = await DropboxSync.completeOAuth(code);
      await this.db.setSetting('dropboxConfig', { clientId, accessToken, refreshToken });
      this.dropbox = new DropboxSync(accessToken, refreshToken, clientId);
      await this.dropbox.ping(); // fetch account name
      this.showToast('📦 Dropbox подключён ✓');
    } catch (e) {
      this.showToast('Ошибка входа в Dropbox: ' + e.message);
    }
  }

  async disconnectDropbox() {
    this.dropbox = null;
    await this.db.setSetting('dropboxConfig', null);
    document.getElementById('dbx-setup-form').style.display = 'block';
    document.getElementById('dbx-connected').style.display  = 'none';
    this.showToast('Dropbox отключён');
  }

  async loadDropboxBooks() {
    const container = document.getElementById('dbx-books');
    container.innerHTML = '<div class="dbx-empty">Загружаем список книг…</div>';

    let files;
    try {
      files = await this.dropbox.listBooks();
    } catch (e) {
      // Показываем реальную ошибку + кнопку переподключения
      container.innerHTML = `
        <div class="dbx-empty">
          <strong>Ошибка доступа к Dropbox:</strong><br>
          <code style="font-size:12px;word-break:break-all">${escHtml(e.message)}</code>
          <br><br>
          Скорее всего нужно:<br>
          1. Добавить права в Dropbox App Console:<br>
          &nbsp;&nbsp;<strong>Permissions → files.metadata.read + files.content.read</strong><br>
          2. Переподключить Dropbox (токен обновится)
          <br><br>
          <button class="btn-primary" id="dbx-reconnect-btn" style="margin-top:4px">🔄 Переподключить</button>
        </div>`;
      document.getElementById('dbx-reconnect-btn')?.addEventListener('click', () => {
        this.disconnectDropbox();
      });
      return;
    }

    if (files.length === 0) {
      container.innerHTML = `<div class="dbx-empty">
        Папка /Читалка пуста или не существует.<br>
        Добавь книги в папку <strong>/chitalka</strong> в своём Dropbox.
      </div>`;
      return;
    }

    // Check which books are already in the library
    const existingBooks = await this.db.getAllBooks();
    const existingPaths = new Set(existingBooks.map(b => b.dropboxPath).filter(Boolean));

    const ICONS = { epub: '📗', pdf: '📕', txt: '📄', fb2: '📘' };

    container.innerHTML = files.map(f => {
      const already = existingPaths.has(f.path);
      const icon    = ICONS[f.ext] || '📄';
      const size    = DropboxSync.formatSize(f.size);

      return `<div class="dbx-book-item" data-path="${escHtml(f.path)}">
        <div class="dbx-book-icon">${icon}</div>
        <div class="dbx-book-info">
          <div class="dbx-book-name">${escHtml(f.name)}</div>
          <div class="dbx-book-meta">${f.ext.toUpperCase()}${size ? ' · ' + size : ''}</div>
        </div>
        <div class="dbx-book-action">
          ${already
            ? '<button class="dbx-dl-btn done" disabled>✓ Есть</button>'
            : `<button class="dbx-dl-btn" data-path="${escHtml(f.path)}" data-name="${escHtml(f.name)}">Скачать</button>`
          }
        </div>
      </div>`;
    }).join('');

    // Bind download buttons
    container.querySelectorAll('.dbx-dl-btn:not(.done)').forEach(btn => {
      btn.addEventListener('click', () => this.downloadDropboxBook(btn));
    });
  }

  async downloadDropboxBook(btn) {
    const path     = btn.dataset.path;
    const fileName = btn.dataset.name;

    // Отмечаем путь как «скачивается» — автосинк пропустит этот файл
    this._downloadingPaths.add(path);
    btn.textContent = '⏳'; btn.disabled = true;

    try {
      const buf = await this.dropbox.downloadFile(path);
      const ext = fileName.split('.').pop().toLowerCase();

      let meta = { title: fileName.replace(/\.[^.]+$/, ''), author: '', coverUrl: null, html: null };
      if (ext === 'txt')  { const p = parseTXT(buf);                meta = { ...meta, ...p }; }
      if (ext === 'fb2')  { const p = parseFB2(buf);                meta = { ...meta, ...p }; }
      if (ext === 'epub') { const p = await parseEPUBNative(buf);   meta = { ...meta, ...p }; }

      await this.db.addBook({
        title:       meta.title,
        author:      meta.author || '',
        format:      ext,
        content:     buf,
        coverUrl:    meta.coverUrl || null,
        html:        meta.html || null,
        progress:    0,
        addedAt:     Date.now(),
        lastRead:    null,
        dropboxPath: path,
      });

      btn.textContent = '✓ Есть';
      btn.classList.add('done');
      await this.renderLibrary();
      this.showToast('✓ ' + meta.title);
    } catch (e) {
      btn.textContent = 'Скачать';
      btn.disabled = false;
      this.showToast('Ошибка: ' + (e.message || String(e)), 5000);
    } finally {
      // Снимаем метку в любом случае
      this._downloadingPaths.delete(path);
    }
  }

  async saveVaultName() {
    const input = document.getElementById('obsidian-vault-input');
    const name  = input?.value.trim();
    if (!name) { this.showToast('Введи имя vault'); return; }
    await this.db.setSetting('obsidianVaultName', name);
    this.showToast('✓ Vault сохранён: ' + name);
  }

  // ── EVENT BINDINGS ────────────────────────────────────────
  bindEvents() {
    // Безопасный addEventListener — не крашит если элемент отсутствует
    const on = (id, event, handler, opts) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(event, handler, opts);
    };

    // Library: add book
    document.getElementById('add-book-btn').addEventListener('click', () => {
      document.getElementById('file-input').click();
    });
    document.getElementById('file-input').addEventListener('change', (e) => {
      if (e.target.files.length) {
        this.addBooks(Array.from(e.target.files));
        e.target.value = '';
      }
    });

    // Drag & drop
    const dragHint = document.getElementById('dragover-hint');
    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      dragHint.classList.add('show');
    });
    document.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) dragHint.classList.remove('show');
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragHint.classList.remove('show');
      const files = Array.from(e.dataTransfer.files);
      if (files.length) this.addBooks(files);
    });

    // Reader: back
    on('back-btn', 'click', () => {
      this.destroyReader();
      this.currentBook = null;
      this.showScreen('library');
      this.renderLibrary();
      if (this._pdfKeyHandler) {
        document.removeEventListener('keyup', this._pdfKeyHandler);
        this._pdfKeyHandler = null;
      }
    });

    // Reader: settings
    on('reader-settings-btn', 'click', () => this.openSettings());
    on('global-settings-btn', 'click',  () => this.openSettings());

    // Reader: annotations
    on('annotations-btn', 'click', () => this.openAnnotationsPanel());

    // Overlay closes panels
    on('overlay', 'click', () => {
      this.closeAnnotationsPanel();
      this.closeSettings();
    });

    // Settings panel close on backdrop
    on('settings-panel', 'click', (e) => {
      if (e.target === document.getElementById('settings-panel')) this.closeSettings();
    });

    // Theme buttons
    document.querySelectorAll('.theme-btn').forEach(btn =>
      btn.addEventListener('click', () => this.setTheme(btn.dataset.theme))
    );

    // Font size
    on('font-minus', 'click', () => this.changeFontSize(-1));
    on('font-plus',  'click', () => this.changeFontSize(1));
    on('lh-minus',   'click', () => this.changeLineHeight(-0.1));
    on('lh-plus',    'click', () => this.changeLineHeight(0.1));

    // Selection bar
    on('highlight-btn', 'click', () => this.saveAnnotation('highlight'));
    on('note-btn', 'click', () => {
      if (!this.pendingSelection) return;
      document.getElementById('note-quote-preview').textContent = this.pendingSelection.text;
      document.getElementById('note-textarea').value = '';
      document.getElementById('note-modal').classList.add('open');
      this.hideSelectionBar();
      setTimeout(() => document.getElementById('note-textarea').focus(), 300);
    });

    // Note modal
    const closeNoteModal = () => {
      document.getElementById('note-modal').classList.remove('open');
      this._removePendingSelectionMark();
      this.pendingSelection = null;
    };
    on('note-modal-close', 'click', closeNoteModal);
    on('note-cancel',      'click', closeNoteModal);
    on('note-modal',       'click', (e) => {
      if (e.target === document.getElementById('note-modal')) closeNoteModal();
    });
    on('note-save', 'click', async () => {
      const noteText = document.getElementById('note-textarea').value.trim();
      document.getElementById('note-modal').classList.remove('open');
      await this.saveAnnotation('note', noteText);
    });
    on('note-textarea', 'keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        document.getElementById('note-save').click();
      }
    });

    // Скрываем бар на десктопе при клике вне него
    document.addEventListener('mousedown', (e) => {
      if (e.target.closest('#selection-bar')) return;
      // Модалка заметки открыта — не трогаем pendingSelection (иначе заметка не сохранится)
      if (document.getElementById('note-modal')?.classList.contains('open')) return;
      this._removePendingSelectionMark();
      this.hideSelectionBar();
      this.pendingSelection = null;
    });
    // На тачскрине: скрываем бар при тапе вне его — НО только если модалка заметки закрыта.
    // Иначе тап по textarea обнуляет pendingSelection и заметка не сохраняется.
    document.addEventListener('touchend', (e) => {
      // Тап по нашей панели — ничего не делаем
      if (e.target.closest('#selection-bar')) return;
      // Модалка заметки открыта — не трогаем pendingSelection (иначе заметка не сохранится)
      if (document.getElementById('note-modal')?.classList.contains('open')) return;
      // Скрываем панель и очищаем выделение только если в документе нет активного выделения
      setTimeout(() => {
        // Бар только что показали (touchend выделения) — не трогаем
        if (Date.now() < (this._barProtectedUntil || 0)) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
          this._removePendingSelectionMark();
          this.hideSelectionBar();
          this.pendingSelection = null;
        }
      }, 150);
    }, { passive: true });

    // Dropbox modal (📦)
    on('dbx-open-btn',      'click', () => this.openDropboxModal());
    on('dbx-modal-close',   'click', () => this.closeDropboxModal());
    on('dbx-login-btn',     'click', () => this.startDropboxLogin());
    on('dbx-disconnect-btn','click', () => this.disconnectDropbox());
    on('dbx-refresh-btn',   'click', () => this.loadDropboxBooks());
    on('dbx-copy-uri-btn',  'click', () => {
      const uri = document.getElementById('dbx-redirect-uri')?.textContent || '';
      navigator.clipboard?.writeText(uri).then(() => this.showToast('URI скопирован ✓'))
        .catch(() => this.showToast('Скопируй вручную: ' + uri));
    });
    on('dbx-modal', 'click', (e) => {
      if (e.target === document.getElementById('dbx-modal')) this.closeDropboxModal();
    });

    // Sync modal (☁️)
    on('sync-open-btn',       'click', () => this.openSyncModal());
    on('sync-modal-close',    'click', () => this.closeSyncModal());
    on('sync-connect-btn',    'click', () => this.connectSync());
    on('sync-disconnect-btn', 'click', () => this.disconnectSync());
    on('sync-modal',          'click', (e) => {
      if (e.target === document.getElementById('sync-modal')) this.closeSyncModal();
    });

    // Annotations panel
    on('sync-obsidian-btn',   'click', () => this.manualSyncObsidian());
    on('obsidian-setup-btn',  'click', () => this.setupObsidian());
    on('obsidian-global-btn', 'click', () => this.setupObsidian());
    on('obsidian-vault-save', 'click', () => this.saveVaultName());
    // Сохранение по Enter в поле vault
    on('obsidian-vault-input', 'keydown', (e) => {
      if (e.key === 'Enter') this.saveVaultName();
    });

    // Sync settings UI on open
    on('reader-settings-btn', 'click', () => this.syncSettingsUI());
    on('global-settings-btn', 'click', () => this.syncSettingsUI());

    // Swipe / touch navigation
    let touchStartX = 0;
    on('reader-body', 'touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });
    on('reader-body', 'touchend', () => {}, { passive: true });
  }
}

// ─────────────────────────────────────────────────────────────
//  BOOTSTRAP
// ─────────────────────────────────────────────────────────────
const app = new App();
app.init().catch(err => {
  console.error('App init failed:', err);
  document.body.innerHTML = `<div style="padding:40px;font-family:system-ui;color:#c0392b">
    <h2>Ошибка запуска</h2>
    <p>${err.message}</p>
    <p>Убедись, что приложение открыто через HTTP-сервер, а не как файл.</p>
  </div>`;
});

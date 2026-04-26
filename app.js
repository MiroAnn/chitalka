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

    // Telegram
    this.telegram   = null;   // TelegramSync instance
    this.tgBotName  = '';
    this.tgProxyUrl = '';     // CORS proxy для iPhone/Safari
  }

  // ── INIT ──────────────────────────────────────────────────
  async init() {
    await this.db.init();
    await this.loadSettings();
    this.applyTheme();
    this.bindEvents();
    this.registerSW();
    await this.initSync();
    await this.initTelegram();
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
    for (const file of files) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!['epub','pdf','txt','fb2'].includes(ext)) {
        this.showToast(`${file.name}: формат не поддерживается`);
        continue;
      }
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
          title: meta.title,
          author: meta.author || '',
          format: ext,
          content: buf,
          coverUrl: meta.coverUrl || null,
          html: meta.html || null,
          progress: 0,
          addedAt: Date.now(),
          lastRead: null,
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
      // Получаем удалённую позицию до открытия (параллельно)
      const remoteProgressPromise = this.fetchRemoteProgress(book);

      if (book.format === 'epub') await this.renderEPUB(book);
      else if (book.format === 'pdf') await this.renderPDF(book);
      else await this.renderText(book);

      // Предлагаем перейти к удалённой позиции если она свежее
      this._offerRemotePosition(book, await remoteProgressPromise);
    } catch (err) {
      document.getElementById('reader-loading').innerHTML =
        `<p style="color:var(--accent-2);padding:20px;text-align:center">
          Ошибка загрузки: ${err.message}
        </p>`;
    }
  }

  destroyReader() {
    this.pdfDoc = null;
    const body = document.getElementById('reader-body');
    body.innerHTML = `<div class="loading" id="reader-loading"><div class="spinner"></div><span>Загрузка…</span></div>`;
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
      const parsed = await parseEPUBNative(book.content);
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

    // Selection
    div.addEventListener('mouseup', (e) => this._handleTextSelection(e));
    div.addEventListener('touchend', (e) => setTimeout(() => this._handleTextSelection(e), 200));

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
      savedRange = range.cloneRange(); // сохраняем до сброса выделения
    } catch {}

    this.pendingSelection = {
      text,
      range: savedRange,
      context: { type: this.currentBook?.format || 'text' }
    };
    this.showSelectionBar(x, y);
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
  }

  hideSelectionBar() {
    document.getElementById('selection-bar').style.display = 'none';
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

    // Применяем визуальное выделение сразу (для TXT/FB2/EPUB)
    const savedRange = this.pendingSelection?.range;
    this.pendingSelection = null;
    this.hideSelectionBar();

    // Clear browser selection
    try { window.getSelection()?.removeAllRanges(); } catch {}

    if (savedRange && this.currentBook?.format !== 'pdf') {
      try { applyHighlightRange(savedRange, id, type); } catch {}
    }

    this.updateAnnotationBadge();

    // Auto-sync to Obsidian on Mac
    if (this.obsidianDir) {
      await this.syncCurrentBookToObsidian();
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
  async setupObsidian() {
    if (!window.showDirectoryPicker) {
      this.showToast('File System API недоступен в этом браузере. Используй Chrome на Mac.');
      return;
    }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      this.obsidianDir = dir;
      this.obsidianDirName = dir.name;
      this.updateObsidianUI();
      this.showToast('Папка Obsidian настроена ✓');
    } catch (e) {
      if (e.name !== 'AbortError') this.showToast('Ошибка: ' + e.message);
    }
  }

  updateObsidianUI() {
    const path = document.getElementById('obsidian-path');
    const setup = document.getElementById('obsidian-setup-btn');
    if (this.obsidianDirName) {
      path.textContent = '📂 ' + this.obsidianDirName;
      path.style.display = 'block';
      setup.textContent = '🔮 Сменить папку vault';
    } else {
      path.style.display = 'none';
      setup.textContent = '🔮 Указать папку Obsidian vault';
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

  async manualSyncObsidian() {
    if (!this.obsidianDir) {
      await this.setupObsidian();
      if (!this.obsidianDir) return;
    }
    if (!this.currentBook) return;

    document.getElementById('sync-obsidian-btn').disabled = true;
    try {
      const filename = await this.syncBookToObsidian(this.currentBook, this.currentAnnotations);
      this.showToast(`✓ Синхронизировано: ${filename}`);
    } catch (e) {
      this.showToast('Ошибка: ' + e.message);
    }
    document.getElementById('sync-obsidian-btn').disabled = false;
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
      const remote = await this.sync.getProgress(hash);
      return remote;
    } catch { return null; }
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

  // ── TELEGRAM ──────────────────────────────────────────────
  async initTelegram() {
    const cfg = await this.db.getSetting('telegramConfig', null);
    if (cfg?.token) {
      this.telegram   = new TelegramSync(cfg.token);
      this.tgBotName  = cfg.botName  || '';
      this.tgProxyUrl = cfg.proxyUrl || '';
    }
  }

  openTelegramModal() {
    const setup = document.getElementById('tg-setup-form');
    const list  = document.getElementById('tg-book-list');

    if (this.telegram) {
      setup.style.display = 'none';
      list.style.display  = 'block';
      document.getElementById('tg-bot-name').textContent = '@' + (this.tgBotName || 'бот');
      document.getElementById('tg-proxy-connected').value = this.tgProxyUrl || '';
      this.loadTelegramBooks();
    } else {
      setup.style.display = 'block';
      list.style.display  = 'none';
      document.getElementById('tg-token').value = '';
      document.getElementById('tg-proxy').value = '';
    }
    document.getElementById('tg-modal').classList.add('open');
  }

  closeTelegramModal() {
    document.getElementById('tg-modal').classList.remove('open');
  }

  async connectTelegram() {
    const token = document.getElementById('tg-token').value.trim();
    if (!token) { this.showToast('Введи токен бота'); return; }

    const btn = document.getElementById('tg-connect-btn');
    btn.textContent = 'Проверяем…'; btn.disabled = true;

    let botName = '';
    try {
      const tg = new TelegramSync(token);
      const res = await tg._tgFetch(`https://api.telegram.org/bot${token}/getMe`);

      let data;
      try { data = await res.json(); } catch { throw new Error('Не удалось прочитать ответ'); }

      if (!res.ok || !data.ok) {
        throw new Error(data?.description || `Ошибка ${res.status} — проверь токен`);
      }

      botName = data.result?.username || data.result?.first_name || 'бот';
      const proxyUrl = document.getElementById('tg-proxy').value.trim();

      this.telegram   = tg;
      this.tgBotName  = botName;
      this.tgProxyUrl = proxyUrl;
      await this.db.setSetting('telegramConfig', { token, botName, proxyUrl });

      document.getElementById('tg-setup-form').style.display = 'none';
      document.getElementById('tg-book-list').style.display  = 'block';
      document.getElementById('tg-bot-name').textContent = '@' + botName;
      document.getElementById('tg-proxy-connected').value = proxyUrl;
      this.showToast('Telegram подключён ✓');
      this.loadTelegramBooks();

    } catch (e) {
      this.showToast('Ошибка: ' + e.message);
    } finally {
      btn.textContent = 'Подключить'; btn.disabled = false;
    }
  }

  async disconnectTelegram() {
    this.telegram  = null;
    this.tgBotName = '';
    await this.db.setSetting('telegramConfig', null);
    document.getElementById('tg-setup-form').style.display = 'block';
    document.getElementById('tg-book-list').style.display  = 'none';
    this.showToast('Telegram отключён');
  }

  async loadTelegramBooks() {
    const container = document.getElementById('tg-books');
    container.innerHTML = '<div class="tg-empty">Загружаем список книг…</div>';

    let files;
    try {
      files = await this.telegram.fetchFileCatalog();
    } catch (e) {
      container.innerHTML = `<div class="tg-empty">Ошибка: ${e.message}</div>`;
      return;
    }

    if (files.length === 0) {
      container.innerHTML = `<div class="tg-empty">
        Книг пока нет.<br>Открой своего бота в Telegram и отправь ему файлы книг.
      </div>`;
      return;
    }

    // Узнаём, какие книги уже есть в библиотеке
    const existingBooks = await this.db.getAllBooks();
    const existingIds   = new Set(existingBooks.map(b => b.telegramFileId).filter(Boolean));

    const ICONS = { epub: '📗', pdf: '📕', txt: '📄', fb2: '📘' };

    container.innerHTML = files.map(f => {
      const already = existingIds.has(f.file_id);
      const icon    = ICONS[f.ext] || '📄';
      const size    = TelegramSync.formatSize(f.file_size);
      const tooBig  = f.file_size > 20 * 1024 * 1024;

      return `<div class="tg-book-item" data-file-id="${f.file_id}">
        <div class="tg-book-icon">${icon}</div>
        <div class="tg-book-info">
          <div class="tg-book-name">${escHtml(f.file_name)}</div>
          <div class="tg-book-meta">${f.ext.toUpperCase()}${size ? ' · ' + size : ''}${tooBig ? ' · ⚠️ > 20 МБ' : ''}</div>
        </div>
        <div class="tg-book-action">
          ${already
            ? '<button class="tg-dl-btn done" disabled>✓ Есть</button>'
            : tooBig
              ? '<button class="tg-dl-btn" disabled title="Telegram Bot API не поддерживает файлы > 20 МБ">Слишком большой</button>'
              : `<button class="tg-dl-btn" data-file-id="${f.file_id}" data-file-name="${escHtml(f.file_name)}">Скачать</button>`
          }
        </div>
      </div>`;
    }).join('');

    // Bind download buttons
    container.querySelectorAll('.tg-dl-btn:not(.done):not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => this.downloadTelegramBook(btn));
    });
  }

  async downloadTelegramBook(btn) {
    const fileId   = btn.dataset.fileId;
    const fileName = btn.dataset.fileName;

    btn.textContent = '⏳'; btn.disabled = true;

    try {
      const buf = await this.telegram.downloadFile(fileId, this.tgProxyUrl || null);
      const ext = fileName.split('.').pop().toLowerCase();

      let meta = { title: fileName.replace(/\.[^.]+$/, ''), author: '', coverUrl: null, html: null };
      if (ext === 'txt')  { const p = parseTXT(buf);                meta = { ...meta, ...p }; }
      if (ext === 'fb2')  { const p = parseFB2(buf);                meta = { ...meta, ...p }; }
      if (ext === 'epub') { const p = await parseEPUBNative(buf);   meta = { ...meta, ...p }; }

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
        telegramFileId: fileId,
      });

      btn.textContent = '✓ Есть';
      btn.classList.add('done');
      await this.renderLibrary();
      this.showToast('✓ ' + meta.title);
    } catch (e) {
      btn.textContent = 'Скачать';
      btn.disabled = false;
      this.showToast('Ошибка: ' + e.message);
    }
  }

  // ── EVENT BINDINGS ────────────────────────────────────────
  bindEvents() {
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
    document.getElementById('back-btn').addEventListener('click', () => {
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
    document.getElementById('reader-settings-btn').addEventListener('click', () => this.openSettings());
    document.getElementById('global-settings-btn').addEventListener('click', () => this.openSettings());

    // Reader: annotations
    document.getElementById('annotations-btn').addEventListener('click', () => this.openAnnotationsPanel());

    // Overlay closes panels
    document.getElementById('overlay').addEventListener('click', () => {
      this.closeAnnotationsPanel();
      this.closeSettings();
    });

    // Settings panel close on backdrop
    document.getElementById('settings-panel').addEventListener('click', (e) => {
      if (e.target === document.getElementById('settings-panel')) this.closeSettings();
    });

    // Theme buttons
    document.querySelectorAll('.theme-btn').forEach(btn =>
      btn.addEventListener('click', () => this.setTheme(btn.dataset.theme))
    );

    // Font size
    document.getElementById('font-minus').addEventListener('click', () => this.changeFontSize(-1));
    document.getElementById('font-plus').addEventListener('click', () => this.changeFontSize(1));
    document.getElementById('lh-minus').addEventListener('click', () => this.changeLineHeight(-0.1));
    document.getElementById('lh-plus').addEventListener('click', () => this.changeLineHeight(0.1));

    // Selection bar: Highlight
    document.getElementById('highlight-btn').addEventListener('click', () => {
      this.saveAnnotation('highlight');
    });

    // Selection bar: Note
    document.getElementById('note-btn').addEventListener('click', () => {
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
      this.pendingSelection = null;
    };
    document.getElementById('note-modal-close').addEventListener('click', closeNoteModal);
    document.getElementById('note-cancel').addEventListener('click', closeNoteModal);
    document.getElementById('note-modal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('note-modal')) closeNoteModal();
    });

    document.getElementById('note-save').addEventListener('click', async () => {
      const noteText = document.getElementById('note-textarea').value.trim();
      document.getElementById('note-modal').classList.remove('open');
      await this.saveAnnotation('note', noteText);
    });

    // Ctrl+Enter in textarea saves note
    document.getElementById('note-textarea').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        document.getElementById('note-save').click();
      }
    });

    // Hide selection bar on click elsewhere
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#selection-bar')) {
        this.hideSelectionBar();
      }
    });
    document.addEventListener('touchstart', (e) => {
      if (!e.target.closest('#selection-bar')) {
        this.hideSelectionBar();
      }
    }, { passive: true });

    // Telegram modal (✈️)
    document.getElementById('tg-open-btn').addEventListener('click', () => this.openTelegramModal());
    document.getElementById('tg-modal-close').addEventListener('click', () => this.closeTelegramModal());
    document.getElementById('tg-connect-btn').addEventListener('click', () => this.connectTelegram());
    document.getElementById('tg-disconnect-btn').addEventListener('click', () => this.disconnectTelegram());
    document.getElementById('tg-refresh-btn').addEventListener('click', () => this.loadTelegramBooks());
    document.getElementById('tg-save-proxy-btn').addEventListener('click', async () => {
      const proxyUrl = document.getElementById('tg-proxy-connected').value.trim();
      this.tgProxyUrl = proxyUrl;
      const cfg = await this.db.getSetting('telegramConfig', {});
      await this.db.setSetting('telegramConfig', { ...cfg, proxyUrl });
      this.showToast(proxyUrl ? 'Proxy сохранён ✓' : 'Proxy удалён');
    });
    document.getElementById('tg-modal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('tg-modal')) this.closeTelegramModal();
    });

    // Sync modal (☁️ Supabase)
    document.getElementById('sync-open-btn').addEventListener('click', () => this.openSyncModal());
    document.getElementById('sync-modal-close').addEventListener('click', () => this.closeSyncModal());
    document.getElementById('sync-connect-btn').addEventListener('click', () => this.connectSync());
    document.getElementById('sync-disconnect-btn').addEventListener('click', () => this.disconnectSync());
    // Close sync modal on backdrop click
    document.getElementById('sync-modal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('sync-modal')) this.closeSyncModal();
    });

    // Annotations panel
    document.getElementById('sync-obsidian-btn').addEventListener('click', () => this.manualSyncObsidian());
    document.getElementById('obsidian-setup-btn').addEventListener('click', () => this.setupObsidian());
    document.getElementById('obsidian-global-btn').addEventListener('click', () => this.setupObsidian());

    // Sync settings UI on open
    document.getElementById('reader-settings-btn').addEventListener('click', () => this.syncSettingsUI());
    document.getElementById('global-settings-btn').addEventListener('click', () => this.syncSettingsUI());

    // Swipe navigation for EPUB (horizontal)
    let touchStartX = 0;
    document.getElementById('reader-body').addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });
    document.getElementById('reader-body').addEventListener('touchend', () => {}, { passive: true });
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

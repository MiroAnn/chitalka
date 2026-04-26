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
  }

  // ── INIT ──────────────────────────────────────────────────
  async init() {
    await this.db.init();
    await this.loadSettings();
    this.applyTheme();
    this.bindEvents();
    this.registerSW();
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
          meta.title = file.name.replace(/\.epub$/i, '');
          // Will extract cover/metadata lazily on open
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
      if (book.format === 'epub') await this.renderEPUB(book);
      else if (book.format === 'pdf') await this.renderPDF(book);
      else await this.renderText(book);
    } catch (err) {
      document.getElementById('reader-loading').innerHTML =
        `<p style="color:var(--accent-2);padding:20px;text-align:center">
          Ошибка загрузки: ${err.message}
        </p>`;
    }
  }

  destroyReader() {
    if (this.rendition) {
      try { this.rendition.destroy(); } catch {}
      this.rendition = null;
    }
    if (this.epubBook) {
      try { this.epubBook.destroy(); } catch {}
      this.epubBook = null;
    }
    this.pdfDoc = null;
    const body = document.getElementById('reader-body');
    body.innerHTML = `<div class="loading" id="reader-loading"><div class="spinner"></div><span>Загрузка…</span></div>`;
  }

  // ── EPUB RENDERER ─────────────────────────────────────────
  async renderEPUB(book) {
    if (typeof ePub === 'undefined') throw new Error('epub.js не загружен');

    const blob = new Blob([book.content], { type: 'application/epub+zip' });
    const url = URL.createObjectURL(blob);
    this.epubBook = ePub(url);

    // Try to extract metadata
    const meta = await this.epubBook.loaded.metadata.catch(() => ({}));
    if (meta.title && meta.title !== book.title) {
      await this.db.updateBook(book.id, { title: meta.title, author: meta.creator || '' });
      document.getElementById('reader-title').textContent = meta.title;
      this.currentBook.title = meta.title;
    }

    // Try to extract cover
    if (!book.coverUrl) {
      try {
        const coverUrl = await this.epubBook.coverUrl();
        if (coverUrl) await this.db.updateBook(book.id, { coverUrl });
      } catch {}
    }

    const container = document.createElement('div');
    container.id = 'epub-container';
    container.style.cssText = 'width:100%;height:100%;';

    const body = document.getElementById('reader-body');
    body.innerHTML = '';
    body.appendChild(container);

    this.rendition = this.epubBook.renderTo(container, {
      width: '100%',
      height: '100%',
      spread: 'none',
      flow: 'paginated',
    });

    // Restore position
    const savedCFI = await this.db.getSetting(`pos-${book.id}`, null);

    await this.rendition.display(savedCFI || undefined);

    // Theme / font for iframe content
    this.applyEpubTheme();

    // Selection events
    this.rendition.on('selected', (cfiRange, contents) => {
      const text = contents.window.getSelection().toString().trim();
      if (text.length > 1) {
        this.pendingSelection = { text, context: { type: 'epub', cfi: cfiRange } };
        const iframeRect = container.getBoundingClientRect();
        this.showSelectionBar(iframeRect.left + iframeRect.width / 2, iframeRect.top + 120);
      }
    });

    this.rendition.on('relocated', (loc) => {
      const pct = loc.start.percentage || 0;
      this.updateProgress(pct);
      this.db.updateBook(book.id, { progress: pct });
      this.db.setSetting(`pos-${book.id}`, loc.start.cfi);
    });

    // Keyboard navigation
    this.rendition.on('keyup', (e) => {
      if (e.key === 'ArrowRight') this.rendition.next();
      if (e.key === 'ArrowLeft') this.rendition.prev();
    });

    document.getElementById('reader-footer').style.display = 'flex';
  }

  applyEpubTheme() {
    if (!this.rendition) return;
    const isDark = this.settings.theme === 'dark';
    const isSepia = this.settings.theme === 'sepia';
    const bg = isDark ? '#18181b' : isSepia ? '#f8f3e8' : '#ffffff';
    const fg = isDark ? '#e4d5bb' : isSepia ? '#3d2b1f' : '#1a1a1a';

    this.rendition.themes.register('reader', {
      body: {
        background: bg + ' !important',
        color: fg + ' !important',
        'font-family': 'Georgia, serif !important',
        'font-size': this.settings.fontSize + 'px !important',
        'line-height': this.settings.lineHeight + ' !important',
        'max-width': '680px',
        margin: '0 auto',
        padding: '20px 24px !important',
      },
      p: { margin: '0 0 1em', 'text-align': 'justify', hyphens: 'auto' },
      'h1,h2,h3': { 'font-family': 'system-ui, sans-serif', color: isDark ? '#c9a96e' : isSepia ? '#5c3d1e' : '#2c6e49' },
    });
    this.rendition.themes.select('reader');
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
    const padH = 48; // top+bottom padding inside container
    const navH = 56; // nav bar height
    const containerW = container.clientWidth || (window.innerWidth - 32);
    const containerH = container.clientHeight || (window.innerHeight - 120 - navH);

    const scaleW = (containerW - 32) / page1.width;
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
  }

  // ── TEXT (TXT / FB2) RENDERER ─────────────────────────────
  async renderText(book) {
    let html = book.html;

    // If stored html is missing (e.g. old record), re-parse
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

    // Apply highlights from annotations
    this.restoreTextHighlights(div);

    // Progress tracking on scroll
    div.addEventListener('scroll', () => {
      const pct = div.scrollTop / (div.scrollHeight - div.clientHeight) || 0;
      this.updateProgress(pct);
      this.db.updateBook(this.currentBook.id, { progress: pct });
    });

    // Selection
    div.addEventListener('mouseup', (e) => this._handleTextSelection(e));
    div.addEventListener('touchend', (e) => setTimeout(() => this._handleTextSelection(e), 200));

    document.getElementById('reader-footer').style.display = 'flex';
    this.updateProgress(savedPct);
  }

  restoreTextHighlights(container) {
    // Simple text-based highlight restoration
    this.currentAnnotations.forEach(ann => {
      if (!ann.textOffset || ann.context?.type === 'epub' || ann.context?.type === 'pdf') return;
      // For v1: we don't visually restore highlights in text (complex range logic)
      // They are shown in the annotations panel instead
    });
  }

  _handleTextSelection(e) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (text.length < 2) return;

    let x = window.innerWidth / 2, y = 200;
    try {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top - 10;
    } catch {}

    this.pendingSelection = {
      text,
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
    this.pendingSelection = null;
    this.hideSelectionBar();

    // Clear browser selection
    try { window.getSelection()?.removeAllRanges(); } catch {}

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
        await this.db.deleteAnnotation(id);
        this.currentAnnotations = this.currentAnnotations.filter(a => a.id !== id);
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
    this.applyEpubTheme();
    this.saveSettings();
  }

  changeFontSize(delta) {
    this.settings.fontSize = Math.max(13, Math.min(30, this.settings.fontSize + delta));
    this.applyReadingCSS();
    this.applyEpubTheme();
    document.getElementById('font-size-label').textContent = this.settings.fontSize;
    this.saveSettings();
  }

  changeLineHeight(delta) {
    this.settings.lineHeight = Math.round((
      Math.max(1.2, Math.min(2.5, this.settings.lineHeight + delta))
    ) * 10) / 10;
    this.applyReadingCSS();
    this.applyEpubTheme();
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
    document.getElementById('reader-body').addEventListener('touchend', (e) => {
      if (!this.rendition) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 60) {
        if (dx < 0) this.rendition.next();
        else this.rendition.prev();
      }
    }, { passive: true });
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

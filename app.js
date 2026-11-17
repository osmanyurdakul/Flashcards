'use strict';
/* Flashcards — offline PWA with spaced repetition, photos, speech, voice recording and Claude feedback.
   All data stays on this device (IndexedDB). The API key is stored only on this device. */
(() => {
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DAY = 86400000;
const today = () => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = a => a[Math.floor(Math.random() * a.length)];
const LANGS = { nl: { name: 'Dutch', tts: 'nl-NL', level: 'Dutch, moving from A2 to B1' },
                en: { name: 'English', tts: 'en-GB', level: 'English, working on natural everyday fluency' } };
const MODELS = [['claude-haiku-5-5', 'Haiku — fastest, cheapest'], ['claude-sonnet-5-5', 'Sonnet — best feedback (recommended)']];

/* ================= IndexedDB ================= */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('flashcards', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('cards', { keyPath: 'id' }); d.createObjectStore('blobs'); d.createObjectStore('kv'); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); const s = t.objectStore(store); let out;
      const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = t.onabort = () => rej(t.error);
    });
  },
  all: (st) => DB.tx(st, 'readonly', s => s.getAll()),
  get: (st, k) => DB.tx(st, 'readonly', s => s.get(k)),
  put: (st, v, k) => DB.tx(st, 'readwrite', s => k === undefined ? s.put(v) : s.put(v, k)),
  del: (st, k) => DB.tx(st, 'readwrite', s => s.delete(k)),
};
async function putBlob(blob) { const id = 'b' + uid(); await DB.put('blobs', { buf: await blob.arrayBuffer(), type: blob.type || 'application/octet-stream' }, id); return id; }
const urlCache = {};
async function blobURL(id) {
  if (!id) return null; if (urlCache[id]) return urlCache[id];
  const r = await DB.get('blobs', id); if (!r) return null;
  return (urlCache[id] = URL.createObjectURL(new Blob([r.buf], { type: r.type })));
}
async function delBlob(id) { if (!id) return; await DB.del('blobs', id); if (urlCache[id]) { URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; } }

/* ================= state ================= */
let cards = [];
let settings = { apiKey: '', model: 'claude-sonnet-5-5', newPerDay: 10, rate: 0.9, voice: { nl: '', en: '' }, bannerClosed: false };
let newToday = { day: 0, n: 0 };
const ui = {
  tab: 'study', lang: 'all', queue: [], shown: false, search: '',
  draft: null, busy: false, err: '', msg: '', delArm: false,
  quiz: { mode: null, score: { ok: 0, n: 0 } },
  recording: null, // card id or 'draft'
};
const saveSettings = () => DB.put('kv', settings, 'settings');
const saveNewToday = () => DB.put('kv', newToday, 'newToday');
async function saveCard(c) { c.updated = Date.now(); await DB.put('cards', c); }
function newCard(lang) { return { id: uid(), lang, front: '', back: '', info: '', ex: '', exTr: '', photo: null, photoFront: false, audio: null, created: Date.now(), updated: Date.now(), seen: false, due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0 }; }

/* ================= spaced repetition ================= */
function calc(c, q) {
  const i = c.interval || 0, e = c.ease || 2.5;
  if (q === 0) return { i: 0, e: Math.max(1.3, e - 0.2) };
  if (q === 1) return { i: Math.max(1, Math.round((i || 1) * 1.2)), e: Math.max(1.3, e - 0.15) };
  if (q === 2) return { i: i < 1 ? 1 : (i < 2 ? 3 : Math.round(i * e)), e };
  return { i: i < 1 ? 4 : Math.round(i * e * 1.3), e: e + 0.1 };
}
const fmt = d => d < 1 ? '<10 min' : d === 1 ? '1 day' : d < 30 ? d + ' days' : d < 365 ? Math.round(d / 30) + ' mo' : (d / 365).toFixed(1) + ' yr';
function newLeft() { if (newToday.day !== today()) newToday = { day: today(), n: 0 }; return Math.max(0, (settings.newPerDay | 0) - newToday.n); }
const pool = () => cards.filter(c => ui.lang === 'all' || c.lang === ui.lang);
function buildQueue() {
  const t = today();
  const due = shuffle(pool().filter(c => c.seen && c.due <= t));
  const nw = pool().filter(c => !c.seen).sort((a, b) => a.created - b.created).slice(0, newLeft());
  ui.queue = [...due, ...nw]; ui.shown = false;
}
function updateBadge() {
  const t = today(); const n = cards.filter(c => c.seen && c.due <= t).length + Math.min(newLeft(), cards.filter(c => !c.seen).length);
  const b = $('#dueBadge'); b.hidden = !n; b.textContent = n;
}
async function rate(q) {
  const c = ui.queue.shift(); if (!c) return;
  if (!c.seen) { c.seen = true; newToday.n++; saveNewToday(); }
  const r = calc(c, q); c.ease = r.e; c.interval = r.i;
  if (q === 0) { c.lapses = (c.lapses || 0) + 1; c.due = today(); ui.queue.push(c); }
  else { c.due = today() + r.i * DAY; c.reps = (c.reps || 0) + 1; }
  ui.shown = false; stopAudio(); await saveCard(c); render();
}

/* ================= speech (text-to-speech) ================= */
let voices = [];
const hasTTS = 'speechSynthesis' in window;
function loadVoices() { voices = hasTTS ? speechSynthesis.getVoices() : []; }
if (hasTTS) { loadVoices(); speechSynthesis.onvoiceschanged = () => { loadVoices(); if (ui.tab === 'settings') render(); }; }
const vLang = v => v.lang.replace('_', '-').toLowerCase();
function voicesFor(lang) { const p = lang + '-'; return voices.filter(v => vLang(v).startsWith(p) || vLang(v) === lang); }
function pickVoice(lang) {
  const list = voicesFor(lang); const want = settings.voice[lang];
  return list.find(v => v.name === want) || list.find(v => vLang(v) === LANGS[lang].tts.toLowerCase()) || list[0] || null;
}
function speak(text, lang, rate) {
  if (!hasTTS || !text) return; stopAudio(); speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = LANGS[lang].tts;
  const v = pickVoice(lang); if (v) u.voice = v; u.rate = rate || settings.rate;
  speechSynthesis.speak(u);
}

/* ================= voice recording ================= */
let player = null;
function stopAudio() { if (player) { player.pause(); player = null; } }
async function playBlob(id) {
  const url = await blobURL(id); if (!url) return;
  stopAudio(); if (hasTTS) speechSynthesis.cancel();
  player = new Audio(url); player.play().catch(() => {});
}
async function playRaw(blob) { stopAudio(); player = new Audio(URL.createObjectURL(blob)); player.play().catch(() => {}); }
const Rec = {
  mr: null, chunks: [], stream: null, timer: null,
  supported: () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder),
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
    const t = types.find(x => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(x));
    this.mr = new MediaRecorder(this.stream, t ? { mimeType: t } : undefined);
    this.chunks = []; this.mr.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.start();
  },
  stop() {
    return new Promise(res => {
      if (!this.mr) return res(null);
      clearTimeout(this.timer);
      this.mr.onstop = () => {
        const b = new Blob(this.chunks, { type: (this.mr && this.mr.mimeType) || 'audio/mp4' });
        this.stream.getTracks().forEach(t => t.stop()); this.mr = null; this.stream = null; res(b.size ? b : null);
      };
      this.mr.stop();
    });
  },
};
async function toggleRecord(target) {
  if (ui.recording) { // stop
    const who = ui.recording; ui.recording = null; render();
    const blob = await Rec.stop(); if (!blob) return;
    if (who === 'draft') { ui.draft.audioBlob = blob; ui.draft.audioRemoved = false; render(); playRaw(blob); return; }
    const c = cards.find(x => x.id === who); if (!c) return;
    const old = c.audio; c.audio = await putBlob(blob); await saveCard(c); if (old) delBlob(old);
    render(); playBlob(c.audio); return;
  }
  if (!Rec.supported()) { flash('Recording is not supported in this browser.'); return; }
  try {
    stopAudio(); if (hasTTS) speechSynthesis.cancel();
    await Rec.start(); ui.recording = target; render();
    Rec.timer = setTimeout(() => { if (ui.recording) toggleRecord(); }, 20000);
  } catch (e) { flash('Microphone not available. Allow microphone access for this app.'); }
}

/* ================= photos ================= */
async function resizeImage(file, max = 1200) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.naturalWidth * s); cv.height = Math.round(img.naturalHeight * s);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.82));
  } finally { URL.revokeObjectURL(url); }
}
async function hydrate() {
  for (const el of document.querySelectorAll('img[data-blob]')) { const u = await blobURL(el.dataset.blob); if (u) el.src = u; }
}

/* ================= Claude API ================= */
function parseJ(t) { t = String(t || '').replace(/```json|```/g, ''); const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('Unexpected answer from Claude. Try again.'); return JSON.parse(t.slice(a, b + 1)); }
async function claude(prompt, maxTokens) {
  if (!settings.apiKey) throw new Error('Add your Claude API key in Settings (⚙️) first.');
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': settings.apiKey.trim(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: settings.model, max_tokens: maxTokens || 800, messages: [{ role: 'user', content: prompt }] }),
    });
  } catch (e) { throw new Error('No connection. Check your internet and try again.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = (j.error && j.error.message) || ('HTTP ' + r.status);
    if (r.status === 401) throw new Error('The API key was rejected. Check it in Settings.');
    if (r.status === 429) throw new Error('Too many requests. Wait a moment and try again.');
    if (r.status === 529 || r.status >= 500) throw new Error('Claude is busy right now. Try again in a minute.');
    if (/credit/i.test(m)) throw new Error('Your API account has no credit left. Add credit at console.anthropic.com.');
    throw new Error(m);
  }
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
async function aiFill() {
  const d = ui.draft; if (!d.front.trim()) { ui.err = 'Type the word or phrase first.'; render(); return; }
  ui.busy = true; ui.err = ''; render();
  const L = LANGS[d.lang];
  const prompt = d.lang === 'nl'
    ? `You make flashcards for an adult learner of Dutch (level A2 → B1) whose working language is English.
Term: "${d.front.trim()}"
Return ONLY a JSON object, no other text:
{"back":"short English meaning (if it has several common meanings, max 3, separated by '; ')",
"info":"short grammar note: for a noun give the article and plural (e.g. 'het huis · pl. huizen'); for a verb give the past forms and auxiliary (e.g. 'liep · heeft/is gelopen'), say if it is separable; for an idiom or expression give its literal meaning; otherwise empty string",
"ex":"one short, natural Dutch example sentence a native speaker would really say in daily life",
"exTr":"English translation of the example"}`
    : `You make flashcards for an adult non-native English speaker who wants to sound natural in everyday conversation.
Term: "${d.front.trim()}"
Return ONLY a JSON object, no other text:
{"back":"a short, simple English definition",
"info":"short note: part of speech and register (casual / neutral / formal), plus a common collocation if useful",
"ex":"one short, natural example sentence a native speaker would really say in daily life",
"exTr":""}`;
  try {
    const r = parseJ(await claude(prompt, 500));
    if (!d.back.trim()) d.back = r.back || '';
    if (!d.info.trim()) d.info = r.info || '';
    if (!d.ex.trim()) { d.ex = r.ex || ''; d.exTr = r.exTr || ''; }
  } catch (e) { ui.err = e.message; }
  ui.busy = false; render();
}
async function checkSentence() {
  const q = ui.quiz; const text = (q.text || '').trim(); if (!text) return;
  q.busy = true; q.result = null; q.err = ''; render();
  const lang = q.card ? q.card.lang : q.freeLang; const L = LANGS[lang];
  const target = q.card ? `Target word/phrase: "${q.card.front}" (meaning: ${q.card.back}). The learner must use it correctly and naturally.` : 'Free sentence, no target word.';
  const prompt = `You are a friendly, honest ${L.name} teacher. The learner is an adult studying ${L.level}. Explanations must be in simple English.
${target}
Learner's sentence: "${text}"
Judge grammar and above all NATURALNESS: would a native speaker actually say this in daily life? Return ONLY a JSON object, no other text:
{"verdict":"natural" | "understandable but unnatural" | "incorrect",
"score":integer 1-5,
"corrected":"the most natural version in ${L.name} (same as the original if it is already natural)",
"why":"max 3 short sentences explaining the mistakes or the unnatural parts, or why it is good",
"register":"short note: casual / neutral / formal / written, and where you would hear it",
"alternatives":["1-2 other natural ways to say it in ${L.name}"],
"used_target":true or false}`;
  try { q.result = parseJ(await claude(prompt, 700)); } catch (e) { q.err = e.message; }
  q.busy = false; render();
}
async function testKey() {
  ui.msg = ''; ui.err = ''; ui.busy = true; render();
  try { await claude('Reply with the single word: OK', 5); ui.msg = 'It works! Claude is connected.'; }
  catch (e) { ui.err = e.message; }
  ui.busy = false; render();
}

/* ================= backup ================= */
function abToB64(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
function b64ToAb(s) { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b.buffer; }
async function exportBackup() {
  const blobs = {};
  for (const c of cards) for (const k of ['photo', 'audio']) if (c[k] && !blobs[c[k]]) { const r = await DB.get('blobs', c[k]); if (r) blobs[c[k]] = { type: r.type, data: abToB64(r.buf) }; }
  const name = `flashcards-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify({ app: 'flashcards', v: 1, exported: Date.now(), cards, blobs })], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); ui.msg = 'Backup ready.'; return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  ui.msg = 'Backup downloaded.';
}
async function importBackup(file) {
  ui.msg = ''; ui.err = '';
  try {
    const d = JSON.parse(await file.text());
    if (!d || d.app !== 'flashcards' || !Array.isArray(d.cards)) throw new Error('This is not a Flashcards backup file.');
    let added = 0, updated = 0;
    for (const [id, b] of Object.entries(d.blobs || {})) await DB.put('blobs', { buf: b64ToAb(b.data), type: b.type }, id);
    for (const c of d.cards) {
      const cur = cards.find(x => x.id === c.id);
      if (!cur) { cards.push(c); await DB.put('cards', c); added++; }
      else if ((c.updated || 0) > (cur.updated || 0)) { Object.assign(cur, c); await DB.put('cards', cur); updated++; }
    }
    ui.msg = `Imported: ${added} new, ${updated} updated.`; buildQueue();
  } catch (e) { ui.err = e.message || 'Could not read the file.'; }
  render();
}

/* ================= views ================= */
let flashT = null;
function flash(m) { ui.err = m; render(); clearTimeout(flashT); flashT = setTimeout(() => { ui.err = ''; render(); }, 4000); }
const ttsBtn = (text, lang, label) => hasTTS && text ? `<button class="tool" data-act="speak" data-text="${esc(text)}" data-lang="${lang}">🔊 ${label}</button>` : '';
function recTools(c) {
  if (!Rec.supported()) return '';
  const rec = ui.recording === c.id;
  return `<button class="tool ${rec ? 'rec' : ''}" data-act="rec" data-id="${c.id}">${rec ? '⏹ Stop' : '🎙 Record me'}</button>` +
    (c.audio && !rec ? `<button class="tool" data-act="playcard" data-id="${c.id}">▶︎ My voice</button>` : '');
}

function vStudy() {
  if (!cards.length) return `<div class="empty"><b>🗂</b>No cards yet.<br>Tap <b style="display:inline;font-size:inherit">＋ Add</b> to create your first card.</div>`;
  const p = pool();
  if (!p.length) return `<div class="empty"><b>🗂</b>No ${LANGS[ui.lang].name} cards yet.</div>`;
  if (!ui.queue.length) {
    const t = today(); const tom = p.filter(c => c.seen && c.due > t && c.due <= t + DAY).length;
    const unseen = p.filter(c => !c.seen).length;
    return `<div class="empty"><b>🎉</b>All done for today!<br>Due tomorrow: ${tom}</div>` +
      (unseen ? `<button class="sec" data-act="more">Study 5 more new cards (${unseen} waiting)</button>` : '') +
      `<button class="sec" data-act="tab" data-t="quiz">Practise with a quiz</button>`;
  }
  const c = ui.queue[0];
  let h = `<div class="top"><span>Left: ${ui.queue.length}</span><span>${c.seen ? 'review' : 'new'}</span></div>
  <div class="card" data-act="flip"><div class="tag">${LANGS[c.lang].name}</div><div class="front">${esc(c.front)}</div>`;
  if (c.photo && (c.photoFront || ui.shown)) h += `<img class="photo" data-blob="${c.photo}" alt="">`;
  if (ui.shown) {
    if (c.info) h += `<div class="info">${esc(c.info)}</div>`;
    h += `<hr><div class="back">${esc(c.back)}</div>`;
    if (c.ex) h += `<div class="ex">${esc(c.ex)}${c.exTr ? `<div class="exTr">${esc(c.exTr)}</div>` : ''}</div>`;
    h += `<div class="tools">${ttsBtn(c.front, c.lang, 'Word')}${ttsBtn(c.ex, c.lang, 'Sentence')}${recTools(c)}</div>`;
  } else {
    h += `<div class="tools">${ttsBtn(c.front, c.lang, 'Listen')}</div><div class="hint">Tap the card to see the answer</div>`;
  }
  h += '</div>';
  if (ui.err) h += `<div class="err">${esc(ui.err)}</div>`;
  if (ui.shown) {
    const L = ['Again', 'Hard', 'Good', 'Easy'];
    h += '<div class="rate">' + L.map((n, i) => `<button class="r${i}" data-act="rate" data-q="${i}">${n}<small>${fmt(calc(c, i).i)}</small></button>`).join('') + '</div>';
  } else h += `<button class="primary" data-act="flip">Show answer</button>`;
  return h;
}

function langSeg(act, cur) { return `<div class="seg">${Object.keys(LANGS).map(l => `<button class="chip ${cur === l ? 'on' : ''}" data-act="${act}" data-l="${l}">${LANGS[l].name}</button>`).join('')}</div>`; }
function startDraft(c) {
  const base = c || newCard(ui.lang === 'all' ? (ui.draft ? ui.draft.lang : 'nl') : ui.lang);
  ui.draft = { id: c ? c.id : null, lang: base.lang, front: base.front, back: base.back, info: base.info || '', ex: base.ex || '', exTr: base.exTr || '',
    photo: base.photo, photoFront: !!base.photoFront, audio: base.audio, photoBlob: null, photoRemoved: false, audioBlob: null, audioRemoved: false, photoUrl: null };
  ui.err = ''; ui.delArm = false;
}
function vAdd() {
  if (!ui.draft) startDraft();
  const d = ui.draft, ed = !!d.id;
  const photoSrc = d.photoUrl ? `src="${d.photoUrl}"` : (d.photo && !d.photoRemoved ? `data-blob="${d.photo}"` : '');
  const hasAudio = d.audioBlob || (d.audio && !d.audioRemoved);
  const rec = ui.recording === 'draft';
  return `${ed ? '<div class="top"><span>Editing card</span></div>' : ''}
  <label>Language</label>${langSeg('draftlang', d.lang)}
  <label>Word / phrase / sentence</label><input data-f="front" value="${esc(d.front)}" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">
  <label>Meaning</label><input data-f="back" value="${esc(d.back)}" autocomplete="off">
  <label>Grammar note (optional)</label><input data-f="info" value="${esc(d.info)}" autocomplete="off" placeholder="${d.lang === 'nl' ? 'e.g. het huis · pl. huizen' : 'e.g. verb · casual'}">
  <label>Example sentence (optional)</label><textarea data-f="ex" style="min-height:64px">${esc(d.ex)}</textarea>
  ${d.lang === 'nl' ? `<label>Example translation (optional)</label><input data-f="exTr" value="${esc(d.exTr)}" autocomplete="off">` : ''}
  <button class="sec" data-act="fill" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Claude is thinking…' : '✨ Let Claude fill the empty fields'}</button>
  <label>Photo (optional)</label>
  <div class="media">${photoSrc ? `<img ${photoSrc} alt="">` : ''}
    <span class="tool filebtn">📷 ${photoSrc ? 'Change' : 'Add photo'}<input type="file" accept="image/*" id="photoIn"></span>
    ${photoSrc ? `<button class="tool" data-act="rmphoto">✕ Remove</button>` : ''}</div>
  ${photoSrc ? `<label class="check"><input type="checkbox" id="photoFront" ${d.photoFront ? 'checked' : ''}>Show photo on the front of the card</label>` : ''}
  <label>Pronunciation</label>
  <div class="media">${ttsBtn(d.front, d.lang, 'Listen')}
    ${Rec.supported() ? `<button class="tool ${rec ? 'rec' : ''}" data-act="rec" data-id="draft">${rec ? '⏹ Stop' : '🎙 Record my voice'}</button>` : ''}
    ${hasAudio && !rec ? `<button class="tool" data-act="playdraft">▶︎ Play</button><button class="tool" data-act="rmaudio">✕</button>` : ''}</div>
  ${ui.err ? `<div class="err">${esc(ui.err)}</div>` : ''}
  ${ui.msg ? `<div class="okmsg">${esc(ui.msg)}</div>` : ''}
  <button class="primary" data-act="save">${ed ? 'Save changes' : 'Save card'}</button>
  ${ed ? `<button class="sec" data-act="cancel">Cancel</button><button class="danger" data-act="del">${ui.delArm ? 'Tap again to delete' : 'Delete card'}</button>` : ''}
  ${ed ? '' : `<details><summary>Add many at once</summary>
    <label>One card per line: word ; meaning ; example (example is optional)</label>
    <textarea id="bulk" style="min-height:120px" placeholder="gezellig ; cosy, pleasant ; Het was heel gezellig gisteren."></textarea>
    <button class="sec" data-act="bulk">Add to ${LANGS[d.lang].name}</button></details>`}`;
}

function listHtml() {
  const q = ui.search.trim().toLowerCase(); const t = today();
  const rows = pool().filter(c => !q || (c.front + ' ' + c.back).toLowerCase().includes(q)).sort((a, b) => b.created - a.created);
  if (!rows.length) return `<div class="empty">No cards found.</div>`;
  return rows.map(c => {
    const m = !c.seen ? 'new' : c.due <= t ? 'today' : 'in ' + fmt(Math.round((c.due - t) / DAY));
    return `<div class="item" data-act="edit" data-id="${c.id}">${c.photo ? `<img class="thumb" data-blob="${c.photo}" alt="">` : ''}
      <div class="txt"><div class="t">${esc(c.front)}</div><div class="s">${esc(c.back)}</div></div>
      <div class="m">${c.lang.toUpperCase()}${c.audio ? ' 🎙' : ''}<br>${m}</div></div>`;
  }).join('');
}
function vCards() {
  const p = pool(); const t = today();
  const learned = p.filter(c => c.seen && c.interval >= 21).length;
  return `<input id="search" placeholder="Search…" value="${esc(ui.search)}" autocapitalize="off" autocorrect="off">
    <div class="top" style="margin-top:10px"><span>${p.length} cards · ${learned} well learned</span><span>${p.filter(c => c.seen && c.due <= t).length} due</span></div>
    <div id="list">${listHtml()}</div>`;
}

function vQuiz() {
  const q = ui.quiz;
  if (!q.mode) return `<div class="empty" style="padding:16px 10px"><b>✍️</b>Choose a quiz</div>
    <button class="primary" data-act="qmode" data-m="mc">Multiple choice</button>
    <button class="primary" data-act="qmode" data-m="type">Type the word</button>
    ${hasTTS ? `<button class="primary" data-act="qmode" data-m="listen">Listen and choose</button>` : ''}
    <button class="primary" data-act="qmode" data-m="sent">Write a sentence — Claude checks it</button>
    <div class="note">Tip: quiz questions favour the cards you find hardest.</div>`;
  const back = `<div class="seg"><button class="chip" data-act="qmode" data-m="">← Quizzes</button></div>`;
  if (q.mode === 'mc' || q.mode === 'listen') {
    const m = q.mc;
    if (!m || m.err) return back + `<div class="empty">${esc(m ? m.err : 'No cards here yet.')}</div>`;
    let h = back + `<div class="score">Score: ${q.score.ok} / ${q.score.n}</div>`;
    if (q.mode === 'listen') h += `<div class="q"><button class="primary" data-act="speak" data-text="${esc(m.c.front)}" data-lang="${m.c.lang}" style="width:auto;display:inline-block;padding:16px 28px">🔊 Play again</button></div><div class="score">Which one did you hear?</div>`;
    else h += `<div class="q">${esc(m.dir === 'fb' ? m.c.front : m.c.back)}</div><div class="score">${m.dir === 'fb' ? 'What does it mean?' : 'Which ' + LANGS[m.c.lang].name + ' word is it?'}</div>`;
    m.opts.forEach((o, i) => {
      const txt = (q.mode === 'mc' && m.dir === 'fb') ? o.back : o.front; let cls = '';
      if (m.picked != null) { if (o.id === m.c.id) cls = 'ok'; else if (i === m.picked) cls = 'bad'; }
      h += `<button class="opt ${cls}" data-act="mcpick" data-i="${i}" ${m.picked != null ? 'disabled' : ''}>${esc(txt)}</button>`;
    });
    if (m.picked != null) h += `<div class="box" style="text-align:center"><b>${esc(m.c.front)}</b> — ${esc(m.c.back)}<div class="tools">${ttsBtn(m.c.front, m.c.lang, 'Listen')}</div></div><button class="primary" data-act="mcnext">Next</button>`;
    return h;
  }
  if (q.mode === 'type') {
    const m = q.ty;
    if (!m) return back + `<div class="empty">No cards here yet.</div>`;
    let h = back + `<div class="score">Score: ${q.score.ok} / ${q.score.n}</div><div class="q">${esc(m.c.back)}</div>
      <div class="score">Type the ${LANGS[m.c.lang].name} word</div>${m.c.photo ? `<img class="photo" data-blob="${m.c.photo}" alt="">` : ''}
      <input data-q="typed" value="${esc(m.typed || '')}" style="margin-top:14px" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" ${m.done ? 'disabled' : ''}>`;
    if (!m.done) h += `<button class="primary" data-act="typecheck">Check</button><button class="sec" data-act="typeskip">I don't know</button>`;
    else h += `<div class="box" style="text-align:center"><span class="pill ${m.ok ? 'b-ok' : 'b-bad'}">${m.ok ? (m.close ? 'Almost — check the spelling' : 'Correct!') : 'Not quite'}</span>
      <div class="front" style="font-size:24px">${esc(m.c.front)}</div><div class="tools">${ttsBtn(m.c.front, m.c.lang, 'Listen')}</div></div>
      <button class="primary" data-act="typenext">Next</button>`;
    return h;
  }
  // sentence mode
  const c = q.card; let h = back;
  if (c) {
    h += `<div class="card" style="min-height:0;margin-top:10px"><div class="tag">${LANGS[c.lang].name} · make a sentence with</div><div class="front" style="font-size:26px">${esc(c.front)}</div><div class="exTr">${esc(c.back)}</div></div>
    <div class="seg" style="margin-top:10px"><button class="chip" data-act="snext">Another word</button><button class="chip" data-act="sfree">My own sentence</button></div>`;
  } else {
    h += `<label>Free sentence — language</label>${langSeg('sfreelang', q.freeLang)}<div class="seg" style="margin-top:10px"><button class="chip" data-act="snext">Give me a word from my cards</button></div>`;
  }
  h += `<label>Your sentence</label><textarea data-q="text" placeholder="Write here…" autocapitalize="sentences">${esc(q.text || '')}</textarea>
  <button class="primary" data-act="scheck" ${q.busy ? 'disabled' : ''}>${q.busy ? 'Claude is reading…' : 'Check my sentence'}</button>`;
  if (q.err) h += `<div class="err">${esc(q.err)}</div>`;
  const r = q.result;
  if (r) {
    const v = String(r.verdict || ''); const cls = v === 'natural' ? 'b-ok' : v === 'incorrect' ? 'b-bad' : 'b-mid';
    const sc = Math.max(0, Math.min(5, parseInt(r.score) || 0)); const lang = c ? c.lang : q.freeLang;
    h += `<div class="box"><span class="pill ${cls}">${esc(v)}</span> <span class="score">${'★'.repeat(sc)}${'☆'.repeat(5 - sc)}</span>
    <div style="margin-top:10px"><div class="tag">Most natural version</div><div class="back" style="font-size:19px;margin:2px 0">${esc(r.corrected)}</div>
    <div class="tools" style="justify-content:flex-start;margin-top:4px">${ttsBtn(r.corrected, lang, 'Listen')}</div></div>
    <div style="margin-top:8px">${esc(r.why)}</div>
    ${r.register ? `<div class="exTr" style="margin-top:8px">Usage: ${esc(r.register)}</div>` : ''}
    ${r.used_target === false && c ? `<div class="err">You didn't use the target word.</div>` : ''}
    ${Array.isArray(r.alternatives) && r.alternatives.length ? `<div style="margin-top:8px"><div class="tag">Other ways to say it</div>${r.alternatives.map(a => `<div>• ${esc(a)}</div>`).join('')}</div>` : ''}
    ${c ? `<button class="sec" data-act="saveex" ${r.saved ? 'disabled' : ''}>${r.saved ? 'Saved as example ✓' : "Save corrected sentence as this card's example"}</button>` : ''}
    </div>`;
  }
  return h;
}

function vSettings() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  let h = `<div class="seg"><button class="chip" data-act="tab" data-t="study">← Back</button></div>
  <h2>Claude (AI)</h2>
  <div class="note">Used for “Let Claude fill”, and for checking your sentences. Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>. The key is stored only on this device.</div>
  <label>API key</label><input id="apiKey" type="password" value="${esc(settings.apiKey)}" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
  <label>Model</label><select id="model">${MODELS.map(([v, n]) => `<option value="${v}" ${settings.model === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
  <button class="sec" data-act="testkey" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Testing…' : 'Save & test key'}</button>
  ${ui.err ? `<div class="err">${esc(ui.err)}</div>` : ''}${ui.msg ? `<div class="okmsg">${esc(ui.msg)}</div>` : ''}
  <h2>Study</h2>
  <label>New cards per day: <b id="npdV">${settings.newPerDay}</b></label><input id="npd" type="range" min="0" max="40" step="1" value="${settings.newPerDay}">
  <h2>Pronunciation</h2>
  <label>Speaking speed: <b id="rateV">${settings.rate.toFixed(2)}</b></label><input id="rate" type="range" min="0.5" max="1.2" step="0.05" value="${settings.rate}">`;
  for (const l of Object.keys(LANGS)) {
    const vs = voicesFor(l); const cur = pickVoice(l);
    h += `<label>${LANGS[l].name} voice</label>` + (vs.length
      ? `<div class="media"><select data-voice="${l}" style="flex:1">${vs.map(v => `<option ${cur && cur.name === v.name ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>${ttsBtn(l === 'nl' ? 'Goedemorgen, hoe gaat het?' : 'Good morning, how are you?', l, 'Test')}</div>`
      : `<div class="note">No ${LANGS[l].name} voice found on this device.</div>`);
  }
  if (isIOS) h += `<div class="note">Better voices: iPhone/iPad Settings → Accessibility → Spoken Content → Voices → ${'Dutch'} / English → download an “Enhanced” or “Premium” voice. Then restart this app.</div>`;
  h += `<h2>Backup & move to another device</h2>
  <div class="note">Your cards, photos and recordings live only on this device. Make a backup regularly. To copy cards to your iPad: back up here, AirDrop or save the file to Files, then use “Restore” on the iPad.</div>
  <button class="sec" data-act="export">⬆︎ Back up (save / share file)</button>
  <span class="sec filebtn" style="display:block;text-align:center;border:1px solid var(--acc);border-radius:14px;padding:14px;margin-top:12px;color:var(--acc);background:var(--card)">⬇︎ Restore from backup<input type="file" accept=".json,application/json" id="importIn"></span>
  <div class="note">Restoring adds new cards and updates changed ones. Nothing is deleted.</div>
  <h2>About</h2><div class="note">${cards.length} cards on this device.${standalone ? '' : isIOS ? ' To install: open this page in Safari → Share → Add to Home Screen.' : ''}</div>`;
  return h;
}

function render() {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.t === ui.tab));
  const showChips = ui.tab !== 'settings';
  $('#chips').innerHTML = showChips ? [['all', 'All'], ['nl', 'Dutch'], ['en', 'English']].map(([l, n]) => `<button class="chip ${ui.lang === l ? 'on' : ''}" data-act="lang" data-l="${l}">${n}</button>`).join('') : '';
  $('#title').textContent = ui.tab === 'settings' ? 'Settings' : 'Flashcards';
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  $('#banner').innerHTML = (isIOS && !standalone && !settings.bannerClosed) ? `<div class="banner"><div>📲 Install: tap <b>Share</b> → <b>Add to Home Screen</b>. Then open it from your home screen.</div><button data-act="closebanner">✕</button></div>` : '';
  $('#main').innerHTML = ui.tab === 'study' ? vStudy() : ui.tab === 'add' ? vAdd() : ui.tab === 'cards' ? vCards() : ui.tab === 'quiz' ? vQuiz() : vSettings();
  updateBadge(); hydrate();
}

/* ================= quiz helpers ================= */
function weighted(p) { // harder cards come up more often
  const w = p.map(c => 1 + (c.lapses || 0) * 2 + (c.ease ? Math.max(0, 2.6 - c.ease) * 4 : 0) + (c.seen ? 0 : 0.5));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < p.length; i++) { r -= w[i]; if (r <= 0) return p[i]; } return p[p.length - 1];
}
function newMC() {
  const p = pool(); if (!p.length) { ui.quiz.mc = null; return; }
  let c = weighted(p); if (ui.quiz.mc && ui.quiz.mc.c && p.length > 1 && c.id === ui.quiz.mc.c.id) c = weighted(p);
  const same = cards.filter(x => x.lang === c.lang && x.id !== c.id && x.front !== c.front);
  if (same.length < 3) { ui.quiz.mc = { err: 'You need at least 4 cards in the same language for this quiz.' }; return; }
  ui.quiz.mc = { c, dir: Math.random() < .5 ? 'fb' : 'bf', opts: shuffle([c, ...shuffle(same).slice(0, 3)]), picked: null };
  if (ui.quiz.mode === 'listen') setTimeout(() => speak(c.front, c.lang), 150);
}
function newType() { const p = pool(); ui.quiz.ty = p.length ? { c: weighted(p), typed: '', done: false } : null; }
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
const stripArt = s => s.replace(/^(de|het|een|to|a|an|the) /, '');
function lev(a, b) { const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i]); for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }
function newSent() {
  const p = pool(); const q = ui.quiz; q.text = ''; q.result = null; q.err = '';
  if (p.length) q.card = weighted(p); else { q.card = null; q.freeLang = ui.lang === 'en' ? 'en' : 'nl'; }
}

/* ================= actions ================= */
async function saveDraft() {
  const d = ui.draft;
  if (!d.front.trim() || !d.back.trim()) { ui.err = 'Word and meaning cannot be empty.'; return; }
  let c = d.id ? cards.find(x => x.id === d.id) : null;
  if (!c) { c = newCard(d.lang); cards.push(c); }
  Object.assign(c, { lang: d.lang, front: d.front.trim(), back: d.back.trim(), info: d.info.trim(), ex: d.ex.trim(), exTr: d.lang === 'nl' ? d.exTr.trim() : '', photoFront: d.photoFront });
  if (d.photoBlob) { const old = c.photo; c.photo = await putBlob(d.photoBlob); if (old) delBlob(old); }
  else if (d.photoRemoved && c.photo) { delBlob(c.photo); c.photo = null; }
  if (d.audioBlob) { const old = c.audio; c.audio = await putBlob(d.audioBlob); if (old) delBlob(old); }
  else if (d.audioRemoved && c.audio) { delBlob(c.audio); c.audio = null; }
  await saveCard(c);
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  const wasEdit = !!d.id; const lang = d.lang;
  if (d.photoUrl) URL.revokeObjectURL(d.photoUrl);
  ui.draft = null; startDraft(); ui.draft.lang = lang; ui.msg = wasEdit ? '' : 'Saved ✓';
  if (wasEdit) ui.tab = 'cards';
  buildQueue();
}
async function act(a, d, el) {
  if (a !== 'save' && a !== 'export' && a !== 'testkey') ui.msg = '';
  switch (a) {
    case 'tab':
      if (ui.recording) await toggleRecord();
      ui.tab = d.t; ui.err = ''; stopAudio();
      if (d.t === 'study') buildQueue();
      if (d.t === 'add' && (!ui.draft || ui.draft.id)) { ui.draft = null; startDraft(); }
      break;
    case 'lang': ui.lang = d.l; buildQueue(); ui.quiz.mode = null; if (ui.draft && !ui.draft.id && d.l !== 'all') ui.draft.lang = d.l; break;
    case 'flip': if (!ui.shown) { ui.shown = true; } else return; break;
    case 'rate': return rate(+d.q);
    case 'more': { const ids = new Set(ui.queue.map(c => c.id)); ui.queue.push(...pool().filter(c => !c.seen && !ids.has(c.id)).sort((x, y) => x.created - y.created).slice(0, 5)); break; }
    case 'speak': speak(d.text, d.lang); return;
    case 'rec': return toggleRecord(d.id);
    case 'playcard': { const c = cards.find(x => x.id === d.id); if (c) playBlob(c.audio); return; }
    case 'playdraft': { const dr = ui.draft; if (dr.audioBlob) playRaw(dr.audioBlob); else if (dr.audio) playBlob(dr.audio); return; }
    case 'rmaudio': ui.draft.audioBlob = null; ui.draft.audioRemoved = true; break;
    case 'rmphoto': if (ui.draft.photoUrl) URL.revokeObjectURL(ui.draft.photoUrl); ui.draft.photoBlob = null; ui.draft.photoUrl = null; ui.draft.photoRemoved = true; break;
    case 'draftlang': ui.draft.lang = d.l; break;
    case 'fill': return aiFill();
    case 'save': await saveDraft(); break;
    case 'cancel': ui.draft = null; ui.tab = 'cards'; break;
    case 'del':
      if (!ui.delArm) { ui.delArm = true; break; }
      { const c = cards.find(x => x.id === ui.draft.id); if (c) { cards = cards.filter(x => x !== c); await DB.del('cards', c.id); delBlob(c.photo); delBlob(c.audio); } }
      ui.draft = null; ui.tab = 'cards'; buildQueue(); break;
    case 'edit': { const c = cards.find(x => x.id === d.id); if (c) { startDraft(c); ui.tab = 'add'; } break; }
    case 'bulk': {
      const ta = $('#bulk'); const lines = (ta ? ta.value : '').split('\n').map(s => s.trim()).filter(Boolean); let n = 0;
      for (const l of lines) { const p = l.split(/;|\t/).map(s => s.trim()); if (p[0] && p[1]) { const c = newCard(ui.draft.lang); Object.assign(c, { front: p[0], back: p[1], ex: p[2] || '', created: Date.now() + n }); cards.push(c); await saveCard(c); n++; } }
      if (n) { ui.msg = `Added ${n} cards.`; buildQueue(); } else ui.err = 'Use this format: word ; meaning ; example';
      break;
    }
    case 'qmode':
      ui.quiz.mode = d.m || null; ui.quiz.score = { ok: 0, n: 0 }; ui.quiz.mc = null;
      if (d.m === 'mc' || d.m === 'listen') newMC(); if (d.m === 'type') newType(); if (d.m === 'sent') newSent(); break;
    case 'mcpick': { const m = ui.quiz.mc; if (m && m.picked == null) { m.picked = +d.i; ui.quiz.score.n++; if (m.opts[m.picked].id === m.c.id) ui.quiz.score.ok++; else { m.c.lapses = (m.c.lapses || 0) + 1; saveCard(m.c); } } break; }
    case 'mcnext': newMC(); break;
    case 'typecheck': case 'typeskip': {
      const m = ui.quiz.ty; if (!m || m.done) break;
      const a1 = norm(m.typed), b1 = norm(m.c.front);
      const exact = a === 'typecheck' && a1 && (a1 === b1 || stripArt(a1) === stripArt(b1));
      const close = a === 'typecheck' && !exact && a1 && lev(stripArt(a1), stripArt(b1)) <= (b1.length > 6 ? 2 : 1);
      m.ok = exact || close; m.close = close; m.done = true; ui.quiz.score.n++; if (m.ok) ui.quiz.score.ok++;
      if (!m.ok) { m.c.lapses = (m.c.lapses || 0) + 1; saveCard(m.c); }
      if (hasTTS) speak(m.c.front, m.c.lang); break;
    }
    case 'typenext': newType(); render(); { const i = document.querySelector('[data-q="typed"]'); if (i) i.focus(); } return;
    case 'snext': newSent(); break;
    case 'sfree': ui.quiz.card = null; ui.quiz.freeLang = ui.lang === 'en' ? 'en' : 'nl'; ui.quiz.result = null; break;
    case 'sfreelang': ui.quiz.freeLang = d.l; break;
    case 'scheck': return checkSentence();
    case 'saveex': { const q = ui.quiz; if (q.card && q.result) { q.card.ex = q.result.corrected; q.card.exTr = ''; await saveCard(q.card); ui.msg = ''; q.err = ''; q.result.saved = true; } break; }
    case 'testkey': settings.apiKey = ($('#apiKey').value || '').trim(); settings.model = $('#model').value; await saveSettings(); return testKey();
    case 'export': ui.err = ''; try { await exportBackup(); } catch (e) { ui.err = 'Backup failed: ' + e.message; } break;
    case 'closebanner': settings.bannerClosed = true; saveSettings(); break;
  }
  render();
}

document.addEventListener('click', e => { const el = e.target.closest('[data-act]'); if (!el) return; act(el.dataset.act, el.dataset, el); });
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.f && ui.draft) ui.draft[t.dataset.f] = t.value;
  else if (t.dataset.q === 'typed' && ui.quiz.ty) ui.quiz.ty.typed = t.value;
  else if (t.dataset.q) ui.quiz[t.dataset.q] = t.value;
  else if (t.id === 'search') { ui.search = t.value; $('#list').innerHTML = listHtml(); hydrate(); }
  else if (t.id === 'npd') { settings.newPerDay = +t.value; $('#npdV').textContent = t.value; saveSettings(); }
  else if (t.id === 'rate') { settings.rate = +t.value; $('#rateV').textContent = (+t.value).toFixed(2); saveSettings(); }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'photoIn' && t.files[0]) {
    try { const b = await resizeImage(t.files[0]); if (ui.draft.photoUrl) URL.revokeObjectURL(ui.draft.photoUrl); ui.draft.photoBlob = b; ui.draft.photoUrl = URL.createObjectURL(b); ui.draft.photoRemoved = false; }
    catch (err) { ui.err = 'Could not read this photo.'; }
    render();
  } else if (t.id === 'photoFront') { ui.draft.photoFront = t.checked; }
  else if (t.id === 'importIn' && t.files[0]) { await importBackup(t.files[0]); }
  else if (t.dataset.voice) { settings.voice[t.dataset.voice] = t.value; saveSettings(); }
  else if (t.id === 'model') { settings.model = t.value; saveSettings(); }
  else if (t.id === 'apiKey') { settings.apiKey = t.value.trim(); saveSettings(); }
});
document.addEventListener('keydown', e => { // iPad keyboard shortcuts
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    if (e.key === 'Enter' && document.activeElement.dataset.q === 'typed') { e.preventDefault(); act(ui.quiz.ty && ui.quiz.ty.done ? 'typenext' : 'typecheck', {}); }
    return;
  }
  if (ui.tab !== 'study' || !ui.queue.length) return;
  if (e.key === ' ' && !ui.shown) { e.preventDefault(); act('flip', {}); }
  else if (ui.shown && '1234'.includes(e.key)) act('rate', { q: e.key - 1 });
});

/* ================= start ================= */
(async () => {
  try {
    await DB.open();
    cards = (await DB.all('cards')) || [];
    const s = await DB.get('kv', 'settings'); if (s) settings = Object.assign(settings, s, { voice: Object.assign({ nl: '', en: '' }, s.voice) });
    const n = await DB.get('kv', 'newToday'); if (n) newToday = n;
  } catch (e) { $('#main').innerHTML = `<div class="empty">Storage is not available (private browsing?).</div>`; return; }
  buildQueue(); render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
})();

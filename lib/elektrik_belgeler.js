// elektrik_belgeler.js — "Belgeler" sayfası: dosya yükleme, listeleme, açma / indirme, silme.
//
// İki klasör: faturalar/ ve belgeler/ (kovada ayrı klasörler). Dosyalar YALNIZCA Supabase Storage'da tutulur (bilgisayara / sunucu diskine kopya yazılmaz): özel (public
// olmayan) "elektrik-belgeler" kovası; dosya <id><uzantı>, liste liste.json. Erişim sunucu üzerinden
// (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY); tarayıcı Supabase anahtarını hiç görmez.
// Uçlar: GET /belgeler (sayfa) · GET /referans (Referans sekmesi) · GET /api/belgeler · POST /api/belgeler/yukle?ad=&kategori=&sozlesme=&lokasyon=&donem=&aciklama=
//        (gövde = dosyanın kendisi) · GET /belge/<id> (?indir=1) · POST /api/belgeler/sil { id } · POST /api/belgeler/guncelle
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KOVA = 'elektrik-belgeler';
const SINIR = 30 * 1024 * 1024; // dosya başına 30 MB
const TUR = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.zip': 'application/zip', '.xml': 'application/xml' };
const KLASORLER = ['faturalar', 'belgeler'];
const nesneAdi = k => k.nesne || k.id + k.uzanti; // eski kayıtlar klasörsüz
const turu = ad => TUR[path.extname(ad || '').toLowerCase()] || 'application/octet-stream';

// zenginlestir(kayit): sunucunun verdiği eşleştirici; fatura no → sözleşme, lokasyon, dönem ve kategori doldurur
// yerel: { depo, otomatik(): [kayıt], okunanlar(): Map } — Supabase yoksa dosyalar bu klasörde tutulur (SECENGIDA masaüstü);
// otomatik() SECENGIDA klasöründen okunan faturaların listesi (silinemez, alanları duzeltmeler.json ile değiştirilir).
const FATURA_NO = /(CK\d{12,16}|OSB\d{10,16}|ANT\d{10,16})/i;
function belgeler({ sayfa, env = {}, log = console.log, zenginlestir = null, yerel = null }) {
  // Liste güncellemeleri tek sıra: aynı anda yapılan yükleme / silme birbirinin kaydını ezmesin
  let kuyruk = Promise.resolve();
  const sirali = f => (kuyruk = kuyruk.then(f, f));
  const zengin = k => { try { if (!k.faturaNo) k.faturaNo = ((k.ad || '').match(FATURA_NO) || [''])[0].toUpperCase(); if (zenginlestir) zenginlestir(k); } catch (e) { log('Belge eşleştirme hatası:', e.message); } return k; };
  const U = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, ''), K = String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '').trim();
  const supa = !!(U && K) || !!yerel;
  const YEREL = !(U && K) && yerel ? yerel : null;
  const yerelYol = n => { const p = path.resolve(YEREL.depo, n); if (!p.startsWith(path.resolve(YEREL.depo))) throw new Error('Geçersiz yol'); return p; };
  const bas = (ek = {}) => ({ apikey: K, Authorization: 'Bearer ' + K, ...ek });
  let kovaHazir = false;
  // PDF'ten okunan fatura değerleri: fatura no → özet. Supabase'de okunan.json olarak saklanır (tek dosya);
  // sunucu açılınca yüklenir, yeni yüklenen PDF hemen okunur, toplu okuma eksikleri tamamlar.
  const OKUNAN = new Map();
  let okunanYuklendi = false;
  const okumaDurumu = { calisiyor: false, toplam: 0, okunan: 0, hata: 0, baslangic: null, bitis: null };
  const ozetle = (r, k) => ({
    ...r,
    belgeId: k.id, faturaNo: r.faturaNo || k.faturaNo, donem: r.donem, gun: r.gun, ilkOkuma: r.ilkOkuma, sonOkuma: r.sonOkuma,
    tuketimKwh: r.tuketimKwh, okumaKwh: r.okumaKwh, faturaTutari: r.faturaTutari, odenecek: r.odenecek, etv: r.etv, kdv: r.kdv, kdvMatrah: r.kdvMatrah,
    guvence: r.guvence, gucBedeli: r.gucBedeli, trafoKaybi: r.trafoKaybi, dusulen: r.dusulen, dusulenKwh: r.dusulenKwh, dusulenTL: r.dusulenTL,
    tuketiciGrubu: r.tuketiciGrubu, tuketiciSinifi: r.tuketiciSinifi, anlasmaGucu: r.anlasmaGucu, kalemler: r.kalemler, diger: (r.diger || []).filter(x => !/yuvarlama/i.test(x.ad)), okundu: r.okundu,
  });
  async function okunanYukle() {
    if (YEREL) { for (const [no, v] of YEREL.okunanlar()) if (!OKUNAN.has(no)) OKUNAN.set(no, v); }
    if (okunanYuklendi || !supa) return OKUNAN;
    const b = await oku('okunan.json');
    if (b) for (const [no, v] of Object.entries(JSON.parse(b.toString('utf8')))) OKUNAN.set(no, v);
    okunanYuklendi = true;
    log('PDF’ten okunan fatura:', OKUNAN.size);
    return OKUNAN;
  }
  const okunanYaz = () => yaz('okunan.json', Buffer.from(JSON.stringify(Object.fromEntries(OKUNAN))), 'application/json');
  async function pdfOku(k) {
    const veri = await oku(nesneAdi(k));
    if (!veri) throw new Error('PDF Supabase’den okunamadı');
    const r = require('./secengida_pdf.js').cozumle((await require('pdf-parse/lib/pdf-parse.js')(veri)).text);
    const o = ozetle(r, k);
    OKUNAN.set(o.faturaNo, o);
    return o;
  }
  // Toplu okuma (arka planda): Faturalar'daki PDF'lerden henüz okunmamış olanlar (yeniden=true: hepsi)
  async function hepsiniOku(yeniden) {
    if (okumaDurumu.calisiyor) return;
    await okunanYukle();
    const L = (await liste()).filter(k => k.faturaNo && k.uzanti === '.pdf' && (yeniden || !OKUNAN.has(k.faturaNo)));
    Object.assign(okumaDurumu, { calisiyor: true, toplam: L.length, okunan: 0, hata: 0, baslangic: new Date().toISOString(), bitis: null });
    log('Fatura PDF toplu okuma başladı:', L.length, 'dosya');
    for (let i = 0; i < L.length; i++) {
      try { await pdfOku(L[i]); okumaDurumu.okunan++; } catch (e) { okumaDurumu.hata++; log('PDF okunamadı:', L[i].ad, e.message); }
      if (i % 50 === 49) await okunanYaz().catch(() => { });
    }
    await okunanYaz().catch(e => log('okunan.json yazılamadı:', e.message));
    Object.assign(okumaDurumu, { calisiyor: false, bitis: new Date().toISOString() });
    log('Fatura PDF toplu okuma bitti:', okumaDurumu.okunan, 'okundu,', okumaDurumu.hata, 'hata');
  }

  function hazirMi() { if (!supa) throw new Error('Belgeler Supabase’de tutulur: .env / Render ayarlarında SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY tanımlı olmalı.'); }
  async function kova() {
    hazirMi();
    if (kovaHazir || YEREL) return;
    const r = await fetch(U + '/storage/v1/bucket', { method: 'POST', headers: bas({ 'Content-Type': 'application/json' }), body: JSON.stringify({ id: KOVA, name: KOVA, public: false }) });
    if (!r.ok && ![400, 409].includes(r.status)) throw new Error('Supabase kova oluşturulamadı: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 150));
    kovaHazir = true;
  }
  async function yaz(nesne, veri, tur) {
    if (YEREL) { const p = yerelYol(nesne); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, veri); return; }
    await kova();
    const r = await fetch(U + '/storage/v1/object/' + KOVA + '/' + nesne, { method: 'POST', headers: bas({ 'Content-Type': tur, 'x-upsert': 'true' }), body: veri });
    if (!r.ok) throw new Error('Supabase yükleme HTTP ' + r.status + ' ' + (await r.text()).slice(0, 150));
  }
  async function oku(nesne) {
    if (YEREL) { try { return fs.readFileSync(yerelYol(nesne)); } catch (e) { return null; } }
    await kova();
    const r = await fetch(U + '/storage/v1/object/' + KOVA + '/' + nesne, { headers: bas() });
    if (r.status === 404 || r.status === 400) return null;
    if (!r.ok) throw new Error('Supabase okuma HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
  async function kaldir(nesne) {
    if (YEREL) { try { fs.unlinkSync(yerelYol(nesne)); } catch (e) { } return; }
    await kova();
    const r = await fetch(U + '/storage/v1/object/' + KOVA + '/' + nesne, { method: 'DELETE', headers: bas() });
    if (!r.ok && r.status !== 404 && r.status !== 400) throw new Error('Supabase silme HTTP ' + r.status);
  }

  async function liste() {
    const b = await oku('liste.json'), l = b ? JSON.parse(b.toString('utf8')) : [];
    if (!YEREL) return l;
    const d = await oku('duzeltmeler.json'), duz = d ? JSON.parse(d.toString('utf8')) : {};
    return [...YEREL.otomatik().map(k => ({ ...k, ...(duz[k.id] || {}) })), ...l];
  }
  async function listeYaz(l) {
    if (!YEREL) return yaz('liste.json', Buffer.from(JSON.stringify(l)), 'application/json');
    // Otomatik kayıtlar listede tutulmaz; elle değiştirilen alanları duzeltmeler.json'a yazılır
    const d = await oku('duzeltmeler.json'), duz = d ? JSON.parse(d.toString('utf8')) : {};
    const oto = new Map(YEREL.otomatik().map(k => [k.id, k]));
    for (const k of l.filter(x => x.otomatik)) {
      const o = oto.get(k.id); if (!o) continue;
      const fark = {}; for (const a of ['kategori', 'sozlesme', 'lokasyon', 'donem', 'aciklama', 'faturaNo']) if (k[a] !== o[a]) fark[a] = k[a];
      if (Object.keys(fark).length) duz[k.id] = fark; else delete duz[k.id];
    }
    await yaz('duzeltmeler.json', Buffer.from(JSON.stringify(duz)), 'application/json');
    await yaz('liste.json', Buffer.from(JSON.stringify(l.filter(x => !x.otomatik))), 'application/json');
  }
  // Sayfaya giden liste: fatura PDF'inden okunan KDV dahil fatura tutarı, ödenecek ve KDV eklenir (dönem boşsa PDF'teki dönem)
  async function listeTutarli() {
    await okunanYukle().catch(() => { });
    return (await liste()).map(k => {
      const o = k.faturaNo && OKUNAN.get(k.faturaNo);
      return o ? { ...k, tutar: o.faturaTutari, odenecek: o.odenecek, kdv: o.kdv, donem: k.donem || (/^\d{4}-\d{2}$/.test(o.donem || '') ? o.donem : '') } : k;
    });
  }

  async function yukle(q, veri) {
    const ad = String(q.get('ad') || 'belge').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 180) || 'belge';
    const uz = path.extname(ad).toLowerCase().slice(0, 10);
    const id = new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
    const klasor = KLASORLER.includes(q.get('klasor')) ? q.get('klasor') : 'belgeler';
    const kayit = {
      id, klasor, nesne: klasor + '/' + id + uz, ad, uzanti: uz, tur: turu(ad), boyut: veri.length, sha1: crypto.createHash('sha1').update(veri).digest('hex'),
      kategori: String(q.get('kategori') || 'Diğer').slice(0, 60), sozlesme: String(q.get('sozlesme') || '').slice(0, 20), lokasyon: String(q.get('lokasyon') || '').slice(0, 120),
      // Fatura numarası: elle verilmediyse dosya adından (panel dosya adları "…-CK22026000133857-…pdf")
      faturaNo: (String(q.get('faturaNo') || '').match(FATURA_NO) || ad.match(FATURA_NO) || [''])[0].toUpperCase(),
      donem: /^\d{4}-\d{2}$/.test(q.get('donem') || '') ? q.get('donem') : '', aciklama: String(q.get('aciklama') || '').slice(0, 500), yukleme: new Date().toISOString(),
    };
    zengin(kayit);
    await yaz(kayit.nesne, veri, kayit.tur);
    const l = await liste();
    const ayni = l.find(x => x.sha1 === kayit.sha1);
    l.unshift(kayit);
    await listeYaz(l);
    log('Belge Supabase’e yüklendi:', ad, (veri.length / 1024).toFixed(0) + ' KB', kayit.kategori);
    // Fatura PDF'i hemen okunur (arka planda; yüklemeyi bekletmez)
    if (kayit.faturaNo && uz === '.pdf') setImmediate(() => okunanYukle().then(() => pdfOku(kayit)).then(okunanYaz).catch(e => log('Yeni fatura PDF okunamadı:', e.message)));
    return { kayit, ayni: ayni ? ayni.ad : null };
  }
  async function dosya(id) {
    const k = (await liste()).find(x => x.id === id);
    if (!k) return null;
    const veri = await oku(nesneAdi(k));
    return veri ? { k, veri } : null;
  }
  async function sil(id) {
    const l = await liste(), k = l.find(x => x.id === id);
    if (!k) return false;
    if (k.otomatik) throw new Error('Bu fatura SECENGIDA klasöründen otomatik okundu; silmek için dosyayı klasörden kaldırın.');
    await kaldir(nesneAdi(k));
    await listeYaz(l.filter(x => x.id !== id));
    log('Belge silindi:', k.ad);
    return true;
  }
  async function guncelle(b) {
    const l = await liste(), k = l.find(x => x.id === b.id);
    if (!k) return false;
    for (const a of ['kategori', 'sozlesme', 'lokasyon', 'donem', 'aciklama', 'faturaNo']) if (b[a] !== undefined) k[a] = String(b[a]).slice(0, a === 'aciklama' ? 500 : 120);
    await listeYaz(l);
    return true;
  }

  const ham = req => new Promise((resolve, reject) => {
    const p = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > SINIR) { reject(new Error('Dosya 30 MB sınırını aşıyor.')); req.destroy(); } else p.push(c); });
    req.on('end', () => resolve(Buffer.concat(p))); req.on('error', reject);
  });
  const json = (res, kod, v) => { res.writeHead(kod, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(v)); };
  const jsonGovde = req => ham(req).then(b => { try { return JSON.parse(b.toString('utf8') || '{}'); } catch (e) { return {}; } });

  // İsteği bu modül karşıladıysa true döner
  async function yonet(req, res, url) {
    const p = url.pathname;
    if (!(p === '/belgeler' || p === '/referans' || p.startsWith('/api/belgeler') || p.startsWith('/belge/') || p.startsWith('/belge-gor/') || p.startsWith('/api/fatura-pdf') || p === '/pdf-serit.js')) return false;
    try {
      // Tablolardaki "fatura no → gerçek fatura" şeridinin ortak kodu (Fatura Kontrol ve GES Mahsup sayfaları)
      if (p === '/pdf-serit.js') { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(path.join(path.dirname(sayfa), 'pdf-serit.js'))); return true; }
      // Faturanın PDF'inden gerçek değerler (lib/elektrik_pdf_fatura.js); belge başına bir kez okunur, bellekte tutulur
      if (p === '/api/fatura-pdf/durum') { await okunanYukle(); json(res, 200, { ok: true, ...okumaDurumu, kayitli: OKUNAN.size }); return true; }
      if (p === '/api/fatura-pdf/hepsini-oku' && req.method === 'POST') {
        hepsiniOku(url.searchParams.get('yeniden') === '1').catch(e => { okumaDurumu.calisiyor = false; log('Toplu okuma hatası:', e.message); });
        await new Promise(r => setTimeout(r, 300));
        json(res, 200, { ok: true, ...okumaDurumu, kayitli: OKUNAN.size }); return true;
      }
      if (p === '/api/fatura-pdf') {
        const no = String(url.searchParams.get('faturaNo') || '').trim().toUpperCase();
        await okunanYukle();
        const k = no && (await liste()).find(x => x.faturaNo === no);
        if (!k) { json(res, 200, { ok: false, yok: true, hata: 'Bu faturanın PDF’i Belgeler › Faturalar klasöründe yok.' }); return true; }
        if (!OKUNAN.has(no)) { await pdfOku(k); okunanYaz().catch(() => { }); }
        json(res, 200, { ok: true, belge: { id: k.id, ad: k.ad }, ...OKUNAN.get(no) }); return true;
      }
      // Fatura görseli + sitenin o fatura için hesabı yan yana (public/belge-gor.html)
      if (p.startsWith('/belge-gor/')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(path.join(path.dirname(sayfa), 'belge-gor.html'))); return true; }
      // Referans sekmesi (public/referans.html): veri güncelleme, dönem özetleri, mahsup ve işaret açıklamaları
      if (p === '/referans') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(path.join(path.dirname(sayfa), 'referans.html'))); return true; }
      if (p === '/belgeler') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(sayfa)); return true; }
      if (p === '/api/belgeler' && req.method === 'GET') { if (!supa) { json(res, 200, { ok: false, supabase: false, hata: 'Supabase tanımlı değil.', belgeler: [] }); return true; } json(res, 200, { ok: true, supabase: true, yerel: !!YEREL, belgeler: await listeTutarli() }); return true; }
      if (p === '/api/belgeler/yukle' && req.method === 'POST') {
        const veri = await ham(req);
        if (!veri.length) { json(res, 400, { ok: false, hata: 'Dosya boş.' }); return true; }
        const r = await sirali(() => yukle(url.searchParams, veri));
        json(res, 200, { ok: true, ...r, belgeler: await listeTutarli() }); return true;
      }
      if (p === '/api/belgeler/sil' && req.method === 'POST') { const b = await jsonGovde(req); json(res, 200, { ok: await sirali(() => sil(b.id)), belgeler: await listeTutarli() }); return true; }
      if (p === '/api/belgeler/guncelle' && req.method === 'POST') { const b = await jsonGovde(req); json(res, 200, { ok: await sirali(() => guncelle(b)), belgeler: await listeTutarli() }); return true; }
      // Toplu eşleştirme: tüm belgelerde fatura no / sözleşme / lokasyon / dönem / kategori (yalnız boş alanlar + otomatik kategori)
      if (p === '/api/belgeler/esle' && req.method === 'POST') {
        const sonuc = await sirali(async () => {
          const l = await liste(); let degisen = 0;
          for (const k of l) { const once = JSON.stringify(k); zengin(k); if (JSON.stringify(k) !== once) degisen++; }
          if (degisen) await listeYaz(l);
          return { toplam: l.length, degisen, eslesen: l.filter(k => k.sozlesme).length };
        });
        json(res, 200, { ok: true, ...sonuc, belgeler: await listeTutarli() }); return true;
      }
      if (p.startsWith('/belge/')) {
        const d = await dosya(decodeURIComponent(p.split('/')[2] || ''));
        if (!d) { json(res, 404, { ok: false, hata: 'Belge bulunamadı.' }); return true; }
        const indir = url.searchParams.get('indir') === '1';
        res.writeHead(200, { 'Content-Type': d.k.tur, 'Content-Length': d.veri.length, 'Cache-Control': 'private, no-store', 'Content-Disposition': (indir ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(d.k.ad) });
        res.end(d.veri); return true;
      }
      return false;
    } catch (e) { log('Belgeler hata:', e.message); json(res, 500, { ok: false, hata: e.message }); return true; }
  }
  // okunanlar(): fatura no → PDF özeti (fatura kontrolü ve GES mahsubu bunu kullanır)
  return { yonet, supa, okunanlar: () => OKUNAN, okunanYukle, hepsiniOku, okumaDurumu };
}

module.exports = { belgeler };

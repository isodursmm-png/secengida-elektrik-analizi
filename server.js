// server.js — SECENGIDA ELEKTRİK ANALİZİ (port 5356)
//
// TAHTAKALE ELEKTRİK ANALİZİ'nin (port 5352, ELEKTRIK-ANALIZI-WEB) SECENGIDA kopyası. Farklar:
//  • Faturalar Elektrik Fatura Paneli yerine Masaüstü\SECENGIDA klasöründen okunur (zip / PDF, lib/secengida_kaynak.js):
//    CK Akdeniz abonelikleri, Antalya OSB fabrika faturaları, ANT Trafo hizmet faturaları.
//  • Ortak piyasa verisi (EPİAŞ hesabı, saatlik PTF, YEKDEM, EPDK tarifeleri, gider tablosu, PVGIS) 5352 ortamının
//    dosyalarından (Desktop\CLAUDE) alınır, eksikler bu sunucu tarafından tamamlanır.
//  • 🏭 AOSB Fabrika sekmesi: OSB faturalarının sağlaması, geçici ↔ kesin birim fiyat, GES veriş ↔ mahsup tetkiki.
//
// Otonom, canlı veriye dayalı elektrik fiyat analizi:
//  • Saatlik PTF (Piyasa Takas Fiyatı) EPİAŞ Şeffaflık Platformu API'sinden çekilir. Sunucu her saat
//    içinde bulunulan ayı (yarın dahil — gün öncesi fiyatlar ~14:00'te açıklanır) kendisi yeniler,
//    eksik geçmiş ayları tamamlar. Tamamlanmış aylar önbellekte kalır, tekrar sorgulanmaz.
//  • EPDK tarife tabloları (vergiler hariç, resmi Excel) elektrik_tarifeler\ klasöründen okunur.
//    Sunucu günde bir kez MEDAŞ "EPDK Kurul Kararları - Ulusal Tarifeler" arşivini tarar; yeni bir
//    "... itibaren geçerli" tablosu yayımlanmışsa indirip otomatik devreye alır.
//  • EPİAŞ kullanıcı adı/şifresi sadece bu bilgisayarda elektrik_analizi_ayar.json içinde tutulur.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// ─── Yapılandırma (ortam değişkenleri · .env.example'a bakın) ───────────────────────────────────
// Masaüstünde hiçbiri gerekmez; Render'da DATA_DIR, APP_KULLANICI/APP_SIFRE, EPIAS_* ve SENKRON_ANAHTARI verilir.
(() => { try { for (const satir of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(satir); if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) { } })();
// Gün/ay anahtarları Türkiye saatine göre (Render sunucusu UTC çalışır)
process.env.TZ = process.env.TZ || 'Europe/Istanbul';
const VERI = process.env.DATA_DIR || path.join(__dirname, 'veri');
fs.mkdirSync(VERI, { recursive: true });
const BULUT = !!process.env.RENDER || process.env.BULUT === '1';

const PORT = process.env.PORT || 5356;
const UYGULAMA = 'SECENGIDA ELEKTRİK ANALİZİ';
const AYAR_DOSYASI = path.join(VERI, 'elektrik_analizi_ayar.json');
const PTF_DOSYASI = path.join(VERI, 'elektrik_analizi_ptf.json');
const TARIFE_KLASORU = path.join(VERI, 'tarifeler');
// İlk açılışta depodaki EPDK tarife tabloları veri klasörüne kopyalanır; yenileri sunucu kendisi indirir
fs.mkdirSync(TARIFE_KLASORU, { recursive: true });
for (const f of fs.readdirSync(path.join(__dirname, 'tarifeler'))) if (!fs.existsSync(path.join(TARIFE_KLASORU, f))) fs.copyFileSync(path.join(__dirname, 'tarifeler', f), path.join(TARIFE_KLASORU, f));
const HTML_DOSYASI = path.join(__dirname, 'public', 'index.html');
const MEDAS_URL = 'https://www.meramedas.com.tr/tr/epdk-kurul-kararlari-ulusal-tarifeler.html';
const PENCERE_AY = 12;

if (!fs.existsSync(TARIFE_KLASORU)) fs.mkdirSync(TARIFE_KLASORU);

// ─── Ortak veri: TAHTAKALE ELEKTRİK ANALİZİ ortamının (5352) dosyaları ────────────────────────────────
// Desktop\CLAUDE\elektrik_analizi_ptf.json, elektrik_yekdem.json, elektrik_analizi_ayar.json (EPİAŞ hesabı),
// elektrik_tarifeler\*.xlsx, elektrik_analizi_gunes.json, elektrik_analizi_bedeller.json. Yerelde eksik olan
// eklenir (yerel değer ezilmez; yalnızca eksik saatler ve daha yeni YEKDEM versiyonu alınır).
const ORTAK_KLASOR = process.env.ORTAK_KLASOR || path.join(__dirname, '..');
const ortakDurum = { son: null, ptfGun: 0, yekdemAy: 0, tarife: 0, hata: null };
function ortakVeriAl() {
  try {
    const oj = f => jsonOku(path.join(ORTAK_KLASOR, f), null);
    let ptfGun = 0, yekdemAy = 0, tarife = 0;
    const optf = oj('elektrik_analizi_ptf.json');
    if (optf) {
      const p = jsonOku(PTF_DOSYASI, {});
      for (const [g, sa] of Object.entries(optf)) {
        const y = p[g];
        if (!y) { p[g] = sa; ptfGun++; continue; }
        let d = false; sa.forEach((v, h) => { if (y[h] == null && v != null) { y[h] = v; d = true; } }); if (d) ptfGun++;
      }
      if (ptfGun) jsonYaz(PTF_DOSYASI, p);
    }
    const oy = oj('elektrik_yekdem.json');
    if (oy) {
      const Y = jsonOku(path.join(VERI, 'elektrik_yekdem.json'), {});
      for (const [a, v] of Object.entries(oy)) if (!Y[a] || String(v.versiyon) > String(Y[a].versiyon)) { Y[a] = v; yekdemAy++; }
      if (yekdemAy) jsonYaz(path.join(VERI, 'elektrik_yekdem.json'), Y);
    }
    const oa = oj('elektrik_analizi_ayar.json'), a = jsonOku(AYAR_DOSYASI, {});
    if (oa && oa.kullanici && oa.sifre && !(a.kullanici && a.sifre)) jsonYaz(AYAR_DOSYASI, { ...a, kullanici: oa.kullanici, sifre: oa.sifre });
    const otk = path.join(ORTAK_KLASOR, 'elektrik_tarifeler');
    if (fs.existsSync(otk)) for (const x of fs.readdirSync(otk).filter(x => /^tarife_\d{4}-\d{2}-\d{2}\.xlsx$/i.test(x))) if (!fs.existsSync(path.join(TARIFE_KLASORU, x))) { fs.copyFileSync(path.join(otk, x), path.join(TARIFE_KLASORU, x)); tarife++; }
    for (const x of ['elektrik_analizi_gunes.json', 'elektrik_analizi_bedeller.json']) { const o = path.join(ORTAK_KLASOR, x), y = path.join(VERI, x); if (fs.existsSync(o) && (!fs.existsSync(y) || fs.statSync(o).mtimeMs > fs.statSync(y).mtimeMs)) fs.copyFileSync(o, y); }
    Object.assign(ortakDurum, { son: new Date().toISOString(), ptfGun, yekdemAy, tarife, hata: null });
    if (ptfGun || yekdemAy || tarife) log('Ortak veri (5352) alındı: PTF', ptfGun, 'gün · YEKDEM', yekdemAy, 'ay · tarife', tarife);
    if (tarife && tarifeler.length) tarifeleriYukle();
  } catch (e) { ortakDurum.hata = e.message; log('Ortak veri alınamadı:', e.message); }
}

const durum = {
  ptfSonGuncelleme: null, ptfHata: null, ptfCalisiyor: false,
  tarifeSonKontrol: null, tarifeHata: null, tarifeYeniBulunan: null,
};

function jsonOku(f, vars) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return vars; } }
function jsonYaz(f, v) { fs.writeFileSync(f, JSON.stringify(v), 'utf8'); }
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ─── HTTP yardımcıları ──────────────────────────────────────────────────────────────────────────
function istek(url, { method = 'GET', headers = {}, body = null, ikili = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, timeout: 60000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(istek(new URL(res.headers.location, url).href, { method, headers, body, ikili }));
      }
      const parcalar = [];
      res.on('data', c => parcalar.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parcalar);
        resolve({ status: res.statusCode, headers: res.headers, body: ikili ? buf : buf.toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Zaman aşımı: ' + url)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── EPİAŞ: TGT + saatlik PTF ───────────────────────────────────────────────────────────────────
const ayarOku = () => ({ ...jsonOku(AYAR_DOSYASI, {}), ...(process.env.EPIAS_KULLANICI ? { kullanici: process.env.EPIAS_KULLANICI, sifre: process.env.EPIAS_SIFRE || '' } : {}) });
let tgt = null, tgtZaman = 0;
async function tgtAl() {
  if (tgt && Date.now() - tgtZaman < 90 * 60 * 1000) return tgt;
  const ayar = ayarOku();
  if (!ayar.kullanici || !ayar.sifre) throw new Error('EPİAŞ kullanıcı adı/şifresi girilmemiş (EPİAŞ Ayarları).');
  const body = 'username=' + encodeURIComponent(ayar.kullanici) + '&password=' + encodeURIComponent(ayar.sifre);
  const r = await istek('https://giris.epias.com.tr/cas/v1/tickets', {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/plain', 'Content-Length': Buffer.byteLength(body) },
  });
  const t = (r.body || '').trim();
  if (r.status !== 201 && r.status !== 200 || !/^TGT-/.test(t)) throw new Error('EPİAŞ girişi başarısız (HTTP ' + r.status + '). Kullanıcı adı/şifreyi kontrol edin.');
  tgt = t; tgtZaman = Date.now();
  return tgt;
}

const ikiHane = n => String(n).padStart(2, '0');
const ayAnahtari = d => d.getFullYear() + '-' + ikiHane(d.getMonth() + 1);
const gunAnahtari = d => ayAnahtari(d) + '-' + ikiHane(d.getDate());
const ayGunSayisi = (y, m) => new Date(y, m, 0).getDate(); // m: 1..12

function pencereAylari() {
  const simdi = new Date();
  const aylar = [];
  for (let i = PENCERE_AY - 1; i >= 0; i--) aylar.push(ayAnahtari(new Date(simdi.getFullYear(), simdi.getMonth() - i, 1)));
  return aylar;
}

async function ptfCek(bas, bit) {
  const body = JSON.stringify({ startDate: bas + 'T00:00:00+03:00', endDate: bit + 'T23:00:00+03:00' });
  let r;
  for (let deneme = 0; deneme < 2; deneme++) {
    const t = await tgtAl();
    r = await istek('https://seffaflik.epias.com.tr/electricity-service/v1/markets/dam/data/mcp', {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'TGT': t, 'Content-Length': Buffer.byteLength(body) },
    });
    if (r.status === 401 || r.status === 403) { tgt = null; continue; }
    break;
  }
  if (r.status !== 200) throw new Error('EPİAŞ PTF servisi HTTP ' + r.status + ': ' + String(r.body).slice(0, 200));
  const j = JSON.parse(r.body);
  const items = (j.items || (j.body && j.body.items) || []);
  const sonuc = {};
  for (const it of items) {
    // date: "2026-09-01T05:00:00+03:00" — yerel saat metnin içinde, saat dilimi dönüşümü yapmadan oku
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})/.exec(it.date || '');
    if (!m) continue;
    (sonuc[m[1]] = sonuc[m[1]] || new Array(24).fill(null))[+m[2]] = Number(it.price);
  }
  return sonuc;
}

async function ptfGuncelle() {
  if (durum.ptfCalisiyor) return;
  ortakVeriAl();
  durum.ptfCalisiyor = true;
  try {
    const ptf = jsonOku(PTF_DOSYASI, {});
    const simdi = new Date();
    const buAy = ayAnahtari(simdi);
    const yarin = new Date(simdi.getFullYear(), simdi.getMonth(), simdi.getDate() + 1);
    for (const ay of pencereAylari()) {
      const [y, m] = ay.split('-').map(Number);
      const gs = ayGunSayisi(y, m);
      const eksiksiz = () => { for (let g = 1; g <= gs; g++) { const s = ptf[ay + '-' + ikiHane(g)]; if (!s || s.some(v => v === null)) return false; } return true; };
      if (ay !== buAy && eksiksiz()) continue;
      // Bu ay: EPİAŞ bugünün tamamını da saat 14'ten önce HTTP 400 (SEF1124) ile reddedebiliyor.
      // Ana sorgu dünde biter; bugün ve yarın ayrı ayrı denenir (açıklanmadıysa sessizce geçilir).
      const dun = new Date(simdi.getFullYear(), simdi.getMonth(), simdi.getDate() - 1);
      const veri = ay !== buAy ? await ptfCek(ay + '-01', ay + '-' + ikiHane(gs)) : simdi.getDate() > 1 ? await ptfCek(ay + '-01', gunAnahtari(dun)) : {};
      Object.assign(ptf, veri);
      if (ay === buAy) {
        for (const g of [simdi, yarin]) { try { Object.assign(ptf, await ptfCek(gunAnahtari(g), gunAnahtari(g))); } catch (e) { /* henüz açıklanmadı */ } }
      }
      log('PTF güncellendi:', ay, Object.keys(veri).length, 'gün');
    }
    jsonYaz(PTF_DOSYASI, ptf);
    durum.ptfSonGuncelleme = new Date().toISOString();
    durum.ptfHata = null;
  } catch (e) {
    durum.ptfHata = e.message;
    log('PTF hata:', e.message);
  } finally {
    durum.ptfCalisiyor = false;
  }
}

// ─── EPDK tarife tabloları ──────────────────────────────────────────────────────────────────────
const AYLAR_TR = { ocak: 1, şubat: 2, subat: 2, mart: 3, nisan: 4, mayıs: 5, mayis: 5, haziran: 6, temmuz: 7, ağustos: 8, agustos: 8, eylül: 9, eylul: 9, ekim: 10, kasım: 11, kasim: 11, aralık: 12, aralik: 12 };
function trTarih(metin) {
  const m = /(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})/.exec(metin || '');
  if (!m) return null;
  const ay = AYLAR_TR[m[2].toLocaleLowerCase('tr-TR')];
  return ay ? m[3] + '-' + ikiHane(ay) + '-' + ikiHane(+m[1]) : null;
}

// Ticarethane ("Kamu ve Özel Hizmetler Sektörü ile Diğer") satırlarını çözer. İki farklı EPDK
// Excel formatı (2025: "Faaliyet Bazlı" sayfası, 2026: tek sayfa) aynı sıra ile gelir:
// [tek zamanlı, gündüz, puant, gece, dağıtım]. Bölüm (OG çift / OG tek / AG) etiket satırlarından izlenir.
function tarifeCoz(dosya) {
  const wb = XLSX.readFile(dosya);
  const t = { gecerlilik: null, dosya: path.basename(dosya), OGC: null, OGT: null, AG: null, AG_dusuk: null, LU1: null, LU2: null };
  for (const ad of wb.SheetNames) {
    const satirlar = XLSX.utils.sheet_to_json(wb.Sheets[ad], { header: 1, raw: true, defval: null });
    // Reaktif bedel sütunu yalnızca "kVArh/Reaktif" başlığı olan sayfalarda var; ticarethane satırının son sayısıdır
    const reaktifSayfasi = satirlar.some(s => s.some(v => typeof v === 'string' && /kvarh|reaktif/i.test(v)));
    let bolum = null, alcak = false;
    for (const s of satirlar) {
      const metinler = s.filter(v => typeof v === 'string').map(v => v.trim());
      const sayilar = s.filter(v => typeof v === 'number');
      if (!t.gecerlilik) for (const mt of metinler) { if (/[İi]tibaren/i.test(mt)) { t.gecerlilik = trTarih(mt); if (t.gecerlilik) break; } }
      for (const mt of metinler) {
        if (/alçak gerilim|^AG\b/i.test(mt)) alcak = true;
        if (/orta gerilim|^OG\b/i.test(mt)) alcak = false;
        if (/üretici/i.test(mt) && !/lisanssız/i.test(mt)) bolum = null;
        if (/çift terim/i.test(mt)) bolum = alcak ? null : 'OGC';
        else if (/tek terim/i.test(mt) && !/üretici/i.test(mt)) bolum = alcak ? 'AG' : 'OGT';
      }
      const lu = metinler.find(mt => /lisanssız üretici[\s-]*[12]\b/i.test(mt));
      if (lu && sayilar.length) {
        const k = /[\s-]*1\b/.test(lu.replace(/.*üretici/i, '')) ? 'LU1' : 'LU2';
        if (t[k] === null) t[k] = sayilar[0];
      }
      const kamu = metinler.find(mt => /kamu ve özel hizmetler/i.test(mt));
      // OG çift terim güç bedeli (kr/kW/ay): satırdaki 1000'den büyük ilk sayı (enerji/dağıtım bedelleri hep daha küçük)
      if (kamu && bolum === 'OGC' && t.gucBedeli == null) { const g = sayilar.find(x => x > 1000); if (g) t.gucBedeli = g; }
      if (kamu && bolum === 'OGT' && reaktifSayfasi && t.reaktif == null && sayilar.length >= 2) {
        const son = sayilar[sayilar.length - 1];
        if (son > 1 && son < 1000) t.reaktif = son;
      }
      if (kamu && bolum && sayilar.length >= 5) {
        const k = bolum === 'AG' && /ve altı/i.test(kamu) ? 'AG_dusuk' : bolum;
        if (!t[k]) t[k] = { tek: sayilar[0], gunduz: sayilar[1], puant: sayilar[2], gece: sayilar[3], dagitim: sayilar[4] };
      }
    }
  }
  const makul = v => v && [v.tek, v.gunduz, v.puant, v.gece, v.dagitim].every(x => x > 1 && x < 5000);
  if (!t.gecerlilik) { const fm = /(\d{4}-\d{2}-\d{2})/.exec(path.basename(dosya)); if (fm) t.gecerlilik = fm[1]; }
  if (!t.gecerlilik || !makul(t.AG) || !makul(t.OGT) || !makul(t.OGC)) throw new Error('Tarife tablosu çözülemedi: ' + path.basename(dosya));
  if (!t.AG_dusuk) t.AG_dusuk = t.AG;
  return t;
}

let tarifeler = [];
function tarifeleriYukle() {
  const liste = [];
  for (const f of fs.readdirSync(TARIFE_KLASORU).filter(f => /\.xlsx$/i.test(f))) {
    try { liste.push(tarifeCoz(path.join(TARIFE_KLASORU, f))); } catch (e) { log(e.message); }
  }
  liste.sort((a, b) => a.gecerlilik.localeCompare(b.gecerlilik));
  tarifeler = liste.filter((t, i) => i === 0 || t.gecerlilik !== liste[i - 1].gecerlilik);
  log('Tarife tabloları:', tarifeler.map(t => t.gecerlilik).join(', '));
}

async function tarifeKontrol() {
  try {
    const r = await istek(MEDAS_URL);
    if (r.status !== 200) throw new Error('MEDAŞ arşivi HTTP ' + r.status);
    const html = r.body;
    const re = /href="([^"]+\.xlsx)"/gi;
    let m, yeni = 0;
    const mevcut = new Set(tarifeler.map(t => t.gecerlilik));
    const enYeni = tarifeler.length ? tarifeler[tarifeler.length - 1].gecerlilik : '0000';
    while ((m = re.exec(html))) {
      const onceki = html.slice(Math.max(0, m.index - 400), m.index).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const parca = onceki.split(/İndir/).pop();
      const tarih = trTarih(parca);
      if (!tarih || tarih <= enYeni || mevcut.has(tarih)) continue;
      const url = new URL(m[1], 'https://www.meramedas.com.tr/').href;
      const d = await istek(url, { ikili: true });
      if (d.status !== 200 || d.body.slice(0, 2).toString() !== 'PK') continue;
      const hedef = path.join(TARIFE_KLASORU, 'tarife_' + tarih + '.xlsx');
      fs.writeFileSync(hedef, d.body);
      try { tarifeCoz(hedef); yeni++; durum.tarifeYeniBulunan = tarih; log('Yeni EPDK tarifesi indirildi:', tarih); }
      catch (e) { fs.unlinkSync(hedef); log(e.message); }
    }
    if (yeni) tarifeleriYukle();
    durum.tarifeSonKontrol = new Date().toISOString();
    durum.tarifeHata = null;
  } catch (e) {
    durum.tarifeHata = e.message;
    log('Tarife kontrol hata:', e.message);
  }
}

// ─── Güneş profili: PVGIS (AB JRC) — Akdeniz Bölgesi ───────────────────────────────────────────
// DRcalc: 2005-2023 ortalaması, ay × saat ışınım (W/m², 30° eğim, güney). PVcalc: 1 kWp aylık üretim.
// PVGIS "localtime" UTC+2 döndürüyor; bu yüzden UTC alınır, Türkiye saatine (UTC+3) burada çevrilir.
// İklim ortalaması değişmediği için şehir başına bir kez çekilip kalıcı önbelleğe alınır.
const GUNES_DOSYASI = path.join(VERI, 'elektrik_analizi_gunes.json');
const SEHIRLER = {
  'Antalya': [36.89, 30.71], 'Alanya': [36.54, 32.00], 'Mersin': [36.80, 34.63], 'Adana': [37.00, 35.32],
  'Hatay': [36.20, 36.16], 'Osmaniye': [37.07, 36.25], 'Kahramanmaraş': [37.58, 36.94],
  'Isparta': [37.76, 30.55], 'Burdur': [37.72, 30.29],
};
const gunesIstekte = {};
async function gunesGetir(sehir) {
  const onbellek = jsonOku(GUNES_DOSYASI, {});
  if (onbellek[sehir]) return onbellek[sehir];
  if (gunesIstekte[sehir]) return gunesIstekte[sehir];
  const [lat, lon] = SEHIRLER[sehir];
  gunesIstekte[sehir] = (async () => {
    const q = 'lat=' + lat + '&lon=' + lon + '&angle=30&aspect=0&outputformat=json';
    const dr = await istek('https://re.jrc.ec.europa.eu/api/v5_3/DRcalc?' + q + '&month=0&global=1&localtime=0');
    const pv = await istek('https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?' + q + '&peakpower=1&loss=14');
    if (dr.status !== 200 || pv.status !== 200) throw new Error('PVGIS HTTP ' + dr.status + '/' + pv.status);
    const utc = Array.from({ length: 12 }, () => new Array(24).fill(0));
    for (const x of JSON.parse(dr.body).outputs.daily_profile) utc[x.month - 1][+x.time.slice(0, 2)] = x['G(i)'];
    // TSİ saat dilimi H..H+1 ≈ UTC (H-3) ve (H-2) anlık değerlerinin ortalaması
    const tsi = utc.map(s => Array.from({ length: 24 }, (_, h) => (s[(h + 21) % 24] + s[(h + 22) % 24]) / 2));
    const pvj = JSON.parse(pv.body).outputs;
    const kayit = {
      sehir, lat, lon, kaynak: 'PVGIS 5.3 (SARAH3, 2005-2023), 30° eğim, güney, %14 kayıp',
      isinim: tsi.map(s => s.map(v => +v.toFixed(2))),
      aylikUretim: pvj.monthly.fixed.map(m => m.E_m), yillikUretim: pvj.totals.fixed.E_y,
      alinma: new Date().toISOString(),
    };
    const o = jsonOku(GUNES_DOSYASI, {}); o[sehir] = kayit; jsonYaz(GUNES_DOSYASI, o);
    log('PVGIS güneş profili alındı:', sehir, kayit.yillikUretim, 'kWh/kWp');
    return kayit;
  })();
  try { return await gunesIstekte[sehir]; } finally { delete gunesIstekte[sehir]; }
}
async function tumGunesleriTamamla() {
  for (const s of Object.keys(SEHIRLER)) { try { await gunesGetir(s); } catch (e) { log('PVGIS hata:', s, e.message); } }
}

// ─── Gider tanım tablosu: vergi, harç, bağlantı/katılım ve tüm işlem bedelleri ──────────────────
// EPDK "Nihai Kullanıcılara Uygulanan Diğer Bedeller" listesi JSON uçtan (/Detay/GetFastAccessList)
// okunur; her başlığın en güncel ve bir önceki kurul kararı (.docx) indirilip tabloları çözülür.
// Vergi oranları 2464 sayılı Kanun metninden (mevzuat.gov.tr) okunur. Günde bir kez yenilenir.
const BEDEL_DOSYASI = path.join(VERI, 'elektrik_analizi_bedeller.json');
const BEDEL_KLASORU = path.join(VERI, 'elektrik_bedeller');
if (!fs.existsSync(BEDEL_KLASORU)) fs.mkdirSync(BEDEL_KLASORU);
const EPDK_BEDEL_KAYNAKLARI = [
  { fId: 1331, kategori: 'Abonelik ve tüketici işlemleri', uygulama: 'Tüketim' },   // güvence
  { fId: 1850, kategori: 'Abonelik ve tüketici işlemleri', uygulama: 'Tüketim' },   // kesme-bağlama
  { fId: 7528, kategori: 'Abonelik ve tüketici işlemleri', uygulama: 'Tüketim' },   // sayaç kontrol
  { fId: 1855, kategori: 'Abonelik ve tüketici işlemleri', uygulama: 'Tüketim' },   // ödeme bildirimi
  { fId: 1851, kategori: 'Bağlantı / katılım bedelleri', uygulama: 'Tüketim + GES' }, // dağıtım bağlantı bedeli
  { fId: 1853, kategori: 'GES · lisanssız üretim bedelleri', uygulama: 'GES', coklu: true },
  { fId: 21218, kategori: 'GES · proje onay ve kabul', uygulama: 'GES (çatı ≤50 kW)' },
  { fId: 23583, kategori: 'GES · proje onay ve kabul', uygulama: 'GES' },
  { fId: 1854, kategori: 'Ölçüm ve veri hizmetleri', uygulama: 'Tüketim + GES' },
  { fId: 15836, kategori: 'Ölçüm ve veri hizmetleri', uygulama: 'Tüketim + GES' },
  { fId: 1856, kategori: 'Referans fiyatlar', uygulama: 'GES', paragraf: /([\d.]+,\d+)\s*kr\/kWh/ }, // TORETOSAF
];

function docxCoz(buf) {
  const z = XLSX.CFB.read(buf, { type: 'buffer' });
  const i = z.FullPaths.findIndex(p => p.endsWith('word/document.xml'));
  const xml = Buffer.from(z.FileIndex[i].content).toString('utf8');
  const metin = s => (s.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const tablolar = (xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || []).map(tb =>
    (tb.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || []).map(tr => (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(metin)));
  const paragraflar = (xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, '').match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).map(metin).filter(Boolean);
  return { tablolar, paragraflar };
}
const trSayi = s => { const t = String(s).trim(); return /^-?[\d.]+(,\d+)?$/.test(t) ? Number(t.replace(/\./g, '').replace(',', '.')) : NaN; };

// Kurul kararı tablolarını "kalem / değer / birim" satırlarına çevirir. Tablolar tek hücreli başlık,
// yıl satırı, "Bedel (TL/kW)" gibi birim başlığı, " | AG | OG" sütun başlıkları, boş değerli grup
// satırları (ör. "0-15 kW (dahil)") ve iki çiftli satırlar (proje onay | bedel | kabul | bedel) içerebilir.
function kalemleriCikar(tablolar) {
  const kalemler = [];
  for (const t of tablolar) {
    let bolum = '', grup = '', birim = '', sutunlar = null;
    for (const r of t) {
      const dolu = r.filter(c => c !== '');
      if (!dolu.length) continue;
      if (r.length === 1 || dolu.length === 1 && r.length > 1 && !r.slice(1).some(Boolean) && !birim) {
        if (!/^\d{4}$/.test(dolu[0])) { bolum = dolu[0]; grup = ''; }
        continue;
      }
      const birimHucre = r.find(c => /\((TL|kr)[^)]*\)/i.test(c));
      if (birimHucre && r.every(c => c === '' || /^\d{4}$/.test(c) || /bedel|grup|türü|seviyesi|aralığı|sınıfı|kapsamı/i.test(c))) {
        birim = (birimHucre.match(/\(([^)]*)\)/) || [])[1] || '';
        sutunlar = null;
        continue;
      }
      if (r[0] === '' && r.slice(1).every(c => c && isNaN(trSayi(c)))) { sutunlar = r.slice(1); continue; }
      if (r.length === 4 && isNaN(trSayi(r[0])) && isNaN(trSayi(r[2])) && r[1] !== '' && r[3] !== '') {
        for (const [e, v] of [[r[0], r[1]], [r[2], r[3]]]) {
          const n = trSayi(v);
          kalemler.push({ bolum, kalem: e, deger: isNaN(n) ? null : n, formul: isNaN(n) ? v : null, birim });
        }
        continue;
      }
      const etiket = r[0], degerler = r.slice(1);
      if (degerler.every(c => c === '')) { grup = etiket; continue; }
      degerler.forEach((v, j) => {
        if (v === '') return;
        const n = trSayi(v);
        const ad = [grup, etiket, sutunlar && sutunlar[j]].filter(Boolean).join(' · ');
        kalemler.push({ bolum, kalem: ad, deger: isNaN(n) ? null : n, formul: isNaN(n) ? v : null, birim });
      });
    }
  }
  return kalemler;
}

async function epdkListe(fId) {
  const body = JSON.stringify({ fId: String(fId) });
  const r = await istek('https://www.epdk.gov.tr/Detay/GetFastAccessList', {
    method: 'POST', body, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
  });
  if (r.status !== 200) throw new Error('EPDK liste ' + fId + ' HTTP ' + r.status);
  return JSON.parse(r.body).model || [];
}
async function epdkBelge(contentId) {
  const dosya = path.join(BEDEL_KLASORU, contentId.replace(/[^A-Za-z0-9]/g, '_') + '.docx');
  if (fs.existsSync(dosya)) return fs.readFileSync(dosya);
  const d = await istek('https://www.epdk.gov.tr/Detay/DownloadDocument?id=' + encodeURIComponent(contentId), { ikili: true });
  if (d.status !== 200 || d.body.slice(0, 2).toString() !== 'PK') throw new Error('EPDK belge indirilemedi: ' + contentId);
  fs.writeFileSync(dosya, d.body);
  return d.body;
}

// 2464 s. Kanun m.37-38: ETV matrahı ve oranları (mevzuat.gov.tr metninden)
async function etvOku() {
  const r = await istek('https://www.mevzuat.gov.tr/anasayfa/MevzuatFihristDetayIframe?MevzuatTur=1&MevzuatNo=2464&MevzuatTertip=5');
  if (r.status !== 200) throw new Error('mevzuat.gov.tr HTTP ' + r.status);
  const s = r.body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (a, b) => String.fromCharCode(b)).replace(/\s+/g, ' ');
  const m38 = s.slice(s.search(/Madde 38 –/), s.search(/Madde 39 –/));
  const m37 = s.slice(s.search(/Madde 37 –/), s.search(/Madde 38 –/));
  const imal = /istihsal[^.]*?yüzde (\d+(?:,\d+)?)/i.exec(m38), diger = /bendi dışında[^.]*?yüzde (\d+(?:,\d+)?)/i.exec(m38);
  if (!imal || !diger) throw new Error('2464 m.38 oranları metinden okunamadı');
  return { imal: trSayi(imal[1]), diger: trSayi(diger[1]), matrahHaricDagitim: /dağıtım/i.test(m37) && /hariç/i.test(m37), m38: m38.slice(0, 400) };
}

// 492 s. Harçlar Kanunu (4) sayılı tarife — tapu ve kadastro harçları. mevzuat.gov.tr metninde güncel
// oran/tutar parantez içinde, kanunun ilk hali parantez dışında yazılıdır: "(Binde 20) Binde 10".
async function tapuOku() {
  const r = await istek('https://www.mevzuat.gov.tr/anasayfa/MevzuatFihristDetayIframe?MevzuatTur=1&MevzuatNo=492&MevzuatTertip=5');
  if (r.status !== 200) throw new Error('mevzuat.gov.tr 492 HTTP ' + r.status);
  const s = r.body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (a, b) => String.fromCharCode(b)).replace(/\s+/g, ' ');
  const t4 = s.slice(s.search(/\(4\) SAYILI TAR[İI]FE/i));
  const oku = (anahtar, tip) => {
    const i = t4.indexOf(anahtar);
    if (i < 0) return null;
    const m = (tip === 'binde' ? /\(Binde ([\d.,]+)\)/ : /\(([\d.,]+) TL\.?\)/).exec(t4.slice(i, i + 3000));
    return m ? trSayi(m[1]) : null;
  };
  const kalemler = [
    { kalem: 'Tapu harcı · gayrimenkul satışı (alıcı ve satıcı için ayrı ayrı)', deger: oku('zilyetlik devir sözleşmeleri yapılmadan', 'binde'), birim: 'binde', dayanak: '492 s. Harçlar Kanunu (4) sayılı tarife, 20/a' },
    { kalem: 'Tapu harcı · gayrimenkul üzerine irtifak hakkı tesisi ve devri (devir alan)', deger: oku('Gayrimenkul üzerine irtifak hakkı tesis ve devrinde', 'binde'), birim: 'binde', dayanak: '492 s. Harçlar Kanunu (4) sayılı tarife, 20/e' },
    { kalem: 'Tapu harcı · arsa/arazi üzerine inşa edilen bina ve tesis tescili (her bağımsız bölüm/tesis)', deger: oku('Arsa ve arazi üzerine inşa olunacak bina vesair tesislerin tescilinde', 'tl'), birim: 'TL', dayanak: '492 s. Harçlar Kanunu (4) sayılı tarife, 13/a' },
    { kalem: 'Tapu harcı · cins ve kayıt tashihi (her işlem)', deger: oku('(a) fıkrası dışında kalan her nevi cins ve kayıt tashihinde', 'tl'), birim: 'TL', dayanak: '492 s. Harçlar Kanunu (4) sayılı tarife, 13/c' },
    { kalem: 'Tapu harcı · tescil ve şerhlerin terkini', deger: oku('tescil ve şerhlerin terkininden', 'tl'), birim: 'TL', dayanak: '492 s. Harçlar Kanunu (4) sayılı tarife, 14' },
  ];
  if (kalemler.filter(k => k.deger != null).length < 3) throw new Error('492 (4) sayılı tarife metinden okunamadı');
  return { kalemler, okunma: new Date().toISOString() };
}

let bedelCalisiyor = false;
async function bedelleriGuncelle() {
  if (bedelCalisiyor) return;
  bedelCalisiyor = true;
  const eski = jsonOku(BEDEL_DOSYASI, {});
  const sonuc = { kaynaklar: [], hatalar: [], sonKontrol: new Date().toISOString(), etv: eski.etv || null, tapu: eski.tapu || null };
  try {
    for (const k of EPDK_BEDEL_KAYNAKLARI) {
      try {
        const liste = await epdkListe(k.fId);
        const tarihler = [...new Set(liste.map(x => x.Date))]; // liste yeniden eskiye sıralı gelir
        const secim = (tarih) => liste.filter(x => x.Date === tarih).slice(0, k.coklu ? 10 : 1);
        const [guncel, onceki] = [secim(tarihler[0]), tarihler[1] ? secim(tarihler[1]) : []];
        const coz = async (kayit) => {
          const d = (kayit.FastAccessDetail || [])[0];
          if (!d) return { kalemler: [], paragraflar: [] };
          const { tablolar, paragraflar } = docxCoz(await epdkBelge(d.ContentId));
          let kalemler = kalemleriCikar(tablolar);
          if (k.paragraf) {
            const m = k.paragraf.exec(paragraflar.join(' '));
            const yil = (kayit.Title.match(/(\d{4}) yılı/) || [])[1];
            if (m) kalemler = [{ bolum: '', kalem: 'TORETOSAF · Türkiye ortalama elektrik toptan satış fiyatı' + (yil ? ' (' + yil + ' yılı)' : ''), anahtar: 'TORETOSAF', deger: trSayi(m[1]), formul: null, birim: 'kr/kWh' }];
          }
          return { kalemler, paragraflar, contentId: d.ContentId };
        };
        const oncekiKalemler = {};
        const anahtar = x => x.anahtar || (x.bolum + '|' + x.kalem);
        for (const kayit of onceki) for (const x of (await coz(kayit)).kalemler) oncekiKalemler[anahtar(x)] = x.deger;
        for (const kayit of guncel) {
          const c = await coz(kayit);
          const kararNo = (c.paragraflar.join(' ').match(/Karar No:\s*([\d/-]+)/) || [])[1] || kayit.Number;
          const aciklama = c.paragraflar.filter(p => /hesaplan|uygulan|ilave|dahil|hariç/i.test(p) && !/Karar No/.test(p) && p.length < 600).slice(0, 4);
          sonuc.kaynaklar.push({
            fId: k.fId, kategori: k.kategori, uygulama: k.uygulama, baslik: kayit.Title.trim(),
            kararNo, kararTarihi: kayit.Date, rgTarih: kayit.RgDate, rgSayi: kayit.RgNumber,
            belgeUrl: c.contentId ? 'https://www.epdk.gov.tr/Detay/DownloadDocument?id=' + encodeURIComponent(c.contentId) : null,
            aciklama,
            kalemler: c.kalemler.map(x => ({ ...x, onceki: oncekiKalemler[anahtar(x)] ?? null })),
          });
        }
      } catch (e) { sonuc.hatalar.push('EPDK ' + k.fId + ': ' + e.message); }
    }
    try { sonuc.etv = { ...(await etvOku()), okunma: new Date().toISOString() }; }
    catch (e) { sonuc.hatalar.push('ETV: ' + e.message); }
    try { sonuc.tapu = await tapuOku(); }
    catch (e) { sonuc.hatalar.push('Tapu harcı: ' + e.message); }
    // Hata olan başlıkların eski kaydını koru
    for (const ek of (eski.kaynaklar || [])) if (!sonuc.kaynaklar.some(x => x.fId === ek.fId)) sonuc.kaynaklar.push({ ...ek, eskiVeri: true });
    jsonYaz(BEDEL_DOSYASI, sonuc);
    log('Gider tablosu güncellendi:', sonuc.kaynaklar.length, 'karar,', sonuc.hatalar.length, 'hata');
  } finally { bedelCalisiyor = false; }
}

// ─── Fatura ve mahsuplaşma kontrolü (Ocak 2026 →) ──────────────────────────────────────────────
// Elektrik Fatura Paneli (Python, port 8010) ağdaki başka bir bilgisayarda çalışır (Sami PC,
// C:\Users\Sami\Desktop\PANEL). Uçları: /veri (fatura özetleri), /lokasyonlar, /ges-veri (saatlik
// çekiş/veriş), /durum. 30 dakikada bir okunur, ham hali zaman damgalı saklanır. Adres ulaşılamazsa
// yerel ağlar 8010 için taranır ve bulunan adres elektrik_analizi_ayar.json'a yazılır.
const MAHSUP = require('./lib/elektrik_mahsup.js');
const MDEPO = MAHSUP.depo(VERI);
const ARSIV = require('./lib/elektrik_panel_arsiv.js').arsiv(VERI);
const os = require('os');
const net = require('net');
const PANEL_VARSAYILAN = process.env.PANEL_URL || 'http://192.168.0.106:8010';
const panelTaban = () => jsonOku(AYAR_DOSYASI, {}).panelTaban || PANEL_VARSAYILAN;

function yerelIstek(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 60000 }, res => {
      const p = []; res.on('data', c => p.push(c));
      res.on('end', () => resolve({ status: res.statusCode, tip: res.headers['content-type'] || '', body: Buffer.concat(p).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Zaman aşımı')));
    req.on('error', reject);
  });
}
async function panelJson(taban, uc) {
  const r = await yerelIstek(taban + uc);
  if (r.status !== 200) throw new Error('Panel ' + uc + ' HTTP ' + r.status);
  const j = JSON.parse(r.body);
  if (!j.ok) throw new Error('Panel ' + uc + ' ok=false');
  return { j, body: r.body };
}

// Yerel ağlarda (her /24) 8010 portu açık ve /durum'u panel gibi yanıtlayan bilgisayarı bulur
async function panelleriBul() {
  const onekler = new Set();
  for (const l of Object.values(os.networkInterfaces())) for (const a of l || [])
    if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254') && !a.address.startsWith('100.')) onekler.add(a.address.split('.').slice(0, 3).join('.') + '.');
  const adaylar = ['127.0.0.1'];
  for (const o of onekler) for (let i = 1; i < 255; i++) adaylar.push(o + i);
  const acik = h => new Promise(r => { const s = net.connect({ host: h, port: 8010 }); s.setTimeout(1200); s.on('connect', () => { s.destroy(); r(h); }); s.on('timeout', () => { s.destroy(); r(null); }); s.on('error', () => r(null)); });
  const bulunan = [];
  for (let i = 0; i < adaylar.length; i += 100) {
    for (const h of (await Promise.all(adaylar.slice(i, i + 100).map(acik))).filter(Boolean)) {
      try { await panelJson('http://' + h + ':8010', '/durum'); bulunan.push('http://' + h + ':8010'); } catch (e) { }
    }
  }
  return bulunan;
}
// Bilinen tüm paneller her turda okunur ve birleştirilir (lib/elektrik_panel_kaynak.js). Öncelik: varsayılan
// (Sami PC) → ayardaki liste → eski tek adres. 127.0.0.1 aynı paneli iki kez saymasın diye listeye alınmaz.
// SECENGIDA: faturalar Masaüstü\SECENGIDA klasöründen (zip / PDF). Panel modülü yapıda kalır (PANEL_KULLAN=1 ile açılır).
const SG_KLASORLER = () => { const a = jsonOku(AYAR_DOSYASI, {}); return [...new Set([process.env.SECENGIDA_KLASOR || path.join(os.homedir(), 'Desktop', 'SECENGIDA'), ...(a.kaynakKlasorleri || [])])].filter(k => fs.existsSync(k)); };
const SG = require('./lib/secengida_kaynak.js').kaynak({ veri: VERI, klasorler: SG_KLASORLER, log });
const PANELLER = require('./lib/elektrik_panel_kaynak.js').paneller({
  adresler: () => { const a = jsonOku(AYAR_DOSYASI, {}); return [PANEL_VARSAYILAN, ...(a.paneller || []), a.panelTaban].filter(x => x && !/127\.0\.0\.1/.test(x)); },
  kaydet: liste => jsonYaz(AYAR_DOSYASI, { ...jsonOku(AYAR_DOSYASI, {}), paneller: [...new Set(liste)].filter(x => !/127\.0\.0\.1/.test(x)) }),
  panelJson, yerelIstek, tara: panelleriBul, log,
});

const panelDurum = { sonDeneme: null, sonBasari: null, hata: null, adres: null, klasor: null };
let panelCalisiyor = false;
// ─── Supabase (lib/elektrik_supabase.js) ─────────────────────────────────────────────────────────
const SUPA = require('./lib/elektrik_supabase.js').supabase(process.env);
const BELGE = require('./lib/elektrik_belgeler.js').belgeler({ sayfa: path.join(__dirname, 'public', 'belgeler.html'), env: process.env, log, zenginlestir: k => belgeZenginlestir(k), yerel: { depo: SG.DEPO, otomatik: () => SG.belgeKayitlari(), okunanlar: () => SG.okunanlar() } });
BELGE.okunanYukle().catch(e => log('PDF okunanları yüklenemedi:', e.message));
// Belge ↔ fatura eşleştirici: dosya adındaki fatura no panel faturasında aranır; boş alanlar doldurulur,
// Faturalar klasöründe kategori gerçek duruma göre konur (GES tesisi / normal / kWh'siz ek fatura)
function belgeZenginlestir(k) {
  if (!k.faturaNo) return;
  const f = ((MDEPO.oku().panelVeri || {}).faturalar || []).find(x => (x.dosya || '').toUpperCase().includes(k.faturaNo));
  if (!f) return;
  if (!k.sozlesme) k.sozlesme = f.sozlesmeNo;
  if (!k.lokasyon) k.lokasyon = f.lokasyon || '';
  if (!k.donem) k.donem = f.donem;
  if ((k.klasor || 'belgeler') === 'faturalar' && ['GES faturası', 'Elektrik faturası', 'Fark / ek fatura', ''].includes(k.kategori || '')) {
    const ges = !!(jsonOku(GES_AYAR_DOSYASI, {}).tur || {})[f.sozlesmeNo] || f.grup === 'GES';
    k.kategori = ges ? 'GES faturası' : f.tuketim > 0 ? 'Elektrik faturası' : 'Fark / ek fatura';
  }
}
// Masaüstü: önce sözleşme ayarlarını Supabase'den al (bulutta yapılan değişiklik ezilmesin), sonra her şeyi gönder.
// ayarCek=false: elle kaydedilen ayar hemen gönderilir (Supabase'deki eski değer geri alınmaz).
async function supabaseGonder(neden, ayarCek = true) {
  if (!SUPA.hazir) return;
  try {
    if (ayarCek) {
      const b = await SUPA.ayarlariBirlestir(jsonOku(FIRMA_DOSYASI, {}), jsonOku(GES_AYAR_DOSYASI, {}));
      if (b.sozlesmeSayisi) { jsonYaz(FIRMA_DOSYASI, b.firmaAyar); jsonYaz(GES_AYAR_DOSYASI, b.gesAyar); }
    }
    const p = MDEPO.oku().panelVeri;
    if (!p) return;
    const r = await SUPA.gonder(p, jsonOku(FIRMA_DOSYASI, {}), jsonOku(GES_AYAR_DOSYASI, {}));
    supabaseDurum.son = new Date().toISOString(); supabaseDurum.hata = null;
    log('Supabase (' + neden + '):', Object.entries(r).map(([t, n]) => t + ' ' + (n ? n : '—')).join(' · '));
  } catch (e) { supabaseDurum.hata = e.message; log('Supabase gönderilemedi (' + neden + '):', e.message); }
}
const supabaseDurum = { son: null, hata: null };
// Bulut: panel yerine Supabase'den okur; yerel depo, firma ve GES ayarları Supabase'deki hale getirilir
async function supabasedenYukle() {
  if (panelCalisiyor) return { hata: 'Okuma zaten sürüyor, birkaç saniye sonra tekrar deneyin.' };
  panelCalisiyor = true;
  panelDurum.sonDeneme = new Date().toISOString();
  try {
    const [p, ayar] = await Promise.all([SUPA.geriYukle(), SUPA.ayarlariBirlestir(jsonOku(FIRMA_DOSYASI, {}), jsonOku(GES_AYAR_DOSYASI, {}))]);
    if (!p.faturalar.length) throw new Error('Supabase\'de henüz fatura yok (masaüstü sunucusu panel okuyunca gönderir).');
    const simdi = new Date().toISOString(), v = MDEPO.oku(), eski = v.panelVeri || {};
    const son = { zaman: simdi, gelen: p.faturalar.length, yeni: Math.max(p.faturalar.length - (eski.faturalar || []).length, 0), guncellenen: 0, gesYeniGun: 0 };
    v.panelVeri = { ...p, alinma: p.alinma || simdi, ilkAlinma: eski.ilkAlinma || simdi, adres: 'Supabase (masaüstü: ' + (p.adres || '?') + ')', klasor: null, hamlar: {}, sonYenileme: son, gecmis: [...(eski.gecmis || []), son].slice(-100) };
    v.panel = { sonBasari: simdi, adres: v.panelVeri.adres, faturaSayisi: p.faturalar.length };
    MDEPO.yaz(v);
    jsonYaz(FIRMA_DOSYASI, ayar.firmaAyar); jsonYaz(GES_AYAR_DOSYASI, ayar.gesAyar);
    Object.assign(panelDurum, { sonBasari: simdi, hata: null, adres: v.panelVeri.adres, klasor: null });
    log('Supabase\'den yüklendi:', p.faturalar.length, 'fatura,', Object.keys(p.gesSaatlik).length, 'GES günü');
    return son;
  } catch (e) {
    panelDurum.hata = e.message;
    log('Supabase\'den okunamadı:', e.message);
    return { hata: e.message };
  } finally { panelCalisiyor = false; }
}

async function panelCek(disKaynak) {
  if (BULUT && !disKaynak && SUPA.hazir) return supabasedenYukle();
  if (panelCalisiyor) return { hata: 'Okuma zaten sürüyor, birkaç saniye sonra tekrar deneyin.' };
  panelCalisiyor = true;
  panelDurum.sonDeneme = new Date().toISOString();
  try {
    let taban, durumJ, veri, lok, ges, ekler = {}, okunamayan = [];
    if (disKaynak) {
      // disKaynak: masaüstündeki senkron aracının gönderdiği panel verisi ({ '/durum': {...}, '/veri': {...}, ... })
      const getir = uc => { const j = disKaynak[uc]; if (!j || !j.ok) throw new Error('Senkron verisinde ' + uc + ' yok'); return { j, body: JSON.stringify(j) }; };
      taban = 'senkron: ' + (disKaynak.kaynak || 'masaüstü');
      durumJ = getir('/durum').j; veri = getir('/veri'); lok = getir('/lokasyonlar'); ges = getir('/ges-veri');
    } else {
      if (BULUT) throw new Error('Bulut sunucusu yerel ağdaki panele erişemez; veri masaüstü sunucusundan Supabase ile gelir.');
      ({ taban, durumJ, veri, lok, ges, ekler, okunamayan } = process.env.PANEL_KULLAN === '1' ? await PANELLER.oku() : await SG.panelBicimi());
      await BELGE.okunanYukle().catch(() => { });
    }
    const hamlar = {
      veri: MDEPO.hamSakla('veri', veri.body), lokasyonlar: MDEPO.hamSakla('lokasyonlar', lok.body), ges: MDEPO.hamSakla('ges-veri', ges.body),
    };
    // EKLEMELİ BİRLEŞTİRME (İshak'ın kuralı): saklanan kayıtlar asla silinmez; panelden yeni gelen
    // eklenir, değişen güncellenir. Panelden kalkmış kayıtlar da depoda kalır.
    const simdi = new Date().toISOString();
    const v = MDEPO.oku();
    const eski = v.panelVeri || { faturalar: [], lokasyonlar: [], gesSaatlik: {} };
    const fAnahtar = f => f.sozlesmeNo + '|' + f.donem + '|' + (f.dosya || '');
    const fHarita = new Map(eski.faturalar.map(f => [fAnahtar(f), f]));
    let yeni = 0, guncellenen = 0;
    for (const f of veri.j.kayitlar || []) {
      const k = fAnahtar(f), onceki = fHarita.get(k);
      if (!onceki) { fHarita.set(k, { ...f, eklenme: simdi }); yeni++; continue; }
      const { eklenme, guncelleme, ...ham } = onceki;
      // Panelden boş gelen alan (ör. yeni panelde lokasyon eşleşmesi yok) saklanan dolu değeri silmez
      const yeniF = { ...f }; for (const [a, d] of Object.entries(ham)) if ((yeniF[a] === '' || yeniF[a] == null) && d !== '' && d != null) yeniF[a] = d;
      if (JSON.stringify(ham) !== JSON.stringify(yeniF)) { fHarita.set(k, { ...yeniF, eklenme: eklenme || simdi, guncelleme: simdi }); guncellenen++; }
    }
    const lHarita = new Map(eski.lokasyonlar.map(l => [l.sozlesmeNo, l]));
    for (const l of lok.j.kayitlar || []) lHarita.set(l.sozlesmeNo, { ...(lHarita.get(l.sozlesmeNo) || {}), ...Object.fromEntries(Object.entries(l).filter(([, d]) => d !== '' && d != null)) });
    // Saatlik GES: gün → { cekis:[24], veris:[24] }. Her saat tek hücredir, gelen değer ÜZERİNE YAZILIR
    // (asla toplanmaz): aynı veri kaç kez okunursa okunsun sonuç değişmez, mükerrer oluşmaz.
    const gesOlcum = eski.gesSaatlik || {};
    const gesGunOnce = Object.keys(gesOlcum).length;
    for (const r of ges.j.kayitlar || []) {
      const gun = String(r.tarih).slice(0, 10), h = +r.saat;
      if (!(h >= 0 && h < 24)) continue;
      const g = (gesOlcum[gun] = gesOlcum[gun] || { cekis: new Array(24).fill(0), veris: new Array(24).fill(0) });
      g.cekis[h] = +r.cekis || 0; g.veris[h] = +r.veris || 0;
    }
    const son = { zaman: simdi, gelen: (veri.j.kayitlar || []).length, yeni, guncellenen, gesYeniGun: Object.keys(gesOlcum).length - gesGunOnce };
    v.panelVeri = {
      alinma: simdi, ilkAlinma: eski.ilkAlinma || eski.alinma || simdi, adres: taban, klasor: durumJ.klasor || null,
      faturalar: [...fHarita.values()], lokasyonlar: [...lHarita.values()], gesSaatlik: gesOlcum, hamlar, sonYenileme: son,
      gecmis: [...(eski.gecmis || []), son].slice(-100),
    };
    v.panel = { sonBasari: simdi, adres: taban, faturaSayisi: v.panelVeri.faturalar.length };
    MDEPO.yaz(v);
    try {
      const a = ARSIV.sakla({ durum: JSON.stringify(durumJ), veri: veri.body, lokasyonlar: lok.body, 'ges-veri': ges.body, ...ekler }, { adres: taban, gelen: son.gelen, yeni, guncellenen });
      const t = ARSIV.tablolar(v.panelVeri);
      log('Panel arşivi:', a.yazilan.length ? a.yazilan.join(', ') : 'değişiklik yok', t.length ? '· tablolar: ' + t.join(', ') : '');
    } catch (e) { log('Panel arşivi yazılamadı:', e.message); }
    Object.assign(panelDurum, { sonBasari: simdi, hata: null, adres: taban, klasor: durumJ.klasor || null, paneller: durumJ.paneller || null, okunamayan: okunamayan || [] });
    log('Elektrik paneli okundu:', taban, '· gelen', son.gelen, '· yeni', yeni, '· güncellenen', guncellenen, '· depoda', v.panelVeri.faturalar.length);
    if (SUPA.hazir) supabaseGonder(disKaynak ? 'senkron' : 'panel okuması')
      .then(() => SUPA.okumaKaydet({ basarili: true, kaynak: disKaynak ? 'senkron' : 'masaustu', adres: taban, gelen: son.gelen, yeni, guncellenen }))
      .catch(e => log('Supabase okuma kaydı yazılamadı:', e.message));
    return son;
  } catch (e) {
    panelDurum.hata = e.message;
    log('Elektrik paneli okunamadı:', e.message);
    try { ARSIV.hata(e.message, { adres: disKaynak ? 'senkron' : panelTaban() }); } catch (e2) { }
    if (SUPA.hazir) SUPA.okumaKaydet({ basarili: false, kaynak: disKaynak ? 'senkron' : 'masaustu', adres: disKaynak ? null : panelTaban(), hata: e.message }).catch(() => { });
    return { hata: e.message };
  } finally { panelCalisiyor = false; }
}

// Panel faturaları + GES aylık mahsup özeti (aylık net vs saatlik net, kWh)
function panelRaporu() {
  const v = MDEPO.oku(), p = v.panelVeri || null;
  if (!p) return { ok: true, var: false, durum: panelDurum, hamKlasor: MDEPO.HAM };
  const gesAylik = {};
  for (const [gun, o] of Object.entries(p.gesSaatlik || {})) {
    const ay = gun.slice(0, 7), a = (gesAylik[ay] = gesAylik[ay] || { ay, saat: 0, cekis: 0, veris: 0, saatlikTuketim: 0, saatlikFazla: 0 });
    for (let h = 0; h < 24; h++) {
      const c = o.cekis[h], w = o.veris[h];
      if (!c && !w) continue;
      a.saat++; a.cekis += c; a.veris += w;
      if (c > w) a.saatlikTuketim += c - w; else a.saatlikFazla += w - c;
    }
  }
  const aylar = Object.values(gesAylik).sort((a, b) => a.ay.localeCompare(b.ay)).map(a => ({
    ...a, cekis: yuvarla2(a.cekis), veris: yuvarla2(a.veris), saatlikTuketim: yuvarla2(a.saatlikTuketim), saatlikFazla: yuvarla2(a.saatlikFazla),
    aylikTuketim: yuvarla2(Math.max(a.cekis - a.veris, 0)), aylikFazla: yuvarla2(Math.max(a.veris - a.cekis, 0)),
    rejim: a.ay + '-01' >= MAHSUP.SAATLIK_MAHSUP_BASLANGIC ? 'Saatlik' : 'Aylık',
  }));
  return {
    ok: true, var: true, durum: { ...panelDurum, sonBasari: panelDurum.sonBasari || p.alinma, adres: p.adres, klasor: p.klasor },
    alinma: p.alinma, ilkAlinma: p.ilkAlinma, sonYenileme: p.sonYenileme, gecmis: p.gecmis || [], faturalar: p.faturalar, lokasyonlar: p.lokasyonlar, gesAylik: aylar, hamKlasor: MDEPO.HAM, hamlar: p.hamlar,
  };
}

// ─── Ödenen faturalar ↔ uygulamanın hesabı (ELEKTRİK FATURA KONTROL sayfası) ─────────────────────
// Aylık PTF ortalaması + YEKDEM birim maliyeti EPİAŞ /renewables/data/unit-cost'tan (her dönemin son versiyonu).
const KIYAS = require('./lib/elektrik_fatura_kiyas.js');
const YEKDEM_DOSYASI = path.join(VERI, 'elektrik_yekdem.json');
const KONTROL_HTML = path.join(__dirname, 'public', 'fatura-kontrol.html');
const yekdemDurum = { son: null, hata: null };
async function yekdemGuncelle() {
  try {
    const veri = jsonOku(YEKDEM_DOSYASI, {});
    const bugun = new Date();
    for (let y = 2025; y <= bugun.getFullYear(); y++) {
      const body = JSON.stringify({ startDate: y + '-01-01T00:00:00+03:00', endDate: (y === bugun.getFullYear() ? gunAnahtari(bugun) : y + '-12-31') + 'T23:00:00+03:00' });
      let r;
      for (let d = 0; d < 2; d++) {
        const t = await tgtAl();
        r = await istek('https://seffaflik.epias.com.tr/electricity-service/v1/renewables/data/unit-cost', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'TGT': t, 'Content-Length': Buffer.byteLength(body) } });
        if (r.status === 401 || r.status === 403) { tgt = null; continue; }
        break;
      }
      if (r.status !== 200) throw new Error('EPİAŞ YEKDEM HTTP ' + r.status);
      for (const it of JSON.parse(r.body).items || []) {
        const ay = String(it.period).slice(0, 7);
        if (!veri[ay] || String(it.version) >= String(veri[ay].versiyon)) veri[ay] = { ptf: it.ptf, yekdem: it.unitCost, versiyon: it.version };
      }
    }
    jsonYaz(YEKDEM_DOSYASI, veri);
    Object.assign(yekdemDurum, { son: new Date().toISOString(), hata: null });
  } catch (e) { yekdemDurum.hata = e.message; log('YEKDEM hata:', e.message); }
}
// ─── Firma eşleştirme (sözleşme no → grup firması) ────────────────────────────────────────────────
const FIRMA_DOSYASI = path.join(VERI, 'elektrik_firma_ayar.json');
const VARSAYILAN_FIRMALAR = ['SECENGIDA'];
// SECENGIDA klasöründeki bütün faturalar SECENGIDA (VKN 7570429521) adına kesilmiştir
function firmaTahmini(grup, lokasyon) {
  return 'SECENGIDA';
  if (/USRE/i.test(lokasyon || '')) return 'USRE (BİRİKİM)';
  if (grup === 'TAHTAKALE SPOT') return 'TAHTAKALE';
  if (grup === 'SECEN GROSS') return 'SECEN';
  return null;
}
const GUVENCE = require('./lib/elektrik_guvence.js');
function firmaBilgisi(satirlar) {
  const a = jsonOku(FIRMA_DOSYASI, {});
  const firmalar = [...new Set([...(a.firmalar || VARSAYILAN_FIRMALAR)])];
  const eslesme = {};
  for (const s of satirlar) {
    if (eslesme[s.sozlesmeNo]) continue;
    const atanan = (a.eslesme || {})[s.sozlesmeNo];
    const tahmin = atanan ? null : firmaTahmini(s.panelGrup || s.grup, s.lokasyon);
    const gg = GUVENCE.liste(a, s.sozlesmeNo);
    eslesme[s.sozlesmeNo] = { firma: atanan || tahmin || 'Atanmamış', tahmin: !atanan && !!tahmin, atanmamis: !atanan && !tahmin, lokasyon: s.lokasyon, grup: s.panelGrup || s.grup, guvence: GUVENCE.guncel(gg), guvenceGecmis: gg };
  }
  return { firmalar, eslesme };
}

// Saklanan faturalardaki en son ekleme/değişiklik zamanı (tablo başlığındaki "Veri güncelleme" şeridi için)
const sonDegisiklik = l => (l || []).reduce((m, f) => [f.eklenme, f.guncelleme].reduce((x, t) => t && (!x || t > x) ? t : x, m), null);

// ─── Reel fatura (PDF) düzeltmesi ─────────────────────────────────────────────────────────────────
// Faturanın PDF'inden okunan kalemler (Belgeler › Faturalar, lib/elektrik_pdf_fatura.js):
//  • Güvence bedeli enerji tüketimi değildir (KDV'siz): farka katılmaz.
//  • Güç bedeli ve trafo kaybı (OG çift terim) uygulamanın enerji hesabında yoktur: KDV'siyle hesaba eklenir.
//  • Eksi / düşülen satırlar (GES'te mahsup edilen enerji) bilgi olarak gösterilir.
const tlYaz = v => Number(v).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DURUM_ADI = { dogru: 'doğru', fazla: 'fazla', eksik: 'az' };
function pdfKalemleri(r) {
  const kdvO = r.kdv && r.kdvMatrah ? r.kdv / r.kdvMatrah : 0.2;
  return { ek: Math.round(((r.gucBedeli || 0) + (r.trafoKaybi || 0)) * (1 + kdvO) * 100) / 100, guvence: r.guvence || 0 };
}
function faturaPdfDuzelt(satirlar, kTarife) {
  const PDF = BELGE.okunanlar();
  for (const s of satirlar) {
    const r = PDF.get(s.faturaNo);
    if (!r || !r.okundu) continue;
    let { ek, guvence } = pdfKalemleri(r);
    const kPdf = r.kdv && r.kdvMatrah ? Math.round(r.kdv / r.kdvMatrah * 100) / 100 : null;
    s.pdf = { belgeId: r.belgeId, tutar: r.faturaTutari, odenecek: r.odenecek, guvence, gucBedeli: r.gucBedeli || 0, trafoKaybi: r.trafoKaybi || 0, ekKalem: ek, dusulenKwh: r.dusulenKwh, dusulenTL: r.dusulenTL, tuketimKwh: r.tuketimKwh, okumaKwh: r.okumaKwh, etv: r.etv, kdv: r.kdv, kdvMatrah: r.kdvMatrah, kdvOran: kPdf, grup: r.tuketiciGrubu };
    if (s.hesap == null) continue;
    const eski = s.durum, n = [];
    let hd = s.hesapDetay;
    // Tarife grubu ve kademe faturadan (KIYAS.pdfHesap): panel grubu (ör. MESKEN) faturadaki tüketici grubuyla uyuşmayabilir
    const y = hd && kTarife ? KIYAS.pdfHesap(r, hd, kTarife) : null;
    if (y) {
      const eskiTip = hd.tipAd || hd.tip;
      if ((hd.tip || '').replace('_alt', '') !== y.pdfGrup) n.push('tarife grubu faturadan: ' + (r.tuketiciGrubu || y.pdfGrup) + ' (panel / uygulama: ' + (s.panelGrup || '') + ' · ' + eskiTip + ')');
      if (hd.kdvOran != null && Math.abs(hd.kdvOran - y.kdvOran) >= 0.01) n.push('KDV %' + Math.round(y.kdvOran * 100) + ' (uygulama %' + Math.round(hd.kdvOran * 100) + ' kullanıyordu)');
      if (kPdf != null && Math.abs(kPdf - y.kdvOran) >= 0.01) n.push('⚠ faturadaki KDV oranı %' + Math.round(kPdf * 100) + ', grubun yasal oranı %' + Math.round(y.kdvOran * 100));
      if (!n.length) n.push(y.yontem);
      s.hesapOnce = { yontem: s.yontem, toplam: hd.toplam, tipAd: eskiTip };
      hd = s.hesapDetay = { ...y, tipAd: y.yontem }; s.yontem = y.yontem; s.hesap = y.toplam;
      if (y.ekDigerTop) { ek = Math.round((ek + y.ekDigerTop) * 100) / 100; n.push('faturadaki enerji dışı kalemler hesaba eklendi: ' + y.ekDiger.map(x => x.ad + ' ' + tlYaz(x.tutar) + ' TL' + (x.kdvli ? ' (+KDV)' : '')).join(', ')); }
    }
    // Grup okunamadıysa (OG vb.) yalnızca KDV oranı faturadan
    else if (hd && kPdf != null && hd.kdvOran != null && Math.abs(kPdf - hd.kdvOran) >= 0.01) {
      const taban = hd.enerji + hd.dagitim + hd.etv;
      n.push('KDV oranı faturaya göre %' + Math.round(kPdf * 100) + ' (uygulama %' + Math.round(hd.kdvOran * 100) + ' kullanıyordu; faturadaki grup: ' + (r.tuketiciGrubu || '?') + ')');
      hd.kdvOran = kPdf; hd.kdv = Math.round(taban * kPdf * 100) / 100; hd.toplam = Math.round((taban + hd.kdv) * 100) / 100;
      s.hesap = hd.toplam;
    }
    if (!ek && !guvence && !n.length) continue;
    s.hesapEnerji = hd ? hd.toplam : s.hesap; s.farkHam = s.fark;
    s.hesap = Math.round(((hd ? hd.toplam : s.hesap) + ek) * 100) / 100;
    s.fark = Math.round((s.odenen - guvence - s.hesap) * 100) / 100;
    s.farkYuzde = s.hesap ? Math.round(s.fark / s.hesap * 10000) / 100 : null;
    if (s.kwh) s.birimHesap = Math.round(s.hesap / s.kwh * 10000) / 10000;
    s.durum = Math.abs(s.fark) <= Math.max(10, s.hesap * 0.03) ? 'dogru' : s.fark > 0 ? 'fazla' : 'eksik';
    if (guvence) n.push('güvence bedeli ' + tlYaz(guvence) + ' TL faturaya eklenmiş (enerji dışı, farka katılmadı)');
    const ekGuc = Math.round((ek - (y && y.ekDigerTop || 0)) * 100) / 100;
    if (ekGuc) n.push('güç bedeli / trafo kaybı ' + tlYaz(ekGuc) + ' TL (KDV dahil) hesaba eklendi');
    s.aciklama = 'Reel fatura (PDF): ' + n.join(' · ') + (eski !== s.durum ? ' · durum ' + (DURUM_ADI[eski] || eski) + ' → ' + (DURUM_ADI[s.durum] || s.durum) : '') + '. ' + (s.durum === 'dogru' ? 'Enerji bedeli hesapla uyumlu.' : (s.aciklama || ''));
  }
}
function gesPdfDuzelt(satirlar) {
  const PDF = BELGE.okunanlar();
  for (const x of satirlar) {
    const r = PDF.get(x.faturaNo);
    if (!r || !r.okundu || x.brut == null) continue;
    const { ek, guvence } = pdfKalemleri(r), disi = ek + guvence;
    x.pdf = { belgeId: r.belgeId, guvence, gucBedeli: r.gucBedeli || 0, trafoKaybi: r.trafoKaybi || 0, enerjiDisi: Math.round(disi * 100) / 100, dusulenKwh: r.dusulenKwh, dusulenTL: r.dusulenTL, dusulenKdvDahil: r.dusulenTL ? Math.round(r.dusulenTL * (1 + (r.kdv && r.kdvMatrah ? r.kdv / r.kdvMatrah : 0.2)) * 100) / 100 : null };
    x.mahsupHam = x.mahsupTL;
    x.mahsupTL = Math.round((x.brut - (x.odenen - disi)) * 100) / 100;
    const tol = Math.max(50, x.brut * 0.03);
    x.durum = x.mahsupTL > tol ? 'yansimis' : x.mahsupTL >= -tol ? 'yok-mahsup' : 'fazla';
    x.aciklama = 'Reel fatura (PDF): ' + [disi ? 'enerji dışı kalemler ' + tlYaz(disi) + ' TL çıkarıldı (' + [r.gucBedeli ? 'güç bedeli' : '', r.trafoKaybi ? 'trafo kaybı' : '', guvence ? 'güvence' : ''].filter(Boolean).join(', ') + ')' : '', r.dusulenTL ? 'faturada düşülen (mahsup) ' + (r.dusulenKwh ? tlYaz(r.dusulenKwh) + ' kWh · ' : '') + tlYaz(r.dusulenTL) + ' TL' : 'faturada düşülen satır yok'].filter(Boolean).join(' · ') + '. '
      + (x.durum === 'yansimis' ? 'Mahsup indirimi ' + tlYaz(x.mahsupTL) + ' TL.' : x.durum === 'fazla' ? 'Mahsupsuz fiyattan ' + tlYaz(-x.mahsupTL) + ' TL fazla.' : 'Mahsup indirimi görünmüyor.');
  }
}
// PDF'ten okunan tüm faturalar: SECENGIDA klasörü + Belgeler'e elle yüklenenler
function okunanHepsi() { const m = new Map(SG.okunanlar()); for (const [n, v] of BELGE.okunanlar()) if (!m.has(n)) m.set(n, v); return m; }
// kWh'siz hizmet / bedel faturaları (ANT Trafo, CK yıllık işletim bedeli): tutar, sözleşmenin olağan aylık tutarıyla kıyaslanır
function hizmetFaturalari(satirlar) {
  const O = okunanHepsi(), grup = {};
  const tl = v => v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const s of satirlar) if (s.durum === 'ek-fatura') (grup[s.sozlesmeNo] = grup[s.sozlesmeNo] || []).push(s);
  for (const l of Object.values(grup)) {
    const matrah = s => { const r = O.get(s.faturaNo); return r && r.kdvMatrah != null ? r.kdvMatrah : s.odenen / 1.2; };
    const m = l.map(matrah).sort((a, b) => a - b), medyan = m[m.length >> 1];
    for (const s of l) {
      const r = O.get(s.faturaNo) || {}, mt = matrah(s), kat = medyan ? mt / medyan : 1;
      const kdvO = r.kdv != null && r.kdvMatrah ? Math.round(r.kdv / r.kdvMatrah * 100) : null;
      let a = (r.hizmet ? r.hizmet + ': ' : (s.aciklama || '') + ' ') + tl(mt) + ' TL + KDV' + (kdvO != null ? ' %' + kdvO : '') + ' = ' + tl(s.odenen) + ' TL.';
      if (l.length > 1 && Math.round(kat) > 1 && Math.abs(kat - Math.round(kat)) < 0.01) a += ' Olağan aylık tutarın tam ' + Math.round(kat) + ' katı: ' + Math.round(kat) + ' aylık toplu fatura.';
      else if (l.length > 1 && Math.abs(kat - 1) > 0.01) a += ' ⚠ Olağan aylık tutardan (' + tl(medyan) + ' TL) %' + Math.round((kat - 1) * 100) + ' farklı.';
      else if (l.length > 1) a += ' Olağan aylık tutarla aynı.';
      if (kdvO != null && kdvO !== 20) a += ' ⚠ KDV oranı %' + kdvO + '.';
      if ((r.kontrol || []).some(k => !k.tamam)) a += ' ⚠ Fatura içi sağlama tutmuyor.';
      s.aciklama = a;
    }
  }
}
function faturaKiyasRaporu() {
  const v = MDEPO.oku(), p = v.panelVeri;
  if (!p) return { ok: true, var: false, durum: panelDurum };
  const piyasa = jsonOku(YEKDEM_DOSYASI, {});
  const kTarife = KIYAS.tarifeleriOku(TARIFE_KLASORU);
  const k = KIYAS.kiyasla({ faturalar: p.faturalar, lokasyonlar: p.lokasyonlar, tarifeler: kTarife, piyasa, okunan: okunanHepsi() });
  hizmetFaturalari(k.satirlar);
  const fb = firmaBilgisi(k.satirlar);
  // GES tesisleri (GES ayarında çatı / tarla tanımlı) panel grubu ne olursa olsun burada kapsam dışıdır:
  // bu tabloda mahsup hesaplanmaz, mahsup kontrolü GES Mahsup sekmesinde saatlik veriyle yapılır
  const gesTur = jsonOku(GES_AYAR_DOSYASI, {}).tur || {};
  for (const s of k.satirlar) if (gesTur[s.sozlesmeNo] && s.durum !== 'kapsam-disi') { s.durum = 'kapsam-disi'; s.aciklama = (gesTur[s.sozlesmeNo] === 'cati' ? 'Çatı' : 'Tarla') + ' GES tesisi: bu tabloda mahsup hesaplanmaz; mahsup GES Mahsup sekmesinde kontrol edilir.'; s.hesapNormal = s.hesap; s.hesap = null; s.fark = null; s.farkYuzde = null; s.birimHesap = null; }
  for (const s of k.satirlar) { s.firma = fb.eslesme[s.sozlesmeNo].firma; s.guvence = GUVENCE.donemde(fb.eslesme[s.sozlesmeNo].guvenceGecmis, s.donem); }
  for (const m of k.mukerrer) m.firma = fb.eslesme[m.sozlesmeNo].firma;
  for (const c of k.cift) c.firma = fb.eslesme[c.sozlesmeNo].firma;
  faturaPdfDuzelt(k.satirlar, kTarife);
  // GES tesislerinin faturalarına hesaplanan mahsup: GES Mahsup sekmesindeki hesap (mahsupsuz brüt − ödenen)
  try {
    const g = GESM.gesMahsup({ kiyas: { ...k, firmaBilgisi: fb }, gesSaatlik: (MDEPO.oku().panelVeri || {}).gesSaatlik, tarifeler, ayar: jsonOku(GES_AYAR_DOSYASI, {}) });
    gesPdfDuzelt(g.satirlar);
    const gm = new Map(g.satirlar.map(x => [x.faturaNo, x]));
    const DURUM_AD = { yansimis: '✔ mahsup faturaya yansımış', 'yok-mahsup': '○ mahsup görünmüyor', fazla: '✘ mahsupsuz fiyattan bile fazla ödenmiş' };
    for (const s of k.satirlar) {
      const x = gm.get(s.faturaNo);
      if (!x || x.mahsupTL == null) continue;
      s.gesMahsup = { brut: x.brut, mahsup: x.mahsupTL, durum: x.durum, emsal: x.emsalBirim, rejim: x.rejim, pdf: !!x.pdf };
      if (s.durum === 'kapsam-disi') s.aciklama = 'GES: hesaplanan mahsup ' + x.mahsupTL.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL (mahsupsuz ' + x.brut.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' − ödenen) · ' + (DURUM_AD[x.durum] || x.durum) + ' · ayrıntı GES Mahsup sekmesinde.';
    }
    // Üretilen GES enerjisi (mahsupsuz, GES faturaları görünümünün altı): güç = faturadaki en son anlaşma gücü
    const PDFg = BELGE.okunanlar(), gucG = {};
    for (const s of k.satirlar.slice().sort((a, b) => a.donem.localeCompare(b.donem))) { const r = PDFg.get(s.faturaNo); if (r && r.anlasmaGucu) gucG[s.sozlesmeNo] = r.anlasmaGucu; }
    k.gesUretim = GESM.gesUretimi({ sayac: g.sayac, birim: g.birim, tesisler: g.tesisler, guc: gucG, ayar: jsonOku(GES_AYAR_DOSYASI, {}) });
    // Panelin saatlik GES verisinin son günü: faturası olup verisi olmayan aylar tabloda nedeniyle gösterilir
    k.gesUretim.sonGun = Object.keys((MDEPO.oku().panelVeri || {}).gesSaatlik || {}).sort().pop() || null;
    // GES mahsup tetkiki: faturalarda düşülen mahsup ↔ mevzuata göre mahsup (birikimli), ihtiyaç fazlası
    k.mahsupKontrol = GESM.mahsupKontrolu({ satirlar: k.satirlar, okunan: PDFg, sayac: g.sayac, birim: g.birim, uretim: k.gesUretim });
  } catch (e) { log('GES mahsup fatura kontrolüne eklenemedi:', e.message); }
  // SECENGIDA: panelde saatlik GES verisi yoksa üretim ve mahsup tetkiki AOSB faturalarından (lib/secengida_ges.js)
  try {
    if (!Object.keys((MDEPO.oku().panelVeri || {}).gesSaatlik || {}).length) {
      const sg = require('./lib/secengida_ges.js').secengidaGes({ satirlar: k.satirlar, okunan: okunanHepsi(), gunes: jsonOku(GUNES_DOSYASI, {}).Antalya, saatlikBaslangic: MAHSUP.SAATLIK_MAHSUP_BASLANGIC });
      if (sg) { k.gesUretim = sg.uretim; k.mahsupKontrol = sg.kontrol; }
    }
  } catch (e) { log('SECENGIDA GES tetkiki hesaplanamadı:', e.message); }
  return { ok: true, var: true, firmaBilgisi: fb, alinma: p.alinma, sonDegisiklik: sonDegisiklik(p.faturalar), sonYenileme: p.sonYenileme, panel: { ...panelDurum, adres: p.adres, klasor: p.klasor }, yekdem: yekdemDurum, ptf: { son: durum.ptfSonGuncelleme, hata: durum.ptfHata }, bulut: BULUT, ...k };
}

// ─── GES mahsup kontrolü (☀ GES Mahsup sekmesi) ─────────────────────────────────────────────────
const GESM = require('./lib/elektrik_ges_mahsup.js');
const GES_AYAR_DOSYASI = path.join(VERI, 'elektrik_ges_ayar.json');
const GES_HTML = path.join(__dirname, 'public', 'ges-mahsup.html');
function gesMahsupRaporu() {
  const k = faturaKiyasRaporu();
  if (!k.var) return { ok: true, var: false };
  const ayar = jsonOku(GES_AYAR_DOSYASI, {});
  const g = GESM.gesMahsup({ kiyas: k, gesSaatlik: (MDEPO.oku().panelVeri || {}).gesSaatlik, tarifeler, ayar });
  gesPdfDuzelt(g.satirlar);
  const lok = {};
  for (const s of k.satirlar) lok[s.sozlesmeNo] = s.lokasyon;
  for (const s of g.satirlar) s.firma = k.firmaBilgisi.eslesme[s.sozlesmeNo] ? k.firmaBilgisi.eslesme[s.sozlesmeNo].firma : 'Atanmamış';
  for (const x of g.tesisler) x.firma = k.firmaBilgisi.eslesme[x.sozlesmeNo] ? k.firmaBilgisi.eslesme[x.sozlesmeNo].firma : 'Atanmamış';
  return { ok: true, var: true, firmalar: k.firmaBilgisi.firmalar, alinma: k.alinma, sonDegisiklik: k.sonDegisiklik, yekdem: k.yekdem, ptf: k.ptf, panel: k.panel, bulut: k.bulut, ayar, tumLokasyonlar: Object.entries(lok).map(([no, ad]) => ({ no, ad })).sort((a, b) => a.ad.localeCompare(b.ad, 'tr')), ...g };
}

// ─── 🏭 AOSB Fabrika tetkiki (Antalya OSB faturaları, PDF'ten) ──────────────────────────────────────
// Her ay: faturanın kendi sağlaması · geçici birim fiyat ve bir sonraki faturadaki "birim fiyat farkı" ile kesinleşen fiyat ·
// (PTF+YEKDEM) karşısında efektif katsayı · GES şebekeye veriş (2.8.0) ↔ bir sonraki faturada mahsup edilen kWh ·
// iletim / dağıtım bedelleri · reaktif oranları · demand ↔ sözleşme gücü. ANT Trafo hizmet faturaları ayrıca listelenir.
function aosbRaporu() {
  const O = okunanHepsi(), piyasa = jsonOku(YEKDEM_DOSYASI, {}), ptf = jsonOku(PTF_DOSYASI, {});
  const osb = [...O.values()].filter(r => r.kaynak === 'OSB' && r.okundu && r.donem).sort((a, b) => a.donem.localeCompare(b.donem));
  const y2 = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100, y6 = v => v == null || !isFinite(v) ? null : Math.round(v * 1e6) / 1e6;
  const sonrakiAy = a => { const [y, m] = a.split('-').map(Number); return m === 12 ? (y + 1) + '-01' : y + '-' + ikiHane(m + 1); };
  const zon = h => h >= 6 && h < 17 ? 'Gündüz' : h >= 17 && h < 22 ? 'Puant' : 'Gece';
  const aylar = osb.map(r => {
    const p = piyasa[r.donem] || null, sonra = osb.find(x => x.donem === sonrakiAy(r.donem)) || null;
    const bed = ad => (r.bedeller || []).filter(b => ad.test(b.ad)).reduce((t, b) => t + (b.tutar || 0), 0);
    // Kesin birim: bir sonraki faturadaki fiyat farkı satırı bu ayın kWh'ına uygulanmışsa
    const ff = sonra && sonra.fiyatFarki, ffUyar = !!(ff && r.aktif && Math.abs(ff.miktar - r.aktif.toplam) <= Math.max(1, r.aktif.toplam * 0.001));
    const kesin = ffUyar ? r.aktif.birim + ff.birim : null;
    const py = p ? (p.ptf + p.yekdem) / 1000 : null;
    // Zaman dilimi ağırlıklı PTF (faturadaki gündüz/puant/gece kWh ile; saatlik PTF önbelleğinden)
    let zonPtf = null;
    const zk = r.zaman || {}, zt = ['Gündüz', 'Puant', 'Gece'].reduce((t, z) => t + (zk[z] ? zk[z].kwh : 0), 0);
    if (zt) {
      const o = { Gündüz: [0, 0], Puant: [0, 0], Gece: [0, 0] };
      for (const [g, sa] of Object.entries(ptf)) if (g.startsWith(r.donem)) sa.forEach((v, h) => { if (v != null) { o[zon(h)][0] += v; o[zon(h)][1]++; } });
      if (o.Gece[1]) zonPtf = ['Gündüz', 'Puant', 'Gece'].reduce((t, z) => t + (zk[z] ? zk[z].kwh : 0) / zt * o[z][0] / o[z][1], 0);
    }
    // GES: bu ay şebekeye verilen (2.8.0) ↔ bir sonraki faturada "üretim bir önceki dönem" ile mahsup edilen
    const veris = r.veris ? r.veris.kwh : 0, mahsupSonra = sonra ? (sonra.uretimMahsup ? Math.abs(sonra.uretimMahsup.miktar) : 0) : null;
    const reaktifOran = k => r.aktif && r.aktif.okuma && r.reaktif && r.reaktif[k] ? y2(r.reaktif[k].okuma / r.aktif.okuma * 100) : null; // sayaç okuması (faturalanan kVArh sınır altında 0'dır)
    const saglama = r.kontrol || [];
    return {
      ay: r.donem, faturaNo: r.faturaNo, belgeId: r.belgeId, tarifeGrubu: r.tuketiciGrubu, ilkOkuma: r.ilkOkuma, sonOkuma: r.sonOkuma, gun: r.gun,
      kwh: r.aktif ? r.aktif.toplam : null, olculen: r.aktif ? r.aktif.okuma : null, ilave: r.aktif ? r.aktif.ilave : 0,
      gunduz: zk.Gündüz ? zk.Gündüz.kwh : null, puant: zk.Puant ? zk.Puant.kwh : null, gece: zk.Gece ? zk.Gece.kwh : null,
      geciciBirim: r.aktif ? r.aktif.birim : null, kesinBirim: y6(kesin), sonrakiFark: ffUyar ? ff.birim : null, sonrakiFarkTL: ffUyar ? ff.tutar : null,
      ptf: p ? p.ptf : null, yekdem: p ? p.yekdem : null, ptfYekdem: y6(py), zonPtf: y2(zonPtf),
      kGecici: py && r.aktif ? Math.round(r.aktif.birim / py * 1e4) / 1e4 : null, kKesin: py && kesin ? Math.round(kesin / py * 1e4) / 1e4 : null,
      refBirim: py ? y6(py * KIYAS.SKTT_KATSAYI) : null,
      enerjiTL: r.aktif ? r.aktif.tutar : null, fiyatFarkiTL: r.fiyatFarki ? r.fiyatFarki.tutar : 0, fiyatFarkiKwh: r.fiyatFarki ? r.fiyatFarki.miktar : null, fiyatFarkiBirim: r.fiyatFarki ? r.fiyatFarki.birim : null,
      uretimMahsupKwh: r.uretimMahsup ? Math.abs(r.uretimMahsup.miktar) : 0, uretimMahsupBirim: r.uretimMahsup ? Math.abs(r.uretimMahsup.birim) : null, uretimMahsupTL: r.uretimMahsup ? r.uretimMahsup.tutar : 0,
      veris, mahsupSonra, verisFark: mahsupSonra != null ? y2(veris - mahsupSonra) : null,
      rejim: r.donem + '-01' >= MAHSUP.SAATLIK_MAHSUP_BASLANGIC ? 'Saatlik' : 'Aylık',
      iletimTuketim: y2(bed(/İLETİM BEDELİ \(TÜKETİM\)/)), iletimSabit: y2(bed(/İLETİM BEDELİ SABİT \(kW\)/)), dagitim: y2(bed(/DAĞITIM/)), digerBedel: y2(bed(/PERAKENDE|ÜRETİM\)|kWe|EMRE/)),
      reaktifTL: y2(Object.values(r.reaktif || {}).reduce((t, x) => t + (x.tutar || 0), 0)), induktifOran: reaktifOran('endüktif'), kapasitifOran: reaktifOran('kapasitif'),
      demand: r.demand, sozlesmeGucu: r.sozlesmeGucu, kuruluKva: r.kuruluKva, uretimKwe: r.uretimKwe,
      etv: r.etv || 0, matrah: r.kdvMatrah, kdv: r.kdv, tutar: r.faturaTutari, odenecek: r.odenecek,
      saglamaHata: saglama.filter(k => !k.tamam).length, saglama, uyarilar: r.uyarilar || [], not: r.not || null,
    };
  });
  const ant = [...O.values()].filter(r => r.kaynak === 'ANT' && r.okundu).sort((a, b) => (a.donem || '').localeCompare(b.donem || '')).map(r => ({ ay: r.donem, faturaNo: r.faturaNo, belgeId: r.belgeId, hizmet: r.hizmet, matrah: r.kdvMatrah, kdv: r.kdv, tutar: r.faturaTutari, saglamaHata: (r.kontrol || []).filter(k => !k.tamam).length }));
  const am = ant.map(x => x.matrah).sort((a, b) => a - b), antMedyan = am[am.length >> 1] || null;
  for (const x of ant) x.ayAdedi = antMedyan ? Math.round(x.matrah / antMedyan * 100) / 100 : null;
  return { ok: true, var: aylar.length > 0, uygulama: UYGULAMA, aylar, ant, antMedyan, sktt: KIYAS.SKTT_KATSAYI, saatlikBaslangic: MAHSUP.SAATLIK_MAHSUP_BASLANGIC, kaynak: SG.durum, panel: panelDurum, ptfSon: durum.ptfSonGuncelleme };
}

function mahsupRaporu() {
  const v = MDEPO.oku();
  const simdi = new Date();
  const aylar = [];
  for (let d = new Date(2026, 0, 1); d <= simdi; d.setMonth(d.getMonth() + 1)) aylar.push(d.getFullYear() + '-' + ikiHane(d.getMonth() + 1));
  const etv = (jsonOku(BEDEL_DOSYASI, {}).etv) || null;
  const tesisNolari = [...new Set([...Object.keys(v.tesisler), ...Object.keys(v.olcum || {}), ...v.faturalar.map(f => f.tesisatNo)])];
  const hucreler = [];
  for (const no of tesisNolari) {
    const tesis = v.tesisler[no] || { tesisatNo: no, tarifeSinifi: 'AG', zaman: 'tek', etv: 'diger', lu: 'LU2' };
    const olcum = (v.olcum || {})[no];
    for (const ay of aylar) {
      const fatura = v.faturalar.find(f => f.tesisatNo === no && f.donem === ay) || null;
      const olcumVar = !!(olcum && MAHSUP.gunleri(ay).some(g => olcum[g]));
      if (!fatura && !olcumVar) { hucreler.push({ tesisatNo: no, ay, sonuc: 'veri-yok' }); continue; }
      const args = { tesis, ay, olcum: olcumVar ? olcum : null, fatura, tarifeler, etvOranlari: etv };
      const hesap = MAHSUP.beklenenHesapla(args);
      const kars = fatura && hesap.durum === 'hesaplandi' ? MAHSUP.karsilastir(fatura, hesap) : null;
      const etki = olcumVar ? MAHSUP.rejimEtkisi(args) : null;
      hucreler.push({ tesisatNo: no, ay, sonuc: kars ? kars.sonuc : (fatura ? 'hesaplanamadi' : 'fatura-bekleniyor'), fatura, hesap, karsilastirma: kars, rejimEtkisi: etki ? { aylikNet: yuvarla2(etki.aylik.toplamTL - etki.aylik.fazlaBedelTL), saatlikNet: yuvarla2(etki.saatlik.toplamTL - etki.saatlik.fazlaBedelTL), farkTL: etki.farkTL } : null });
    }
  }
  return { aylar, tesisler: tesisNolari.map(no => v.tesisler[no] || { tesisatNo: no }), hucreler, panel: { ...v.panel, ...panelDurum }, olcumTesisleri: Object.keys(v.olcum || {}), faturaSayisi: v.faturalar.length };
}
const yuvarla2 = x => Math.round(x * 100) / 100;

// ─── Mail (Outlook) ─────────────────────────────────────────────────────────────────────────────
// Seçilen raporlar mail gövdesinde HTML tablo + tek Excel eki (her rapor ayrı sayfa) olarak gider.
// Gönderim elektrik_mail_gonder.ps1 ile Outlook üzerinden: 'Outlook'ta aç' (kontrol et) veya 'Hemen gönder'.
const { execFile } = require('child_process');
const os2 = require('os');
const MAIL_PS1 = path.join(__dirname, 'araclar', 'elektrik_mail_gonder.ps1');
const MAIL_ADRES_DOSYASI = path.join(VERI, 'elektrik_mail_adresleri.json');
const GOVDE_SATIR_SINIRI = 300;
function psCalistir(args) {
  return new Promise(res => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MAIL_PS1, ...args], { timeout: 120000, windowsHide: true, encoding: 'utf8' }, (err, out) => {
    const m = /\{[\s\S]*\}/.exec(out || '');
    try { res(JSON.parse(m[0])); } catch (e) { res({ ok: false, hata: (err && err.message) || 'Outlook yanıt vermedi' }); }
  }));
}
let mailHesaplari = null;
const htmlKac = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hucreMetni = v => typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('tr-TR') : v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })) : (v == null ? '' : String(v));
function mailGovdesi(b) {
  const tarih = new Date().toLocaleString('tr-TR');
  let h = '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#111">';
  if (b.not) h += '<p>' + htmlKac(b.not).replace(/\n/g, '<br>') + '</p>';
  h += '<div style="background:#1a3a6b;color:#fff;padding:10px 14px;font-size:16px;font-weight:bold">⚡ ' + UYGULAMA + '</div>';
  h += '<div style="color:#555;font-size:12px;margin:6px 0 12px">Hazırlanma: ' + tarih + (b.filtre ? ' · ' + htmlKac(b.filtre) : '') + '</div>';
  for (const r of b.raporlar || []) {
    const s = r.satirlar || [];
    h += '<h3 style="color:#1a3a6b;margin:16px 0 6px;font-size:14px">' + htmlKac(r.ad) + '</h3>';
    if (r.bilgi) h += '<div style="background:#fff4e0;border-left:4px solid #e67e22;padding:5px 10px;font-size:12px;color:#5a3b00;margin:0 0 6px">🕒 ' + htmlKac(r.bilgi) + '</div>';
    if (!b.govdeTablo) continue;
    if (s.length < 2) { h += '<div style="color:#777">Kayıt yok.</div>'; continue; }
    h += '<table style="border-collapse:collapse;font-size:12px"><tr>' + s[0].map(x => '<th style="background:#1a3a6b;color:#fff;padding:5px 8px;border:1px solid #c7cfdc;white-space:nowrap">' + htmlKac(x) + '</th>').join('') + '</tr>';
    const govde = s.slice(1, 1 + GOVDE_SATIR_SINIRI);
    govde.forEach((sat, i) => { h += '<tr>' + sat.map(v => '<td style="padding:4px 8px;border:1px solid #dde3ec;' + (typeof v === 'number' ? 'text-align:right;' : '') + (i % 2 ? 'background:#f5f8fc;' : '') + 'white-space:nowrap">' + htmlKac(hucreMetni(v)) + '</td>').join('') + '</tr>'; });
    h += '</table>';
    if (s.length - 1 > GOVDE_SATIR_SINIRI) h += '<div style="color:#c0392b;font-size:12px;margin-top:4px">İlk ' + GOVDE_SATIR_SINIRI + ' satır gösterildi (toplam ' + (s.length - 1).toLocaleString('tr-TR') + '). Tamamı ekteki Excel dosyasında.</div>';
  }
  return h + '<div style="color:#888;font-size:11px;margin-top:18px">Bu e-posta ' + UYGULAMA + ' uygulamasından gönderilmiştir.</div></div>';
}
const EPOSTA = /^[^\s@;,]+@[^\s@;,]+\.[^\s@;,]+$/;
// SMTP (Render / Outlook olmayan makineler): SMTP_HOST, SMTP_PORT, SMTP_KULLANICI, SMTP_SIFRE, SMTP_GONDEREN
const SMTP_VAR = !!process.env.SMTP_HOST;
const OUTLOOK_KULLAN = process.platform === 'win32' && process.env.MAIL_YONTEMI !== 'smtp';
async function smtpGonder({ gonderen, kime, bilgi, konu, govdeDosya, ekler }) {
  if (!SMTP_VAR) return { ok: false, hata: 'Mail için SMTP ayarı yok (SMTP_HOST, SMTP_KULLANICI, SMTP_SIFRE). Render panelinde Environment bölümüne ekleyin.' };
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587), secure: +(process.env.SMTP_PORT || 587) === 465, auth: process.env.SMTP_KULLANICI ? { user: process.env.SMTP_KULLANICI, pass: process.env.SMTP_SIFRE } : undefined });
  try {
    await t.sendMail({ from: gonderen || process.env.SMTP_GONDEREN || process.env.SMTP_KULLANICI, to: kime.join(', '), cc: bilgi.length ? bilgi.join(', ') : undefined, subject: konu, html: fs.readFileSync(govdeDosya, 'utf8'), attachments: ekler.map(e => ({ filename: path.basename(e), path: e })) });
    return { ok: true, durum: 'gonderildi' };
  } catch (e) { return { ok: false, hata: 'SMTP: ' + e.message }; }
}
async function mailGonder(b) {
  const kime = [...new Set((b.kime || []).map(x => String(x).trim()).filter(Boolean))], bilgi = [...new Set((b.bilgi || []).map(x => String(x).trim()).filter(Boolean))];
  const hatali = [...kime, ...bilgi].filter(x => !EPOSTA.test(x));
  if (!kime.length) return { ok: false, hata: 'En az bir alıcı girin.' };
  if (hatali.length) return { ok: false, hata: 'Geçersiz e-posta adresi: ' + hatali.join(', ') };
  if (!(b.raporlar || []).length) return { ok: false, hata: 'En az bir rapor seçin.' };
  const klasor = fs.mkdtempSync(path.join(os2.tmpdir(), 'elk_mail_'));
  const govdeDosya = path.join(klasor, 'govde.html');
  fs.writeFileSync(govdeDosya, mailGovdesi(b), 'utf8');
  const ekler = [];
  if (b.excel) {
    const wb = XLSX.utils.book_new(), adlar = new Set();
    for (const r of b.raporlar) {
      let ad = String(r.ad || 'Rapor').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), i = 2;
      while (adlar.has(ad)) ad = ad.slice(0, 28) + ' ' + i++;
      adlar.add(ad);
      const ws = XLSX.utils.aoa_to_sheet(r.bilgi ? [[String(r.bilgi)], [], ...(r.satirlar || [])] : (r.satirlar || []));
      ws['!cols'] = ((r.satirlar || [])[0] || []).map(() => ({ wch: 16 }));
      XLSX.utils.book_append_sheet(wb, ws, ad);
    }
    const ek = path.join(klasor, (String(b.dosyaAdi || UYGULAMA).replace(/[\\/:*?"<>|]/g, ' ').trim() || UYGULAMA) + '.xlsx');
    fs.writeFileSync(ek, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    ekler.push(ek);
  }
  const isDosya = path.join(klasor, 'is.json');
  fs.writeFileSync(isDosya, JSON.stringify({ gonderen: b.gonderen || '', kime, bilgi, konu: b.konu || 'Elektrik Analizi', govdeDosya, ekler, hemen: !!b.hemen }), 'utf8');
  // Bulutta 'Outlook'ta aç' mümkün değildir; SMTP ile doğrudan gönderilir
  const r = OUTLOOK_KULLAN ? await psCalistir(['-Is', isDosya]) : await smtpGonder({ gonderen: b.gonderen, kime, bilgi, konu: b.konu || 'Elektrik Analizi', govdeDosya, ekler });
  setTimeout(() => { try { fs.rmSync(klasor, { recursive: true, force: true }); } catch (e) { } }, 10 * 60 * 1000);
  if (r.ok) {
    const kayit = jsonOku(MAIL_ADRES_DOSYASI, { adresler: [] });
    kayit.adresler = [...new Set([...kime, ...bilgi, ...kayit.adresler])].slice(0, 200);
    jsonYaz(MAIL_ADRES_DOSYASI, kayit);
    log('Mail', r.durum, '→', kime.join(', '), bilgi.length ? '(bilgi: ' + bilgi.join(', ') + ')' : '', '·', b.konu);
  }
  return r;
}

// ─── HTTP sunucu ────────────────────────────────────────────────────────────────────────────────
function gonder(res, kod, veri, tip = 'application/json; charset=utf-8') {
  res.writeHead(kod, { 'Content-Type': tip, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(typeof veri === 'string' || Buffer.isBuffer(veri) ? veri : JSON.stringify(veri));
}
function govdeOku(req) {
  return new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 50 * 1024 * 1024) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Render sağlık kontrolü (giriş istemez, veri döndürmez)
  if (url.pathname === '/saglik') return gonder(res, 200, { ok: true });
  // Masaüstündeki senkron aracı: panel verisini buluta ekler (SENKRON_ANAHTARI ile)
  if (url.pathname === '/api/panel/yukle' && req.method === 'POST') {
    if (!process.env.SENKRON_ANAHTARI || req.headers['x-senkron-anahtari'] !== process.env.SENKRON_ANAHTARI) return gonder(res, 401, { ok: false, hata: 'Senkron anahtarı geçersiz.' });
    const b = await govdeOku(req);
    const son = await panelCek(b);
    if (b.ayarlar) { if (b.ayarlar.firma) jsonYaz(FIRMA_DOSYASI, b.ayarlar.firma); if (b.ayarlar.ges) jsonYaz(GES_AYAR_DOSYASI, b.ayarlar.ges); }
    return gonder(res, son && son.hata ? 500 : 200, { ok: !(son && son.hata), ...son });
  }
  // Giriş: APP_SIFRE tanımlıysa tüm sayfa ve API'ler kullanıcı adı/şifre ister
  if (process.env.APP_SIFRE) {
    const [tur, kod] = String(req.headers.authorization || '').split(' ');
    const [k, ...p] = tur === 'Basic' ? Buffer.from(kod || '', 'base64').toString('utf8').split(':') : [];
    if (k !== (process.env.APP_KULLANICI || 'secen') || p.join(':') !== process.env.APP_SIFRE) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SECENGIDA ELEKTRIK ANALIZI", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Giriş gerekli.');
    }
  }
  try {
    if (req.method === 'OPTIONS') return gonder(res, 204, '');
    // Belgeler sayfası ve dosyaları (yalnızca Supabase Storage'da tutulur)
    if (await BELGE.yonet(req, res, url)) return;
    if (url.pathname === '/' || url.pathname === '/index.html') return gonder(res, 200, fs.readFileSync(HTML_DOSYASI), 'text/html; charset=utf-8');
    if (url.pathname === '/api/durum') {
      const ayar = ayarOku();
      return gonder(res, 200, { ok: true, uygulama: UYGULAMA, ortak: ortakDurum, kaynak: SG.durum, ...durum, kimlikVar: !!(ayar.kullanici && ayar.sifre), kullanici: ayar.kullanici || '' });
    }
    if (url.pathname === '/api/veri') {
      const ptf = jsonOku(PTF_DOSYASI, {});
      const aylar = pencereAylari();
      const secili = {};
      for (const g of Object.keys(ptf)) if (aylar.includes(g.slice(0, 7)) || g > aylar[aylar.length - 1]) secili[g] = ptf[g];
      const ayar = ayarOku();
      return gonder(res, 200, { panel: { ...panelDurum, adres: panelDurum.adres || ((MDEPO.oku().panelVeri || {}).adres) || null, sonBasari: panelDurum.sonBasari || ((MDEPO.oku().panelVeri || {}).alinma) || null }, yekdem: yekdemDurum, aylar, tarifeler, ptf: secili, sehirler: Object.keys(SEHIRLER), gunes: jsonOku(GUNES_DOSYASI, {}), bedeller: jsonOku(BEDEL_DOSYASI, {}), durum: { ...durum, kimlikVar: !!(ayar.kullanici && ayar.sifre) } });
    }
    if (url.pathname === '/api/ayar' && req.method === 'POST') {
      const b = await govdeOku(req);
      if (!b.kullanici || !b.sifre) return gonder(res, 400, { ok: false, hata: 'Kullanıcı adı ve şifre gerekli.' });
      jsonYaz(AYAR_DOSYASI, { ...jsonOku(AYAR_DOSYASI, {}), kullanici: String(b.kullanici).trim(), sifre: String(b.sifre) });
      tgt = null;
      try { await tgtAl(); } catch (e) { return gonder(res, 200, { ok: false, hata: e.message }); }
      ptfGuncelle();
      return gonder(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mahsup') return gonder(res, 200, mahsupRaporu());
    if (url.pathname === '/api/mahsup/panel-cek' && req.method === 'POST') { await panelCek(); return gonder(res, 200, mahsupRaporu()); }
    if (url.pathname === '/api/panel') return gonder(res, 200, panelRaporu());
    if (url.pathname === '/fatura-kontrol') return gonder(res, 200, fs.readFileSync(KONTROL_HTML), 'text/html; charset=utf-8');
    if (url.pathname === '/api/mail/bilgi') {
      if (!mailHesaplari) { if (OUTLOOK_KULLAN) { const h = await psCalistir(['-Hesaplar']); if (h.ok) mailHesaplari = h.hesaplar; } else mailHesaplari = (process.env.SMTP_GONDEREN || process.env.SMTP_KULLANICI || '').split(/[;,]/).map(x => x.trim()).filter(Boolean); }
      return gonder(res, 200, { ok: true, hesaplar: mailHesaplari || [], adresler: jsonOku(MAIL_ADRES_DOSYASI, { adresler: [] }).adresler });
    }
    if (url.pathname === '/api/mail' && req.method === 'POST') return gonder(res, 200, await mailGonder(await govdeOku(req)));
    if (url.pathname === '/aosb') return gonder(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'aosb.html')), 'text/html; charset=utf-8');
    if (url.pathname === '/api/aosb') return gonder(res, 200, aosbRaporu());
    if (url.pathname === '/api/aosb/yenile' && req.method === 'POST') { const son = await panelCek(); return gonder(res, 200, { ...aosbRaporu(), yenileme: son }); }
    if (url.pathname === '/ges-mahsup') return gonder(res, 200, fs.readFileSync(GES_HTML), 'text/html; charset=utf-8');
    if (url.pathname === '/api/ges-mahsup') return gonder(res, 200, gesMahsupRaporu());
    if (url.pathname === '/api/ges-mahsup/ayar' && req.method === 'POST') {
      const b = await govdeOku(req), a = jsonOku(GES_AYAR_DOSYASI, {});
      if (b.tur && typeof b.tur === 'object') a.tur = Object.fromEntries(Object.entries({ ...(a.tur || {}), ...b.tur }).filter(([, v]) => v === 'tarla' || v === 'cati'));
      if (Array.isArray(b.ekSozlesmeler)) a.ekSozlesmeler = [...new Set(b.ekSozlesmeler.map(String))];
      jsonYaz(GES_AYAR_DOSYASI, a);
      await supabaseGonder('GES ayarı', false);
      return gonder(res, 200, gesMahsupRaporu());
    }
    if (url.pathname === '/api/firma' && req.method === 'POST') {
      // { eslesme: { sozlesmeNo: firma | '' }, firmalar: [...] } — boş firma eşleştirmeyi kaldırır (tahmine döner)
      const b = await govdeOku(req), a = jsonOku(FIRMA_DOSYASI, {});
      if (Array.isArray(b.firmalar)) a.firmalar = [...new Set(b.firmalar.map(x => String(x).trim()).filter(Boolean))];
      if (b.eslesme && typeof b.eslesme === 'object') {
        a.eslesme = a.eslesme || {};
        for (const [no, f] of Object.entries(b.eslesme)) { const v = String(f || '').trim(); if (v) a.eslesme[no] = v; else delete a.eslesme[no]; }
        a.firmalar = [...new Set([...(a.firmalar || VARSAYILAN_FIRMALAR), ...Object.values(a.eslesme)])];
      }
      // { guvenceGecmis: { sozlesmeNo: [{ tarih: 'YYYY-MM-DD' | '', tutar }] } } — sözleşmenin tarihli güvence bedeli
      // (depozito) geçmişinin tamamı; boş liste sözleşmenin kayıtlarını siler. Eski tek tutarlı biçim bu kayda taşınır.
      if (b.guvenceGecmis && typeof b.guvenceGecmis === 'object') {
        a.guvenceGecmis = a.guvenceGecmis || {};
        for (const [no, l] of Object.entries(b.guvenceGecmis)) {
          const t = GUVENCE.temizle(l);
          if (t.length) a.guvenceGecmis[no] = t; else delete a.guvenceGecmis[no];
          if (a.guvence) delete a.guvence[no];
        }
      }
      jsonYaz(FIRMA_DOSYASI, a);
      await supabaseGonder('firma/güvence ayarı', false);
      return gonder(res, 200, faturaKiyasRaporu());
    }
    if (url.pathname === '/api/fatura-kiyas') return gonder(res, 200, faturaKiyasRaporu());
    if (url.pathname === '/api/fatura-kiyas/yenile' && req.method === 'POST') { const son = await panelCek(); await yekdemGuncelle(); return gonder(res, 200, { ...faturaKiyasRaporu(), yenileme: son }); }
    if (url.pathname === '/api/panel/yenile' && req.method === 'POST') { const son = await panelCek(); return gonder(res, 200, { ...panelRaporu(), yenileme: son }); }
    if (url.pathname === '/api/mahsup/olcum' && req.method === 'POST') {
      // Saatlik sayaç (OSOS) dosyası: { dosyaAdi, base64, tesisatNo? } — Excel veya CSV
      const b = await govdeOku(req);
      const wb = XLSX.read(Buffer.from(b.base64 || '', 'base64'), { type: 'buffer', cellDates: false, raw: false });
      const satirlar = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      let bulunan;
      try { bulunan = MAHSUP.olcumCoz(satirlar); } catch (e) { return gonder(res, 200, { ok: false, hata: e.message }); }
      if (bulunan._ && !b.tesisatNo) return gonder(res, 200, { ok: false, hata: 'Dosyada tesisat numarası sütunu yok; yüklerken tesisat numarasını yazın.' });
      if (bulunan._) { bulunan[b.tesisatNo] = bulunan._; delete bulunan._; }
      const v = MDEPO.oku(); v.olcum = v.olcum || {};
      let gun = 0;
      for (const [no, gunler] of Object.entries(bulunan)) { v.olcum[no] = { ...(v.olcum[no] || {}), ...gunler }; gun += Object.keys(gunler).length; if (!v.tesisler[no]) v.tesisler[no] = { tesisatNo: no, tarifeSinifi: 'AG', zaman: 'tek', etv: 'diger', lu: 'LU2' }; }
      MDEPO.yaz(v);
      return gonder(res, 200, { ok: true, tesis: Object.keys(bulunan), gun });
    }
    if (url.pathname === '/api/mahsup/tesis' && req.method === 'POST') {
      const b = await govdeOku(req);
      if (!b.tesisatNo) return gonder(res, 400, { ok: false });
      const v = MDEPO.oku();
      const izin = ['ad', 'tarifeSinifi', 'zaman', 'etv', 'lu', 'sozlesmeGucuKw', 'kuruluGucKva'];
      v.tesisler[b.tesisatNo] = { ...(v.tesisler[b.tesisatNo] || { tesisatNo: b.tesisatNo }), ...Object.fromEntries(Object.entries(b).filter(([k]) => izin.includes(k))) };
      MDEPO.yaz(v);
      return gonder(res, 200, { ok: true });
    }
    if (url.pathname === '/api/excel' && req.method === 'POST') {
      const b = await govdeOku(req);
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(b.bilgi ? [[String(b.bilgi)], [], ...(b.satirlar || [])] : (b.satirlar || []));
      ws['!cols'] = (b.satirlar && b.satirlar[0] || []).map((_, i) => ({ wch: i === 0 ? 18 : 16 }));
      XLSX.utils.book_append_sheet(wb, ws, String(b.ad || 'Matris').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Access-Control-Allow-Origin': '*' });
      return res.end(buf);
    }
    if (url.pathname === '/api/yenile' && req.method === 'POST') {
      await Promise.all([ptfGuncelle(), tarifeKontrol(), bedelleriGuncelle()]);
      return gonder(res, 200, { ok: true, ...durum });
    }
    gonder(res, 404, { ok: false });
  } catch (e) {
    gonder(res, 500, { ok: false, hata: e.message });
  }
}).listen(PORT, () => log(UYGULAMA + ' sunucusu: http://localhost:' + PORT + (BULUT ? ' (bulut)' : '') + ' · veri klasörü: ' + VERI + (process.env.APP_SIFRE ? ' · giriş açık' : '')));

// ─── Otonom döngü ───────────────────────────────────────────────────────────────────────────────
ortakVeriAl();
tarifeleriYukle();
tarifeKontrol();
ptfGuncelle();
tumGunesleriTamamla();
bedelleriGuncelle();
yekdemGuncelle();
setInterval(ptfGuncelle, 60 * 60 * 1000);          // her saat: içinde bulunulan ay + yarın
// Elektrik paneli: 30 dakikada bir otomatik + 'Veriyi yenile' ile elle (/api/panel/yenile).
//  • Masaüstü: panel okunur, arşivlenir, Supabase'e yazılır (bilgisayar kapalıysa deneme günlüğe yazılır).
//    Supabase yoksa ve .env'de SENKRON_ANAHTARI + BULUT_URL varsa eski yolla buluta gönderilir.
//  • Bulut: veri Supabase'den okunur (panelCek → supabasedenYukle).
const otomatikPanel = async () => {
  const son = await panelCek();
  if (!BULUT && !SUPA.hazir && son && !son.hata && process.env.SENKRON_ANAHTARI && process.env.BULUT_URL) {
    require('child_process').execFile(process.execPath, [path.join(__dirname, 'araclar', 'panel_senkron.js')], { cwd: __dirname, timeout: 10 * 60 * 1000 }, (e, out, err) => log('Buluta senkron:', e ? 'HATA ' + String(err || e.message).trim() : String(out).trim().split(/\r?\n/).pop()));
  }
};
// SECENGIDA klasörü izlenir: yeni zip / PDF bırakılınca 10 sn içinde okunur
let izlemeZamani = null;
for (const k of SG_KLASORLER()) {
  try { fs.watch(k, { recursive: true }, () => { clearTimeout(izlemeZamani); izlemeZamani = setTimeout(() => { log('SECENGIDA klasöründe değişiklik: okunuyor'); otomatikPanel(); }, 10 * 1000); }); log('SECENGIDA klasörü izleniyor:', k); }
  catch (e) { log('Klasör izlenemedi:', k, e.message); }
}
if (!BULUT || SUPA.hazir) {
  setTimeout(otomatikPanel, BULUT ? 5 * 1000 : 3 * 1000);
  setInterval(otomatikPanel, 30 * 60 * 1000);
}
// günde bir: yeni EPDK tarifesi, eksik PVGIS şehri, EPDK kurul kararı bedelleri + 2464 s. Kanun ETV oranları
setInterval(() => { tarifeKontrol(); tumGunesleriTamamla(); bedelleriGuncelle(); yekdemGuncelle(); }, 24 * 60 * 60 * 1000);

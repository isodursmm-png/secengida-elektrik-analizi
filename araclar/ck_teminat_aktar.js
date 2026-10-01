// ck_teminat_aktar.js — CK Elektrik Excel'indeki TEMİNAT sayfasından güvence bedellerini sözleşmelere aktarır.
//
// ACCT_ID = Sözleşme No (Excel baştaki sıfırları atar; 10 haneye tamamlanır).
// GENEL_TOPLAM_GUVENCE (nakit + teminat mektubu) sözleşmenin "başlangıçtan beri" (tarihsiz) güvence kaydı olur;
// ekrandan eklenmiş tarihli kayıtlar korunur. Nakit / mektup / müşteri tipi kaydın açıklamasına yazılır.
// Kayıt çalışan ELEKTRİK ANALİZİ sunucusuna (/api/firma) yapılır: yerel ayar + Supabase birlikte güncellenir.
//
// Kullanım: node araclar/ck_teminat_aktar.js ["C:\...\CK ELEKTRİK.xlsx"] [--dene]
//   --dene: kaydetmeden yalnızca eşleşmeyi gösterir. Sunucu adresi: SUNUCU_URL (varsayılan http://localhost:5352)
const path = require('path');
const os = require('os');
const XLSX = require('xlsx');

const arg = process.argv.slice(2);
const DENE = arg.includes('--dene');
const DOSYA = arg.find(a => !a.startsWith('--')) || path.join(os.homedir(), 'Desktop', 'CK ELEKTRİK.xlsx');
const SUNUCU = (process.env.SUNUCU_URL || 'http://localhost:5352').replace(/\/+$/, '');
const tl = v => Number(v).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sayi = v => typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).trim().split('.').join('').replace(',', '.')) || 0;

(async () => {
  const wb = XLSX.readFile(DOSYA);
  const sayfaAdi = wb.SheetNames.find(n => /tem[iİı]nat/i.test(n));
  if (!sayfaAdi) throw new Error('Dosyada TEMİNAT sayfası yok: ' + wb.SheetNames.join(', '));
  const satirlar = XLSX.utils.sheet_to_json(wb.Sheets[sayfaAdi], { defval: null, raw: true });
  const al = (x, ...adlar) => { for (const a of adlar) { const k = Object.keys(x).find(k => k.trim().toLocaleUpperCase('tr-TR') === a); if (k) return x[k]; } return null; };

  const rapor = await (await fetch(SUNUCU + '/api/fatura-kiyas')).json();
  if (!rapor.var) throw new Error('Sunucuda fatura verisi yok.');
  const E = rapor.firmaBilgisi.eslesme;

  // Abone adı (NAME) → grup firması: firma adıyla başlayan unvan (ör. "TAHTAKALE SPOT MAĞAZACILIK … A.Ş." → TAHTAKALE).
  // Yalnızca firması ATANMAMIŞ sözleşmelere uygulanır; onaylı ya da otomatik yorumlu firmaya dokunulmaz.
  const firmalar = rapor.firmaBilgisi.firmalar.slice().sort((a, b) => b.length - a.length);
  const aboneFirmasi = ad => { const u = String(ad || '').toLocaleUpperCase('tr-TR'); return firmalar.find(f => u.startsWith(f.toLocaleUpperCase('tr-TR').replace(/\s*\(.*\)$/, ''))) || null; };
  const guvenceGecmis = {}, eslesmeyen = [], eslesme = {};
  let toplam = 0, sifir = 0;
  for (const x of satirlar) {
    const ham = al(x, 'ACCT_ID');
    if (ham == null || ham === '') continue;
    const no = String(ham).trim().replace(/\.0+$/, '').padStart(10, '0');
    const nakit = sayi(al(x, 'NAKIT')), mektup = sayi(al(x, 'TEMINAT_MEKTUBU')), genel = Math.round((sayi(al(x, 'GENEL_TOPLAM_GUVENCE')) || nakit + mektup) * 100) / 100;
    const tip = al(x, 'MUSTERI_TIPI'), aciklama = al(x, 'AÇIKLAMA', 'ACIKLAMA'), abone = al(x, 'NAME');
    if (!E[no]) { eslesmeyen.push({ no, genel, tip }); continue; }
    const f = aboneFirmasi(abone);
    if (E[no].atanmamis && f) eslesme[no] = f;
    const not = ['CK Elektrik TEMİNAT · ' + path.basename(DOSYA), abone ? 'abone ' + abone : '', 'nakit ' + tl(nakit), 'teminat mektubu ' + tl(mektup), tip ? 'müşteri tipi ' + tip : '', aciklama || ''].filter(Boolean).join(' · ');
    // Tarihli kayıtlar korunur; tarihsiz (başlangıçtan beri) kayıt CK tutarıyla değişir
    guvenceGecmis[no] = [{ tarih: '', tutar: genel, not }, ...(E[no].guvenceGecmis || []).filter(g => g.tarih)];
    toplam += genel; if (!genel) sifir++;
  }
  const n = Object.keys(guvenceGecmis).length;
  console.log('Dosya:', DOSYA, '· sayfa:', sayfaAdi, '·', satirlar.length, 'satır');
  console.log('Eşleşen sözleşme:', n, '(güvence > 0:', n - sifir + ', sıfır:', sifir + ') · toplam', tl(toplam), 'TL');
  console.log('Eşleşmeyen ACCT_ID:', eslesmeyen.length, '· toplam', tl(eslesmeyen.reduce((a, x) => a + x.genel, 0)), 'TL (panelde faturası olmayan sözleşmeler)');
  for (const x of eslesmeyen) console.log('   ', x.no, tl(x.genel).padStart(12), x.tip || '');
  const kapsamDisi = Object.keys(E).filter(no => !guvenceGecmis[no]);
  console.log('Panelde olup CK dosyasında olmayan:', kapsamDisi.map(no => no + ' ' + (E[no].lokasyon || '')).join(' · ') || '—');
  const atanan = Object.entries(eslesme).reduce((a, [no, f]) => { (a[f] = a[f] || []).push(E[no].grup || '(grupsuz)'); return a; }, {});
  console.log('Atanmamış → abone firması:', Object.entries(atanan).map(([f, g]) => f + ' ' + g.length + ' sözleşme (' + Object.entries(g.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {})).map(([k, v]) => k + ' ' + v).join(', ') + ')').join(' · ') || '—');
  if (DENE) { console.log('--dene: kaydedilmedi.'); return; }

  const r = await fetch(SUNUCU + '/api/firma', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guvenceGecmis, ...(Object.keys(eslesme).length ? { eslesme, firmalar: rapor.firmaBilgisi.firmalar } : {}) }) });
  const j = await r.json();
  if (!j.var) throw new Error('Kaydedilemedi: HTTP ' + r.status);
  const kayitli = Object.values(j.firmaBilgisi.eslesme).filter(e => e.guvence != null).length;
  console.log('Kaydedildi · güvence bedeli olan sözleşme:', kayitli);
})().catch(e => { console.error('HATA:', e.message); process.exitCode = 1; });

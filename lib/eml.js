'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  eml.js — E-posta taslağı (.eml) üretici. Outlook'a ve Windows'a bağlı DEĞİLDİR.
//  Uygulama e-postayı kendisi göndermez: kullanıcının VARSAYILAN MAİL UYGULAMASINDA açılacak,
//  gönderilmemiş (X-Unsent: 1) bir taslak üretir. Tarayıcı dosyayı indirir; Outlook, Thunderbird,
//  Windows Posta, Apple Mail vb. bunu alıcıları, konusu, HTML gövdesi ve ekleriyle düzenlenebilir
//  yeni ileti olarak açar; kullanıcı kontrol edip kendi hesabından gönderir.
//  Biçim SC Grup portalındaki portal/lib/eml.js ile aynıdır (bağımsız kopya; portaldan yüklenmez).
// ─────────────────────────────────────────────────────────────────────────────

const ADRES = /^[^\s@;,<>]+@[^\s@;,<>]+\.[^\s@;,<>]+$/;
// "a@x.com; b@y.com" ya da dizi → temiz adres listesi
const liste = v => (Array.isArray(v) ? v : String(v || '').split(/[;,\s]+/)).map(s => String(s).trim()).filter(Boolean);

// RFC 2047: ASCII dışı başlık metni =?UTF-8?B?...?= biçiminde kodlanır (Türkçe konu / dosya adları)
const baslik = s => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
// base64, satır başına 76 karakter (RFC 2045)
const b64 = buf => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
const MIME = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  csv: 'text/csv', html: 'text/html', htm: 'text/html', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip: 'application/zip' };
const tur = ad => MIME[String(ad).split('.').pop().toLowerCase()] || 'application/octet-stream';

// b: { kime, bilgi, konu, html | metin, ekler: [{ ad, icerik: Buffer|string }] } → { ad, icerik: Buffer, kime, bilgi }
function olustur(b) {
  const kime = liste(b.kime), bilgi = liste(b.bilgi), hatali = [...kime, ...bilgi].filter(a => !ADRES.test(a));
  if (!kime.length) throw new Error('Alıcı (Kime) adresi girilmedi');
  if (hatali.length) throw new Error('Geçersiz e-posta adresi: ' + hatali.join(', '));
  const sinir = 'scgrup-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const html = b.html != null ? String(b.html)
    : '<div style="font:11pt Calibri,Arial,sans-serif;color:#1f2937">' + String(b.metin || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]).replace(/\r?\n/g, '<br>') + '</div>';
  const satirlar = [
    'X-Unsent: 1',                                   // Outlook / Thunderbird: gönderilmemiş taslak olarak aç
    'To: ' + kime.join(', '),
    ...(bilgi.length ? ['Cc: ' + bilgi.join(', ')] : []),
    'Subject: ' + baslik(String(b.konu || '').replace(/[\r\n]+/g, ' ').slice(0, 250)),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + sinir + '"',
    '',
    '--' + sinir,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(Buffer.from('<html><head><meta charset="utf-8"></head><body>' + html + '</body></html>', 'utf8'))
  ];
  for (const e of b.ekler || []) {
    const ad = String(e.ad || 'ek.dat').replace(/[\\/:*?"<>|\r\n]/g, '_');
    satirlar.push('--' + sinir,
      'Content-Type: ' + tur(ad) + '; name="' + baslik(ad) + '"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="' + baslik(ad) + '"',
      '',
      b64(Buffer.isBuffer(e.icerik) ? e.icerik : Buffer.from(String(e.icerik || ''), 'utf8')));
  }
  satirlar.push('--' + sinir + '--', '');
  const konuAd = String(b.konu || 'eposta').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 60) || 'eposta';
  return { ad: konuAd + '.eml', icerik: Buffer.from(satirlar.join('\r\n'), 'utf8'), kime, bilgi };
}

// JSON yanıtına konacak biçim: tarayıcı (public/*.html → emlIndir) indirir, varsayılan mail uygulaması açar
function yanit(b) {
  const e = olustur(b);
  return { durum: 'taslak', eml: e.icerik.toString('base64'), emlAd: e.ad, kime: e.kime, bilgi: e.bilgi };
}

module.exports = { olustur, yanit, liste, ADRES };

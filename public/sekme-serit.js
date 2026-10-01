// sekme-serit.js — Sekme şeridi (Elektrik Analizi · Fatura Kontrol · AOSB · Belgeler · Referans · Geri dön · Tam ekran ·
// Yazdır · Mail) sayfanın başlık şeridinin ALTINDA durur. Sayfa ana sayfanın (index.html) çerçevesinde açıldığında
// ana sayfanın şeridi gizlidir; bu script şeridin bir kopyasını sayfanın başlığının altına çizer. Düğmeler ana
// sayfadakilere tıklar (aynı iş), etiketler (ör. "Tam ekrandan çık") ana sayfayla eşitlenir.
//
// Firma etiketi "SECEN UNLU MAMÜLLER ELEKTRİK ANALİZİ": başlık şeritlerinin boş alanına ve her tablo / rapor başlığına
// (yeniden çizilen başlıklar da izlenir). Sayfa çerçevesiz açıldığında da eklenir.
(function () {
  const ETIKET = 'SECEN UNLU MAMÜLLER ELEKTRİK ANALİZİ';
  const ESTIL = '.firma-etiket{flex:1 1 260px;text-align:center;font:900 17px "Segoe UI",Arial,sans-serif;letter-spacing:1.5px;color:#f7dc6f;text-shadow:0 1px 3px rgba(0,0,0,.45);line-height:1.25;min-width:0;padding:0 10px}'
    + '.firma-rozet{display:inline-block;margin-left:auto;font:900 11.5px "Segoe UI",Arial,sans-serif;letter-spacing:.8px;color:#1a3a6b;background:linear-gradient(#f9e79f,#f4d03f);border:1px solid #d4ac0d;border-radius:12px;padding:2px 11px;white-space:nowrap;vertical-align:middle;box-shadow:0 1px 4px rgba(0,0,0,.3)}'
    + 'h2 > .firma-rozet,h3 > .firma-rozet{float:right;margin-top:2px}';
  function etiketle() {
    if (!document.getElementById('firmaEtiketStil')) { const s = document.createElement('style'); s.id = 'firmaEtiketStil'; s.textContent = ESTIL; document.head.appendChild(s); }
    // Başlık şeridi: .ust içindeki boşluk ya da ana sayfanın <header>'ı
    const ust = document.querySelector('.ust');
    if (ust && !ust.querySelector('.firma-etiket')) {
      const b = ust.querySelector(':scope > .bosluk'), e = document.createElement('div'); e.className = 'firma-etiket'; e.textContent = ETIKET;
      if (b) b.replaceWith(e); else ust.insertBefore(e, ust.children[1] || null);
    }
    const hd = document.querySelector('#sekmeAnaliz > header');
    if (hd && !hd.querySelector('.firma-etiket')) { const e = document.createElement('div'); e.className = 'firma-etiket'; e.textContent = ETIKET; hd.insertBefore(e, hd.querySelector('.sag')); }
    // Tablo / rapor başlıkları: sağına rozet
    for (const h of document.querySelectorAll('.baslik, .panel > h2, .matris > h3, .ges-ur > h3')) {
      if (h.querySelector('.firma-rozet')) continue;
      const r = document.createElement('span'); r.className = 'firma-rozet'; r.textContent = ETIKET;
      if (h.classList.contains('baslik')) { const ara = h.querySelector(':scope > .bosluk'); if (ara) ara.after(r); else h.appendChild(r); } else h.appendChild(r);
    }
  }
  function izle() {
    etiketle();
    let bekle = null;
    new MutationObserver(() => { clearTimeout(bekle); bekle = setTimeout(etiketle, 50); }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', izle); else izle();
})();

(function () {
  let P;
  try { P = window.parent; if (P === window || !P.sekmeAc) return; P.document; } catch (e) { return; }
  const STIL = '.sekmeler-ic{display:flex;gap:4px;background:#1a3a6b;padding:0 22px;flex:0 0 100%;align-self:stretch;box-sizing:border-box}'
    + '.ust .sekmeler-ic{margin:4px -20px -12px;width:calc(100% + 40px);flex-basis:calc(100% + 40px)}'
    + '.sekmeler-ic.ayri{position:sticky;top:0;z-index:30;margin:0 0 12px;border-radius:0 0 8px 8px;box-shadow:0 2px 6px rgba(0,0,0,.15)}'
    + '.sekmeler-ic .sekme{background:linear-gradient(#f0913a,#d9661a);color:#fff;border:1px solid #b9540f;border-bottom:none;border-radius:8px 8px 0 0;padding:8px 20px 9px;font:700 13.5px "Segoe UI",Arial,sans-serif;cursor:pointer;margin-top:6px;text-shadow:0 1px 1px rgba(0,0,0,.25);box-shadow:inset 0 1px 0 rgba(255,255,255,.28);transition:background .15s,transform .15s}'
    + '.sekmeler-ic .sekme:hover{background:linear-gradient(#f7a45a,#e67e22);transform:translateY(-1px)}.sekmeler-ic .sekme.aktif{background:#f4f6fa;color:#1a3a6b;border-color:#f4f6fa;border-top:4px solid #e67e22;padding-top:5px;text-shadow:none;box-shadow:0 -2px 8px rgba(0,0,0,.18);transform:none}'
    + '.sekmeler-ic .sekme-arac{margin-left:auto;display:flex;gap:6px;align-items:center;padding:5px 0}'
    + '.sekmeler-ic .sekme-arac button{background:#fff;color:#1a3a6b;border:1px solid #fff;border-radius:6px;padding:6px 12px;font:700 12.5px "Segoe UI",Arial,sans-serif;cursor:pointer}'
    + '.sekmeler-ic .sekme-arac button:hover{background:#dfe7f3}.sekmeler-ic .sekme-arac button.mail{background:#1e8449;color:#fff;border-color:#1e8449}'
    + '.sekmeler-ic .sekme-arac button.geri{background:#e67e22;color:#fff;border-color:#e67e22}';
  function kur() {
    const pn = P.document.querySelector('nav.sekmeler');
    if (!pn || document.querySelector('.sekmeler-ic')) return;
    const st = document.createElement('style'); st.textContent = STIL; document.head.appendChild(st);
    const nav = pn.cloneNode(true);
    nav.className = 'sekmeler-ic';
    const orj = [...pn.querySelectorAll('button')], kop = [...nav.querySelectorAll('button')];
    kop.forEach((b, i) => { b.removeAttribute('onclick'); b.removeAttribute('id'); b.onclick = () => { orj[i].click(); setTimeout(esitle, 150); }; });
    function esitle() { kop.forEach((b, i) => { b.className = orj[i].className; b.textContent = orj[i].textContent; b.title = orj[i].title; }); }
    // Hangi sekmedeysem o sekme aktif görünsün (çerçevenin kimliğinden)
    const benim = { kontrolCerceve: 'skKontrol', gesCerceve: 'skGes', belgeCerceve: 'skBelgeler', referansCerceve: 'skReferans' }[(window.frameElement || {}).id];
    esitle();
    if (benim) kop.forEach((b, i) => { if (orj[i].classList.contains('sekme')) b.classList.toggle('aktif', orj[i].id === benim); });
    const ust = document.querySelector('.ust');
    if (ust) {
      const once = ust.offsetHeight;
      ust.appendChild(nav);
      // Başlık uzadı: altındaki yapışkan bölümler (sol menü vb.) o kadar aşağıdan başlasın
      const fark = ust.offsetHeight - once;
      for (const el of document.querySelectorAll('.sol, .duzen')) {
        const cs = getComputedStyle(el);
        if (cs.position === 'sticky') { const t = parseFloat(cs.top) || 0; el.style.top = (t + fark) + 'px'; el.style.height = 'calc(100vh - ' + (t + fark) + 'px)'; }
        else if (el.classList.contains('duzen')) el.style.minHeight = 'calc(100vh - ' + ust.offsetHeight + 'px)';
      }
    } else {
      // Başlık kutusu + açıklama olan sayfalar (Belgeler, Referans): açıklamanın altına
      nav.classList.add('ayri');
      const ac = document.querySelector('.kap > .aciklama') || document.querySelector('.kap > .baslik');
      if (ac) ac.after(nav); else document.body.prepend(nav);
    }
    try { P.document.addEventListener('fullscreenchange', () => setTimeout(esitle, 100)); } catch (e) { }
    window.addEventListener('focus', esitle);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', kur); else kur();
})();

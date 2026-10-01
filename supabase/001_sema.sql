-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- ELEKTRİK ANALİZİ · Supabase (PostgreSQL) şeması
-- Supabase → SQL Editor → New query → bu dosyanın tamamını yapıştırıp Run. Tekrar çalıştırmak güvenlidir.
-- Tablolar public şemasında "elektrik_" önekiyle durur (Supabase API'sine ek ayar gerekmeden açıktır).
-- Veriyi uygulama kendisi yazar (lib/elektrik_supabase.js); elle yükleme için: node araclar/supabase_yukle.js
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ─── Grup firmaları ───────────────────────────────────────────────────────────────────────────
create table if not exists public.elektrik_firmalar (
  ad          text primary key,                         -- SECEN, SECENGIDA, TAHTAKALE …
  olusturma   timestamptz not null default now()
);

-- ─── Sözleşmeler (sayaç / lokasyon) ───────────────────────────────────────────────────────────
create table if not exists public.elektrik_sozlesmeler (
  sozlesme_no        text primary key,
  lokasyon           text,
  panel_grubu        text,                               -- panelden gelen grup (TAHTAKALE SPOT, GES, MESKEN …)
  firma              text references public.elektrik_firmalar(ad) on update cascade,
  firma_onayli       boolean not null default false,     -- false: panel grubundan otomatik yorum
  ges_turu           text check (ges_turu in ('cati', 'tarla')),
  guvence_bedeli_tl  numeric(14, 2),                     -- elle girilen güvence bedeli (depozito)
  guvence_notu       text,
  guncelleme         timestamptz not null default now()
);

-- ─── Faturalar (panelden okunan; hiçbir kayıt silinmez) ───────────────────────────────────────
create table if not exists public.elektrik_faturalar (
  id               bigint generated always as identity primary key,
  sozlesme_no      text not null references public.elektrik_sozlesmeler(sozlesme_no) on update cascade,
  donem            date not null,                        -- fatura dönemi, ayın 1'i (2026-08-01)
  lokasyon         text,                                 -- faturadaki hali
  panel_grubu      text,
  tuketim_kwh      numeric(16, 3),
  odenecek_tl      numeric(16, 2),
  birim_fiyat_tl   numeric(12, 6),                       -- TL/kWh
  dosya            text not null default '',             -- PDF dosya adı
  dosya_yolu       text,
  ilk_gorulme      timestamptz,
  son_degisiklik   timestamptz,
  constraint elektrik_faturalar_tekil unique (sozlesme_no, donem, dosya)
);
create index if not exists elektrik_faturalar_donem_idx on public.elektrik_faturalar (donem);

-- ─── GES saatlik çekiş / veriş (tüm GES sayaçlarının toplamı, kWh) ─────────────────────────────
create table if not exists public.elektrik_ges_saatlik (
  gun         date not null,
  saat        smallint not null check (saat between 0 and 23),
  cekis_kwh   numeric(14, 3) not null default 0,
  veris_kwh   numeric(14, 3) not null default 0,
  net_kwh     numeric(14, 3) generated always as (cekis_kwh - veris_kwh) stored,
  primary key (gun, saat)
);

-- ─── Panel okuma günlüğü (başarılı / başarısız her deneme) ────────────────────────────────────
create table if not exists public.elektrik_panel_okumalari (
  id           bigint generated always as identity primary key,
  zaman        timestamptz not null default now(),
  basarili     boolean not null,
  kaynak       text,                                     -- masaüstü / bulut
  adres        text,
  gelen        integer,
  yeni         integer,
  guncellenen  integer,
  hata         text
);

-- ─── Raporlama görünümleri ────────────────────────────────────────────────────────────────────
create or replace view public.v_elektrik_fatura_detay with (security_invoker = true) as
select f.*, s.firma, s.guvence_bedeli_tl,
       extract(year from f.donem)::int as yil, extract(month from f.donem)::int as ay
from public.elektrik_faturalar f
left join public.elektrik_sozlesmeler s using (sozlesme_no);

create or replace view public.v_elektrik_aylik_firma_ozeti with (security_invoker = true) as
select f.donem, coalesce(s.firma, 'Atanmamış') as firma,
       count(*) as fatura_adedi, sum(f.tuketim_kwh) as tuketim_kwh, sum(f.odenecek_tl) as odenecek_tl,
       round(sum(f.odenecek_tl) / nullif(sum(f.tuketim_kwh), 0), 4) as ortalama_birim_tl
from public.elektrik_faturalar f
left join public.elektrik_sozlesmeler s using (sozlesme_no)
group by 1, 2;

create or replace view public.v_elektrik_ges_aylik with (security_invoker = true) as
select date_trunc('month', gun)::date as ay,
       sum(cekis_kwh) as cekis_kwh, sum(veris_kwh) as veris_kwh,
       sum(greatest(net_kwh, 0)) as saatlik_tuketim_kwh, sum(greatest(-net_kwh, 0)) as saatlik_fazla_kwh,
       greatest(sum(cekis_kwh) - sum(veris_kwh), 0) as aylik_tuketim_kwh
from public.elektrik_ges_saatlik
group by 1;

-- ─── Güvenlik: şirket verisi · anonim erişim KAPALI ───────────────────────────────────────────
-- RLS açık ve politika yok → yalnızca service_role / secret anahtar (uygulama sunucusu) okuyup yazabilir.
alter table public.elektrik_firmalar        enable row level security;
alter table public.elektrik_sozlesmeler     enable row level security;
alter table public.elektrik_faturalar       enable row level security;
alter table public.elektrik_ges_saatlik     enable row level security;
alter table public.elektrik_panel_okumalari enable row level security;
-- Supabase girişi yapan kullanıcılar okuyabilsin isterseniz (örnek):
-- create policy "giris_yapan_okur" on public.elektrik_faturalar for select to authenticated using (true);

-- API'nin yeni tabloları hemen görmesi için
notify pgrst, 'reload schema';

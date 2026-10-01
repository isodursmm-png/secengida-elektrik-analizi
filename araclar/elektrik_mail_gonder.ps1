# elektrik_mail_gonder.ps1 — ELEKTRİK ANALİZİ mail gönderimi (Outlook COM)
# Sunucu (elektrik_analizi_server.js) iş dosyasını JSON olarak yazar; bu betik okur, Outlook'ta
# mail oluşturur. hemen=true ise gönderir, değilse Outlook'ta açar (kullanıcı kontrol edip gönderir).
# -Hesaplar verilirse sadece Outlook hesap listesini JSON döndürür.
param([string]$Is, [switch]$Hesaplar, [switch]$Deneme)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $ol = New-Object -ComObject Outlook.Application
  if ($Hesaplar) {
    $liste = @($ol.Session.Accounts | ForEach-Object { $_.SmtpAddress })
    ConvertTo-Json -InputObject @{ ok = $true; hesaplar = $liste } -Compress
    exit 0
  }
  $j = Get-Content -LiteralPath $Is -Raw -Encoding UTF8 | ConvertFrom-Json
  $m = $ol.CreateItem(0)
  if ($j.gonderen) {
    $hesap = $ol.Session.Accounts | Where-Object { $_.SmtpAddress -eq $j.gonderen } | Select-Object -First 1
    if ($hesap) { $m.SendUsingAccount = $hesap }
  }
  $m.To = (@($j.kime) -join '; ')
  if (@($j.bilgi).Count) { $m.CC = (@($j.bilgi) -join '; ') }
  $m.Subject = $j.konu
  $m.HTMLBody = Get-Content -LiteralPath $j.govdeDosya -Raw -Encoding UTF8
  foreach ($e in @($j.ekler)) { if ($e) { [void]$m.Attachments.Add([string]$e) } }
  [void]$m.Recipients.ResolveAll()
  if ($Deneme) { $ek = $m.Attachments.Count; $al = $m.Recipients.Count; $m.Delete(); ConvertTo-Json -InputObject @{ ok = $true; durum = 'deneme'; alici = $al; ek = $ek } -Compress; exit 0 }
  if ($j.hemen) { $m.Send(); $durum = 'gonderildi' } else { $m.Display($false); $durum = 'acildi' }
  ConvertTo-Json -InputObject @{ ok = $true; durum = $durum } -Compress
} catch {
  ConvertTo-Json -InputObject @{ ok = $false; hata = $_.Exception.Message } -Compress
}

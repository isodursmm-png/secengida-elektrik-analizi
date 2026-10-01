' Görev Zamanlayıcı için: PANEL_SENKRON'u pencere açmadan çalıştırır, çıktıyı panel_senkron.log'a ekler
Set fso = CreateObject("Scripting.FileSystemObject")
kok = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
CreateObject("WScript.Shell").Run "cmd /c cd /d """ & kok & """ && echo ==== %date% %time% >> panel_senkron.log && node araclar\panel_senkron.js >> panel_senkron.log 2>&1", 0, True

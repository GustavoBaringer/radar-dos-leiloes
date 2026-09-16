#!/usr/bin/env bash
# Desfaz o que expor-na-rede.sh fez: remove o encaminhamento e a regra de firewall.
set -euo pipefail
PORTA=4500
WINUSER=$(powershell.exe -NoProfile -Command '$env:USERNAME' 2>/dev/null | tr -d '\r\n')
TMP="/mnt/c/Users/$WINUSER/AppData/Local/Temp"
cat > "$TMP/fechar-$PORTA.ps1" <<PS1
netsh interface portproxy delete v4tov4 listenport=$PORTA listenaddress=0.0.0.0
Get-NetFirewallRule -DisplayName 'WSL Radar de Leiloes $PORTA' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Output 'removido'
PS1
sed -i 's/$/\r/' "$TMP/fechar-$PORTA.ps1"
echo "abrindo o UAC, clique em Sim"
powershell.exe -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\\Users\\$WINUSER\\AppData\\Local\\Temp\\fechar-$PORTA.ps1'" >/dev/null 2>&1
echo "porta $PORTA fechada na rede local"

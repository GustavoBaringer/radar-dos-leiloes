#!/usr/bin/env bash
# Expõe a porta 4500 para a rede local (celular no mesmo wifi).
#
# Necessário porque o WSL2 roda numa VM NATeada: o servidor escuta em
# 0.0.0.0:4500 DENTRO do WSL, mas outros aparelhos da LAN não enxergam isso.
# O Windows precisa escutar na LAN e repassar para o IP do WSL.
#
# O IP do WSL MUDA a cada reinício, então rode de novo depois de reiniciar.
# Dispara UAC: é preciso clicar em Sim na janela do Windows.
set -euo pipefail
PORTA=4500
WSLIP=$(hostname -I | awk '{print $1}')
WINUSER=$(powershell.exe -NoProfile -Command '$env:USERNAME' 2>/dev/null | tr -d '\r\n')
TMP="/mnt/c/Users/$WINUSER/AppData/Local/Temp"

cat > "$TMP/expor-$PORTA.ps1" <<PS1
\$ErrorActionPreference = 'Stop'
netsh interface portproxy delete v4tov4 listenport=$PORTA listenaddress=0.0.0.0 2>\$null | Out-Null
netsh interface portproxy add v4tov4 listenport=$PORTA listenaddress=0.0.0.0 connectport=$PORTA connectaddress=$WSLIP
Get-NetFirewallRule -DisplayName 'WSL Radar de Leiloes $PORTA' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'WSL Radar de Leiloes $PORTA' -Direction Inbound -Action Allow \`
  -Protocol TCP -LocalPort $PORTA -RemoteAddress LocalSubnet -Profile Private,Domain | Out-Null
netsh interface portproxy show v4tov4
PS1
sed -i 's/$/\r/' "$TMP/expor-$PORTA.ps1"

echo "IP do WSL: $WSLIP — abrindo o UAC, clique em Sim"
powershell.exe -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\\Users\\$WINUSER\\AppData\\Local\\Temp\\expor-$PORTA.ps1'" >/dev/null 2>&1

LANIP=$(powershell.exe -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.IPAddress -like '192.168.*' -or \$_.IPAddress -like '10.*' } | Select-Object -First 1).IPAddress" 2>/dev/null | tr -d '\r\n')
echo "Acesse do celular: http://$LANIP:$PORTA"

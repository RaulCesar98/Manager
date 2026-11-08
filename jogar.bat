@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Manager
echo.
echo  Iniciando o Manager... o navegador vai abrir sozinho.
echo  Deixe esta janela aberta enquanto joga. Para parar, feche-a ou aperte Ctrl+C.
node --experimental-strip-types --no-warnings server\main.ts --abrir
echo.
echo  O servidor parou. Se apareceu um erro acima, confira se o Node 22.6 ou mais novo esta instalado.
pause

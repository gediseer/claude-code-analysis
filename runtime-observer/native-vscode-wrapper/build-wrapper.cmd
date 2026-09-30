@echo off
setlocal
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo C# compiler not found: %CSC% 1>&2
  exit /b 1
)
set "OUT=%~dp0..\..\..\..\agent-maestro-observer\.observer-native\bin"
if not exist "%OUT%" mkdir "%OUT%"
"%CSC%" /nologo /target:exe /optimize+ /debug- /out:"%OUT%\claude-observer-wrapper.exe" "%~dp0Program.cs"
exit /b %ERRORLEVEL%

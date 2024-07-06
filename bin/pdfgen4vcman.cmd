@ECHO OFF

SETLOCAL

SET "NODE_EXE=%~dp0\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)

SET "PDFGEN4VCMAN_CLI_JS=%~dp0\node_modules\pdfgen4vcman\bin\pdfgen4vcman-cli.js"
"%NODE_EXE%" "%PDFGEN4VCMAN_CLI_JS%" %*

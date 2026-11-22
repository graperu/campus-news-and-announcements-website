@echo off
setlocal EnableExtensions DisableDelayedExpansion
title UTH Campus - Dang nhap AWS
set "AWS_PAGER="
set "CAMPUS_AWS_CLI=%~dp0..\..\storage\tmp\tools\aws-cli-v2\Amazon\AWSCLIV2\aws.exe"
if exist "%CAMPUS_AWS_CLI%" goto ready
where aws.exe >nul 2>nul
if errorlevel 1 goto missing
set "CAMPUS_AWS_CLI=aws.exe"

:ready
echo UTH CAMPUS - AWS LOGIN
echo.
echo 1. Open the AWS URL printed below in your browser.
echo 2. Sign in and approve access for the AWS command-line tool.
echo 3. Paste the authorization code from AWS into THIS window.
echo Do not send passwords, OTPs, access keys, or the code in chat.
echo.
"%CAMPUS_AWS_CLI%" login --remote --profile uth-campus-project --region ap-southeast-2 --no-cli-pager
if errorlevel 1 goto failed
echo.
"%CAMPUS_AWS_CLI%" sts get-caller-identity --profile uth-campus-project --region ap-southeast-2 --no-cli-pager
if errorlevel 1 goto failed
echo.
echo AWS sign-in completed. Return to the assistant to continue deployment.
pause
exit /b 0

:missing
echo AWS CLI v2 was not found. Install it from https://aws.amazon.com/cli/
pause
exit /b 1

:failed
echo.
echo AWS sign-in did not finish. Check the error above and run this script again.
pause
exit /b 1

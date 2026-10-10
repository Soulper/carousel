@echo off
REM Carousel Studio - local dev server
REM Double-click this, or run it from a terminal.

cd /d "%~dp0"

REM ---- Login for the browser prompt ------------------------------------
REM Change these before sharing the machine. They're only read from this
REM script's environment, so nothing is written to disk.
if not defined STUDIO_USER set "STUDIO_USER=studio"
if not defined STUDIO_PASSWORD set "STUDIO_PASSWORD=studio"

REM ---- Chrome for rendering --------------------------------------------
REM puppeteer-core doesn't bundle a browser. Point it at your installed
REM Chrome; the app skips this on Vercel and uses @sparticuz/chromium.
if not defined CHROME_EXECUTABLE_PATH (
  if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_EXECUTABLE_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  ) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_EXECUTABLE_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  ) else if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_EXECUTABLE_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"
  ) else (
    echo.
    echo   Chrome not found. Install it, or set CHROME_EXECUTABLE_PATH
    echo   yourself before running this again.
    echo.
  )
)

REM ---- Dependencies -----------------------------------------------------
if not exist "node_modules" (
  echo Installing dependencies. This only happens once...
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed. Check your connection and try again.
    pause
    exit /b 1
  )
)

REM ---- Port -------------------------------------------------------------
REM Pinning the port matters more than it looks: without it, Next quietly
REM moves to 3001 when something else already holds 3000, and the old tab
REM keeps talking to whichever server is still on 3000.
set "PORT=3000"

echo.
echo   Checking port %PORT%...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
  echo.
  echo   Port %PORT% is already in use by process %%p.
  echo   That's usually an older copy of this server. Close it and run again.
  echo   To stop it now:  taskkill /PID %%p /F
  echo.
  pause
  exit /b 1
)

echo.
echo   Carousel Studio  -  http://localhost:%PORT%
echo   Sign in with  %STUDIO_USER% / %STUDIO_PASSWORD%
echo   Preview mode unless .env.local has Supabase filled in.
echo   Press Ctrl+C to stop.
echo.

call npx next dev -p %PORT%

echo.
echo   Server stopped.
pause

# Скрипт для полной пересборки и запуска Synastry
# Сохрани как build_and_run.ps1 и запускай через PowerShell


# Перейти в корень проекта
cd c:\Users\user\Git\Synastry

# Завершить процессы
try {
    taskkill /IM Synastry.exe /F /T
} catch {}
try {
    taskkill /IM electron.exe /F /T
} catch {}

# Удалить старую сборку
try {
    Remove-Item -Recurse -Force release\win-unpacked
} catch {}

# Собрать проект (дистрибутив)
npm run dist

# Перейти в папку сборки
cd release\win-unpacked

# Включить логи и запустить
$env:ELECTRON_ENABLE_LOGGING=1
$env:ELECTRON_ENABLE_STACK_DUMPING=1
Start-Process .\Synastry.exe

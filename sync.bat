@echo off
echo Syncing to GitHub...
git add .
git commit -m "https://github.com/Youcheer/HealthApp.git"
git push origin main
echo Done!
pause
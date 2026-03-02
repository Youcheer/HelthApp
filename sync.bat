@echo off
echo ===================================
echo Health App - GitHub Sync Tool
echo ===================================

set "PATH=%PATH%;C:\Program Files\Git\cmd"

echo Added new changes...
git add .

echo Committing changes...
git commit -m "Auto Update %date% %time%"

echo Uploading to GitHub...
git push -u origin main

echo ===================================
echo Sync Completed Successfully!
echo ===================================
pause
@echo off
rem Run this yourself once: stops Windows from sleeping or hibernating while the PC is plugged in
rem (the bot only works while the PC is awake at the booking time). Screen off after 15 minutes is fine.
rem To undo later:  powercfg /change standby-timeout-ac 30
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 15
echo Done (plugged-in power only). Keep the laptop connected to the charger.
pause

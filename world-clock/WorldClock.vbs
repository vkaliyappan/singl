' Launches WorldClock.ps1 with no console window. Double-click this, or put a shortcut to it in shell:startup.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & dir & "\WorldClock.ps1""", 0, False

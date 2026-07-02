Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

Do
    WshShell.Run "cmd /c node server.mjs", 0, True
    WScript.Sleep 2000
Loop

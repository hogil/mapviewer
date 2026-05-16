Dim port
port = "8451"
If WScript.Arguments.Count > 0 Then
    port = WScript.Arguments(0)
End If

Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Environment("Process")("PYTHONIOENCODING") = "utf-8"
shell.Environment("Process")("PYTHONUNBUFFERED") = "1"
shell.Environment("Process")("AUTO_LOGIN") = "0"
shell.Environment("Process")("RELOAD") = "0"
shell.Environment("Process")("UVICORN_WORKERS") = "1"
shell.Environment("Process")("SSL_ENABLED") = "1"
shell.Environment("Process")("HTTPS_PORT") = port
shell.Environment("Process")("SSL_CERTFILE") = "cert/fullchain.pem"
shell.Environment("Process")("SSL_KEYFILE") = "cert/server.key"
shell.Environment("Process")("IMAGES_ROOT") = "E:/data/images"
shell.Environment("Process")("POSITIONS_ROOT") = "E:/data/positions"
shell.Environment("Process")("ACCESS_LOG_ENABLED") = "0"

Dim cmd
cmd = "cmd /c cd /d D:\project\mapviewer && python -m api.main"
shell.Run cmd, 0, False

WScript.Echo "STARTED:" & port

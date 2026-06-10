import Foundation
import Speech

struct Stderr: TextOutputStream {
    mutating func write(_ string: String) {
        FileHandle.standardError.write(Data(string.utf8))
    }
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    var err = Stderr()
    print(message, to: &err)
    exit(code)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail("usage: MacSpeechTranscriber <audio-file> [locale]")
}

let audioURL = URL(fileURLWithPath: args[1])
let localeID = args.count >= 3 ? args[2] : Locale.current.identifier
let locale = Locale(identifier: localeID)
let outputURL = args.count >= 4 ? URL(fileURLWithPath: args[3]) : nil
let errorURL = args.count >= 5 ? URL(fileURLWithPath: args[4]) : nil

func writeFile(_ url: URL?, _ text: String) {
    guard let url else { return }
    try? text.write(to: url, atomically: true, encoding: .utf8)
}

func finishError(_ message: String, code: Int32 = 1) -> Never {
    writeFile(errorURL, message)
    fail(message, code: code)
}

let authSemaphore = DispatchSemaphore(value: 0)
var authStatus = SFSpeechRecognizerAuthorizationStatus.notDetermined
SFSpeechRecognizer.requestAuthorization { status in
    authStatus = status
    authSemaphore.signal()
}
if authSemaphore.wait(timeout: .now() + .seconds(5)) == .timedOut {
    finishError("macOS 语音识别授权超时，请在系统设置中授予权限后重试。")
}

guard authStatus == .authorized else {
    finishError("macOS 语音识别权限未授权：\(authStatus.rawValue)")
}

guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer() else {
    finishError("当前系统没有可用的语音识别器。")
}

guard recognizer.isAvailable else {
    finishError("macOS 语音识别服务当前不可用。")
}

let request = SFSpeechURLRecognitionRequest(url: audioURL)
request.shouldReportPartialResults = false
if #available(macOS 10.15, *) {
    request.requiresOnDeviceRecognition = false
}

let semaphore = DispatchSemaphore(value: 0)
var finalText = ""
var finalError: Error?

let task = recognizer.recognitionTask(with: request) { result, error in
    if let result {
        finalText = result.bestTranscription.formattedString
        if result.isFinal {
            semaphore.signal()
        }
    }
    if let error {
        finalError = error
        semaphore.signal()
    }
}

let timeout = DispatchTime.now() + .seconds(90)
if semaphore.wait(timeout: timeout) == .timedOut {
    task.cancel()
    finishError("macOS 语音识别超时。")
}

if let finalError {
    finishError("macOS 语音识别失败：\(finalError.localizedDescription)")
}

let text = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
guard !text.isEmpty else {
    finishError("macOS 语音识别没有返回文字。")
}

writeFile(outputURL, text)
print(text)

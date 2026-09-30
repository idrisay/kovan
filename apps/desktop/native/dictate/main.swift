// kovan-dictate — on-device dictation for Kovan (improvements item 88).
//
// Kovan is Electron, and Chromium's own speech recognition doesn't work there,
// so the microphone and Apple's recogniser live in this small helper. It's the
// same approach VoiceSmith's live preview uses (LiveTranscriber +
// AudioRecorder): an AVAudioEngine tap feeding an
// SFSpeechAudioBufferRecognitionRequest, on-device wherever the language
// offers it, so audio never leaves the Mac.
//
// Protocol — one JSON object per line on stdout:
//   {"type":"ready","locale":"en-US","onDevice":true}
//   {"type":"level","value":0.42}          ~20 a second, 0…1
//   {"type":"partial","text":"hello wor"}  whenever the words change
//   {"type":"final","text":"Hello world."} once, after "stop"
//   {"type":"error","code":"…","message":"…"}  then exit 1
// and one command per line on stdin: "stop" (finish, send final, exit) or
// "cancel" (exit now, send nothing). EOF counts as cancel, so a Kovan that
// dies never leaves the microphone on.
//
//   kovan-dictate [--locale en-US] [--file audio.wav]
//   kovan-dictate --record out.wav   (item 97) record only, for a speech
//                                    provider other than Apple's: 16 kHz mono
//                                    16-bit WAV, the same level meter, then
//                                    {"type":"recorded","path":…,"seconds":…}
//                                    after "stop". No Speech permission needed.
//   kovan-dictate --status     permissions and languages, never prompts

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

let outputLock = NSLock()
func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    outputLock.lock()
    print(line)
    fflush(stdout)
    outputLock.unlock()
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(1)
}

func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func micStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .notDetermined: return "not-determined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "unknown"
    }
}

func speechStatus() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "authorized"
    case .notDetermined: return "not-determined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "unknown"
    }
}

// MARK: - --status

if CommandLine.arguments.contains("--status") {
    let locales = SFSpeechRecognizer.supportedLocales()
        .map { locale -> [String: Any] in
            let id = locale.identifier.replacingOccurrences(of: "_", with: "-")
            let name = Locale.current.localizedString(forIdentifier: locale.identifier) ?? id
            let onDevice = SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition ?? false
            return ["id": id, "name": name, "onDevice": onDevice]
        }
        .sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    emit([
        "type": "status",
        "mic": micStatus(),
        "speech": speechStatus(),
        "system": Locale.current.identifier.replacingOccurrences(of: "_", with: "-"),
        "locales": locales,
    ])
    exit(0)
}

// MARK: - Transcriber

/// Words so far. A recogniser stops on its own after about a minute of audio,
/// so — as in VoiceSmith — what a finished task said is kept in `settled` and
/// a fresh task takes over, until "stop" says the end is real.
final class Transcriber: @unchecked Sendable {
    private let recognizer: SFSpeechRecognizer
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var settled = ""
    private var partial = ""
    private var lastSent = ""
    private var running = true
    private var finishing = false
    var onFinished: ((String) -> Void)?

    init(recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
    }

    static func joined(_ a: String, _ b: String) -> String {
        if a.isEmpty { return b }
        if b.isEmpty { return a }
        return a + " " + b
    }

    var text: String {
        lock.lock(); defer { lock.unlock() }
        return Self.joined(settled, partial)
    }

    func begin() {
        lock.lock()
        guard running else { lock.unlock(); return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request
        lock.unlock()

        let task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            self?.handle(result: result, error: error)
        }
        lock.lock()
        self.task = task
        lock.unlock()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let request = self.request
        lock.unlock()
        request?.append(buffer)
    }

    /// No more audio: the current task gets to finish its last words.
    func finish() {
        lock.lock()
        running = false
        finishing = true
        let request = self.request
        lock.unlock()
        request?.endAudio()
    }

    private func handle(result: SFSpeechRecognitionResult?, error: Error?) {
        if let result {
            lock.lock()
            partial = result.bestTranscription.formattedString
            let visible = Self.joined(settled, partial)
            let changed = visible != lastSent
            lastSent = visible
            lock.unlock()
            if changed { emit(["type": "partial", "text": visible]) }
        }
        let done = (result?.isFinal ?? false) || error != nil
        guard done else { return }

        lock.lock()
        settled = Self.joined(settled, partial)
        partial = ""
        request = nil
        task = nil
        let again = running
        let final = finishing ? settled : nil
        lock.unlock()

        if again { begin() }
        if let final { onFinished?(final) }
    }
}

// MARK: - Setup

let localeId = argument("--locale")
let locale = localeId.map { Locale(identifier: $0.replacingOccurrences(of: "-", with: "_")) } ?? Locale.current
let file = argument("--file")
let recordPath = argument("--record")

func authorize(_ then: @escaping () -> Void) {
    let speech = { (next: @escaping () -> Void) in
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: next()
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { status in
                if status == .authorized { next() }
                else { fail("speech-denied", "Speech recognition isn't allowed for Kovan.") }
            }
        default: fail("speech-denied", "Speech recognition isn't allowed for Kovan.")
        }
    }
    if file != nil { speech(then); return }
    // Recording for another provider: the words aren't Apple's, so only the
    // microphone is asked for.
    let next = recordPath != nil ? { (go: @escaping () -> Void) in go() } : speech
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: next(then)
    case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            if granted { next(then) } else { fail("mic-denied", "Kovan isn't allowed to use the microphone.") }
        }
    default: fail("mic-denied", "Kovan isn't allowed to use the microphone.")
    }
}

let engine = AVAudioEngine()
var transcriber: Transcriber?
var lastLevelAt = Date.distantPast
let maxSeconds: TimeInterval = 300
let startedAt = Date()

func level(of buffer: AVAudioPCMBuffer) -> Double {
    guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    var sum: Float = 0
    for i in 0..<Int(buffer.frameLength) { sum += data[i] * data[i] }
    let rms = sqrt(sum / Float(buffer.frameLength))
    let db = 20 * log10(max(rms, 0.000_001))
    // Same curve as VoiceSmith's meter: -60…0 dBFS, lifted so speech looks alive.
    return pow(Double((max(-60, min(0, db)) + 60) / 60), 1.8)
}

func deliverFinal(_ text: String) {
    emit(["type": "final", "text": text.trimmingCharacters(in: .whitespacesAndNewlines)])
    exit(0)
}

func stopAndFinish() {
    if engine.isRunning {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
    if let recorder {
        emit(["type": "recorded", "path": recorder.close(), "seconds": (recorder.seconds * 10).rounded() / 10])
        exit(0)
    }
    guard let transcriber else { deliverFinal(""); return }
    transcriber.onFinished = { deliverFinal($0) }
    transcriber.finish()
    // The recogniser's last word can take a moment; never wait forever for it.
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { deliverFinal(transcriber.text) }
}

/// `--record`: the microphone, converted to what every speech service and
/// whisper.cpp accept — 16 kHz, mono, 16-bit PCM WAV.
final class Recorder: @unchecked Sendable {
    let url: URL
    private var file: AVAudioFile?
    private let converter: AVAudioConverter
    private let output: AVAudioFormat
    private let lock = NSLock()
    private(set) var seconds: Double = 0

    init(url: URL, input: AVAudioFormat) throws {
        self.url = url
        output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
        guard let converter = AVAudioConverter(from: input, to: output) else {
            throw NSError(domain: "kovan-dictate", code: 1, userInfo: [NSLocalizedDescriptionKey: "can't convert \(input)"])
        }
        self.converter = converter
        file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
        ], commonFormat: .pcmFormatFloat32, interleaved: false)
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        let ratio = output.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, converted.frameLength > 0 else { return }
        lock.lock(); defer { lock.unlock() }
        try? file?.write(from: converted)
        seconds += Double(converted.frameLength) / output.sampleRate
    }

    /// Flushes and closes the file (AVAudioFile writes its header on release).
    func close() -> String {
        lock.lock(); defer { lock.unlock() }
        file = nil
        return url.path
    }
}

var recorder: Recorder?

func startRecording(to path: String) {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0 else { fail("no-input", "No microphone is ready.") }
    do {
        recorder = try Recorder(url: URL(fileURLWithPath: path), input: format)
    } catch {
        fail("record", "Couldn't record to \(path): \(error.localizedDescription)")
    }
    let r = recorder!
    emit(["type": "ready", "locale": "", "onDevice": false, "recording": true])
    input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
        r.append(buffer)
        let now = Date()
        if now.timeIntervalSince(lastLevelAt) >= 0.05 {
            lastLevelAt = now
            emit(["type": "level", "value": (level(of: buffer) * 100).rounded() / 100])
        }
        if now.timeIntervalSince(startedAt) > maxSeconds {
            DispatchQueue.main.async { stopAndFinish() }
        }
    }
    engine.prepare()
    do {
        try engine.start()
    } catch {
        fail("no-input", "The microphone couldn't start: \(error.localizedDescription)")
    }
}

func start() {
    if let recordPath { startRecording(to: recordPath); return }
    guard let recognizer = SFSpeechRecognizer(locale: locale) else {
        fail("no-recognizer", "Dictation isn't available for \(locale.identifier).")
    }
    guard recognizer.isAvailable else {
        fail("unavailable", "Dictation for \(locale.identifier) isn't available right now.")
    }
    let t = Transcriber(recognizer: recognizer)
    transcriber = t
    t.begin()
    emit([
        "type": "ready",
        "locale": locale.identifier.replacingOccurrences(of: "_", with: "-"),
        "onDevice": recognizer.supportsOnDeviceRecognition,
    ])

    if let file {
        // Tests: the same pipeline, fed from a file instead of the microphone.
        do {
            let audio = try AVAudioFile(forReading: URL(fileURLWithPath: file))
            let format = audio.processingFormat
            while audio.framePosition < audio.length {
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4_096) else { break }
                try audio.read(into: buffer)
                t.append(buffer)
            }
        } catch {
            fail("file", "Couldn't read \(file): \(error.localizedDescription)")
        }
        stopAndFinish()
        return
    }

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0 else {
        fail("no-input", "No microphone is ready.")
    }
    input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
        t.append(buffer)
        let now = Date()
        if now.timeIntervalSince(lastLevelAt) >= 0.05 {
            lastLevelAt = now
            emit(["type": "level", "value": (level(of: buffer) * 100).rounded() / 100])
        }
        if now.timeIntervalSince(startedAt) > maxSeconds {
            DispatchQueue.main.async { stopAndFinish() }
        }
    }
    engine.prepare()
    do {
        try engine.start()
    } catch {
        fail("no-input", "The microphone couldn't start: \(error.localizedDescription)")
    }
}

// MARK: - Commands

let stdinThread = Thread {
    while let line = readLine() {
        switch line.trimmingCharacters(in: .whitespaces) {
        case "stop": DispatchQueue.main.async { stopAndFinish() }
        case "cancel": exit(0)
        default: continue
        }
    }
    exit(0) // EOF: Kovan went away. Don't leave the microphone on.
}
stdinThread.start()

authorize { DispatchQueue.main.async { start() } }
dispatchMain()

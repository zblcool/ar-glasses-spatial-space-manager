// Photos -> textured 3D model with Apple's Object Capture (RealityKit's
// PhotogrammetrySession). Runs on the Mac, no GPU server needed.
//
//   object-capture <images-dir> <out-dir> [--detail preview|reduced|medium|full|raw]
//                  [--unordered] [--high-sensitivity] [--no-masking] [--check]
//
// Writes <out-dir>/model.usdz (opens in Preview / Quick Look),
// <out-dir>/obj/ (OBJ + MTL + textures, for three.js and Blender) and
// <out-dir>/detail.txt. The session won't write over existing files, so the
// model is built in <out-dir>.building and replaces <out-dir> only when it is
// done: a failed or cancelled run leaves the previous model as it was.
// Progress goes to stdout as one JSON object per line:
//   {"progress":0.42,"stage":"...","eta":95}   {"done":"<out-dir>"}   {"error":"..."}
//
// Build:  swiftc -O -parse-as-library tools/capture/object_capture.swift -o tools/capture/build/object-capture

import Foundation
import RealityKit

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

func fail(_ message: String) -> Never {
    emit(["error": message])
    exit(1)
}

func stageName(_ stage: PhotogrammetrySession.Output.ProcessingStage?) -> String {
    switch stage {
    case .preProcessing?: return "preprocessing"
    case .imageAlignment?: return "aligning images"
    case .pointCloudGeneration?: return "point cloud"
    case .meshGeneration?: return "mesh"
    case .textureMapping?: return "texturing"
    case .optimization?: return "optimizing"
    default: return "working"
    }
}

@main
struct ObjectCapture {
    static func main() async {
        var args = Array(CommandLine.arguments.dropFirst())
        if args.contains("--check") {
            emit(["supported": PhotogrammetrySession.isSupported])
            exit(PhotogrammetrySession.isSupported ? 0 : 1)
        }
        func flag(_ name: String) -> Bool {
            guard let i = args.firstIndex(of: name) else { return false }
            args.remove(at: i)
            return true
        }
        func option(_ name: String) -> String? {
            guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
            let v = args[i + 1]
            args.removeSubrange(i...(i + 1))
            return v
        }
        let detailName = option("--detail") ?? "medium"
        let unordered = flag("--unordered"), high = flag("--high-sensitivity"), noMasking = flag("--no-masking")
        guard args.count == 2 else {
            fail("usage: object-capture <images-dir> <out-dir> [--detail preview|reduced|medium|full|raw] [--unordered] [--high-sensitivity] [--no-masking]")
        }
        guard PhotogrammetrySession.isSupported else {
            fail("Object Capture is not supported on this Mac (it needs Apple silicon, or a GPU with ray tracing and 4 GB of memory)")
        }
        let details: [String: PhotogrammetrySession.Request.Detail] = [
            "preview": .preview, "reduced": .reduced, "medium": .medium, "full": .full, "raw": .raw,
        ]
        guard let detail = details[detailName] else { fail("unknown detail level \(detailName)") }

        let input = URL(fileURLWithPath: args[0], isDirectory: true)
        let out = URL(fileURLWithPath: args[1], isDirectory: true)
        let fm = FileManager.default
        let work = URL(fileURLWithPath: out.path + ".building", isDirectory: true)
        let objDir = work.appendingPathComponent("obj", isDirectory: true)
        do {
            try? fm.removeItem(at: work)  // left over from a cancelled run
            try fm.createDirectory(at: objDir, withIntermediateDirectories: true)
        } catch {
            fail("cannot create \(objDir.path): \(error.localizedDescription)")
        }

        var config = PhotogrammetrySession.Configuration()
        config.sampleOrdering = unordered ? .unordered : .sequential
        config.featureSensitivity = high ? .high : .normal
        config.isObjectMaskingEnabled = !noMasking

        let session: PhotogrammetrySession
        do {
            session = try PhotogrammetrySession(input: input, configuration: config)
        } catch {
            fail("cannot start: \(error.localizedDescription)")
        }

        let usdz = work.appendingPathComponent("model.usdz")
        // A directory URL makes the session write OBJ + MTL + textures there.
        let requests: [PhotogrammetrySession.Request] = [
            .modelFile(url: usdz, detail: detail),
            .modelFile(url: objDir, detail: detail),
        ]
        var stage = "starting", eta: Double? = nil, failed: String? = nil
        let started = Date()

        let watcher = Task {
            for try await output in session.outputs {
                switch output {
                case .requestProgress(_, let fraction):
                    var o: [String: Any] = ["progress": fraction, "stage": stage, "elapsed": Int(Date().timeIntervalSince(started))]
                    if let eta { o["eta"] = Int(eta) }
                    emit(o)
                case .requestProgressInfo(_, let info):
                    stage = stageName(info.processingStage)
                    eta = info.estimatedRemainingTime
                case .requestError(_, let error):
                    // String(describing:) names the case (e.g. processError), localizedDescription only a number.
                    failed = "\(error)"
                case .requestComplete(_, _):
                    emit(["stage": "saved"])
                case .invalidSample(let id, let reason):
                    emit(["warning": "image \(id) not used: \(reason)"])
                case .skippedSample(let id):
                    emit(["warning": "image \(id) skipped"])
                case .automaticDownsampling:
                    emit(["warning": "not enough memory: images were downsampled"])
                case .processingCancelled:
                    failed = "cancelled"
                case .processingComplete:
                    return
                default:
                    break
                }
            }
        }
        do {
            try session.process(requests: requests)
        } catch {
            fail("cannot process: \(error)")
        }
        do {
            try await watcher.value
        } catch {
            fail(error.localizedDescription)
        }
        if let failed {
            try? fm.removeItem(at: work)
            fail(failed)
        }
        do {
            try detailName.write(to: work.appendingPathComponent("detail.txt"), atomically: true, encoding: .utf8)
            try? fm.removeItem(at: out)
            try fm.moveItem(at: work, to: out)
        } catch {
            fail("cannot move the model to \(out.path): \(error.localizedDescription)")
        }
        let final = out.appendingPathComponent("model.usdz")
        emit(["done": out.path, "usdz": final.path, "obj": out.appendingPathComponent("obj").path, "seconds": Int(Date().timeIntervalSince(started))])
    }
}

import QuickLook
import SwiftUI

/// The preview and an active share each retain the document until they finish using its file.
final class FleetDocument: Identifiable {
  static let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("FleetPrivate", isDirectory: true)
  // The operating system may terminate the app without running deinitializers.
  static let cleanPreviousLaunch: Void = {
    try? FileManager.default.removeItem(at: directory)
  }()

  let url: URL
  let title: String
  var id: URL { url }

  init(name: String, title: String) throws {
    _ = Self.cleanPreviousLaunch
    self.title = title
    let folder = Self.directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let sanitized = name.replacingOccurrences(
      of: "[^a-zA-Z0-9_.-]", with: "_", options: .regularExpression)
    let filename = ["", ".", ".."].contains(sanitized) ? "Fleet-document" : sanitized
    url = folder.appendingPathComponent(filename)
    let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.complete]
    let manager = FileManager.default
    try manager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: protection)
    guard manager.createFile(atPath: url.path, contents: nil, attributes: protection) else {
      try? manager.removeItem(at: folder)
      throw FleetError(message: "Could not create a private file for this preview.")
    }
  }

  deinit { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}

/// URLSession delivers chunks on its serial delegate queue. Check even when the server omits
/// Content-Length, and write straight to the protected file without buffering the whole report.
private final class PreviewWriter: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let handle: FileHandle
  private let limit: Int
  private var received = 0
  private var failure: Error?
  private let completion: CheckedContinuation<Void, Error>

  init(_ handle: FileHandle, limit: Int, completion: CheckedContinuation<Void, Error>) {
    self.handle = handle
    self.limit = limit
    self.completion = completion
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
      if response.expectedContentLength <= Int64(limit) {
        completionHandler(.allow)
        return
      }
      failure = FleetError(message: "File is too large to preview.")
    } else {
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      failure = FleetError(message: "Could not download this file. Please try again.", status: status)
    }
    completionHandler(.cancel)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard failure == nil else { return }
    do {
      guard data.count <= limit - received else {
        throw FleetError(message: "File is too large to preview.")
      }
      try handle.write(contentsOf: data)
      received += data.count
    } catch {
      failure = error
      dataTask.cancel()
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    do {
      try handle.close()
      if let error = failure ?? error { throw error }
      completion.resume()
    } catch {
      completion.resume(throwing: error)
    }
  }
}

enum FleetPreviewTransfer {
  static func download(_ request: URLRequest, with session: URLSession, to url: URL, maximumBytes: Int)
    async throws
  {
    let handle = try FileHandle(forWritingTo: url)
    let task = session.dataTask(with: request)
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (completion: CheckedContinuation<Void, Error>) in
        task.delegate = PreviewWriter(handle, limit: maximumBytes, completion: completion)
        task.resume()
        if Task.isCancelled { task.cancel() }
      }
    } onCancel: {
      task.cancel()
    }
  }
}

struct DocumentPreview: View {
  let document: FleetDocument
  @State private var sharing = false
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      FilePreview(url: document.url)
        .navigationTitle(document.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") { dismiss() }.accessibilityLabel("Close preview")
          }
          ToolbarItem(placement: .primaryAction) {
            Button { sharing = true } label: { Label("Share", systemImage: "square.and.arrow.up") }
          }
        }
        .sheet(isPresented: $sharing) { DocumentShare(document: document) }
    }
  }
}

private struct DocumentShare: UIViewControllerRepresentable {
  let document: FleetDocument

  func makeUIViewController(context: Context) -> UIActivityViewController {
    let controller = UIActivityViewController(activityItems: [document.url], applicationActivities: nil)
    controller.completionWithItemsHandler = { [document] _, _, _, _ in
      withExtendedLifetime(document) {}
    }
    return controller
  }

  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct FilePreview: UIViewControllerRepresentable {
  let url: URL

  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    let url: URL
    init(url: URL) { self.url = url }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
      -> QLPreviewItem
    {
      url as NSURL
    }
  }

  func makeCoordinator() -> Coordinator { Coordinator(url: url) }

  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: QLPreviewController, context: Context) {}
}

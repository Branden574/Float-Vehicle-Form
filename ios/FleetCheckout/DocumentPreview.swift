import QuickLook
import SwiftUI

struct FleetDocument: Identifiable {
  let url: URL
  let title: String
  var id: URL { url }
}

struct DocumentPreview: View {
  let document: FleetDocument
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
            ShareLink(item: document.url) { Label("Share", systemImage: "square.and.arrow.up") }
          }
        }
    }
  }
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

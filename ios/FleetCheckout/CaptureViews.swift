import PhotosUI
import SwiftUI
import UIKit

struct SignaturePad: UIViewRepresentable {
  @Binding var signature: String
  var clearID: UUID
  func makeUIView(context: Context) -> SignatureCanvas {
    let view = SignatureCanvas()
    view.changed = { signature = $0 }
    view.clearID = clearID
    return view
  }
  func updateUIView(_ view: SignatureCanvas, context: Context) {
    view.changed = { signature = $0 }
    view.isUserInteractionEnabled = context.environment.isEnabled
    if view.clearID != clearID {
      view.clearID = clearID
      view.lines = []
      view.setNeedsDisplay()
    }
  }
}
final class SignatureCanvas: UIView {
  var lines: [[CGPoint]] = []
  var changed: (String) -> Void = { _ in }
  var clearID = UUID()
  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .white
    isMultipleTouchEnabled = false
    accessibilityLabel = "Signature drawing area"
    accessibilityHint = "Draw your signature with your finger or Apple Pencil."
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    if let point = touches.first?.location(in: self) {
      lines.append([point])
      setNeedsDisplay()
    }
  }
  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard !lines.isEmpty, let touch = touches.first else { return }
    lines[lines.count - 1].append(
      contentsOf: (event?.coalescedTouches(for: touch) ?? [touch]).map { $0.location(in: self) })
    setNeedsDisplay()
  }
  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { publish() }
  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { publish() }
  private func render(_ context: CGContext, size: CGSize) {
    context.setFillColor(UIColor.white.cgColor)
    context.fill(CGRect(origin: .zero, size: size))
    context.setStrokeColor(UIColor.black.cgColor)
    context.setLineWidth(2.5)
    context.setLineCap(.round)
    context.setLineJoin(.round)
    for line in lines where line.count > 1 {
      context.beginPath()
      context.move(to: line[0])
      for point in line.dropFirst() { context.addLine(to: point) }
      context.strokePath()
    }
  }
  override func draw(_ rect: CGRect) {
    if let context = UIGraphicsGetCurrentContext() { render(context, size: bounds.size) }
  }
  private func publish() {
    guard lines.flatMap({ $0 }).count >= 8, bounds.width >= 50 else {
      changed("")
      return
    }
    // A fixed export scale keeps signatures below the API's 400 KB cap on large iPads.
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let image = UIGraphicsImageRenderer(size: bounds.size, format: format).image {
      render($0.cgContext, size: bounds.size)
    }
    if let data = image.pngData() { changed("data:image/png;base64," + data.base64EncodedString()) }
  }
}
struct CameraCapture: UIViewControllerRepresentable {
  let onCapture: (Data) -> Void
  @Environment(\.dismiss) private var dismiss
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIViewController(context: Context) -> UIImagePickerController {
    let controller = UIImagePickerController()
    controller.sourceType = .camera
    controller.cameraCaptureMode = .photo
    controller.delegate = context.coordinator
    return controller
  }
  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate
  {
    let parent: CameraCapture
    init(_ parent: CameraCapture) { self.parent = parent }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    func imagePickerController(
      _ picker: UIImagePickerController,
      didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
      if let image = info[.originalImage] as? UIImage, let data = cameraJPEG(image) {
        parent.onCapture(data)
      }
      parent.dismiss()
    }
  }
}
func cameraJPEG(_ image: UIImage) -> Data? {
  let factor = min(1, 2400 / max(image.size.width, image.size.height))
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  format.opaque = true
  return UIGraphicsImageRenderer(
    size: CGSize(width: image.size.width * factor, height: image.size.height * factor),
    format: format
  ).image { _ in
    image.draw(
      in: CGRect(x: 0, y: 0, width: image.size.width * factor, height: image.size.height * factor))
  }.jpegData(compressionQuality: 0.88)
}
struct DamageDiagram: View {
  @Environment(\.isEnabled) private var isEnabled
  @Binding var marks: [Damage]
  var previous: [Damage] = []
  var editable = true
  var selectedArea: String
  var selectedType: String
  var currentPrefix = "D"
  var body: some View {
    GeometryReader { geometry in
      let width = min(geometry.size.width, geometry.size.height * 360 / 560)
      let height = width * 560 / 360
      Canvas { context, size in
        var scaled = context
        scaled.scaleBy(x: size.width / 360, y: size.height / 560)
        scaled.stroke(vehicleDiagramPath(), with: .color(.gray), lineWidth: 1.5)
        for (index, damage) in previous.enumerated() {
          draw(damage, index: index, prefix: "C", color: .orange, context: &context, size: size)
        }
        for (index, damage) in marks.enumerated() {
          draw(
            damage, index: index, prefix: currentPrefix, color: .blue, context: &context, size: size
          )
        }
      }.frame(width: width, height: height).background(.white).contentShape(Rectangle())
        .gesture(
          SpatialTapGesture().onEnded { tap in
            guard editable, isEnabled, marks.count < 40 else { return }
            marks.append(
              Damage(
                area: selectedArea, type: selectedType,
                position: DamagePosition(
                  x: max(0, min(1, tap.location.x / width)),
                  y: max(0, min(1, tap.location.y / height)))))
          }
        )
        .accessibilityLabel(
          "Vehicle damage diagram. \(previous.count) checkout marks and \(marks.count) current marks."
        )
        .accessibilityHint(
          editable
            ? "Tap the vehicle to mark damage. A list below also supports adding and editing damage."
            : "Damage is listed on the signed form."
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }
  private func draw(
    _ damage: Damage, index: Int, prefix: String, color: Color, context: inout GraphicsContext,
    size: CGSize
  ) {
    guard let position = damage.position else { return }
    let point = CGPoint(x: position.x * size.width, y: position.y * size.height)
    let circle = Path(ellipseIn: CGRect(x: point.x - 9, y: point.y - 9, width: 18, height: 18))
    context.fill(circle, with: .color(color))
    context.stroke(circle, with: .color(.white), lineWidth: 1)
    let symbol = damage.type == "dent" ? "×" : damage.type == "scratch" ? "~" : "•"
    context.draw(
      Text(symbol).font(.system(size: 16, weight: .bold)).foregroundColor(.white), at: point)
    context.draw(
      Text("\(prefix)\(index + 1)").font(.system(size: 10, weight: .bold)).foregroundColor(color),
      at: CGPoint(x: point.x + 16, y: point.y - 12))
  }
}

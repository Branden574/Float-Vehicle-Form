import AVFoundation
import PhotosUI
import QuickLook
import SwiftUI
import VisionKit

struct InspectionView: View {
  @EnvironmentObject var store: FleetStore
  @Environment(\.dismiss) private var dismiss
  let vehicle: Vehicle
  let trip: Trip?
  @State private var step = 0
  @State private var draftID = UUID().uuidString.lowercased()
  @State private var due = Date().addingTimeInterval(3600)
  @State private var mileage = ""
  @State private var confirmed = false
  @State private var checks: [String: String] = [:]
  @State private var windshield = ""
  @State private var marks: [Damage] = []
  @State private var notes = ""
  @State private var area = "front"
  @State private var damageType = "dent"
  @State private var photos: [FleetPhoto] = []
  @State private var viewName = "front"
  @State private var selectedPhoto: PhotosPickerItem?
  @State private var camera = false
  @State private var receiptScanner = false
  @State private var pendingReceiptPages: [Data] = []
  @State private var signature = ""
  @State private var clearID = UUID()
  @State private var acknowledgments: [String: Bool] = [:]
  @State private var replacementAcknowledged = false
  @State private var pendingBody: [String: Any]?
  @State private var pendingKey = ""
  @State private var busy = false
  @State private var loadingPhoto = false
  @State private var ownerSession: UUID?
  @State private var error = ""
  @State private var cancel = false
  @State private var preview: URL?
  @State private var completed: Trip?
  var returning: Bool { trip != nil }
  var stage: String { returning ? "return" : "checkout" }
  var requiredViews: [String] {
    var views = ["front", "rear", "driver", "passenger"]
    for view in store.session?.settings.requiredPhotoViews ?? [] where !views.contains(view) {
      views.append(view)
    }
    return views
  }
  var questions: [(String, String)] {
    var result = [
      ("fuelFull", "Fuel tank full?"), ("interiorClean", "Interior clean?"),
      ("gasCard", "Gas card present?"),
    ]
    if returning {
      result += [
        ("receiptReceived", "Fuel receipt returned?"), ("keyReturned", "Vehicle key returned?"),
      ]
    }
    return result
  }
  var promises: [(String, String)] {
    var result = [("accurate", "The information I provided is accurate.")]
    if !returning { result.append(("noEating", "I will not eat in float vehicles.")) }
    result.append(
      (
        "removeBelongings",
        returning
          ? "I removed all personal belongings and trash."
          : "I will remove all personal belongings and trash."
      ))
    result.append(
      (
        "fullTank",
        returning
          ? "I understand that vehicles must be returned with a full tank of gas."
          : "I will return the vehicle with a full tank of gas."
      ))
    return result
  }
  var body: some View {
    Group {
      if let completed {
        VStack(spacing: 20) {
          Image(systemName: "checkmark.seal.fill").font(.system(size: 64)).foregroundStyle(.green)
          Text(returning ? "Return recorded" : "Checkout recorded").font(.largeTitle.bold())
          Text(
            completed.status == "pending_checkout"
              ? "Wait for representative approval before driving."
              : "Your signed forms and photographs are saved."
          ).multilineTextAlignment(.center)
          Text("Configured recipients receive the forms after any required representative review.")
            .font(.footnote).foregroundStyle(.secondary)
          Button("Done") { dismiss() }.buttonStyle(.borderedProminent).foregroundStyle(
            Color("FleetOnAccent"))
        }.padding(32)
      } else {
        Form {
          Section {
            Text(vehicle.name).font(.headline)
            Text("\(vehicle.plate) · VIN •••• \(vehicle.vinLast4)").font(.subheadline)
            Text("\(store.session?.user.name ?? "") · \(store.session?.user.charter ?? "")").font(
              .caption
            ).foregroundStyle(.secondary)
            ProgressView(value: Double(step + 1), total: 4)
            Text(
              "Step \(step + 1) of 4 · \(["Trip details","Inspection","Photographs","Review & sign"][step])"
            ).font(.caption)
          }
          if !error.isEmpty {
            Text(error).foregroundStyle(.red).accessibilityIdentifier("workflowError")
          }
          Group {
            if step == 0 { tripDetails }
            if step == 1 { inspection }
            if step == 2 { photographSection }
            if step == 3 { review }
          }.disabled(busy || loadingPhoto || pendingBody != nil)
          if pendingBody != nil {
            Text(
              "Submission status is uncertain. Retry the same submission to avoid a duplicate. Keep this draft open."
            ).foregroundStyle(.orange)
          }
          Section {
            if step < 3 {
              Button("Continue") {
                let issue = validate(step)
                if issue.isEmpty {
                  error = ""
                  step += 1
                } else {
                  error = issue
                }
              }.disabled(busy || loadingPhoto)
            } else {
              Button(
                busy
                  ? "Saving…"
                  : pendingBody != nil ? "Retry same submission" : "Sign & submit \(stage)"
              ) { Task { await submit() } }.disabled(busy || loadingPhoto)
            }
            if step > 0 {
              Button("Back") {
                step -= 1
                error = ""
              }.disabled(busy || loadingPhoto || pendingBody != nil)
            }
          }
        }
      }
    }.navigationTitle(returning ? "Return vehicle" : "Check out vehicle")
      .navigationBarTitleDisplayMode(.inline)
      .quickLookPreview($preview)
      .toolbar {
        if completed == nil { Button("Cancel") { cancel = true }.disabled(busy || loadingPhoto) }
      }
      .interactiveDismissDisabled(completed == nil)
      .confirmationDialog(
        "Discard this unfinished inspection? Uploaded photos are not a completed trip. If a submission is uncertain, check Trip history before starting another.",
        isPresented: $cancel
      ) { Button("Discard draft", role: .destructive) { dismiss() } }
      .onAppear {
        if ownerSession == nil { ownerSession = store.revision }
        if mileage.isEmpty && !returning { mileage = String(vehicle.currentMileage) }
      }
      .sheet(isPresented: $camera) {
        CameraCapture { data in Task { await upload(data, source: "camera") } }.ignoresSafeArea()
      }
      .fullScreenCover(isPresented: $receiptScanner) {
        ReceiptScanner(remainingPages: max(0, 30 - photos.count)) { pages in
          pendingReceiptPages = pages
          loadingPhoto = true
          Task { await uploadReceiptPages() }
        } onError: {
          error = $0
        }
        .ignoresSafeArea()
      }
      .onChange(of: selectedPhoto) { _, item in
        guard let item else { return }
        loadingPhoto = true
        Task {
          defer { loadingPhoto = false }
          do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
              throw FleetError(message: "Could not read that photograph.")
            }
            // Imported originals retain their original bytes and are labelled as uploads.
            await upload(data, source: "upload")
          } catch { self.error = error.localizedDescription }
          selectedPhoto = nil
        }
      }
  }
  var tripDetails: some View {
    Section("Odometer & return time") {
      if let trip {
        LabeledContent("Starting mileage", value: trip.startingMileage.formatted())
        TextField("Ending odometer reading", text: $mileage).keyboardType(.numberPad)
        if let value = Int(mileage) {
          LabeledContent("Calculated trip miles", value: trip.distance(ending: value).formatted())
        }
        if let replacement = trip.odometerReplacement {
          Text(
            "Recorded odometer replacement: \(replacement.oldReading) → \(replacement.newReading). \(replacement.reason)"
          )
          Toggle("I acknowledge this documented replacement", isOn: $replacementAcknowledged)
        }
      } else {
        LabeledContent("Accepted mileage", value: vehicle.currentMileage.formatted())
        Toggle("I checked the dashboard and this reading matches", isOn: $confirmed)
        Text(
          "If the reading differs, cancel and use Report a mileage discrepancy. Do not change the accepted reading yourself."
        ).font(.footnote).foregroundStyle(.secondary)
        DatePicker(
          "Expected return", selection: $due, in: Date()...Date().addingTimeInterval(365 * 86400))
      }
    }
  }
  var inspection: some View {
    Group {
      Section("Condition checks") {
        ForEach(questions, id: \.0) { key, label in
          Picker(label, selection: Binding(get: { checks[key] ?? "" }, set: { checks[key] = $0 })) {
            Text("Choose").tag("")
            Text("Yes").tag("yes")
            Text("No").tag("no")
          }
        }
        Picker("Windshield", selection: $windshield) {
          Text("Choose").tag("")
          Text("Clear").tag("clear")
          Text("Star / chip").tag("star")
          Text("Cracked").tag("cracked")
        }
      }
      Section(returning ? "New damage on return" : "Record all observed damage") {
        if returning {
          Text(
            "Amber C marks are the original checkout damage. Add only new damage in blue. Original marks remain on the form."
          ).font(.footnote)
        }
        Picker("Area for list-only damage", selection: $area) {
          ForEach(
            ["front", "rear", "driver", "passenger", "roof", "interior", "windshield", "wheels"],
            id: \.self
          ) { Text(humanize($0)).tag($0) }
        }
        Picker("Damage type", selection: $damageType) {
          ForEach(["chip", "dent", "scratch"], id: \.self) { Text(humanize($0)).tag($0) }
        }.pickerStyle(.segmented)
        Text("Tap the vehicle exactly where the damage is.").font(.footnote)
        DamageDiagram(
          marks: $marks, previous: trip?.checkoutInspection.damage ?? [], selectedArea: area,
          selectedType: damageType, currentPrefix: returning ? "N" : "D"
        ).frame(height: 460)
        ForEach(marks.indices, id: \.self) { index in
          VStack(alignment: .leading) {
            HStack {
              Text("\(index + 1). \(humanize(marks[index].area)) · \(humanize(marks[index].type))")
              Spacer()
              Button(role: .destructive) {
                marks.remove(at: index)
              } label: {
                Image(systemName: "trash")
              }.accessibilityLabel("Remove damage \(index + 1)")
            }
            TextField("Damage notes", text: $marks[index].notes, axis: .vertical)
          }
        }
        Button("Add damage by area without a diagram point") {
          marks.append(Damage(area: area, type: damageType))
        }.disabled(marks.count >= 40)
        TextField("Inspection notes", text: $notes, axis: .vertical).lineLimit(3...6)
      }
    }
  }
  var photographSection: some View {
    Section {
      ForEach(requiredViews, id: \.self) { view in
        Label(
          humanize(view),
          systemImage: photos.contains(where: { $0.view == view })
            ? "checkmark.circle.fill" : "circle"
        ).foregroundStyle(photos.contains(where: { $0.view == view }) ? .green : .secondary)
      }
      Picker("Photo view", selection: $viewName) {
        ForEach(
          Array(
            Set(
              requiredViews + [
                "windshield", "interior", "odometer", "receipt", "wheels", "damage", "other",
              ])
          ).sorted(), id: \.self
        ) { Text(humanize($0)).tag($0) }
      }
      if returning {
        if VNDocumentCameraViewController.isSupported {
          Button("Scan gas receipt", systemImage: "doc.viewfinder") {
            let permission = AVCaptureDevice.authorizationStatus(for: .video)
            if permission == .denied || permission == .restricted {
              error =
                "Camera access is unavailable. Allow Fleet Checkout to use the camera in Settings to scan receipts."
            } else {
              receiptScanner = true
            }
          }.disabled(busy || loadingPhoto || photos.count >= 30 || !pendingReceiptPages.isEmpty)
          Text(
            "Use Apple's scanner to crop and capture each receipt page. Saved scans attach to this return and its emailed form package."
          )
          .font(.footnote).foregroundStyle(.secondary)
        } else {
          Text(
            "Receipt scanning requires a supported iPhone or iPad camera. You can also select Receipt and take a photo, or choose a photo when imports are allowed."
          )
          .font(.footnote).foregroundStyle(.secondary)
        }
        if !pendingReceiptPages.isEmpty {
          Text(
            "\(pendingReceiptPages.count) scanned receipt pages waiting to upload. Keep this draft open."
          )
          Button("Retry receipt uploads") {
            loadingPhoto = true
            Task { await uploadReceiptPages() }
          }.disabled(busy || loadingPhoto)
          Button("Remove unsaved receipt scans", role: .destructive) {
            pendingReceiptPages = []
          }.disabled(busy || loadingPhoto)
        }
      }
      if UIImagePickerController.isSourceTypeAvailable(.camera) {
        Button("Take photo", systemImage: "camera") { camera = true }.disabled(
          busy || photos.count >= 30)
      } else {
        Text("The simulator has no camera. Camera capture must also be tested on a real iPad.")
          .font(.footnote).foregroundStyle(.secondary)
      }
      if store.session?.settings.allowPhotoImports == true {
        PhotosPicker(selection: $selectedPhoto, matching: .images, preferredItemEncoding: .current)
        { Label("Choose photo", systemImage: "photo") }.disabled(
          busy || loadingPhoto || photos.count >= 30)
      }
      if busy || loadingPhoto { ProgressView("Storing photos and receipt pages…") }
      ForEach(photos) { photo in
        HStack {
          Label(humanize(photo.view), systemImage: "checkmark.circle.fill").foregroundStyle(.green)
          Spacer()
          Button("Preview") {
            Task {
              busy = true
              defer { busy = false }
              do { preview = try await store.api.file(photo.url, name: "\(photo.id).jpg") } catch {
                self.error = error.localizedDescription
              }
            }
          }
          Button("Remove", role: .destructive) { photos.removeAll { $0.id == photo.id } }
        }
      }
    } header: {
      Text("Required photographs")
    } footer: {
      Text(
        "Each side needs a fresh, distinct photograph. Uploaded files are labelled as imports. Photo timestamps do not independently verify capture time."
      )
    }
  }
  var review: some View {
    Group {
      Section("Review before signing") {
        Text("\(vehicle.name) · \(vehicle.plate)")
        Text(
          "\(photos.count) stored photos · \(marks.count) \(returning ? "new " : "")damage marks")
        Text("Odometer: \(mileage)")
        if !returning { Text("Expected return: \(due.formatted())") }
        ForEach(questions, id: \.0) { key, label in
          LabeledContent(label, value: checks[key] == "yes" ? "Yes" : "No")
        }
        LabeledContent("Windshield", value: humanize(windshield))
        if !notes.isEmpty { Text(notes) }
      }
      Section("Acknowledgments") {
        ForEach(promises, id: \.0) { key, label in
          Toggle(
            label,
            isOn: Binding(
              get: { acknowledgments[key] ?? false }, set: { acknowledgments[key] = $0 }))
        }
      }
      Section("Your signature") {
        Text("Signed by \(store.session?.user.name ?? "")").font(.subheadline)
        SignaturePad(signature: $signature, clearID: clearID).frame(height: 180).overlay(
          RoundedRectangle(cornerRadius: 8).stroke(.gray.opacity(0.5)))
        Button("Clear signature") {
          signature = ""
          clearID = UUID()
        }
      }
    }
  }
  func validate(_ index: Int) -> String {
    if index == 2 && !pendingReceiptPages.isEmpty {
      return "Upload or remove the remaining scanned receipt pages before continuing."
    }
    if index == 0 {
      guard let value = Int(mileage), value >= 0, value <= 9_999_999 else {
        return "Enter a valid whole-number odometer reading."
      }
      if let trip {
        if value < (trip.odometerReplacement?.newReading ?? trip.startingMileage) {
          return "Ending mileage cannot be below the starting reading."
        }
        if trip.odometerReplacement != nil && !replacementAcknowledged {
          return "Acknowledge the documented odometer replacement."
        }
      } else if !confirmed || due <= Date() {
        return "Confirm the odometer and select a future return time."
      }
    }
    if index == 1 && (questions.contains { checks[$0.0] == nil } || windshield.isEmpty) {
      return "Answer every condition question and select the windshield condition."
    }
    if index == 2
      && requiredViews.contains(where: { required in
        !photos.contains(where: { $0.view == required })
      })
    {
      return "Store every required photo before continuing."
    }
    return ""
  }
  func uploadReceiptPages() async {
    defer { loadingPhoto = false }
    while let page = pendingReceiptPages.first {
      guard await upload(page, source: "camera", view: "receipt") else { return }
      pendingReceiptPages.removeFirst()
    }
  }
  @discardableResult
  func upload(_ data: Data, source: String, view: String? = nil) async -> Bool {
    guard !busy, ownerSession == store.revision, store.session != nil else { return false }
    guard photos.count < 30 else {
      error = "Each inspection allows 30 photos and receipt pages combined."
      return false
    }
    guard data.count <= 12 * 1024 * 1024 else {
      error = "Photographs must be no larger than 12 MB."
      return false
    }
    busy = true
    error = ""
    defer { busy = false }
    var metadata: [String: Any] = [
      "vehicleId": vehicle.id, "stage": stage, "view": view ?? viewName, "draftId": draftID,
      "source": source,
    ]
    if source == "camera" {
      metadata["deviceCapturedAt"] = ISO8601DateFormatter().string(from: Date())
    }
    if let trip { metadata["tripId"] = trip.id }
    do {
      let photo = try await store.api.upload(data, metadata: metadata)
      guard ownerSession == store.revision, store.session != nil else { return false }
      if !photos.contains(where: { $0.id == photo.id }) { photos.append(photo) }
      if let next = requiredViews.first(where: { required in
        !photos.contains(where: { $0.view == required })
      }) {
        viewName = next
      }
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }
  func submit() async {
    guard !busy, ownerSession == store.revision, store.session != nil else { return }
    if pendingBody == nil {
      for index in 0...2 {
        let issue = validate(index)
        if !issue.isEmpty {
          error = issue
          step = index
          return
        }
      }
      guard promises.allSatisfy({ acknowledgments[$0.0] == true }), !signature.isEmpty else {
        error = "Accept every acknowledgment and draw your signature."
        return
      }
      let inspection = Inspection(
        fuelFull: checks["fuelFull"] == "yes", interiorClean: checks["interiorClean"] == "yes",
        gasCard: checks["gasCard"] == "yes",
        receiptReceived: returning ? checks["receiptReceived"] == "yes" : nil,
        keyReturned: returning ? checks["keyReturned"] == "yes" : nil, windshield: windshield,
        damage: marks, damageScope: returning ? "new" : "all", notes: notes)
      do {
        var body: [String: Any] = [
          "draftId": draftID,
          "inspection": try JSONSerialization.jsonObject(with: JSONEncoder().encode(inspection)),
          "photoIds": photos.map(\.id), "signature": signature, "acknowledgments": acknowledgments,
        ]
        if returning {
          body["endingMileage"] = Int(mileage)
          if let replacement = trip?.odometerReplacement {
            body["odometerReplacementId"] = replacement.id
            body["odometerReplacementAcknowledged"] = replacementAcknowledged
          }
        } else {
          body["vehicleId"] = vehicle.id
          body["startingMileage"] = Int(mileage)
          body["mileageConfirmed"] = true
          body["projectedReturnAt"] = ISO8601DateFormatter().string(from: due)
        }
        pendingBody = body
        pendingKey = UUID().uuidString
      } catch {
        self.error = error.localizedDescription
        return
      }
    }
    busy = true
    error = ""
    defer { busy = false }
    do {
      let result: TripResult = try await store.api.request(
        returning ? "/api/trips/\(trip!.id)/return" : "/api/trips/checkout", method: "POST",
        body: pendingBody, key: pendingKey)
      completed = result.trip
      pendingBody = nil
      await store.refresh()
    } catch let failure as FleetError {
      error = failure.localizedDescription
      if failure.status > 0 && failure.status < 500 { pendingBody = nil }
    } catch { self.error = error.localizedDescription }
  }
}

import AVFoundation
import PhotosUI
import SwiftUI
import VisionKit

struct InspectionView: View {
  @Environment(\.dynamicTypeSize) private var textSize
  @EnvironmentObject var store: FleetStore
  @Environment(\.dismiss) private var dismiss
  let vehicle: Vehicle
  let trip: Trip?
  var reservation: FleetBooking? = nil
  @State private var step = 0
  @State private var draftID = UUID().uuidString.lowercased()
  @State private var due = Date().addingTimeInterval(3600)
  @State private var mileage = ""
  @State private var confirmed = false
  @State private var checks: [String: String] = [:]
  @State private var windshield = ""
  @State private var marks: [Damage] = []
  @State private var missingEmergencyKits = ""
  @State private var notes = ""
  @State private var area = "front"
  @State private var damageType = "dent"
  @State private var photos: [FleetPhoto] = []
  @State private var viewName = "front"
  @State private var selectedPhoto: PhotosPickerItem?
  @State private var camera = false
  @State private var receiptScanner = false
  @State private var queued: [QueuedInspectionPhoto] = []
  @State private var vault: NativeDraftVault?
  @State private var saved: InspectionDraft?
  @State private var unlocking = true
  @State private var finished = false
  @State private var draftStatus = "Draft saves on this device for 24 hours."
  @State private var signature = ""
  @State private var clearID = UUID()
  @State private var acknowledgments: [String: Bool] = [:]
  @State private var replacementAcknowledged = false
  @State private var pendingBody: Data?
  @State private var pendingKey = ""
  @State private var busy = false
  @State private var loadingPhoto = false
  @State private var ownerSession: UUID?
  @State private var error = ""
  @State private var cancel = false
  @State private var preview: FleetDocument?
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
  private static let kitQuestion =
    "Are all emergency service kits assigned to this vehicle present?"
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
    result.append(("emergencyKitsPresent", Self.kitQuestion))
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
  private func inspectionMessage<Content: View>(@ViewBuilder content: () -> Content) -> some View {
    ScrollView {
      VStack(spacing: 16, content: content)
        .multilineTextAlignment(.center)
        .controlSize(.large)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity)
        .padding(24)
    }
    .defaultScrollAnchor(.center, for: .alignment)
  }

  var body: some View {
    Group {
      if let completed {
        inspectionMessage {
          Image(systemName: "checkmark.seal.fill").font(.system(size: 64)).foregroundStyle(
            Color("FleetAccent"))
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
        }
      } else if unlocking {
        ProgressView("Opening your private draft…")
      } else if let saved {
        inspectionMessage {
          Text("Resume inspection").font(.title.bold())
          Text("You have an unfinished \(stage) for \(vehicle.name) on this device.")
          if !error.isEmpty { Text(error).foregroundStyle(Color("FleetError")) }
          Button("Resume inspection") {
            restore(saved)
            self.saved = nil
          }.buttonStyle(.borderedProminent).foregroundStyle(Color("FleetOnAccent"))
          if saved.pendingBody == nil {
            Button("Discard draft", role: .destructive) { cancel = true }.buttonStyle(.bordered)
              .confirmationDialog(
                "Discard this unfinished inspection?", isPresented: $cancel,
                titleVisibility: .visible
              ) {
                Button("Discard draft", role: .destructive) {
                  do {
                    try vault?.remove()
                    finished = true
                    dismiss()
                  } catch { self.error = error.localizedDescription }
                }
              }
          }
          Button("Back to fleet") { dismiss() }.buttonStyle(.bordered)
        }
      } else if vault == nil {
        inspectionMessage {
          Text(error)
          Button("Retry opening inspection") { Task { await unlock() } }
            .buttonStyle(.borderedProminent).foregroundStyle(Color("FleetOnAccent"))
          Button("Back to fleet") { dismiss() }.buttonStyle(.bordered)
        }
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
          Text(draftStatus).font(.footnote).foregroundStyle(.secondary)
          if !error.isEmpty {
            Text(error).foregroundStyle(Color("FleetError")).accessibilityIdentifier(
              "workflowError")
          }
          Group {
            if step == 0 { tripDetails }
            if step == 1 { inspection }
            if step == 2 { photographSection }
            if step == 3 { review }
          }.disabled(busy || loadingPhoto || pendingBody != nil)
          if pendingBody != nil {
            Text(
              "Submission status is uncertain. Retry the same submission to check its status."
            ).foregroundStyle(Color("FleetWarning"))
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
              }.buttonStyle(.borderedProminent).foregroundStyle(Color("FleetOnAccent"))
                .controlSize(.large).disabled(busy || loadingPhoto)
            } else {
              Button(
                busy
                  ? "Saving…"
                  : pendingBody != nil ? "Retry same submission" : "Sign & submit \(stage)"
              ) { Task { await submit() } }.buttonStyle(.borderedProminent)
                .foregroundStyle(Color("FleetOnAccent")).controlSize(.large).disabled(
                  busy || loadingPhoto)
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
      .sheet(item: $preview) { DocumentPreview(document: $0) }
      .toolbar {
        if completed == nil && vault != nil && saved == nil {
          Button("Save & exit") { if persist() { dismiss() } }.disabled(busy || loadingPhoto)
        }
      }
      .interactiveDismissDisabled(completed == nil)
      .task { if vault == nil { await unlock() } }
      .onChange(of: snapshot) { _, _ in if !unlocking && saved == nil && !finished { _ = persist() }
      }
      .sheet(isPresented: $camera) {
        CameraCapture { data in
          Task { await queueAndUpload([data], source: "camera", view: viewName) }
        }.ignoresSafeArea()
      }
      .fullScreenCover(isPresented: $receiptScanner) {
        ReceiptScanner(remainingPages: max(0, 30 - photos.count)) { pages in
          Task { await queueAndUpload(pages, source: "camera", view: "receipt") }
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
            await queueAndUpload([data], source: "upload", view: viewName)
          } catch { self.error = error.localizedDescription }
          selectedPhoto = nil
        }
      }
  }
  var tripDetails: some View {
    Section("Odometer & return time") {
      if let trip {
        LabeledContent("Starting mileage", value: trip.startingMileage.formatted())
        FleetTextField("Ending odometer reading", text: $mileage).keyboardType(.numberPad)
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
  private func conditionPicker(_ key: String, _ label: String) -> some View {
    Picker(label, selection: Binding(get: { checks[key] ?? "" }, set: { checks[key] = $0 })) {
      Text("Choose").tag("")
      Text("Yes").tag("yes")
      Text("No").tag("no")
    }
  }
  var inspection: some View {
    Group {
      Section("Condition checks") {
        ForEach(questions.filter { $0.0 != "emergencyKitsPresent" }, id: \.0) { key, label in
          conditionPicker(key, label)
        }
        Picker("Windshield", selection: $windshield) {
          Text("Choose").tag("")
          Text("Clear").tag("clear")
          Text("Star / chip").tag("star")
          Text("Cracked").tag("cracked")
        }
      }
      Section("Emergency equipment") {
        if let trip {
          LabeledContent(
            "Checkout answer",
            value: trip.checkoutInspection.emergencyKitsPresent.map { $0 ? "Yes" : "No" }
              ?? "Not recorded")
        }
        if let previous = trip?.checkoutInspection, previous.emergencyKitsPresent == false,
          let names = previous.missingEmergencyKits
        {
          LabeledContent("Missing at checkout", value: names)
        }
        conditionPicker("emergencyKitsPresent", Self.kitQuestion)
          .onChange(of: checks["emergencyKitsPresent"]) { _, answer in
            if answer != "no" { missingEmergencyKits = "" }
          }
        if checks["emergencyKitsPresent"] == "no" {
          TextField(
            "Which emergency kit or kits are missing?", text: $missingEmergencyKits, axis: .vertical
          )
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
        let types = Picker("Damage type", selection: $damageType) {
          ForEach(["chip", "dent", "scratch"], id: \.self) { Text(humanize($0)).tag($0) }
        }
        if textSize.isAccessibilitySize {
          types.pickerStyle(.menu)
        } else {
          types.pickerStyle(.segmented)
        }
        Text(store.workspaceContent.damageInstructions).font(.footnote)
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
                Image(systemName: "trash").frame(minWidth: 44, minHeight: 44)
              }.buttonStyle(.borderless).accessibilityLabel("Remove damage \(index + 1)")
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
          }.disabled(busy || loadingPhoto || photos.count >= 30 || !queued.isEmpty)
          Text(store.workspaceContent.receiptInstructions)
            .font(.footnote).foregroundStyle(.secondary)
        } else {
          Text(
            "Receipt scanning requires a supported iPhone or iPad camera. You can also select Receipt and take a photo, or choose a photo when imports are allowed."
          )
          .font(.footnote).foregroundStyle(.secondary)
        }
      }
      if !queued.isEmpty {
        Text("\(queued.count) photos or receipt pages waiting to upload.")
        Button("Retry uploads") { Task { await uploadQueue() } }.disabled(busy || loadingPhoto)
        Button("Remove unsaved photos", role: .destructive) {
          let old = queued
          queued = []
          if persist() { for item in old { vault?.removePhoto(item.id) } } else { queued = old }
        }.disabled(busy || loadingPhoto)
      }
      if UIImagePickerController.isSourceTypeAvailable(.camera) {
        Button("Take photo", systemImage: "camera") { camera = true }.disabled(
          busy || photos.count >= 30)
      } else {
        Text("Camera capture is unavailable on this device.")
          .font(.footnote).foregroundStyle(.secondary)
      }
      if store.session?.settings.allowPhotoImports == true {
        PhotosPicker(selection: $selectedPhoto, matching: .images, preferredItemEncoding: .current)
        { Label("Choose photo", systemImage: "photo") }.disabled(
          busy || loadingPhoto || photos.count >= 30)
      }
      if busy || loadingPhoto { ProgressView("Storing photos and receipt pages…") }
      ForEach(photos) { photo in
        VStack(alignment: .leading, spacing: 8) {
          Label(humanize(photo.view), systemImage: "checkmark.circle.fill")
            .foregroundStyle(Color("FleetAccent"))
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { photoActions(photo) }.fixedSize(horizontal: true, vertical: false)
            VStack(alignment: .leading, spacing: 8) { photoActions(photo) }
          }
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
        if checks["emergencyKitsPresent"] == "no" {
          LabeledContent("Missing emergency kits", value: missingEmergencyKits)
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
    if index == 1 && checks["emergencyKitsPresent"] == "no" {
      let names = missingEmergencyKits.trimmingCharacters(in: .whitespacesAndNewlines)
      if names.isEmpty { return "Name the missing emergency kit or kits." }
      if names.utf16.count > 120 { return "Use 120 characters or fewer for the missing kit names." }
    }
    if index == 2 && !queued.isEmpty {
      return "Upload or remove all waiting photos and receipt pages before continuing."
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
    if index == 1
      && (questions.contains { !["yes", "no"].contains(checks[$0.0] ?? "") } || windshield.isEmpty)
    {
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
  @ViewBuilder private func photoActions(_ photo: FleetPhoto) -> some View {
    Button {
      Task {
        busy = true
        defer { busy = false }
        do {
          preview = try await store.api.file(
            photo.url, name: "\(photo.id).jpg", title: "\(humanize(photo.view)) photo")
        } catch {
          self.error = error.localizedDescription
        }
      }
    } label: {
      Text("Preview").frame(minHeight: 32)
    }
    .buttonStyle(.bordered)
    .accessibilityLabel("Preview \(humanize(photo.view)) photo")
    Button(role: .destructive) {
      photos.removeAll { $0.id == photo.id }
    } label: {
      Text("Remove").frame(minHeight: 32)
    }
    .buttonStyle(.bordered)
    .accessibilityLabel("Remove \(humanize(photo.view)) photo")
  }

  var snapshot: InspectionDraft {
    InspectionDraft(
      draftID: draftID, step: step, mileage: mileage, due: due, confirmed: confirmed,
      checks: checks, windshield: windshield, marks: marks,
      missingEmergencyKits: missingEmergencyKits, notes: notes, photos: photos,
      uploads: queued, pendingBody: pendingBody, pendingKey: pendingKey)
  }
  func unlock() async {
    guard let owner = store.session?.user.id else { return }
    unlocking = true
    let revision = store.revision
    do {
      let result: DraftUnlock = try await store.api.request("/api/inspection-draft-key")
      guard revision == store.revision, owner == store.session?.user.id else { return }
      if let reservation { due = reservation.due }
      let context =
        NativeDraftVault.context(vehicle: vehicle, trip: trip)
        + (reservation.map { "/" + $0.id } ?? "")
      let opened = try NativeDraftVault(unlock: result, owner: owner, context: context)
      saved = try opened.load()
      if !returning { mileage = String(vehicle.currentMileage) }
      ownerSession = revision
      vault = opened
      error = ""
    } catch { self.error = error.localizedDescription }
    unlocking = false
  }
  func restore(_ d: InspectionDraft) {
    draftID = d.draftID
    step = d.step
    mileage = d.mileage
    due = d.due
    confirmed = d.confirmed
    checks = d.checks
    missingEmergencyKits = d.missingEmergencyKits ?? ""
    windshield = d.windshield
    marks = d.marks
    notes = d.notes
    photos = d.photos
    queued = d.uploads
    pendingBody = d.pendingBody
    pendingKey = d.pendingKey
  }
  @discardableResult func persist() -> Bool {
    guard let vault, ownerSession == store.revision, store.session != nil, !finished else {
      return false
    }
    do {
      try vault.save(snapshot)
      draftStatus = "Draft saved on this device for 24 hours."
      return true
    } catch {
      draftStatus = "Could not save the latest draft: " + error.localizedDescription
      return false
    }
  }
  func queueAndUpload(_ pages: [Data], source: String, view: String) async {
    guard let vault, ownerSession == store.revision else { return }
    guard queued.count + photos.count + pages.count <= 30,
      pages.allSatisfy({ $0.count <= 12 * 1024 * 1024 })
    else {
      error = "Each photo must be under 12 MB. An inspection can have up to 30 photos."
      return
    }
    var added: [QueuedInspectionPhoto] = []
    do {
      for data in pages {
        let item = QueuedInspectionPhoto(
          id: UUID(), source: source, view: view,
          capturedAt: source == "camera" ? ISO8601DateFormatter().string(from: Date()) : nil)
        try vault.storePhoto(data, id: item.id)
        added.append(item)
      }
      queued.append(contentsOf: added)
      guard persist() else { return }
      await uploadQueue()
    } catch {
      for item in added { vault.removePhoto(item.id) }
      self.error = error.localizedDescription
    }
  }
  func uploadQueue() async {
    guard let vault else { return }
    loadingPhoto = true
    defer { loadingPhoto = false }
    while let item = queued.first {
      do {
        let bytes = try vault.photo(item.id)
        guard await upload(bytes, item: item) else { return }
        queued.removeFirst()
        guard persist() else { return }
        vault.removePhoto(item.id)
      } catch {
        self.error = error.localizedDescription
        return
      }
    }
  }
  @discardableResult
  func upload(_ data: Data, item: QueuedInspectionPhoto) async -> Bool {
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
      "vehicleId": vehicle.id, "stage": stage, "view": item.view, "draftId": draftID,
      "source": item.source,
    ]
    if let captured = item.capturedAt { metadata["deviceCapturedAt"] = captured }
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
        emergencyKitsPresent: checks["emergencyKitsPresent"] == "yes",
        missingEmergencyKits: checks["emergencyKitsPresent"] == "no"
          ? missingEmergencyKits.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
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
          if let reservation { body["reservationId"] = reservation.id }
          body["vehicleId"] = vehicle.id
          body["startingMileage"] = Int(mileage)
          body["mileageConfirmed"] = true
          body["projectedReturnAt"] = ISO8601DateFormatter().string(from: due)
        }
        pendingBody = try JSONSerialization.data(withJSONObject: body, options: .sortedKeys)
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
      guard persist(), let pendingBody,
        let body = try JSONSerialization.jsonObject(with: pendingBody) as? [String: Any]
      else { return }
      let result: TripResult = try await store.api.request(
        returning ? "/api/trips/\(trip!.id)/return" : "/api/trips/checkout", method: "POST",
        body: body, key: pendingKey)
      finished = true
      try? vault?.remove()
      completed = result.trip
      self.pendingBody = nil
      await store.refresh()
    } catch let failure as FleetError {
      error = failure.localizedDescription
      if failure.status > 0 && failure.status < 500 { pendingBody = nil }
    } catch { self.error = error.localizedDescription }
  }
}

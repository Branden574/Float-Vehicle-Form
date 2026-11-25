import SwiftUI

struct WorkspaceView: View {
  @EnvironmentObject var store: FleetStore
  var body: some View {
    TabView {
      NavigationStack { FleetView() }.tabItem { Label("Fleet", systemImage: "car.2") }
      NavigationStack { HistoryView() }.tabItem { Label("Trips", systemImage: "list.clipboard") }
      NavigationStack { ProfileView() }.tabItem {
        Label("My profile", systemImage: "person.crop.circle")
      }
      if store.session?.user.role == "admin" {
        NavigationStack { AdminView() }.tabItem {
          Label("Admin", systemImage: "slider.horizontal.3")
        }
      }
    }
    .task(id: store.session?.rememberedUntil) {
      guard let value = store.session?.rememberedUntil,
        let expiry = try? Date(
          value,
          strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true).timeZone(
            separator: .colon))
      else { return }
      do { try await Task.sleep(for: .seconds(max(0, expiry.timeIntervalSinceNow))) } catch {
        return
      }
      if store.session?.rememberedUntil == value { await store.logout() }
    }
  }
}
struct FleetView: View {
  @Environment(\.dynamicTypeSize) private var textSize
  @EnvironmentObject var store: FleetStore
  @State private var search = ""
  var body: some View {
    List {
      Section { NavigationLink("Vehicle calendar & availability") { ReservationCalendar() } }
      if !store.error.isEmpty { Text(store.error).foregroundStyle(Color("FleetError")) }
      if !store.vehicleInspections.isEmpty {
        Section("Vehicles needing a physical inspection") {
          ForEach(store.vehicleInspections) { task in
            NavigationLink {
              VehicleInspectionView(task: task)
            } label: {
              VStack(alignment: .leading) {
                Text(task.name).font(.headline)
                Text("\(task.plate) · \(task.site)").font(.subheadline)
              }
            }
          }
        }
      }
      if !store.pendingReturns.isEmpty {
        Section("Returns awaiting your review") {
          ForEach(store.pendingReturns) { trip in
            NavigationLink {
              TripView(tripID: trip.id)
            } label: {
              TripRow(trip: trip)
            }
          }
        }
      }
      Section("My current checkouts") {
        let current = store.trips.filter {
          $0.employeeId == store.session?.user.id
            && ["active", "pending_checkout"].contains($0.status)
        }
        if current.isEmpty { Text("You have no vehicle checked out.").foregroundStyle(.secondary) }
        ForEach(current) { trip in
          NavigationLink {
            TripView(tripID: trip.id)
          } label: {
            TripRow(trip: trip)
          }
        }
      }
      Section {
        ForEach(
          store.vehicles.filter {
            search.isEmpty
              || "\($0.name) \($0.plate) \($0.site)".localizedCaseInsensitiveContains(search)
          }
        ) { vehicle in
          NavigationLink {
            VehicleView(vehicle: vehicle)
          } label: {
            let row =
              textSize.isAccessibilitySize
              ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
              : AnyLayout(HStackLayout(spacing: 16))
            row {
              if !textSize.isAccessibilitySize {
                Image(systemName: "car.side").font(.title).foregroundStyle(.tint).frame(width: 52)
                  .accessibilityHidden(true)
              }
              VStack(alignment: .leading, spacing: 5) {
                Text(vehicle.name).font(.headline)
                Text(
                  "\(vehicle.year.formatted(.number.grouping(.never))) \(vehicle.make) \(vehicle.model)"
                ).font(.subheadline)
                Text("\(vehicle.plate) · VIN •••• \(vehicle.vinLast4) · \(vehicle.site)").font(
                  .caption
                ).foregroundStyle(.secondary)
                Text(humanize(vehicle.status)).font(.caption.bold()).foregroundStyle(
                  vehicle.status == "available" ? Color("FleetAccent") : Color("FleetWarning"))
              }
              if !textSize.isAccessibilitySize { Spacer() }
              Text("\(vehicle.currentMileage.formatted()) mi").font(.subheadline.monospacedDigit())
                .multilineTextAlignment(.trailing)
            }.padding(.vertical, 8)
          }
        }
      } header: {
        Text("Find your next vehicle")
      } footer: {
        Text(store.workspaceContent.fleetReminder)
      }
    }.navigationTitle("Learn4Life Fleet").searchable(
      text: $search, prompt: "Vehicle, plate or site"
    )
    .modifier(FleetReleaseNotice())
    .refreshable { await store.refresh() }
    .toolbar {
      Button {
        Task { await store.refresh() }
      } label: {
        Label("Refresh", systemImage: "arrow.clockwise")
      }
    }
  }
}
private struct VehicleInspectionView: View {
  @EnvironmentObject var store: FleetStore
  @Environment(\.dismiss) private var dismiss
  let task: VehicleInspection
  @State private var inspected = false
  @State private var decision = ""
  @State private var reason = ""
  @State private var busy = false
  @State private var error = ""

  var body: some View {
    Form {
      Section(task.name) {
        Text("\(task.plate) · \(task.site)")
        Text("There is no current return form for this inspection. Inspect the vehicle, emergency kits, keys, and odometer in person before deciding whether it can return to service.")
      }
      Section {
        Toggle("I physically inspected this vehicle and was not the driver for this return", isOn: $inspected)
        Picker("Inspection decision", selection: $decision) {
          Text("Choose a decision").tag("")
          Text("Make available for checkout").tag("approve")
          Text("Take out of service").tag("hold")
        }
        FleetTextField("Inspection notes", text: $reason, axis: .vertical)
        if !error.isEmpty { Text(error).foregroundStyle(Color("FleetError")) }
        Button(busy ? "Saving…" : "Complete inspection") {
          Task {
            busy = true
            defer { busy = false }
            do {
              let _: EmptyResponse = try await store.api.request(
                "/api/vehicle-inspections/\(task.id)/resolve", method: "POST",
                body: ["inspected": inspected, "decision": decision, "reason": reason])
              await store.refresh()
              dismiss()
            } catch { self.error = error.localizedDescription }
          }
        }.disabled(busy || !inspected || decision.isEmpty || reason.trimmingCharacters(in: .whitespacesAndNewlines).count < 5)
      }
    }.navigationTitle("Physical inspection")
  }
}
struct VehicleView: View {
  @EnvironmentObject var store: FleetStore
  let vehicle: Vehicle
  @State private var hasDraft = false
  @State private var checkout = false
  @State private var discrepancy = false
  @State private var observed = ""
  @State private var reason = ""
  @State private var error = ""
  @State private var busy = false
  var body: some View {
    List {
      Section("Vehicle identification") {
        LabeledContent("Vehicle", value: "\(vehicle.year) \(vehicle.make) \(vehicle.model)")
        LabeledContent("Plate", value: vehicle.plate)
        LabeledContent("VIN last 4", value: vehicle.vinLast4)
        LabeledContent("Site", value: vehicle.site)
        LabeledContent("Odometer", value: "\(vehicle.currentMileage.formatted()) miles")
        LabeledContent("Status", value: humanize(vehicle.status))
      }
      if !vehicle.notes.isEmpty { Section("Vehicle notes") { Text(vehicle.notes) } }
      Section {
        Button(hasDraft ? "Resume checkout" : "Check out this vehicle") { checkout = true }
          .disabled(
            vehicle.status != "available" || store.session?.user.authorizedDriver != true
              || store.session?.user.charter.isEmpty != false)
        if store.session?.user.authorizedDriver != true {
          Text("Ask your administrator to authorize you as a driver.").foregroundStyle(.secondary)
        }
        if store.session?.user.charter.isEmpty != false {
          Text("Complete My profile before checkout.").foregroundStyle(.secondary)
        }
        Button("Report a mileage discrepancy") { discrepancy = true }
      }
    }.navigationTitle(vehicle.name)
      .onAppear { updateDraftLabel() }
      .sheet(isPresented: $checkout, onDismiss: updateDraftLabel) {
        NavigationStack { InspectionView(vehicle: vehicle, trip: nil) }
      }
      .sheet(isPresented: $discrepancy) {
        NavigationStack {
          Form {
            Text("Report the actual reading so an administrator can review it before checkout.")
            FleetTextField("Observed odometer", text: $observed).keyboardType(.numberPad)
            FleetTextField("Reason", text: $reason, axis: .vertical)
            if !error.isEmpty { Text(error).foregroundStyle(Color("FleetError")) }
            Button(busy ? "Sending…" : "Send for review") {
              Task {
                busy = true
                defer { busy = false }
                do {
                  let _: EmptyResponse = try await store.api.request(
                    "/api/vehicles/\(vehicle.id)/discrepancy", method: "POST",
                    body: ["observedMileage": Int(observed) ?? -1, "reason": reason])
                  await store.refresh()
                  discrepancy = false
                } catch { self.error = error.localizedDescription }
              }
            }.disabled(busy || Int(observed) == nil || reason.count < 5)
          }.navigationTitle("Mileage discrepancy").toolbar {
            Button("Cancel") { discrepancy = false }.disabled(busy)
          }
        }
      }
  }
  private func updateDraftLabel() {
    hasDraft = NativeDraftVault.hasDraft(
      owner: store.session?.user.id, context: NativeDraftVault.context(vehicle: vehicle, trip: nil))
  }
}
struct HistoryView: View {
  @EnvironmentObject var store: FleetStore
  var body: some View {
    List {
      if !store.error.isEmpty { Text(store.error).foregroundStyle(Color("FleetError")) }
      if store.trips.isEmpty {
        ContentUnavailableView(
          "No trips yet", systemImage: "list.clipboard",
          description: Text("Your signed checkout and return forms appear here."))
      }
      ForEach(store.trips) { trip in
        NavigationLink {
          TripView(tripID: trip.id)
        } label: {
          TripRow(trip: trip)
        }
      }
    }.navigationTitle("Trip history").refreshable { await store.refresh() }
  }
}
struct TripRow: View {
  let trip: Trip
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(trip.vehicleSnapshot.name).font(.headline)
      Text(trip.employeeSnapshot.name).font(.subheadline)
      Text(displayDate(trip.checkoutAt)).font(.caption).foregroundStyle(.secondary)
      Text(trip.overdue ? "Overdue · \(humanize(trip.status))" : humanize(trip.status)).font(
        .caption.bold()
      ).foregroundStyle(trip.overdue ? Color("FleetError") : .secondary)
    }.padding(.vertical, 6)
  }
}
struct TripView: View {
  @EnvironmentObject var store: FleetStore
  let tripID: String
  @State private var detail: TripDetail?
  @State private var error = ""
  @State private var hasReturnDraft = false
  @State private var returning = false
  @State private var reviewing = false
  @State private var revision: MileageRevision?
  @State private var preview: FleetDocument?
  @State private var busy = false
  var body: some View {
    List {
      if !error.isEmpty { Text(error).foregroundStyle(Color("FleetError")) }
      if let detail {
        let trip = detail.trip
        Section(trip.vehicleSnapshot.name) {
          LabeledContent("Employee", value: trip.employeeSnapshot.name)
          LabeledContent("Charter", value: trip.employeeSnapshot.displayedCharter)
          LabeledContent("Status", value: humanize(trip.status))
          LabeledContent("Checked out", value: displayDate(trip.checkoutAt))
          LabeledContent("Due", value: displayDate(trip.projectedReturnAt))
          LabeledContent("Start", value: "\(trip.startingMileage.formatted()) miles")
          if let ending = trip.endingMileage {
            LabeledContent("End", value: "\(ending.formatted()) miles")
          }
          if let mileage = trip.tripMileage {
            LabeledContent("Trip distance", value: "\(mileage.formatted()) miles")
          }
        }
        if !trip.flags.isEmpty {
          Section("Needs attention") { ForEach(trip.flags, id: \.self) { Text($0) } }
        }
        Section("Forms & evidence") {
          Button("Checkout form · front, back & photos") { Task { await report("checkout") } }
            .disabled(busy)
          if trip.returnedAt != nil {
            Button("Both forms · front, back & photos") { Task { await report("return") } }
              .disabled(busy)
          }
          if busy { ProgressView("Preparing private PDF…") }
          ForEach(detail.photos) { photo in
            Button("\(humanize(photo.stage)) · \(humanize(photo.view)) photo") {
              Task { await photoFile(photo) }
            }.disabled(busy)
          }
        }
        Section("Vehicle condition") {
          DamageDiagram(
            marks: .constant(trip.returnInspection?.damage ?? []),
            previous: trip.checkoutInspection.damage, editable: false, selectedArea: "front",
            selectedType: "dent", currentPrefix: "N"
          ).frame(height: 400)
          Text("Amber C = checkout damage. Blue N = new return damage.").font(.footnote)
          Text(
            trip.checkoutInspection.notes.isEmpty
              ? "No checkout notes." : trip.checkoutInspection.notes)
          ForEach(Array(trip.checkoutInspection.damage.enumerated()), id: \.offset) { index, mark in
            Text("C\(index + 1): \(humanize(mark.area)) · \(humanize(mark.type)) · \(mark.notes)")
              .font(.caption)
          }
          if let inspection = trip.returnInspection {
            ForEach(Array(inspection.damage.enumerated()), id: \.offset) { index, mark in
              Text("N\(index + 1): \(humanize(mark.area)) · \(humanize(mark.type)) · \(mark.notes)")
                .font(.caption)
            }
            Text(inspection.notes.isEmpty ? "No return notes." : inspection.notes)
          }
        }
        if trip.status == "active" && trip.employeeId == store.session?.user.id {
          Button(hasReturnDraft ? "Resume return" : "Return this vehicle") { returning = true }
            .buttonStyle(.borderedProminent)
            .foregroundStyle(Color("FleetOnAccent"))
        }
        if trip.status == "returned"
          ? detail.canReviewReturn == true : store.session?.user.role == "admin",
          trip.employeeId != store.session?.user.id,
          ["pending_checkout", "returned"].contains(trip.status),
          !detail.reviews.contains(where: {
            $0.stage == (trip.status == "returned" ? "return" : "checkout")
          })
        {
          Button("Representative review") { reviewing = true }
        }
        if !detail.revisions.isEmpty {
          Section("Documented mileage corrections") {
            Text("Original signed readings remain on the record. Review each documented change.")
              .font(.footnote)
            ForEach(detail.revisions) { change in
              VStack(alignment: .leading, spacing: 8) {
                Text(
                  "\(change.field == "startingMileage" ? "Starting mileage" : "Ending mileage"): \(change.originalValue.formatted()) → \(change.correctedValue.formatted())"
                ).font(.headline)
                Text(change.reason)
                Text(
                  change.acknowledgedAt == nil
                    ? "Employee acknowledgment pending" : "Acknowledged by employee"
                ).font(.caption)
                if change.acknowledgedAt == nil && trip.employeeId == store.session?.user.id {
                  Button("Review and acknowledge") { revision = change }
                }
              }
            }
          }
        }
        ForEach(detail.reviews) { review in
          Section("\(humanize(review.stage)) review") {
            Text("\(review.initials) · \(humanize(review.decision))")
            Text(review.reason)
          }
        }
      } else {
        ProgressView("Loading trip…")
      }
    }.navigationTitle("Trip record").task { await load() }.refreshable { await load() }
      .sheet(item: $preview) { DocumentPreview(document: $0) }
      .sheet(isPresented: $returning, onDismiss: { Task { await load() } }) {
        if let trip = detail?.trip {
          NavigationStack {
            InspectionView(
              vehicle: store.vehicles.first(where: { $0.id == trip.vehicleId })
                ?? trip.vehicleSnapshot, trip: trip)
          }
        }
      }
      .sheet(item: $revision, onDismiss: { Task { await load() } }) { change in
        NavigationStack { CorrectionAcknowledgment(tripID: tripID, revision: change) }
      }
      .sheet(isPresented: $reviewing, onDismiss: { Task { await load() } }) {
        if let trip = detail?.trip { NavigationStack { ReviewView(trip: trip) } }
      }
  }
  func load() async {
    do {
      detail = try await store.api.request("/api/trips/\(tripID)")
      hasReturnDraft = NativeDraftVault.hasDraft(
        owner: store.session?.user.id, context: "return/" + tripID)
      error = ""
    } catch { self.error = error.localizedDescription }
  }
  func report(_ stage: String) async {
    busy = true
    defer { busy = false }
    do {
      preview = try await store.api.file(
        "/api/trips/\(tripID)/report?stage=\(stage)",
        name: detail?.reportFilenames?[stage] ?? "fleet-\(tripID)-\(stage).pdf",
        title: stage == "checkout" ? "Checkout form" : "Checkout and check-in forms")
    } catch { self.error = error.localizedDescription }
  }
  func photoFile(_ photo: FleetPhoto) async {
    busy = true
    defer { busy = false }
    do {
      preview = try await store.api.file(
        photo.url, name: "\(photo.id).jpg", title: "\(humanize(photo.view)) photo")
    } catch {
      self.error = error.localizedDescription
    }
  }
}
/// Keeps editable values identifiable after autofill and at larger text sizes.
struct FleetTextField: View {
  let title: String
  @Binding var text: String
  var axis: Axis = .horizontal

  init(_ title: String, text: Binding<String>, axis: Axis = .horizontal) {
    self.title = title
    self._text = text
    self.axis = axis
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title).font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
      TextField(title, text: $text, prompt: Text(""), axis: axis).accessibilityLabel(title)
    }
  }
}

struct ProfileView: View {
  @EnvironmentObject var store: FleetStore
  @State private var name = ""
  @State private var charter = ""
  @State private var department = ""
  @State private var manager = ""
  @State private var message = ""
  @State private var busy = false
  @State private var pendingAction: ProfileAction?
  @State private var passkeyCount = 0
  @State private var passkeyMessage = ""
  var body: some View {
    Form {
      Section {
        FleetTextField("Full name", text: $name).textContentType(.name)
        LabeledContent("Email", value: store.session?.user.email ?? "")
        FleetTextField("Charter / school", text: $charter)
        FleetTextField("Department (optional)", text: $department)
        FleetTextField("Manager", text: $manager)
      } header: {
        Text("Your saved details")
      } footer: {
        Text(
          "Your profile is encrypted on the server and prefills future checkouts. Signed trips retain their original details."
        )
      }
      if !message.isEmpty { Text(message) }
      Button(busy ? "Saving…" : "Save my details") {
        Task {
          busy = true
          defer { busy = false }
          do {
            let result: FleetSession = try await store.api.request(
              "/api/auth/profile", method: "PATCH",
              body: [
                "name": name, "email": store.session?.user.email ?? "", "charter": charter,
                "department": department, "manager": manager,
              ])
            store.accept(result)
            message = "Your details are saved."
          } catch { message = error.localizedDescription }
        }
      }.disabled(
        busy || name.trimmingCharacters(in: .whitespaces).isEmpty
          || charter.trimmingCharacters(in: .whitespaces).isEmpty
          || manager.trimmingCharacters(in: .whitespaces).isEmpty)
      if store.session?.user.canAccessFleet != false {
        Section {
          Text(
            "Tap Create a passkey, choose Passwords if asked, then confirm with Face ID, Touch ID, or your device passcode."
          )
          .font(.subheadline)
          Button("Create a passkey") {
            Task {
              busy = true
              passkeyMessage = ""
              defer { busy = false }
              do {
                try await store.api.createPasskey()
                passkeyCount += 1
                passkeyMessage = "Passkey saved. Next time, tap Sign in with a passkey."
              } catch { passkeyMessage = error.localizedDescription }
            }
          }.disabled(busy)
          if passkeyCount > 0 {
            ProfileActionRow(
              action: .removePasskeys, pending: $pendingAction,
              explanation:
                "This removes every passkey for your Fleet Checkout account. You can still sign in with an email code.",
              confirmTitle: "Remove passkeys"
            ) {
              busy = true
              passkeyMessage = ""
              Task {
                defer { busy = false }
                do {
                  let _: EmptyResponse = try await store.api.request(
                    "/api/auth/passkeys/remove", method: "POST", body: [:])
                  passkeyCount = 0
                  passkeyMessage = "Passkeys removed."
                } catch { passkeyMessage = error.localizedDescription }
              }
            }.disabled(busy)
          }
          if !passkeyMessage.isEmpty { Text(passkeyMessage).font(.callout) }
        } header: {
          Text("Passkey sign-in")
        } footer: {
          Text(
            "Use your personal password manager. On a shared iPad, use your own phone or sign in by email."
          )
        }.task {
          if let result: PasskeyCount = try? await store.api.request("/api/auth/passkeys") {
            passkeyCount = result.count
          }
        }
      }
      Section {
        ProfileActionRow(
          action: .signOut, pending: $pendingAction,
          explanation: "Your session ends and private files on this device are cleared.",
          confirmTitle: "Confirm sign out"
        ) {
          busy = true
          Task { await store.logout() }
        }.disabled(busy)
        Link("Open web workspace", destination: store.api.baseURL)
        Link("Privacy policy", destination: FleetAPI.origin.appendingPathComponent("privacy"))
        Link("Support", destination: FleetAPI.origin.appendingPathComponent("support"))
        NavigationLink("Delete my account", destination: DeleteAccountView())
      } header: {
        if let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
          as? String,
          let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        {
          Text("Fleet Checkout \(version) · Build \(build)").textCase(nil)
            .accessibilityIdentifier("profile.appVersion")
        }
      }
    }.navigationTitle("My profile").onAppear {
      name = store.session?.user.name ?? ""
      charter = store.session?.user.charter ?? ""
      department = store.session?.user.department ?? ""
      manager = store.session?.user.manager ?? ""
    }
    .onDisappear { pendingAction = nil }
  }
}

private enum ProfileAction: String {
  case signOut = "Sign out"
  case removePasskeys = "Remove all passkeys"
}

private struct ProfileActionRow: View {
  let action: ProfileAction
  @Binding var pending: ProfileAction?
  let explanation: String
  let confirmTitle: String
  let onConfirm: () -> Void
  private var expanded: Bool { pending == action }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        pending = expanded ? nil : action
      } label: {
        HStack {
          Text(action.rawValue)
          Spacer()
          Image(systemName: expanded ? "chevron.up" : "chevron.down")
            .font(.caption.weight(.semibold)).accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityValue(expanded ? "Expanded" : "Collapsed")

      if expanded {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 12) { controls }.fixedSize(horizontal: true, vertical: false)
          VStack(alignment: .leading, spacing: 8) { controls }
        }
        Text(explanation).font(.subheadline).foregroundStyle(.secondary)
          .padding(.bottom, 4)
      }
    }
  }

  @ViewBuilder private var controls: some View {
    Button {
      pending = nil
    } label: {
      Text("Cancel").frame(minHeight: 36)
    }
    .buttonStyle(.bordered)
    Button(role: .destructive) {
      pending = nil
      onConfirm()
    } label: {
      Text(confirmTitle).frame(minHeight: 36)
    }
    .buttonStyle(.bordered)
    .tint(Color("FleetError"))
    .accessibilityHint(explanation)
  }
}

struct CorrectionAcknowledgment: View {
  @EnvironmentObject var store: FleetStore
  @Environment(\.dismiss) private var dismiss
  let tripID: String
  let revision: MileageRevision
  @State private var signature = ""
  @State private var clearID = UUID()
  @State private var reviewed = false
  @State private var busy = false
  @State private var error = ""
  var body: some View {
    Form {
      Section("Documented correction") {
        LabeledContent("Original reading", value: revision.originalValue.formatted())
        LabeledContent("Corrected reading", value: revision.correctedValue.formatted())
        Text(revision.reason)
        Text(displayDate(revision.createdAt)).font(.caption)
      }
      Toggle("I reviewed and acknowledge this correction", isOn: $reviewed).disabled(busy)
      SignaturePad(signature: $signature, clearID: clearID).frame(height: 180).disabled(busy)
      Button("Clear signature") {
        signature = ""
        clearID = UUID()
      }.disabled(busy)
      if !error.isEmpty { Text(error).foregroundStyle(Color("FleetError")) }
      Button(busy ? "Saving…" : "Sign acknowledgment") {
        Task {
          busy = true
          defer { busy = false }
          do {
            let _: EmptyResponse = try await store.api.request(
              "/api/trips/\(tripID)/revisions/\(revision.id)/acknowledge", method: "POST",
              body: ["signature": signature])
            await store.refresh()
            dismiss()
          } catch { self.error = error.localizedDescription }
        }
      }.disabled(busy || !reviewed || signature.isEmpty)
    }.navigationTitle("Mileage acknowledgment")
      .toolbar { Button("Cancel") { dismiss() }.disabled(busy) }
      .interactiveDismissDisabled(busy)
  }
}

import SwiftUI

struct AdminView: View {
  @EnvironmentObject var store: FleetStore
  @State private var overview: AdminOverview?
  @State private var recipients = ""
  @State private var employeeCopy = true
  @State private var message = ""
  @State private var busy = false
  var body: some View {
    Form {
      if !message.isEmpty { Text(message) }
      Section {
        TextField("assistant@school.org", text: $recipients, axis: .vertical)
          .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.emailAddress)
          .lineLimit(3...8)
        Toggle("Send employee a copy", isOn: $employeeCopy)
        Button(busy ? "Saving…" : "Save form recipients") { Task { await saveRecipients() } }
          .disabled(busy)
      } header: {
        Text("Completed-form email copies")
      } footer: {
        Text(
          "Enter one email per line, up to 20. These recipients receive the checkout and check-in PDF forms, including front, back and photos, after any required representative review."
        )
      }
      if let overview {
        Section("Staff access") {
          ForEach(overview.users) { user in
            NavigationLink {
              StaffEditor(user: user, onSave: { Task { await load() } })
            } label: {
              VStack(alignment: .leading) {
                Text(user.name)
                Text(user.email).font(.caption).foregroundStyle(.secondary)
                Text(user.authorizedDriver ? "Authorized driver" : "Driver approval needed").font(
                  .caption)
              }
            }
          }
        }
        Section("Vehicles") {
          ForEach(overview.vehicles) { vehicle in
            NavigationLink {
              VehicleEditor(vehicle: vehicle, onSave: { Task { await load() } })
            } label: {
              Text(vehicle.name)
              Spacer()
              Text(humanize(vehicle.status)).font(.caption).foregroundStyle(.secondary)
            }
          }
          NavigationLink("Add a vehicle") {
            VehicleEditor(vehicle: nil, onSave: { Task { await load() } })
          }
        }
      }
      Section("Additional administration") {
        Link("Open complete web administration", destination: FleetAPI.origin)
        Text(
          "Use the web dashboard for mileage corrections, odometer replacement documentation, notification retries, audit exports and organization settings."
        ).font(.footnote).foregroundStyle(.secondary)
      }
    }.navigationTitle("Administration").task { await load() }.refreshable { await load() }
  }
  func load() async {
    do {
      let result: AdminOverview = try await store.api.request("/api/admin/overview")
      overview = result
      recipients = (result.settings.notificationRecipients ?? []).joined(separator: "\n")
      employeeCopy = result.settings.employeeCopy
    } catch { message = error.localizedDescription }
  }
  func saveRecipients() async {
    busy = true
    defer { busy = false }
    let emails = Array(
      Set(
        recipients.components(separatedBy: CharacterSet(charactersIn: ",;\n")).map {
          $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }.filter { !$0.isEmpty })
    ).sorted()
    do {
      let result: SettingsResult = try await store.api.request(
        "/api/admin/settings", method: "PATCH",
        body: [
          "notificationRecipients": emails, "employeeCopy": employeeCopy,
          "reason": "Administrator updated completed-form email recipients in the native app",
        ])
      store.session?.settings = result.settings
      recipients = (result.settings.notificationRecipients ?? []).joined(separator: "\n")
      message = "Recipients saved for future checkout and check-in forms."
    } catch { message = error.localizedDescription }
  }
}
struct StaffEditor: View {
  @EnvironmentObject var store: FleetStore
  @Environment(\.dismiss) private var dismiss
  let user: FleetUser
  var onSave: () -> Void
  @State private var authorized = false
  @State private var active = true
  @State private var role = "staff"
  @State private var reason = ""
  @State private var error = ""
  @State private var busy = false
  var body: some View {
    Form {
      Section(user.name) {
        Text(user.email)
        Text("\(user.charter) · \(user.manager)")
      }
      Toggle("Authorized fleet driver", isOn: $authorized)
      Toggle("Active account", isOn: $active)
      Picker("Role", selection: $role) {
        Text("Staff").tag("staff")
        Text("Administrator").tag("admin")
      }
      TextField("Reason for this change", text: $reason, axis: .vertical)
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button(busy ? "Saving…" : "Save access") {
        Task {
          busy = true
          defer { busy = false }
          do {
            var body =
              try JSONSerialization.jsonObject(with: JSONEncoder().encode(user)) as! [String: Any]
            body.removeValue(forKey: "id")
            body["authorizedDriver"] = authorized
            body["active"] = active
            body["role"] = role
            body["reason"] = reason
            let _: EmptyResponse = try await store.api.request(
              "/api/admin/users/\(user.id)", method: "PATCH", body: body)
            onSave()
            dismiss()
          } catch { self.error = error.localizedDescription }
        }
      }.disabled(busy || reason.count < 5)
    }.navigationTitle("Staff access").onAppear {
      authorized = user.authorizedDriver
      active = user.active
      role = user.role
    }
  }
}
struct VehicleEditor: View {
  @EnvironmentObject var store: FleetStore
  @Environment(\.dismiss) private var dismiss
  let vehicle: Vehicle?
  var onSave: () -> Void
  @State private var name = ""
  @State private var make = ""
  @State private var model = ""
  @State private var year = "2026"
  @State private var plate = ""
  @State private var vin = ""
  @State private var site = ""
  @State private var mileage = "0"
  @State private var status = "available"
  @State private var notes = ""
  @State private var reason = ""
  @State private var error = ""
  @State private var busy = false
  var body: some View {
    Form {
      TextField("Vehicle name", text: $name)
      TextField("Make", text: $make)
      TextField("Model", text: $model)
      TextField("Year", text: $year).keyboardType(.numberPad)
      TextField("Plate", text: $plate)
      TextField("VIN last 4", text: $vin)
      TextField("Site", text: $site)
      TextField("Odometer", text: $mileage).keyboardType(.numberPad).disabled(vehicle != nil)
      if vehicle != nil {
        Text("Mileage corrections require documented review in the web administration dashboard.")
          .font(.footnote)
      }
      Picker("Status", selection: $status) {
        ForEach(
          ["available", "pending_review", "out_of_service"]
            + (vehicle?.status == "checked_out" ? ["checked_out"] : []), id: \.self
        ) { Text(humanize($0)).tag($0) }
      }.disabled(vehicle?.status == "checked_out")
      TextField("Notes", text: $notes, axis: .vertical)
      if vehicle != nil { TextField("Reason for this change", text: $reason, axis: .vertical) }
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button(busy ? "Saving…" : "Save vehicle") { Task { await save() } }.disabled(
        busy || name.isEmpty || make.isEmpty || model.isEmpty || plate.isEmpty || vin.count != 4
          || site.isEmpty || (vehicle != nil && reason.count < 5))
    }.navigationTitle(vehicle == nil ? "Add vehicle" : "Edit vehicle").onAppear {
      site = store.session?.settings.site ?? ""
      if let vehicle {
        name = vehicle.name
        make = vehicle.make
        model = vehicle.model
        year = String(vehicle.year)
        plate = vehicle.plate
        vin = vehicle.vinLast4
        site = vehicle.site
        mileage = String(vehicle.currentMileage)
        status = vehicle.status
        notes = vehicle.notes
      }
    }
  }
  func save() async {
    busy = true
    defer { busy = false }
    var body: [String: Any] = [
      "name": name, "make": make, "model": model, "year": Int(year) ?? 0, "plate": plate,
      "vinLast4": vin, "site": site, "currentMileage": Int(mileage) ?? -1, "status": status,
      "notes": notes, "photoUrl": vehicle?.photoUrl ?? "", "archived": vehicle?.archived ?? false,
    ]
    if vehicle != nil { body["reason"] = reason }
    do {
      let _: EmptyResponse = try await store.api.request(
        vehicle.map { "/api/admin/vehicles/\($0.id)" } ?? "/api/admin/vehicles",
        method: vehicle == nil ? "POST" : "PATCH", body: body)
      await store.refresh()
      onSave()
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}
struct ReviewView: View {
  @EnvironmentObject var store: FleetStore
  @Environment(\.dismiss) private var dismiss
  let trip: Trip
  @State private var initials = ""
  @State private var decision = "out_of_service"
  @State private var reason = ""
  @State private var signature = ""
  @State private var clearID = UUID()
  @State private var error = ""
  @State private var busy = false
  var body: some View {
    Form {
      Text(
        "Review \(trip.vehicleSnapshot.name) for \(trip.employeeSnapshot.name). Your authenticated signature is recorded with this decision."
      )
      Picker("Decision", selection: $decision) {
        Text("Approve / release").tag("approve")
        Text("Take out of service").tag("out_of_service")
      }
      TextField("Initials", text: $initials)
      TextField("Reason", text: $reason, axis: .vertical)
      SignaturePad(signature: $signature, clearID: clearID).frame(height: 180)
      Button("Clear signature") {
        signature = ""
        clearID = UUID()
      }
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Button(busy ? "Saving…" : "Save signed review") {
        Task {
          busy = true
          defer { busy = false }
          do {
            let _: EmptyResponse = try await store.api.request(
              "/api/trips/\(trip.id)/review", method: "POST",
              body: [
                "stage": trip.status == "returned" ? "return" : "checkout", "initials": initials,
                "decision": decision, "reason": reason, "signature": signature,
              ])
            await store.refresh()
            dismiss()
          } catch { self.error = error.localizedDescription }
        }
      }.disabled(busy || initials.isEmpty || reason.count < 5 || signature.isEmpty)
    }.navigationTitle("Representative review").toolbar {
      Button("Cancel") { dismiss() }.disabled(busy)
    }.interactiveDismissDisabled(busy)
  }
}

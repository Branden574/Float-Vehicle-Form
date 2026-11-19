import SwiftUI

struct FleetBooking: Decodable, Identifiable {
  let id, vehicleId, vehicle, site, start, end, status: String
  let mine, canCancel: Bool
  let owner, reason, canceledBy, canceledAt: String?
  let ongoing: Bool?
  static func instant(_ text: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: text) ?? ISO8601DateFormatter().date(from: text)
  }
  var pickup: Date { Self.instant(start) ?? .distantPast }
  var due: Date { Self.instant(end) ?? .distantPast }
}
private struct BookingList: Decodable { let events: [FleetBooking] }
private struct BookingNotice: Decodable, Identifiable {
  let id, status: String
  let event: FleetBooking
}
private struct BookingInbox: Decodable { let notices: [BookingNotice] }
private struct VehicleSlot: Decodable, Identifiable { let id, name, site, status: String }
private struct AvailableVehicles: Decodable { let vehicles: [VehicleSlot] }
private func bookingLabel(_ s: String) -> String {
  [
    "available": "Available for this period", "active": "Checked out",
    "pending_checkout": "Awaiting checkout approval", "pending_review": "Awaiting review",
    "checked_out": "Currently checked out", "canceled": "Canceled", "picked_up": "Picked up",
    "out_of_service": "Out of service",
  ][s] ?? s.capitalized
}
struct ReservationCalendar: View {
  @EnvironmentObject var store: FleetStore
  @Environment(\.horizontalSizeClass) private var size
  @Environment(\.scenePhase) private var phase
  @State private var mode = "Agenda"
  @State private var selectedDay: Date?
  @State private var day = Date()
  @State private var start = Date().addingTimeInterval(3600)
  @State private var end = Date().addingTimeInterval(7200)
  @State private var site = ""
  @State private var vehicle = ""
  @State private var canceled = false
  @State private var slots: [VehicleSlot]?
  @State private var selected: VehicleSlot?
  @State private var detail: FleetBooking?
  @State private var pickup: FleetBooking?
  @State private var events: [FleetBooking]?
  @State private var mine: [FleetBooking] = []
  @State private var notices: [BookingNotice] = []
  @State private var message = ""
  @State private var error = ""
  @State private var loadError = ""
  @State private var checking = false
  @State private var busy = false
  @State private var bookingID = UUID().uuidString
  @State private var requestID = UUID()
  @State private var refreshID = UUID()
  private var zone: TimeZone {
    TimeZone(identifier: store.session?.settings.timezone ?? "") ?? .current
  }
  private var cal: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = zone
    return c
  }
  private var first: Date {
    if mode == "Month" { return cal.dateInterval(of: .month, for: day)!.start }
    if mode == "Week" { return cal.dateInterval(of: .weekOfYear, for: day)!.start }
    return cal.startOfDay(for: day)
  }
  private var last: Date {
    mode == "Month"
      ? cal.date(byAdding: .month, value: 1, to: first)!
      : cal.date(byAdding: .day, value: mode == "Week" ? 7 : 30, to: first)!
  }
  private var queryKey: String {
    [mode, iso(first), site, vehicle, String(canceled), refreshID.uuidString].joined(separator: "|")
  }
  private var selectedKey: String { [iso(start), iso(end), site, vehicle].joined(separator: "|") }
  private func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
  private func formatted(_ date: Date) -> String {
    date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: zone))
  }
  private func query(_ start: Date, _ end: Date) -> String {
    var c = URLComponents()
    c.queryItems = [
      "start": iso(start), "end": iso(end), "site": site, "vehicleId": vehicle,
      "canceled": String(canceled),
    ].map { URLQueryItem(name: $0.key, value: $0.value) }
    return c.percentEncodedQuery ?? ""
  }
  var body: some View {
    List {
      Section("Fleet filters") {
        Picker("Site", selection: $site) {
          Text("All sites").tag("")
          ForEach(Array(Set(store.vehicles.map(\.site))).sorted(), id: \.self) { Text($0).tag($0) }
        }
        Picker("Vehicle", selection: $vehicle) {
          Text("All vehicles").tag("")
          ForEach(store.vehicles.filter { site.isEmpty || $0.site == site }) {
            Text($0.name).tag($0.id)
          }
        }
      }
      Section {
        DatePicker("Pickup", selection: $start)
        DatePicker("Expected return", selection: $end)
        Button(checking ? "Checking…" : "Check availability") { Task { await check() } }.disabled(
          checking)
        if let slots {
          if !slots.contains(where: { $0.status == "available" }) {
            Text("No vehicles available for the selected dates.")
          }
          ForEach(slots) { v in
            VStack(alignment: .leading, spacing: 5) {
              Text(v.name).font(.headline)
              Text(v.site + " · " + bookingLabel(v.status)).font(.subheadline)
              if v.status == "available", store.session?.user.authorizedDriver == true {
                Button("Select vehicle") {
                  selected = v
                  bookingID = UUID().uuidString
                }
              }
            }.padding(.vertical, 4)
          }
        }
      } header: {
        Text("Check availability")
      } footer: {
        Text("All times use " + zone.identifier)
      }
      if !message.isEmpty { Text(message).accessibilityAddTraits(.isStaticText) }
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      Section("Fleet schedule") {
        Picker("View", selection: $mode) {
          ForEach(["Month", "Week", "Agenda"], id: \.self) { Text($0) }
        }.pickerStyle(.segmented)
        HStack {
          Button("Previous") { move(-1) }
          Spacer()
          Button("Today") { day = Date() }
          Spacer()
          Button("Next") { move(1) }
        }.buttonStyle(.borderless)
        Text(
          first.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: zone))
            + " – "
            + cal.date(byAdding: .day, value: -1, to: last)!.formatted(
              Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: zone))
        ).font(.headline)
        Toggle("Include canceled reservations", isOn: $canceled)
        if !loadError.isEmpty {
          Text(loadError)
          Button("Retry calendar") { refreshID = UUID() }
        } else if let events {
          if events.isEmpty { Text("No bookings in this period.") }
          if mode == "Agenda" {
            ForEach(events) { r in eventButton(r) }
          } else if mode == "Month" {
            monthGrid(events)
          } else {
            let count = cal.dateComponents([.day], from: first, to: last).day ?? 0
            ForEach(0..<count, id: \.self) { n in
              let d = cal.date(byAdding: .day, value: n, to: first)!
              let next = cal.date(byAdding: .day, value: 1, to: d)!
              let rows = events.filter { $0.pickup < next && ($0.ongoing == true || $0.due > d) }
              if mode == "Week" || !rows.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                  Text(d.formatted(Date.FormatStyle(timeZone: zone).weekday(.wide).month().day()))
                    .font(.subheadline.bold())
                  if rows.isEmpty { Text("No bookings").font(.caption).foregroundStyle(.secondary) }
                  ForEach(rows) { eventButton($0) }
                }
              }
            }
          }
        } else {
          ProgressView("Loading schedule…")
        }
        Text(
          "Reserved holds a time. Checked out means a physical trip. Canceled bookings release the time."
        ).font(.footnote).foregroundStyle(.secondary)
      }
      if loadError.isEmpty, events != nil {
        Section("My upcoming reservations") {
          if mine.isEmpty { Text("You have no upcoming reservations.") }
          ForEach(mine) { eventButton($0) }
        }
        if !notices.isEmpty {
          Section("Cancellation notices") {
            ForEach(notices) { n in
              VStack(alignment: .leading) {
                eventButton(n.event)
                Text("Email · " + n.status).font(.caption)
                if n.status == "failed" {
                  Button("Retry email") {
                    Task {
                      do {
                        let _: EmptyResponse = try await store.api.request(
                          "/api/reservation-notices/" + n.id + "/retry", method: "POST", body: [:])
                        refreshID = UUID()
                      } catch { self.error = error.localizedDescription }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    .navigationTitle("Vehicle calendar").environment(\.timeZone, zone)
    .onChange(of: site) { _, _ in vehicle = "" }
    .onChange(of: selectedKey) { _, _ in
      slots = nil
      selected = nil
      requestID = UUID()
      checking = false
      error = ""
    }
    .task(id: queryKey) { await load() }
    .task(id: phase) {
      guard phase == .active else { return }
      refreshID = UUID()
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(60)) } catch { return }
        refreshID = UUID()
      }
    }
    .refreshable { refreshID = UUID() }
    .sheet(item: $selected) { v in
      NavigationStack {
        Form {
          Section("Reserve vehicle") {
            Text(v.name)
            Text(formatted(start) + " – " + formatted(end))
            Text(zone.identifier)
            Text(store.session?.user.name ?? "")
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            Button("Reserve vehicle") { Task { await reserve(v) } }.disabled(busy)
            Button("Back") { selected = nil }.disabled(busy)
          }
        }.navigationTitle("Reservation")
      }.interactiveDismissDisabled(busy)
    }
    .sheet(item: $detail) { r in
      BookingDetail(
        booking: r, zone: zone,
        onChanged: { _ in
          detail = nil
          message = "Reservation canceled. This booking no longer holds the vehicle."
          slots = nil
          refreshID = UUID()
        },
        onPickup: {
          detail = nil
          pickup = r
        })
    }
    .sheet(item: $pickup) { r in
      if let v = store.vehicles.first(where: { $0.id == r.vehicleId }) {
        NavigationStack { InspectionView(vehicle: v, trip: nil, reservation: r) }
      }
    }
  }
  @ViewBuilder private func monthGrid(_ rows: [FleetBooking]) -> some View {
    let count = cal.range(of: .day, in: .month, for: first)?.count ?? 0
    let blanks = cal.component(.weekday, from: first) - 1
    let day =
      selectedDay.flatMap { cal.isDate($0, equalTo: first, toGranularity: .month) ? $0 : nil }
      ?? first
    let next = cal.date(byAdding: .day, value: 1, to: day)!
    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 7), spacing: 4) {
      ForEach(0..<7, id: \.self) { i in
        Text(cal.veryShortWeekdaySymbols[i]).font(.caption).foregroundStyle(.secondary)
      }
      ForEach(0..<blanks, id: \.self) { _ in Color.clear.frame(height: 1) }
      ForEach(0..<count, id: \.self) { i in
        let date = cal.date(byAdding: .day, value: i, to: first)!
        let following = cal.date(byAdding: .day, value: 1, to: date)!
        let number = rows.filter { $0.pickup < following && ($0.ongoing == true || $0.due > date) }
          .count
        Button {
          selectedDay = date
        } label: {
          VStack(spacing: 2) {
            Text(String(i + 1)).font(.body)
            Text(number > 0 ? String(number) + "×" : " ").font(.caption2)
          }
          .frame(maxWidth: .infinity, minHeight: 44).background(
            cal.isDate(day, inSameDayAs: date) ? Color.accentColor.opacity(0.18) : .clear,
            in: RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain).accessibilityLabel(
          date.formatted(Date.FormatStyle(date: .complete, time: .omitted, timeZone: zone)) + ", "
            + String(number) + " bookings")
      }
    }
    let matches = rows.filter { $0.pickup < next && ($0.ongoing == true || $0.due > day) }
    if matches.isEmpty {
      Text("No bookings on this day.").font(.footnote)
    } else {
      ForEach(matches) { eventButton($0) }
    }
  }
  func eventButton(_ r: FleetBooking) -> some View {
    Button {
      detail = r
    } label: {
      VStack(alignment: .leading, spacing: 3) {
        Text(r.vehicle + " · " + bookingLabel(r.status))
        Text(
          formatted(r.pickup) + " – " + formatted(r.due) + (r.ongoing == true ? " · Overdue" : "")
        ).font(.caption).foregroundStyle(.secondary)
      }
    }.buttonStyle(.borderless)
  }
  func move(_ n: Int) {
    day =
      mode == "Month"
      ? cal.date(byAdding: .month, value: n, to: day)!
      : cal.date(byAdding: .day, value: n * (mode == "Week" ? 7 : 30), to: day)!
  }
  @MainActor func load() async {
    events = nil
    loadError = ""
    let key = queryKey
    do {
      async let a: BookingList = store.api.request("/api/reservations?" + query(first, last))
      async let b: BookingList = store.api.request("/api/my-reservations")
      async let c: BookingInbox = store.api.request("/api/reservation-inbox")
      let result = try await (a, b, c)
      guard !Task.isCancelled, key == queryKey else { return }
      events = result.0.events
      mine = result.1.events
      notices = result.2.notices
      if slots != nil && !checking && selected == nil { await check() }
    } catch { if !Task.isCancelled && key == queryKey { loadError = error.localizedDescription } }
  }
  @MainActor func check() async {
    guard start > Date(), end > start else {
      slots = nil
      error = "Choose a future pickup and later return."
      return
    }
    let id = UUID()
    requestID = id
    checking = true
    error = ""
    slots = nil
    defer { if requestID == id { checking = false } }
    do {
      let list: AvailableVehicles = try await store.api.request(
        "/api/availability?" + query(start, end))
      if id == requestID { slots = list.vehicles }
    } catch { if id == requestID { self.error = error.localizedDescription } }
  }
  @MainActor private func reserve(_ v: VehicleSlot) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    error = ""
    do {
      let _: FleetBooking = try await store.api.request(
        "/api/reservations", method: "POST",
        body: [
          "id": bookingID.lowercased(), "vehicleId": v.id, "start": iso(start), "end": iso(end),
        ])
      selected = nil
      slots = nil
      day = start
      refreshID = UUID()
      message = "Reservation confirmed."
    } catch { self.error = error.localizedDescription }
  }
}
private struct BookingDetail: View {
  @EnvironmentObject var store: FleetStore
  @Environment(\.dismiss) var dismiss
  let booking: FleetBooking
  let zone: TimeZone
  let onChanged: (FleetBooking) -> Void
  let onPickup: () -> Void
  @State private var cancel = false
  @State private var busy = false
  @State private var reason = ""
  @State private var error = ""
  private func time(_ d: Date) -> String {
    d.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: zone))
  }
  var body: some View {
    NavigationStack {
      Form {
        Section(booking.vehicle) {
          Text(bookingLabel(booking.status) + " · " + booking.site)
          Text(time(booking.pickup) + " – " + time(booking.due))
          Text(zone.identifier)
          if let owner = booking.owner { Text("Reserved by " + owner) }
          if let at = booking.canceledAt, let d = FleetBooking.instant(at) {
            Text("Canceled " + time(d) + " · " + (booking.canceledBy ?? "Former staff member"))
          }
          if let r = booking.reason, !r.isEmpty { Text(r) }
        }
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        if cancel {
          Section("Cancel reservation?") {
            Text("Canceling releases this vehicle for the dates and times shown.")
            TextField("Reason (optional)", text: $reason, axis: .vertical)
            Button("Keep reservation") { cancel = false }
            Button("Cancel reservation", role: .destructive) { Task { await submit() } }
          }.disabled(busy)
        } else {
          if booking.canCancel {
            Button("Cancel reservation", role: .destructive) { cancel = true }
          }
          if booking.mine && booking.status == "reserved" && booking.pickup <= Date()
            && booking.due > Date()
          {
            Button("Start checkout inspection", action: onPickup)
          }
        }
      }.navigationTitle("Reservation details").toolbar {
        Button("Close") { dismiss() }.disabled(busy)
      }
    }.interactiveDismissDisabled(busy)
  }
  @MainActor func submit() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let event: FleetBooking = try await store.api.request(
        "/api/reservations/" + booking.id + "/cancel", method: "POST", body: ["reason": reason])
      cancel = false
      onChanged(event)
    } catch { self.error = error.localizedDescription }
  }
}

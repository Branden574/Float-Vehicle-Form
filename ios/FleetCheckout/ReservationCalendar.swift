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
    "available": "Available for your selected time", "active": "Checked out",
    "pending_checkout": "Awaiting checkout approval", "pending_review": "Awaiting review",
    "checked_out": "Currently checked out", "canceled": "Canceled", "picked_up": "Picked up",
    "out_of_service": "Out of service",
  ][s] ?? s.capitalized
}
private func friendlyZone(_ zone: TimeZone) -> String {
  zone.localizedName(for: .generic, locale: .current) ?? zone.localizedName(
    for: .standard, locale: .current) ?? zone.identifier.replacingOccurrences(of: "_", with: " ")
}
private struct BookingBadge: View {
  let status: String
  private var hue: Color {
    switch status {
    case "available", "returned": return Color("FleetAccent")
    case "reserved", "active", "checked_out", "picked_up": return Color("FleetActive")
    case "pending_checkout", "pending_review": return Color("FleetWarning")
    case "out_of_service", "rejected": return Color("FleetError")
    default: return .secondary
    }
  }
  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(hue).frame(width: 7, height: 7)
      Text(bookingLabel(status)).font(.caption.weight(.semibold))
    }.padding(.horizontal, 8).padding(.vertical, 4).background(hue.opacity(0.13), in: Capsule())
  }
}
private struct CheckedInterval {
  let start, end: Date
  let vehicles: [VehicleSlot]
}
struct ReservationCalendar: View {
  @EnvironmentObject var store: FleetStore
  @Environment(\.horizontalSizeClass) private var size
  @Environment(\.scenePhase) private var phase
  @AppStorage("fleet.calendar.view") private var mode = "Month"
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .body) private var cellWidth: CGFloat = 40
  @State private var panel = false
  @State private var showMine = false
  @State private var day = Date()
  @State private var start = Date().addingTimeInterval(3600)
  @State private var end = Date().addingTimeInterval(7200)
  @State private var site = ""
  @State private var vehicle = ""
  @State private var canceled = false
  @State private var checked: CheckedInterval?
  @State private var selected: VehicleSlot?
  @State private var detail: FleetBooking?
  @State private var pickup: FleetBooking?
  @State private var events: [FleetBooking]?
  @State private var loadedSchedule = ""
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
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        filters
        if let checked, !panel {
          Button {
            panel = true
          } label: {
            Label("View results · " + interval(checked.start, checked.end), systemImage: "clock")
              .font(.subheadline).multilineTextAlignment(.leading).frame(minHeight: 44)
          }
        }
        if !message.isEmpty { Text(message).font(.callout).accessibilityAddTraits(.isStaticText) }
        if !error.isEmpty && !panel { Text(error).foregroundStyle(Color("FleetError")) }
        if size == .regular && !typeSize.isAccessibilitySize {
          HStack(alignment: .top, spacing: 24) {
            schedule.frame(maxWidth: .infinity)
            sidebar.frame(width: 264, alignment: .leading)
          }
        } else {
          schedule
          sidebar
        }
      }.frame(maxWidth: 1024, alignment: .leading)
        .frame(maxWidth: .infinity).padding(.horizontal, 16).padding(.vertical, 12)
    }
    .safeAreaPadding(.bottom, 16)
    .background(Color(uiColor: .systemGroupedBackground))
    .navigationTitle("Vehicle calendar").navigationBarTitleDisplayMode(.inline)
    .environment(\.timeZone, zone)
    .onChange(of: site) { _, site in
      if !site.isEmpty && !store.vehicles.contains(where: { $0.id == vehicle && $0.site == site }) {
        vehicle = ""
      }
    }
    .onChange(of: selectedKey) { _, _ in
      checked = nil
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
    .sheet(isPresented: $panel, onDismiss: { selected = nil }) {
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            if let selected {
              Text(selected.name).font(.title2.bold())
              Text(selected.site).foregroundStyle(.secondary)
              Text(interval(start, end))
              Text(zoneName).font(.subheadline).foregroundStyle(.secondary)
              Text(store.session?.user.name ?? "")
              if !error.isEmpty { Text(error).foregroundStyle(Color("FleetError")) }
              primary("Reserve vehicle", icon: "calendar.badge.plus") {
                Task { await reserve(selected) }
              }.disabled(busy)
              Button("Back to results") { self.selected = nil }.disabled(busy)
            } else {
              HStack(alignment: .top) {
                Image(systemName: "line.3.horizontal.decrease").foregroundStyle(.secondary)
                  .accessibilityHidden(true)
                Text([site.isEmpty ? "All sites" : site, vehicleTitle].joined(separator: " · "))
              }.font(.subheadline)
              VStack(alignment: .leading, spacing: 14) {
                timeInput("Pickup", $start)
                Divider()
                timeInput("Expected return", $end)
              }.padding(16).background(surface, in: RoundedRectangle(cornerRadius: 16))
              Label("Times shown in " + zoneName, systemImage: "clock").font(.footnote)
                .foregroundStyle(.secondary)
              primary(checking ? "Checking…" : "Check availability", icon: "magnifyingglass") {
                Task { await check() }
              }.accessibilityIdentifier("runAvailabilityCheck").disabled(checking)
              if !error.isEmpty { Text(error).foregroundStyle(Color("FleetError")) }
              if let checked {
                Divider()
                Text("Results").font(.title3.bold()).accessibilityAddTraits(.isHeader)
                Text(interval(checked.start, checked.end)).font(.subheadline).foregroundStyle(
                  .secondary)
                if !checked.vehicles.contains(where: { $0.status == "available" }) {
                  Text(
                    checked.vehicles.isEmpty
                      ? "No vehicles match these filters."
                      : "No vehicles are available for this interval.")
                }
                ForEach(checked.vehicles) { v in
                  VStack(alignment: .leading, spacing: 7) {
                    Text(v.name).font(.headline)
                    Text(v.site).font(.subheadline).foregroundStyle(.secondary)
                    BookingBadge(status: v.status)
                    if v.status == "available", store.session?.user.authorizedDriver == true {
                      Button("Select vehicle") {
                        selected = v
                        bookingID = UUID().uuidString
                      }
                      .buttonStyle(.bordered).controlSize(.large)
                    }
                  }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
                    .background(surface, in: RoundedRectangle(cornerRadius: 14))
                }
              }
            }
          }.padding(20).frame(maxWidth: 560, alignment: .leading).frame(maxWidth: .infinity)
        }.background(Color(uiColor: .systemGroupedBackground))
          .navigationTitle(selected == nil ? "Check availability" : "Reserve vehicle")
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .confirmationAction) {
              Button("Close") { panel = false }.disabled(busy)
            }
          }
      }.environment(\.timeZone, zone).presentationDragIndicator(.visible)
        .interactiveDismissDisabled(busy)
    }
    .sheet(item: $detail) { r in
      BookingDetail(
        booking: r, zone: zone,
        onChanged: { _ in
          detail = nil
          message = "Reservation canceled. This booking no longer holds the vehicle."
          checked = nil
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
  private var surface: Color { Color(uiColor: .secondarySystemGroupedBackground) }
  private var zoneName: String { friendlyZone(zone) }
  private var vehicleTitle: String {
    store.vehicles.first(where: { $0.id == vehicle })?.name ?? "All vehicles"
  }
  private func interval(_ a: Date, _ b: Date) -> String {
    if cal.isDate(a, inSameDayAs: b) {
      return formatted(a) + " – " + b.formatted(Date.FormatStyle(timeZone: zone).hour().minute())
    }
    return formatted(a) + " – " + formatted(b)
  }
  private func primary(_ name: String, icon: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Label(name, systemImage: icon).font(.headline).multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, minHeight: 46).padding(.horizontal, 8)
        .contentShape(Rectangle())
    }.buttonStyle(.plain).foregroundStyle(Color(uiColor: .systemBackground))
      .background(Color("FleetAccent"), in: RoundedRectangle(cornerRadius: 12))
  }
  private func timeInput(_ title: String, _ value: Binding<Date>) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.headline)
      ViewThatFits(in: .horizontal) {
        HStack {
          dateControl(title, value, .date)
          dateControl(title, value, .hourAndMinute)
        }.fixedSize()
        VStack(alignment: .leading) {
          dateControl(title, value, .date)
          dateControl(title, value, .hourAndMinute)
        }
      }
    }
  }
  private func dateControl(_ title: String, _ value: Binding<Date>, _ parts: DatePickerComponents)
    -> some View
  {
    DatePicker(
      title + (parts == .date ? " date" : " time"), selection: value, displayedComponents: parts
    )
    .labelsHidden().datePickerStyle(.compact).frame(minHeight: 44)
  }
  private var filters: some View {
    VStack(alignment: .leading, spacing: 8) {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 8) { filterMenus }.fixedSize(horizontal: true, vertical: false)
        VStack(alignment: .leading, spacing: 6) { filterMenus }
      }
      primary("Check availability", icon: "calendar.badge.clock") {
        error = ""
        panel = true
      }
      .accessibilityIdentifier("openAvailabilityPanel")
      .frame(maxWidth: size == .regular ? 280 : .infinity, alignment: .leading)
      if !site.isEmpty || !vehicle.isEmpty {
        Button("Reset filters") {
          site = ""
          vehicle = ""
        }.font(.subheadline).frame(minHeight: 44)
      }
    }
  }
  @ViewBuilder private var filterMenus: some View {
    Menu {
      Picker("Site", selection: $site) {
        Text("All sites").tag("")
        ForEach(Array(Set(store.vehicles.map(\.site))).sorted(), id: \.self) { Text($0).tag($0) }
      }
    } label: {
      chip("Site", site.isEmpty ? "All sites" : site)
    }
    Menu {
      Picker("Vehicle", selection: $vehicle) {
        Text("All vehicles").tag("")
        ForEach(store.vehicles.filter { site.isEmpty || $0.site == site }) {
          Text($0.name).tag($0.id)
        }
      }
    } label: {
      chip("Vehicle", vehicleTitle)
    }
  }
  private func chip(_ title: String, _ value: String) -> some View {
    HStack(spacing: 6) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.caption).foregroundStyle(Color(uiColor: .label))
        Text(value).font(.subheadline.weight(.semibold)).foregroundStyle(Color("FleetAccent"))
          .fixedSize(
            horizontal: false, vertical: true)
      }
      Image(systemName: "chevron.down").font(.caption2.bold()).foregroundStyle(Color("FleetAccent"))
    }.padding(.horizontal, 12).padding(.vertical, 4).frame(minHeight: 44)
      .background(surface, in: RoundedRectangle(cornerRadius: 10))
      .accessibilityElement(children: .ignore).accessibilityLabel(title + ", " + value)
  }
  private var periodTitle: String {
    if mode == "Month" {
      return day.formatted(Date.FormatStyle(timeZone: zone).month(.wide).year())
    }
    let fmt = DateIntervalFormatter()
    fmt.timeZone = zone
    fmt.dateTemplate = "MMMdyyyy"
    return fmt.string(from: first, to: cal.date(byAdding: .day, value: -1, to: last)!)
  }
  private var schedule: some View {
    VStack(alignment: .leading, spacing: 12) {
      ViewThatFits(in: .horizontal) {
        HStack {
          Text(periodTitle).font(.title3.bold()).accessibilityAddTraits(.isHeader).fixedSize()
          Spacer()
          navigationControls
        }
        VStack(alignment: .leading) {
          Text(periodTitle).font(.title3.bold()).accessibilityAddTraits(.isHeader)
          navigationControls
        }
      }
      if typeSize.isAccessibilitySize {
        Picker("Calendar view", selection: $mode) { viewOptions }.pickerStyle(.menu)
      } else {
        Picker("Calendar view", selection: $mode) { viewOptions }.pickerStyle(.segmented)
      }
      if !loadError.isEmpty {
        Text(loadError).foregroundStyle(Color("FleetError"))
        Button("Retry calendar") { refreshID = UUID() }
      } else if let events {
        if mode == "Agenda" {
          if events.isEmpty { empty("No bookings in this period.") }
          ForEach(agendaDays(events), id: \.self) { d in
            Text(d.formatted(Date.FormatStyle(timeZone: zone).weekday(.wide).month().day())).font(
              .headline)
            ForEach(events.filter { cal.isDate(max($0.pickup, first), inSameDayAs: d) }) {
              eventButton($0)
            }
          }
        } else {
          dateGrid(events)
        }
      } else {
        ProgressView("Loading schedule…").frame(minHeight: 100)
      }
    }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
      .background(surface, in: RoundedRectangle(cornerRadius: 16))
  }
  @ViewBuilder private var viewOptions: some View {
    ForEach(["Month", "Week", "Agenda"], id: \.self) { Text($0) }
  }
  private var navigationControls: some View {
    HStack(spacing: 2) {
      Button {
        move(-1)
      } label: {
        Image(systemName: "chevron.left").frame(width: 44, height: 44)
      }.accessibilityLabel("Previous")
      Button { day = Date() } label: {
        Text("Today").font(.subheadline.weight(.semibold)).frame(minHeight: 44)
          .contentShape(Rectangle())
      }
      Button {
        move(1)
      } label: {
        Image(systemName: "chevron.right").frame(width: 44, height: 44)
      }.accessibilityLabel("Next")
    }
  }
  private func agendaDays(_ rows: [FleetBooking]) -> [Date] {
    Array(Set(rows.map { cal.startOfDay(for: max($0.pickup, first)) })).sorted()
  }
  private func matches(_ rows: [FleetBooking], _ d: Date) -> [FleetBooking] {
    let next = cal.date(byAdding: .day, value: 1, to: d)!
    return rows.filter { $0.pickup < next && ($0.ongoing == true || $0.due > d) }
  }
  private func dateGrid(_ rows: [FleetBooking]) -> some View {
    let count = mode == "Month" ? (cal.range(of: .day, in: .month, for: first)?.count ?? 0) : 7
    let blanks = mode == "Month" ? cal.component(.weekday, from: first) - 1 : 0
    let columns = Array(repeating: GridItem(.flexible(), spacing: 0), count: 7)
    let grid = VStack(spacing: 6) {
      LazyVGrid(columns: columns) {
        ForEach(0..<7, id: \.self) { i in
          Text(
            cal.shortWeekdaySymbols[
              mode == "Week" ? (cal.component(.weekday, from: first) - 1 + i) % 7 : i]
          ).font(.caption.weight(.medium)).foregroundStyle(
            .secondary)
        }
      }
      LazyVGrid(columns: columns, spacing: 1) {
        ForEach(0..<(blanks + count), id: \.self) { index in
          if index < blanks {
            Color.clear.frame(height: 1)
          } else {
            let date = cal.date(byAdding: .day, value: index - blanks, to: first)!
            let selected = cal.isDate(date, inSameDayAs: day)
            let today = cal.isDateInToday(date)
            let n = matches(rows, date).count
            Button {
              day = date
            } label: {
              VStack(spacing: 2) {
                Text(String(cal.component(.day, from: date))).font(
                  .body.weight(today || selected ? .bold : .regular))
                Circle().fill(
                  n > 0
                    ? (selected ? Color(uiColor: .systemBackground) : Color("FleetAccent")) : .clear
                ).frame(width: 5, height: 5)
              }.frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(selected ? Color(uiColor: .systemBackground) : .primary)
                .background(
                  selected ? Color("FleetAccent") : .clear, in: RoundedRectangle(cornerRadius: 10)
                )
                .overlay(
                  RoundedRectangle(cornerRadius: 10).strokeBorder(
                    today
                      ? (selected ? Color(uiColor: .systemBackground) : Color("FleetAccent"))
                      : .clear, lineWidth: 2
                  ).padding(2)
                )
                .contentShape(Rectangle())
            }.buttonStyle(.plain)
              .accessibilityLabel(
                (today ? "Today, " : "")
                  + date.formatted(
                    Date.FormatStyle(date: .complete, time: .omitted, timeZone: zone))
                  + ", " + String(n) + (n == 1 ? " booking" : " bookings")
              )
              .accessibilityAddTraits(selected ? .isSelected : [])
          }
        }
      }
    }
    return VStack(alignment: .leading, spacing: 8) {
      if typeSize.isAccessibilitySize {
        ScrollView(.horizontal) { grid.frame(minWidth: 7 * cellWidth) }
      } else {
        grid
      }
      HStack(spacing: 6) {
        Circle().fill(Color("FleetAccent")).frame(width: 5, height: 5).accessibilityHidden(true)
        Text("Dates with bookings").font(.caption).foregroundStyle(.secondary)
      }
    }
  }
  private var sidebar: some View {
    VStack(alignment: .leading, spacing: 14) {
      if loadError.isEmpty, let events {
        if mode != "Agenda" {
          let entries = matches(events, cal.startOfDay(for: day))
          Text(day.formatted(Date.FormatStyle(timeZone: zone).weekday(.wide).month(.wide).day()))
            .font(.headline)
            .accessibilityAddTraits(.isHeader)
          if entries.isEmpty {
            empty("No bookings on this day.")
          } else {
            ForEach(entries) { eventButton($0) }
          }
        }
        DisclosureGroup("My upcoming reservations", isExpanded: $showMine) {
          if mine.isEmpty {
            empty("You have no upcoming reservations.")
          } else {
            ForEach(mine) { eventButton($0) }
          }
        }.padding(12).background(surface, in: RoundedRectangle(cornerRadius: 12))
        if !notices.isEmpty {
          Text("Cancellation notices").font(.headline)
          ForEach(notices) { n in
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
      Toggle("Include canceled reservations", isOn: $canceled).font(.subheadline)
        .frame(minHeight: 44)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
  private func empty(_ title: String) -> some View {
    Label(title, systemImage: "calendar").font(.subheadline).foregroundStyle(.secondary)
      .padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
  }
  private func eventButton(_ r: FleetBooking) -> some View {
    Button {
      detail = r
    } label: {
      HStack {
        VStack(alignment: .leading, spacing: 5) {
          Text(r.vehicle).font(.headline)
          Text(interval(r.pickup, r.due)).font(.subheadline)
          Text(r.site + (r.owner.map { " · " + $0 } ?? "")).font(.footnote).foregroundStyle(
            .secondary)
          BookingBadge(status: r.status)
          if r.ongoing == true {
            Text("Overdue").font(.caption.bold()).foregroundStyle(Color("FleetWarning"))
          }
        }
        Spacer()
        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
      }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(
          Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12)
        ).contentShape(Rectangle())
    }.buttonStyle(.plain)
  }
  func move(_ n: Int) {
    day =
      mode == "Month"
      ? cal.date(byAdding: .month, value: n, to: day)!
      : cal.date(byAdding: .day, value: n * (mode == "Week" ? 7 : 30), to: day)!
  }
  @MainActor func load() async {
    let scope = query(first, last)
    if scope != loadedSchedule { events = nil }
    loadError = ""
    let key = queryKey
    do {
      async let a: BookingList = store.api.request("/api/reservations?" + scope)
      async let b: BookingList = store.api.request("/api/my-reservations")
      async let c: BookingInbox = store.api.request("/api/reservation-inbox")
      let result = try await (a, b, c)
      guard !Task.isCancelled, key == queryKey else { return }
      loadedSchedule = scope
      events = result.0.events
      mine = result.1.events
      notices = result.2.notices
      if checked != nil && !checking && selected == nil { await check(background: true) }
    } catch {
      if !Task.isCancelled && key == queryKey {
        events = nil
        loadedSchedule = ""
        loadError = error.localizedDescription
      }
    }
  }
  @MainActor func check(background: Bool = false) async {
    guard start > Date(), end > start else {
      checked = nil
      error = "Choose a future pickup and later return."
      return
    }
    let id = UUID()
    requestID = id
    let requestedStart = start
    let requestedEnd = end
    let scope = selectedKey
    checking = !background
    if !background {
      error = ""
      checked = nil
    }
    defer { if requestID == id { checking = false } }
    do {
      let list: AvailableVehicles = try await store.api.request(
        "/api/availability?" + query(start, end))
      if id == requestID, scope == selectedKey {
        checked = CheckedInterval(start: requestedStart, end: requestedEnd, vehicles: list.vehicles)
      }
    } catch {
      if id == requestID {
        checked = nil
        self.error = error.localizedDescription
      }
    }
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
      checked = nil
      panel = false
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
          Text(friendlyZone(zone))
          if let owner = booking.owner { Text("Reserved by " + owner) }
          if let at = booking.canceledAt, let d = FleetBooking.instant(at) {
            Text("Canceled " + time(d) + " · " + (booking.canceledBy ?? "Former staff member"))
          }
          if let r = booking.reason, !r.isEmpty { Text(r) }
        }
        if !error.isEmpty { Text(error).foregroundStyle(Color("FleetError")) }
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

import SwiftUI

@MainActor final class FleetStore: ObservableObject {
  let api = FleetAPI()
  @Published var session: FleetSession?
  @Published var vehicles: [Vehicle] = []
  @Published var trips: [Trip] = []
  @Published var error = ""
  @Published var restoring = true
  @Published var revision = UUID()
  var lastActive = Date()
  func restore() async {
    let started = revision
    defer { restoring = false }
    do {
      let result: FleetSession = try await api.request("/api/auth/me")
      guard started == revision else { return }
      accept(result)
      await refresh()
    } catch let failure as FleetError {
      if failure.status == 401 { clear() } else { error = failure.localizedDescription }
    } catch { self.error = error.localizedDescription }
  }
  func accept(_ result: FleetSession) {
    session = result
    api.csrf = result.csrfToken
    lastActive = Date()
  }
  func refresh() async {
    let started = revision
    do {
      async let fleet: VehicleList = api.request("/api/vehicles")
      async let history: TripList = api.request("/api/trips")
      let result = try await (fleet.vehicles, history.trips)
      guard started == revision else { return }
      (vehicles, trips) = result
      error = ""
    } catch { self.error = error.localizedDescription }
  }
  func logout() async {
    api.signOut()
    clear()
  }
  func clear() {
    api.clear()
    session = nil
    vehicles = []
    trips = []
    error = ""
    revision = UUID()
  }
  func resume() async {
    guard let session else { return }
    if Date().timeIntervalSince(lastActive) >= Double(session.settings.sessionMinutes * 60) {
      await logout()
    } else {
      await restore()
    }
  }
}
@main struct FleetCheckoutApp: App {
  @StateObject private var store = FleetStore()
  @Environment(\.scenePhase) private var phase
  var body: some Scene {
    WindowGroup {
      Group {
        if store.restoring {
          ProgressView("Opening your fleet…")
        } else if store.session != nil {
          WorkspaceView().id(store.revision)
        } else {
          SignInView()
        }
      }
      .environmentObject(store).tint(Color(red: 0.12, green: 0.34, blue: 0.28))
      .task { await store.restore() }
      .onReceive(NotificationCenter.default.publisher(for: .fleetSessionExpired)) { _ in
        store.clear()
      }
      .overlay {
        if phase != .active {
          Color(.systemBackground).ignoresSafeArea().overlay(
            Label("Fleet Checkout", systemImage: "lock.shield").font(.title2))
        }
      }
      .onChange(of: phase) { old, value in
        if old == .active { store.lastActive = Date() }
        if value == .active { Task { await store.resume() } }
      }
    }
  }
}
struct SignInView: View {
  @EnvironmentObject var store: FleetStore
  @State private var email = ""
  @State private var code = ""
  @State private var challenge = ""
  @State private var cooldown = Date.distantPast
  @State private var busy = false
  @State private var message = ""
  @State private var error = ""
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          Image(systemName: "car.side.hill.up.fill").font(.system(size: 48)).foregroundStyle(.tint)
          Text("Learn4Life").font(.title2.bold())
          Text("Your fleet.\nReady when you are.").font(.largeTitle.bold())
          Text("Sign in to inspect a vehicle, record your trip, and keep every form together.")
            .foregroundStyle(.secondary)
          VStack(alignment: .leading, spacing: 16) {
            TextField("Work email", text: $email).keyboardType(.emailAddress).textContentType(
              .emailAddress
            ).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(
              !challenge.isEmpty || busy
            ).textFieldStyle(.roundedBorder).accessibilityIdentifier("email")
            if !challenge.isEmpty {
              TextField("6-digit code", text: $code).keyboardType(.numberPad).textContentType(
                .oneTimeCode
              ).textFieldStyle(.roundedBorder).accessibilityIdentifier("code")
                .onChange(of: code) { _, value in code = String(value.filter(\.isNumber).prefix(6))
                }
              Text("Check your inbox or spam folder. Your code expires in 10 minutes.").font(
                .footnote
              ).foregroundStyle(.secondary)
            }
            if !message.isEmpty {
              Text(message).font(.callout).foregroundStyle(.tint).accessibilityAddTraits(
                .updatesFrequently)
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            if !store.error.isEmpty { Text(store.error).foregroundStyle(.red) }
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
              let remaining = max(0, Int(ceil(cooldown.timeIntervalSince(timeline.date))))
              Button {
                Task { await submit() }
              } label: {
                HStack {
                  if busy { ProgressView() }
                  Text(challenge.isEmpty ? "Email me a sign-in code" : "Verify code & sign in")
                  Spacer()
                  Image(systemName: "arrow.right")
                }
              }.buttonStyle(.borderedProminent).controlSize(.large).disabled(
                busy || email.isEmpty || (challenge.isEmpty && remaining > 0)
                  || (!challenge.isEmpty && code.count != 6))
              if !challenge.isEmpty {
                Button(remaining > 0 ? "Resend code in \(remaining)s" : "Resend code") {
                  Task { await sendCode(resend: true) }
                }.disabled(busy || remaining > 0)
                Button("Change email") {
                  challenge = ""
                  code = ""
                  message = ""
                  error = ""
                }.disabled(busy)
              } else if remaining > 0 {
                Text("You can request another code in \(remaining)s.").font(.footnote)
              }
            }
          }.padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
          Label("Your account. Your signature.", systemImage: "lock.shield").font(.footnote)
            .foregroundStyle(.secondary)
          Text(
            "First time? Verify your email, save your details, then ask your fleet administrator to authorize you as a driver."
          ).font(.footnote).foregroundStyle(.secondary)
        }.padding(32).frame(maxWidth: 560).frame(maxWidth: .infinity)
      }.navigationTitle("Fleet Checkout").navigationBarTitleDisplayMode(.inline)
    }
  }
  func sendCode(resend: Bool = false) async {
    guard !busy, Date() >= cooldown else { return }
    busy = true
    error = ""
    defer { busy = false }
    do {
      let response: CodeChallenge = try await store.api.request(
        "/api/auth/request-code", method: "POST",
        body: ["email": email.trimmingCharacters(in: .whitespacesAndNewlines)])
      challenge = response.challengeId
      code = ""
      cooldown = Date().addingTimeInterval(Double(response.retryAfterSeconds ?? 60))
      message =
        resend
        ? "A new code was sent. Use the newest email; the previous code no longer works."
        : "Your code is on its way."
    } catch let failure as FleetError {
      error = failure.localizedDescription
      if failure.retryAfter > 0 { cooldown = Date().addingTimeInterval(Double(failure.retryAfter)) }
    } catch { self.error = error.localizedDescription }
  }
  func submit() async {
    if challenge.isEmpty {
      await sendCode()
      return
    }
    guard !busy else { return }
    busy = true
    error = ""
    defer { busy = false }
    do {
      let result: FleetSession = try await store.api.request(
        "/api/auth/verify-code", method: "POST", body: ["challengeId": challenge, "code": code])
      store.accept(result)
      await store.refresh()
    } catch { self.error = error.localizedDescription }
  }
}

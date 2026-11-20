import SwiftUI
import UserNotifications

final class FleetNotificationDelegate: NSObject, UIApplicationDelegate,
  UNUserNotificationCenterDelegate
{
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .sound]
  }
}

private enum SignInNotice {
  static let identifier = "sign-in-email"

  static func show() async throws -> Bool {
    let center = UNUserNotificationCenter.current()
    guard try await center.requestAuthorization(options: [.alert, .sound]) else { return false }
    try Task.checkCancellation()
    let content = UNMutableNotificationContent()
    content.title = "Sign-in code requested"
    content.body = "Check your email for the latest Fleet Checkout code."
    content.sound = .default
    try await center.add(
      UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    return true
  }

  static func clear() {
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: [identifier])
    center.removeDeliveredNotifications(withIdentifiers: [identifier])
  }
}

@MainActor final class FleetStore: ObservableObject {
  let api: FleetAPI
  @Published private(set) var workspaceContent: WorkspaceContent
  private let defaults: UserDefaults
  init(review: Bool = false, api: FleetAPI? = nil, defaults: UserDefaults = .standard) {
    let client = api ?? FleetAPI(review: review)
    self.api = client
    self.defaults = defaults
    workspaceContent = WorkspaceContent.stored(
      for: client.baseURL.absoluteString, defaults: defaults)
    deletionReceipt = DeletionReceipt.read(review: review)
  }
  @Published var deletionReceipt: String?
  @Published var session: FleetSession?
  @Published var vehicles: [Vehicle] = []
  @Published var trips: [Trip] = []
  @Published var pendingReturns: [Trip] = []
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
  private func schedule(for session: FleetSession) async throws -> ([Vehicle], [Trip], [Trip]) {
    guard session.user.canAccessFleet != false else { return ([], [], []) }
    async let fleet: VehicleList = api.request("/api/vehicles")
    async let history: TripList = api.request("/api/trips")
    let (vehicles, records) = try await (fleet.vehicles, history)
    return (vehicles, records.trips, records.pendingReturns ?? [])
  }
  func refresh() async {
    guard let session else { return }
    let started = revision
    do {
      let snapshot = try await schedule(for: session)
      guard started == revision else { return }
      (vehicles, trips, pendingReturns) = snapshot
      error = ""
    } catch { if started == revision { self.error = error.localizedDescription } }
  }
  func applyWorkspaceUpdate(_ content: WorkspaceContent) async throws {
    guard content.isSupported, let user = session?.user.id else {
      throw FleetError(message: "This workspace update requires a newer app.")
    }
    let started = revision
    let latest: FleetSession = try await api.request("/api/auth/me")
    guard latest.user.id == user, started == revision else { throw CancellationError() }
    let snapshot = try await schedule(for: latest)
    try Task.checkCancellation()
    guard started == revision, session?.user.id == user else { throw CancellationError() }
    try content.persist(for: api.baseURL.absoluteString, defaults: defaults)
    accept(latest)
    (vehicles, trips, pendingReturns) = snapshot
    workspaceContent = content
    error = ""
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
    pendingReturns = []
    error = ""
    revision = UUID()
  }
  func resume() async {
    guard let session else { return }
    if session.rememberedUntil == nil
      && Date().timeIntervalSince(lastActive) >= Double(session.settings.sessionMinutes * 60)
    {
      await logout()
    } else {
      await restore()
    }
  }
}
@main struct FleetCheckoutApp: App {
  @UIApplicationDelegateAdaptor(FleetNotificationDelegate.self) private var notificationDelegate
  @StateObject private var store = FleetStore()
  @Environment(\.scenePhase) private var phase
  var body: some Scene {
    WindowGroup {
      Group {
        if store.deletionReceipt != nil {
          DeletionStatusView()
        } else if store.restoring {
          ProgressView("Opening your fleet…")
        } else if store.session?.user.canAccessFleet == false {
          NavigationStack {
            Form {
              Section("Fleet access pending") {
                Text("Ask your fleet administrator to approve your work email.")
                Button("Check approval") { Task { await store.restore() } }
              }
              Section("Account") {
                NavigationLink("Delete my account") { DeleteAccountView() }
                Button("Sign out") { Task { await store.logout() } }
              }
            }.navigationTitle("Fleet Checkout")
          }
        } else if store.session != nil {
          WorkspaceView().id(store.revision)
        } else {
          SignInView()
        }
      }
      .environmentObject(store).tint(Color("FleetAccent"))
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
struct RememberDeviceToggle: View {
  @Binding var enabled: Bool
  var body: some View {
    Toggle(isOn: $enabled) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Remember me for 60 days")
        Text("Use on your personal device.").font(.footnote).foregroundStyle(.secondary)
      }
    }
  }
}

struct SignInView: View {
  @EnvironmentObject var store: FleetStore
  @State private var rememberMe = false
  @State private var email = ""
  @State private var code = ""
  @State private var challenge = ""
  @State private var cooldown = Date.distantPast
  @State private var busy = false
  @State private var message = ""
  @State private var error = ""
  @State private var showingReview = false
  @FocusState private var codeFocused: Bool
  @AppStorage("signInEmailAlerts") private var wantsCodeAlerts = false
  @State private var alertsDenied = false
  @State private var noticeTask: Task<Void, Never>?
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
            RememberDeviceToggle(enabled: $rememberMe).disabled(busy)
            if challenge.isEmpty {
              Button {
                Task {
                  busy = true
                  error = ""
                  defer { busy = false }
                  do {
                    let session = try await store.api.passkeySession(rememberMe: rememberMe)
                    store.accept(session)
                    await store.refresh()
                  } catch { self.error = error.localizedDescription }
                }
              } label: {
                Label("Sign in with a passkey", systemImage: "person.badge.key").frame(
                  maxWidth: .infinity)
              }.buttonStyle(.bordered).controlSize(.large).disabled(busy)
              Text("First time? Sign in by email below, then open My profile → Create a passkey.")
                .font(.footnote).foregroundStyle(.secondary)
            }
            TextField("Work email", text: $email).keyboardType(.emailAddress).textContentType(
              .emailAddress
            ).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(
              !challenge.isEmpty || busy
            ).textFieldStyle(.roundedBorder).accessibilityIdentifier("email")
            if challenge.isEmpty {
              Toggle("Notify me when my code is sent", isOn: $wantsCodeAlerts)
                .font(.subheadline).disabled(busy)
            }
            if !challenge.isEmpty {
              TextField("6-digit code", text: $code).keyboardType(.numberPad).textContentType(
                .oneTimeCode
              ).textFieldStyle(.roundedBorder).accessibilityIdentifier("code")
                .focused($codeFocused)
                .onAppear { codeFocused = true }
                .onChange(of: code) { _, value in
                  let digits = String(value.filter(\.isNumber).prefix(6))
                  if code != digits { code = digits }
                  if digits.count == 6 { codeFocused = false }
                }
              Text("Check your inbox or spam folder. Your code expires in 10 minutes.").font(
                .footnote
              ).foregroundStyle(.secondary)
              if alertsDenied,
                let url = URL(string: UIApplication.openNotificationSettingsURLString)
              {
                Link("Enable Fleet Checkout alerts in Settings", destination: url).font(.footnote)
              }
            }
            if !message.isEmpty {
              Text(message).font(.callout).foregroundStyle(.tint).accessibilityAddTraits(
                .updatesFrequently)
            }
            if !error.isEmpty { Text(error).foregroundStyle(Color("FleetError")) }
            if !store.error.isEmpty { Text(store.error).foregroundStyle(Color("FleetError")) }
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
              let remaining = max(0, Int(ceil(cooldown.timeIntervalSince(timeline.date))))
              let unavailable =
                busy || email.isEmpty || (challenge.isEmpty && remaining > 0)
                || (!challenge.isEmpty && code.count != 6)
              Button {
                Task { await submit() }
              } label: {
                HStack {
                  if busy { ProgressView() }
                  Text(challenge.isEmpty ? "Email me a sign-in code" : "Verify code & sign in")
                  Spacer()
                  Image(systemName: "arrow.right")
                }
              }.buttonStyle(.borderedProminent).foregroundStyle(
                unavailable ? Color.secondary : Color("FleetOnAccent")
              ).controlSize(
                .large
              ).disabled(unavailable)
              if !challenge.isEmpty {
                Button(remaining > 0 ? "Resend code in \(remaining)s" : "Resend code") {
                  Task { await sendCode(resend: true) }
                }.disabled(busy || remaining > 0)
                Button("Change email") {
                  clearNotice()
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
          Button {
            showingReview = true
          } label: {
            Text("App Review workspace").frame(minHeight: 44)
          }.font(.footnote)
            .fullScreenCover(isPresented: $showingReview) { ReviewWorkspaceView() }
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) { supportLinks }.fixedSize(horizontal: true, vertical: false)
            VStack(alignment: .leading, spacing: 8) { supportLinks }
          }.font(.footnote)
          Label("Your account. Your signature.", systemImage: "lock.shield").font(.footnote)
            .foregroundStyle(.secondary)
          Text(
            "Use the work email your fleet administrator approved. Ask them to add your email if you need access."
          ).font(.footnote).foregroundStyle(.secondary)
        }.padding(32).frame(maxWidth: 560).frame(maxWidth: .infinity)
      }.navigationTitle("Fleet Checkout").navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
          if codeFocused {
            ToolbarItemGroup(placement: .keyboard) {
              Spacer()
              Button("Done") { codeFocused = false }
            }
          }
        }
        .onDisappear { clearNotice() }
    }
  }
  private func clearNotice() {
    noticeTask?.cancel()
    noticeTask = nil
    alertsDenied = false
    SignInNotice.clear()
  }
  @ViewBuilder private var supportLinks: some View {
    Link(destination: FleetAPI.origin.appendingPathComponent("privacy")) {
      Text("Privacy policy").frame(minHeight: 44)
    }
    Link(destination: FleetAPI.origin.appendingPathComponent("support")) {
      Text("Support").frame(minHeight: 44)
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
      codeFocused = true
      cooldown = Date().addingTimeInterval(Double(response.retryAfterSeconds ?? 60))
      message =
        resend
        ? "Use the code in your newest email. Earlier codes have expired."
        : "If your email has access, check your inbox for a sign-in code."
      if wantsCodeAlerts {
        noticeTask?.cancel()
        noticeTask = Task {
          let allowed = try? await SignInNotice.show()
          if !Task.isCancelled { alertsDenied = allowed == false }
        }
      }
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
        "/api/auth/verify-code", method: "POST",
        body: ["challengeId": challenge, "code": code, "rememberMe": rememberMe])
      store.accept(result)
      await store.refresh()
    } catch { self.error = error.localizedDescription }
  }
}

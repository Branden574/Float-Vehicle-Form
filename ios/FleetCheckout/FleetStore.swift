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
  @Published private(set) var hasLoadedSchedule = false
  @Published var pendingReturns: [Trip] = []
  @Published var vehicleInspections: [VehicleInspection] = []
  @Published var error = ""
  @Published var restoring = true
  @Published var revision = UUID()
  private(set) var lastActive = Date()
  private var idleTask: Task<Void, Never>?

  private var idleDeadline: Date? {
    guard let session, session.rememberedUntil == nil else { return nil }
    return lastActive.addingTimeInterval(Double(session.settings.sessionMinutes * 60))
  }

  @discardableResult
  func expireIdleSession(at time: Date = Date()) -> Bool {
    guard let deadline = idleDeadline, time >= deadline else { return false }
    endSession()
    return true
  }

  func recordInteraction(at time: Date = Date()) {
    guard idleDeadline != nil, !expireIdleSession(at: time) else { return }
    lastActive = time
  }

  private func scheduleIdleLock() {
    idleTask?.cancel()
    guard idleDeadline != nil else { return }
    idleTask = Task { [weak self] in
      while let deadline = self?.idleDeadline {
        do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) } catch {
          return
        }
        if self?.expireIdleSession() != false { return }
      }
    }
  }
  func restore() async {
    let started = revision
    defer { restoring = false }
    do {
      let result: FleetSession = try await api.request("/api/auth/me")
      guard started == revision else { return }
      accept(result)
      await refresh()
    } catch let failure as FleetError {
      guard started == revision else { return }
      if failure.status == 401 { clear() } else { error = failure.localizedDescription }
    } catch { if started == revision { self.error = error.localizedDescription } }
  }
  func accept(_ result: FleetSession) {
    if session?.csrfToken != result.csrfToken { lastActive = Date() }
    session = result
    api.csrf = result.csrfToken
    scheduleIdleLock()
  }
  private func schedule(for session: FleetSession) async throws -> ([Vehicle], [Trip], [Trip], [VehicleInspection]) {
    guard session.user.canAccessFleet != false else { return ([], [], [], []) }
    async let fleet: VehicleList = api.request("/api/vehicles")
    async let history: TripList = api.request("/api/trips")
    let (vehicles, records) = try await (fleet.vehicles, history)
    return (vehicles, records.trips, records.pendingReturns ?? [], records.vehicleInspections ?? [])
  }
  func refresh() async {
    guard let session else { return }
    let started = revision
    do {
      let snapshot = try await schedule(for: session)
      guard started == revision else { return }
      (vehicles, trips, pendingReturns, vehicleInspections) = snapshot
      hasLoadedSchedule = true
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
    (vehicles, trips, pendingReturns, vehicleInspections) = snapshot
    hasLoadedSchedule = true
    workspaceContent = content
    error = ""
  }
  func logout() async { endSession() }
  private func endSession() {
    clear()
    api.scheduleSignOutRetry()
  }
  func clear() {
    idleTask?.cancel()
    idleTask = nil
    api.clear()
    session = nil
    hasLoadedSchedule = false
    vehicles = []
    trips = []
    pendingReturns = []
    vehicleInspections = []
    error = ""
    revision = UUID()
  }
  func resume() async {
    guard session != nil, !expireIdleSession() else { return }
    await restore()
  }
}

/// A passive observer on the window also sees touches in sheets and UIKit controls.
/// It never recognizes a gesture or delays the underlying control.
private final class FleetInteractionObserver: UIGestureRecognizer {
  let interaction: () -> Void
  init(interaction: @escaping () -> Void) {
    self.interaction = interaction
    super.init(target: nil, action: nil)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
  }
  override func canPrevent(_ other: UIGestureRecognizer) -> Bool { false }
  override func canBePrevented(by other: UIGestureRecognizer) -> Bool { false }
  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) { interaction() }
  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) { interaction() }
  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { state = .failed }
  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent) { interaction() }
  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent) {
    state = .failed
  }
}

private struct FleetActivityWindow: UIViewRepresentable {
  let interaction: () -> Void
  final class Anchor: UIView {
    var observer: FleetInteractionObserver?
    override func didMoveToWindow() {
      super.didMoveToWindow()
      if let observer {
        observer.view?.removeGestureRecognizer(observer)
        window?.addGestureRecognizer(observer)
      }
    }
  }
  func makeUIView(context: Context) -> Anchor {
    let anchor = Anchor()
    anchor.isUserInteractionEnabled = false
    anchor.observer = FleetInteractionObserver(interaction: interaction)
    return anchor
  }
  func updateUIView(_ view: Anchor, context: Context) {}
  static func dismantleUIView(_ view: Anchor, coordinator: ()) {
    guard let observer = view.observer else { return }
    observer.view?.removeGestureRecognizer(observer)
    view.observer = nil
  }
}

struct FleetSessionLifecycle: ViewModifier {
  @ObservedObject var store: FleetStore
  @Environment(\.scenePhase) private var phase

  func body(content: Content) -> some View {
    content
      .background {
        if store.session != nil && store.session?.rememberedUntil == nil {
          FleetActivityWindow { store.recordInteraction() }.frame(width: 0, height: 0)
            .accessibilityHidden(true)
        }
      }
      .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidChangeNotification)) {
        _ in
        store.recordInteraction()
      }
      .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidChangeNotification)) {
        _ in
        store.recordInteraction()
      }
      .onReceive(
        NotificationCenter.default.publisher(for: UIAccessibility.elementFocusedNotification)
      ) { _ in
        if UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning {
          store.recordInteraction()
        }
      }
      .onReceive(NotificationCenter.default.publisher(for: .fleetSessionExpired)) { notice in
        if notice.object as? FleetAPI === store.api { store.clear() }
      }
      .overlay {
        if phase != .active {
          Color(.systemBackground).ignoresSafeArea().overlay(
            Label("Fleet Checkout", systemImage: "lock.shield").font(.title2))
        }
      }
      .onChange(of: phase) { _, value in
        if value == .active {
          store.api.scheduleSignOutRetry()
          if !store.expireIdleSession() { Task { await store.resume() } }
        }
      }
      .task {
        store.api.scheduleSignOutRetry()
        await store.restore()
      }
  }
}
@main struct FleetCheckoutApp: App {
  @UIApplicationDelegateAdaptor(FleetNotificationDelegate.self) private var notificationDelegate
  @StateObject private var store = FleetStore()
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
      .modifier(FleetSessionLifecycle(store: store))
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
            ).textFieldStyle(.roundedBorder).controlSize(.large).accessibilityIdentifier("email")
            if challenge.isEmpty {
              Toggle("Notify me when my code is sent", isOn: $wantsCodeAlerts)
                .font(.subheadline).disabled(busy)
            }
            if !challenge.isEmpty {
              TextField("6-digit code", text: $code).keyboardType(.numberPad).textContentType(
                .oneTimeCode
              ).textFieldStyle(.roundedBorder).controlSize(.large).accessibilityIdentifier("code")
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
                Link(destination: url) {
                  Text("Enable Fleet Checkout alerts in Settings").frame(minHeight: 44)
                }.font(.footnote)
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
                Button {
                  Task { await sendCode(resend: true) }
                } label: {
                  Text(remaining > 0 ? "Resend code in \(remaining)s" : "Resend code")
                    .frame(minHeight: 44).contentShape(Rectangle())
                }.disabled(busy || remaining > 0)
                Button {
                  clearNotice()
                  challenge = ""
                  code = ""
                  message = ""
                  error = ""
                } label: {
                  Text("Change email").frame(minHeight: 44).contentShape(Rectangle())
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

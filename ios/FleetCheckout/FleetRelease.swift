import StoreKit
import SwiftUI

struct FleetReleaseManifest: Decodable {
  let release: String
  let betaBuild: Int
  let workspaceContent: WorkspaceContent?
}

private struct UpdatePrompt: Identifiable {
  enum Action {
    case workspace
    case install(URL)
  }
  let id: String
  let title: String
  let message: String
  let button: String
  let action: Action
}

/// Only the visible fleet list offers updates. An inspection, camera or signature stays in place.
struct FleetReleaseNotice: ViewModifier {
  @EnvironmentObject var store: FleetStore
  @Environment(\.scenePhase) private var phase
  @Environment(\.openURL) private var openURL
  @State private var visible = false
  @State private var prompt: UpdatePrompt?
  @State private var retry: UpdatePrompt?
  @State private var refreshError = ""
  @State private var refreshing = false
  @State private var refreshed = false
  private var key: String { "workspace-release." + (store.api.baseURL.host ?? "fleet") }
  private var active: Bool { visible && phase == .active }
  private struct Listing: Decodable {
    struct Item: Decodable { let version: String }
    let results: [Item]
  }

  func body(content: Content) -> some View {
    content
      .safeAreaInset(edge: .top, spacing: 0) {
        if refreshing {
          ProgressView("Refreshing workspace…").padding(8)
        } else if let retry {
          VStack(alignment: .leading, spacing: 8) {
            Text("Couldn’t refresh the workspace").font(.headline)
            Text(refreshError).font(.callout)
            HStack {
              Button("Try again") { Task { await perform(retry) } }.buttonStyle(.borderedProminent)
              Button("Later") {
                postpone(retry.id)
                self.retry = nil
              }.buttonStyle(.bordered)
            }
          }.frame(maxWidth: .infinity, alignment: .leading).padding().background(.regularMaterial)
        } else if refreshed {
          Label("Workspace refreshed", systemImage: "checkmark.circle").padding(8)
        }
      }
      .onAppear { visible = true }
      .onDisappear {
        visible = false
        prompt = nil
      }
      .alert(item: $prompt) { item in
        Alert(
          title: Text(item.title), message: Text(item.message),
          primaryButton: .default(Text(item.button)) { Task { await perform(item) } },
          secondaryButton: .cancel(Text("Later")) {
            postpone(item.id)
          })
      }
      .task(id: active) {
        guard active else { return }
        while !Task.isCancelled {
          if !refreshing && retry == nil && prompt == nil { await check() }
          do { try await Task.sleep(for: .seconds(60)) } catch { return }
        }
      }
      .task(id: refreshed) {
        guard refreshed else { return }
        do {
          try await Task.sleep(for: .seconds(4))
          refreshed = false
        } catch {}
      }
  }

  private func postpone(_ id: String) {
    UserDefaults.standard.set(id, forKey: key + ".deferred")
    UserDefaults.standard.set(Date().addingTimeInterval(86400), forKey: key + ".until")
  }

  private func deferred(_ id: String) -> Bool {
    let defaults = UserDefaults.standard
    return defaults.string(forKey: key + ".deferred") == id
      && (defaults.object(forKey: key + ".until") as? Date ?? .distantPast) > Date()
  }

  @MainActor private func perform(_ item: UpdatePrompt) async {
    switch item.action {
    case .install(let url):
      openURL(url) { opened in
        if !opened {
          store.error =
            "Open " + (url.scheme == "itms-beta" ? "TestFlight" : "the App Store")
            + " to update Fleet Checkout."
        }
      }
    case .workspace:
      guard !refreshing else { return }
      retry = nil
      refreshing = true
      refreshed = false
      defer { refreshing = false }
      do {
        // Read again in case the deployment changed or rolled back while the alert was open.
        let current = try await manifest()
        guard let copy = current.workspaceContent, copy.isSupported else {
          throw FleetError(
            message: "This workspace update requires a newer version of Fleet Checkout.")
        }
        try await store.applyWorkspaceUpdate(copy)
        UserDefaults.standard.set(current.release, forKey: key)
        refreshed = true
        UIAccessibility.post(notification: .announcement, argument: "Workspace refreshed")
      } catch {
        guard active, store.session != nil else { return }
        refreshError = error.localizedDescription
        retry = item
      }
    }
  }

  private func manifest() async throws -> FleetReleaseManifest {
    let url = store.api.baseURL.appendingPathComponent("release.json")
    let request = URLRequest(
      url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.url == url,
      data.count <= 32_768
    else { throw URLError(.badServerResponse) }
    let info = try JSONDecoder().decode(FleetReleaseManifest.self, from: data)
    guard !info.release.isEmpty else { throw URLError(.cannotParseResponse) }
    return info
  }

  @MainActor private func check() async {
    do {
      let info = try await manifest()
      let native = store.api.isReview ? nil : await binaryUpdate(info.betaBuild)
      try Task.checkCancellation()
      guard active, store.session != nil else { return }
      if let native, !deferred(native.id) {
        prompt = native
        return
      }
      guard let copy = info.workspaceContent, copy.isSupported else { return }
      let defaults = UserDefaults.standard
      let previous = defaults.string(forKey: key)
      if previous == nil && copy == store.workspaceContent {
        defaults.set(info.release, forKey: key)
        return
      }
      guard previous != info.release || copy != store.workspaceContent, !deferred(info.release)
      else { return }
      prompt = UpdatePrompt(
        id: info.release, title: "Workspace update available",
        message: "Refresh to load the latest fleet information and inspection instructions.",
        button: "Refresh now", action: .workspace)
    } catch { /* Keep the current workspace available offline. */  }
  }

  @MainActor private func binaryUpdate(_ betaBuild: Int) async -> UpdatePrompt? {
    let bundle = Bundle.main
    let installed =
      Int(bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
    if betaBuild > installed, let transaction = try? await AppTransaction.shared,
      case .verified(let signed) = transaction, signed.environment == .sandbox
    {
      return UpdatePrompt(
        id: "beta-\(betaBuild)", title: "TestFlight update available",
        message: "Build \(betaBuild) is ready to install.", button: "Open TestFlight",
        action: .install(URL(string: "itms-beta://")!))
    }
    let defaults = UserDefaults.standard
    if Date().timeIntervalSince1970 - defaults.double(forKey: "store-version-checked") > 86400 {
      let url = URL(string: "https://itunes.apple.com/lookup?id=6832734217&country=us")!
      if let (data, _) = try? await URLSession.shared.data(
        for: URLRequest(url: url, timeoutInterval: 6)),
        let version = (try? JSONDecoder().decode(Listing.self, from: data))?.results.first?.version
      {
        defaults.set(version, forKey: "store-version")
        defaults.set(Date().timeIntervalSince1970, forKey: "store-version-checked")
      }
    }
    let current = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    guard let version = defaults.string(forKey: "store-version"),
      version.compare(current, options: .numeric) == .orderedDescending
    else { return nil }
    return UpdatePrompt(
      id: "store-" + version, title: "App update available",
      message: "Fleet Checkout \(version) is ready to install.", button: "Open App Store",
      action: .install(URL(string: "https://apps.apple.com/app/id6832734217")!))
  }
}

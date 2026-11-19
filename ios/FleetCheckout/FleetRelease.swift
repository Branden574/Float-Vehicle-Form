import StoreKit
import SwiftUI

/// Shown on the fleet list, so accepting a reload cannot interrupt a signature or camera session.
struct FleetReleaseNotice: ViewModifier {
  @EnvironmentObject var store: FleetStore
  @Environment(\.scenePhase) private var phase
  @Environment(\.openURL) private var openURL
  @State private var pending: String?
  @State private var deferred: String?
  @State private var binaryURL: URL?
  @State private var refreshing = false
  struct Manifest: Decodable {
    let release: String
    let betaBuild: Int
  }
  struct Listing: Decodable {
    struct Item: Decodable { let version: String }
    let results: [Item]
  }
  private var key: String { "workspace-release." + (store.api.baseURL.host ?? "fleet") }
  func body(content: Content) -> some View {
    content.safeAreaInset(edge: .top, spacing: 0) {
      if let pending, pending != deferred {
        VStack(alignment: .leading, spacing: 8) {
          Text("Update available").font(.headline)
          Text(
            binaryURL == nil
              ? "Fleet Checkout has a workspace update. Restart the workspace when you’re ready."
              : "A new version of Fleet Checkout is ready to install.")
          HStack(spacing: 18) {
            Button(binaryURL == nil ? "Restart now" : "Open update") {
              if let binaryURL {
                openURL(binaryURL)
                return
              }
              Task {
                refreshing = true
                await store.refresh()
                refreshing = false
                guard store.error.isEmpty else { return }
                UserDefaults.standard.set(pending, forKey: key)
                self.pending = nil
                store.revision = UUID()
              }
            }.disabled(refreshing)
            Button("Later") { deferred = pending }
          }.buttonStyle(.bordered)
        }.padding().frame(maxWidth: .infinity, alignment: .leading).background(.regularMaterial)
      }
    }
    .task(id: phase) {
      guard phase == .active else { return }
      while !Task.isCancelled {
        await check()
        do { try await Task.sleep(for: .seconds(60)) } catch { return }
      }
    }
  }
  @MainActor func check() async {
    do {
      let url = store.api.baseURL.appendingPathComponent("release.json")
      let request = URLRequest(
        url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
      let (data, response) = try await URLSession.shared.data(for: request)
      guard !Task.isCancelled, (response as? HTTPURLResponse)?.statusCode == 200,
        response.url?.host == url.host
      else { return }
      let info = try JSONDecoder().decode(Manifest.self, from: data)
      let defaults = UserDefaults.standard
      if defaults.string(forKey: key) == nil { defaults.set(info.release, forKey: key) }
      let installed =
        Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
      var beta = false
      if !store.api.isReview && info.betaBuild > installed,
        let transaction = try? await AppTransaction.shared,
        case .verified(let signed) = transaction
      {
        beta = signed.environment == .sandbox
      }
      if beta {
        binaryURL = URL(string: "itms-beta://")
        pending = "beta-\(info.betaBuild)"
        return
      }
      if !beta && !store.api.isReview {
        let stamp = defaults.double(forKey: "store-version-checked")
        if Date().timeIntervalSince1970 - stamp > 86400 {
          let lookup = URL(string: "https://itunes.apple.com/lookup?id=6832734217&country=us")!
          if let (body, _) = try? await URLSession.shared.data(from: lookup),
            let listing = try? JSONDecoder().decode(Listing.self, from: body),
            let version = listing.results.first?.version
          {
            defaults.set(version, forKey: "store-version")
            defaults.set(Date().timeIntervalSince1970, forKey: "store-version-checked")
          }
        }
        let installedVersion =
          Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        if let version = defaults.string(forKey: "store-version"),
          version.compare(installedVersion, options: .numeric) == .orderedDescending
        {
          binaryURL = URL(string: "https://apps.apple.com/app/id6832734217")
          pending = "store-" + version
          return
        }
      }
      guard !Task.isCancelled else { return }
      binaryURL = nil
      pending = defaults.string(forKey: key) == info.release ? nil : info.release
    } catch { /* An unavailable version service never blocks the fleet. */  }
  }
}

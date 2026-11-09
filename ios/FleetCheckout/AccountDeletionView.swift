import Security
import SwiftUI

struct DeletionResult: Decodable { let receipt: String }
struct DeletionStatus: Decodable { let status: String }

@MainActor enum DeletionReceipt {
  private static func query(_ review: Bool) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app.fleetcheckout.deletion" + (review ? ".review" : ""),
      kSecAttrAccount as String: "receipt",
    ]
  }
  static func read(review: Bool = false) -> String? {
    var value: CFTypeRef?
    var q = query(review)
    q[kSecReturnData as String] = true
    guard SecItemCopyMatching(q as CFDictionary, &value) == errSecSuccess, let data = value as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }
  static func save(_ receipt: String, review: Bool = false) throws {
    SecItemDelete(query(review) as CFDictionary)
    var q = query(review)
    q[kSecValueData as String] = Data(receipt.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else {
      throw FleetError(message: "Save your deletion receipt: \(receipt)")
    }
  }
  static func clear(review: Bool = false) { SecItemDelete(query(review) as CFDictionary) }
}

struct DeleteAccountView: View {
  @EnvironmentObject var store: FleetStore
  @State private var confirmation = ""
  @State private var busy = false
  @State private var error = ""
  @State private var confirm = false
  var body: some View {
    Form {
      Section("Permanently delete your account") {
        Text(
          "Your profile, signed forms, vehicle photos, gas receipts and generated reports will be removed. Access closes immediately; cloud data and recoverable backups are removed within 7 days."
        )
        Text(
          "Copies already emailed or downloaded must be removed by their recipients. This cannot be undone."
        )
        Text(
          "Return your vehicle first. A vehicle still checked out will be held for inspection. Administrators should appoint a replacement first."
        )
      }
      Section("Confirm your identity") {
        Text(
          "If your sign-in is more than 10 minutes old, sign out and sign in again before requesting deletion."
        )
        TextField("Type DELETE", text: $confirmation).autocorrectionDisabled()
          .textInputAutocapitalization(.characters)
        if !error.isEmpty { Text(error).foregroundStyle(.red) }
        Button(busy ? "Requesting deletion…" : "Permanently delete my account", role: .destructive)
        { confirm = true }
        .disabled(busy || confirmation != "DELETE")
      }
      Link("Privacy policy", destination: FleetAPI.origin.appendingPathComponent("privacy"))
    }.navigationTitle("Delete account").confirmationDialog(
      "Delete your account and associated data permanently?", isPresented: $confirm,
      titleVisibility: .visible
    ) {
      Button("Delete permanently", role: .destructive) {
        Task {
          busy = true
          defer { busy = false }
          error = ""
          do {
            let result: DeletionResult = try await store.api.request(
              "/api/auth/delete-account", method: "POST", body: ["confirmation": confirmation])
            store.deletionReceipt = result.receipt
            do { try DeletionReceipt.save(result.receipt, review: store.api.isReview) } catch {
              store.error = error.localizedDescription
            }
            store.clear()
          } catch { self.error = error.localizedDescription }
        }
      }
      Button("Keep my account", role: .cancel) {}
    }
  }
}

struct DeletionStatusView: View {
  @EnvironmentObject var store: FleetStore
  @State private var message = "Your account is closed. Data removal is processing."
  @State private var busy = false
  @State private var leave = false
  var body: some View {
    NavigationStack {
      Form {
        Section("Account deletion") {
          Text(message)
          Text(
            "Cloud cleanup, including recoverable backups, finishes within 7 days. Keep this receipt to check completion."
          )
        }
        Section("Your private receipt") {
          Text(store.deletionReceipt ?? "").font(.caption.monospaced()).textSelection(.enabled)
        }
        Button(busy ? "Checking…" : "Check completion") { Task { await check() } }.disabled(busy)
        Link("Support", destination: URL(string: "mailto:fleetcheckout.support@gmail.com")!)
        Link("Privacy policy", destination: FleetAPI.origin.appendingPathComponent("privacy"))
        Button("Return to sign-in") { leave = true }
      }.navigationTitle("Deletion status").task { await check() }
        .confirmationDialog(
          "Save your receipt before leaving. You can check it later at fleetcheckout.app/deletion-status.",
          isPresented: $leave, titleVisibility: .visible
        ) {
          Button("I saved my receipt — continue") {
            DeletionReceipt.clear(review: store.api.isReview)
            store.deletionReceipt = nil
          }
          Button("Keep receipt here", role: .cancel) {}
        }
    }
  }
  func check() async {
    guard let receipt = store.deletionReceipt, !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let result: DeletionStatus = try await store.api.request(
        "/api/deletion-status", method: "POST", body: ["receipt": receipt])
      message =
        result.status == "complete"
        ? "Deletion complete. Your associated app data and recoverable backups have been removed."
        : result.status == "removing_backups"
          ? "Your profile and files have been removed. Recoverable backup cleanup is processing."
          : "Your account is closed. Data removal is processing."
    } catch { message = error.localizedDescription }
  }
}

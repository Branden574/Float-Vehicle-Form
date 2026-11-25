import SwiftUI

/// The review deployment has its own database role, encryption key and private bucket.
/// Credentials use the ordinary password authentication endpoint, never an OTP bypass.
struct ReviewWorkspaceView: View {
  @StateObject private var store = FleetStore(review: true)
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    Group {
      if store.deletionReceipt != nil {
        DeletionStatusView()
      } else if store.restoring {
        ProgressView("Opening review workspace…")
      } else if store.session != nil {
        WorkspaceView().id(store.revision)
      } else {
        NavigationStack { ReviewSignInView() }
      }
    }.environmentObject(store)
      .safeAreaInset(edge: .bottom) {
        if store.session == nil || store.deletionReceipt != nil {
          Button("Return to staff sign-in") { dismiss() }
            .font(.footnote).padding(12).frame(maxWidth: .infinity)
            .background(.regularMaterial)
        }
      }
      .modifier(FleetSessionLifecycle(store: store))
  }
}
struct ReviewSignInView: View {
  @EnvironmentObject var store: FleetStore
  @State private var email = ""
  @State private var rememberMe = false
  @State private var password = ""
  @State private var busy = false
  @State private var error = ""
  var body: some View {
    Form {
      Section("App Review workspace") {
        Text(
          "For Apple reviewers. This workspace contains synthetic vehicles and accounts, separate from staff records. Use the credentials in App Review Information. Do not upload personal information here."
        )
        RememberDeviceToggle(enabled: $rememberMe).disabled(busy)
        Button("Sign in with a review passkey") {
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
        }.disabled(busy)
        TextField("Review email", text: $email).keyboardType(.emailAddress).textContentType(
          .username
        ).textInputAutocapitalization(.never).autocorrectionDisabled()
        SecureField("Review password", text: $password).textContentType(.password)
        if !error.isEmpty { Text(error).foregroundStyle(Color("FleetError")) }
        Button(busy ? "Signing in…" : "Sign in to review workspace") {
          Task {
            busy = true
            defer { busy = false }
            error = ""
            do {
              let result: FleetSession = try await store.api.request(
                "/api/auth/login", method: "POST",
                body: ["email": email, "password": password, "rememberMe": rememberMe])
              password = ""
              store.accept(result)
              await store.refresh()
            } catch { self.error = error.localizedDescription }
          }
        }.disabled(busy || email.isEmpty || password.isEmpty)
      }
      Link("Privacy policy", destination: FleetAPI.origin.appendingPathComponent("privacy"))
      Link("Support", destination: FleetAPI.origin.appendingPathComponent("support"))
    }.navigationTitle("App Review")
  }
}

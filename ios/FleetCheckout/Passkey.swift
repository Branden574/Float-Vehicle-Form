import AuthenticationServices
import UIKit

private struct PasskeyOptions: Decodable {
  struct User: Decodable {
    let id: String
    let name: String
  }
  struct Descriptor: Decodable { let id: String }
  let challenge: String
  let user: User?
  let excludeCredentials: [Descriptor]?
}
struct PasskeyCount: Decodable { let count: Int }

extension Data {
  fileprivate init(passkeyValue: String) throws {
    var base = passkeyValue.replacingOccurrences(of: "-", with: "+").replacingOccurrences(
      of: "_", with: "/")
    base += String(repeating: "=", count: (4 - base.count % 4) % 4)
    guard let decoded = Data(base64Encoded: base) else {
      throw FleetError(message: "Invalid passkey data.")
    }
    self = decoded
  }
  fileprivate var passkeyValue: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
      of: "/", with: "_"
    ).replacingOccurrences(of: "=", with: "")
  }
}

@MainActor
private final class PasskeyPrompt: NSObject, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding
{
  let window: UIWindow
  var pending: CheckedContinuation<ASAuthorization, Error>?
  var controller: ASAuthorizationController?
  init(window: UIWindow) { self.window = window }
  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    window
  }
  func present(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
    let controller = ASAuthorizationController(authorizationRequests: [request])
    self.controller = controller
    controller.delegate = self
    controller.presentationContextProvider = self
    return try await withCheckedThrowingContinuation {
      pending = $0
      controller.performRequests()
    }
  }
  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    pending?.resume(returning: authorization)
    pending = nil
    self.controller = nil
  }
  func authorizationController(
    controller: ASAuthorizationController, didCompleteWithError error: Error
  ) {
    pending?.resume(throwing: error)
    pending = nil
    self.controller = nil
  }
}

@MainActor
extension FleetAPI {
  private func passkeyResponse(registering: Bool) async throws -> [String: Any] {
    guard let rp = baseURL.host,
      let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
        .first(where: { $0.activationState == .foregroundActive && $0.keyWindow != nil })?.keyWindow
    else { throw FleetError(message: "Open Fleet Checkout to use your passkey.") }
    let purpose = registering ? "register" : "sign-in"
    let options: PasskeyOptions = try await request(
      "/api/auth/passkeys/\(purpose)/options", method: "POST", body: [:])
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rp)
    let challenge = try Data(passkeyValue: options.challenge)
    let request: ASAuthorizationRequest
    if registering, let user = options.user {
      let registration = provider.createCredentialRegistrationRequest(
        challenge: challenge, name: user.name, userID: try Data(passkeyValue: user.id))
      registration.userVerificationPreference = .required
      registration.excludedCredentials = try (options.excludeCredentials ?? []).map {
        ASAuthorizationPlatformPublicKeyCredentialDescriptor(
          credentialID: try Data(passkeyValue: $0.id))
      }
      request = registration
    } else {
      let assertion = provider.createCredentialAssertionRequest(challenge: challenge)
      assertion.userVerificationPreference = .required
      request = assertion
    }
    let prompt = PasskeyPrompt(window: window)
    let authorization: ASAuthorization
    // Keep the presentation delegate alive while the system displays the account picker.
    defer { withExtendedLifetime(prompt) {} }
    do {
      authorization = try await prompt.present(request)
    } catch let error as ASAuthorizationError {
      if error.code == .canceled {
        throw FleetError(message: "Passkey request canceled.")
      }
      let fallback = isReview ? "your review password" : "an email code"
      throw FleetError(
        message: "Passkeys are unavailable on this device right now. You can sign in with "
          + fallback + " and try the passkey again later.")
    }
    let id: String
    let response: [String: Any]
    if let key = authorization.credential
      as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
      let attestation = key.rawAttestationObject
    {
      id = key.credentialID.passkeyValue
      response = [
        "attestationObject": attestation.passkeyValue,
        "clientDataJSON": key.rawClientDataJSON.passkeyValue,
      ]
    } else if let key = authorization.credential
      as? ASAuthorizationPlatformPublicKeyCredentialAssertion
    {
      id = key.credentialID.passkeyValue
      response = [
        "clientDataJSON": key.rawClientDataJSON.passkeyValue,
        "signature": key.signature.passkeyValue,
        "authenticatorData": key.rawAuthenticatorData.passkeyValue,
        "userHandle": key.userID.passkeyValue,
      ]
    } else {
      throw FleetError(message: "The device could not complete passkey verification.")
    }
    return [
      "challenge": options.challenge,
      "credential": [
        "id": id, "rawId": id, "type": "public-key", "clientExtensionResults": [:],
        "response": response,
      ] as [String: Any],
    ]
  }
  func createPasskey() async throws {
    let body = try await passkeyResponse(registering: true)
    let _: EmptyResponse = try await request(
      "/api/auth/passkeys/register/verify", method: "POST", body: body)
  }
  func passkeySession() async throws -> FleetSession {
    let body = try await passkeyResponse(registering: false)
    return try await request("/api/auth/passkeys/sign-in/verify", method: "POST", body: body)
  }
}

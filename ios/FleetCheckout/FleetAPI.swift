import CryptoKit
import Foundation
import Security

struct FleetError: LocalizedError {
  var message: String
  var status: Int = 0
  var retryAfter: Int = 0
  var errorDescription: String? { message }
}
/// Only the app's session cookie is persisted, in this-device-only Keychain storage.
/// API responses and photographs never enter URLCache or shared cookie storage.
@MainActor final class FleetAPI {
  static let origin = URL(string: "https://fleetcheckout.app")!
  let baseURL: URL
  let isReview: Bool
  private var cookie: String?
  var csrf = ""
  private var epoch = UUID()
  private var session: URLSession
  private let configuration: URLSessionConfiguration
  private let service: String
  private var retryTask: Task<Void, Never>?
  private var signOutFence: String { service + ".signedOutSession" }

  private static func sessionID(_ cookie: String) -> String {
    SHA256.hash(data: Data(cookie.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  init(
    review: Bool = false, protocolClasses: [AnyClass]? = nil,
    keychainService: String = "app.fleetcheckout.mobile.session"
  ) {
    _ = FleetDocument.cleanPreviousLaunch
    isReview = review
    baseURL = review ? URL(string: "https://fleet-checkout-review.vercel.app")! : Self.origin
    service = review ? keychainService + ".review" : keychainService
    let configuration = URLSessionConfiguration.ephemeral
    if let protocolClasses { configuration.protocolClasses = protocolClasses }
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 120
    self.configuration = configuration
    session = URLSession(
      configuration: configuration, delegate: FleetRedirectGuard(), delegateQueue: nil)
    var result: CFTypeRef?
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: "fleet_session",
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data
    {
      if let value = String(data: data, encoding: .utf8) {
        if UserDefaults.standard.string(forKey: signOutFence) == Self.sessionID(value) {
          // Recover if iOS locked or terminated the app during local sign-out.
          var key = query
          key.removeValue(forKey: kSecReturnData as String)
          key.removeValue(forKey: kSecMatchLimit as String)
          SecItemDelete(key as CFDictionary)
        } else {
          cookie = value
        }
      }
    }
  }
  func clear() {
    epoch = UUID()
    if let cookie { UserDefaults.standard.set(Self.sessionID(cookie), forKey: signOutFence) }
    cookie = nil
    csrf = ""
    session.invalidateAndCancel()
    session = URLSession(
      configuration: configuration, delegate: FleetRedirectGuard(), delegateQueue: nil)
    SecItemDelete(
      [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
      ] as CFDictionary)
    if service.hasPrefix("app.fleetcheckout.mobile.session"),
      FileManager.default.fileExists(atPath: Self.privateFiles.path)
    {
      try? FileManager.default.removeItem(at: Self.privateFiles)
    }
  }
  // Prepare the device-only, revoke-only proof before making a session usable.
  // Removing the active cookie then makes its proof eligible for delivery even
  // if iOS terminates the app immediately after the user taps Sign out.
  private func prepareRevocation(cookie: String, response: Data) throws {
    struct SessionSecurity: Decodable { let csrfToken: String }
    let security = try JSONDecoder().decode(SessionSecurity.self, from: response)
    guard !security.csrfToken.isEmpty else {
      throw FleetError(message: "Invalid session response.")
    }
    let id = Self.sessionID(cookie)
    let proof = HMAC<SHA256>.authenticationCode(
      for: Data(("fleet.revoke.v1:" + id).utf8),
      using: SymmetricKey(data: Data(security.csrfToken.utf8)))
    let item: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service + ".revocations",
      kSecAttrAccount as String: id, kSecValueData as String: Data(proof),
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess || status == errSecDuplicateItem else {
      throw FleetError(message: "Could not secure this session. Unlock your device and try again.")
    }
  }

  /// Returns true only when all signed-out sessions have been acknowledged.
  func retryPendingSignOuts() async -> Bool {
    // An additional review window may own another API object for the same host.
    // Consult the durable cookie, not a potentially stale in-memory snapshot.
    var active: CFTypeRef?
    let activeQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "fleet_session", kSecReturnData as String: true,
    ]
    let activeStatus = SecItemCopyMatching(activeQuery as CFDictionary, &active)
    guard activeStatus == errSecSuccess || activeStatus == errSecItemNotFound else { return false }
    let activeID = (active as? Data).flatMap { String(data: $0, encoding: .utf8) }.map(
      Self.sessionID)
    let revokedID = UserDefaults.standard.string(forKey: signOutFence)
    let queue: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service + ".revocations",
    ]
    var query = queue
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    query[kSecReturnAttributes as String] = true
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return true }
    guard status == errSecSuccess, let tickets = result as? [[String: Any]] else { return false }
    var completed = true
    for ticket in tickets {
      guard let id = ticket[kSecAttrAccount as String] as? String,
        let proof = ticket[kSecValueData as String] as? Data, id != activeID || id == revokedID
      else { continue }
      var request = URLRequest(url: baseURL.appendingPathComponent("api/auth/revoke-session"))
      request.httpMethod = "POST"
      request.timeoutInterval = 10
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try? JSONEncoder().encode([
        "sessionId": id, "proof": proof.map { String(format: "%02x", $0) }.joined(),
      ])
      do {
        let (_, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 204 else {
          completed = false
          continue
        }
        var key = queue
        key[kSecAttrAccount as String] = id
        let removed = SecItemDelete(key as CFDictionary)
        if removed != errSecSuccess && removed != errSecItemNotFound { completed = false }
      } catch { return false }
    }
    return completed
  }

  func scheduleSignOutRetry() {
    retryTask?.cancel()
    retryTask = Task { [weak self] in
      var delay = 5
      while !Task.isCancelled {
        guard let finished = await self?.retryPendingSignOuts(), !finished else { return }
        do { try await Task.sleep(for: .seconds(delay)) } catch { return }
        delay = min(60, delay * 2)
      }
    }
  }
  private func saveCookie(_ value: String) throws {
    let attributes: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: "fleet_session",
    ]
    SecItemDelete(attributes as CFDictionary)
    var insert = attributes
    insert[kSecValueData as String] = Data(value.utf8)
    insert[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else {
      throw FleetError(message: "Could not securely save this session. Please sign in again.")
    }
    cookie = value
  }
  func request<T: Decodable>(
    _ path: String, method: String = "GET", body: [String: Any]? = nil, key: String? = nil
  ) async throws -> T {
    guard path.hasPrefix("/api/"), let url = URL(string: path, relativeTo: baseURL),
      url.host == baseURL.host
    else {
      throw FleetError(message: "Invalid API address.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    if let body {
      request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
    let data = try await perform(request)
    if data.isEmpty, let empty = EmptyResponse() as? T { return empty }
    do { return try JSONDecoder().decode(T.self, from: data) } catch {
      throw FleetError(message: "The server response could not be read. Refresh and try again.")
    }
  }
  private func perform(_ original: URLRequest, authenticated: Bool = true) async throws -> Data {
    let started = epoch
    var request = original
    if authenticated {
      if let cookie { request.setValue("fleet_session=\(cookie)", forHTTPHeaderField: "Cookie") }
      if request.httpMethod != "GET" { request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token") }
    }
    let data: Data
    let response: URLResponse
    do { (data, response) = try await session.data(for: request) } catch {
      throw FleetError(
        message:
          "Connection interrupted. Keep this draft open and retry; your submission may have reached the server."
      )
    }
    guard started == epoch else {
      throw FleetError(message: "This session ended. Please sign in again.", status: 401)
    }
    guard let http = response as? HTTPURLResponse else {
      throw FleetError(message: "Invalid server response.")
    }
    guard (200..<300).contains(http.statusCode) else {
      let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      if http.statusCode == 401 && !csrf.isEmpty {
        clear()
        NotificationCenter.default.post(name: .fleetSessionExpired, object: self)
      }
      throw FleetError(
        message: error?["error"] as? String ?? "Request failed. Please try again.",
        status: http.statusCode,
        retryAfter: Int(http.value(forHTTPHeaderField: "Retry-After") ?? "0") ?? 0)
    }
    if authenticated, http.url?.host == baseURL.host,
      let headers = http.allHeaderFields as? [String: String]
    {
      for value in HTTPCookie.cookies(withResponseHeaderFields: headers, for: baseURL)
      where value.name == "fleet_session" && !value.value.isEmpty {
        try prepareRevocation(cookie: value.value, response: data)
        try saveCookie(value.value)
      }
      // Also enroll an existing session when a user upgrades from an older build.
      if original.url?.path == "/api/auth/me", let cookie {
        try prepareRevocation(cookie: cookie, response: data)
      }
    }
    return data
  }
  func upload(_ bytes: Data, metadata: [String: Any]) async throws -> FleetPhoto {
    let started = epoch
    var body = metadata
    body["bytes"] = bytes.count
    let ticket: UploadTicket = try await request(
      "/api/photos/upload-ticket", method: "POST", body: body)
    guard started == epoch else { throw FleetError(message: "Session ended.", status: 401) }
    if ticket.direct, let address = ticket.url, let url = URL(string: address),
      url.scheme == "https", let id = ticket.ticketId
    {
      var put = URLRequest(url: url)
      put.httpMethod = "PUT"
      put.httpBody = bytes
      for (key, value) in ticket.headers ?? [:] { put.setValue(value, forHTTPHeaderField: key) }
      _ = try await perform(put, authenticated: false)
      guard started == epoch else { throw FleetError(message: "Session ended.", status: 401) }
      let result: PhotoResult = try await request(
        "/api/photos/upload-ticket/\(id)/complete", method: "POST", body: [:])
      return result.photo
    }
    let boundary = UUID().uuidString
    var data = Data()
    for (key, value) in metadata.sorted(by: { $0.key < $1.key }) {
      data.append(
        Data(
          "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(key)\"\r\n\r\n\(value)\r\n"
            .utf8))
    }
    data.append(
      Data(
        "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"inspection.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"
          .utf8))
    data.append(bytes)
    data.append(Data("\r\n--\(boundary)--\r\n".utf8))
    var upload = URLRequest(url: baseURL.appendingPathComponent("api/photos"))
    upload.httpMethod = "POST"
    upload.httpBody = data
    upload.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    return try JSONDecoder().decode(PhotoResult.self, from: await perform(upload)).photo
  }
  static var privateFiles: URL { FleetDocument.directory }

  func file(_ path: String, name: String, title: String, maximumBytes: Int = 120 * 1024 * 1024)
    async throws -> FleetDocument
  {
    guard path.hasPrefix("/api/"), let url = URL(string: path, relativeTo: baseURL),
      url.host == baseURL.host
    else { throw FleetError(message: "Invalid file address.") }
    let started = epoch
    var request = URLRequest(url: url)
    if let cookie { request.setValue("fleet_session=\(cookie)", forHTTPHeaderField: "Cookie") }
    let document = try FleetDocument(name: name, title: title)
    do {
      try await FleetPreviewTransfer.download(
        request, with: session, to: document.url, maximumBytes: maximumBytes)
    } catch let error as FleetError {
      if error.status == 401 && started == epoch && !csrf.isEmpty {
        clear()
        NotificationCenter.default.post(name: .fleetSessionExpired, object: self)
      }
      throw error
    }
    guard started == epoch else {
      throw FleetError(message: "This session ended. Please sign in again.", status: 401)
    }
    return document
  }
}
extension Notification.Name {
  static let fleetSessionExpired = Notification.Name("fleetSessionExpired")
}

/// Signed R2 downloads redirect away from the API. Never forward app credentials.
final class FleetRedirectGuard: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    guard request.url?.scheme == "https", response.url?.path != "/api/auth/revoke-session" else {
      completionHandler(nil)
      return
    }
    var redirected = request
    if request.url?.host != response.url?.host {
      redirected.setValue(nil, forHTTPHeaderField: "Cookie")
      redirected.setValue(nil, forHTTPHeaderField: "X-CSRF-Token")
      redirected.setValue(nil, forHTTPHeaderField: "Authorization")
      redirected.setValue(nil, forHTTPHeaderField: "Idempotency-Key")
    }
    completionHandler(redirected)
  }
}

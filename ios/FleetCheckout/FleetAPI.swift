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
  private var cookie: String?
  var csrf = ""
  private var epoch = UUID()
  private var session: URLSession
  private let configuration: URLSessionConfiguration
  private let service: String
  init(
    protocolClasses: [AnyClass]? = nil, keychainService: String = "app.fleetcheckout.mobile.session"
  ) {
    service = keychainService
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
      cookie = String(data: data, encoding: .utf8)
    }
  }
  func clear() {
    epoch = UUID()
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
    if service == "app.fleetcheckout.mobile.session",
      FileManager.default.fileExists(atPath: Self.privateFiles.path)
    {
      try? FileManager.default.removeItem(at: Self.privateFiles)
    }
  }
  func signOut() {
    var request = URLRequest(url: Self.origin.appendingPathComponent("api/auth/logout"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data("{}".utf8)
    if let cookie { request.setValue("fleet_session=\(cookie)", forHTTPHeaderField: "Cookie") }
    request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.urlCache = nil
    config.timeoutIntervalForRequest = 10
    let revocation = URLSession(
      configuration: config, delegate: FleetRedirectGuard(), delegateQueue: nil)
    clear()
    revocation.dataTask(with: request) { _, _, _ in revocation.finishTasksAndInvalidate() }.resume()
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
    guard path.hasPrefix("/api/"), let url = URL(string: path, relativeTo: Self.origin),
      url.host == Self.origin.host
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
        NotificationCenter.default.post(name: .fleetSessionExpired, object: nil)
      }
      throw FleetError(
        message: error?["error"] as? String ?? "Request failed. Please try again.",
        status: http.statusCode,
        retryAfter: Int(http.value(forHTTPHeaderField: "Retry-After") ?? "0") ?? 0)
    }
    if authenticated, http.url?.host == Self.origin.host,
      let headers = http.allHeaderFields as? [String: String]
    {
      for value in HTTPCookie.cookies(withResponseHeaderFields: headers, for: Self.origin)
      where value.name == "fleet_session" && !value.value.isEmpty {
        try saveCookie(value.value)
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
    var upload = URLRequest(url: Self.origin.appendingPathComponent("api/photos"))
    upload.httpMethod = "POST"
    upload.httpBody = data
    upload.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    return try JSONDecoder().decode(PhotoResult.self, from: await perform(upload)).photo
  }
  static var privateFiles: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("FleetPrivate", isDirectory: true)
  }
  func file(_ path: String, name: String) async throws -> URL {
    guard path.hasPrefix("/api/") else { throw FleetError(message: "Invalid file address.") }
    let data = try await perform(URLRequest(url: URL(string: path, relativeTo: Self.origin)!))
    guard data.count <= 120 * 1024 * 1024 else {
      throw FleetError(message: "File is too large to preview.")
    }
    let root = Self.privateFiles
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    let output = root.appendingPathComponent(name.replacingOccurrences(of: "/", with: "_"))
    try data.write(to: output, options: [.atomic, .completeFileProtection])
    return output
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
    guard request.url?.scheme == "https" else {
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

import XCTest

@testable import FleetCheckout

final class FleetCheckoutTests: XCTestCase {
  func testTripMileageIncludesDocumentedReplacement() throws {
    var trip = try JSONDecoder().decode(Trip.self, from: Data(Self.tripJSON.utf8))
    XCTAssertEqual(trip.distance(ending: 43125), 125)
    trip.odometerReplacement = OdometerReplacement(
      id: "replacement", oldReading: 43050, newReading: 10, reason: "Replaced instrument cluster")
    XCTAssertEqual(trip.distance(ending: 85), 125)
  }
  func testDiagramRegionsMatchWebAndMarksStayInsidePage() {
    XCTAssertEqual(Damage.placed(x: 0.8, y: 0.5, type: "dent").area, "passenger")
    XCTAssertEqual(Damage.placed(x: 0.2, y: 0.5, type: "dent").area, "driver")
    XCTAssertEqual(Damage.placed(x: 0.5, y: 0.3, type: "chip").area, "windshield")
    XCTAssertEqual(Damage.placed(x: 0.5, y: 0.6, type: "scratch").area, "roof")
    XCTAssertEqual(Damage.placed(x: 0.5, y: 1, type: "dent").position?.y, 0.98)
    XCTAssertEqual(Damage.placed(x: -0.1, y: 0, type: "dent").position?.x, 0.02)
  }
  func testDamageRoundTripPreservesPDFCoordinatesAndStage() throws {
    let inspection = Inspection(
      fuelFull: true, interiorClean: true, gasCard: true, receiptReceived: true, keyReturned: true,
      windshield: "clear",
      damage: [
        Damage(
          area: "driver", type: "dent", notes: "Door", position: DamagePosition(x: 0.25, y: 0.4))
      ], damageScope: "new", notes: "")
    let object =
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(inspection)) as! [String: Any]
    XCTAssertEqual(object["damageScope"] as? String, "new")
    let decoded = try JSONDecoder().decode(Inspection.self, from: JSONEncoder().encode(inspection))
    XCTAssertEqual(decoded.damage[0].position?.diagram, "vehicle-v1")
    XCTAssertEqual(decoded.damage[0].position?.x, 0.25)
    XCTAssertEqual(decoded.damage[0].position?.y, 0.4)
  }
  func testRedirectStripsCredentialsForStorageHost() {
    let delegate = FleetRedirectGuard()
    let session = URLSession(configuration: .ephemeral)
    let response = HTTPURLResponse(
      url: URL(string: "https://fleetcheckout.app/api/trips/1/report")!, statusCode: 302,
      httpVersion: nil, headerFields: nil)!
    var request = URLRequest(url: URL(string: "https://example.r2.cloudflarestorage.com/file")!)
    for header in ["Cookie", "X-CSRF-Token", "Authorization", "Idempotency-Key"] {
      request.setValue("test-secret", forHTTPHeaderField: header)
    }
    delegate.urlSession(
      session, task: session.dataTask(with: request), willPerformHTTPRedirection: response,
      newRequest: request
    ) { result in
      XCTAssertNotNil(result)
      for header in ["Cookie", "X-CSRF-Token", "Authorization", "Idempotency-Key"] {
        XCTAssertNil(result?.value(forHTTPHeaderField: header))
      }
    }
    request.url = URL(string: "http://fleetcheckout.app/unsafe")!
    delegate.urlSession(
      session, task: session.dataTask(with: request), willPerformHTTPRedirection: response,
      newRequest: request
    ) { XCTAssertNil($0) }
    session.invalidateAndCancel()
  }
  @MainActor func testResendRetryAfterAndSessionCookieCSRFContract() async throws {
    let api = FleetAPI(
      protocolClasses: [FixtureProtocol.self], keychainService: "app.fleetcheckout.mobile.tests")
    api.clear()
    defer {
      api.clear()
      FixtureProtocol.handler = nil
    }
    FixtureProtocol.handler = { request in
      if request.url?.path == "/api/auth/request-code" {
        return (
          429, ["Retry-After": "37"],
          Data("{\"error\":\"Wait before requesting another code.\"}".utf8)
        )
      }
      if request.url?.path == "/api/auth/verify-code" {
        return (
          200,
          [
            "Set-Cookie":
              "fleet_session=synthetic-session; Path=/; Secure; HttpOnly; SameSite=Strict"
          ], Data("{}".utf8)
        )
      }
      XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "fleet_session=synthetic-session")
      XCTAssertEqual(request.value(forHTTPHeaderField: "X-CSRF-Token"), "synthetic-csrf")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "stable-retry-key")
      return (200, [:], Data("{}".utf8))
    }
    do {
      let _: EmptyResponse = try await api.request(
        "/api/auth/request-code", method: "POST", body: ["email": "native@example.test"])
      XCTFail("Expected cooldown")
    } catch let failure as FleetError {
      XCTAssertEqual(failure.status, 429)
      XCTAssertEqual(failure.retryAfter, 37)
    }
    let _: EmptyResponse = try await api.request("/api/auth/verify-code", method: "POST", body: [:])
    api.csrf = "synthetic-csrf"
    let _: EmptyResponse = try await api.request(
      "/api/trips/checkout", method: "POST", body: [:], key: "stable-retry-key")
  }
  static let tripJSON = """
    {"id":"trip","vehicleId":"vehicle","employeeId":"staff","status":"active","checkoutAt":"2026-11-09T12:00:00.000Z","projectedReturnAt":"2026-11-09T18:00:00.000Z","startingMileage":43000,"employeeSnapshot":{"id":"staff","email":"driver@example.test","name":"Test Driver","department":"Testing","charter":"Testing","manager":"Test Manager","role":"staff","authorizedDriver":true,"active":true},"vehicleSnapshot":{"id":"vehicle","name":"Test Vehicle","make":"Ford","model":"Escape","year":2024,"plate":"TEST-01","vinLast4":"1234","site":"Testing","currentMileage":43000,"status":"checked_out","photoUrl":"","notes":"","archived":false},"checkoutInspection":{"fuelFull":true,"interiorClean":true,"gasCard":true,"windshield":"clear","damage":[],"notes":""},"flags":[],"overdue":false}
    """
}
final class FixtureProtocol: URLProtocol {
  static var handler: ((URLRequest) -> (Int, [String: String], Data))?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    let (status, headers, data) = handler(request)
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

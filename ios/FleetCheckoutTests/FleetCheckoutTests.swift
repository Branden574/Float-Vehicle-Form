import XCTest

@testable import FleetCheckout

final class FleetCheckoutTests: XCTestCase {
  @MainActor func testEncryptedInspectionRecoveryAndAccountIsolation() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let account = DraftUnlock(
      owner: "test-driver", key: Data(repeating: 12, count: 32).base64EncodedString())
    let other = DraftUnlock(
      owner: "other-driver", key: Data(repeating: 33, count: 32).base64EncodedString())
    let makeVault = { (unlock: DraftUnlock) in
      try NativeDraftVault(unlock: unlock, owner: unlock.owner, context: "return/trip", root: root)
    }
    let original = try makeVault(account)
    let upload = QueuedInspectionPhoto(
      id: UUID(), source: "camera", view: "receipt", capturedAt: "2026-11-18T12:00:00Z")
    let receipt = Data("Test scanned receipt".utf8)
    let signedPayload = Data("Signed original test payload".utf8)
    let snapshot = InspectionDraft(
      draftID: "draft", step: 3, mileage: "41671", due: Date(), confirmed: true,
      checks: ["gasCard": "yes"], windshield: "clear", marks: [], notes: "Private inspection note",
      photos: [], uploads: [upload], pendingBody: signedPayload,
      pendingKey: "original-idempotency-key")
    try original.storePhoto(receipt, id: upload.id)
    try original.save(snapshot)
    let restored = try makeVault(account)
    XCTAssertEqual(try restored.load(), snapshot)
    XCTAssertEqual(try restored.photo(upload.id), receipt)
    let otherVault = try makeVault(other)
    XCTAssertNil(try otherVault.load())
    try otherVault.save(snapshot)
    XCTAssertThrowsError(
      try NativeDraftVault(unlock: other, owner: account.owner, context: "return/trip", root: root))
    for case let url as URL in FileManager.default.enumerator(
      at: root, includingPropertiesForKeys: nil)!
    {
      guard let data = try? Data(contentsOf: url) else { continue }
      XCTAssertNil(data.range(of: receipt))
      XCTAssertNil(data.range(of: signedPayload))
      XCTAssertNil(data.range(of: Data(snapshot.notes.utf8)))
    }
    try original.save(snapshot)
    XCTAssertThrowsError(try restored.save(snapshot))
    XCTAssertThrowsError(try restored.remove())
    try NativeDraftVault.deleteAll(owner: account.owner, root: root)
    XCTAssertNil(try makeVault(account).load())
    XCTAssertEqual(try makeVault(other).load(), snapshot)
  }
  @MainActor func testReceiptScanKeepsAllPagesAndBoundsUploadSize() throws {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let page = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 3000), format: format)
      .image {
        UIColor.white.setFill()
        $0.fill(CGRect(x: 0, y: 0, width: 1200, height: 3000))
        UIColor.black.setFill()
        $0.fill(CGRect(x: 40, y: 50, width: 500, height: 30))
      }
    var readPages: [Int] = []
    let pages = try receiptScanPages(count: 2, limit: 3) { index in
      readPages.append(index)
      return page
    }
    XCTAssertEqual(readPages, [0, 1])
    XCTAssertEqual(pages.count, 2)
    let decoded = try XCTUnwrap(UIImage(data: pages[0]))
    XCTAssertEqual(decoded.size.height, 2400)
    XCTAssertLessThan(pages[0].count, 12 * 1024 * 1024)
    XCTAssertThrowsError(
      try receiptScanPages(count: 4, limit: 3) { _ in
        XCTFail("Oversized scans must not partially process or silently lose pages")
        return page
      })
    XCTAssertThrowsError(try receiptScanPages(count: 0, limit: 3) { _ in page })
  }
  @MainActor func testSignatureExportDoesNotChangeWithDeviceAppearance() throws {
    let canvas = SignatureCanvas(frame: CGRect(x: 0, y: 0, width: 300, height: 120))
    canvas.lines = [[CGPoint(x: 20, y: 80), CGPoint(x: 70, y: 30), CGPoint(x: 110, y: 90)]]
    canvas.overrideUserInterfaceStyle = .light
    let light = try XCTUnwrap(canvas.signatureImage().pngData())
    canvas.overrideUserInterfaceStyle = .dark
    let dark = try XCTUnwrap(canvas.signatureImage().pngData())
    XCTAssertEqual(light, dark, "The signed PDF must retain black-on-white ink in both themes")
  }
  func testHistoricalTripWithoutCharterLoadsInListAndDetail() throws {
    let oldTrip = Self.tripJSON.replacingOccurrences(of: "\"charter\":\"Testing\",", with: "")
    let list = try JSONDecoder().decode(
      TripList.self, from: Data("{\"trips\":[\(oldTrip)]}".utf8))
    XCTAssertEqual(list.trips.count, 1)
    XCTAssertNil(list.trips[0].employeeSnapshot.charter)
    XCTAssertEqual(list.trips[0].employeeSnapshot.displayedCharter, "Testing")
    let detail = try JSONDecoder().decode(
      TripDetail.self,
      from: Data("{\"trip\":\(oldTrip),\"photos\":[],\"reviews\":[],\"revisions\":[]}".utf8))
    XCTAssertEqual(detail.trip.employeeSnapshot.name, "Test Driver")
    let current = try JSONDecoder().decode(Trip.self, from: Data(Self.tripJSON.utf8))
    XCTAssertEqual(current.employeeSnapshot.charter, "Testing")
  }
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
  @MainActor func testProtectedPreviewSizeAndCleanup() async throws {
    let api = FleetAPI(protocolClasses: [FixtureProtocol.self], keychainService: UUID().uuidString)
    defer { FixtureProtocol.handler = nil }
    let bytes = Data(repeating: 97, count: 64)
    FixtureProtocol.handler = { _ in (200, [:], bytes) }
    var document: FleetDocument? = try await api.file(
      "/api/test-file", name: "trip.pdf", title: "Trip", maximumBytes: bytes.count)
    let path = try XCTUnwrap(document?.url)
    XCTAssertEqual(try Data(contentsOf: path), bytes)
    XCTAssertEqual(path.lastPathComponent, "trip.pdf")
    let folder = path.deletingLastPathComponent()
    var share = document
    document = nil
    XCTAssertNotNil(share)
    XCTAssertTrue(FileManager.default.fileExists(atPath: path.path))
    share = nil
    XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))

    func previewFolders() throws -> Set<String> {
      Set(try FileManager.default.contentsOfDirectory(atPath: FleetDocument.directory.path))
    }
    let before = try previewFolders()
    for headers in [[:], ["Content-Length": "1000"]] {
      FixtureProtocol.handler = { _ in (200, headers, bytes) }
      do {
        _ = try await api.file("/api/test-file", name: "trip.pdf", title: "Trip", maximumBytes: 63)
        XCTFail("An oversized file must be rejected")
      } catch let error as FleetError {
        XCTAssertTrue(error.message.contains("too large"))
      }
      XCTAssertEqual(try previewFolders(), before)
    }
    FixtureProtocol.handler = { _ in (403, [:], Data("Denied".utf8)) }
    do {
      _ = try await api.file("/api/test-file", name: "trip.pdf", title: "Trip")
      XCTFail("An HTTP error must not become a preview")
    } catch let error as FleetError {
      XCTAssertEqual(error.status, 403)
    }
    XCTAssertEqual(try previewFolders(), before)
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
          ], Data(#"{"csrfToken":"synthetic-csrf"}"#.utf8)
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
  @MainActor func testReviewWorkspaceUsesIsolatedHostAndCookie() async throws {
    let namespace = "app.fleetcheckout.tests." + UUID().uuidString
    let staff = FleetAPI(protocolClasses: [FixtureProtocol.self], keychainService: namespace)
    let review = FleetAPI(
      review: true, protocolClasses: [FixtureProtocol.self], keychainService: namespace)
    defer {
      staff.clear()
      review.clear()
      FixtureProtocol.handler = nil
    }
    FixtureProtocol.handler = { request in
      if request.url?.host == "fleetcheckout.app" {
        return (
          200, ["Set-Cookie": "fleet_session=staff-only; Path=/; Secure; HttpOnly"], Data(#"{"csrfToken":"staff-csrf"}"#.utf8)
        )
      }
      XCTAssertEqual(request.url?.host, "fleet-checkout-review.vercel.app")
      XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
      return (200, [:], Data("{}".utf8))
    }
    let _: EmptyResponse = try await staff.request("/api/auth/me")
    let _: EmptyResponse = try await review.request("/api/auth/me")
    do {
      let _: EmptyResponse = try await review.request("https://fleetcheckout.app/api/auth/me")
      XCTFail("External API must be rejected")
    } catch {}
  }
  @MainActor func testOfflineSignOutRetriesAfterRelaunchWithoutSendingNextLoginCookie() async throws
  {
    let namespace = "app.fleetcheckout.tests." + UUID().uuidString
    let client = { FleetAPI(protocolClasses: [FixtureProtocol.self], keychainService: namespace) }
    var first: FleetStore? = FleetStore(api: client())
    let attemptedOffline = expectation(description: "Sign-out attempted without connectivity")
    let sessionResponse = Data(#"{"csrfToken":"private-test-csrf"}"#.utf8)
    var issuing = "first-session"
    var reachable = false
    var received = 0
    var expectedCookie: String?
    FixtureProtocol.handler = { request in
      switch request.url?.path {
      case "/api/auth/login":
        return (
          200, ["Set-Cookie": "fleet_session=\(issuing); Path=/; Secure; HttpOnly"], sessionResponse
        )
      case "/api/auth/revoke-session":
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        XCTAssertNil(request.value(forHTTPHeaderField: "X-CSRF-Token"))
        received += 1
        // The first two deliveries represent the old device session across a failed
        // connection and relaunch. This vector also checks the server proof format.
        if received <= 2 {
          var body = request.httpBody ?? Data()
          if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var chunk = [UInt8](repeating: 0, count: 512)
            var n = stream.read(&chunk, maxLength: chunk.count)
            while n > 0 {
              body.append(contentsOf: chunk.prefix(n))
              n = stream.read(&chunk, maxLength: chunk.count)
            }
          }
          let payload = try? JSONDecoder().decode([String: String].self, from: body)
          XCTAssertEqual(
            payload,
            [
              "sessionId": "bb0beffaf301dc83600a5b32b8267ee129a144aaf645bd2c2e5ec2ab9d949efa",
              "proof": "838e54e050fc59f64ae7a9eba8cc4a5ff6a2ca7498cf60f29cff64da2fb828ad",
            ])
        }
        if !reachable { attemptedOffline.fulfill() }
        return (reachable ? 204 : 0, [:], Data())
      default:
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), expectedCookie)
        return (200, [:], Data("{}".utf8))
      }
    }
    defer { FixtureProtocol.handler = nil }
    let _: EmptyResponse = try await first!.api.request(
      "/api/auth/login", method: "POST", body: [:])
    await first!.logout()
    await fulfillment(of: [attemptedOffline], timeout: 3)
    first = nil
    XCTAssertEqual(received, 1)

    let relaunched = client()
    let _: EmptyResponse = try await relaunched.request("/api/public-settings")
    issuing = "next-session"
    let _: EmptyResponse = try await relaunched.request(
      "/api/auth/login", method: "POST", body: [:])
    reachable = true
    let retried = await relaunched.retryPendingSignOuts()
    XCTAssertTrue(retried)
    XCTAssertEqual(received, 2)
    expectedCookie = "fleet_session=next-session"
    let _: EmptyResponse = try await relaunched.request("/api/public-settings")
    let drained = await relaunched.retryPendingSignOuts()
    XCTAssertTrue(drained)
    XCTAssertEqual(received, 2)
    relaunched.clear()
    let cleanup = await relaunched.retryPendingSignOuts()
    XCTAssertTrue(cleanup)
    XCTAssertEqual(received, 3)
  }

  @MainActor func testSharedSessionLocksAfterActualInactivityButRememberedSessionStaysSignedIn()
    async throws
  {
    let store = FleetStore(
      api: FleetAPI(
        protocolClasses: [FixtureProtocol.self],
        keychainService: "app.fleetcheckout.tests." + UUID().uuidString))
    let user = FleetUser(
      id: "driver", email: "driver@example.test", name: "Driver", department: "", charter: "",
      manager: "", role: "staff", authorizedDriver: true, active: true)
    var session = FleetSession(
      user: user, csrfToken: "test",
      settings: FleetSettings(
        appName: "Fleet", organizationName: "Fleet", site: "", timezone: "UTC", employeeCopy: false,
        reviewMode: "self_service", allowPhotoImports: true, sessionMinutes: 15))
    store.accept(session)
    let opened = store.lastActive
    store.recordInteraction(at: opened.addingTimeInterval(600))
    store.accept(session)
    XCTAssertFalse(store.expireIdleSession(at: opened.addingTimeInterval(1000)))
    // A late tap cannot unlock a screen whose configured idle interval elapsed.
    store.recordInteraction(at: opened.addingTimeInterval(1500))
    XCTAssertNil(store.session)
    session.rememberedUntil = "2099-01-01T00:00:00.000Z"
    store.accept(session)
    XCTAssertFalse(store.expireIdleSession(at: opened.addingTimeInterval(3600)))
    XCTAssertNotNil(store.session)
    session.rememberedUntil = nil
    session.settings.sessionMinutes = 0
    store.accept(session)
    let limit = ContinuousClock.now.advanced(by: .seconds(2))
    while store.session != nil && ContinuousClock.now < limit {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertNil(
      store.session, "The foreground idle timer locks without a scene transition or further input.")
  }

  @MainActor func testWorkspaceUpdateIsAtomicSurvivesRelaunchAndIsIsolatedByHost() async throws {
    let name = "app.fleetcheckout.tests." + UUID().uuidString
    let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
    defer {
      defaults.removePersistentDomain(forName: name)
      FixtureProtocol.handler = nil
    }
    let api = FleetAPI(protocolClasses: [FixtureProtocol.self], keychainService: name)
    defer { api.clear() }
    let store = FleetStore(api: api, defaults: defaults)
    let user = FleetUser(
      id: "driver", email: "driver@example.test", name: "Test Driver", department: "", charter: "",
      manager: "", role: "staff", authorizedDriver: true, active: true)
    let session = FleetSession(
      user: user, csrfToken: "new-token",
      settings:
        FleetSettings(
          appName: "Refreshed", organizationName: "Fleet", site: "Site",
          timezone: "America/Los_Angeles",
          employeeCopy: false, reviewMode: "self_service", allowPhotoImports: true,
          sessionMinutes: 15))
    var previous = session
    previous.settings.appName = "Earlier"
    store.accept(previous)
    let copy = WorkspaceContent(
      schema: 1, fleetReminder: "Look for the fleet number by the door.",
      damageInstructions: "Mark each dent.", receiptInstructions: "Scan all receipt pages.")
    let sessionData = try JSONEncoder().encode(session)
    var failTrips = true
    FixtureProtocol.handler = { request in
      switch request.url?.path {
      case "/api/auth/me": return (200, [:], sessionData)
      case "/api/vehicles": return (200, [:], Data("{\"vehicles\":[]}".utf8))
      case "/api/trips": return (failTrips ? 503 : 200, [:], Data("{\"trips\":[]}".utf8))
      default:
        XCTFail("Unexpected URL")
        return (404, [:], Data())
      }
    }
    await store.refresh()
    XCTAssertFalse(store.hasLoadedSchedule, "A failed initial fetch must not produce empty fleet or trip states.")
    do {
      try await store.applyWorkspaceUpdate(copy)
      XCTFail("Expected refresh failure")
    } catch {}
    XCTAssertEqual(store.session?.settings.appName, "Earlier")
    XCTAssertEqual(store.workspaceContent, WorkspaceContent.bundled)
    failTrips = false
    await store.refresh()
    XCTAssertTrue(store.hasLoadedSchedule, "A successfully loaded empty schedule is ready to display.")
    try await store.applyWorkspaceUpdate(copy)
    XCTAssertEqual(store.session?.settings.appName, "Refreshed")
    XCTAssertEqual(store.workspaceContent, copy)
    XCTAssertEqual(FleetStore(api: api, defaults: defaults).workspaceContent, copy)
    XCTAssertEqual(
      FleetStore(review: true, defaults: defaults).workspaceContent, WorkspaceContent.bundled)
    for bad in [
      WorkspaceContent(
        schema: 2, fleetReminder: "a", damageInstructions: "b", receiptInstructions: "c"),
      WorkspaceContent(
        schema: 1, fleetReminder: " ", damageInstructions: "b", receiptInstructions: "c"),
    ] {
      do {
        try await store.applyWorkspaceUpdate(bad)
        XCTFail("Expected unsupported content")
      } catch {}
      XCTAssertEqual(store.workspaceContent, copy)
    }
    store.clear()
    XCTAssertFalse(store.hasLoadedSchedule)
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
    if status == 0 {
      client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
      return
    }
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

import CryptoKit
import Foundation

struct DraftUnlock: Decodable {
  let owner: String
  let key: String
}
struct QueuedInspectionPhoto: Codable, Equatable {
  let id: UUID
  let source: String
  let view: String
  let capturedAt: String?
}
struct InspectionDraft: Codable, Equatable {
  let draftID: String
  let step: Int
  let mileage: String
  let due: Date
  let confirmed: Bool
  let checks: [String: String]
  let windshield: String
  let marks: [Damage]
  var missingEmergencyKits: String?
  let notes: String
  let photos: [FleetPhoto]
  let uploads: [QueuedInspectionPhoto]
  let pendingBody: Data?
  let pendingKey: String
}

/// Session-only key. Untouched draft files cannot be read after changing staff accounts.
@MainActor final class NativeDraftVault {
  private struct Envelope: Codable {
    let expires: Date
    let revision: UUID
    let sealed: Data
  }
  private let directory: URL
  private let key: SymmetricKey
  private var revision: UUID?
  private var manifest: URL { directory.appendingPathComponent("draft") }
  private let fm = FileManager.default
  private static let lifetime: TimeInterval = 86400
  static func context(vehicle: Vehicle, trip: Trip?) -> String {
    trip.map { "return/" + $0.id }
      ?? "checkout/\(vehicle.id)/\(vehicle.mileageVersion ?? vehicle.currentMileage)"
  }
  private static func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  private static func baseDirectory() throws -> URL {
    try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    )
    .appendingPathComponent("InspectionDrafts", isDirectory: true)
  }
  static func hasDraft(owner: String?, context: String) -> Bool {
    guard let owner, let base = try? baseDirectory() else { return false }
    let path = base.appendingPathComponent(digest(owner) + "-" + digest(context))
      .appendingPathComponent("draft")
    guard let bytes = try? Data(contentsOf: path),
      let envelope = try? JSONDecoder().decode(Envelope.self, from: bytes)
    else { return false }
    return envelope.expires > Date()
  }
  static func deleteAll(owner: String, root: URL? = nil) throws {
    let base = try root ?? baseDirectory()
    guard FileManager.default.fileExists(atPath: base.path) else { return }
    let prefix = digest(owner) + "-"
    for directory in try FileManager.default.contentsOfDirectory(
      at: base, includingPropertiesForKeys: nil)
    where directory.lastPathComponent.hasPrefix(prefix) {
      try FileManager.default.removeItem(at: directory)
    }
  }
  init(unlock: DraftUnlock, owner: String, context: String, root: URL? = nil) throws {
    guard unlock.owner == owner, let bytes = Data(base64Encoded: unlock.key), bytes.count == 32
    else {
      throw FleetError(message: "Your session changed. Reopen the inspection.")
    }
    key = SymmetricKey(data: bytes)
    var base = try root ?? Self.baseDirectory()
    let id = Self.digest(owner) + "-" + Self.digest(context)
    directory = base.appendingPathComponent(id, isDirectory: true)
    try fm.createDirectory(at: base, withIntermediateDirectories: true)
    var flags = URLResourceValues()
    flags.isExcludedFromBackup = true
    try base.setResourceValues(flags)
    for entry in try fm.contentsOfDirectory(at: base, includingPropertiesForKeys: nil) {
      let path = entry.appendingPathComponent("draft")
      if let data = try? Data(contentsOf: path),
        let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
        envelope.expires <= Date()
      {
        try fm.removeItem(at: entry)
      }
    }
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
  }
  private func envelope() throws -> Envelope? {
    if !fm.fileExists(atPath: manifest.path) { return nil }
    return try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: manifest))
  }
  func load() throws -> InspectionDraft? {
    guard let envelope = try envelope() else { return nil }
    revision = envelope.revision
    let data = try AES.GCM.open(
      AES.GCM.SealedBox(combined: envelope.sealed), using: key,
      authenticating: Data(directory.lastPathComponent.utf8))
    return try JSONDecoder().decode(InspectionDraft.self, from: data)
  }
  private func requireCurrent() throws {
    guard try envelope()?.revision == revision else {
      throw FleetError(message: "This inspection changed in another window. Reopen it to resume.")
    }
  }
  func save(_ draft: InspectionDraft) throws {
    try requireCurrent()
    let encrypted = try AES.GCM.seal(
      JSONEncoder().encode(draft), using: key,
      authenticating: Data(directory.lastPathComponent.utf8))
    guard let sealed = encrypted.combined else {
      throw FleetError(message: "Could not encrypt this draft.")
    }
    let next = Envelope(
      expires: Date().addingTimeInterval(Self.lifetime), revision: UUID(), sealed: sealed)
    try JSONEncoder().encode(next).write(to: manifest, options: [.atomic, .completeFileProtection])
    revision = next.revision
  }
  func remove() throws {
    try requireCurrent()
    if fm.fileExists(atPath: directory.path) { try fm.removeItem(at: directory) }
    revision = nil
  }
  func storePhoto(_ bytes: Data, id: UUID) throws {
    let sealed = try AES.GCM.seal(bytes, using: key, authenticating: Data(id.uuidString.utf8))
    guard let combined = sealed.combined else {
      throw FleetError(message: "Could not encrypt this photograph.")
    }
    try combined.write(
      to: directory.appendingPathComponent(id.uuidString),
      options: [.atomic, .completeFileProtection])
  }
  func photo(_ id: UUID) throws -> Data {
    let sealed = try AES.GCM.SealedBox(
      combined: Data(contentsOf: directory.appendingPathComponent(id.uuidString)))
    return try AES.GCM.open(sealed, using: key, authenticating: Data(id.uuidString.utf8))
  }
  func removePhoto(_ id: UUID) {
    try? fm.removeItem(at: directory.appendingPathComponent(id.uuidString))
  }
}

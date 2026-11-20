import Foundation

/// Remote workspace copy is plain text in a fixed set of native views.
struct WorkspaceContent: Codable, Equatable {
  let schema: Int
  let fleetReminder: String
  let damageInstructions: String
  let receiptInstructions: String

  var isSupported: Bool {
    schema == 1
      && [fleetReminder, damageInstructions, receiptInstructions].allSatisfy {
        !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.count <= 500
      }
  }

  static let bundled: Self = {
    guard let url = Bundle.main.url(forResource: "WorkspaceContent", withExtension: "json"),
      let bytes = try? Data(contentsOf: url),
      let copy = try? JSONDecoder().decode(Self.self, from: bytes), copy.isSupported
    else { preconditionFailure("The build must include valid workspace content") }
    return copy
  }()

  static func stored(for host: String, defaults: UserDefaults = .standard) -> Self {
    guard let data = defaults.data(forKey: "workspace-content." + host),
      let saved = try? JSONDecoder().decode(Self.self, from: data), saved.isSupported
    else { return bundled }
    return saved
  }

  func persist(for host: String, defaults: UserDefaults = .standard) throws {
    guard isSupported else {
      throw FleetError(message: "This workspace update requires a newer app.")
    }
    defaults.set(try JSONEncoder().encode(self), forKey: "workspace-content." + host)
  }
}

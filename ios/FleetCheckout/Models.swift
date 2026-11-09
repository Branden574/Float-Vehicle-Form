import Foundation

struct FleetUser: Codable, Identifiable {
  var id: String
  var email: String
  var name: String
  var department: String
  var charter: String
  var manager: String
  var role: String
  var authorizedDriver: Bool
  var active: Bool
}
struct Vehicle: Codable, Identifiable {
  var id: String
  var name: String
  var make: String
  var model: String
  var year: Int
  var plate: String
  var vinLast4: String
  var site: String
  var currentMileage: Int
  var status: String
  var photoUrl: String
  var notes: String
  var archived: Bool
}
struct FleetSettings: Codable {
  var appName: String
  var organizationName: String
  var site: String
  var timezone: String
  var notificationRecipients: [String]?
  var employeeCopy: Bool
  var reviewMode: String
  var allowPhotoImports: Bool
  var sessionMinutes: Int
  var requiredPhotoViews: [String]?
}
struct FleetSession: Codable {
  var user: FleetUser
  var csrfToken: String
  var settings: FleetSettings
}
struct DamagePosition: Codable, Equatable {
  var x: Double
  var y: Double
  var diagram = "vehicle-v1"
}
struct Damage: Codable, Equatable {
  var area: String
  var type: String
  var notes = ""
  var position: DamagePosition?
}
struct Inspection: Codable {
  var fuelFull: Bool
  var interiorClean: Bool
  var gasCard: Bool
  var receiptReceived: Bool?
  var keyReturned: Bool?
  var windshield: String
  var damage: [Damage]
  var damageScope: String?
  var notes: String
}
struct OdometerReplacement: Codable {
  var id: String
  var oldReading: Int
  var newReading: Int
  var reason: String
}
struct Trip: Codable, Identifiable {
  var id: String
  var vehicleId: String
  var employeeId: String
  var status: String
  var checkoutAt: String
  var projectedReturnAt: String
  var returnedAt: String?
  var startingMileage: Int
  var endingMileage: Int?
  var tripMileage: Int?
  var employeeSnapshot: FleetUser
  var vehicleSnapshot: Vehicle
  var checkoutInspection: Inspection
  var returnInspection: Inspection?
  var flags: [String]
  var overdue: Bool
  var odometerReplacement: OdometerReplacement?
  func distance(ending: Int) -> Int {
    if let replacement = odometerReplacement {
      return replacement.oldReading - startingMileage + ending - replacement.newReading
    }
    return ending - startingMileage
  }
}
struct FleetPhoto: Codable, Identifiable {
  var id: String
  var view: String
  var stage: String
  var url: String
  var originalUrl: String
}
struct Review: Codable, Identifiable {
  var id: String
  var stage: String
  var initials: String
  var decision: String
  var reason: String
}
struct TripDetail: Decodable {
  var trip: Trip
  var photos: [FleetPhoto]
  var reviews: [Review]
}
struct VehicleList: Decodable { var vehicles: [Vehicle] }
struct TripList: Decodable { var trips: [Trip] }
struct TripResult: Decodable { var trip: Trip }
struct PhotoResult: Decodable { var photo: FleetPhoto }
struct CodeChallenge: Decodable {
  var challengeId: String
  var expiresInSeconds: Int?
  var retryAfterSeconds: Int?
}
struct UploadTicket: Decodable {
  var direct: Bool
  var ticketId: String?
  var url: String?
  var headers: [String: String]?
}
struct SettingsResult: Decodable { var settings: FleetSettings }
struct AdminOverview: Decodable {
  var users: [FleetUser]
  var vehicles: [Vehicle]
  var settings: FleetSettings
}
struct EmptyResponse: Decodable {}

func humanize(_ value: String) -> String {
  value.replacingOccurrences(of: "_", with: " ").capitalized
}
func displayDate(_ value: String) -> String {
  let parser = ISO8601DateFormatter()
  parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let date = parser.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  return date?.formatted(date: .abbreviated, time: .shortened) ?? value
}
